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

const BASE_URL = "https://api.bybit.com";
const RECV_WINDOW = "5000";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2;

function shouldRetryStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hmacHex(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

async function bybitRequest(
  method: string,
  endpoint: string,
  creds: DecryptedCreds,
  body?: Record<string, unknown>,
  query?: string,
): Promise<unknown> {
  const path = endpoint + (query ? `?${query}` : "");
  const url = `${BASE_URL}${path}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const timestamp = Date.now().toString();
    const bodyStr = body ? JSON.stringify(body) : "";
    const signPayload = `${timestamp}${creds.api_key}${RECV_WINDOW}${query ?? bodyStr}`;
    const sign = hmacHex(signPayload, creds.api_secret);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const resp = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-BAPI-API-KEY": creds.api_key,
          "X-BAPI-SIGN": sign,
          "X-BAPI-SIGN-TYPE": "2",
          "X-BAPI-TIMESTAMP": timestamp,
          "X-BAPI-RECV-WINDOW": RECV_WINDOW,
        },
        body: method === "GET" ? undefined : bodyStr || undefined,
        signal: controller.signal,
      });

      const text = await resp.text();
      const data = text ? (JSON.parse(text) as unknown) : {};

      if (!resp.ok) {
        const msg = (data as { retMsg?: string }).retMsg ?? resp.statusText;
        if (attempt < MAX_RETRIES && shouldRetryStatus(resp.status)) {
          await sleep(300 * (attempt + 1));
          continue;
        }
        throw new Error(`Bybit API error ${resp.status}: ${msg}`);
      }

      const wrapped = data as { retCode?: number; retMsg?: string };
      if ((wrapped.retCode ?? 0) !== 0) {
        throw new Error(`Bybit API error ${wrapped.retCode}: ${wrapped.retMsg ?? "unknown"}`);
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

  throw new Error("Bybit API request failed");
}

export class BybitAdapter implements ExchangeAdapter {
  async validateRequest(req: WithdrawRequest): Promise<void> {
    if (!req.asset || !req.network || !req.address || !req.amount) {
      throw new Error("Missing required fields: asset, network, address, amount");
    }
    if (Number.isNaN(Number(req.amount)) || Number(req.amount) <= 0) {
      throw new Error("Invalid amount");
    }
  }

  async withdraw(req: WithdrawRequest, creds: DecryptedCreds): Promise<WithdrawResponse> {
    const raw = await bybitRequest("POST", "/v5/asset/withdraw/create", creds, {
      coin: req.asset,
      chain: req.network,
      address: req.address,
      tag: req.address_tag ?? undefined,
      amount: req.amount,
      accountType: "FUND",
      forceChain: 1,
      requestId: req.client_withdraw_id,
      timestamp: Date.now(),
    });

    const data = raw as { result?: { id?: string } };
    return {
      ok: true,
      withdraw_id: data.result?.id ?? "",
      status: "submitted",
      message: "created",
      raw,
    };
  }

  async queryStatus(id: string, creds: DecryptedCreds): Promise<WithdrawResponse> {
    const query = `withdrawID=${encodeURIComponent(id)}`;
    const raw = await bybitRequest("GET", "/v5/asset/withdraw/query-record", creds, undefined, query);

    const data = raw as { result?: { rows?: Array<{ withdrawID?: string; status?: string }> } };
    const row = data.result?.rows?.[0];

    return {
      ok: true,
      withdraw_id: row?.withdrawID ?? id,
      status: row?.status ?? "unknown",
      message: "queried",
      raw,
    };
  }

  async listCurrencies(creds: DecryptedCreds): Promise<CurrencyInfo[]> {
    const raw = await bybitRequest("GET", "/v5/asset/coin/query-info", creds);
    const rows = (raw as {
      result?: {
        rows?: Array<{
          coin?: string;
          name?: string;
          chains?: Array<{ chainWithdraw?: string }>;
        }>;
      };
    }).result?.rows ?? [];

    return rows
      .filter((r) => r.coin)
      .map((r) => ({
        currency: r.coin!,
        name_en: r.name ?? "",
        withdraw_disabled: !(r.chains ?? []).some((c) => c.chainWithdraw === "1"),
      }));
  }

  async listChains(currency: string, creds: DecryptedCreds): Promise<ChainInfo[]> {
    const query = `coin=${encodeURIComponent(currency)}`;
    const raw = await bybitRequest("GET", "/v5/asset/coin/query-info", creds, undefined, query);
    const rows = (raw as {
      result?: {
        rows?: Array<{
          coin?: string;
          chains?: Array<{
            chain?: string;
            chainType?: string;
            chainWithdraw?: string;
            chainDeposit?: string;
            withdrawFee?: string;
            withdrawPercentageFee?: string;
            withdrawMin?: string;
            minAccuracy?: string;
          }>;
        }>;
      };
    }).result?.rows ?? [];

    const row = rows.find((r) => (r.coin ?? "").toUpperCase() === currency.toUpperCase());
    const chains = row?.chains ?? [];

    return chains.map((c) => ({
      chain: c.chain ?? "",
      name_en: c.chainType ?? c.chain ?? "",
      is_withdraw_disabled: c.chainWithdraw !== "1",
      is_deposit_disabled: c.chainDeposit !== "1",
      withdraw_fix: c.withdrawFee ?? "0",
      withdraw_percent: c.withdrawPercentageFee ?? "0",
      withdraw_amount_mini: c.withdrawMin ?? "0",
      withdraw_eachtime_limit: "0",
      withdraw_day_limit: "0",
      decimal: Number(c.minAccuracy ?? "8"),
    }));
  }

  async getBalance(currency: string, creds: DecryptedCreds): Promise<AssetBalance> {
    const query = `accountType=FUND&coin=${encodeURIComponent(currency)}`;
    const raw = await bybitRequest(
      "GET",
      "/v5/asset/transfer/query-account-coin-balance",
      creds,
      undefined,
      query,
    );

    const balance = (raw as {
      result?: { balance?: { transferBalance?: string; walletBalance?: string } };
    }).result?.balance;

    const available = balance?.transferBalance ?? "0";
    const total = balance?.walletBalance ?? available;
    const locked = (Number(total) - Number(available)).toString();

    return {
      currency: currency.toUpperCase(),
      available,
      locked,
      total,
    };
  }
}
