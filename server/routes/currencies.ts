import { Router } from "express";
import { decrypt, type SessionManager } from "../security.js";
import { loadConfig } from "../config.js";
import { GateAdapter } from "../exchange/gate.js";
import type { ExchangeAdapter, DecryptedCreds } from "../exchange/types.js";

const adapters: Record<string, ExchangeAdapter> = {
  gate: new GateAdapter(),
};

function resolveCreds(
  accountId: string,
  session: SessionManager,
): { adapter: ExchangeAdapter; creds: DecryptedCreds } {
  const config = loadConfig();
  const acct = config.accounts.find((a) => a.id === accountId);
  if (!acct) throw new Error("Account not found");

  const adapter = adapters[acct.exchange];
  if (!adapter) throw new Error(`Unsupported exchange: ${acct.exchange}`);

  const key = session.getKey()!;
  const creds: DecryptedCreds = {
    api_key: acct.api_key,
    api_secret: acct.api_secret_enc ? decrypt(acct.api_secret_enc, key) : "",
    passphrase: acct.passphrase_enc
      ? decrypt(acct.passphrase_enc, key)
      : undefined,
  };
  return { adapter, creds };
}

export function currencyRoutes(session: SessionManager): Router {
  const router = Router();

  // GET /api/currencies?account_id=xxx
  router.get("/", async (req, res) => {
    try {
      const accountId = req.query.account_id as string;
      if (!accountId) {
        res.status(400).json({
          ok: false,
          error: "BAD_REQUEST",
          message: "account_id query param required",
        });
        return;
      }
      const { adapter, creds } = resolveCreds(accountId, session);
      const currencies = await adapter.listCurrencies(creds);
      res.json({ ok: true, currencies });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ ok: false, error: "EXCHANGE_ERROR", message: msg });
    }
  });

  // GET /api/currencies/:currency/chains?account_id=xxx
  router.get("/:currency/chains", async (req, res) => {
    try {
      const accountId = req.query.account_id as string;
      if (!accountId) {
        res.status(400).json({
          ok: false,
          error: "BAD_REQUEST",
          message: "account_id query param required",
        });
        return;
      }
      const { adapter, creds } = resolveCreds(accountId, session);
      const chains = await adapter.listChains(req.params.currency, creds);
      res.json({ ok: true, chains });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ ok: false, error: "EXCHANGE_ERROR", message: msg });
    }
  });

  return router;
}
