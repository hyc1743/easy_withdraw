import crypto from "node:crypto";
import type {
  AssetBalance,
  ChainInfo,
  CurrencyInfo,
  DecryptedCreds,
  ExchangeAdapter,
  MarketSellOrderResult,
  SpotSymbolInfo,
  WithdrawRequest,
  WithdrawResponse,
} from "./types.js";

const BASE_URL = "https://api.mexc.com";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2;
const RECV_WINDOW = "5000";
const MEXC_WITHDRAW_ORDER_ID_MAX_LEN = 32;

type MexcCapitalConfigRow = {
  coin?: string;
  name?: string;
  networkList?: Array<{
    coin?: string;
    netWork?: string;
    network?: string;
    name?: string;
    withdrawEnable?: boolean;
    depositEnable?: boolean;
    withdrawFee?: string;
    withdrawMin?: string;
    withdrawIntegerMultiple?: string;
    withdrawMax?: string;
  }>;
};

type MexcExchangeSymbolRow = {
  symbol?: string;
  status?: string;
  permissions?: string[];
  isSpotTradingAllowed?: boolean;
  baseAsset?: string;
  quoteAsset?: string;
  baseSizePrecision?: string;
  quoteAmountPrecision?: string;
  quoteAmountPrecisionMarket?: string;
};

type MexcOrderResponse = {
  orderId?: string | number;
  symbol?: string;
  status?: string;
  executedQty?: string;
  cummulativeQuoteQty?: string;
};

function shouldRetryStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hmacSha256Hex(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

function toQuery(params: Record<string, string | undefined>): string {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      usp.set(key, value);
    }
  }
  return usp.toString();
}

function parseDecimalPlaces(step: string | undefined): number {
  if (!step || !step.includes(".")) return 0;
  return Math.max(0, step.split(".")[1]?.replace(/0+$/, "").length ?? 0);
}

function normalizeMexcWithdrawOrderId(raw?: string): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/[^0-9A-Za-z_-]/g, "");
  if (cleaned.length > 0 && cleaned.length <= MEXC_WITHDRAW_ORDER_ID_MAX_LEN) {
    return cleaned;
  }

  return `wd_${crypto.createHash("sha256").update(raw).digest("hex").slice(0, MEXC_WITHDRAW_ORDER_ID_MAX_LEN - 3)}`;
}

function normalizeMexcSpotStatus(row: MexcExchangeSymbolRow): string {
  const normalizedStatus = String(row.status ?? "").toLowerCase();
  const isTradingStatus =
    normalizedStatus === "1" ||
    normalizedStatus === "enabled" ||
    normalizedStatus === "trading";
  const hasSpotPermission =
    row.isSpotTradingAllowed === true ||
    (row.permissions ?? []).some((permission) => permission.toUpperCase() === "SPOT");

  return isTradingStatus || hasSpotPermission
    ? "TRADING"
    : String(row.status ?? "UNKNOWN").toUpperCase();
}

export function buildMexcSpotSymbolInfo(row: MexcExchangeSymbolRow): SpotSymbolInfo {
  return {
    symbol: row.symbol ?? "",
    status: normalizeMexcSpotStatus(row),
    base_asset: row.baseAsset ?? "",
    quote_asset: row.quoteAsset ?? "",
    min_qty: row.baseSizePrecision ?? "0",
    step_size: row.baseSizePrecision ?? "0.00000001",
    min_quote_amount: row.quoteAmountPrecisionMarket ?? row.quoteAmountPrecision ?? "0",
    last_price: undefined,
  };
}

function unwrapMexcArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === "object") {
    const obj = raw as {
      data?: unknown;
      rows?: unknown;
      list?: unknown;
    };
    if (Array.isArray(obj.data)) return obj.data as T[];
    if (Array.isArray(obj.rows)) return obj.rows as T[];
    if (Array.isArray(obj.list)) return obj.list as T[];
  }
  return [];
}

function unwrapMexcStringArray(raw: unknown): string[] {
  return unwrapMexcArray<string>(raw)
    .map((value) => String(value ?? "").toUpperCase())
    .filter(Boolean);
}

async function mexcSignedRequest(
  method: string,
  endpoint: string,
  creds: DecryptedCreds,
  params: Record<string, string | undefined> = {},
): Promise<unknown> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const baseQuery = toQuery({
      ...params,
      recvWindow: RECV_WINDOW,
      timestamp: Date.now().toString(),
    });
    const signature = hmacSha256Hex(baseQuery, creds.api_secret);
    const payload = `${baseQuery}&signature=${signature}`;
    const url = `${BASE_URL}${endpoint}?${payload}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const resp = await fetch(url, {
        method,
        headers: {
          "X-MEXC-APIKEY": creds.api_key,
        },
        signal: controller.signal,
      });

      const text = await resp.text();
      const data = text ? (JSON.parse(text) as unknown) : {};

      if (!resp.ok) {
        const msg =
          (data as { msg?: string; message?: string }).msg ??
          (data as { msg?: string; message?: string }).message ??
          resp.statusText;
        if (attempt < MAX_RETRIES && shouldRetryStatus(resp.status)) {
          await sleep(300 * (attempt + 1));
          continue;
        }
        throw new Error(`MEXC API error ${resp.status}: ${msg}`);
      }

      return data;
    } catch (error: unknown) {
      const isAbort = error instanceof Error && error.name === "AbortError";
      if (attempt < MAX_RETRIES && (isAbort || error instanceof TypeError)) {
        await sleep(300 * (attempt + 1));
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error("MEXC API request failed");
}

async function mexcPublicRequest(
  endpoint: string,
  params: Record<string, string | undefined> = {},
): Promise<unknown> {
  const query = toQuery(params);
  const url = query ? `${BASE_URL}${endpoint}?${query}` : `${BASE_URL}${endpoint}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const resp = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });
    const text = await resp.text();
    const data = text ? (JSON.parse(text) as unknown) : {};
    if (!resp.ok) {
      const msg =
        (data as { msg?: string; message?: string }).msg ??
        (data as { msg?: string; message?: string }).message ??
        resp.statusText;
      throw new Error(`MEXC API error ${resp.status}: ${msg}`);
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function getCapitalConfig(creds: DecryptedCreds): Promise<MexcCapitalConfigRow[]> {
  const raw = await mexcSignedRequest("GET", "/api/v3/capital/config/getall", creds);
  return unwrapMexcArray<MexcCapitalConfigRow>(raw);
}

async function getSelfSymbols(creds: DecryptedCreds): Promise<string[]> {
  const raw = await mexcSignedRequest("GET", "/api/v3/selfSymbols", creds);
  return unwrapMexcStringArray(raw);
}

async function getOrder(
  symbol: string,
  orderId: string,
  creds: DecryptedCreds,
): Promise<MexcOrderResponse> {
  const raw = await mexcSignedRequest("GET", "/api/v3/order", creds, {
    symbol: symbol.toUpperCase(),
    orderId,
  });
  return raw as MexcOrderResponse;
}

export class MexcAdapter implements ExchangeAdapter {
  async validateRequest(req: WithdrawRequest): Promise<void> {
    if (!req.asset || !req.network || !req.address || !req.amount) {
      throw new Error("Missing required fields: asset, network, address, amount");
    }
    if (Number.isNaN(Number(req.amount)) || Number(req.amount) <= 0) {
      throw new Error("Invalid amount");
    }
  }

  async withdraw(req: WithdrawRequest, creds: DecryptedCreds): Promise<WithdrawResponse> {
    const raw = await mexcSignedRequest("POST", "/api/v3/capital/withdraw", creds, {
      coin: req.asset.toUpperCase(),
      netWork: req.network,
      address: req.address,
      memo: req.address_tag ?? undefined,
      amount: req.amount,
      withdrawOrderId: normalizeMexcWithdrawOrderId(req.client_withdraw_id),
    });

    const data = raw as { id?: string };
    return {
      ok: true,
      withdraw_id: String(data.id ?? ""),
      status: "submitted",
      message: "created",
      raw,
    };
  }

  async queryStatus(id: string, creds: DecryptedCreds): Promise<WithdrawResponse> {
    const raw = await mexcSignedRequest("GET", "/api/v3/capital/withdraw/history", creds, {
      withdrawOrderId: id,
    });
    const rows = unwrapMexcArray<{
      id?: string;
      withdrawOrderId?: string;
      status?: string | number;
      msg?: string;
    }>(raw);
    const row = rows.find((entry) => entry.id === id || entry.withdrawOrderId === id);

    return {
      ok: true,
      withdraw_id: String(row?.id ?? row?.withdrawOrderId ?? id),
      status: String(row?.status ?? "unknown"),
      message: row?.msg ?? "queried",
      raw,
    };
  }

  async listCurrencies(creds: DecryptedCreds): Promise<CurrencyInfo[]> {
    const rows = await getCapitalConfig(creds);
    return rows
      .filter((row) => row.coin)
      .map((row) => ({
        currency: row.coin!,
        name_en: row.name ?? "",
        withdraw_disabled: !(row.networkList ?? []).some((chain) => chain.withdrawEnable),
      }));
  }

  async listChains(currency: string, creds: DecryptedCreds): Promise<ChainInfo[]> {
    const rows = await getCapitalConfig(creds);
    const row = rows.find((entry) => (entry.coin ?? "").toUpperCase() === currency.toUpperCase());
    const chains = row?.networkList ?? [];

    return chains.map((chain) => {
      const step = chain.withdrawIntegerMultiple ?? "0.00000001";
      return {
        chain: chain.netWork ?? chain.network ?? "",
        name_en: chain.name ?? chain.netWork ?? chain.network ?? "",
        is_withdraw_disabled: !chain.withdrawEnable,
        is_deposit_disabled: !chain.depositEnable,
        withdraw_fix: chain.withdrawFee ?? "0",
        withdraw_percent: "0",
        withdraw_amount_mini: chain.withdrawMin ?? "0",
        withdraw_eachtime_limit: chain.withdrawMax ?? "0",
        withdraw_day_limit: "0",
        decimal: parseDecimalPlaces(step),
      };
    });
  }

  async getBalance(currency: string, creds: DecryptedCreds): Promise<AssetBalance> {
    const raw = await mexcSignedRequest("GET", "/api/v3/account", creds);
    const balances = (raw as {
      balances?: Array<{ asset?: string; free?: string; locked?: string }>;
    }).balances ?? [];
    const row = balances.find((entry) => (entry.asset ?? "").toUpperCase() === currency.toUpperCase());
    const available = row?.free ?? "0";
    const locked = row?.locked ?? "0";

    return {
      currency: currency.toUpperCase(),
      available,
      locked,
      total: (Number(available) + Number(locked)).toString(),
    };
  }

  async listSpotSymbols(creds: DecryptedCreds): Promise<SpotSymbolInfo[]> {
    const allowedSymbols = new Set(await getSelfSymbols(creds));
    const raw = await mexcPublicRequest("/api/v3/exchangeInfo");
    const symbols = (raw as { symbols?: MexcExchangeSymbolRow[] }).symbols ?? [];

    return symbols
      .filter((row) =>
        row.symbol &&
        row.baseAsset &&
        row.quoteAsset &&
        allowedSymbols.has(String(row.symbol).toUpperCase()),
      )
      .map((row) => buildMexcSpotSymbolInfo(row));
  }

  async getSpotSymbol(symbol: string, _creds: DecryptedCreds): Promise<SpotSymbolInfo | null> {
    const raw = await mexcPublicRequest("/api/v3/exchangeInfo", {
      symbol: symbol.toUpperCase(),
    });
    const symbols = (raw as { symbols?: MexcExchangeSymbolRow[] }).symbols ?? [];
    const first = symbols[0];
    return first ? buildMexcSpotSymbolInfo(first) : null;
  }

  async getSpotBalance(currency: string, creds: DecryptedCreds): Promise<AssetBalance> {
    return this.getBalance(currency, creds);
  }

  async placeMarketSellOrder(
    symbol: string,
    quantity: string,
    creds: DecryptedCreds,
  ): Promise<MarketSellOrderResult> {
    const submitRaw = await mexcSignedRequest("POST", "/api/v3/order", creds, {
      symbol: symbol.toUpperCase(),
      side: "SELL",
      type: "MARKET",
      quantity,
    });

    const submitted = submitRaw as MexcOrderResponse;
    const shouldQueryOrder =
      submitted.orderId !== undefined &&
      (submitted.executedQty === undefined || submitted.cummulativeQuoteQty === undefined);
    const order = shouldQueryOrder
      ? await getOrder(symbol, String(submitted.orderId), creds)
      : submitted;
    const executedQty = order.executedQty ?? "0";
    const quoteQty = order.cummulativeQuoteQty ?? "0";
    const avgPrice =
      Number(executedQty) > 0
        ? (Number(quoteQty) / Number(executedQty)).toString()
        : "0";

    return {
      order_id: String(order.orderId ?? ""),
      symbol: order.symbol ?? symbol.toUpperCase(),
      status: order.status ?? "UNKNOWN",
      executed_qty: executedQty,
      quote_qty: quoteQty,
      avg_price: avgPrice,
      raw: shouldQueryOrder ? { submit: submitRaw, order } : submitRaw,
    };
  }
}
