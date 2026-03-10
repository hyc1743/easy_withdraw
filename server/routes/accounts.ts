import { Router } from "express";
import { encrypt, type SessionManager } from "../security.js";
import { loadConfig, saveConfig } from "../config.js";
import { supportedExchanges } from "../exchange/adapters.js";

export function accountRoutes(session: SessionManager): Router {
  const router = Router();

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
    if (!supportedExchanges.includes(exchange)) {
      res.status(400).json({
        ok: false,
        error: "BAD_REQUEST",
        message: `Unsupported exchange: ${exchange}`,
      });
      return;
    }

    const key = session.getKey(req);
    if (!key) {
      res.status(401).json({ ok: false, error: "UNAUTHORIZED", message: "Session not unlocked" });
      return;
    }

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

  router.get("/", (_req, res) => {
    const config = loadConfig();
    const accounts = config.accounts.map((a) => ({
      id: a.id,
      exchange: a.exchange,
      has_secret: a.api_secret_enc !== null,
    }));
    res.json({ accounts });
  });

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
