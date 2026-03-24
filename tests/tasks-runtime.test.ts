import test from "node:test";
import assert from "node:assert/strict";

import { TaskRuntime } from "../server/tasks/runtime.js";
import type { TaskJob } from "../server/tasks/types.js";

test("TaskRuntime runs a task round and clears active task when completed", async () => {
  const persisted: TaskJob[] = [];
  const runtime = new TaskRuntime({
    persistTask: (job) => {
      persisted.push(structuredClone(job));
    },
    appendLog: () => {},
  });

  const now = new Date().toISOString();
  const job: TaskJob = {
    id: "job_1",
    job_type: "withdraw",
    state: "running",
    interval_sec: 1,
    total_count: 1,
    done_count: 0,
    next_run_at: null,
    created_at: now,
    updated_at: now,
    payload: {
      account_id: "acct",
      asset: "USDT",
      network: "TRX",
      address: "T123",
      amount: "10",
    },
    progress: {},
    logs: [],
  };

  runtime.startTask(job, async (currentJob) => ({
    job: {
      ...currentJob,
      done_count: currentJob.done_count + 1,
    },
    log: {
      ok: true,
      message: "round ok",
    },
    complete: true,
  }));

  await runtime.runNow("job_1");

  const active = runtime.getActiveTask();
  const stored = runtime.getTask("job_1");

  assert.equal(active, null);
  assert.ok(stored);
  assert.equal(stored?.state, "completed");
  assert.equal(stored?.done_count, 1);
  assert.equal(stored?.logs[0]?.message, "round ok");
  assert.ok(persisted.length >= 1);
});
