import crypto from "node:crypto";
import argon2 from "argon2";
import type { Request } from "express";

// --------------- KDF ---------------

export interface KdfParams {
  m_cost: number;
  t_cost: number;
  p: number;
}

export const DEFAULT_KDF_PARAMS: KdfParams = {
  m_cost: 47104,
  t_cost: 2,
  p: 1,
};

export async function deriveKey(
  password: string,
  salt: Buffer,
  params: KdfParams = DEFAULT_KDF_PARAMS,
): Promise<Buffer> {
  const hash = await argon2.hash(password, {
    type: argon2.argon2id,
    salt,
    memoryCost: params.m_cost,
    timeCost: params.t_cost,
    parallelism: params.p,
    hashLength: 32,
    raw: true,
  });
  return Buffer.from(hash);
}

export function generateSalt(): Buffer {
  return crypto.randomBytes(32);
}

// --------------- AES-256-GCM ---------------

const NONCE_LEN = 12;
const TAG_LEN = 16;

export function encrypt(plaintext: string, key: Buffer): string {
  const nonce = crypto.randomBytes(NONCE_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([nonce, encrypted, authTag]).toString("base64");
}

export function decrypt(encoded: string, key: Buffer): string {
  const buf = Buffer.from(encoded, "base64");
  const nonce = buf.subarray(0, NONCE_LEN);
  const authTag = buf.subarray(buf.length - TAG_LEN);
  const ciphertext = buf.subarray(NONCE_LEN, buf.length - TAG_LEN);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext) + decipher.final("utf8");
}

// --------------- Verify Tag ---------------

const VERIFY_PLAINTEXT = "easy_withdraw_verify";
export const SESSION_COOKIE_NAME = "ew_session";

export function createVerifyTag(key: Buffer): string {
  return encrypt(VERIFY_PLAINTEXT, key);
}

export function checkVerifyTag(verifyTag: string, key: Buffer): boolean {
  try {
    return decrypt(verifyTag, key) === VERIFY_PLAINTEXT;
  } catch {
    return false;
  }
}

interface SessionEntry {
  key: Buffer;
  timer: ReturnType<typeof setTimeout> | null;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const rawKey = part.slice(0, idx).trim();
    const rawValue = part.slice(idx + 1).trim();
    if (!rawKey) continue;
    out[rawKey] = decodeURIComponent(rawValue);
  }
  return out;
}

export class SessionManager {
  private sessions = new Map<string, SessionEntry>();
  private timeoutMs: number;

  constructor(timeoutMinutes: number = 15) {
    this.timeoutMs = timeoutMinutes * 60 * 1000;
  }

  createSession(key: Buffer): string {
    const sessionId = crypto.randomBytes(32).toString("hex");
    const entry: SessionEntry = {
      key: Buffer.from(key),
      timer: null,
    };
    this.sessions.set(sessionId, entry);
    this.resetTimer(sessionId);
    return sessionId;
  }

  destroySession(sessionId: string | null | undefined): void {
    if (!sessionId) return;
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.key.fill(0);
    this.clearTimer(entry);
    this.sessions.delete(sessionId);
  }

  isUnlocked(req: Request): boolean {
    return this.getKey(req) !== null;
  }

  getKey(req: Request): Buffer | null {
    const sessionId = this.getSessionId(req);
    if (!sessionId) return null;
    const entry = this.sessions.get(sessionId);
    if (!entry) return null;
    this.resetTimer(sessionId);
    return entry.key;
  }

  getSessionId(req: Request): string | null {
    const cookies = parseCookies(req.headers.cookie);
    const sessionId = cookies[SESSION_COOKIE_NAME];
    return sessionId || null;
  }

  setTimeoutMinutes(minutes: number): void {
    this.timeoutMs = minutes * 60 * 1000;
    for (const sessionId of this.sessions.keys()) {
      this.resetTimer(sessionId);
    }
  }

  private resetTimer(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.clearTimer(entry);
    entry.timer = setTimeout(() => this.destroySession(sessionId), this.timeoutMs);
  }

  private clearTimer(entry: SessionEntry): void {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  }
}
