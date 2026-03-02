import crypto from "node:crypto";
import fs from "node:fs";
import { Router } from "express";
import { decrypt, type SessionManager } from "../security.js";
import { loadConfig, getHistoryPath } from "../config.js";
import { GateAdapter } from "../exchange/gate.js";
import type {
  DecryptedCreds,
  ExchangeAdapter,
  WithdrawRequest,
  WithdrawResponse,
} from "../exchange/types.js";

const adapters: Record<string, ExchangeAdapter> = {
  gate: new GateAdapter(),
};

interface HistoryRecord {
  timestamp: string;
  account_id: string;
  exchange: string;
  asset: string;
  network: string;
  address: string;
  amount: string;
  withdraw_id: string;
  status: string;
}

interface ScheduleLogRecord {
  timestamp: string;
  ok: boolean;
  message: string;
}

type ScheduleState = "running" | "completed" | "stopped";

interface ScheduleJobView {
  id: string;
  state: ScheduleState;
  interval_sec: number;
  total_count: number;
  done_count: number;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
  request: WithdrawRequest;
  logs: ScheduleLogRecord[];
}

interface ScheduleJobInternal extends ScheduleJobView {
  timer: ReturnType<typeof setTimeout> | null;
  adapter: ExchangeAdapter;
  creds: DecryptedCreds;
  exchange: string;
}

interface StartScheduleBody {
  interval_sec: number;
  count: number;
  withdraw: WithdrawRequest;
}

const scheduleJobs = new Map<string, ScheduleJobInternal>();
const scheduleOrder: string[] = [];
let activeScheduleJobId: string | null = null;

function appendHistory(record: HistoryRecord): void {
  const histPath = getHistoryPath();
  let records: HistoryRecord[] = [];
  if (fs.existsSync(histPath)) {
    records = JSON.parse(fs.readFileSync(histPath, "utf-8"));
  }
  records.push(record);
  fs.writeFileSync(histPath, JSON.stringify(records, null, 2), "utf-8");
}

function resolveAccount(
  accountId: string,
  session: SessionManager,
): { adapter: ExchangeAdapter; creds: DecryptedCreds; exchange: string } {
  const config = loadConfig();
  const acct = config.accounts.find((a) => a.id === accountId);
  if (!acct) throw new Error("Account not found");

  const adapter = adapters[acct.exchange];
  if (!adapter) throw new Error(`Unsupported exchange: ${acct.exchange}`);

  const key = session.getKey()!;
  const creds: DecryptedCreds = {
    api_key: acct.api_key,
    api_secret: acct.api_secret_enc ? decrypt(acct.api_secret_enc, key) : "",
    passphrase: acct.passphrase_enc
      ? decrypt(acct.passphrase_enc, key)
      : undefined,
  };
  return { adapter, creds, exchange: acct.exchange };
}

async function executeWithdraw(
  wReq: WithdrawRequest,
  adapter: ExchangeAdapter,
  creds: DecryptedCreds,
  exchange: string,
): Promise<WithdrawResponse> {
  await adapter.validateRequest(wReq);
  const result = await adapter.withdraw(wReq, creds);

  appendHistory({
    timestamp: new Date().toISOString(),
    account_id: wReq.account_id,
    exchange,
    asset: wReq.asset,
    network: wReq.network,
    address: wReq.address,
    amount: wReq.amount,
    withdraw_id: result.withdraw_id,
    status: result.status,
  });

  return result;
}

function toJobView(job: ScheduleJobInternal): ScheduleJobView {
  return {
    id: job.id,
    state: job.state,
    interval_sec: job.interval_sec,
    total_count: job.total_count,
    done_count: job.done_count,
    next_run_at: job.next_run_at,
    created_at: job.created_at,
    updated_at: job.updated_at,
    request: job.request,
    logs: job.logs,
  };
}

function addScheduleLog(job: ScheduleJobInternal, ok: boolean, message: string): void {
  job.logs.unshift({
    timestamp: new Date().toISOString(),
    ok,
    message,
  });
  if (job.logs.length > 200) {
    job.logs.length = 200;
  }
}

function scheduleNextRun(job: ScheduleJobInternal): void {
  job.next_run_at = new Date(Date.now() + job.interval_sec * 1000).toISOString();
  job.updated_at = new Date().toISOString();
  job.timer = setTimeout(() => {
    void runScheduleJob(job.id);
  }, job.interval_sec * 1000);
}

async function runScheduleJob(jobId: string): Promise<void> {
  const job = scheduleJobs.get(jobId);
  if (!job || job.state !== "running") {
    return;
  }

  job.timer = null;
  job.next_run_at = null;
  job.updated_at = new Date().toISOString();

  try {
    const result = await executeWithdraw(
      job.request,
      job.adapter,
      job.creds,
      job.exchange,
    );
    job.done_count += 1;
    addScheduleLog(
      job,
      true,
      `第${job.done_count}/${job.total_count}次成功 - ID: ${result.withdraw_id}`,
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    job.done_count += 1;
    addScheduleLog(
      job,
      false,
      `第${job.done_count}/${job.total_count}次失败: ${msg}`,
    );
  }

  job.updated_at = new Date().toISOString();

  if (job.done_count >= job.total_count) {
    job.state = "completed";
    addScheduleLog(job, true, `全部完成: ${job.done_count}/${job.total_count}`);
    activeScheduleJobId = activeScheduleJobId === job.id ? null : activeScheduleJobId;
    return;
  }

  scheduleNextRun(job);
}

function stopScheduleJob(job: ScheduleJobInternal, reason: string): void {
  if (job.timer) {
    clearTimeout(job.timer);
    job.timer = null;
  }
  job.state = "stopped";
  job.next_run_at = null;
  job.updated_at = new Date().toISOString();
  addScheduleLog(job, false, reason);
  activeScheduleJobId = activeScheduleJobId === job.id ? null : activeScheduleJobId;
}

function parsePositiveInt(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("interval_sec and count must be positive integers");
  }
  return parsed;
}

export function withdrawRoutes(session: SessionManager): Router {
  const router = Router();

  // POST /api/withdraw/preview
  router.post("/preview", async (req, res) => {
    try {
      const wReq = req.body as WithdrawRequest;
      const { adapter } = resolveAccount(wReq.account_id, session);
      await adapter.validateRequest(wReq);
      res.json({ ok: true, message: "Validation passed" });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(400).json({ ok: false, error: "BAD_REQUEST", message: msg });
    }
  });

  // POST /api/withdraw/execute
  router.post("/execute", async (req, res) => {
    try {
      const wReq = req.body as WithdrawRequest;
      const { adapter, creds, exchange } = resolveAccount(wReq.account_id, session);
      const result = await executeWithdraw(wReq, adapter, creds, exchange);
      res.json(result);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({
        ok: false,
        error: "EXCHANGE_ERROR",
        message: msg,
      });
    }
  });

  // POST /api/withdraw/schedule/start
  router.post("/schedule/start", async (req, res) => {
    try {
      if (activeScheduleJobId) {
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
      const wReq = body.withdraw as WithdrawRequest;
      if (!wReq || typeof wReq.account_id !== "string") {
        throw new Error("withdraw payload is required");
      }

      const { adapter, creds, exchange } = resolveAccount(wReq.account_id, session);
      await adapter.validateRequest(wReq);

      const now = new Date().toISOString();
      const job: ScheduleJobInternal = {
        id: `sch_${crypto.randomUUID()}`,
        state: "running",
        interval_sec: intervalSec,
        total_count: count,
        done_count: 0,
        next_run_at: null,
        created_at: now,
        updated_at: now,
        request: wReq,
        logs: [],
        timer: null,
        adapter,
        creds,
        exchange,
      };

      addScheduleLog(
        job,
        true,
        `定时提现开始: ${count} 次, 间隔 ${intervalSec}s`,
      );

      scheduleJobs.set(job.id, job);
      scheduleOrder.unshift(job.id);
      if (scheduleOrder.length > 100) {
        const removed = scheduleOrder.pop();
        if (removed) {
          scheduleJobs.delete(removed);
        }
      }

      activeScheduleJobId = job.id;
      void runScheduleJob(job.id);

      res.json({ ok: true, job: toJobView(job) });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(400).json({ ok: false, error: "BAD_REQUEST", message: msg });
    }
  });

  // POST /api/withdraw/schedule/:id/stop
  router.post("/schedule/:id/stop", (req, res) => {
    const job = scheduleJobs.get(req.params.id);
    if (!job) {
      res.status(404).json({
        ok: false,
        error: "NOT_FOUND",
        message: "Schedule job not found",
      });
      return;
    }

    if (job.state === "running") {
      stopScheduleJob(job, `手动停止: 已完成 ${job.done_count}/${job.total_count}`);
    }

    res.json({ ok: true, job: toJobView(job) });
  });

  // GET /api/withdraw/schedule/active
  router.get("/schedule/active", (_req, res) => {
    if (!activeScheduleJobId) {
      res.json({ ok: true, job: null });
      return;
    }
    const job = scheduleJobs.get(activeScheduleJobId) ?? null;
    res.json({ ok: true, job: job ? toJobView(job) : null });
  });

  // GET /api/withdraw/schedule/:id
  router.get("/schedule/:id", (req, res) => {
    const job = scheduleJobs.get(req.params.id);
    if (!job) {
      res.status(404).json({
        ok: false,
        error: "NOT_FOUND",
        message: "Schedule job not found",
      });
      return;
    }
    res.json({ ok: true, job: toJobView(job) });
  });

  // GET /api/withdraw/history — must be before /:id
  router.get("/history", (_req, res) => {
    const histPath = getHistoryPath();
    let records: HistoryRecord[] = [];
    if (fs.existsSync(histPath)) {
      records = JSON.parse(fs.readFileSync(histPath, "utf-8"));
    }
    const limit = Number(_req.query.limit) || 20;
    const offset = Number(_req.query.offset) || 0;
    const page = records.reverse().slice(offset, offset + limit);
    res.json({ records: page, total: records.length });
  });

  // GET /api/withdraw/:id
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
      const { adapter, creds } = resolveAccount(accountId, session);
      const result = await adapter.queryStatus(req.params.id, creds);
      res.json(result);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({
        ok: false,
        error: "EXCHANGE_ERROR",
        message: msg,
      });
    }
  });

  return router;
}
