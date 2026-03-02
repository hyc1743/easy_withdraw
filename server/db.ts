import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import type { AppConfig, AddressEntry, WithdrawTemplate } from "./config.js";

interface LegacyConfig {
  version?: number;
  security?: AppConfig["security"];
  accounts?: AppConfig["accounts"];
  address_book?: AddressEntry[];
  templates?: WithdrawTemplate[];
  settings?: AppConfig["settings"];
}

const DATA_DIR = path.join(os.homedir(), ".easy_withdraw");
const DB_PATH = path.join(DATA_DIR, "easy_withdraw.db");
const LEGACY_CONFIG_PATH = path.join(DATA_DIR, "config.json");
const LEGACY_HISTORY_PATH = path.join(DATA_DIR, "history.json");

let db: Database.Database | null = null;

function defaultConfig(): AppConfig {
  return {
    version: 1,
    security: null,
    accounts: [],
    address_book: [],
    templates: [],
    settings: {
      host: "127.0.0.1",
      port: 4217,
      session_timeout_min: 15,
    },
  };
}

function normalizeConfig(raw: LegacyConfig): AppConfig {
  const cfg = defaultConfig();
  if (raw.version) cfg.version = raw.version;
  if (raw.security !== undefined) cfg.security = raw.security;
  if (Array.isArray(raw.accounts)) cfg.accounts = raw.accounts;
  if (Array.isArray(raw.address_book)) cfg.address_book = raw.address_book;
  if (Array.isArray(raw.templates)) cfg.templates = raw.templates;
  if (raw.settings) {
    cfg.settings = {
      host: raw.settings.host || cfg.settings.host,
      port: raw.settings.port || cfg.settings.port,
      session_timeout_min:
        raw.settings.session_timeout_min || cfg.settings.session_timeout_min,
    };
  }
  return cfg;
}

function parseJsonSafe<T>(content: string, fallback: T): T {
  try {
    return JSON.parse(content) as T;
  } catch {
    return fallback;
  }
}

function ensureSchema(conn: Database.Database): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS withdraw_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      account_id TEXT NOT NULL,
      exchange TEXT NOT NULL,
      asset TEXT NOT NULL,
      network TEXT NOT NULL,
      address TEXT NOT NULL,
      amount TEXT NOT NULL,
      withdraw_id TEXT NOT NULL,
      status TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schedule_jobs (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      interval_sec INTEGER NOT NULL,
      total_count INTEGER NOT NULL,
      done_count INTEGER NOT NULL,
      next_run_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      request_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schedule_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      ok INTEGER NOT NULL,
      message TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_schedule_logs_job_id_id
      ON schedule_logs(job_id, id DESC);
  `);
}

function migrateFromLegacyFiles(conn: Database.Database): void {
  const cfgRow = conn
    .prepare("SELECT value FROM kv_store WHERE key = 'app_config'")
    .get() as { value: string } | undefined;

  if (!cfgRow) {
    let cfg = defaultConfig();
    if (fs.existsSync(LEGACY_CONFIG_PATH)) {
      const raw = parseJsonSafe<LegacyConfig>(
        fs.readFileSync(LEGACY_CONFIG_PATH, "utf-8"),
        {},
      );
      cfg = normalizeConfig(raw);
    }
    conn
      .prepare("INSERT INTO kv_store(key, value) VALUES ('app_config', ?)")
      .run(JSON.stringify(cfg));
  }

  const histCount = conn
    .prepare("SELECT COUNT(1) as n FROM withdraw_history")
    .get() as { n: number };
  if (histCount.n > 0 || !fs.existsSync(LEGACY_HISTORY_PATH)) {
    return;
  }

  const legacyRows = parseJsonSafe<Array<Record<string, unknown>>>(
    fs.readFileSync(LEGACY_HISTORY_PATH, "utf-8"),
    [],
  );
  if (!Array.isArray(legacyRows) || legacyRows.length === 0) {
    return;
  }

  const insert = conn.prepare(`
    INSERT INTO withdraw_history(
      timestamp, account_id, exchange, asset, network, address, amount, withdraw_id, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = conn.transaction((rows: Array<Record<string, unknown>>) => {
    for (const row of rows) {
      insert.run(
        String(row.timestamp ?? new Date().toISOString()),
        String(row.account_id ?? ""),
        String(row.exchange ?? ""),
        String(row.asset ?? ""),
        String(row.network ?? ""),
        String(row.address ?? ""),
        String(row.amount ?? ""),
        String(row.withdraw_id ?? ""),
        String(row.status ?? "unknown"),
      );
    }
  });
  tx(legacyRows);
}

export function getDataDir(): string {
  return DATA_DIR;
}

export function getDbPath(): string {
  return DB_PATH;
}

export function getLegacyConfigPath(): string {
  return LEGACY_CONFIG_PATH;
}

export function getLegacyHistoryPath(): string {
  return LEGACY_HISTORY_PATH;
}

export function getDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  ensureSchema(db);
  migrateFromLegacyFiles(db);
  return db;
}
