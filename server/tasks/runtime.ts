import type { TaskJob, TaskLogRecord } from "./types.js";
import { appendTaskLog, persistTaskJob } from "./store.js";

export interface TaskExecutionResult {
  job: TaskJob;
  log?: Omit<TaskLogRecord, "timestamp">;
  complete?: boolean;
  stop?: boolean;
  next_delay_sec?: number;
}

type TaskExecutor = (job: TaskJob) => Promise<TaskExecutionResult>;

interface RuntimeEntry {
  job: TaskJob;
  executeRound: TaskExecutor;
  timer: ReturnType<typeof setTimeout> | null;
  executing?: boolean;
}

interface TaskRuntimeOptions {
  persistTask: (job: TaskJob) => void;
  appendLog: (jobId: string, ok: boolean, message: string) => void;
}

export class TaskRuntime {
  private tasks = new Map<string, RuntimeEntry>();

  constructor(private readonly options: TaskRuntimeOptions) {}

  startTask(job: TaskJob, executeRound: TaskExecutor): TaskJob {
    if (this.hasConflict(job)) {
      throw new Error("Another task is already running");
    }

    this.clearTaskTimer(job.id);
    const entry: RuntimeEntry = {
      job,
      executeRound,
      timer: null,
    };
    this.tasks.set(job.id, entry);
    this.options.persistTask(job);
    return job;
  }

  registerTask(job: TaskJob, executeRound: TaskExecutor): TaskJob {
    const existing = this.tasks.get(job.id);
    if (existing?.timer) {
      clearTimeout(existing.timer);
    }
    this.tasks.set(job.id, {
      job,
      executeRound,
      timer: null,
    });
    if (job.state === "running") {
      this.scheduleNextRun(job.id);
    }
    return job;
  }

  isExecuting(jobId: string): boolean {
    return this.tasks.get(jobId)?.executing ?? false;
  }

  getTask(jobId: string): TaskJob | null {
    return this.tasks.get(jobId)?.job ?? null;
  }

  getActiveTasks(): TaskJob[] {
    return [...this.tasks.values()].map(entry => entry.job).filter(job => job.state === "running");
  }

  getActiveTask(): TaskJob | null {
    return this.getActiveTasks()[0] ?? null;
  }

  hasConflict(job: Pick<TaskJob, "id" | "job_type">): boolean {
    const isArbitrage = (type: string) => type === "arbitrage" || type === "dex_to_cex_arbitrage";
    return this.getActiveTasks().some(active =>
      active.id !== job.id && (!isArbitrage(active.job_type) || !isArbitrage(job.job_type)),
    );
  }

  async runNow(jobId: string): Promise<TaskJob | null> {
    const entry = this.tasks.get(jobId);
    if (!entry || entry.job.state !== "running" || entry.executing) {
      return null;
    }

    this.clearTaskTimer(jobId);
    entry.executing = true;
    entry.job = {
      ...entry.job,
      next_run_at: null,
      updated_at: new Date().toISOString(),
    };
    this.options.persistTask(entry.job);

    let result: TaskExecutionResult;
    try {
      result = await entry.executeRound(entry.job);
    } catch (error) {
      result = { job: entry.job, stop: true, log: { ok: false, message: error instanceof Error ? error.message : String(error) } };
    } finally {
      entry.executing = false;
    }
    // A deleted task must never be persisted again by an in-flight round.
    if (this.tasks.get(jobId) !== entry) return null;
    const wasStopped = entry.job.state !== "running";
    entry.job = {
      ...result.job,
      updated_at: new Date().toISOString(),
    };

    if (result.log) {
      const logRecord: TaskLogRecord = {
        timestamp: new Date().toISOString(),
        ok: result.log.ok,
        message: result.log.message,
      };
      entry.job.logs.unshift(logRecord);
      if (entry.job.logs.length > 200) entry.job.logs.length = 200;
      this.options.appendLog(entry.job.id, logRecord.ok, logRecord.message);
    }

    if (wasStopped) {
      entry.job = { ...entry.job, state: "stopped", next_run_at: null };
    } else if (result.complete) {
      entry.job = {
        ...entry.job,
        state: "completed",
        next_run_at: null,
      };
    } else if (result.stop) {
      entry.job = {
        ...entry.job,
        state: "stopped",
        next_run_at: null,
      };
    } else {
      const delaySec = result.next_delay_sec ?? entry.job.interval_sec;
      entry.job = {
        ...entry.job,
        next_run_at: new Date(Date.now() + delaySec * 1000).toISOString(),
      };
      this.scheduleNextRun(entry.job.id);
    }

    this.options.persistTask(entry.job);
    return entry.job;
  }

  stopTask(jobId: string, reason: string): TaskJob | null {
    const entry = this.tasks.get(jobId);
    if (!entry) return null;
    this.clearTaskTimer(jobId);
    entry.job = {
      ...entry.job,
      state: "stopped",
      next_run_at: null,
      updated_at: new Date().toISOString(),
    };
    const logRecord: TaskLogRecord = {
      timestamp: new Date().toISOString(),
      ok: false,
      message: reason,
    };
    entry.job.logs.unshift(logRecord);
    if (entry.job.logs.length > 200) entry.job.logs.length = 200;
    this.options.appendLog(jobId, false, reason);
    this.options.persistTask(entry.job);
    return entry.job;
  }

  resumeTask(jobId: string): TaskJob | null {
    const entry = this.tasks.get(jobId);
    if (!entry) return null;
    if (entry.executing) throw new Error("任务正在完成当前操作，请稍后继续");
    if (entry.job.state === "running") return entry.job;
    if (this.hasConflict(entry.job)) {
      throw new Error("Another task is already running");
    }
    entry.job = {
      ...entry.job,
      state: "running",
      next_run_at: null,
      updated_at: new Date().toISOString(),
    };
    this.options.persistTask(entry.job);
    void this.runNow(jobId);
    return entry.job;
  }

  removeTask(jobId: string): TaskJob | null {
    const entry = this.tasks.get(jobId);
    if (!entry) return null;
    this.clearTaskTimer(jobId);
    this.tasks.delete(jobId);
    return entry.job;
  }

  private clearTaskTimer(jobId: string): void {
    const entry = this.tasks.get(jobId);
    if (!entry?.timer) return;
    clearTimeout(entry.timer);
    entry.timer = null;
  }

  private scheduleNextRun(jobId: string): void {
    const entry = this.tasks.get(jobId);
    if (!entry || entry.job.state !== "running" || !entry.job.next_run_at) {
      return;
    }
    this.clearTaskTimer(jobId);
    const delayMs = Math.max(
      0,
      new Date(entry.job.next_run_at).getTime() - Date.now(),
    );
    entry.timer = setTimeout(() => {
      void this.runNow(jobId);
    }, delayMs);
  }
}

export const taskRuntime = new TaskRuntime({
  persistTask: persistTaskJob,
  appendLog: appendTaskLog,
});
