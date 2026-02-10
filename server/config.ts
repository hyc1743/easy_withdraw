import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { KdfParams } from "./security.js";

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

const CONFIG_DIR = path.join(os.homedir(), ".easy_withdraw");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const HISTORY_FILE = path.join(CONFIG_DIR, "history.json");

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}

export function getHistoryPath(): string {
  return HISTORY_FILE;
}

// --------------- Default Config ---------------

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

// --------------- Read / Write ---------------

export function loadConfig(): AppConfig {
  if (!fs.existsSync(CONFIG_FILE)) {
    return ensureConfig();
  }
  const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
  const cfg = JSON.parse(raw) as AppConfig;
  if (!cfg.address_book) cfg.address_book = [];
  if (!cfg.templates) cfg.templates = [];
  return cfg;
}

export function saveConfig(config: AppConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = CONFIG_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), "utf-8");
  fs.renameSync(tmp, CONFIG_FILE);
}

/** Ensure config dir and file exist; returns current config */
export function ensureConfig(): AppConfig {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_FILE)) {
    const cfg = defaultConfig();
    saveConfig(cfg);
    return cfg;
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as AppConfig;
}
