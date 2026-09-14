import test from "node:test";
import assert from "node:assert/strict";
import { editStoppedArbitrage } from "../server/tasks/edit.js";
import type { TaskJob, ArbitrageTaskPayload, DexToCexArbitrageTaskPayload } from "../server/tasks/types.js";
import type { AppConfig } from "../server/config.js";

const address = "0x" + "a".repeat(40);
const target = "0x" + "b".repeat(40);
const config = {
  accounts: [{ id: "old" }, { id: "new" }],
  onchain_wallets: [{ id: "old" }, { id: "new" }],
} as Pick<AppConfig, "accounts" | "onchain_wallets">;
function job(d2c = false): TaskJob {
  return {
    id: "test", job_type: d2c ? "dex_to_cex_arbitrage" : "arbitrage", state: "stopped",
    interval_sec: 5, total_count: 0, done_count: 2, next_run_at: null,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    payload: d2c
      ? { wallet_id: "old", deposit_address: address, symbol: "ETH", src_chain: "Ethereum", token_address: address, threshold_amount: "1", interval_sec: 5 }
      : { account_id: "old", address, asset: "ETH", network: "ETH", threshold_amount: "1", interval_sec: 5 },
    progress: d2c ? { phase: "check_source_balance", completed_count: 2 } : { phase: "check_balance", withdraw_count: 2 },
    logs: [],
  };
}
const input = { source_id: "new", target_address: target, threshold_amount: "2.5", interval_sec: 10 };

test("editing stopped CEX task changes only requested settings and preserves history", () => {
  const original = job();
  const updated = editStoppedArbitrage(original, input, config);
  const payload = updated.payload as ArbitrageTaskPayload;
  assert.equal(payload.account_id, "new");
  assert.equal(payload.address, target);
  assert.equal(payload.asset, "ETH");
  assert.equal(payload.threshold_amount, "2.5");
  assert.equal(payload.interval_sec, 10);
  assert.equal(updated.interval_sec, 10);
  assert.equal(updated.state, "stopped");
  assert.equal(updated.done_count, 2);
  assert.equal((original.payload as ArbitrageTaskPayload).account_id, "old");
});

test("DEX to CEX updates source wallet and deposit target", () => {
  const updated = editStoppedArbitrage(job(true), input, config);
  assert.equal((updated.payload as DexToCexArbitrageTaskPayload).wallet_id, "new");
  assert.equal((updated.payload as DexToCexArbitrageTaskPayload).deposit_address, target);
});

test("crosschain edit changes final recipient without changing intermediate withdrawal address", () => {
  const original = job();
  (original.payload as ArbitrageTaskPayload).crosschain = {
    wallet_id: "old", recipient: address, src_chain: "Ethereum", dst_chain: "Arbitrum", token_address: address, slippage_bps: 50,
  };
  const updated = editStoppedArbitrage(original, input, config).payload as ArbitrageTaskPayload;
  assert.equal(updated.crosschain?.recipient, target);
  assert.equal(updated.address, address);
});

test("pending transfers lock endpoints but allow interval and threshold edits", () => {
  const original = job();
  original.progress = { phase: "wait_withdrawal", withdraw_count: 2, last_withdraw_id: "pending" };
  assert.throws(() => editStoppedArbitrage(original, input, config), /未完成操作/);
  const updated = editStoppedArbitrage(original, { ...input, source_id: "old", target_address: address }, config);
  assert.deepEqual(updated.progress, original.progress);
});

test("running, completed, malformed values, missing accounts and tagged targets are rejected", () => {
  for (const state of ["running", "completed"] as const) {
    assert.throws(() => editStoppedArbitrage({ ...job(), state }, input, config), /已停止/);
  }
  for (const patch of [{ interval_sec: 0 }, { interval_sec: 1.1 }, { threshold_amount: "-1" }, { threshold_amount: "NaN" }, { source_id: "missing" }, { unexpected: "x" }]) {
    assert.throws(() => editStoppedArbitrage(job(), { ...input, ...patch }, config));
  }
  assert.throws(() => editStoppedArbitrage(job(true), { ...input, target_address: "invalid" }, config), /EVM/);
  const tagged = job();
  (tagged.payload as ArbitrageTaskPayload).address_tag = "memo";
  assert.throws(() => editStoppedArbitrage(tagged, input, config), /Memo/);
});

test("PATCH persists edits, rejects stale versions, and blocks an in-flight stopped task", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  process.env.EW_DATA_DIR = mkdtempSync(join(tmpdir(), "ew-edit-"));
  const { ensureConfig, saveConfig } = await import("../server/config.js");
  const cfg = ensureConfig();
  cfg.accounts = ["old", "new"].map(id => ({ id, exchange: "binance", api_key: "test", api_secret_enc: null, passphrase_enc: null }));
  saveConfig(cfg);
  const { persistTaskJob, loadTaskJob } = await import("../server/tasks/store.js");
  const { taskRoutes } = await import("../server/routes/tasks.js");
  const { taskRuntime } = await import("../server/tasks/runtime.js");
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use("/tasks", taskRoutes({} as never));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  const original = job();
  persistTaskJob(original);
  const patch = (body: unknown) => fetch(`http://127.0.0.1:${port}/tasks/test`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    const body = { ...input, updated_at: original.updated_at };
    assert.equal((await patch(body)).status, 200);
    assert.equal(loadTaskJob("test")?.interval_sec, 10);
    assert.equal(taskRuntime.getTask("test")?.interval_sec, 10);
    assert.equal(taskRuntime.getTask("test")?.state, "stopped");
    assert.equal((await patch(body)).status, 409);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const running = { ...job(), state: "running" as const };
    taskRuntime.startTask(running, async current => { await gate; return { job: current }; });
    const pending = taskRuntime.runNow(running.id);
    taskRuntime.stopTask(running.id, "test stop");
    assert.equal((await patch({ ...input, updated_at: taskRuntime.getTask("test")?.updated_at })).status, 409);
    release();
    await pending;
  } finally {
    taskRuntime.removeTask("test");
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
