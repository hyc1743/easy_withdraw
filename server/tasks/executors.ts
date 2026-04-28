import type { Request } from "express";
import { loadConfig } from "../config.js";
import { adapters } from "../exchange/adapters.js";
import { decrypt, type SessionManager } from "../security.js";
import type {
  DecryptedCreds,
  ExchangeAdapter,
  MarketSellOrderResult,
  SpotSymbolInfo,
  WithdrawRequest,
  WithdrawResponse,
} from "../exchange/types.js";
import type { TaskExecutionResult } from "./runtime.js";
import type { SellMarketTaskPayload, TaskJob } from "./types.js";

interface AccountContext {
  adapter: ExchangeAdapter;
  creds: DecryptedCreds;
  exchange: string;
}

interface WithdrawHistoryRecord {
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

interface SellPreviewResult {
  balance_available: string;
  symbol: SpotSymbolInfo;
  requested_qty: string;
  executable_qty: string;
  can_execute: boolean;
  final_round: boolean;
}

function isSpotSymbolSellable(symbol: SpotSymbolInfo): boolean {
  return symbol.status === "TRADING" || symbol.status === "SELLABLE";
}

function getSellNotional(quantity: string, symbol: SpotSymbolInfo): number {
  const lastPrice = Number(symbol.last_price ?? "0");
  const executedQty = Number(quantity);
  if (!Number.isFinite(lastPrice) || lastPrice <= 0 || !Number.isFinite(executedQty)) {
    return 0;
  }
  return lastPrice * executedQty;
}

function validateSellPreview(preview: {
  symbol: SpotSymbolInfo;
  executable_qty: string;
  balance_available: string;
}): { ok: boolean; message?: string } {
  if (!isSpotSymbolSellable(preview.symbol)) {
    return { ok: false, message: `交易对不可交易: ${preview.symbol.status}` };
  }

  if (
    Number(preview.executable_qty) <= 0 ||
    Number(preview.executable_qty) < Number(preview.symbol.min_qty)
  ) {
    return { ok: false, message: "可执行数量低于最小下单量" };
  }

  if (preview.symbol.min_quote_amount) {
    const minQuoteAmount = Number(preview.symbol.min_quote_amount);
    const orderNotional = getSellNotional(preview.executable_qty, preview.symbol);
    if (
      Number.isFinite(minQuoteAmount) &&
      minQuoteAmount > 0 &&
      Number.isFinite(orderNotional) &&
      orderNotional > 0 &&
      orderNotional < minQuoteAmount
    ) {
      return {
        ok: false,
        message: `按当前价格估算成交额约 ${orderNotional.toFixed(8).replace(/\.?0+$/, "")} ${preview.symbol.quote_asset}，低于最小 ${preview.symbol.min_quote_amount} ${preview.symbol.quote_asset}`,
      };
    }
  }

  if (Number(preview.balance_available) <= 0) {
    return { ok: false, message: "余额为 0" };
  }

  return { ok: true };
}

function formatSellPreviewDebug(preview: {
  symbol: SpotSymbolInfo;
  requested_qty: string;
  executable_qty: string;
  balance_available: string;
}): string {
  const orderNotional = getSellNotional(preview.executable_qty, preview.symbol);
  return [
    `symbol=${preview.symbol.symbol}`,
    `status=${preview.symbol.status}`,
    `balance=${preview.balance_available}`,
    `requested_qty=${preview.requested_qty}`,
    `executable_qty=${preview.executable_qty}`,
    `min_qty=${preview.symbol.min_qty}`,
    `step_size=${preview.symbol.step_size}`,
    `last_price=${preview.symbol.last_price ?? "0"}`,
    `notional=${orderNotional}`,
    `min_quote_amount=${preview.symbol.min_quote_amount ?? "0"}`,
  ].join(" ");
}

function countDecimals(value: string): number {
  if (!value.includes(".")) return 0;
  return value.split(".")[1].replace(/0+$/, "").length;
}

function roundDownToStep(value: string, step: string): string {
  const decimals = Math.max(countDecimals(value), countDecimals(step));
  const scale = 10 ** decimals;
  const valueInt = Math.floor(Number(value) * scale);
  const stepInt = Math.max(1, Math.floor(Number(step) * scale));
  const roundedInt = Math.floor(valueInt / stepInt) * stepInt;
  const formatted = (roundedInt / scale).toFixed(decimals);
  if (!formatted.includes(".")) {
    return formatted;
  }
  return formatted.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

export function resolveAccountContext(
  accountId: string,
  session: SessionManager,
  req: Request,
): AccountContext {
  const config = loadConfig();
  const acct = config.accounts.find((account) => account.id === accountId);
  if (!acct) throw new Error("Account not found");

  const adapter = adapters[acct.exchange];
  if (!adapter) throw new Error(`Unsupported exchange: ${acct.exchange}`);

  const key = session.getKey(req);
  if (!key) throw new Error("Session not unlocked");

  return {
    adapter,
    exchange: acct.exchange,
    creds: {
      api_key: acct.api_key,
      api_secret: acct.api_secret_enc ? decrypt(acct.api_secret_enc, key) : "",
      passphrase: acct.passphrase_enc ? decrypt(acct.passphrase_enc, key) : undefined,
    },
  };
}

export async function executeWithdrawRequest(
  request: WithdrawRequest,
  context: AccountContext,
  idempotencyKey?: string,
): Promise<WithdrawResponse> {
  const shouldInjectClientWithdrawId = context.exchange !== "mexc";
  const effectiveRequest: WithdrawRequest = {
    ...request,
    client_withdraw_id: request.client_withdraw_id ?? (
      shouldInjectClientWithdrawId ? idempotencyKey : undefined
    ),
  };
  await context.adapter.validateRequest(effectiveRequest);
  return context.adapter.withdraw(effectiveRequest, context.creds);
}

export function createWithdrawTaskExecutor(
  baseJob: TaskJob,
  context: AccountContext,
  appendHistory: (record: WithdrawHistoryRecord) => void,
): (job: TaskJob) => Promise<TaskExecutionResult> {
  const request = baseJob.payload as WithdrawRequest;

  return async (job: TaskJob): Promise<TaskExecutionResult> => {
    const round = job.done_count + 1;
    const idempotencyKey = `${job.id}-round-${round}`;

    try {
      const result = await executeWithdrawRequest(request, context, idempotencyKey);
      appendHistory({
        timestamp: new Date().toISOString(),
        account_id: request.account_id,
        exchange: context.exchange,
        asset: request.asset,
        network: request.network,
        address: request.address,
        amount: request.amount,
        withdraw_id: result.withdraw_id,
        status: result.status,
      });

      const nextDoneCount = job.done_count + 1;
      const completed = nextDoneCount >= job.total_count;
      return {
        job: {
          ...job,
          done_count: nextDoneCount,
        },
        log: {
          ok: true,
          message: `第${nextDoneCount}/${job.total_count}次成功 - ID: ${result.withdraw_id}`,
        },
        complete: completed,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const nextDoneCount = job.done_count + 1;
      const completed = nextDoneCount >= job.total_count;
      return {
        job: {
          ...job,
          done_count: nextDoneCount,
        },
        log: {
          ok: false,
          message: `第${nextDoneCount}/${job.total_count}次失败: ${message}`,
        },
        complete: completed,
      };
    }
  };
}

export async function previewSellQuantity(
  payload: SellMarketTaskPayload,
  context: AccountContext,
): Promise<SellPreviewResult> {
  if (!context.adapter.getSpotSymbol || !context.adapter.placeMarketSellOrder) {
    throw new Error("Exchange does not support spot auto sell");
  }

  const symbol = await context.adapter.getSpotSymbol(payload.symbol, context.creds);
  if (!symbol) throw new Error("Trading pair not found");
  if (symbol.base_asset !== payload.base_asset || symbol.quote_asset !== payload.quote_asset) {
    throw new Error("Trading pair does not match selected base/quote assets");
  }

  const balance = context.adapter.getSpotBalance
    ? await context.adapter.getSpotBalance(payload.base_asset, context.creds)
    : await context.adapter.getBalance(payload.base_asset, context.creds);
  const requestedQty =
    Number(balance.available) >= Number(payload.step_amount)
      ? payload.step_amount
      : balance.available;
  const executableQty = roundDownToStep(requestedQty, symbol.step_size);

  return {
    balance_available: balance.available,
    symbol,
    requested_qty: requestedQty,
    executable_qty: executableQty,
    can_execute: validateSellPreview({
      symbol,
      executable_qty: executableQty,
      balance_available: balance.available,
    }).ok,
    final_round: Number(balance.available) > 0 && Number(balance.available) < Number(payload.step_amount),
  };
}

export function createSellMarketTaskExecutor(
  context: AccountContext,
): (job: TaskJob) => Promise<TaskExecutionResult> {
  return async (job: TaskJob): Promise<TaskExecutionResult> => {
    const payload = job.payload as SellMarketTaskPayload;
    try {
      const preview = await previewSellQuantity(payload, context);

      if (Number(preview.balance_available) <= 0) {
        return {
          job,
          log: { ok: true, message: "余额为 0，任务完成" },
          complete: true,
        };
      }
      const previewValidation = validateSellPreview(preview);
      if (!previewValidation.ok) {
        return {
          job,
          log: {
            ok: false,
            message: `${previewValidation.message ?? "当前卖出条件不满足"} ｜ ${formatSellPreviewDebug(preview)}`,
          },
          stop: true,
        };
      }

      const result = await context.adapter.placeMarketSellOrder!(
        payload.symbol,
        preview.executable_qty,
        context.creds,
      ) as MarketSellOrderResult;

      const doneCount = job.done_count + 1;
      const soldTotal =
        Number((job.progress as { sold_total?: string }).sold_total ?? "0") +
        Number(result.executed_qty);

      return {
        job: {
          ...job,
          done_count: doneCount,
          progress: {
            ...(job.progress ?? {}),
            done_count: doneCount,
            sold_total: soldTotal.toString(),
            last_order_id: result.order_id,
            last_executed_qty: result.executed_qty,
            last_quote_qty: result.quote_qty,
            last_price: result.avg_price,
            final_round: preview.final_round,
          },
        },
        log: {
          ok: true,
          message: `第${doneCount}次卖出成功 - ${payload.symbol} ${result.executed_qty}`,
        },
        complete: preview.final_round,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        job,
        log: { ok: false, message: `卖出失败: ${message}` },
        stop: true,
      };
    }
  };
}

export function createTaskExecutor(
  job: TaskJob,
  session: SessionManager,
  req: Request,
  appendHistory: (record: WithdrawHistoryRecord) => void,
): (job: TaskJob) => Promise<TaskExecutionResult> {
  if (job.job_type === "withdraw") {
    const payload = job.payload as WithdrawRequest;
    const context = resolveAccountContext(payload.account_id, session, req);
    return createWithdrawTaskExecutor(job, context, appendHistory);
  }

  const payload = job.payload as SellMarketTaskPayload;
  const context = resolveAccountContext(payload.account_id, session, req);
  return createSellMarketTaskExecutor(context);
}
