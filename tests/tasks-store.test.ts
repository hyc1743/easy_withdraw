import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("loadTaskJob normalizes legacy withdraw rows", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "easy-withdraw-task-store-"));
  process.env.EW_DATA_DIR = tempDir;

  const dbModule = await import("../server/db.js");
  dbModule.resetDbForTests();
  const db = dbModule.getDb();

  const now = new Date().toISOString();
  const legacyRequest = {
    account_id: "binance_main",
    asset: "USDT",
    network: "TRX",
    address: "T123",
    amount: "10",
  };

  db.prepare(
    `INSERT INTO schedule_jobs(
      id, state, interval_sec, total_count, done_count, next_run_at, created_at, updated_at, request_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("legacy_job", "running", 60, 5, 2, null, now, now, JSON.stringify(legacyRequest));

  const storeModule = await import("../server/tasks/store.js");
  const job = storeModule.loadTaskJob("legacy_job");

  assert.ok(job);
  assert.equal(job?.id, "legacy_job");
  assert.equal(job?.job_type, "withdraw");
  assert.deepEqual(job?.payload, legacyRequest);
  assert.deepEqual(job?.progress, {});
});
