import { Router } from "express";
import { decrypt, encrypt, type SessionManager } from "../security.js";
import { loadConfig, saveConfig } from "../config.js";
import { supportedExchanges } from "../exchange/adapters.js";
import { okxFundsTransfer } from "../exchange/okx.js";

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

  router.get("/:id", (req, res) => {
    const config = loadConfig();
    const account = config.accounts.find((a) => a.id === req.params.id);
    if (!account) {
      res.status(404).json({
        ok: false,
        error: "BAD_REQUEST",
        message: "Account not found",
      });
      return;
    }

    res.json({
      account: {
        id: account.id,
        exchange: account.exchange,
        api_key: account.api_key,
        has_secret: account.api_secret_enc !== null,
        has_passphrase: account.passphrase_enc !== null,
      },
    });
  });

  router.put("/:id", (req, res) => {
    const { exchange, api_key, api_secret, passphrase } = req.body;
    if (!exchange || !api_key) {
      res.status(400).json({
        ok: false,
        error: "BAD_REQUEST",
        message: "exchange, api_key are required",
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
    const idx = config.accounts.findIndex((a) => a.id === req.params.id);
    if (idx < 0) {
      res.status(404).json({
        ok: false,
        error: "BAD_REQUEST",
        message: "Account not found",
      });
      return;
    }

    const current = config.accounts[idx];
    const nextId = typeof req.body.id === "string" && req.body.id ? req.body.id : current.id;
    if (nextId !== current.id && config.accounts.some((a) => a.id === nextId)) {
      res.status(409).json({
        ok: false,
        error: "CONFLICT",
        message: "Account id already exists",
      });
      return;
    }

    config.accounts[idx] = {
      id: nextId,
      exchange,
      api_key,
      api_secret_enc: typeof api_secret === "string" && api_secret
        ? encrypt(api_secret, key)
        : current.api_secret_enc,
      passphrase_enc: passphrase === null
        ? null
        : (typeof passphrase === "string" && passphrase
          ? encrypt(passphrase, key)
          : current.passphrase_enc),
    };
    saveConfig(config);

    res.json({ ok: true, id: nextId });
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

  router.post("/:id/okx-transfer", async (req, res) => {
    try {
      const config = loadConfig();
      const account = config.accounts.find((a) => a.id === req.params.id);
      if (!account) {
        res.status(404).json({
          ok: false,
          error: "BAD_REQUEST",
          message: "Account not found",
        });
        return;
      }
      if (account.exchange !== "okx") {
        res.status(400).json({
          ok: false,
          error: "BAD_REQUEST",
          message: "Only OKX accounts support this endpoint",
        });
        return;
      }

      const key = session.getKey(req);
      if (!key) {
        res.status(401).json({ ok: false, error: "UNAUTHORIZED", message: "Session not unlocked" });
        return;
      }

      const creds = {
        api_key: account.api_key,
        api_secret: account.api_secret_enc ? decrypt(account.api_secret_enc, key) : "",
        passphrase: account.passphrase_enc ? decrypt(account.passphrase_enc, key) : undefined,
      };

      const result = await okxFundsTransfer({
        ccy: req.body.ccy,
        amt: req.body.amt,
        from: req.body.from,
        to: req.body.to,
        clientId: req.body.clientId,
      }, creds);

      res.json({ ok: true, transfer: result });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(400).json({ ok: false, error: "BAD_REQUEST", message: msg });
    }
  });

  return router;
}
