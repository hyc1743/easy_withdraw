import crypto from "node:crypto";
import type {
  ExchangeAdapter,
  WithdrawRequest,
  WithdrawResponse,
  DecryptedCreds,
  CurrencyInfo,
  ChainInfo,
} from "./types.js";

const BASE_URL = "https://api.gateio.ws";
const API_PREFIX = "/api/v4";

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
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = sign(method, path, query, bodyStr, creds.api_secret, timestamp);

  const url = BASE_URL + path + (query ? `?${query}` : "");
  const resp = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      KEY: creds.api_key,
      SIGN: signature,
      Timestamp: timestamp,
    },
    body: bodyStr || undefined,
  });

  const data = await resp.json();
  if (!resp.ok) {
    const msg = (data as { message?: string }).message ?? resp.statusText;
    throw new Error(`Gate API error ${resp.status}: ${msg}`);
  }
  return data;
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
    if (req.client_withdraw_id) payload.withdraw_order_id = req.client_withdraw_id;

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
}
