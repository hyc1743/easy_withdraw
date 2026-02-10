import crypto from "node:crypto";
import type {
  ExchangeAdapter,
  WithdrawRequest,
  WithdrawResponse,
  DecryptedCreds,
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
}
