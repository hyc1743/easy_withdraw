import crypto from "node:crypto";
import { Router } from "express";
import type { SessionManager } from "../security.js";
import { resolveAccountContext, previewSellQuantity } from "../tasks/executors.js";
import { ensureRuntimeHydrated, hydrateTask } from "../tasks/hydration.js";
import { taskRuntime } from "../tasks/runtime.js";
import type { SellMarketTaskPayload, TaskJob } from "../tasks/types.js";

interface SellPreviewBody extends SellMarketTaskPayload {}

function validateBinanceContext(accountId: string, session: SessionManager, req: Parameters<Router["get"]>[1] extends never ? never : any) {
  const context = resolveAccountContext(accountId, session, req);
  if (context.exchange !== "binance") {
    throw new Error("Only Binance accounts support auto sell");
  }
  return context;
}

function parsePositiveInterval(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("interval_sec must be a positive integer");
  }
  return parsed;
}

export function tradeRoutes(session: SessionManager): Router {
  const router = Router();

  router.get("/binance/symbols", async (req, res) => {
    try {
      const accountId = req.query.account_id as string;
      if (!accountId) {
        throw new Error("account_id query param required");
      }
      const context = validateBinanceContext(accountId, session, req);
      if (!context.adapter.listSpotSymbols) {
        throw new Error("Exchange does not support spot symbol lookup");
      }
      const symbols = await context.adapter.listSpotSymbols(context.creds);
      res.json({ ok: true, symbols });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: "BAD_REQUEST", message });
    }
  });

  router.get("/binance/symbol/:symbol", async (req, res) => {
    try {
      const accountId = req.query.account_id as string;
      if (!accountId) {
        throw new Error("account_id query param required");
      }
      const context = validateBinanceContext(accountId, session, req);
      if (!context.adapter.getSpotSymbol) {
        throw new Error("Exchange does not support spot symbol lookup");
      }
      const symbol = await context.adapter.getSpotSymbol(req.params.symbol, context.creds);
      res.json({ ok: true, symbol });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: "BAD_REQUEST", message });
    }
  });

  router.get("/binance/balance", async (req, res) => {
    try {
      const accountId = req.query.account_id as string;
      const asset = req.query.asset as string;
      if (!accountId || !asset) {
        throw new Error("account_id and asset query params required");
      }
      const context = validateBinanceContext(accountId, session, req);
      const balance = await context.adapter.getBalance(asset, context.creds);
      res.json({ ok: true, balance });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: "BAD_REQUEST", message });
    }
  });

  router.post("/sell/preview", async (req, res) => {
    try {
      const body = req.body as SellPreviewBody;
      body.interval_sec = parsePositiveInterval(body.interval_sec);
      const context = validateBinanceContext(body.account_id, session, req);
      const preview = await previewSellQuantity(body, context);
      res.json({ ok: true, preview });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: "BAD_REQUEST", message });
    }
  });

  router.post("/sell/schedule/start", async (req, res) => {
    try {
      ensureRuntimeHydrated(session, req);
      if (taskRuntime.getActiveTask()) {
        res.status(409).json({
          ok: false,
          error: "SCHEDULE_RUNNING",
          message: "已有任务在运行，请先停止",
        });
        return;
      }

      const payload = req.body as SellMarketTaskPayload;
      payload.interval_sec = parsePositiveInterval(payload.interval_sec);
      const context = validateBinanceContext(payload.account_id, session, req);
      const preview = await previewSellQuantity(payload, context);
      if (!preview.can_execute) {
        throw new Error("Current balance or lot size rules do not allow execution");
      }

      const now = new Date().toISOString();
      const job: TaskJob = {
        id: `sell_${crypto.randomUUID()}`,
        job_type: "sell_market",
        state: "running",
        interval_sec: payload.interval_sec,
        total_count: 0,
        done_count: 0,
        next_run_at: null,
        created_at: now,
        updated_at: now,
        payload,
        progress: {},
        logs: [],
      };

      hydrateTask(job, session, req);
      void taskRuntime.runNow(job.id);
      res.json({ ok: true, job: taskRuntime.getTask(job.id) ?? job });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: "BAD_REQUEST", message });
    }
  });

  return router;
}
