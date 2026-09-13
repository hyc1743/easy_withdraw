import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { ceilDecimalRatioToStep, floorDecimalToStep } from "../server/decimal.js";
import { BinanceAdapter } from "../server/exchange/binance.js";
import type {
  AssetBalance,
  ExchangeAdapter,
  MarketSellOrderResult,
  SpotSymbolInfo,
} from "../server/exchange/types.js";
import {
  createSellMarketTaskExecutor,
  previewSellQuantity,
} from "../server/tasks/executors.js";
import type { SellMarketTaskPayload, TaskJob } from "../server/tasks/types.js";

const creds = { api_key: "binance-key", api_secret: "binance-secret" };

function adaptiveSymbol(): SpotSymbolInfo {
  return {
    symbol: "DUSTUSDT",
    status: "TRADING",
    base_asset: "DUST",
    quote_asset: "USDT",
    min_qty: "1",
    max_qty: "50000",
    step_size: "1",
    min_quote_amount: "5",
    last_price: "0.004",
    market_reference_price: "0.004",
    market_reference_price_source: "average_price",
    quote_order_qty_market_allowed: true,
  };
}

function sellPayload(): SellMarketTaskPayload {
  return {
    account_id: "binance-main",
    symbol: "DUSTUSDT",
    base_asset: "DUST",
    quote_asset: "USDT",
    step_amount: "1000",
    interval_sec: 1,
  };
}

function adaptiveAdapter(
  balance: string,
  quoteOrders: string[] = [],
  symbol = adaptiveSymbol(),
  quantityOrders: string[] = [],
): ExchangeAdapter {
  const assetBalance: AssetBalance = {
    currency: "DUST",
    available: balance,
    locked: "0",
    total: balance,
  };
  const orderResult: MarketSellOrderResult = {
    order_id: "123",
    symbol: symbol.symbol,
    status: "FILLED",
    executed_qty: "1250",
    quote_qty: "5",
    avg_price: "0.004",
    raw: {},
  };
  return {
    getBalance: async () => assetBalance,
    getSpotSymbol: async () => symbol,
    placeMarketSellOrder: async (_symbol: string, quantity: string) => {
      quantityOrders.push(quantity);
      return orderResult;
    },
    placeMarketSellOrderByQuoteAmount: async (_symbol: string, quoteAmount: string) => {
      quoteOrders.push(quoteAmount);
      return orderResult;
    },
  } as unknown as ExchangeAdapter;
}

function adaptiveSellJob(): TaskJob {
  const now = new Date().toISOString();
  return {
    id: "sell-adaptive-test",
    job_type: "sell_market",
    state: "running",
    interval_sec: 1,
    total_count: 0,
    done_count: 0,
    next_run_at: null,
    created_at: now,
    updated_at: now,
    payload: sellPayload(),
    progress: {},
    logs: [],
  };
}

test("Binance symbol rules use official filters and average-price fallback", async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    if (url.pathname === "/api/v3/exchangeInfo") {
      return new Response(JSON.stringify({ symbols: [{
        symbol: "DUSTUSDT",
        status: "TRADING",
        baseAsset: "DUST",
        baseAssetPrecision: 8,
        quoteAsset: "USDT",
        quoteOrderQtyMarketAllowed: true,
        filters: [
          { filterType: "LOT_SIZE", minQty: "1", maxQty: "100000", stepSize: "1" },
          { filterType: "MARKET_LOT_SIZE", minQty: "0", maxQty: "50000", stepSize: "0" },
          { filterType: "MIN_NOTIONAL", minNotional: "10", applyToMarket: false, avgPriceMins: 1 },
          { filterType: "NOTIONAL", minNotional: "5.00000000", applyMinToMarket: true, avgPriceMins: 5 },
        ],
      }] }), { status: 200 });
    }
    if (url.pathname === "/api/v3/referencePrice") {
      return new Response(JSON.stringify({ code: -2043, msg: "No reference price" }), { status: 400 });
    }
    if (url.pathname === "/api/v3/avgPrice") {
      return new Response(JSON.stringify({ mins: 5, price: "0.00400000" }), { status: 200 });
    }
    throw new Error(`Unexpected Binance endpoint: ${url.pathname}`);
  };

  try {
    const symbol = await new BinanceAdapter().getSpotSymbol("dustusdt", creds);
    assert.ok(symbol);
    assert.equal(symbol.min_qty, "1");
    assert.equal(symbol.max_qty, "50000");
    assert.equal(symbol.step_size, "1");
    assert.equal(symbol.min_quote_amount, "5");
    assert.equal(symbol.market_reference_price, "0.004");
    assert.equal(symbol.market_reference_price_source, "average_price");
    assert.deepEqual(paths, ["/api/v3/exchangeInfo", "/api/v3/referencePrice", "/api/v3/avgPrice"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Binance quote-amount market sell uses quoteOrderQty without quantity", async () => {
  const originalFetch = globalThis.fetch;
  let body: URLSearchParams | undefined;
  globalThis.fetch = async (_input, init) => {
    body = new URLSearchParams(String(init?.body ?? ""));
    return new Response(JSON.stringify({
      symbol: "DUSTUSDT",
      orderId: 123,
      status: "FILLED",
      executedQty: "1250",
      cummulativeQuoteQty: "5",
    }), { status: 200 });
  };

  try {
    await new BinanceAdapter().placeMarketSellOrderByQuoteAmount("DUSTUSDT", "5.00000000", creds);
    assert.equal(body?.get("side"), "SELL");
    assert.equal(body?.get("type"), "MARKET");
    assert.equal(body?.get("quoteOrderQty"), "5");
    assert.equal(body?.has("quantity"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Binance auto sell adapts 1000 tokens to the 5 USDT minimum with exact decimal math", async () => {
  assert.equal(floorDecimalToStep("1.23456789", "0.000001"), "1.234567");
  assert.equal(ceilDecimalRatioToStep("5", "0.004", "1"), "1250");

  const quoteOrders: string[] = [];
  const context = { adapter: adaptiveAdapter("10000", quoteOrders), creds, exchange: "binance" };
  const preview = await previewSellQuantity(sellPayload(), context);
  assert.equal(preview.executable_qty, "1000");
  assert.equal(preview.estimated_notional, "4");
  assert.equal(preview.execution_mode, "quote_order_qty");
  assert.equal(preview.quote_order_qty, "5");
  assert.equal(preview.estimated_base_qty, "1250");
  assert.equal(preview.can_execute, true);

  const result = await createSellMarketTaskExecutor(context)(adaptiveSellJob());
  assert.deepEqual(quoteOrders, ["5"]);
  assert.equal(result.stop, undefined);
  assert.match(result.log?.message ?? "", /最小成交额 5 USDT 自适应/);
});

test("Binance keeps quantity mode when the configured amount meets minimum notional", async () => {
  const quoteOrders: string[] = [];
  const quantityOrders: string[] = [];
  const symbol = { ...adaptiveSymbol(), last_price: "0.005", market_reference_price: "0.005" };
  const context = {
    adapter: adaptiveAdapter("10000", quoteOrders, symbol, quantityOrders),
    creds,
    exchange: "binance",
  };
  const preview = await previewSellQuantity(sellPayload(), context);
  assert.equal(preview.estimated_notional, "5");
  assert.equal(preview.execution_mode, "quantity");
  assert.equal(preview.can_execute, true);

  await createSellMarketTaskExecutor(context)(adaptiveSellJob());
  assert.deepEqual(quantityOrders, ["1000"]);
  assert.deepEqual(quoteOrders, []);
});

test("Binance auto sell stops when the full balance is below minimum notional", async () => {
  const quoteOrders: string[] = [];
  const context = { adapter: adaptiveAdapter("1200", quoteOrders), creds, exchange: "binance" };
  const preview = await previewSellQuantity(sellPayload(), context);
  assert.equal(preview.can_execute, false);
  assert.match(preview.validation_message ?? "", /余额 1200 DUST.*不足最小成交额 5 USDT/);

  const result = await createSellMarketTaskExecutor(context)(adaptiveSellJob());
  assert.equal(result.stop, true);
  assert.deepEqual(quoteOrders, []);
});

test("other exchanges retain quantity-mode minimum-notional validation", async () => {
  const preview = await previewSellQuantity(sellPayload(), {
    adapter: adaptiveAdapter("10000"),
    creds,
    exchange: "okx",
  });
  assert.equal(preview.execution_mode, "quantity");
  assert.equal(preview.adjusted_for_min_notional, false);
  assert.equal(preview.can_execute, false);
});

test("sell UI documents adaptive quoteOrderQty precision handling", () => {
  const html = fs.readFileSync("public/index.html", "utf8");
  assert.match(html, /quoteOrderQty=/);
  assert.match(html, /实际数量由 Binance 按精度计算/);
});
