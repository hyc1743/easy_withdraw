import crypto from "node:crypto";
import type {
  AssetBalance,
  ChainInfo,
  CurrencyInfo,
  DecryptedCreds,
  ExchangeAdapter,
  WithdrawRequest,
  WithdrawResponse,
} from "./types.js";

const BASE_URL = "https://www.okx.com";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2;

function shouldRetryStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function b64HmacSha256(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64");
}

async function okxRequest(
  method: string,
  endpoint: string,
  creds: DecryptedCreds,
  body?: unknown,
  query?: string,
): Promise<unknown> {
  if (!creds.passphrase) {
    throw new Error("OKX requires passphrase");
  }

  const path = endpoint + (query ? `?${query}` : "");
  const url = `${BASE_URL}${path}`;
  const bodyStr = body ? JSON.stringify(body) : "";

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const timestamp = new Date().toISOString();
    const signPayload = `${timestamp}${method}${path}${bodyStr}`;
    const signature = b64HmacSha256(signPayload, creds.api_secret);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const resp = await fetch(url, {
        method,
        headers: {
          "OK-ACCESS-KEY": creds.api_key,
          "OK-ACCESS-SIGN": signature,
          "OK-ACCESS-TIMESTAMP": timestamp,
          "OK-ACCESS-PASSPHRASE": creds.passphrase,
          "Content-Type": "application/json",
        },
        body: bodyStr || undefined,
        signal: controller.signal,
      });

      const text = await resp.text();
      const data = text ? (JSON.parse(text) as unknown) : {};

      if (!resp.ok) {
        const msg = (data as { msg?: string }).msg ?? resp.statusText;
        if (attempt < MAX_RETRIES && shouldRetryStatus(resp.status)) {
          await sleep(300 * (attempt + 1));
          continue;
        }
        throw new Error(`OKX API error ${resp.status}: ${msg}`);
      }

      const wrapped = data as { code?: string; msg?: string };
      if (wrapped.code && wrapped.code !== "0") {
        throw new Error(`OKX API error ${wrapped.code}: ${wrapped.msg ?? "unknown"}`);
      }

      return data;
    } catch (e: unknown) {
      const isAbort = e instanceof Error && e.name === "AbortError";
      if (attempt < MAX_RETRIES && (isAbort || e instanceof TypeError)) {
        await sleep(300 * (attempt + 1));
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error("OKX API request failed");
}

function parseDecimalPlaces(num: string): number {
  if (!num.includes(".")) return 0;
  return Math.max(0, num.split(".")[1].replace(/0+$/, "").length);
}

export class OkxAdapter implements ExchangeAdapter {
  async validateRequest(req: WithdrawRequest): Promise<void> {
    if (!req.asset || !req.network || !req.address || !req.amount) {
      throw new Error("Missing required fields: asset, network, address, amount");
    }
    if (Number.isNaN(Number(req.amount)) || Number(req.amount) <= 0) {
      throw new Error("Invalid amount");
    }
  }

  async withdraw(req: WithdrawRequest, creds: DecryptedCreds): Promise<WithdrawResponse> {
    const chainsRaw = await this.listChains(req.asset, creds);
    const selected = chainsRaw.find((c) => c.chain === req.network);
    const fee = selected?.withdraw_fix ?? "0";

    const raw = await okxRequest("POST", "/api/v5/asset/withdrawal", creds, {
      ccy: req.asset,
      amt: req.amount,
      dest: "4",
      toAddr: req.address,
      chain: req.network,
      fee,
      clientId: req.client_withdraw_id,
    });

    const data = raw as { data?: Array<{ wdId?: string }> };
    const wdId = data.data?.[0]?.wdId ?? "";
    return {
      ok: true,
      withdraw_id: wdId,
      status: "submitted",
      message: "created",
      raw,
    };
  }

  async queryStatus(id: string, creds: DecryptedCreds): Promise<WithdrawResponse> {
    const query = `wdId=${encodeURIComponent(id)}`;
    const raw = await okxRequest("GET", "/api/v5/asset/withdrawal-history", creds, undefined, query);
    const data = raw as { data?: Array<{ wdId?: string; state?: string }> };
    const row = data.data?.[0];

    return {
      ok: true,
      withdraw_id: row?.wdId ?? id,
      status: row?.state ?? "unknown",
      message: "queried",
      raw,
    };
  }

  async listCurrencies(creds: DecryptedCreds): Promise<CurrencyInfo[]> {
    const raw = await okxRequest("GET", "/api/v5/asset/currencies", creds);
    const rows = (raw as { data?: Array<{ ccy?: string; canWd?: boolean }> }).data ?? [];

    const grouped = new Map<string, boolean>();
    for (const row of rows) {
      const ccy = row.ccy;
      if (!ccy) continue;
      const canWd = row.canWd ?? false;
      const prev = grouped.get(ccy) ?? false;
      grouped.set(ccy, prev || canWd);
    }

    return [...grouped.entries()].map(([currency, canWd]) => ({
      currency,
      name_en: currency,
      withdraw_disabled: !canWd,
    }));
  }

  async listChains(currency: string, creds: DecryptedCreds): Promise<ChainInfo[]> {
    const query = `ccy=${encodeURIComponent(currency)}`;
    const raw = await okxRequest("GET", "/api/v5/asset/currencies", creds, undefined, query);
    const rows = (raw as {
      data?: Array<{
        chain?: string;
        ccy?: string;
        canWd?: boolean;
        canDep?: boolean;
        fee?: string;
        minFee?: string;
        minWd?: string;
        maxWd?: string;
        wdTickSz?: string;
      }>;
    }).data ?? [];

    return rows
      .filter((row) => (row.ccy ?? "").toUpperCase() === currency.toUpperCase())
      .map((row) => {
        const tick = row.wdTickSz ?? "0.00000001";
        return {
          chain: row.chain ?? "",
          name_en: row.chain ?? "",
          is_withdraw_disabled: !(row.canWd ?? false),
          is_deposit_disabled: !(row.canDep ?? false),
          withdraw_fix: row.minFee ?? row.fee ?? "0",
          withdraw_percent: "0",
          withdraw_amount_mini: row.minWd ?? "0",
          withdraw_eachtime_limit: row.maxWd ?? "0",
          withdraw_day_limit: "0",
          decimal: parseDecimalPlaces(tick) || 8,
        };
      });
  }

  async getBalance(currency: string, creds: DecryptedCreds): Promise<AssetBalance> {
    const query = `ccy=${encodeURIComponent(currency)}`;
    const raw = await okxRequest("GET", "/api/v5/asset/balances", creds, undefined, query);
    const rows = (raw as {
      data?: Array<{
        ccy?: string;
        availBal?: string;
        bal?: string;
        frozenBal?: string;
      }>;
    }).data ?? [];

    const row = rows.find((r) => (r.ccy ?? "").toUpperCase() === currency.toUpperCase());
    const available = row?.availBal ?? "0";
    const total = row?.bal ?? "0";
    const locked = row?.frozenBal ?? (Number(total) - Number(available)).toString();

    return {
      currency: currency.toUpperCase(),
      available,
      locked,
      total,
    };
  }
}
