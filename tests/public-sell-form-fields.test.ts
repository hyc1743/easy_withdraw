import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("sell form derives base and quote assets from selected symbol instead of separate inputs", () => {
  const html = fs.readFileSync("public/index.html", "utf8");

  assert.doesNotMatch(html, /id="sell-base-asset"/);
  assert.doesNotMatch(html, /id="sell-quote-asset"/);
  assert.match(
    html,
    /function getSellBody\(\)[\s\S]*base_asset:\s*selectedSellSymbol\?\.base_asset[\s\S]*quote_asset:\s*selectedSellSymbol\?\.quote_asset/,
  );
});
