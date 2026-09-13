import type { Request } from "express";
import type { SessionManager } from "../security.js";
import { listTaskJobs, stopInterruptedRunningTasks } from "./store.js";
import type { TaskJob } from "./types.js";
import { createTaskExecutor } from "./executors.js";
import { taskRuntime } from "./runtime.js";
import { appendWithdrawHistory } from "./withdraw-history.js";

export function hydrateTask(job: TaskJob, session: SessionManager, req: Request): TaskJob {
  const executor = createTaskExecutor(job, session, req, appendWithdrawHistory);
  return taskRuntime.registerTask(job, executor);
}

let hydrated = false;

export function ensureRuntimeHydrated(session: SessionManager, req: Request): void {
  if (hydrated) return;
  stopInterruptedRunningTasks();
  for (const persisted of listTaskJobs()) {
    if (persisted.state === "running" && !taskRuntime.getTask(persisted.id)) {
      hydrateTask(persisted, session, req);
    }
  }
  hydrated = true;
}
