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

const BASE_URL = "https://api.binance.com";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2;
const RECV_WINDOW = "5000";

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
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") {
      usp.set(k, v);
    }
  }
  return usp.toString();
}

async function binanceSignedRequest(
  method: string,
  endpoint: string,
  creds: DecryptedCreds,
  params: Record<string, string | undefined> = {},
): Promise<unknown> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const timestamp = Date.now().toString();
    const baseQuery = toQuery({ ...params, recvWindow: RECV_WINDOW, timestamp });
    const signature = hmacSha256Hex(baseQuery, creds.api_secret);
    const query = `${baseQuery}&signature=${signature}`;
    const isGetLike = method === "GET" || method === "DELETE";
    const url = isGetLike
      ? `${BASE_URL}${endpoint}?${query}`
      : `${BASE_URL}${endpoint}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const resp = await fetch(url, {
        method,
        headers: {
          "X-MBX-APIKEY": creds.api_key,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: isGetLike ? undefined : query,
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
        throw new Error(`Binance API error ${resp.status}: ${msg}`);
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

  throw new Error("Binance API request failed");
}

async function binancePublicRequest(
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
      const msg = (data as { msg?: string }).msg ?? resp.statusText;
      throw new Error(`Binance API error ${resp.status}: ${msg}`);
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeSpotSymbolInfo(raw: {
  symbol?: string;
  status?: string;
  baseAsset?: string;
  quoteAsset?: string;
  filters?: Array<{
    filterType?: string;
    minQty?: string;
    stepSize?: string;
  }>;
}): SpotSymbolInfo {
  const lotSize =
    raw.filters?.find((filter) => filter.filterType === "MARKET_LOT_SIZE") ??
    raw.filters?.find((filter) => filter.filterType === "LOT_SIZE");

  return {
    symbol: raw.symbol ?? "",
    status: raw.status ?? "UNKNOWN",
    base_asset: raw.baseAsset ?? "",
    quote_asset: raw.quoteAsset ?? "",
    min_qty: lotSize?.minQty ?? "0",
    step_size: lotSize?.stepSize ?? "0.00000001",
  };
}

export class BinanceAdapter implements ExchangeAdapter {
  async validateRequest(req: WithdrawRequest): Promise<void> {
    if (!req.asset || !req.network || !req.address || !req.amount) {
      throw new Error("Missing required fields: asset, network, address, amount");
    }
    if (Number.isNaN(Number(req.amount)) || Number(req.amount) <= 0) {
      throw new Error("Invalid amount");
    }
  }

  async withdraw(req: WithdrawRequest, creds: DecryptedCreds): Promise<WithdrawResponse> {
    const raw = await binanceSignedRequest("POST", "/sapi/v1/capital/withdraw/apply", creds, {
      coin: req.asset,
      network: req.network,
      address: req.address,
      addressTag: req.address_tag ?? undefined,
      amount: req.amount,
      withdrawOrderId: req.client_withdraw_id,
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
    const raw = await binanceSignedRequest("GET", "/sapi/v1/capital/withdraw/history", creds, {
      idList: id,
    });

    const list = raw as Array<{ id?: string; status?: number; info?: string }>;
    const row = list[0];
    return {
      ok: true,
      withdraw_id: String(row?.id ?? id),
      status: String(row?.status ?? "unknown"),
      message: row?.info ?? "queried",
      raw,
    };
  }

  async listCurrencies(creds: DecryptedCreds): Promise<CurrencyInfo[]> {
    const raw = await binanceSignedRequest("GET", "/sapi/v1/capital/config/getall", creds);
    const list = raw as Array<{
      coin?: string;
      name?: string;
      withdrawAllEnable?: boolean;
      networkList?: Array<{ withdrawEnable?: boolean }>;
    }>;

    return list
      .filter((c) => c.coin && (c.networkList ?? []).length > 0)
      .map((c) => ({
        currency: c.coin!,
        name_en: c.name ?? "",
        withdraw_disabled: !(c.withdrawAllEnable ?? false),
      }));
  }

  async listChains(currency: string, creds: DecryptedCreds): Promise<ChainInfo[]> {
    const raw = await binanceSignedRequest("GET", "/sapi/v1/capital/config/getall", creds);
    const list = raw as Array<{
      coin?: string;
      networkList?: Array<{
        network?: string;
        name?: string;
        withdrawEnable?: boolean;
        depositEnable?: boolean;
        withdrawFee?: string;
        withdrawMin?: string;
        withdrawMax?: string;
        withdrawIntegerMultiple?: string;
      }>;
    }>;

    const coin = list.find((c) => (c.coin ?? "").toUpperCase() === currency.toUpperCase());
    const chains = coin?.networkList ?? [];

    return chains.map((c) => {
      const step = c.withdrawIntegerMultiple ?? "0.00000001";
      const decimals = step.includes(".")
        ? Math.max(0, step.split(".")[1].replace(/0+$/, "").length)
        : 0;

      return {
        chain: c.network ?? "",
        name_en: c.name ?? "",
        is_withdraw_disabled: !(c.withdrawEnable ?? false),
        is_deposit_disabled: !(c.depositEnable ?? false),
        withdraw_fix: c.withdrawFee ?? "0",
        withdraw_percent: "0",
        withdraw_amount_mini: c.withdrawMin ?? "0",
        withdraw_eachtime_limit: c.withdrawMax ?? "0",
        withdraw_day_limit: "0",
        decimal: decimals || 8,
      };
    });
  }

  async getBalance(currency: string, creds: DecryptedCreds): Promise<AssetBalance> {
    const raw = await binanceSignedRequest("GET", "/sapi/v1/capital/config/getall", creds);
    const list = raw as Array<{
      coin?: string;
      free?: string;
      locked?: string;
    }>;

    const row = list.find((c) => (c.coin ?? "").toUpperCase() === currency.toUpperCase());
    const available = row?.free ?? "0";
    const locked = row?.locked ?? "0";

    return {
      currency: currency.toUpperCase(),
      available,
      locked,
      total: (Number(available) + Number(locked)).toString(),
    };
  }

  async listSpotSymbols(_creds: DecryptedCreds): Promise<SpotSymbolInfo[]> {
    const raw = await binancePublicRequest("/api/v3/exchangeInfo");
    const symbols = (raw as { symbols?: Array<{
      symbol?: string;
      status?: string;
      baseAsset?: string;
      quoteAsset?: string;
      filters?: Array<{
        filterType?: string;
        minQty?: string;
        stepSize?: string;
      }>;
    }> }).symbols ?? [];

    return symbols
      .filter((symbol) => symbol.symbol && symbol.baseAsset && symbol.quoteAsset)
      .map((symbol) => normalizeSpotSymbolInfo(symbol));
  }

  async getSpotSymbol(
    symbol: string,
    _creds: DecryptedCreds,
  ): Promise<SpotSymbolInfo | null> {
    const raw = await binancePublicRequest("/api/v3/exchangeInfo", {
      symbol: symbol.toUpperCase(),
    });
    const symbols = (raw as { symbols?: Array<{
      symbol?: string;
      status?: string;
      baseAsset?: string;
      quoteAsset?: string;
      filters?: Array<{
        filterType?: string;
        minQty?: string;
        stepSize?: string;
      }>;
    }> }).symbols ?? [];
    const first = symbols[0];
    return first ? normalizeSpotSymbolInfo(first) : null;
  }

  async placeMarketSellOrder(
    symbol: string,
    quantity: string,
    creds: DecryptedCreds,
  ): Promise<MarketSellOrderResult> {
    const raw = await binanceSignedRequest("POST", "/api/v3/order", creds, {
      symbol: symbol.toUpperCase(),
      side: "SELL",
      type: "MARKET",
      quantity,
    });

    const order = raw as {
      orderId?: number;
      symbol?: string;
      status?: string;
      executedQty?: string;
      cummulativeQuoteQty?: string;
    };
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
      raw,
    };
  }
}
