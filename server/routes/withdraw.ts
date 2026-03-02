import crypto from "node:crypto";
import { Router } from "express";
import { decrypt, type SessionManager } from "../security.js";
import { loadConfig } from "../config.js";
import { GateAdapter } from "../exchange/gate.js";
import { getDb } from "../db.js";
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

interface ScheduleJobRow {
  id: string;
  state: ScheduleState;
  interval_sec: number;
  total_count: number;
  done_count: number;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
  request_json: string;
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

const db = getDb();
const scheduleJobs = new Map<string, ScheduleJobInternal>();
let activeScheduleJobId: string | null = null;

function appendHistory(record: HistoryRecord): void {
  db.prepare(
    `INSERT INTO withdraw_history(
      timestamp, account_id, exchange, asset, network, address, amount, withdraw_id, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    record.timestamp,
    record.account_id,
    record.exchange,
    record.asset,
    record.network,
    record.address,
    record.amount,
    record.withdraw_id,
    record.status,
  );
}

function listHistory(limit: number, offset: number): HistoryRecord[] {
  return db
    .prepare(
      `SELECT
        timestamp, account_id, exchange, asset, network, address, amount, withdraw_id, status
      FROM withdraw_history
      ORDER BY id DESC
      LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as HistoryRecord[];
}

function countHistory(): number {
  const row = db
    .prepare("SELECT COUNT(1) as n FROM withdraw_history")
    .get() as { n: number };
  return row.n;
}

function persistScheduleJob(job: ScheduleJobView): void {
  db.prepare(
    `INSERT INTO schedule_jobs(
      id, state, interval_sec, total_count, done_count, next_run_at, created_at, updated_at, request_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      state = excluded.state,
      interval_sec = excluded.interval_sec,
      total_count = excluded.total_count,
      done_count = excluded.done_count,
      next_run_at = excluded.next_run_at,
      updated_at = excluded.updated_at,
      request_json = excluded.request_json`,
  ).run(
    job.id,
    job.state,
    job.interval_sec,
    job.total_count,
    job.done_count,
    job.next_run_at,
    job.created_at,
    job.updated_at,
    JSON.stringify(job.request),
  );
}

function loadScheduleLogs(jobId: string, limit: number = 200): ScheduleLogRecord[] {
  const rows = db
    .prepare(
      `SELECT timestamp, ok, message
      FROM schedule_logs
      WHERE job_id = ?
      ORDER BY id DESC
      LIMIT ?`,
    )
    .all(jobId, limit) as Array<{ timestamp: string; ok: number; message: string }>;
  return rows.map((row) => ({
    timestamp: row.timestamp,
    ok: row.ok === 1,
    message: row.message,
  }));
}

function appendScheduleLog(jobId: string, ok: boolean, message: string): void {
  db.prepare(
    "INSERT INTO schedule_logs(job_id, timestamp, ok, message) VALUES (?, ?, ?, ?)",
  ).run(jobId, new Date().toISOString(), ok ? 1 : 0, message);
}

function loadScheduleJob(jobId: string): ScheduleJobView | null {
  const row = db
    .prepare(
      `SELECT id, state, interval_sec, total_count, done_count, next_run_at, created_at, updated_at, request_json
      FROM schedule_jobs WHERE id = ?`,
    )
    .get(jobId) as ScheduleJobRow | undefined;
  if (!row) return null;
  return {
    id: row.id,
    state: row.state,
    interval_sec: row.interval_sec,
    total_count: row.total_count,
    done_count: row.done_count,
    next_run_at: row.next_run_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    request: JSON.parse(row.request_json) as WithdrawRequest,
    logs: loadScheduleLogs(row.id),
  };
}

function loadLatestRunningJob(): ScheduleJobView | null {
  const row = db
    .prepare(
      `SELECT id, state, interval_sec, total_count, done_count, next_run_at, created_at, updated_at, request_json
      FROM schedule_jobs
      WHERE state = 'running'
      ORDER BY created_at DESC
      LIMIT 1`,
    )
    .get() as ScheduleJobRow | undefined;
  if (!row) return null;
  return {
    id: row.id,
    state: row.state,
    interval_sec: row.interval_sec,
    total_count: row.total_count,
    done_count: row.done_count,
    next_run_at: row.next_run_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    request: JSON.parse(row.request_json) as WithdrawRequest,
    logs: loadScheduleLogs(row.id),
  };
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
  idempotencyKey?: string,
): Promise<WithdrawResponse> {
  const effectiveReq: WithdrawRequest = {
    ...wReq,
    client_withdraw_id: wReq.client_withdraw_id ?? idempotencyKey,
  };

  await adapter.validateRequest(effectiveReq);
  const result = await adapter.withdraw(effectiveReq, creds);

  appendHistory({
    timestamp: new Date().toISOString(),
    account_id: effectiveReq.account_id,
    exchange,
    asset: effectiveReq.asset,
    network: effectiveReq.network,
    address: effectiveReq.address,
    amount: effectiveReq.amount,
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
  const rec: ScheduleLogRecord = {
    timestamp: new Date().toISOString(),
    ok,
    message,
  };
  job.logs.unshift(rec);
  if (job.logs.length > 200) job.logs.length = 200;
  appendScheduleLog(job.id, ok, message);
}

function scheduleNextRun(job: ScheduleJobInternal): void {
  job.next_run_at = new Date(Date.now() + job.interval_sec * 1000).toISOString();
  job.updated_at = new Date().toISOString();
  persistScheduleJob(toJobView(job));

  const delayMs = Math.max(
    0,
    new Date(job.next_run_at).getTime() - Date.now(),
  );

  job.timer = setTimeout(() => {
    void runScheduleJob(job.id);
  }, delayMs);
}

async function runScheduleJob(jobId: string): Promise<void> {
  const job = scheduleJobs.get(jobId);
  if (!job || job.state !== "running") {
    return;
  }

  job.timer = null;
  job.next_run_at = null;
  job.updated_at = new Date().toISOString();
  persistScheduleJob(toJobView(job));

  const round = job.done_count + 1;
  const idempotencyKey = `${job.id}-round-${round}`;

  try {
    const result = await executeWithdraw(
      job.request,
      job.adapter,
      job.creds,
      job.exchange,
      idempotencyKey,
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
    job.next_run_at = null;
    addScheduleLog(job, true, `全部完成: ${job.done_count}/${job.total_count}`);
    persistScheduleJob(toJobView(job));
    activeScheduleJobId = activeScheduleJobId === job.id ? null : activeScheduleJobId;
    return;
  }

  persistScheduleJob(toJobView(job));
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
  persistScheduleJob(toJobView(job));
  activeScheduleJobId = activeScheduleJobId === job.id ? null : activeScheduleJobId;
}

function parsePositiveInt(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("interval_sec and count must be positive integers");
  }
  return parsed;
}

function hydrateRuntimeJob(
  session: SessionManager,
  job: ScheduleJobView,
): ScheduleJobInternal {
  const { adapter, creds, exchange } = resolveAccount(job.request.account_id, session);
  return {
    ...job,
    timer: null,
    adapter,
    creds,
    exchange,
  };
}

function ensureRuntimeActiveJob(session: SessionManager): void {
  if (activeScheduleJobId && scheduleJobs.has(activeScheduleJobId)) {
    return;
  }

  const running = loadLatestRunningJob();
  if (!running) {
    activeScheduleJobId = null;
    return;
  }

  const runtime = hydrateRuntimeJob(session, running);
  scheduleJobs.set(runtime.id, runtime);
  activeScheduleJobId = runtime.id;

  if (runtime.next_run_at) {
    const delayMs = new Date(runtime.next_run_at).getTime() - Date.now();
    if (delayMs > 0) {
      runtime.timer = setTimeout(() => {
        void runScheduleJob(runtime.id);
      }, delayMs);
      return;
    }
  }

  void runScheduleJob(runtime.id);
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
      const autoId = `exec-${Date.now()}-${crypto.randomUUID()}`;
      const result = await executeWithdraw(wReq, adapter, creds, exchange, autoId);
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
      ensureRuntimeActiveJob(session);
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
      activeScheduleJobId = job.id;
      persistScheduleJob(toJobView(job));
      void runScheduleJob(job.id);

      res.json({ ok: true, job: toJobView(job) });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(400).json({ ok: false, error: "BAD_REQUEST", message: msg });
    }
  });

  // POST /api/withdraw/schedule/:id/stop
  router.post("/schedule/:id/stop", (req, res) => {
    try {
      ensureRuntimeActiveJob(session);
      const job = scheduleJobs.get(req.params.id);
      if (!job) {
        const persisted = loadScheduleJob(req.params.id);
        if (!persisted) {
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
          persistScheduleJob(persisted);
          appendScheduleLog(
            persisted.id,
            false,
            `手动停止: 已完成 ${persisted.done_count}/${persisted.total_count}`,
          );
          persisted.logs = loadScheduleLogs(persisted.id);
        }
        res.json({ ok: true, job: persisted });
        return;
      }

      if (job.state === "running") {
        stopScheduleJob(job, `手动停止: 已完成 ${job.done_count}/${job.total_count}`);
      }

      res.json({ ok: true, job: toJobView(job) });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(400).json({ ok: false, error: "BAD_REQUEST", message: msg });
    }
  });

  // GET /api/withdraw/schedule/active
  router.get("/schedule/active", (_req, res) => {
    try {
      ensureRuntimeActiveJob(session);
      if (!activeScheduleJobId) {
        res.json({ ok: true, job: null });
        return;
      }
      const job = scheduleJobs.get(activeScheduleJobId) ?? null;
      res.json({ ok: true, job: job ? toJobView(job) : null });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(400).json({ ok: false, error: "BAD_REQUEST", message: msg });
    }
  });

  // GET /api/withdraw/schedule/:id
  router.get("/schedule/:id", (req, res) => {
    try {
      ensureRuntimeActiveJob(session);
      const runtime = scheduleJobs.get(req.params.id);
      if (runtime) {
        res.json({ ok: true, job: toJobView(runtime) });
        return;
      }

      const job = loadScheduleJob(req.params.id);
      if (!job) {
        res.status(404).json({
          ok: false,
          error: "NOT_FOUND",
          message: "Schedule job not found",
        });
        return;
      }
      res.json({ ok: true, job });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(400).json({ ok: false, error: "BAD_REQUEST", message: msg });
    }
  });

  // GET /api/withdraw/history — must be before /:id
  router.get("/history", (_req, res) => {
    const limit = Number(_req.query.limit) || 20;
    const offset = Number(_req.query.offset) || 0;
    const records = listHistory(limit, offset);
    const total = countHistory();
    res.json({ records, total });
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
