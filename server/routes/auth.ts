import { Router } from "express";
import {
  deriveKey,
  generateSalt,
  createVerifyTag,
  checkVerifyTag,
  DEFAULT_KDF_PARAMS,
  type SessionManager,
} from "../security.js";
import { loadConfig, saveConfig } from "../config.js";
import type { Request } from "express";

const MAX_FAILED_ATTEMPTS = 5;
const FAILED_WINDOW_MS = 10 * 60 * 1000;
const BLOCK_MS = 15 * 60 * 1000;

interface UnlockAttemptState {
  first_failed_at: number;
  failed_count: number;
  blocked_until: number;
}

const unlockAttempts = new Map<string, UnlockAttemptState>();

function getClientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function checkUnlockBlocked(ip: string): { blocked: boolean; retrySec: number } {
  const now = Date.now();
  const item = unlockAttempts.get(ip);
  if (!item) return { blocked: false, retrySec: 0 };

  if (item.blocked_until > now) {
    return {
      blocked: true,
      retrySec: Math.ceil((item.blocked_until - now) / 1000),
    };
  }

  if (now - item.first_failed_at > FAILED_WINDOW_MS) {
    unlockAttempts.delete(ip);
  }
  return { blocked: false, retrySec: 0 };
}

function markUnlockFailed(ip: string): void {
  const now = Date.now();
  const item = unlockAttempts.get(ip);
  if (!item || now - item.first_failed_at > FAILED_WINDOW_MS) {
    unlockAttempts.set(ip, {
      first_failed_at: now,
      failed_count: 1,
      blocked_until: 0,
    });
    return;
  }

  item.failed_count += 1;
  if (item.failed_count >= MAX_FAILED_ATTEMPTS) {
    item.blocked_until = now + BLOCK_MS;
  }
  unlockAttempts.set(ip, item);
}

function clearUnlockFailed(ip: string): void {
  unlockAttempts.delete(ip);
}

export function authRoutes(session: SessionManager): Router {
  const router = Router();

  // POST /api/auth/init
  router.post("/init", async (req, res) => {
    const { masterPassword } = req.body;
    if (!masterPassword || typeof masterPassword !== "string") {
      res.status(400).json({
        ok: false,
        error: "BAD_REQUEST",
        message: "masterPassword is required",
      });
      return;
    }

    const config = loadConfig();
    if (config.security) {
      res.status(409).json({
        ok: false,
        error: "ALREADY_INITIALIZED",
        message: "Master password already set",
      });
      return;
    }

    const salt = generateSalt();
    const key = await deriveKey(masterPassword, salt);
    const verifyTag = createVerifyTag(key);

    config.security = {
      kdf: "argon2id",
      salt_b64: salt.toString("base64"),
      verify_tag: verifyTag,
      kdf_params: { ...DEFAULT_KDF_PARAMS },
    };
    saveConfig(config);
    key.fill(0);

    res.json({ ok: true });
  });

  // POST /api/auth/unlock
  router.post("/unlock", async (req, res) => {
    const ip = getClientIp(req);
    const blocked = checkUnlockBlocked(ip);
    if (blocked.blocked) {
      res.status(429).json({
        ok: false,
        error: "TOO_MANY_ATTEMPTS",
        message: `Too many failed attempts, retry after ${blocked.retrySec}s`,
      });
      return;
    }

    const { masterPassword } = req.body;
    if (!masterPassword || typeof masterPassword !== "string") {
      res.status(400).json({
        ok: false,
        error: "BAD_REQUEST",
        message: "masterPassword is required",
      });
      return;
    }

    const config = loadConfig();
    if (!config.security) {
      res.status(400).json({
        ok: false,
        error: "NOT_INITIALIZED",
        message: "Master password not set yet",
      });
      return;
    }

    const salt = Buffer.from(config.security.salt_b64, "base64");
    const key = await deriveKey(
      masterPassword,
      salt,
      config.security.kdf_params,
    );

    if (!checkVerifyTag(config.security.verify_tag, key)) {
      key.fill(0);
      markUnlockFailed(ip);
      res.status(401).json({
        ok: false,
        error: "UNAUTHORIZED",
        message: "Incorrect master password",
      });
      return;
    }

    clearUnlockFailed(ip);
    session.unlock(key);
    res.json({ ok: true });
  });

  // POST /api/auth/lock
  router.post("/lock", (_req, res) => {
    session.lock();
    res.json({ ok: true });
  });

  // GET /api/auth/status
  router.get("/status", (_req, res) => {
    const config = loadConfig();
    res.json({
      initialized: config.security !== null,
      unlocked: session.isUnlocked,
    });
  });

  return router;
}
