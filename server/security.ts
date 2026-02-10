import crypto from "node:crypto";
import argon2 from "argon2";

// --------------- KDF ---------------

export interface KdfParams {
  m_cost: number; // memory in KiB
  t_cost: number; // iterations
  p: number; // parallelism
}

export const DEFAULT_KDF_PARAMS: KdfParams = {
  m_cost: 47104, // ~46 MB, OWASP recommended
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
    hashLength: 32, // 256 bits for AES-256
    raw: true,
  });
  return Buffer.from(hash);
}

export function generateSalt(): Buffer {
  return crypto.randomBytes(32);
}

// --------------- AES-256-GCM ---------------

const NONCE_LEN = 12; // 96 bits, recommended for GCM
const TAG_LEN = 16; // 128 bits auth tag

/** Encrypt plaintext. Returns base64 string of: nonce(12) + ciphertext + authTag(16) */
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

/** Decrypt base64 string produced by encrypt(). Returns plaintext. */
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

/** Generate a verify_tag for password correctness check */
export function createVerifyTag(key: Buffer): string {
  return encrypt(VERIFY_PLAINTEXT, key);
}

/** Check if the key can correctly decrypt the verify_tag */
export function checkVerifyTag(verifyTag: string, key: Buffer): boolean {
  try {
    return decrypt(verifyTag, key) === VERIFY_PLAINTEXT;
  } catch {
    return false;
  }
}

// --------------- Session Manager ---------------

export class SessionManager {
  private derivedKey: Buffer | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timeoutMs: number;

  constructor(timeoutMinutes: number = 15) {
    this.timeoutMs = timeoutMinutes * 60 * 1000;
  }

  unlock(key: Buffer): void {
    this.derivedKey = key;
    this.resetTimer();
  }

  lock(): void {
    if (this.derivedKey) {
      this.derivedKey.fill(0);
      this.derivedKey = null;
    }
    this.clearTimer();
  }

  get isUnlocked(): boolean {
    return this.derivedKey !== null;
  }

  getKey(): Buffer | null {
    if (this.derivedKey) this.resetTimer();
    return this.derivedKey;
  }

  setTimeoutMinutes(minutes: number): void {
    this.timeoutMs = minutes * 60 * 1000;
    if (this.isUnlocked) this.resetTimer();
  }

  private resetTimer(): void {
    this.clearTimer();
    this.timer = setTimeout(() => this.lock(), this.timeoutMs);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
