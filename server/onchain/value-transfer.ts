import { ethers } from "ethers";
import type { Request } from "express";
import type { SessionManager } from "../security.js";
import type { CrosschainOftTaskPayload } from "../tasks/types.js";
import { evmChains, getEvmChain } from "./chains.js";
import { resolveLayerZeroApiKey, type TransferTransaction } from "./layerzero.js";
import { getSigner, resolveOnchainWallet } from "./wallets.js";

const TRANSFER_BASE = "https://transfer.layerzero-api.com/v1";
const NATIVE_TOKEN = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const ERC20_ABI = [
  "function decimals() view returns (uint8)",
];

export interface ValueTransferStep {
  type: string;
  description?: string;
  chainKey: string;
  chainType?: string;
  signerAddress?: string;
  transaction?: {
    encoded?: {
      to: string;
      data: string;
      value?: string;
      chainId?: number;
      from?: string;
      gasLimit?: string;
    };
  };
}

export interface ValueTransferQuote {
  id: string;
  feeUsd?: string;
  feePercent?: string;
  srcAmount: string;
  dstAmount?: string;
  dstAmountMin?: string;
  routeSteps?: Array<{ type?: string; description?: string; srcChainKey?: string; dstChainKey?: string }>;
  userSteps?: ValueTransferStep[];
  fees?: unknown[];
  duration?: { estimated?: string | null };
  expiresAt?: string;
  raw: unknown;
}

export interface ValueTransferStatus {
  status: string;
  sourceTxHash?: string;
  destinationTxHash?: string;
  raw: unknown;
}

export interface ValueTransferToken {
  isSupported?: boolean;
  chainKey: string;
  address: string;
  decimals: number;
  symbol: string;
  name: string;
}

export interface ValueTransferRoute {
  symbol: string;
  name: string;
  srcChain: string;
  dstChain: string;
  srcDeployment: {
    address: string;
    localDecimals: number;
    type: string;
    innerTokenAddress?: string;
    approvalRequired?: boolean;
  };
  dstDeployment: {
    address: string;
    localDecimals: number;
    type: string;
    innerTokenAddress?: string;
    approvalRequired?: boolean;
  };
  sharedDecimals: number;
  endpointVersion: "value-transfer";
}

async function fetchJson<T>(url: string, apiKey: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const bodyText = await response.text();
  const parsed = bodyText ? JSON.parse(bodyText) as unknown : null;
  if (!response.ok) {
    const message =
      parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error?: { message?: unknown } }).error?.message ?? response.statusText)
        : response.statusText;
    throw new Error(message);
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    "error" in parsed &&
    (parsed as { error?: unknown }).error
  ) {
    const error = (parsed as { error?: { message?: unknown } }).error;
    throw new Error(String(error?.message ?? "Value Transfer API error"));
  }
  return parsed as T;
}

async function fetchPublicJson<T>(url: URL): Promise<T> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });
  const bodyText = await response.text();
  const parsed = bodyText ? JSON.parse(bodyText) as unknown : null;
  if (!response.ok) {
    const message =
      parsed && typeof parsed === "object" && "message" in parsed
        ? String((parsed as { message?: unknown }).message)
        : response.statusText;
    throw new Error(message);
  }
  return parsed as T;
}

function normalizeQuote(rawQuote: unknown): ValueTransferQuote {
  const quote = rawQuote as Record<string, unknown>;
  return {
    id: String(quote.id ?? ""),
    feeUsd: quote.feeUsd === undefined ? undefined : String(quote.feeUsd),
    feePercent: quote.feePercent === undefined ? undefined : String(quote.feePercent),
    srcAmount: String(quote.srcAmount ?? "0"),
    dstAmount: quote.dstAmount === undefined ? undefined : String(quote.dstAmount),
    dstAmountMin: quote.dstAmountMin === undefined ? undefined : String(quote.dstAmountMin),
    routeSteps: quote.routeSteps as ValueTransferQuote["routeSteps"],
    userSteps: quote.userSteps as ValueTransferStep[] | undefined,
    fees: quote.fees as unknown[] | undefined,
    duration: quote.duration as ValueTransferQuote["duration"],
    expiresAt: quote.expiresAt === undefined ? undefined : String(quote.expiresAt),
    raw: rawQuote,
  };
}

export async function listValueTransferRoutesByTokenAddress(
  srcChain: string,
  tokenAddress: string,
): Promise<ValueTransferRoute[]> {
  if (!ethers.isAddress(tokenAddress)) {
    throw new Error("token_address must be an EVM address");
  }

  const url = new URL(`${TRANSFER_BASE}/tokens`);
  url.searchParams.set("transferrableFromChainKey", srcChain);
  url.searchParams.set("transferrableFromTokenAddress", tokenAddress);

  const raw = await fetchPublicJson<{ tokens?: ValueTransferToken[] }>(url);
  const srcToken = raw.tokens?.find((token) =>
    token.chainKey === srcChain &&
    token.address.toLowerCase() === tokenAddress.toLowerCase() &&
    ethers.isAddress(token.address)
  );
  const srcDecimals = srcToken?.decimals ?? await getTokenDecimals(srcChain, tokenAddress);

  return (raw.tokens ?? [])
    .filter((token) =>
      token.isSupported !== false &&
      token.chainKey !== srcChain &&
      token.chainKey in evmChains &&
      ethers.isAddress(token.address)
    )
    .map((token) => ({
      symbol: token.symbol,
      name: token.name,
      srcChain,
      dstChain: token.chainKey,
      srcDeployment: {
        address: tokenAddress,
        localDecimals: srcDecimals,
        type: "VALUE_TRANSFER_TOKEN",
        approvalRequired: true,
      },
      dstDeployment: {
        address: token.address,
        localDecimals: token.decimals,
        type: "VALUE_TRANSFER_TOKEN",
      },
      sharedDecimals: Math.min(srcDecimals, token.decimals),
      endpointVersion: "value-transfer",
    }));
}

export async function getTokenDecimals(chainName: string, tokenAddress: string): Promise<number> {
  if (tokenAddress.toLowerCase() === NATIVE_TOKEN) return 18;
  const chain = getEvmChain(chainName);
  const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId);
  try {
    const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    return Number(await contract.decimals());
  } catch {
    return 18;
  }
}

export async function requestValueTransferQuote(params: {
  apiKey: string;
  payload: CrosschainOftTaskPayload;
  srcWalletAddress: string;
  amountRaw?: string;
}): Promise<{ quote: ValueTransferQuote; amountRaw: string; raw: unknown }> {
  if (!params.payload.token_address || !ethers.isAddress(params.payload.token_address)) {
    throw new Error("source token address is required");
  }
  if (!params.payload.dst_token_address || !ethers.isAddress(params.payload.dst_token_address)) {
    throw new Error("destination token address is required");
  }
  if (!ethers.isAddress(params.payload.recipient)) {
    throw new Error("recipient must be an EVM address");
  }

  const decimals = await getTokenDecimals(params.payload.src_chain, params.payload.token_address);
  const amountRaw = params.amountRaw ?? ethers.parseUnits(params.payload.amount, decimals).toString();
  const response = await fetchJson<{
    quotes?: unknown[];
    rejectedQuotes?: unknown[];
    tokens?: unknown[];
  }>(`${TRANSFER_BASE}/quotes`, params.apiKey, {
    srcChainKey: params.payload.src_chain,
    dstChainKey: params.payload.dst_chain,
    srcTokenAddress: params.payload.token_address,
    dstTokenAddress: params.payload.dst_token_address,
    srcWalletAddress: params.srcWalletAddress,
    dstWalletAddress: params.payload.recipient,
    amount: amountRaw,
    options: {
      amountType: "EXACT_SRC_AMOUNT",
      feeTolerance: {
        type: "PERCENT",
        amount: 1,
      },
    },
  });
  const firstQuote = response.quotes?.[0];
  if (!firstQuote) {
    throw new Error("No Value Transfer quote returned");
  }
  return { quote: normalizeQuote(firstQuote), amountRaw, raw: response };
}

export async function quoteForPayload(
  payload: CrosschainOftTaskPayload,
  session: SessionManager,
  req: Request,
): Promise<{ quote: ValueTransferQuote; amountRaw: string; walletAddress: string; raw: unknown }> {
  const wallet = resolveOnchainWallet(payload.wallet_id, session, req);
  const apiKey = resolveLayerZeroApiKey(session, req);
  const result = await requestValueTransferQuote({
    apiKey,
    payload,
    srcWalletAddress: wallet.address,
  });
  return {
    ...result,
    walletAddress: wallet.address,
  };
}

function normalizeStepTransaction(step: ValueTransferStep): TransferTransaction {
  const tx = step.transaction?.encoded;
  if (!tx || !ethers.isAddress(tx.to) || !tx.data?.startsWith("0x")) {
    throw new Error(`Invalid transaction step: ${step.description ?? step.type}`);
  }
  return {
    to: tx.to,
    data: tx.data,
    value: tx.value ?? "0",
    gasLimit: tx.gasLimit,
  };
}

function toBigInt(value: string | undefined): bigint {
  if (!value) return 0n;
  return BigInt(value);
}

export async function executeValueTransferQuote(
  payload: CrosschainOftTaskPayload,
  session: SessionManager,
  req: Request,
): Promise<{ quote: ValueTransferQuote; txHashes: string[] }> {
  const wallet = resolveOnchainWallet(payload.wallet_id, session, req);
  const apiKey = resolveLayerZeroApiKey(session, req);
  const { quote } = await requestValueTransferQuote({
    apiKey,
    payload,
    srcWalletAddress: wallet.address,
  });
  const txSteps = quote.userSteps ?? [];
  if (txSteps.length === 0) {
    throw new Error("Quote did not return executable user steps");
  }

  const txHashes: string[] = [];
  for (const step of txSteps) {
    if (step.type !== "TRANSACTION" || step.chainType !== "EVM") {
      throw new Error(`Unsupported user step: ${step.type} ${step.chainType ?? ""}`.trim());
    }
    if (step.chainKey !== payload.src_chain) {
      throw new Error(`Unsupported execution chain: ${step.chainKey}`);
    }
    const signer = await getSigner(wallet, step.chainKey);
    const tx = normalizeStepTransaction(step);
    const response = await signer.sendTransaction({
      to: tx.to,
      data: tx.data,
      value: toBigInt(tx.value),
      gasLimit: tx.gasLimit ? toBigInt(tx.gasLimit) : undefined,
    });
    const receipt = await response.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error(`Transaction failed: ${response.hash}`);
    }
    txHashes.push(response.hash);
  }

  return { quote, txHashes };
}

export async function getValueTransferStatus(
  quoteId: string,
  session: SessionManager,
  req: Request,
): Promise<ValueTransferStatus> {
  const apiKey = resolveLayerZeroApiKey(session, req);
  const raw = await fetchJson<unknown>(
    `${TRANSFER_BASE}/status?quoteId=${encodeURIComponent(quoteId)}`,
    apiKey,
  );
  const value = raw as Record<string, unknown>;
  return {
    status: String(value.status ?? value.transferStatus ?? "UNKNOWN"),
    sourceTxHash: value.sourceTxHash === undefined ? undefined : String(value.sourceTxHash),
    destinationTxHash: value.destinationTxHash === undefined ? undefined : String(value.destinationTxHash),
    raw,
  };
}
