import test from "node:test";
import assert from "node:assert/strict";
import { TaskRuntime } from "../server/tasks/runtime.js";
import type { TaskJob } from "../server/tasks/types.js";

function job(id: string, jobType: TaskJob["job_type"] = "arbitrage"): TaskJob {
  return {
    id, job_type: jobType, state: "running", interval_sec: 3600,
    total_count: 0, done_count: 0, next_run_at: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    payload: { account_id: id, asset: "USDT", network: "ETH", address: "test",
      threshold_amount: "10", interval_sec: 3600 },
    progress: {}, logs: [],
  };
}

test("both arbitrage directions execute concurrently and stop independently", async () => {
  const runtime = new TaskRuntime({ persistTask: () => {}, appendLog: () => {} });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered: string[] = [];
  for (const task of [job("a"), job("b", "dex_to_cex_arbitrage")]) {
    runtime.startTask(task, async current => {
      entered.push(current.id);
      await gate;
      return { job: current };
    });
  }
  assert.equal(runtime.getActiveTasks().length, 2);
  assert.equal(runtime.hasConflict(job("sell", "sell_market")), true);
  const a = runtime.runNow("a");
  const b = runtime.runNow("b");
  await runtime.runNow("a"); // No overlapping rounds for the same task.
  assert.deepEqual(entered, ["a", "b"]);
  runtime.stopTask("a", "stop");
  release();
  await Promise.all([a, b]);
  assert.equal(runtime.getTask("a")?.state, "stopped");
  assert.equal(runtime.getTask("a")?.next_run_at, null);
  assert.deepEqual(runtime.getActiveTasks().map(task => task.id), ["b"]);
  runtime.resumeTask("a");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runtime.getActiveTasks().length, 2);
  runtime.removeTask("a");
  runtime.removeTask("b");
});

test("removing an in-flight task does not resurrect its persisted state", async () => {
  const writes: string[] = [];
  const runtime = new TaskRuntime({ persistTask: task => { writes.push(task.id); }, appendLog: () => {} });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  runtime.startTask(job("removed"), async current => { await gate; return { job: current }; });
  const pending = runtime.runNow("removed");
  runtime.removeTask("removed");
  writes.length = 0;
  release();
  await pending;
  assert.deepEqual(writes, []);
  assert.equal(runtime.getTask("removed"), null);
});

test("failure in one task does not stop another task", async () => {
  const runtime = new TaskRuntime({ persistTask: () => {}, appendLog: () => {} });
  runtime.startTask(job("failed"), async () => { throw new Error("test failure"); });
  runtime.startTask(job("healthy"), async current => ({ job: current, complete: true }));
  await runtime.runNow("failed");
  assert.equal(runtime.getTask("failed")?.state, "stopped");
  assert.equal(runtime.getTask("healthy")?.state, "running");
  await runtime.runNow("healthy");
  assert.equal(runtime.getTask("healthy")?.state, "completed");
});
