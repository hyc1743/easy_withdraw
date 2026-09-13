import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const source = html.slice(html.indexOf("function sameTaskAddress("), html.indexOf("function taskPhaseName("));
const first = "0x" + "a".repeat(40);
const last = "0x" + "b".repeat(40);
const deposit = "0x" + "c".repeat(40);
function setup() {
  const context = vm.createContext({
    taskPartyDirectory: {
      accounts: [{ id: "交易账户1", exchange: "binance" }],
      wallets: [{ id: "钱包A", address: first }, { id: "钱包B", address: last }],
      addresses: [{ label: "OKX 账户2", address: deposit }],
    },
    esc: (s: unknown) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;"),
  });
  vm.runInContext(source, context);
  return context;
}

test("CEX to DEX resolves source exchange and target wallet", () => {
  const context = setup();
  context.job = { job_type: "arbitrage", payload: { account_id: "交易账户1", address: first.toUpperCase().replace("0X", "0x") } };
  const parties = vm.runInContext("getTaskParties(job)", context);
  assert.equal(parties.from.name, "交易账户1");
  assert.equal(parties.from.kind, "BINANCE 交易所账户");
  assert.equal(parties.to.name, "钱包A");
});

test("crosschain shows final recipient separately from initial withdrawal wallet", () => {
  const context = setup();
  context.job = { job_type: "arbitrage", payload: { account_id: "交易账户1", address: first, crosschain: { wallet_id: "钱包A", recipient: last } } };
  const parties = vm.runInContext("getTaskParties(job)", context);
  assert.equal(parties.to.name, "钱包B");
  assert.equal(parties.via.name, "钱包A");
});

test("DEX to CEX resolves target from address book, with honest unknown-address fallback", () => {
  const context = setup();
  context.job = { job_type: "dex_to_cex_arbitrage", payload: { wallet_id: "钱包A", deposit_address: deposit } };
  const parties = vm.runInContext("getTaskParties(job)", context);
  assert.equal(parties.from.name, "钱包A");
  assert.equal(parties.to.name, "OKX 账户2");
  context.job.payload.deposit_address = "unlabelled";
  assert.equal(vm.runInContext("getTaskParties(job).to.name", context), "未标注地址");
  assert.equal(vm.runInContext('sameTaskAddress("Abc", "abc")', context), false);
});

test("list and panel share party rendering and show escaped full addresses in details", () => {
  assert.ok(html.includes('taskPartiesHtml(job)}'));
  assert.ok(html.includes("taskPartiesHtml(job, true)"));
  const context = setup();
  context.job = { job_type: "arbitrage", payload: { account_id: '<img src="x">', address: first } };
  const rendered = vm.runInContext("taskPartiesHtml(job, true)", context);
  assert.ok(rendered.includes(first));
  assert.ok(rendered.includes("&lt;img"));
  assert.equal(rendered.includes("<img"), false);
});
