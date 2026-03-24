import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function extractFunctionSource(html: string, name: string): string {
  const marker = `function ${name}(`;
  const start = html.indexOf(marker);
  if (start < 0) {
    throw new Error(`function not found: ${name}`);
  }

  let braceIndex = html.indexOf("{", start);
  let depth = 0;
  for (let i = braceIndex; i < html.length; i += 1) {
    const ch = html[i];
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return html.slice(start, i + 1);
      }
    }
  }

  throw new Error(`unterminated function: ${name}`);
}

test("sell symbol helpers format pairs cleanly and fuzzy-match BTCDUST to BTCUSDT only", () => {
  const html = fs.readFileSync("public/index.html", "utf8");
  const script = [
    extractFunctionSource(html, "normalizeSellSymbolSearchValue"),
    extractFunctionSource(html, "getSellSymbolDisplay"),
    extractFunctionSource(html, "sellSymbolEditDistance"),
    extractFunctionSource(html, "sellSymbolCharBagDistance"),
    extractFunctionSource(html, "getFilteredSellSymbols"),
  ].join("\n");

  const context = vm.createContext({});
  new vm.Script(`${script}
globalThis.exports = {
  normalizeSellSymbolSearchValue,
  getSellSymbolDisplay,
  sellSymbolEditDistance,
  sellSymbolCharBagDistance,
  getFilteredSellSymbols,
};`).runInContext(context);

  const helpers = (context as { exports: {
    getSellSymbolDisplay: (symbol: { base_asset: string; quote_asset: string }) => string;
    getFilteredSellSymbols: (
      symbols: Array<{ symbol: string; base_asset: string; quote_asset: string }>,
      query: string,
      baseAsset: string,
      quoteAsset: string,
    ) => Array<{ symbol: string }>;
  } }).exports;

  assert.equal(
    helpers.getSellSymbolDisplay({ base_asset: "BTC", quote_asset: "USDT" }),
    "BTC/USDT",
  );

  const results = helpers.getFilteredSellSymbols(
    [
      { symbol: "BTCUSDT", base_asset: "BTC", quote_asset: "USDT" },
      { symbol: "WBTCUSDT", base_asset: "WBTC", quote_asset: "USDT" },
      { symbol: "BTCFDUSD", base_asset: "BTC", quote_asset: "FDUSD" },
    ],
    "BTCDUST",
    "",
    "",
  );

  assert.deepEqual(results.map((item) => item.symbol), ["BTCUSDT"]);
});
