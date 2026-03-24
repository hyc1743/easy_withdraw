import type { Request } from "express";
import type { SessionManager } from "../security.js";
import { loadLatestRunningTask } from "./store.js";
import type { TaskJob } from "./types.js";
import { createTaskExecutor } from "./executors.js";
import { taskRuntime } from "./runtime.js";
import { appendWithdrawHistory } from "./withdraw-history.js";

export function hydrateTask(job: TaskJob, session: SessionManager, req: Request): TaskJob {
  const executor = createTaskExecutor(job, session, req, appendWithdrawHistory);
  return taskRuntime.registerTask(job, executor);
}

export function ensureRuntimeHydrated(session: SessionManager, req: Request): void {
  if (taskRuntime.getActiveTask()) {
    return;
  }

  const persisted = loadLatestRunningTask();
  if (!persisted) return;
  hydrateTask(persisted, session, req);
}
