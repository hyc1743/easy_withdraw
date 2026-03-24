import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("loadLatestTask returns the latest persisted task for a given job type", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "easy-withdraw-task-latest-"));
  process.env.EW_DATA_DIR = tempDir;

  const dbModule = await import("../server/db.js");
  dbModule.resetDbForTests();
  const db = dbModule.getDb();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO schedule_jobs(
      id, job_type, state, interval_sec, total_count, done_count, next_run_at, created_at, updated_at, payload_json, progress_json, request_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "sell_old",
    "sell_market",
    "completed",
    5,
    0,
    1,
    null,
    "2026-03-25T10:00:00.000Z",
    "2026-03-25T10:00:05.000Z",
    JSON.stringify({ symbol: "BTCUSDT" }),
    "{}",
    JSON.stringify({ symbol: "BTCUSDT" }),
  );

  db.prepare(
    `INSERT INTO schedule_jobs(
      id, job_type, state, interval_sec, total_count, done_count, next_run_at, created_at, updated_at, payload_json, progress_json, request_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "sell_new",
    "sell_market",
    "completed",
    5,
    0,
    2,
    null,
    "2026-03-25T11:00:00.000Z",
    now,
    JSON.stringify({ symbol: "ETHUSDT" }),
    "{}",
    JSON.stringify({ symbol: "ETHUSDT" }),
  );

  const storeModule = await import("../server/tasks/store.js");
  const job = storeModule.loadLatestTask("sell_market");

  assert.ok(job);
  assert.equal(job?.id, "sell_new");
  assert.equal(job?.job_type, "sell_market");
});
