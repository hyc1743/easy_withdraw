import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

test("persistTaskJob supports legacy schedule_jobs tables where request_json is NOT NULL", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "easy-withdraw-legacy-constraint-"));
  process.env.EW_DATA_DIR = tempDir;

  const dbModule = await import("../server/db.js");
  dbModule.resetDbForTests();

  const dbPath = path.join(tempDir, "easy_withdraw.db");
  const legacyDb = new Database(dbPath);
  legacyDb.exec(`
    CREATE TABLE schedule_jobs (
      id TEXT PRIMARY KEY,
      job_type TEXT NOT NULL DEFAULT 'withdraw',
      state TEXT NOT NULL,
      interval_sec INTEGER NOT NULL,
      total_count INTEGER NOT NULL,
      done_count INTEGER NOT NULL,
      next_run_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      progress_json TEXT NOT NULL DEFAULT '{}',
      request_json TEXT NOT NULL
    );
    CREATE TABLE schedule_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      ok INTEGER NOT NULL,
      message TEXT NOT NULL
    );
  `);
  legacyDb.close();

  dbModule.resetDbForTests();
  const storeModule = await import("../server/tasks/store.js");

  assert.doesNotThrow(() => {
    storeModule.persistTaskJob({
      id: "sell_legacy",
      job_type: "sell_market",
      state: "running",
      interval_sec: 5,
      total_count: 0,
      done_count: 0,
      next_run_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      payload: {
        account_id: "BN-Main",
        symbol: "BTCUSDT",
        base_asset: "BTC",
        quote_asset: "USDT",
        step_amount: "0.001",
        interval_sec: 5,
      },
      progress: {},
      logs: [],
    });
  });

  const job = storeModule.loadTaskJob("sell_legacy");
  assert.ok(job);
  assert.equal(job?.job_type, "sell_market");
  assert.equal((job?.payload as { symbol?: string }).symbol, "BTCUSDT");
});
