import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { SessionManager } from "../security.js";
import { resolveAccountContext, previewSellQuantity } from "../tasks/executors.js";
import { ensureRuntimeHydrated, hydrateTask } from "../tasks/hydration.js";
import { taskRuntime } from "../tasks/runtime.js";
import type { SellMarketTaskPayload, TaskJob } from "../tasks/types.js";

interface SellPreviewBody extends SellMarketTaskPayload {}

function validateAutoSellContext(
  accountId: string,
  session: SessionManager,
  req: Request,
) {
  const context = resolveAccountContext(accountId, session, req);
  if (!context.adapter.listSpotSymbols || !context.adapter.getSpotSymbol || !context.adapter.placeMarketSellOrder) {
    throw new Error("Exchange does not support spot auto sell");
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

function queryParamAsString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function logSellPreview(label: string, body: SellPreviewBody, preview: Awaited<ReturnType<typeof previewSellQuantity>>): void {
  const orderNotional =
    Number(preview.executable_qty) * Number(preview.symbol.last_price ?? "0");
  console.log(
    `[sell-preview:${label}] exchange=${body.account_id} symbol=${body.symbol} base=${body.base_asset} quote=${body.quote_asset} step_amount=${body.step_amount} requested_qty=${preview.requested_qty} executable_qty=${preview.executable_qty} balance=${preview.balance_available} step_size=${preview.symbol.step_size} min_qty=${preview.symbol.min_qty} last_price=${preview.symbol.last_price ?? "0"} notional=${orderNotional} min_quote_amount=${preview.symbol.min_quote_amount ?? "0"} can_execute=${preview.can_execute}`,
  );
}

export function tradeRoutes(session: SessionManager): Router {
  const router = Router();

  const listSymbols = async (req: Request, res: Response) => {
    try {
      const accountId = queryParamAsString(req.query.account_id as string | string[] | undefined);
      if (!accountId) {
        throw new Error("account_id query param required");
      }
      const context = validateAutoSellContext(accountId, session, req);
      const symbols = await context.adapter.listSpotSymbols!(context.creds);
      res.json({ ok: true, symbols });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: "BAD_REQUEST", message });
    }
  };

  const getSymbol = async (req: Request, res: Response) => {
    try {
      const accountId = queryParamAsString(req.query.account_id as string | string[] | undefined);
      if (!accountId) {
        throw new Error("account_id query param required");
      }
      const context = validateAutoSellContext(accountId, session, req);
      const symbolName = queryParamAsString(req.params.symbol as string | string[] | undefined);
      const symbol = await context.adapter.getSpotSymbol!(symbolName, context.creds);
      res.json({ ok: true, symbol });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: "BAD_REQUEST", message });
    }
  };

  const getBalance = async (req: Request, res: Response) => {
    try {
      const accountId = queryParamAsString(req.query.account_id as string | string[] | undefined);
      const asset = queryParamAsString(req.query.asset as string | string[] | undefined);
      if (!accountId || !asset) {
        throw new Error("account_id and asset query params required");
      }
      const context = validateAutoSellContext(accountId, session, req);
      const balance = await context.adapter.getBalance(asset, context.creds);
      res.json({ ok: true, balance });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: "BAD_REQUEST", message });
    }
  };

  router.get("/symbols", listSymbols);
  router.get("/symbol/:symbol", getSymbol);
  router.get("/balance", getBalance);
  router.get("/binance/symbols", listSymbols);
  router.get("/binance/symbol/:symbol", getSymbol);
  router.get("/binance/balance", getBalance);

  router.post("/sell/preview", async (req, res) => {
    try {
      const body = req.body as SellPreviewBody;
      body.interval_sec = parsePositiveInterval(body.interval_sec);
      const context = validateAutoSellContext(body.account_id, session, req);
      const preview = await previewSellQuantity(body, context);
      logSellPreview("api", body, preview);
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
      const context = validateAutoSellContext(payload.account_id, session, req);
      const preview = await previewSellQuantity(payload, context);
      logSellPreview("schedule-start", payload, preview);
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
