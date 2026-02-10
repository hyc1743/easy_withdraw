import fs from "node:fs";
import { Router } from "express";
import { decrypt, type SessionManager } from "../security.js";
import { loadConfig, getHistoryPath } from "../config.js";
import { GateAdapter } from "../exchange/gate.js";
import type {
  ExchangeAdapter,
  WithdrawRequest,
  DecryptedCreds,
} from "../exchange/types.js";

const adapters: Record<string, ExchangeAdapter> = {
  gate: new GateAdapter(),
};

interface HistoryRecord {
  timestamp: string;
  account_id: string;
  exchange: string;
  asset: string;
  network: string;
  address: string;
  amount: string;
  withdraw_id: string;
  status: string;
}

function appendHistory(record: HistoryRecord): void {
  const histPath = getHistoryPath();
  let records: HistoryRecord[] = [];
  if (fs.existsSync(histPath)) {
    records = JSON.parse(fs.readFileSync(histPath, "utf-8"));
  }
  records.push(record);
  fs.writeFileSync(histPath, JSON.stringify(records, null, 2), "utf-8");
}

function resolveAccount(
  accountId: string,
  session: SessionManager,
): { adapter: ExchangeAdapter; creds: DecryptedCreds; exchange: string } {
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
  return { adapter, creds, exchange: acct.exchange };
}

export function withdrawRoutes(session: SessionManager): Router {
  const router = Router();

  // POST /api/withdraw/preview
  router.post("/preview", async (req, res) => {
    try {
      const wReq = req.body as WithdrawRequest;
      const { adapter } = resolveAccount(wReq.account_id, session);
      await adapter.validateRequest(wReq);
      res.json({ ok: true, message: "Validation passed" });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(400).json({ ok: false, error: "BAD_REQUEST", message: msg });
    }
  });

  // POST /api/withdraw/execute
  router.post("/execute", async (req, res) => {
    try {
      const wReq = req.body as WithdrawRequest;
      const { adapter, creds, exchange } = resolveAccount(
        wReq.account_id,
        session,
      );
      await adapter.validateRequest(wReq);
      const result = await adapter.withdraw(wReq, creds);

      appendHistory({
        timestamp: new Date().toISOString(),
        account_id: wReq.account_id,
        exchange,
        asset: wReq.asset,
        network: wReq.network,
        address: wReq.address,
        amount: wReq.amount,
        withdraw_id: result.withdraw_id,
        status: result.status,
      });

      res.json(result);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({
        ok: false,
        error: "EXCHANGE_ERROR",
        message: msg,
      });
    }
  });

  // GET /api/withdraw/history — must be before /:id
  router.get("/history", (_req, res) => {
    const histPath = getHistoryPath();
    let records: HistoryRecord[] = [];
    if (fs.existsSync(histPath)) {
      records = JSON.parse(fs.readFileSync(histPath, "utf-8"));
    }
    const limit = Number(_req.query.limit) || 20;
    const offset = Number(_req.query.offset) || 0;
    const page = records.reverse().slice(offset, offset + limit);
    res.json({ records: page, total: records.length });
  });

  // GET /api/withdraw/:id
  router.get("/:id", async (req, res) => {
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
      const { adapter, creds } = resolveAccount(accountId, session);
      const result = await adapter.queryStatus(req.params.id, creds);
      res.json(result);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({
        ok: false,
        error: "EXCHANGE_ERROR",
        message: msg,
      });
    }
  });

  return router;
}
