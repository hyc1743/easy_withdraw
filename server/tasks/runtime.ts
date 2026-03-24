import type { TaskJob, TaskLogRecord } from "./types.js";
import { appendTaskLog, persistTaskJob } from "./store.js";

export interface TaskExecutionResult {
  job: TaskJob;
  log?: Omit<TaskLogRecord, "timestamp">;
  complete?: boolean;
  stop?: boolean;
}

type TaskExecutor = (job: TaskJob) => Promise<TaskExecutionResult>;

interface RuntimeEntry {
  job: TaskJob;
  executeRound: TaskExecutor;
  timer: ReturnType<typeof setTimeout> | null;
}

interface TaskRuntimeOptions {
  persistTask: (job: TaskJob) => void;
  appendLog: (jobId: string, ok: boolean, message: string) => void;
}

export class TaskRuntime {
  private tasks = new Map<string, RuntimeEntry>();
  private activeTaskId: string | null = null;

  constructor(private readonly options: TaskRuntimeOptions) {}

  startTask(job: TaskJob, executeRound: TaskExecutor): TaskJob {
    if (this.activeTaskId && this.activeTaskId !== job.id) {
      throw new Error("Another task is already running");
    }

    this.clearTaskTimer(job.id);
    const entry: RuntimeEntry = {
      job,
      executeRound,
      timer: null,
    };
    this.tasks.set(job.id, entry);
    this.activeTaskId = job.id;
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
      this.activeTaskId = job.id;
      this.scheduleNextRun(job.id);
    }
    return job;
  }

  getTask(jobId: string): TaskJob | null {
    return this.tasks.get(jobId)?.job ?? null;
  }

  getActiveTask(): TaskJob | null {
    if (!this.activeTaskId) return null;
    return this.getTask(this.activeTaskId);
  }

  async runNow(jobId: string): Promise<TaskJob | null> {
    const entry = this.tasks.get(jobId);
    if (!entry || entry.job.state !== "running") {
      return null;
    }

    entry.timer = null;
    entry.job = {
      ...entry.job,
      next_run_at: null,
      updated_at: new Date().toISOString(),
    };
    this.options.persistTask(entry.job);

    const result = await entry.executeRound(entry.job);
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

    if (result.complete) {
      entry.job = {
        ...entry.job,
        state: "completed",
        next_run_at: null,
      };
      this.activeTaskId = this.activeTaskId === entry.job.id ? null : this.activeTaskId;
    } else if (result.stop) {
      entry.job = {
        ...entry.job,
        state: "stopped",
        next_run_at: null,
      };
      this.activeTaskId = this.activeTaskId === entry.job.id ? null : this.activeTaskId;
    } else {
      entry.job = {
        ...entry.job,
        next_run_at: new Date(Date.now() + entry.job.interval_sec * 1000).toISOString(),
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
    this.activeTaskId = this.activeTaskId === jobId ? null : this.activeTaskId;
    return entry.job;
  }

  resumeTask(jobId: string): TaskJob | null {
    const entry = this.tasks.get(jobId);
    if (!entry) return null;
    if (this.activeTaskId && this.activeTaskId !== jobId) {
      throw new Error("Another task is already running");
    }
    entry.job = {
      ...entry.job,
      state: "running",
      next_run_at: null,
      updated_at: new Date().toISOString(),
    };
    this.activeTaskId = jobId;
    this.options.persistTask(entry.job);
    void this.runNow(jobId);
    return entry.job;
  }

  clearActiveTask(): void {
    this.activeTaskId = null;
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
