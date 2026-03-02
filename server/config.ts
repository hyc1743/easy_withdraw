import type { KdfParams } from "./security.js";
import {
  getDb,
  getDataDir,
  getLegacyConfigPath,
  getLegacyHistoryPath,
} from "./db.js";

// --------------- Types ---------------

export interface AccountConfig {
  id: string;
  exchange: string;
  api_key: string;
  api_secret_enc: string | null;
  passphrase_enc: string | null;
}

export interface AddressEntry {
  label: string;
  address: string;
}

export interface WithdrawTemplate {
  name: string;
  account_id: string;
  asset: string;
  network: string;
  address: string;
  amount: string;
}

export interface AppConfig {
  version: number;
  security: {
    kdf: string;
    salt_b64: string;
    verify_tag: string;
    kdf_params: KdfParams;
  } | null;
  accounts: AccountConfig[];
  address_book: AddressEntry[];
  templates: WithdrawTemplate[];
  settings: {
    host: string;
    port: number;
    session_timeout_min: number;
  };
}

// --------------- Paths ---------------

const CONFIG_DIR = getDataDir();
const CONFIG_FILE = getLegacyConfigPath();
const HISTORY_FILE = getLegacyHistoryPath();

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}

export function getHistoryPath(): string {
  return HISTORY_FILE;
}

// --------------- Read / Write ---------------

export function loadConfig(): AppConfig {
  const db = getDb();
  const row = db
    .prepare("SELECT value FROM kv_store WHERE key = 'app_config'")
    .get() as { value: string } | undefined;
  if (!row) return ensureConfig();
  const cfg = JSON.parse(row.value) as AppConfig;
  if (!cfg.address_book) cfg.address_book = [];
  if (!cfg.templates) cfg.templates = [];
  if (!cfg.settings.host) cfg.settings.host = "127.0.0.1";
  return cfg;
}

export function saveConfig(config: AppConfig): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO kv_store(key, value) VALUES ('app_config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(JSON.stringify(config));
}

/** Ensure config dir and file exist; returns current config */
export function ensureConfig(): AppConfig {
  const db = getDb();
  const row = db
    .prepare("SELECT value FROM kv_store WHERE key = 'app_config'")
    .get() as { value: string } | undefined;
  if (row) return JSON.parse(row.value) as AppConfig;

  const cfg: AppConfig = {
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
  saveConfig(cfg);
  return cfg;
}
