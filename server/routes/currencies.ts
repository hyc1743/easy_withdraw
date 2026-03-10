import { Router, type Request } from "express";
import { decrypt, type SessionManager } from "../security.js";
import { loadConfig } from "../config.js";
import { adapters } from "../exchange/adapters.js";
import type { DecryptedCreds, ExchangeAdapter } from "../exchange/types.js";

function resolveCreds(
  accountId: string,
  session: SessionManager,
  req: Request,
): { adapter: ExchangeAdapter; creds: DecryptedCreds } {
  const config = loadConfig();
  const acct = config.accounts.find((a) => a.id === accountId);
  if (!acct) throw new Error("Account not found");

  const adapter = adapters[acct.exchange];
  if (!adapter) throw new Error(`Unsupported exchange: ${acct.exchange}`);

  const key = session.getKey(req);
  if (!key) throw new Error("Session not unlocked");

  const creds: DecryptedCreds = {
    api_key: acct.api_key,
    api_secret: acct.api_secret_enc ? decrypt(acct.api_secret_enc, key) : "",
    passphrase: acct.passphrase_enc ? decrypt(acct.passphrase_enc, key) : undefined,
  };
  return { adapter, creds };
}

export function currencyRoutes(session: SessionManager): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    try {
      const accountId = req.query.account_id as string;
      if (!accountId) {
        res.status(400).json({ ok: false, error: "BAD_REQUEST", message: "account_id query param required" });
        return;
      }
      const { adapter, creds } = resolveCreds(accountId, session, req);
      const currencies = await adapter.listCurrencies(creds);
      res.json({ ok: true, currencies });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ ok: false, error: "EXCHANGE_ERROR", message: msg });
    }
  });

  router.get("/:currency/chains", async (req, res) => {
    try {
      const accountId = req.query.account_id as string;
      if (!accountId) {
        res.status(400).json({ ok: false, error: "BAD_REQUEST", message: "account_id query param required" });
        return;
      }
      const { adapter, creds } = resolveCreds(accountId, session, req);
      const chains = await adapter.listChains(req.params.currency, creds);
      res.json({ ok: true, chains });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ ok: false, error: "EXCHANGE_ERROR", message: msg });
    }
  });

  router.get("/:currency/balance", async (req, res) => {
    try {
      const accountId = req.query.account_id as string;
      if (!accountId) {
        res.status(400).json({ ok: false, error: "BAD_REQUEST", message: "account_id query param required" });
        return;
      }
      const { adapter, creds } = resolveCreds(accountId, session, req);
      const balance = await adapter.getBalance(req.params.currency, creds);
      res.json({ ok: true, balance });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ ok: false, error: "EXCHANGE_ERROR", message: msg });
    }
  });

  return router;
}
