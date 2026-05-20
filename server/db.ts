import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import type { AppConfig, AddressEntry, OnchainWalletConfig, WithdrawTemplate } from "./config.js";

interface LegacyConfig {
  version?: number;
  security?: AppConfig["security"];
  accounts?: AppConfig["accounts"];
  address_book?: AddressEntry[];
  templates?: WithdrawTemplate[];
  onchain_wallets?: OnchainWalletConfig[];
  layerzero_api_key_enc?: string | null;
  okx_web3?: AppConfig["okx_web3"];
  settings?: AppConfig["settings"];
}

function resolveDataDir(): string {
  const override = process.env.EW_DATA_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".easy_withdraw");
}

function resolveDbPath(dataDir: string): string {
  return path.join(dataDir, "easy_withdraw.db");
}

function resolveLegacyConfigPath(dataDir: string): string {
  return path.join(dataDir, "config.json");
}

function resolveLegacyHistoryPath(dataDir: string): string {
  return path.join(dataDir, "history.json");
}

let db: Database.Database | null = null;

function defaultConfig(): AppConfig {
  return {
    version: 1,
    security: null,
    accounts: [],
    address_book: [],
    templates: [],
    onchain_wallets: [],
    layerzero_api_key_enc: null,
    okx_web3: null,
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
  if (Array.isArray(raw.onchain_wallets)) cfg.onchain_wallets = raw.onchain_wallets;
  if (raw.layerzero_api_key_enc !== undefined) {
    cfg.layerzero_api_key_enc = raw.layerzero_api_key_enc;
  }
  if (raw.okx_web3 !== undefined) {
    cfg.okx_web3 = raw.okx_web3;
  }
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
      request_json TEXT
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

    CREATE TABLE IF NOT EXISTS crosschain_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      wallet_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      src_chain TEXT NOT NULL,
      dst_chain TEXT NOT NULL,
      amount TEXT NOT NULL,
      recipient TEXT NOT NULL,
      source_tx_hash TEXT,
      destination_tx_hash TEXT,
      guid TEXT,
      lz_status TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_crosschain_history_id
      ON crosschain_history(id DESC);

    CREATE TABLE IF NOT EXISTS deposit_transfer_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      wallet_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      chain TEXT NOT NULL,
      token_address TEXT NOT NULL,
      deposit_address TEXT NOT NULL,
      amount TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_deposit_transfer_history_id
      ON deposit_transfer_history(id DESC);
  `);

  const scheduleJobColumns = conn
    .prepare("PRAGMA table_info(schedule_jobs)")
    .all() as Array<{ name: string }>;
  const columnNames = new Set(scheduleJobColumns.map((column) => column.name));

  if (!columnNames.has("job_type")) {
    conn.exec(
      "ALTER TABLE schedule_jobs ADD COLUMN job_type TEXT NOT NULL DEFAULT 'withdraw'",
    );
  }
  if (!columnNames.has("payload_json")) {
    conn.exec(
      "ALTER TABLE schedule_jobs ADD COLUMN payload_json TEXT NOT NULL DEFAULT '{}'",
    );
  }
  if (!columnNames.has("progress_json")) {
    conn.exec(
      "ALTER TABLE schedule_jobs ADD COLUMN progress_json TEXT NOT NULL DEFAULT '{}'",
    );
  }
  if (!columnNames.has("request_json")) {
    conn.exec("ALTER TABLE schedule_jobs ADD COLUMN request_json TEXT");
  }

  conn.exec(`
    UPDATE schedule_jobs
    SET payload_json = COALESCE(NULLIF(payload_json, '{}'), request_json, '{}')
    WHERE payload_json IS NULL OR payload_json = '{}'
  `);
}

function migrateFromLegacyFiles(conn: Database.Database): void {
  const cfgRow = conn
    .prepare("SELECT value FROM kv_store WHERE key = 'app_config'")
    .get() as { value: string } | undefined;

  if (!cfgRow) {
    let cfg = defaultConfig();
    const legacyConfigPath = getLegacyConfigPath();
    if (fs.existsSync(legacyConfigPath)) {
      const raw = parseJsonSafe<LegacyConfig>(
        fs.readFileSync(legacyConfigPath, "utf-8"),
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
  const legacyHistoryPath = getLegacyHistoryPath();
  if (histCount.n > 0 || !fs.existsSync(legacyHistoryPath)) {
    return;
  }

  const legacyRows = parseJsonSafe<Array<Record<string, unknown>>>(
    fs.readFileSync(legacyHistoryPath, "utf-8"),
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
  return resolveDataDir();
}

export function getDbPath(): string {
  return resolveDbPath(getDataDir());
}

export function getLegacyConfigPath(): string {
  return resolveLegacyConfigPath(getDataDir());
}

export function getLegacyHistoryPath(): string {
  return resolveLegacyHistoryPath(getDataDir());
}

export function getDb(): Database.Database {
  if (db) return db;
  const dataDir = getDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  db = new Database(getDbPath());
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  ensureSchema(db);
  migrateFromLegacyFiles(db);
  return db;
}

export function resetDbForTests(): void {
  if (!db) return;
  db.close();
  db = null;
}
