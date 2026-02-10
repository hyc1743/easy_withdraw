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

export interface AppConfig {
  version: number;
  security: {
    kdf: string;
    salt_b64: string;
    verify_tag: string;
    kdf_params: KdfParams;
  } | null;
  accounts: AccountConfig[];
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
  return JSON.parse(raw) as AppConfig;
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
