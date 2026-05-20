import type { Request } from "express";
import { ethers } from "ethers";
import type { SessionManager } from "../security.js";
import type { CrosschainOftTaskPayload, CrosschainOftTaskProgress } from "../tasks/types.js";
import { appendCrosschainHistory } from "./history.js";
import {
  executeValueTransferQuote,
  getTokenDecimals,
  getValueTransferStatus,
  quoteForPayload,
} from "./value-transfer.js";
import {
  directExecuteValueTransfer,
  directGetValueTransferStatus,
  directQuoteForPayload,
} from "./oft-direct.js";
import {
  isNoStargateRouteError,
  stargateDirectExecuteValueTransfer,
  stargateDirectQuoteForPayload,
} from "./stargate-direct.js";
import { getSigner, resolveOnchainWallet } from "./wallets.js";

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

export interface CrosschainPreview {
  wallet_address: string;
  symbol: string;
  src_chain: string;
  dst_chain: string;
  amount_raw: string;
  local_decimals: number;
  token_address?: string;
  dst_token_address?: string;
  approval_required: boolean;
  has_approval_transaction: boolean;
  native_balance: string;
  token_balance?: string;
  allowance?: string;
  transfer_value: string;
  estimated_received?: string;
  quote_id?: string;
  fee_usd?: string;
  fee_percent?: string;
  route_steps?: unknown[];
  user_steps?: unknown[];
  can_execute: boolean;
  raw?: unknown;
  /** Current on-chain token balance (sweep mode only) */
  dynamic_balance?: string;
  dynamic_balance_raw?: string;
}

export interface CrosschainSendResult {
  sourceTxHash: string;
  approvalTxHash?: string;
  guid?: string;
  quoteId?: string;
}

/**
 * Read the ERC20 token balance of a wallet on-chain.
 * Returns raw bigint, formatted decimal string, and token decimals.
 */
export async function getWalletTokenBalance(
  walletId: string,
  chainName: string,
  tokenAddress: string,
  session: SessionManager,
  req: Request,
): Promise<{ raw: bigint; formatted: string; decimals: number }> {
  const wallet = resolveOnchainWallet(walletId, session, req);
  const decimals = await getTokenDecimals(chainName, tokenAddress);
  const signer = await getSigner(wallet, chainName);
  const provider = signer.provider;
  if (!provider) throw new Error("No provider available");
  const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const raw = await tokenContract.balanceOf(wallet.address) as bigint;
  return { raw, formatted: ethers.formatUnits(raw, decimals), decimals };
}

async function directPreview(
  payload: CrosschainOftTaskPayload,
  session: SessionManager,
  req: Request,
): Promise<CrosschainPreview> {
  const result = await directQuoteForPayload(payload, session, req).catch(async (error) => {
    if (!isMissingOftRouteError(error)) throw error;
    try {
      return await stargateDirectQuoteForPayload(payload, session, req);
    } catch (stargateError) {
      if (isNoStargateRouteError(stargateError)) {
        throw new Error(
          "直连模式未找到可直接调用的 OFT 或 Stargate V2 合约路线；该路线可能只能通过 LayerZero Value Transfer API 生成交易。",
        );
      }
      throw stargateError;
    }
  });
  const rawData = result.raw as Record<string, unknown> | undefined;
  return {
    wallet_address: result.walletAddress,
    symbol: payload.symbol || "TRANSFER",
    src_chain: payload.src_chain,
    dst_chain: payload.dst_chain,
    token_address: payload.token_address,
    dst_token_address: payload.dst_token_address,
    amount_raw: result.amountRaw,
    local_decimals: 0,
    approval_required: Boolean(rawData?.approvalRequired),
    has_approval_transaction: Boolean(rawData?.approvalRequired),
    native_balance: String(rawData?.nativeBalance ?? "0"),
    token_balance: String(rawData?.tokenBalance ?? ""),
    allowance: String(rawData?.allowance ?? ""),
    transfer_value: String(rawData?.nativeFee ?? "0"),
    estimated_received: result.quote.dstAmount,
    quote_id: result.quote.id,
    route_steps: result.quote.routeSteps,
    user_steps: result.quote.userSteps,
    fee_usd: undefined,
    fee_percent: undefined,
    can_execute: true,
    raw: result.raw,
  };
}

async function apiPreview(
  payload: CrosschainOftTaskPayload,
  session: SessionManager,
  req: Request,
): Promise<CrosschainPreview> {
  const result = await quoteForPayload(payload, session, req);
  return {
    wallet_address: result.walletAddress,
    symbol: payload.symbol || "TRANSFER",
    src_chain: payload.src_chain,
    dst_chain: payload.dst_chain,
    token_address: payload.token_address,
    dst_token_address: payload.dst_token_address,
    amount_raw: result.amountRaw,
    local_decimals: 0,
    approval_required: Boolean(result.quote.userSteps?.some((step) =>
      String((step as { description?: unknown }).description ?? "")
        .toLowerCase()
        .includes("approv"),
    )),
    has_approval_transaction: Boolean(result.quote.userSteps?.some((step) =>
      String((step as { description?: unknown }).description ?? "")
        .toLowerCase()
        .includes("approv"),
    )),
    native_balance: "0",
    transfer_value: "0",
    estimated_received: result.quote.dstAmount,
    quote_id: result.quote.id,
    fee_usd: result.quote.feeUsd,
    fee_percent: result.quote.feePercent,
    route_steps: result.quote.routeSteps,
    user_steps: result.quote.userSteps,
    can_execute: Boolean(result.quote.userSteps?.length),
    raw: result.raw,
  };
}

export async function previewCrosschainOft(
  payload: CrosschainOftTaskPayload,
  session: SessionManager,
  req: Request,
  mode: "api" | "direct" = "api",
): Promise<CrosschainPreview> {
  // Sweep mode: read live balance and override amount
  if (payload.dynamic_amount && payload.token_address) {
    const balance = await getWalletTokenBalance(
      payload.wallet_id, payload.src_chain, payload.token_address,
      session, req,
    );
    const innerPayload = { ...payload, amount: balance.formatted, dynamic_amount: false };
    const preview = mode === "direct"
      ? await directPreview(innerPayload, session, req)
      : await apiPreview(innerPayload, session, req);
    return { ...preview, dynamic_balance: balance.formatted, dynamic_balance_raw: balance.raw.toString() };
  }

  return mode === "direct"
    ? directPreview(payload, session, req)
    : apiPreview(payload, session, req);
}

export async function sendCrosschainOft(
  payload: CrosschainOftTaskPayload,
  session: SessionManager,
  req: Request,
  mode: "api" | "direct" = "api",
): Promise<CrosschainSendResult> {
  if (mode === "direct") {
    const result = await directExecuteValueTransfer(payload, session, req).catch(async (error) => {
      if (!isMissingOftRouteError(error)) throw error;
      try {
        return await stargateDirectExecuteValueTransfer(payload, session, req);
      } catch (stargateError) {
        if (isNoStargateRouteError(stargateError)) {
          throw new Error(
            "直连模式未找到可直接调用的 OFT 或 Stargate V2 合约路线；该路线可能只能通过 LayerZero Value Transfer API 生成交易。",
          );
        }
        throw stargateError;
      }
    });
    return {
      sourceTxHash: result.txHashes.at(-1) ?? "",
      approvalTxHash: result.txHashes.length > 1 ? result.txHashes[0] : undefined,
      quoteId: result.quote.id,
    };
  }

  const result = await executeValueTransferQuote(payload, session, req);
  return {
    sourceTxHash: result.txHashes.at(-1) ?? "",
    approvalTxHash: result.txHashes.length > 1 ? result.txHashes[0] : undefined,
    quoteId: result.quote.id,
  };
}

function isMissingOftRouteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("No supported LayerZero OFT route");
}

export async function pollCrosschainDelivery(
  quoteIdOrTxHash: string,
  session?: SessionManager,
  req?: Request,
  mode: "api" | "direct" = "api",
): Promise<{
  delivered: boolean;
  failed: boolean;
  lzStatus: string;
  message: string;
  destinationTxHash?: string;
  guid?: string;
}> {
  if (mode === "direct") {
    const status = await directGetValueTransferStatus(quoteIdOrTxHash);
    const statusName = status.status.toUpperCase();
    const delivered = ["DELIVERED", "COMPLETED", "SUCCESS", "SUCCEEDED"].includes(statusName);
    const failed = ["FAILED", "ERROR", "REVERTED"].includes(statusName);
    return {
      delivered,
      failed,
      lzStatus: statusName,
      message: status.status,
      destinationTxHash: status.destinationTxHash,
    };
  }

  if (!session || !req) {
    return {
      delivered: false,
      failed: false,
      lzStatus: "SUBMITTED",
      message: "Waiting for Value Transfer status",
    };
  }
  const status = await getValueTransferStatus(quoteIdOrTxHash, session, req);
  const statusName = status.status.toUpperCase();
  const delivered = ["DELIVERED", "COMPLETED", "SUCCESS", "SUCCEEDED"].includes(statusName);
  const failed = ["FAILED", "ERROR", "REVERTED"].includes(statusName);
  return {
    delivered,
    failed,
    lzStatus: statusName,
    message: status.status,
    destinationTxHash: status.destinationTxHash,
  };
}

export function appendCrosschainTaskHistory(params: {
  payload: CrosschainOftTaskPayload;
  sourceTxHash?: string;
  progress?: CrosschainOftTaskProgress;
  status: string;
  message: string;
}): void {
  appendCrosschainHistory({
    timestamp: new Date().toISOString(),
    wallet_id: params.payload.wallet_id,
    symbol: params.payload.symbol || "TRANSFER",
    src_chain: params.payload.src_chain,
    dst_chain: params.payload.dst_chain,
    amount: params.payload.amount,
    recipient: params.payload.recipient,
    source_tx_hash: params.sourceTxHash ?? params.progress?.source_tx_hash,
    destination_tx_hash: params.progress?.destination_tx_hash,
    guid: params.progress?.guid,
    lz_status: params.progress?.lz_status ?? "UNKNOWN",
    status: params.status,
    message: params.message,
  });
}
