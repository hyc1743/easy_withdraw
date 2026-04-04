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

const BASE_URL = "https://api.bitget.com";
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

async function bitgetRequest(
  method: string,
  endpoint: string,
  creds: DecryptedCreds | null,
  body?: unknown,
  query?: string,
): Promise<unknown> {
  const path = endpoint + (query ? `?${query}` : "");
  const url = `${BASE_URL}${path}`;
  const bodyStr = body ? JSON.stringify(body) : "";

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      if (creds) {
        if (!creds.passphrase) {
          throw new Error("Bitget requires passphrase");
        }
        const timestamp = Date.now().toString();
        const preHash = `${timestamp}${method.toUpperCase()}${path}${bodyStr}`;
        const sign = b64HmacSha256(preHash, creds.api_secret);
        headers["ACCESS-KEY"] = creds.api_key;
        headers["ACCESS-SIGN"] = sign;
        headers["ACCESS-TIMESTAMP"] = timestamp;
        headers["ACCESS-PASSPHRASE"] = creds.passphrase;
        headers.locale = "en-US";
      }

      const resp = await fetch(url, {
        method,
        headers,
        body: method === "GET" ? undefined : bodyStr || undefined,
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
        throw new Error(`Bitget API error ${resp.status}: ${msg}`);
      }

      const wrapped = data as { code?: string; msg?: string };
      if (wrapped.code && wrapped.code !== "00000") {
        throw new Error(`Bitget API error ${wrapped.code}: ${wrapped.msg ?? "unknown"}`);
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

  throw new Error("Bitget API request failed");
}

function parsePrecision(scale: string | undefined): number {
  const n = Number(scale);
  if (Number.isNaN(n) || n < 0) return 8;
  return n;
}

function precisionToStepSize(precision: number): string {
  if (!Number.isInteger(precision) || precision <= 0) {
    return "1";
  }
  return `0.${"0".repeat(Math.max(0, precision - 1))}1`;
}

function normalizeBitgetSpotStatus(status: string | undefined): string {
  return status === "online" ? "TRADING" : String(status ?? "UNKNOWN").toUpperCase();
}

function buildBitgetSpotSymbolInfo(row: {
  symbol?: string;
  status?: string;
  baseCoin?: string;
  quoteCoin?: string;
  quantityPrecision?: string;
  minTradeAmount?: string;
  minTradeUSDT?: string;
  lastPr?: string;
}): SpotSymbolInfo {
  return {
    symbol: row.symbol ?? "",
    status: normalizeBitgetSpotStatus(row.status),
    base_asset: row.baseCoin ?? "",
    quote_asset: row.quoteCoin ?? "",
    min_qty: row.minTradeAmount ?? "0",
    step_size: precisionToStepSize(Number(row.quantityPrecision ?? "8")),
    min_quote_amount: row.minTradeUSDT ?? "0",
    last_price: row.lastPr,
  };
}

async function getCoinList(): Promise<Array<{
  coin?: string;
  coinName?: string;
  chains?: Array<{
    chain?: string;
    chainName?: string;
    withdrawable?: string;
    rechargeable?: string;
    withdrawFee?: string;
    extraWithDrawFee?: string;
    minWithdrawAmount?: string;
    withdrawMinScale?: string;
  }>;
}>> {
  const raw = await bitgetRequest("GET", "/api/v2/spot/public/coins", null);
  return (raw as {
    data?: Array<{
      coin?: string;
      coinName?: string;
      chains?: Array<{
        chain?: string;
        chainName?: string;
        withdrawable?: string;
        rechargeable?: string;
        withdrawFee?: string;
        extraWithDrawFee?: string;
        minWithdrawAmount?: string;
        withdrawMinScale?: string;
      }>;
    }>;
  }).data ?? [];
}

export class BitgetAdapter implements ExchangeAdapter {
  async validateRequest(req: WithdrawRequest): Promise<void> {
    if (!req.asset || !req.network || !req.address || !req.amount) {
      throw new Error("Missing required fields: asset, network, address, amount");
    }
    if (Number.isNaN(Number(req.amount)) || Number(req.amount) <= 0) {
      throw new Error("Invalid amount");
    }
  }

  async withdraw(req: WithdrawRequest, creds: DecryptedCreds): Promise<WithdrawResponse> {
    const raw = await bitgetRequest("POST", "/api/v2/spot/wallet/withdrawal", creds, {
      coin: req.asset,
      transferType: "on_chain",
      address: req.address,
      chain: req.network,
      size: req.amount,
      tag: req.address_tag ?? undefined,
      clientOid: req.client_withdraw_id,
    });

    const data = raw as { data?: { orderId?: string; clientOid?: string } };
    const withdrawId = data.data?.orderId ?? data.data?.clientOid ?? "";

    return {
      ok: true,
      withdraw_id: withdrawId,
      status: "submitted",
      message: "created",
      raw,
    };
  }

  async queryStatus(id: string, creds: DecryptedCreds): Promise<WithdrawResponse> {
    const end = Date.now();
    const start = end - 90 * 24 * 60 * 60 * 1000;
    const query = new URLSearchParams({
      startTime: String(start),
      endTime: String(end),
      limit: "100",
    }).toString();

    const raw = await bitgetRequest("GET", "/api/v2/spot/wallet/withdrawal-records", creds, undefined, query);
    const rows = (raw as {
      data?: Array<{ orderId?: string; clientOid?: string; status?: string }>;
    }).data ?? [];

    const row = rows.find((r) => r.orderId === id || r.clientOid === id);
    return {
      ok: true,
      withdraw_id: row?.orderId ?? row?.clientOid ?? id,
      status: row?.status ?? "unknown",
      message: "queried",
      raw,
    };
  }

  async listCurrencies(_creds: DecryptedCreds): Promise<CurrencyInfo[]> {
    const rows = await getCoinList();
    return rows
      .filter((r) => r.coin)
      .map((r) => ({
        currency: r.coin!,
        name_en: r.coinName ?? "",
        withdraw_disabled: !(r.chains ?? []).some((c) => c.withdrawable === "true"),
      }));
  }

  async listChains(currency: string, _creds: DecryptedCreds): Promise<ChainInfo[]> {
    const rows = await getCoinList();
    const row = rows.find((r) => (r.coin ?? "").toUpperCase() === currency.toUpperCase());
    const chains = row?.chains ?? [];

    return chains.map((c) => ({
      chain: c.chain ?? "",
      name_en: c.chainName ?? c.chain ?? "",
      is_withdraw_disabled: c.withdrawable !== "true",
      is_deposit_disabled: c.rechargeable !== "true",
      withdraw_fix: c.withdrawFee ?? "0",
      withdraw_percent: c.extraWithDrawFee ?? "0",
      withdraw_amount_mini: c.minWithdrawAmount ?? "0",
      withdraw_eachtime_limit: "0",
      withdraw_day_limit: "0",
      decimal: parsePrecision(c.withdrawMinScale),
    }));
  }

  async getBalance(currency: string, creds: DecryptedCreds): Promise<AssetBalance> {
    const query = `coin=${encodeURIComponent(currency)}`;
    const raw = await bitgetRequest("GET", "/api/v2/spot/account/assets", creds, undefined, query);

    const rows = (raw as {
      data?: Array<{ coin?: string; available?: string; frozen?: string }>;
    }).data ?? [];
    const row = rows.find((r) => (r.coin ?? "").toUpperCase() === currency.toUpperCase());

    const available = row?.available ?? "0";
    const locked = row?.frozen ?? "0";

    return {
      currency: currency.toUpperCase(),
      available,
      locked,
      total: (Number(available) + Number(locked)).toString(),
    };
  }

  async listSpotSymbols(_creds: DecryptedCreds): Promise<SpotSymbolInfo[]> {
    const raw = await bitgetRequest("GET", "/api/v2/spot/public/symbols", null);
    const rows = (raw as {
      data?: Array<{
        symbol?: string;
        status?: string;
        baseCoin?: string;
        quoteCoin?: string;
        quantityPrecision?: string;
        minTradeAmount?: string;
        minTradeUSDT?: string;
      }>;
    }).data ?? [];

    return rows
      .filter((row) => row.symbol && row.baseCoin && row.quoteCoin)
      .map((row) => buildBitgetSpotSymbolInfo(row));
  }

  async getSpotSymbol(
    symbol: string,
    _creds: DecryptedCreds,
  ): Promise<SpotSymbolInfo | null> {
    const normalizedSymbol = symbol.toUpperCase();
    const [instrumentRaw, tickerRaw] = await Promise.all([
      bitgetRequest(
        "GET",
        "/api/v2/spot/public/symbols",
        null,
        undefined,
        `symbol=${encodeURIComponent(normalizedSymbol)}`,
      ),
      bitgetRequest(
        "GET",
        "/api/v2/spot/market/tickers",
        null,
        undefined,
        `symbol=${encodeURIComponent(normalizedSymbol)}`,
      ),
    ]);

    const instrument = (instrumentRaw as {
      data?: Array<{
        symbol?: string;
        status?: string;
        baseCoin?: string;
        quoteCoin?: string;
        quantityPrecision?: string;
        minTradeAmount?: string;
        minTradeUSDT?: string;
      }>;
    }).data?.[0];
    if (!instrument?.symbol || !instrument.baseCoin || !instrument.quoteCoin) {
      return null;
    }

    const ticker = (tickerRaw as {
      data?: Array<{ lastPr?: string }>;
    }).data?.[0];

    return buildBitgetSpotSymbolInfo({
      ...instrument,
      lastPr: ticker?.lastPr,
    });
  }

  async getSpotBalance(currency: string, creds: DecryptedCreds): Promise<AssetBalance> {
    return this.getBalance(currency, creds);
  }

  async placeMarketSellOrder(
    symbol: string,
    quantity: string,
    creds: DecryptedCreds,
  ): Promise<MarketSellOrderResult> {
    const normalizedSymbol = symbol.toUpperCase();
    const raw = await bitgetRequest("POST", "/api/v2/spot/trade/place-order", creds, {
      symbol: normalizedSymbol,
      side: "sell",
      orderType: "market",
      force: "gtc",
      size: quantity,
    });

    const orderId = (raw as {
      data?: { orderId?: string };
    }).data?.orderId;
    if (!orderId) {
      throw new Error("Bitget order creation failed");
    }

    const detailRaw = await bitgetRequest(
      "GET",
      "/api/v2/spot/trade/orderInfo",
      creds,
      undefined,
      `symbol=${encodeURIComponent(normalizedSymbol)}&orderId=${encodeURIComponent(orderId)}`,
    );
    const detail = (detailRaw as {
      data?: Array<{
        orderId?: string;
        status?: string;
        priceAvg?: string;
        baseVolume?: string;
        quoteVolume?: string;
      }>;
    }).data?.[0];

    return {
      order_id: orderId,
      symbol: normalizedSymbol,
      status: detail?.status ?? "UNKNOWN",
      executed_qty: detail?.baseVolume ?? "0",
      quote_qty: detail?.quoteVolume ?? "0",
      avg_price: detail?.priceAvg ?? "0",
      raw: {
        create: raw,
        detail: detailRaw,
      },
    };
  }
}
