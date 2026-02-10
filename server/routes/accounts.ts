import { Router } from "express";
import { encrypt, type SessionManager } from "../security.js";
import { loadConfig, saveConfig } from "../config.js";

export function accountRoutes(session: SessionManager): Router {
  const router = Router();

  // POST /api/accounts — Upsert
  router.post("/", (req, res) => {
    const { id, exchange, api_key, api_secret, passphrase } = req.body;
    if (!id || !exchange || !api_key) {
      res.status(400).json({
        ok: false,
        error: "BAD_REQUEST",
        message: "id, exchange, api_key are required",
      });
      return;
    }

    const key = session.getKey()!;
    const config = loadConfig();

    const account = {
      id,
      exchange,
      api_key,
      api_secret_enc: api_secret ? encrypt(api_secret, key) : null,
      passphrase_enc: passphrase ? encrypt(passphrase, key) : null,
    };

    const idx = config.accounts.findIndex((a) => a.id === id);
    if (idx >= 0) {
      config.accounts[idx] = account;
    } else {
      config.accounts.push(account);
    }
    saveConfig(config);

    res.json({ ok: true });
  });

  // GET /api/accounts — list (sanitized)
  router.get("/", (_req, res) => {
    const config = loadConfig();
    const accounts = config.accounts.map((a) => ({
      id: a.id,
      exchange: a.exchange,
      has_secret: a.api_secret_enc !== null,
    }));
    res.json({ accounts });
  });

  // DELETE /api/accounts/:id
  router.delete("/:id", (req, res) => {
    const config = loadConfig();
    const idx = config.accounts.findIndex((a) => a.id === req.params.id);
    if (idx < 0) {
      res.status(404).json({
        ok: false,
        error: "BAD_REQUEST",
        message: "Account not found",
      });
      return;
    }
    config.accounts.splice(idx, 1);
    saveConfig(config);
    res.json({ ok: true });
  });

  return router;
}
