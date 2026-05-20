import type { Request } from "express";
import { ethers } from "ethers";
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
import {
  appendCrosschainTaskHistory,
  getWalletTokenBalance,
  pollCrosschainDelivery,
  sendCrosschainOft,
} from "../onchain/oft.js";
import {
  calculateDepositTransferAmount,
  getTransferAssetBalance,
  sendDepositTransfer,
} from "../onchain/deposit-transfer.js";
import { appendDepositTransferHistory } from "../onchain/deposit-history.js";
import { resolveOnchainWallet } from "../onchain/wallets.js";
import type { TaskExecutionResult } from "./runtime.js";
import type {
  ArbitrageTaskPayload,
  ArbitrageTaskProgress,
  CrosschainOftTaskPayload,
  CrosschainOftTaskProgress,
  DexToCexArbitrageTaskPayload,
  DexToCexArbitrageTaskProgress,
  SellMarketTaskPayload,
  TaskJob,
} from "./types.js";

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

export function createCrosschainOftTaskExecutor(
  session: SessionManager,
  req: Request,
): (job: TaskJob) => Promise<TaskExecutionResult> {
  return async (job: TaskJob): Promise<TaskExecutionResult> => {
    const payload = job.payload as CrosschainOftTaskPayload;
    const progress = job.progress as CrosschainOftTaskProgress;
    const mode = payload.mode ?? "api";

    try {
      if (progress.phase === "waiting_delivery" && (progress.quote_id || progress.source_tx_hash)) {
        const delivery = await pollCrosschainDelivery(
          progress.quote_id ?? progress.source_tx_hash ?? "",
          session,
          req,
          mode,
        );
        const nextProgress: CrosschainOftTaskProgress = {
          ...progress,
          destination_tx_hash: delivery.destinationTxHash ?? progress.destination_tx_hash,
          guid: delivery.guid ?? progress.guid,
          lz_status: delivery.lzStatus,
        };

        if (delivery.failed) {
          appendCrosschainTaskHistory({
            payload,
            progress: nextProgress,
            status: "failed",
            message: delivery.message,
          });
          return {
            job: { ...job, progress: nextProgress },
            log: { ok: false, message: `跨链失败: ${delivery.message}` },
            stop: true,
          };
        }

        if (!delivery.delivered) {
          return {
            job: { ...job, progress: nextProgress },
            log: { ok: true, message: `等待 LayerZero 送达: ${delivery.lzStatus}` },
            next_delay_sec: 10,
          };
        }

        // Sweep mode: never complete, always go back to ready_to_send
        if (payload.dynamic_amount) {
          const doneCount = job.done_count + 1;
          const deliveredProgress: CrosschainOftTaskProgress = {
            ...nextProgress,
            phase: "ready_to_send",
            source_tx_hash: undefined,
            approval_tx_hash: undefined,
            delivered_count: doneCount,
          };
          appendCrosschainTaskHistory({
            payload,
            progress: nextProgress,
            status: "delivered",
            message: delivery.message,
          });
          return {
            job: {
              ...job,
              done_count: doneCount,
              progress: deliveredProgress,
            },
            log: {
              ok: true,
              message: `第${doneCount}次跨链送达 - ${delivery.destinationTxHash ?? "目标交易确认"}`,
            },
            next_delay_sec: job.interval_sec,
          };
        }

        const doneCount = job.done_count + 1;
        const completed = doneCount >= job.total_count;
        const deliveredProgress: CrosschainOftTaskProgress = {
          ...nextProgress,
          phase: completed ? "delivered" : "ready_to_send",
          source_tx_hash: completed ? nextProgress.source_tx_hash : undefined,
          approval_tx_hash: completed ? nextProgress.approval_tx_hash : undefined,
          delivered_count: doneCount,
        };
        appendCrosschainTaskHistory({
          payload,
          progress: nextProgress,
          status: "delivered",
          message: delivery.message,
        });
        return {
          job: {
            ...job,
            done_count: doneCount,
            progress: deliveredProgress,
          },
          log: {
            ok: true,
            message: `第${doneCount}/${job.total_count}次跨链送达`,
          },
          complete: completed,
          next_delay_sec: completed ? undefined : job.interval_sec,
        };
      }

      // Sweep mode: read live balance instead of fixed amount
      if (payload.dynamic_amount && payload.token_address) {
        const balance = await getWalletTokenBalance(
          payload.wallet_id, payload.src_chain, payload.token_address,
          session, req,
        );
        // Subtract reserve amount before deciding to send
        if (payload.reserve_amount) {
          const reserveRaw = ethers.parseUnits(payload.reserve_amount, balance.decimals);
          if (reserveRaw >= balance.raw) {
            return {
              job: { ...job, progress: { ...progress, dynamic_balance: balance.formatted } },
              log: { ok: true, message: `余额 ${balance.formatted} 低于预留量 ${payload.reserve_amount}，跳过` },
              next_delay_sec: job.interval_sec,
            };
          }
          const sendRaw = balance.raw - reserveRaw;
          balance.raw = sendRaw;
          balance.formatted = ethers.formatUnits(sendRaw, balance.decimals);
        }
        if (balance.raw <= 0n) {
          return {
            job: { ...job, progress: { ...progress, dynamic_balance: balance.formatted } },
            log: { ok: true, message: "余额为 0，等待新的到账" },
            next_delay_sec: job.interval_sec,
          };
        }
        // Override amount with live balance
        const sweepPayload = { ...payload, amount: balance.formatted, dynamic_amount: false };
        const result = await sendCrosschainOft(sweepPayload, session, req, mode);
        const nextProgress: CrosschainOftTaskProgress = {
          phase: "waiting_delivery",
          source_tx_hash: result.sourceTxHash,
          approval_tx_hash: result.approvalTxHash,
          guid: result.guid,
          quote_id: result.quoteId,
          lz_status: "SUBMITTED",
          delivered_count: job.done_count,
          dynamic_balance: balance.formatted,
        };
        return {
          job: { ...job, progress: nextProgress },
          log: {
            ok: true,
            message: `源链交易已提交 - ${result.sourceTxHash} (余额: ${balance.formatted})`,
          },
          next_delay_sec: 10,
        };
      }

      const result = await sendCrosschainOft(payload, session, req, mode);
      const nextProgress: CrosschainOftTaskProgress = {
        phase: "waiting_delivery",
        source_tx_hash: result.sourceTxHash,
        approval_tx_hash: result.approvalTxHash,
        guid: result.guid,
        quote_id: result.quoteId,
        lz_status: "SUBMITTED",
        delivered_count: job.done_count,
      };

      return {
        job: { ...job, progress: nextProgress },
        log: {
          ok: true,
          message: `源链交易已提交 - ${result.sourceTxHash}`,
        },
        next_delay_sec: 10,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      appendCrosschainTaskHistory({
        payload,
        progress,
        status: "failed",
        message,
      });
      return {
        job,
        log: { ok: false, message: `跨链失败: ${message}` },
        stop: true,
      };
    }
  };
}

export function createArbitrageTaskExecutor(
  session: SessionManager,
  req: Request,
  appendHistory: (record: WithdrawHistoryRecord) => void,
): (job: TaskJob) => Promise<TaskExecutionResult> {
  return async (job: TaskJob): Promise<TaskExecutionResult> => {
    const payload = job.payload as ArbitrageTaskPayload;
    const progress = job.progress as ArbitrageTaskProgress;
    const phase = progress.phase ?? "check_balance";

    try {
      switch (phase) {
        case "check_balance": {
          const context = resolveAccountContext(payload.account_id, session, req);
          const balance = await context.adapter.getBalance(payload.asset, context.creds);
          const balanceAvail = Number(balance.available);
          const threshold = Number(payload.threshold_amount);

          if (balanceAvail > threshold) {
            const withdrawReq: WithdrawRequest = {
              account_id: payload.account_id,
              asset: payload.asset,
              network: payload.network,
              address: payload.address,
              address_tag: payload.address_tag ?? null,
              amount: balance.available,
            };
            const idKey = `arb-${job.id}-w${progress.withdraw_count + 1}`;
            const result = await executeWithdrawRequest(withdrawReq, context, idKey);
            appendHistory({
              timestamp: new Date().toISOString(),
              account_id: payload.account_id,
              exchange: context.exchange,
              asset: payload.asset,
              network: payload.network,
              address: payload.address,
              amount: balance.available,
              withdraw_id: result.withdraw_id,
              status: result.status,
            });
            return {
              job: {
                ...job,
                progress: {
                  ...progress,
                  phase: "wait_withdrawal",
                  withdraw_count: progress.withdraw_count + 1,
                  last_balance: balance.available,
                  last_withdraw_id: result.withdraw_id,
                  waiting_since: new Date().toISOString(),
                },
              },
              log: { ok: true, message: `余额 ${balance.available} > 阈值 ${threshold}，提现 ${balance.available} ${payload.asset} — ID: ${result.withdraw_id}` },
              next_delay_sec: 5,
            };
          }
          return {
            job: { ...job, progress: { ...progress, last_balance: balance.available } },
            log: { ok: true, message: `余额 ${balance.available}，未达阈值 ${threshold}，等待中` },
            next_delay_sec: payload.interval_sec,
          };
        }

        case "wait_withdrawal": {
          const context = resolveAccountContext(payload.account_id, session, req);
          const status = await context.adapter.queryStatus(progress.last_withdraw_id!, context.creds);
          const statusOk = status.status.toLowerCase() === "success" || status.ok;
          const statusFailed = ["fail", "failed", "rejected", "cancelled"].includes(status.status.toLowerCase());

          if (statusOk) {
            if (payload.crosschain) {
              return {
                job: { ...job, progress: { ...progress, phase: "do_crosschain", waiting_since: undefined } },
                log: { ok: true, message: "提现已确认，开始跨链" },
                next_delay_sec: 1,
              };
            }
            return {
              job: { ...job, progress: { ...progress, phase: "check_balance", waiting_since: undefined } },
              log: { ok: true, message: "提现已确认" },
              next_delay_sec: 1,
            };
          }
          if (statusFailed) {
            return {
              job: { ...job, progress: { ...progress, phase: "check_balance", waiting_since: undefined } },
              log: { ok: false, message: `提现失败: ${status.message}` },
              next_delay_sec: payload.interval_sec,
            };
          }
          // Timeout guard: 30 minutes
          const waitingSince = progress.waiting_since ? new Date(progress.waiting_since).getTime() : 0;
          if (waitingSince > 0 && Date.now() - waitingSince > 30 * 60 * 1000) {
            return {
              job: { ...job, progress: { ...progress, phase: "check_balance", waiting_since: undefined } },
              log: { ok: true, message: "提现等待超时，强制继续轮询" },
              next_delay_sec: payload.interval_sec,
            };
          }
          return {
            job,
            log: { ok: true, message: `提现进行中: ${status.status}` },
            next_delay_sec: 5,
          };
        }

        case "do_crosschain": {
          const cc = payload.crosschain!;
          const balance = await getWalletTokenBalance(
            cc.wallet_id, cc.src_chain, cc.token_address,
            session, req,
          );
          let sendBalance = balance;
          if (cc.reserve_amount) {
            const reserveRaw = ethers.parseUnits(cc.reserve_amount, balance.decimals);
            if (reserveRaw >= balance.raw) {
              return {
                job: { ...job, progress: { ...progress, phase: "check_balance" } },
                log: { ok: true, message: `链上余额 ${balance.formatted} 低于预留量 ${cc.reserve_amount}，跳过跨链` },
                next_delay_sec: payload.interval_sec,
              };
            }
            const sendRaw = balance.raw - reserveRaw;
            sendBalance = { raw: sendRaw, formatted: ethers.formatUnits(sendRaw, balance.decimals), decimals: balance.decimals };
          }
          if (sendBalance.raw <= 0n) {
            return {
              job: { ...job, progress: { ...progress, phase: "check_balance" } },
              log: { ok: true, message: "链上余额为 0，跳过跨链" },
              next_delay_sec: payload.interval_sec,
            };
          }
          const ccPayload: CrosschainOftTaskPayload = {
            wallet_id: cc.wallet_id,
            symbol: cc.symbol || payload.asset,
            src_chain: cc.src_chain,
            dst_chain: cc.dst_chain,
            token_address: cc.token_address,
            dst_token_address: cc.dst_token_address ?? "",
            amount: sendBalance.formatted,
            recipient: cc.recipient,
            slippage_bps: cc.slippage_bps,
            mode: cc.mode ?? "api",
          };
          const result = await sendCrosschainOft(ccPayload, session, req, cc.mode);
          return {
            job: {
              ...job,
              progress: { ...progress, phase: "wait_delivery", source_tx_hash: result.sourceTxHash, guid: result.guid },
            },
            log: { ok: true, message: `跨链交易已提交 - ${result.sourceTxHash} (余额: ${sendBalance.formatted})` },
            next_delay_sec: 10,
          };
        }

        case "wait_delivery": {
          const cc = payload.crosschain!;
          const delivery = await pollCrosschainDelivery(
            progress.source_tx_hash ?? "",
            session, req, cc.mode,
          );
          if (delivery.delivered) {
            const ccHistProgress: CrosschainOftTaskProgress = {
              source_tx_hash: progress.source_tx_hash,
              guid: progress.guid,
              lz_status: delivery.lzStatus,
              destination_tx_hash: progress.destination_tx_hash,
              delivered_count: progress.delivered_count,
            };
            appendCrosschainTaskHistory({
              payload: {
                wallet_id: cc.wallet_id,
                symbol: cc.symbol || payload.asset,
                src_chain: cc.src_chain,
                dst_chain: cc.dst_chain ?? "",
                token_address: cc.token_address,
                amount: "",
                recipient: cc.recipient,
                slippage_bps: cc.slippage_bps,
              },
              sourceTxHash: progress.source_tx_hash,
              progress: ccHistProgress,
              status: "delivered",
              message: delivery.message,
            });
            return {
              job: {
                ...job,
                progress: {
                  ...progress,
                  phase: "check_balance",
                  delivered_count: (progress.delivered_count ?? 0) + 1,
                  destination_tx_hash: delivery.destinationTxHash,
                  lz_status: delivery.lzStatus,
                  source_tx_hash: undefined,
                  guid: undefined,
                },
              },
              log: { ok: true, message: `跨链送达 - ${delivery.destinationTxHash ?? "确认"}` },
              next_delay_sec: payload.interval_sec,
            };
          }
          if (delivery.failed) {
            const ccHistFail: CrosschainOftTaskProgress = {
              source_tx_hash: progress.source_tx_hash,
              guid: progress.guid,
              lz_status: delivery.lzStatus,
              destination_tx_hash: progress.destination_tx_hash,
              delivered_count: progress.delivered_count,
            };
            appendCrosschainTaskHistory({
              payload: {
                wallet_id: cc.wallet_id,
                symbol: cc.symbol || payload.asset,
                src_chain: cc.src_chain,
                dst_chain: cc.dst_chain ?? "",
                token_address: cc.token_address,
                amount: "",
                recipient: cc.recipient,
                slippage_bps: cc.slippage_bps,
              },
              sourceTxHash: progress.source_tx_hash,
              progress: ccHistFail,
              status: "failed",
              message: delivery.message,
            });
            return {
              job: { ...job, progress: { ...progress, phase: "check_balance", source_tx_hash: undefined, lz_status: delivery.lzStatus } },
              log: { ok: false, message: `跨链失败: ${delivery.message}` },
              next_delay_sec: payload.interval_sec,
            };
          }
          return {
            job: { ...job, progress: { ...progress, lz_status: delivery.lzStatus } },
            log: { ok: true, message: `等待跨链送达: ${delivery.lzStatus}` },
            next_delay_sec: 10,
          };
        }

        default:
          return {
            job: { ...job, progress: { ...progress, phase: "check_balance" } },
            next_delay_sec: payload.interval_sec,
          };
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      appendCrosschainTaskHistory({
        payload: { wallet_id: "", symbol: payload.asset, src_chain: "", dst_chain: "", token_address: "", amount: "", recipient: "", slippage_bps: 50 },
        status: "failed",
        message,
      });
      return {
        job: { ...job, progress: { ...progress, phase: "check_balance" } as ArbitrageTaskProgress },
        log: { ok: false, message: `搬砖任务错误: ${message}` },
        next_delay_sec: payload.interval_sec,
      };
    }
  };
}

export function createDexToCexArbitrageTaskExecutor(
  session: SessionManager,
  req: Request,
): (job: TaskJob) => Promise<TaskExecutionResult> {
  return async (job: TaskJob): Promise<TaskExecutionResult> => {
    const payload = job.payload as DexToCexArbitrageTaskPayload;
    const progress = job.progress as DexToCexArbitrageTaskProgress;
    const phase = progress.phase ?? "check_source_balance";

    try {
      switch (phase) {
        case "check_source_balance": {
          const balance = await getWalletTokenBalance(
            payload.wallet_id,
            payload.src_chain,
            payload.token_address,
            session,
            req,
          );
          const threshold = Number(payload.threshold_amount);
          const balanceAvail = Number(balance.formatted);

          if (balanceAvail <= threshold) {
            return {
              job: {
                ...job,
                progress: { ...progress, last_source_balance: balance.formatted },
              },
              log: { ok: true, message: `源链余额 ${balance.formatted}，未达阈值 ${threshold}，等待中` },
              next_delay_sec: payload.interval_sec,
            };
          }

          let sendBalance = balance;
          if (payload.reserve_amount) {
            const reserveRaw = ethers.parseUnits(payload.reserve_amount, balance.decimals);
            if (reserveRaw >= balance.raw) {
              return {
                job: {
                  ...job,
                  progress: { ...progress, last_source_balance: balance.formatted },
                },
                log: { ok: true, message: `源链余额 ${balance.formatted} 低于预留量 ${payload.reserve_amount}，等待中` },
                next_delay_sec: payload.interval_sec,
              };
            }
            const sendRaw = balance.raw - reserveRaw;
            sendBalance = {
              raw: sendRaw,
              formatted: ethers.formatUnits(sendRaw, balance.decimals),
              decimals: balance.decimals,
            };
          }

          if (sendBalance.raw <= 0n) {
            return {
              job: { ...job, progress: { ...progress, last_source_balance: balance.formatted } },
              log: { ok: true, message: "源链可操作余额为 0，等待中" },
              next_delay_sec: payload.interval_sec,
            };
          }

          const hasCrosschain = !!payload.crosschain
            || (!!payload.dst_chain && payload.dst_chain !== payload.src_chain);

          if (hasCrosschain) {
            const dstBefore = await getTransferAssetBalance(
              payload.wallet_id,
              payload.crosschain?.dst_chain ?? payload.dst_chain!,
              payload.crosschain?.dst_token_address ?? payload.dst_token_address!,
              session,
              req,
            );

            return {
              job: {
                ...job,
                progress: {
                  ...progress,
                  phase: "do_crosschain",
                  crosschain_done: true,
                  last_source_balance: balance.formatted,
                  crosschain_amount: sendBalance.formatted,
                  dst_balance_before_raw: dstBefore.raw.toString(),
                },
              },
              log: { ok: true, message: `源链余额 ${balance.formatted} > 阈值 ${threshold}，准备跨链 ${sendBalance.formatted} ${payload.symbol}` },
              next_delay_sec: 1,
            };
          }

          // Direct deposit: no crosschain, go straight to deposit
          return {
            job: {
              ...job,
              progress: {
                ...progress,
                phase: "do_deposit_transfer",
                last_source_balance: balance.formatted,
              },
            },
            log: { ok: true, message: `源链余额 ${balance.formatted} > 阈值 ${threshold}，直接充值到 CEX ${sendBalance.formatted} ${payload.symbol}` },
            next_delay_sec: 1,
          };
        }

        case "do_crosschain": {
          const cc = payload.crosschain ?? payload;
          const ccDstChain = cc.dst_chain ?? payload.dst_chain!;
          const ccDstToken = cc.dst_token_address ?? payload.dst_token_address ?? "";
          const ccMode: "api" | "direct" = cc.mode === "direct" ? "direct" : "api";
          const ccSlippage = cc.slippage_bps ?? payload.slippage_bps ?? 50;
          const wallet = resolveOnchainWallet(payload.wallet_id, session, req);
          const ccPayload: CrosschainOftTaskPayload = {
            wallet_id: payload.wallet_id,
            symbol: payload.symbol,
            src_chain: payload.src_chain,
            dst_chain: ccDstChain,
            token_address: payload.token_address,
            dst_token_address: ccDstToken,
            amount: progress.crosschain_amount ?? "0",
            recipient: wallet.address,
            slippage_bps: ccSlippage,
            mode: ccMode === "direct" ? "direct" : undefined,
          };
          const result = await sendCrosschainOft(ccPayload, session, req, ccMode);
          return {
            job: {
              ...job,
              progress: {
                ...progress,
                phase: "wait_delivery",
                source_tx_hash: result.sourceTxHash,
                status_lookup: result.quoteId ?? result.sourceTxHash,
                guid: result.guid,
              },
            },
            log: { ok: true, message: `跨链交易已提交 - ${result.sourceTxHash}` },
            next_delay_sec: 10,
          };
        }

        case "wait_delivery": {
          const cc = payload.crosschain ?? payload;
          const ccMode: "api" | "direct" = cc.mode === "direct" ? "direct" : "api";
          const delivery = await pollCrosschainDelivery(
            progress.status_lookup ?? progress.source_tx_hash ?? "",
            session,
            req,
            ccMode,
          );
          if (delivery.delivered) {
            appendCrosschainTaskHistory({
              payload: {
                wallet_id: payload.wallet_id,
                symbol: payload.symbol,
                src_chain: payload.src_chain,
                dst_chain: cc.dst_chain ?? "",
                token_address: payload.token_address,
                dst_token_address: cc.dst_token_address ?? "",
                amount: progress.crosschain_amount ?? "",
                recipient: resolveOnchainWallet(payload.wallet_id, session, req).address,
                slippage_bps: cc.slippage_bps ?? payload.slippage_bps ?? 50,
                mode: ccMode === "direct" ? "direct" : undefined,
              },
              sourceTxHash: progress.source_tx_hash,
              progress: {
                source_tx_hash: progress.source_tx_hash,
                destination_tx_hash: delivery.destinationTxHash,
                guid: delivery.guid ?? progress.guid,
                lz_status: delivery.lzStatus,
              },
              status: "delivered",
              message: delivery.message,
            });
            return {
              job: {
                ...job,
                progress: {
                  ...progress,
                  phase: "do_deposit_transfer",
                  destination_tx_hash: delivery.destinationTxHash,
                  guid: delivery.guid ?? progress.guid,
                  lz_status: delivery.lzStatus,
                },
              },
              log: { ok: true, message: `跨链送达，准备充值转账 - ${delivery.destinationTxHash ?? "确认"}` },
              next_delay_sec: 1,
            };
          }
          if (delivery.failed) {
            return {
              job: {
                ...job,
                progress: {
                  ...progress,
                  phase: "check_source_balance",
                  source_tx_hash: undefined,
                  status_lookup: undefined,
                  lz_status: delivery.lzStatus,
                },
              },
              log: { ok: false, message: `跨链失败: ${delivery.message}` },
              next_delay_sec: payload.interval_sec,
            };
          }
          return {
            job: { ...job, progress: { ...progress, lz_status: delivery.lzStatus } },
            log: { ok: true, message: `等待跨链送达: ${delivery.lzStatus}` },
            next_delay_sec: 10,
          };
        }

        case "do_deposit_transfer": {
          if (progress.crosschain_done) {
            // Crosschain was done: calculate deposit amount from dst balance diff
            const cc = payload.crosschain ?? payload;
            const depositChain = cc.dst_chain ?? payload.dst_chain!;
            const depositToken = cc.dst_token_address ?? "";
            const current = await getTransferAssetBalance(
              payload.wallet_id,
              depositChain,
              depositToken,
              session,
              req,
            );
            const amount = calculateDepositTransferAmount({
              beforeRaw: BigInt(progress.dst_balance_before_raw ?? "0"),
              currentRaw: current.raw,
              decimals: current.decimals,
            });

            if (amount.raw <= 0n) {
              return {
                job: {
                  ...job,
                  progress: {
                    ...progress,
                    phase: "check_source_balance",
                    source_tx_hash: undefined,
                    status_lookup: undefined,
                  },
                },
                log: { ok: false, message: "目标链余额未增加，跳过充值转账" },
                next_delay_sec: payload.interval_sec,
              };
            }

            const result = await sendDepositTransfer({
              walletId: payload.wallet_id,
              chainName: depositChain,
              tokenAddress: depositToken,
              depositAddress: payload.deposit_address,
              amountRaw: amount.raw,
              decimals: amount.decimals,
              session,
              req,
            });
            appendDepositTransferHistory({
              timestamp: new Date().toISOString(),
              wallet_id: payload.wallet_id,
              symbol: payload.symbol,
              chain: depositChain,
              token_address: depositToken,
              deposit_address: payload.deposit_address,
              amount: result.amount,
              tx_hash: result.tx_hash,
              status: result.status,
              message: "跨链后充值到 CEX 已确认",
            });

            return {
              job: {
                ...job,
                progress: {
                  ...progress,
                  phase: "check_source_balance",
                  completed_count: (progress.completed_count ?? 0) + 1,
                  deposit_amount: result.amount,
                  deposit_tx_hash: result.tx_hash,
                  source_tx_hash: undefined,
                  status_lookup: undefined,
                },
                done_count: job.done_count + 1,
              },
              log: { ok: true, message: `跨链后充值转账已确认 - ${result.tx_hash} (${result.amount} ${payload.symbol})` },
              next_delay_sec: payload.interval_sec,
            };
          }

          // No crosschain: deposit directly from src chain wallet to CEX
          const current = await getTransferAssetBalance(
            payload.wallet_id,
            payload.src_chain,
            payload.token_address,
            session,
            req,
          );
          let sendRaw = current.raw;
          if (payload.reserve_amount) {
            const reserveRaw = ethers.parseUnits(payload.reserve_amount, current.decimals);
            if (reserveRaw >= current.raw) {
              return {
                job: {
                  ...job,
                  progress: {
                    ...progress,
                    phase: "check_source_balance",
                  },
                },
                log: { ok: true, message: `源链余额 ${current.formatted} 低于预留量 ${payload.reserve_amount}，跳过充值` },
                next_delay_sec: payload.interval_sec,
              };
            }
            sendRaw = current.raw - reserveRaw;
          }
          if (sendRaw <= 0n) {
            return {
              job: {
                ...job,
                progress: { ...progress, phase: "check_source_balance" },
              },
              log: { ok: true, message: `源链余额为 0，跳过充值` },
              next_delay_sec: payload.interval_sec,
            };
          }

          const result = await sendDepositTransfer({
            walletId: payload.wallet_id,
            chainName: payload.src_chain,
            tokenAddress: payload.token_address,
            depositAddress: payload.deposit_address,
            amountRaw: sendRaw,
            decimals: current.decimals,
            session,
            req,
          });
          appendDepositTransferHistory({
            timestamp: new Date().toISOString(),
            wallet_id: payload.wallet_id,
            symbol: payload.symbol,
            chain: payload.src_chain,
            token_address: payload.token_address,
            deposit_address: payload.deposit_address,
            amount: result.amount,
            tx_hash: result.tx_hash,
            status: result.status,
            message: "直接充值到 CEX 已确认",
          });

          return {
            job: {
              ...job,
              progress: {
                ...progress,
                phase: "check_source_balance",
                completed_count: (progress.completed_count ?? 0) + 1,
                deposit_amount: result.amount,
                deposit_tx_hash: result.tx_hash,
              },
              done_count: job.done_count + 1,
            },
            log: { ok: true, message: `直接充值已确认 - ${result.tx_hash} (${result.amount} ${payload.symbol})` },
            next_delay_sec: payload.interval_sec,
          };
        }

        case "wait_deposit_confirmed":
        default:
          return {
            job: { ...job, progress: { ...progress, phase: "check_source_balance" } },
            next_delay_sec: payload.interval_sec,
          };
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        job: {
          ...job,
          progress: { ...progress, phase: "check_source_balance" },
        },
        log: { ok: false, message: `DEX 到 CEX 搬砖任务错误: ${message}` },
        next_delay_sec: payload.interval_sec,
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

  if (job.job_type === "crosschain_oft") {
    return createCrosschainOftTaskExecutor(session, req);
  }

  if (job.job_type === "arbitrage") {
    return createArbitrageTaskExecutor(session, req, appendHistory);
  }

  if (job.job_type === "dex_to_cex_arbitrage") {
    return createDexToCexArbitrageTaskExecutor(session, req);
  }

  const payload = job.payload as SellMarketTaskPayload;
  const context = resolveAccountContext(payload.account_id, session, req);
  return createSellMarketTaskExecutor(context);
}
