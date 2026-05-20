import crypto from "node:crypto";
import type { Request } from "express";
import { loadConfig } from "../config.js";
import { decrypt, type SessionManager } from "../security.js";

const OKX_WEB3_BASE = "https://web3.okx.com";

export interface OkxWeb3Creds {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
  source: "database" | "environment";
}

interface OkxTokenAsset {
  tokenContractAddress?: string;
  tokenContractAddr?: string;
  address?: string;
  symbol?: string;
  tokenSymbol?: string;
  tokenName?: string;
  balance?: string;
  tokenBalance?: string;
}

export interface OkxWeb3TokenBalance {
  token_address: string;
  symbol: string;
  name: string;
  balance: string;
}

export function signOkxWeb3Request(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64");
}

export function buildOkxWeb3RequestPath(path: string, query: Record<string, string>): string {
  const search = new URLSearchParams(query);
  const queryString = search.toString();
  return queryString ? `${path}?${queryString}` : path;
}

function maskKey(value: string): string {
  if (value.length <= 8) return `${value.slice(0, 2)}***`;
  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

export function getOkxWeb3EnvCreds(): OkxWeb3Creds | null {
  const apiKey = String(process.env.OKX_DEX_API_KEY || "").trim();
  const apiSecret = String(process.env.OKX_DEX_API_SECRET || "").trim();
  const passphrase = String(process.env.OKX_DEX_API_PASSPHRASE || "").trim();
  if (!apiKey || !apiSecret || !passphrase) return null;
  return { apiKey, apiSecret, passphrase, source: "environment" };
}

function getOkxWeb3StoredCreds(session: SessionManager, req: Request): OkxWeb3Creds | null {
  const key = session.getKey(req);
  const config = loadConfig();
  if (!config.okx_web3) return null;
  if (!key) throw new Error("Session not unlocked");
  return {
    apiKey: config.okx_web3.api_key,
    apiSecret: decrypt(config.okx_web3.api_secret_enc, key),
    passphrase: decrypt(config.okx_web3.passphrase_enc, key),
    source: "database",
  };
}

function getOkxWeb3Creds(session: SessionManager, req: Request): OkxWeb3Creds {
  const stored = getOkxWeb3StoredCreds(session, req);
  if (stored) return stored;
  const env = getOkxWeb3EnvCreds();
  if (env) return env;
  throw new Error("OKX Web3 API key is not configured");
}

function describeCreds(creds: OkxWeb3Creds): Record<string, string | number> {
  return {
    source: creds.source,
    apiKey: maskKey(creds.apiKey),
    apiSecretLength: creds.apiSecret.length,
    passphraseLength: creds.passphrase.length,
  };
}

interface OkxWeb3ErrorBody {
  code?: string;
  msg?: string;
  message?: string;
}

class OkxWeb3ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly statusText: string,
    readonly body: OkxWeb3ErrorBody,
  ) {
    super(message);
  }
}

function getFallbackEnvCreds(primary: OkxWeb3Creds): OkxWeb3Creds | null {
  if (primary.source === "environment") return null;
  const env = getOkxWeb3EnvCreds();
  if (!env) return null;
  if (
    env.apiKey === primary.apiKey &&
    env.apiSecret === primary.apiSecret &&
    env.passphrase === primary.passphrase
  ) {
    return null;
  }
  return env;
}

async function fetchOkxWeb3<T>(url: string, requestPath: string, query: Record<string, string>, creds: OkxWeb3Creds): Promise<T> {
  const timestamp = new Date().toISOString();
  const sign = signOkxWeb3Request(`${timestamp}GET${requestPath}`, creds.apiSecret);
  const headers: Record<string, string> = {
    "OK-ACCESS-KEY": creds.apiKey,
    "OK-ACCESS-SIGN": sign,
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-PASSPHRASE": creds.passphrase,
  };

  console.info("[okx-web3] request", {
    method: "GET",
    requestPath,
    query,
    timestamp,
    credentials: describeCreds(creds),
  });

  let response: Response;
  let bodyText = "";
  try {
    response = await fetch(url, { method: "GET", headers });
    bodyText = await response.text();
  } catch (error: unknown) {
    console.error("[okx-web3] network error", {
      method: "GET",
      requestPath,
      query,
      credentials: describeCreds(creds),
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }

  let body: { code?: string; msg?: string; message?: string; data?: T } = {};
  try {
    body = bodyText ? JSON.parse(bodyText) as { code?: string; msg?: string; message?: string; data?: T } : {};
  } catch (error: unknown) {
    console.error("[okx-web3] invalid json response", {
      method: "GET",
      requestPath,
      status: response.status,
      statusText: response.statusText,
      bodyText,
      credentials: describeCreds(creds),
      message: error instanceof Error ? error.message : String(error),
    });
    throw new Error(`OKX Web3 returned invalid JSON: ${response.status} ${response.statusText}`);
  }

  if (!response.ok || body.code !== "0") {
    console.error("[okx-web3] error response", {
      method: "GET",
      requestPath,
      query,
      status: response.status,
      statusText: response.statusText,
      code: body.code,
      msg: body.msg,
      message: body.message,
      credentials: describeCreds(creds),
      body,
    });
    throw new OkxWeb3ApiError(
      body.msg || body.message || `${response.status} ${response.statusText}`,
      response.status,
      response.statusText,
      body,
    );
  }
  console.info("[okx-web3] success", {
    method: "GET",
    requestPath,
    status: response.status,
    credentials: describeCreds(creds),
  });
  return body.data as T;
}

async function okxWeb3Get<T>(
  path: string,
  query: Record<string, string>,
  session: SessionManager,
  req: Request,
): Promise<T> {
  const creds = getOkxWeb3Creds(session, req);
  const requestPath = buildOkxWeb3RequestPath(path, query);
  const url = `${OKX_WEB3_BASE}${requestPath}`;

  try {
    return await fetchOkxWeb3<T>(url, requestPath, query, creds);
  } catch (error: unknown) {
    const fallback = error instanceof OkxWeb3ApiError && error.body.code === "50114"
      ? getFallbackEnvCreds(creds)
      : null;
    if (!fallback) throw error;
    console.warn("[okx-web3] retry with environment credentials after Invalid Authority", {
      method: "GET",
      requestPath,
      primaryCredentials: describeCreds(creds),
      fallbackCredentials: describeCreds(fallback),
    });
    return await fetchOkxWeb3<T>(url, requestPath, query, fallback);
  }
}

export function normalizeOkxWeb3TokenBalances(raw: unknown): OkxWeb3TokenBalance[] {
  const rows = Array.isArray(raw) ? raw : [];
  const first = rows[0] as { tokenAssets?: OkxTokenAsset[] } | undefined;
  return (first?.tokenAssets || [])
    .map((token) => {
      const tokenAddress =
        token.tokenContractAddress ||
        token.tokenContractAddr ||
        token.address ||
        "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
      const symbol = token.symbol || token.tokenSymbol || token.tokenName || "TOKEN";
      return {
        token_address: tokenAddress,
        symbol,
        name: token.tokenName || symbol,
        balance: token.balance || token.tokenBalance || "",
      };
    })
    .filter((token) => token.token_address);
}

export async function listOkxWeb3TokenBalances(params: {
  address: string;
  chainId: number;
  session: SessionManager;
  req: Request;
}): Promise<OkxWeb3TokenBalance[]> {
  const data = await okxWeb3Get<unknown>(
    "/api/v6/dex/balance/all-token-balances-by-address",
    {
      address: params.address,
      chains: String(params.chainId),
      excludeRiskToken: "1",
    },
    params.session,
    params.req,
  );
  return normalizeOkxWeb3TokenBalances(data);
}
