import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("schedule_jobs schema supports generalized task columns in isolated data dir", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "easy-withdraw-db-test-"));
  process.env.EW_DATA_DIR = tempDir;

  const dbModule = await import("../server/db.js");
  const db = dbModule.getDb();
  const dbPath = dbModule.getDbPath();
  const dataDir = dbModule.getDataDir();

  assert.equal(dataDir, tempDir);
  assert.equal(dbPath, path.join(tempDir, "easy_withdraw.db"));

  const columns = db
    .prepare("PRAGMA table_info(schedule_jobs)")
    .all() as Array<{ name: string }>;
  const names = columns.map((column) => column.name);

  assert.ok(names.includes("job_type"));
  assert.ok(names.includes("payload_json"));
  assert.ok(names.includes("progress_json"));
});
