import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { resolveListenHost } from "../server/host.js";

test("listen host defaults to Tailscale for every startup mode", () => {
  assert.equal(resolveListenHost("", () => "100.64.0.12"), "100.64.0.12");
  assert.equal(resolveListenHost("  ", () => "100.64.0.12"), "100.64.0.12");
  assert.equal(resolveListenHost("", () => null), "127.0.0.1");
  assert.equal(resolveListenHost(" 127.0.0.1 ", () => { throw new Error("must not detect"); }), "127.0.0.1");
});

test("all arbitrage forms default to five seconds and template UI/API are removed", () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  for (const id of ["sch-interval", "d2c-interval", "d2c-interval-cc"]) {
    assert.match(html, new RegExp('id="' + id + '"[^>]*value="5"'));
    assert.equal(html.includes("$('" + id + "').value, 10) || 60"), false);
    assert.equal(html.includes("$('" + id + "').value) || 60"), false);
  }
  assert.doesNotMatch(html, /w-tpl|loadTemplate|saveTemplate|deleteTemplate|\/templates/);
  const entry = fs.readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(entry, /templateRoutes|\/api\/templates/);
  assert.match(entry, /resolveListenHost\(\)/);
});

test("CEX to DEX API defaults to five seconds but preserves explicit intervals", async () => {
  const { normalizeArbitrageStartBody } = await import("../server/routes/withdraw.js");
  const body = {
    withdraw: { account_id: "test", asset: "ETH", network: "ETH", address: "test" },
    threshold_amount: "1",
  };
  assert.equal(normalizeArbitrageStartBody(body).interval_sec, 5);
  assert.equal(normalizeArbitrageStartBody({ ...body, interval_sec: 30 }).interval_sec, 30);
});
