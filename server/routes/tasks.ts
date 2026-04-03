import { Router } from "express";
import type { SessionManager } from "../security.js";
import { ensureRuntimeHydrated, hydrateTask } from "../tasks/hydration.js";
import { taskRuntime } from "../tasks/runtime.js";
import { appendTaskLog, deleteTaskJob, loadLatestTask, loadTaskJob, persistTaskJob } from "../tasks/store.js";

export function taskRoutes(session: SessionManager): Router {
  const router = Router();

  router.get("/active", (req, res) => {
    try {
      ensureRuntimeHydrated(session, req);
      res.json({ ok: true, job: taskRuntime.getActiveTask() });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: "BAD_REQUEST", message });
    }
  });

  router.get("/latest", (req, res) => {
    try {
      const jobType = req.query.job_type as "withdraw" | "sell_market" | undefined;
      const job = loadLatestTask(jobType);
      res.json({ ok: true, job });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: "BAD_REQUEST", message });
    }
  });

  router.get("/:id", (req, res) => {
    try {
      ensureRuntimeHydrated(session, req);
      const runtimeTask = taskRuntime.getTask(req.params.id);
      if (runtimeTask) {
        res.json({ ok: true, job: runtimeTask });
        return;
      }

      const persisted = loadTaskJob(req.params.id);
      if (!persisted) {
        res.status(404).json({
          ok: false,
          error: "NOT_FOUND",
          message: "Task not found",
        });
        return;
      }
      res.json({ ok: true, job: persisted });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: "BAD_REQUEST", message });
    }
  });

  router.post("/:id/stop", (req, res) => {
    try {
      ensureRuntimeHydrated(session, req);
      const runtimeTask = taskRuntime.getTask(req.params.id);
      if (runtimeTask) {
        const stopped = taskRuntime.stopTask(req.params.id, "手动停止任务");
        res.json({ ok: true, job: stopped ?? runtimeTask });
        return;
      }

      const persisted = loadTaskJob(req.params.id);
      if (!persisted) {
        res.status(404).json({
          ok: false,
          error: "NOT_FOUND",
          message: "Task not found",
        });
        return;
      }

      if (persisted.state === "running") {
        persisted.state = "stopped";
        persisted.next_run_at = null;
        persisted.updated_at = new Date().toISOString();
        persistTaskJob(persisted);
        appendTaskLog(persisted.id, false, "手动停止任务");
        persisted.logs = [{ timestamp: new Date().toISOString(), ok: false, message: "手动停止任务" }, ...persisted.logs];
      }

      res.json({ ok: true, job: persisted });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: "BAD_REQUEST", message });
    }
  });

  router.post("/:id/resume", (req, res) => {
    try {
      ensureRuntimeHydrated(session, req);
      const active = taskRuntime.getActiveTask();
      if (active && active.id !== req.params.id) {
        res.status(409).json({
          ok: false,
          error: "SCHEDULE_RUNNING",
          message: "已有其他任务在运行，请先停止",
        });
        return;
      }

      let task = taskRuntime.getTask(req.params.id);
      if (!task) {
        const persisted = loadTaskJob(req.params.id);
        if (!persisted) {
          res.status(404).json({
            ok: false,
            error: "NOT_FOUND",
            message: "Task not found",
          });
          return;
        }
        task = hydrateTask(persisted, session, req);
      }

      if (task.state === "completed") {
        res.status(400).json({
          ok: false,
          error: "BAD_REQUEST",
          message: "已完成任务不能继续",
        });
        return;
      }

      appendTaskLog(task.id, true, "手动继续任务");
      task.logs = [{ timestamp: new Date().toISOString(), ok: true, message: "手动继续任务" }, ...task.logs];
      persistTaskJob(task);

      const resumed = taskRuntime.resumeTask(task.id) ?? task;
      res.json({ ok: true, job: resumed });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: "BAD_REQUEST", message });
    }
  });

  router.post("/:id/terminate", (req, res) => {
    try {
      ensureRuntimeHydrated(session, req);
      const runtimeTask = taskRuntime.removeTask(req.params.id);
      const persisted = loadTaskJob(req.params.id);

      if (!runtimeTask && !persisted) {
        res.status(404).json({
          ok: false,
          error: "NOT_FOUND",
          message: "Task not found",
        });
        return;
      }

      deleteTaskJob(req.params.id);
      res.json({ ok: true, job: runtimeTask ?? persisted });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: "BAD_REQUEST", message });
    }
  });

  return router;
}
