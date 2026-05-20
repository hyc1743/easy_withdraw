import { ethers } from "ethers";
import { loadConfig } from "../config.js";
import { decrypt, type SessionManager } from "../security.js";
import { evmChains } from "./chains.js";

const METADATA_BASE = "https://metadata.layerzero-api.com/v1/metadata/experiment";
const SCAN_BASE = "https://scan.layerzero-api.com/v1";

export interface OftDeployment {
  address: string;
  localDecimals: number;
  type: string;
  innerTokenAddress?: string;
  approvalRequired?: boolean;
}

export interface OftToken {
  symbol: string;
  name: string;
  sharedDecimals: number;
  endpointVersion: string;
  deployments: Record<string, OftDeployment>;
}

export interface TransferTransaction {
  to: string;
  data: string;
  value?: string;
  gasLimit?: string;
}

export interface OftTransferQuote {
  approvalTransaction?: TransferTransaction | null;
  transaction: TransferTransaction;
  amountReceived?: string;
  raw: unknown;
}

export interface OftRoute {
  symbol: string;
  name: string;
  srcChain: string;
  dstChain: string;
  srcDeployment: OftDeployment;
  dstDeployment: OftDeployment;
  sharedDecimals: number;
  endpointVersion: string;
}

export interface LayerZeroMessageStatus {
  name: string;
  message?: string;
}

export interface LayerZeroMessage {
  guid?: string;
  status?: LayerZeroMessageStatus;
  destination?: {
    status?: string;
    tx?: {
      txHash?: string;
    };
  };
}

function getLayerZeroApiKey(session: SessionManager, req: Parameters<SessionManager["getKey"]>[0]): string {
  const key = session.getKey(req);
  if (!key) throw new Error("Session not unlocked");
  const config = loadConfig();
  if (!config.layerzero_api_key_enc) {
    throw new Error("LayerZero API key is not configured");
  }
  return decrypt(config.layerzero_api_key_enc, key);
}

async function fetchJson<T>(url: URL, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const bodyText = await response.text();
  const body = bodyText ? JSON.parse(bodyText) as unknown : null;
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "message" in body
        ? String((body as { message?: unknown }).message)
        : `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return body as T;
}

export async function listOfts(filters: {
  symbol?: string;
  chainNames?: string[];
  contractAddresses?: string[];
} = {}): Promise<OftToken[]> {
  const url = new URL(`${METADATA_BASE}/ofts/list`);
  if (filters.symbol) url.searchParams.set("symbols", filters.symbol.toUpperCase());
  if (filters.chainNames?.length) url.searchParams.set("chainNames", filters.chainNames.join(","));
  if (filters.contractAddresses?.length) {
    url.searchParams.set("contractAddresses", filters.contractAddresses.join(","));
  }
  const raw = await fetchJson<Record<string, Array<Omit<OftToken, "symbol">>>>(url);
  return Object.entries(raw).flatMap(([tokenSymbol, tokens]) =>
    tokens.map((token) => ({
      symbol: tokenSymbol,
      ...token,
      deployments: Object.fromEntries(
        Object.entries(token.deployments).filter(([chain]) => chain in evmChains),
      ),
    })),
  ).filter((token) => Object.keys(token.deployments).length > 0);
}

function deploymentMatchesAddress(deployment: OftDeployment, address: string): boolean {
  return (
    deployment.address.toLowerCase() === address.toLowerCase() ||
    deployment.innerTokenAddress?.toLowerCase() === address.toLowerCase()
  );
}

export async function listOftRoutesByTokenAddress(
  srcChain: string,
  tokenAddress: string,
): Promise<OftRoute[]> {
  if (!ethers.isAddress(tokenAddress)) {
    throw new Error("token_address must be an EVM address");
  }
  let tokens = await listOfts({
    chainNames: [srcChain],
    contractAddresses: [tokenAddress],
  });
  tokens = tokens.filter((token) =>
    token.deployments[srcChain] &&
    deploymentMatchesAddress(token.deployments[srcChain], tokenAddress),
  );

  if (tokens.length === 0) {
    const chainTokens = await listOfts({ chainNames: [srcChain] });
    tokens = chainTokens.filter((token) =>
      token.deployments[srcChain] &&
      deploymentMatchesAddress(token.deployments[srcChain], tokenAddress),
    );
  }

  const fullTokens = (
    await Promise.all(tokens.map((token) => listOfts({ symbol: token.symbol })))
  ).flat();

  return fullTokens.flatMap((token) =>
    Object.entries(token.deployments)
      .filter(([chain]) => chain !== srcChain && chain in evmChains)
      .map(([dstChain, dstDeployment]) => ({
        symbol: token.symbol,
        name: token.name,
        srcChain,
        dstChain,
        srcDeployment: token.deployments[srcChain],
        dstDeployment,
        sharedDecimals: token.sharedDecimals,
        endpointVersion: token.endpointVersion,
      })),
  );
}

export async function findOftRoute(
  params: {
    srcChain: string;
    dstChain: string;
    tokenAddress?: string;
    dstTokenAddress?: string;
    symbol?: string;
  },
): Promise<OftRoute> {
  const tokens = params.tokenAddress
    ? (await listOftRoutesByTokenAddress(params.srcChain, params.tokenAddress))
    : [];
  const tokenRoute = tokens.find(
    (route) =>
      route.endpointVersion === "v2" &&
      route.dstChain === params.dstChain &&
      (
        !params.dstTokenAddress ||
        deploymentMatchesAddress(route.dstDeployment, params.dstTokenAddress)
      ),
  );
  if (tokenRoute) return tokenRoute;

  if (!params.symbol) {
    throw new Error(`No supported LayerZero OFT route for ${params.srcChain}->${params.dstChain}`);
  }
  const symbolTokens = await listOfts({ symbol: params.symbol });
  const token = symbolTokens.find(
    (candidate) =>
      candidate.endpointVersion === "v2" &&
      candidate.deployments[params.srcChain] &&
      candidate.deployments[params.dstChain],
  );
  if (!token) {
    throw new Error(`No supported LayerZero OFT route for ${params.symbol} ${params.srcChain}->${params.dstChain}`);
  }
  return {
    symbol: token.symbol,
    name: token.name,
    srcChain: params.srcChain,
    dstChain: params.dstChain,
    srcDeployment: token.deployments[params.srcChain],
    dstDeployment: token.deployments[params.dstChain],
    sharedDecimals: token.sharedDecimals,
    endpointVersion: token.endpointVersion,
  };
}

function normalizeTransaction(raw: unknown): TransferTransaction {
  if (!raw || typeof raw !== "object") {
    throw new Error("LayerZero API did not return a transaction");
  }
  const rawValue = raw as Record<string, unknown>;
  const value =
    rawValue.populatedTransaction && typeof rawValue.populatedTransaction === "object"
      ? rawValue.populatedTransaction as Record<string, unknown>
      : rawValue;
  const to = String(value.to ?? value.target ?? "");
  const data = String(value.data ?? value.calldata ?? "");
  if (!ethers.isAddress(to) || !data.startsWith("0x")) {
    throw new Error("LayerZero API returned an invalid transaction");
  }
  return {
    to,
    data,
    value: value.value === undefined ? "0" : String(value.value),
    gasLimit: value.gasLimit === undefined ? undefined : String(value.gasLimit),
  };
}

function normalizeTransferQuote(raw: unknown): OftTransferQuote {
  const value = raw as Record<string, unknown>;
  const transactionData =
    value.transactionData && typeof value.transactionData === "object"
      ? value.transactionData as Record<string, unknown>
      : {};
  const txRaw =
    value.transaction ??
    value.tx ??
    value.transferTransaction ??
    transactionData.populatedTransaction;
  const approvalRaw =
    value.approvalTransaction ??
    value.approvalTx ??
    transactionData.approvalTransaction;
  return {
    approvalTransaction: approvalRaw ? normalizeTransaction(approvalRaw) : null,
    transaction: normalizeTransaction(txRaw),
    amountReceived: value.amountReceived === undefined ? undefined : String(value.amountReceived),
    raw,
  };
}

export async function getOftTransferQuote(params: {
  apiKey: string;
  symbol: string;
  srcChain: string;
  dstChain: string;
  tokenAddress?: string;
  dstTokenAddress?: string;
  from: string;
  to: string;
  amountRaw: string;
  slippageBps: number;
  options?: unknown;
  composeMsg?: string;
  oftCmd?: string;
  validate?: boolean;
}): Promise<OftTransferQuote> {
  const route = await findOftRoute({
    symbol: params.symbol,
    srcChain: params.srcChain,
    dstChain: params.dstChain,
    tokenAddress: params.tokenAddress,
    dstTokenAddress: params.dstTokenAddress,
  });
  const url = new URL(`${METADATA_BASE}/ofts/transfer`);
  url.searchParams.set("srcChainName", params.srcChain);
  url.searchParams.set("dstChainName", params.dstChain);
  url.searchParams.set("oftAddress", route.srcDeployment.address);
  url.searchParams.set("amount", params.amountRaw);
  url.searchParams.set("from", params.from);
  url.searchParams.set("to", params.to);
  url.searchParams.set("slippageBps", String(params.slippageBps));
  if (params.options) url.searchParams.set("options", JSON.stringify(params.options));
  if (params.composeMsg) url.searchParams.set("composeMsg", params.composeMsg);
  if (params.oftCmd) url.searchParams.set("oftCmd", params.oftCmd);
  url.searchParams.set("validate", params.validate === false ? "false" : "true");

  const raw = await fetchJson<unknown>(url, {
    headers: {
      "x-layerzero-api-key": params.apiKey,
      accept: "application/json",
    },
  });
  return normalizeTransferQuote(raw);
}

export async function getLayerZeroMessage(txHash: string): Promise<LayerZeroMessage | null> {
  const url = new URL(`${SCAN_BASE}/messages/tx/${txHash}`);
  const raw = await fetchJson<{ data?: LayerZeroMessage[] }>(url, {
    headers: { accept: "application/json" },
  });
  return raw.data?.[0] ?? null;
}

export function resolveLayerZeroApiKey(
  session: SessionManager,
  req: Parameters<SessionManager["getKey"]>[0],
): string {
  return getLayerZeroApiKey(session, req);
}
