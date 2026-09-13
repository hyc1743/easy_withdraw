import crypto from "node:crypto";
import {
  combineDecimalSteps,
  compareDecimalStrings,
  normalizeDecimalString,
} from "../decimal.js";
import type {
  AssetBalance,
  ChainInfo,
  CurrencyInfo,
  DecryptedCreds,
  ExchangeAdapter,
  MarketSellOrderResult,
  SpotTrade,
  SpotSymbolInfo,
  WithdrawRequest,
  WithdrawResponse,
} from "./types.js";

const BASE_URL = "https://api.binance.com";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2;
const RECV_WINDOW = "5000";
const BINANCE_TRADE_WINDOW_MS = 24 * 60 * 60 * 1000;
const BINANCE_TRADE_PAGE_SIZE = 1000;

class BinanceApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | undefined,
    message: string,
  ) {
    super(`Binance API error ${status}: ${message}`);
    this.name = "BinanceApiError";
  }
}

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
        const errorData = data as { code?: number; msg?: string };
        const msg = errorData.msg ?? resp.statusText;
        if (attempt < MAX_RETRIES && shouldRetryStatus(resp.status)) {
          await sleep(300 * (attempt + 1));
          continue;
        }
        throw new BinanceApiError(resp.status, errorData.code, msg);
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
      const errorData = data as { code?: number; msg?: string };
      const msg = errorData.msg ?? resp.statusText;
      throw new BinanceApiError(resp.status, errorData.code, msg);
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

interface BinanceSymbolFilter {
  filterType?: string;
  minQty?: string;
  maxQty?: string;
  stepSize?: string;
  minNotional?: string;
  applyToMarket?: boolean;
  applyMinToMarket?: boolean;
  avgPriceMins?: number;
}

interface BinanceSymbolRaw {
  symbol?: string;
  status?: string;
  baseAsset?: string;
  baseAssetPrecision?: number;
  quoteAsset?: string;
  quoteOrderQtyMarketAllowed?: boolean;
  filters?: BinanceSymbolFilter[];
}

interface NormalizedBinanceSpotSymbol extends SpotSymbolInfo {
  market_avg_price_mins: number;
}

function positiveDecimal(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const normalized = normalizeDecimalString(value);
    return compareDecimalStrings(normalized, "0") > 0 ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function maximumPositive(values: Array<string | undefined>): string | undefined {
  return values
    .map(positiveDecimal)
    .filter((value): value is string => Boolean(value))
    .reduce<string | undefined>((current, value) => (
      current === undefined || compareDecimalStrings(value, current) > 0 ? value : current
    ), undefined);
}

function minimumPositive(values: Array<string | undefined>): string | undefined {
  return values
    .map(positiveDecimal)
    .filter((value): value is string => Boolean(value))
    .reduce<string | undefined>((current, value) => (
      current === undefined || compareDecimalStrings(value, current) < 0 ? value : current
    ), undefined);
}

function precisionToStep(precision: number | undefined): string {
  if (!Number.isInteger(precision) || precision === undefined || precision <= 0) return "1";
  return `0.${"0".repeat(precision - 1)}1`;
}

function normalizeAvgPriceMins(value: number | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function normalizeSpotSymbolInfo(raw: BinanceSymbolRaw): NormalizedBinanceSpotSymbol {
  const lotSize = raw.filters?.find((filter) => filter.filterType === "LOT_SIZE");
  const marketLotSize = raw.filters?.find((filter) => filter.filterType === "MARKET_LOT_SIZE");
  const quantityFilters = [lotSize, marketLotSize].filter(
    (filter): filter is BinanceSymbolFilter => Boolean(filter),
  );
  const stepSize = combineDecimalSteps(
    quantityFilters.map((filter) => filter.stepSize ?? "0"),
  ) ?? precisionToStep(raw.baseAssetPrecision);

  const marketNotionalFilters = (raw.filters ?? []).filter((filter) => (
    (filter.filterType === "MIN_NOTIONAL" && filter.applyToMarket === true) ||
    (filter.filterType === "NOTIONAL" && filter.applyMinToMarket === true)
  ));
  const effectiveNotional = marketNotionalFilters.reduce<BinanceSymbolFilter | undefined>(
    (current, filter) => {
      const currentMin = positiveDecimal(current?.minNotional);
      const candidateMin = positiveDecimal(filter.minNotional);
      if (!candidateMin) return current;
      if (!currentMin || compareDecimalStrings(candidateMin, currentMin) > 0) return filter;
      return current;
    },
    undefined,
  );

  return {
    symbol: raw.symbol ?? "",
    status: raw.status ?? "UNKNOWN",
    base_asset: raw.baseAsset ?? "",
    quote_asset: raw.quoteAsset ?? "",
    min_qty: maximumPositive(quantityFilters.map((filter) => filter.minQty)) ?? "0",
    max_qty: minimumPositive(quantityFilters.map((filter) => filter.maxQty)),
    step_size: stepSize,
    min_quote_amount: positiveDecimal(effectiveNotional?.minNotional),
    quote_order_qty_market_allowed: raw.quoteOrderQtyMarketAllowed === true,
    market_avg_price_mins: normalizeAvgPriceMins(effectiveNotional?.avgPriceMins),
  };
}

async function getMarketReferencePrice(
  symbol: string,
  avgPriceMins: number,
  hasMarketNotionalFilter: boolean,
): Promise<{
  price: string;
  source: "reference_price" | "average_price" | "last_price";
}> {
  if (hasMarketNotionalFilter) {
    try {
      const raw = await binancePublicRequest("/api/v3/referencePrice", { symbol });
      const referencePrice = positiveDecimal(
        (raw as { referencePrice?: string | null }).referencePrice ?? undefined,
      );
      if (referencePrice) return { price: referencePrice, source: "reference_price" };
    } catch (error: unknown) {
      if (!(error instanceof BinanceApiError) || error.code !== -2043) throw error;
    }
  }

  if (avgPriceMins > 0) {
    const raw = await binancePublicRequest("/api/v3/avgPrice", { symbol });
    const price = positiveDecimal((raw as { price?: string }).price);
    if (!price) throw new Error(`Binance returned an invalid average price for ${symbol}`);
    return { price, source: "average_price" };
  }

  const raw = await binancePublicRequest("/api/v3/ticker/price", { symbol });
  const price = positiveDecimal((raw as { price?: string }).price);
  if (!price) throw new Error(`Binance returned an invalid last price for ${symbol}`);
  return { price, source: "last_price" };
}

function normalizeMarketSellResult(
  raw: unknown,
  fallbackSymbol: string,
): MarketSellOrderResult {
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
    symbol: order.symbol ?? fallbackSymbol,
    status: order.status ?? "UNKNOWN",
    executed_qty: executedQty,
    quote_qty: quoteQty,
    avg_price: avgPrice,
    raw,
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
    const symbols = (raw as { symbols?: BinanceSymbolRaw[] }).symbols ?? [];

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
    const symbols = (raw as { symbols?: BinanceSymbolRaw[] }).symbols ?? [];
    const first = symbols[0];
    if (!first) return null;

    const normalized = normalizeSpotSymbolInfo(first);
    const referencePrice = await getMarketReferencePrice(
      normalized.symbol,
      normalized.market_avg_price_mins,
      Boolean(normalized.min_quote_amount),
    );
    return {
      ...normalized,
      last_price: referencePrice.price,
      market_reference_price: referencePrice.price,
      market_reference_price_source: referencePrice.source,
    };
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
      newOrderRespType: "FULL",
    });
    return normalizeMarketSellResult(raw, symbol.toUpperCase());
  }

  /**
   * Official Binance MARKET orders accept quoteOrderQty instead of quantity.
   * For SELL orders it is the quote amount the user wants to receive, and
   * Binance derives a base quantity that does not break LOT_SIZE rules.
   * https://developers.binance.com/docs/binance-spot-api-docs/rest-api/trading-endpoints#new-order-trade
   */
  async placeMarketSellOrderByQuoteAmount(
    symbol: string,
    quoteAmount: string,
    creds: DecryptedCreds,
  ): Promise<MarketSellOrderResult> {
    const raw = await binanceSignedRequest("POST", "/api/v3/order", creds, {
      symbol: symbol.toUpperCase(),
      side: "SELL",
      type: "MARKET",
      quoteOrderQty: normalizeDecimalString(quoteAmount),
      newOrderRespType: "FULL",
    });
    return normalizeMarketSellResult(raw, symbol.toUpperCase());
  }

  /**
   * Binance Account Trade List requires a symbol and limits startTime/endTime
   * to a 24-hour span. Longer user-selected ranges are therefore split into
   * adjacent windows and full pages continue from the last trade id.
   * Official reference:
   * https://developers.binance.com/docs/binance-spot-api-docs/rest-api/account-endpoints#account-trade-list-user_data
   */
  async getSpotTrades(
    symbol: string,
    startTime: number,
    endTime: number,
    creds: DecryptedCreds,
  ): Promise<SpotTrade[]> {
    const normalizedSymbol = symbol.trim().toUpperCase();
    if (!normalizedSymbol) throw new Error("symbol is required");
    if (!Number.isSafeInteger(startTime) || !Number.isSafeInteger(endTime) || startTime > endTime) {
      throw new Error("Invalid trade history time range");
    }

    type BinanceTrade = {
      symbol?: string;
      id?: number;
      orderId?: number;
      price?: string;
      qty?: string;
      quoteQty?: string;
      commission?: string;
      commissionAsset?: string;
      time?: number;
      isBuyer?: boolean;
      isMaker?: boolean;
    };

    const collected = new Map<string, BinanceTrade>();
    let windowStart = startTime;
    while (windowStart <= endTime) {
      const windowEnd = Math.min(endTime, windowStart + BINANCE_TRADE_WINDOW_MS - 1);
      const raw = await binanceSignedRequest("GET", "/api/v3/myTrades", creds, {
        symbol: normalizedSymbol,
        startTime: String(windowStart),
        endTime: String(windowEnd),
        limit: String(BINANCE_TRADE_PAGE_SIZE),
      });
      let page = raw as BinanceTrade[];
      for (const trade of page) {
        if (trade.id !== undefined) collected.set(String(trade.id), trade);
      }

      // startTime/endTime cannot be combined with fromId. Continue from the
      // last id and retain only records that still belong to this window.
      let pages = 1;
      while (page.length === BINANCE_TRADE_PAGE_SIZE) {
        const last = page[page.length - 1];
        if (last.id === undefined || (last.time ?? 0) > windowEnd) break;
        if (pages >= 100) throw new Error("Too many Binance trades in a 24-hour window");
        const nextRaw = await binanceSignedRequest("GET", "/api/v3/myTrades", creds, {
          symbol: normalizedSymbol,
          fromId: String(last.id + 1),
          limit: String(BINANCE_TRADE_PAGE_SIZE),
        });
        page = nextRaw as BinanceTrade[];
        for (const trade of page) {
          const time = trade.time ?? 0;
          if (trade.id !== undefined && time >= windowStart && time <= windowEnd) {
            collected.set(String(trade.id), trade);
          }
        }
        pages += 1;
      }
      windowStart = windowEnd + 1;
    }

    return [...collected.values()]
      .filter((trade) => (trade.time ?? 0) >= startTime && (trade.time ?? 0) <= endTime)
      .sort((a, b) => (a.time ?? 0) - (b.time ?? 0))
      .map((trade) => ({
        symbol: trade.symbol ?? normalizedSymbol,
        trade_id: String(trade.id ?? ""),
        order_id: String(trade.orderId ?? ""),
        price: trade.price ?? "0",
        quantity: trade.qty ?? "0",
        quote_quantity: trade.quoteQty ?? "0",
        commission: trade.commission ?? "0",
        commission_asset: trade.commissionAsset ?? "",
        time: trade.time ?? 0,
        is_buyer: trade.isBuyer ?? false,
        is_maker: trade.isMaker ?? false,
      }));
  }
}
