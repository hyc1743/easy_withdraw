import crypto from "node:crypto";
import { Router, type Request } from "express";
import type { SessionManager } from "../security.js";
import type { WithdrawRequest } from "../exchange/types.js";
import { executeWithdrawRequest, resolveAccountContext } from "../tasks/executors.js";
import { ensureRuntimeHydrated, hydrateTask } from "../tasks/hydration.js";
import { taskRuntime } from "../tasks/runtime.js";
import { loadLatestRunningTask, loadTaskJob, persistTaskJob } from "../tasks/store.js";
import type { TaskJob, TaskLogRecord } from "../tasks/types.js";
import {
  appendWithdrawHistory,
  countWithdrawHistory,
  listWithdrawHistory,
} from "../tasks/withdraw-history.js";

interface ScheduleJobView {
  id: string;
  state: "running" | "completed" | "stopped";
  interval_sec: number;
  total_count: number;
  done_count: number;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
  request: WithdrawRequest;
  logs: TaskLogRecord[];
}

interface StartScheduleBody {
  interval_sec: number;
  count: number;
  withdraw: WithdrawRequest;
}

function parsePositiveInt(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("interval_sec and count must be positive integers");
  }
  return parsed;
}

function toWithdrawScheduleJobView(job: TaskJob): ScheduleJobView {
  return {
    id: job.id,
    state: job.state,
    interval_sec: job.interval_sec,
    total_count: job.total_count,
    done_count: job.done_count,
    next_run_at: job.next_run_at,
    created_at: job.created_at,
    updated_at: job.updated_at,
    request: job.payload as WithdrawRequest,
    logs: job.logs,
  };
}

export function withdrawRoutes(session: SessionManager): Router {
  const router = Router();

  router.post("/preview", async (req, res) => {
    try {
      const withdraw = req.body as WithdrawRequest;
      const context = resolveAccountContext(withdraw.account_id, session, req);
      await context.adapter.validateRequest(withdraw);
      res.json({ ok: true, message: "Validation passed" });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: "BAD_REQUEST", message });
    }
  });

  router.post("/execute", async (req, res) => {
    try {
      const withdraw = req.body as WithdrawRequest;
      const context = resolveAccountContext(withdraw.account_id, session, req);
      const autoId = `exec-${Date.now()}-${crypto.randomUUID()}`;
      const result = await executeWithdrawRequest(withdraw, context, autoId);
      appendWithdrawHistory({
        timestamp: new Date().toISOString(),
        account_id: withdraw.account_id,
        exchange: context.exchange,
        asset: withdraw.asset,
        network: withdraw.network,
        address: withdraw.address,
        amount: withdraw.amount,
        withdraw_id: result.withdraw_id,
        status: result.status,
      });
      res.json(result);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ ok: false, error: "EXCHANGE_ERROR", message });
    }
  });

  router.post("/schedule/start", async (req, res) => {
    try {
      ensureRuntimeHydrated(session, req);
      if (taskRuntime.getActiveTask()) {
        res.status(409).json({
          ok: false,
          error: "SCHEDULE_RUNNING",
          message: "已有定时任务在运行，请先停止",
        });
        return;
      }

      const body = req.body as StartScheduleBody;
      const intervalSec = parsePositiveInt(body.interval_sec);
      const count = parsePositiveInt(body.count);
      const withdraw = body.withdraw as WithdrawRequest;
      if (!withdraw?.account_id) {
        throw new Error("withdraw payload is required");
      }

      const context = resolveAccountContext(withdraw.account_id, session, req);
      await context.adapter.validateRequest(withdraw);

      const now = new Date().toISOString();
      const job: TaskJob = {
        id: `sch_${crypto.randomUUID()}`,
        job_type: "withdraw",
        state: "running",
        interval_sec: intervalSec,
        total_count: count,
        done_count: 0,
        next_run_at: null,
        created_at: now,
        updated_at: now,
        payload: withdraw,
        progress: {},
        logs: [],
      };

      hydrateTask(job, session, req);
      void taskRuntime.runNow(job.id);

      const started = taskRuntime.getTask(job.id) ?? job;
      res.json({ ok: true, job: toWithdrawScheduleJobView(started) });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: "BAD_REQUEST", message });
    }
  });

  router.post("/schedule/:id/stop", (req, res) => {
    try {
      ensureRuntimeHydrated(session, req);
      const runtimeTask = taskRuntime.getTask(req.params.id);
      if (runtimeTask?.job_type === "withdraw") {
        const stopped = taskRuntime.stopTask(
          req.params.id,
          `手动停止: 已完成 ${runtimeTask.done_count}/${runtimeTask.total_count}`,
        );
        res.json({ ok: true, job: toWithdrawScheduleJobView(stopped ?? runtimeTask) });
        return;
      }

      const persisted = loadTaskJob(req.params.id);
      if (!persisted || persisted.job_type !== "withdraw") {
        res.status(404).json({
          ok: false,
          error: "NOT_FOUND",
          message: "Schedule job not found",
        });
        return;
      }

      if (persisted.state === "running") {
        persisted.state = "stopped";
        persisted.next_run_at = null;
        persisted.updated_at = new Date().toISOString();
        persisted.logs.unshift({
          timestamp: new Date().toISOString(),
          ok: false,
          message: `手动停止: 已完成 ${persisted.done_count}/${persisted.total_count}`,
        });
        persistTaskJob(persisted);
      }

      res.json({ ok: true, job: toWithdrawScheduleJobView(persisted) });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: "BAD_REQUEST", message });
    }
  });

  router.post("/schedule/:id/resume", (req, res) => {
    try {
      ensureRuntimeHydrated(session, req);
      const active = taskRuntime.getActiveTask();
      if (active && active.id !== req.params.id) {
        res.status(409).json({
          ok: false,
          error: "SCHEDULE_RUNNING",
          message: "已有其他定时任务在运行，请先停止",
        });
        return;
      }

      let task = taskRuntime.getTask(req.params.id);
      if (!task) {
        const persisted = loadTaskJob(req.params.id);
        if (!persisted || persisted.job_type !== "withdraw") {
          res.status(404).json({
            ok: false,
            error: "NOT_FOUND",
            message: "Schedule job not found",
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

      task.logs.unshift({
        timestamp: new Date().toISOString(),
        ok: true,
        message: `手动继续: 当前进度 ${task.done_count}/${task.total_count}`,
      });
      persistTaskJob(task);

      const resumed = taskRuntime.resumeTask(task.id) ?? task;
      res.json({ ok: true, job: toWithdrawScheduleJobView(resumed) });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: "BAD_REQUEST", message });
    }
  });

  router.get("/schedule/active", (req, res) => {
    try {
      ensureRuntimeHydrated(session, req);
      const active = taskRuntime.getActiveTask();
      if (!active || active.job_type !== "withdraw") {
        res.json({ ok: true, job: null });
        return;
      }
      res.json({ ok: true, job: toWithdrawScheduleJobView(active) });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: "BAD_REQUEST", message });
    }
  });

  router.get("/schedule/:id", (req, res) => {
    try {
      ensureRuntimeHydrated(session, req);
      const runtimeTask = taskRuntime.getTask(req.params.id);
      if (runtimeTask?.job_type === "withdraw") {
        res.json({ ok: true, job: toWithdrawScheduleJobView(runtimeTask) });
        return;
      }

      const persisted = loadTaskJob(req.params.id);
      if (!persisted || persisted.job_type !== "withdraw") {
        res.status(404).json({
          ok: false,
          error: "NOT_FOUND",
          message: "Schedule job not found",
        });
        return;
      }
      res.json({ ok: true, job: toWithdrawScheduleJobView(persisted) });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: "BAD_REQUEST", message });
    }
  });

  router.get("/history", (req, res) => {
    const limit = Number(req.query.limit) || 20;
    const offset = Number(req.query.offset) || 0;
    const records = listWithdrawHistory(limit, offset);
    const total = countWithdrawHistory();
    res.json({ records, total });
  });

  router.get("/:id", async (req, res) => {
    try {
      const accountId = req.query.account_id as string;
      if (!accountId) {
        res.status(400).json({
          ok: false,
          error: "BAD_REQUEST",
          message: "account_id query param required",
        });
        return;
      }
      const context = resolveAccountContext(accountId, session, req);
      const result = await context.adapter.queryStatus(req.params.id, context.creds);
      res.json(result);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ ok: false, error: "EXCHANGE_ERROR", message });
    }
  });

  return router;
}
