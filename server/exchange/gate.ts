import crypto from "node:crypto";
import type {
  ExchangeAdapter,
  WithdrawRequest,
  WithdrawResponse,
  DecryptedCreds,
  CurrencyInfo,
  ChainInfo,
  AssetBalance,
} from "./types.js";

const BASE_URL = "https://api.gateio.ws";
const API_PREFIX = "/api/v4";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2;
const GATE_WITHDRAW_ORDER_ID_MAX_LEN = 32;

function shouldRetryStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sign(
  method: string,
  path: string,
  query: string,
  body: string,
  secret: string,
  timestamp: string,
): string {
  const bodyHash = crypto
    .createHash("sha512")
    .update(body)
    .digest("hex");
  const signStr = `${method}\n${path}\n${query}\n${bodyHash}\n${timestamp}`;
  return crypto
    .createHmac("sha512", secret)
    .update(signStr)
    .digest("hex");
}

async function gateRequest(
  method: string,
  endpoint: string,
  creds: DecryptedCreds,
  body?: unknown,
  query: string = "",
): Promise<unknown> {
  const path = API_PREFIX + endpoint;
  const bodyStr = body ? JSON.stringify(body) : "";
  const url = BASE_URL + path + (query ? `?${query}` : "");

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = sign(
      method,
      path,
      query,
      bodyStr,
      creds.api_secret,
      timestamp,
    );

    try {
      const resp = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          KEY: creds.api_key,
          SIGN: signature,
          Timestamp: timestamp,
        },
        body: bodyStr || undefined,
        signal: controller.signal,
      });

      const text = await resp.text();
      const data = text ? (JSON.parse(text) as unknown) : {};

      if (!resp.ok) {
        const msg = (data as { message?: string }).message ?? resp.statusText;
        if (attempt < MAX_RETRIES && shouldRetryStatus(resp.status)) {
          await sleep(300 * (attempt + 1));
          continue;
        }
        throw new Error(`Gate API error ${resp.status}: ${msg}`);
      }
      return data;
    } catch (e: unknown) {
      const isAbort = e instanceof Error && e.name === "AbortError";
      if (attempt < MAX_RETRIES && isAbort) {
        await sleep(300 * (attempt + 1));
        continue;
      }
      if (attempt < MAX_RETRIES && e instanceof TypeError) {
        await sleep(300 * (attempt + 1));
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error("Gate API request failed");
}

export class GateAdapter implements ExchangeAdapter {
  async validateRequest(req: WithdrawRequest): Promise<void> {
    if (!req.asset || !req.network || !req.address || !req.amount) {
      throw new Error("Missing required fields: asset, network, address, amount");
    }
    if (isNaN(Number(req.amount)) || Number(req.amount) <= 0) {
      throw new Error("Invalid amount");
    }
  }

  async withdraw(
    req: WithdrawRequest,
    creds: DecryptedCreds,
  ): Promise<WithdrawResponse> {
    const payload: Record<string, string> = {
      currency: req.asset,
      chain: req.network,
      address: req.address,
      amount: req.amount,
    };
    if (req.address_tag) payload.memo = req.address_tag;
    if (req.client_withdraw_id) {
      payload.withdraw_order_id = normalizeGateWithdrawOrderId(req.client_withdraw_id);
    }

    const raw = await gateRequest("POST", "/withdrawals", creds, payload);
    const data = raw as { id?: string; status?: string };
    return {
      ok: true,
      withdraw_id: String(data.id ?? ""),
      status: data.status ?? "pending",
      message: "created",
      raw,
    };
  }

  async queryStatus(
    id: string,
    creds: DecryptedCreds,
  ): Promise<WithdrawResponse> {
    const raw = await gateRequest(
      "GET",
      `/withdrawals/${encodeURIComponent(id)}`,
      creds,
    );
    const data = raw as { id?: string; status?: string };
    return {
      ok: true,
      withdraw_id: String(data.id ?? id),
      status: data.status ?? "unknown",
      message: "queried",
      raw,
    };
  }

  async listCurrencies(creds: DecryptedCreds): Promise<CurrencyInfo[]> {
    const raw = await gateRequest(
      "GET",
      "/wallet/withdraw_status",
      creds,
    );
    const items = raw as Array<{
      currency?: string;
      name_en?: string;
      withdraw_fix_on_chains?: Record<string, string>;
    }>;
    return items
      .filter((c) => c.currency && c.withdraw_fix_on_chains && Object.keys(c.withdraw_fix_on_chains).length > 0)
      .map((c) => ({
        currency: c.currency!,
        name_en: c.name_en ?? "",
        withdraw_disabled: false,
      }));
  }

  async listChains(
    currency: string,
    creds: DecryptedCreds,
  ): Promise<ChainInfo[]> {
    const raw = await gateRequest(
      "GET",
      "/wallet/currency_chains",
      creds,
      undefined,
      `currency=${encodeURIComponent(currency)}`,
    );
    const items = raw as Array<{
      chain?: string;
      name_en?: string;
      is_withdraw_disabled?: number;
      is_deposit_disabled?: number;
      withdraw_fix?: string;
      withdraw_percent?: string;
      withdraw_amount_mini?: string;
      withdraw_eachtime_limit?: string;
      withdraw_day_limit?: string;
      decimal?: string;
    }>;
    return items.map((c) => ({
      chain: c.chain ?? "",
      name_en: c.name_en ?? "",
      is_withdraw_disabled: c.is_withdraw_disabled === 1,
      is_deposit_disabled: c.is_deposit_disabled === 1,
      withdraw_fix: c.withdraw_fix ?? "0",
      withdraw_percent: c.withdraw_percent ?? "0",
      withdraw_amount_mini: c.withdraw_amount_mini ?? "0",
      withdraw_eachtime_limit: c.withdraw_eachtime_limit ?? "0",
      withdraw_day_limit: c.withdraw_day_limit ?? "0",
      decimal: Number(c.decimal ?? 8),
    }));
  }

  async getBalance(currency: string, creds: DecryptedCreds): Promise<AssetBalance> {
    const raw = await gateRequest(
      "GET",
      "/spot/accounts",
      creds,
      undefined,
      `currency=${encodeURIComponent(currency)}`,
    );
    const list = raw as Array<{
      currency?: string;
      available?: string;
      locked?: string;
    }>;
    const row = list.find((x) => (x.currency ?? "").toUpperCase() === currency.toUpperCase());
    const available = row?.available ?? "0";
    const locked = row?.locked ?? "0";
    const total = (Number(available) + Number(locked)).toString();
    return {
      currency: currency.toUpperCase(),
      available,
      locked,
      total,
    };
  }
}

function normalizeGateWithdrawOrderId(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "");
  if (cleaned.length > 0 && cleaned.length <= GATE_WITHDRAW_ORDER_ID_MAX_LEN) {
    return cleaned;
  }
  return crypto
    .createHash("sha256")
    .update(raw)
    .digest("hex")
    .slice(0, GATE_WITHDRAW_ORDER_ID_MAX_LEN);
}
