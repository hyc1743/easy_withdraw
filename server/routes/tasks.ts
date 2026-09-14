import { Router } from "express";
import { loadConfig } from "../config.js";
import { editStoppedArbitrage } from "../tasks/edit.js";
import type { SessionManager } from "../security.js";
import { ensureRuntimeHydrated, hydrateTask } from "../tasks/hydration.js";
import { taskRuntime } from "../tasks/runtime.js";
import { appendTaskLog, listTaskJobs, deleteTaskJob, loadLatestTask, loadTaskJob, persistTaskJob } from "../tasks/store.js";
import type { TaskJobType } from "../tasks/types.js";

export function taskRoutes(session: SessionManager): Router {
  const router = Router();

  router.get("/", (req, res) => {
    try {
      ensureRuntimeHydrated(session, req);
      const jobs = listTaskJobs().map(job => taskRuntime.getTask(job.id) ?? job);
      res.json({ ok: true, jobs });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: "BAD_REQUEST", message });
    }
  });

  router.get("/active", (req, res) => {
    try {
      ensureRuntimeHydrated(session, req);
      res.json({ ok: true, job: taskRuntime.getActiveTask(), jobs: taskRuntime.getActiveTasks() });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: "BAD_REQUEST", message });
    }
  });

  router.get("/latest", (req, res) => {
    try {
      const jobType = req.query.job_type as TaskJobType | undefined;
      const job = loadLatestTask(jobType);
      res.json({ ok: true, job });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: "BAD_REQUEST", message });
    }
  });

  router.patch("/:id", (req, res) => {
    try {
      ensureRuntimeHydrated(session, req);
      const job = taskRuntime.getTask(req.params.id) ?? loadTaskJob(req.params.id);
      if (!job) {
        res.status(404).json({ ok: false, error: "NOT_FOUND", message: "Task not found" });
        return;
      }
      if (taskRuntime.isExecuting(job.id) || job.state !== "stopped" || req.body?.updated_at !== job.updated_at) {
        res.status(409).json({ ok: false, error: "TASK_CHANGED", message: "任务正在执行或状态已变更，请重新选择任务后编辑" });
        return;
      }
      const updated = editStoppedArbitrage(job, req.body, loadConfig());
      const message = "已更新来源、目标、触发阈值和扫描间隔；任务保持停止";
      updated.logs.unshift({ timestamp: updated.updated_at, ok: true, message });
      updated.logs = updated.logs.slice(0, 200);
      persistTaskJob(updated);
      appendTaskLog(updated.id, true, message);
      hydrateTask(updated, session, req);
      res.json({ ok: true, job: updated });
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

      if (taskRuntime.hasConflict(task)) {
        res.status(409).json({ ok: false, error: "SCHEDULE_RUNNING", message: "已有其他类型任务在运行，请先停止" });
        return;
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
