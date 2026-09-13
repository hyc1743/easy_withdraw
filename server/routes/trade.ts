import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { SessionManager } from "../security.js";
import { resolveAccountContext, previewSellQuantity } from "../tasks/executors.js";
import { ensureRuntimeHydrated, hydrateTask } from "../tasks/hydration.js";
import { taskRuntime } from "../tasks/runtime.js";
import type { SellMarketTaskPayload, TaskJob } from "../tasks/types.js";
import type { SpotTrade } from "../exchange/types.js";

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

const MAX_TRADE_HISTORY_RANGE_MS = 90 * 24 * 60 * 60 * 1000;

function decimal(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return value.toFixed(12).replace(/\.?0+$/, "") || "0";
}

export function summarizeSpotTrades(
  trades: SpotTrade[],
  baseAsset: string,
  quoteAsset: string,
) {
  let buyQuantity = 0;
  let buyQuote = 0;
  let sellQuantity = 0;
  let sellQuote = 0;
  let quoteEquivalentFees = 0;
  const fees = new Map<string, number>();

  for (const trade of trades) {
    const quantity = Number(trade.quantity);
    const quoteQuantity = Number(trade.quote_quantity);
    const price = Number(trade.price);
    if (trade.is_buyer) {
      buyQuantity += Number.isFinite(quantity) ? quantity : 0;
      buyQuote += Number.isFinite(quoteQuantity) ? quoteQuantity : 0;
    } else {
      sellQuantity += Number.isFinite(quantity) ? quantity : 0;
      sellQuote += Number.isFinite(quoteQuantity) ? quoteQuantity : 0;
    }

    const tradeFees = trade.commissions?.length
      ? trade.commissions
      : [{ asset: trade.commission_asset, amount: trade.commission }];
    for (const tradeFee of tradeFees) {
      const feeAsset = tradeFee.asset.toUpperCase();
      const commission = Math.abs(Number(tradeFee.amount));
      if (feeAsset && Number.isFinite(commission)) {
        fees.set(feeAsset, (fees.get(feeAsset) ?? 0) + commission);
        if (feeAsset === quoteAsset.toUpperCase()) quoteEquivalentFees += commission;
        if (feeAsset === baseAsset.toUpperCase() && Number.isFinite(price)) {
          quoteEquivalentFees += commission * price;
        }
      }
    }
  }

  const unconvertedFeeAssets = [...fees.keys()].filter(
    (asset) => asset !== baseAsset.toUpperCase() && asset !== quoteAsset.toUpperCase(),
  );
  const averageBuyPrice = buyQuantity > 0 ? buyQuote / buyQuantity : 0;
  const averageSellPrice = sellQuantity > 0 ? sellQuote / sellQuantity : 0;
  const matchedQuantity = Math.min(buyQuantity, sellQuantity);
  const profitLoss = matchedQuantity * (averageSellPrice - averageBuyPrice) - quoteEquivalentFees;
  const netCashFlow = sellQuote - buyQuote - quoteEquivalentFees;
  return {
    trade_count: trades.length,
    buy_count: trades.filter((trade) => trade.is_buyer).length,
    sell_count: trades.filter((trade) => !trade.is_buyer).length,
    total_buy_quantity: decimal(buyQuantity),
    total_buy: decimal(buyQuote),
    average_buy_price: decimal(averageBuyPrice),
    total_sell_quantity: decimal(sellQuantity),
    total_sell: decimal(sellQuote),
    average_sell_price: decimal(averageSellPrice),
    fees: [...fees.entries()].map(([asset, amount]) => ({ asset, amount: decimal(amount) })),
    quote_equivalent_fees: decimal(quoteEquivalentFees),
    unconverted_fee_assets: unconvertedFeeAssets,
    matched_quantity: decimal(matchedQuantity),
    profit_loss: decimal(profitLoss),
    profit_loss_method: "区间均价法：匹配数量 ×（卖出均价 - 买入均价）- 可折算手续费；不含区间开始前持仓成本",
    net_cash_flow: decimal(netCashFlow),
  };
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
      const balance = context.adapter.getSpotBalance
        ? await context.adapter.getSpotBalance(asset, context.creds)
        : await context.adapter.getBalance(asset, context.creds);
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

  router.get("/history", async (req, res) => {
    try {
      const accountId = queryParamAsString(req.query.account_id as string | string[] | undefined);
      const symbolName = queryParamAsString(req.query.symbol as string | string[] | undefined)
        .trim().toUpperCase();
      const startTime = Number(queryParamAsString(req.query.start_time as string | string[] | undefined));
      const endTime = Number(queryParamAsString(req.query.end_time as string | string[] | undefined));
      if (!accountId || !symbolName) throw new Error("account_id and symbol query params required");
      if (!Number.isSafeInteger(startTime) || !Number.isSafeInteger(endTime) || startTime > endTime) {
        throw new Error("start_time and end_time must be a valid millisecond range");
      }
      if (endTime - startTime > MAX_TRADE_HISTORY_RANGE_MS) {
        throw new Error("一次最多查询 90 天交易记录");
      }

      const context = resolveAccountContext(accountId, session, req);
      if (!context.adapter.getSpotTrades || !context.adapter.getSpotSymbol) {
        throw new Error("该交易所暂不支持交易记录分析");
      }
      const symbol = await context.adapter.getSpotSymbol(symbolName, context.creds);
      if (!symbol) throw new Error("交易对不存在");
      const trades = await context.adapter.getSpotTrades(symbol.symbol, startTime, endTime, context.creds);
      const summary = summarizeSpotTrades(trades, symbol.base_asset, symbol.quote_asset);
      res.json({
        ok: true,
        exchange: context.exchange,
        symbol,
        range: { start_time: startTime, end_time: endTime },
        summary,
        trades,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: "BAD_REQUEST", message });
    }
  });

  router.post("/sell/preview", async (req, res) => {
    try {
      const body = req.body as SellPreviewBody;
      body.interval_sec = parsePositiveInterval(body.interval_sec);
      const context = validateAutoSellContext(body.account_id, session, req);
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
      const context = validateAutoSellContext(payload.account_id, session, req);
      const preview = await previewSellQuantity(payload, context);
      if (!preview.can_execute) {
        throw new Error(preview.validation_message ?? "Current balance or lot size rules do not allow execution");
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
