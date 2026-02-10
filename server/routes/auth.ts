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
      res.status(401).json({
        ok: false,
        error: "UNAUTHORIZED",
        message: "Incorrect master password",
      });
      return;
    }

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
