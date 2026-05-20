import crypto from "node:crypto";
import { ethers } from "ethers";
import { Router } from "express";
import type { SessionManager } from "../security.js";
import { getWalletTokenBalance } from "../onchain/oft.js";
import {
  countDepositTransferHistory,
  listDepositTransferHistory,
} from "../onchain/deposit-history.js";
import { ensureRuntimeHydrated, hydrateTask } from "../tasks/hydration.js";
import { taskRuntime } from "../tasks/runtime.js";
import type { DexToCexArbitrageTaskPayload, TaskJob } from "../tasks/types.js";

function normalizeDexToCexPayload(body: Partial<DexToCexArbitrageTaskPayload>): DexToCexArbitrageTaskPayload {
  const crosschainRaw = body.crosschain;
  const hasCrosschain = !!crosschainRaw || (!!body.dst_chain && body.dst_chain !== body.src_chain);

  const payload: DexToCexArbitrageTaskPayload = {
    wallet_id: String(body.wallet_id ?? "").trim(),
    symbol: String(body.symbol ?? "").trim().toUpperCase() || "TRANSFER",
    src_chain: String(body.src_chain ?? "").trim(),
    dst_chain: String(body.dst_chain ?? "").trim() || undefined,
    token_address: String(body.token_address ?? "").trim(),
    dst_token_address: String(body.dst_token_address ?? "").trim() || undefined,
    threshold_amount: String(body.threshold_amount ?? "").trim(),
    interval_sec: Number(body.interval_sec ?? 60) || 60,
    deposit_address: String(body.deposit_address ?? "").trim(),
    slippage_bps: body.slippage_bps !== undefined ? Number(body.slippage_bps) : undefined,
    mode: body.mode === "direct" ? "direct" : body.mode === "api" ? "api" : undefined,
    reserve_amount: String(body.reserve_amount ?? "").trim() || undefined,
  };

  if (hasCrosschain) {
    // Normalize crosschain config from nested object or top-level fields
    if (crosschainRaw) {
      payload.crosschain = {
        dst_chain: String(crosschainRaw.dst_chain ?? "").trim(),
        dst_token_address: String(crosschainRaw.dst_token_address ?? "").trim(),
        slippage_bps: crosschainRaw.slippage_bps !== undefined ? Number(crosschainRaw.slippage_bps) : 50,
        mode: crosschainRaw.mode === "direct" ? "direct" : crosschainRaw.mode === "api" ? "api" : undefined,
        reserve_amount: String(crosschainRaw.reserve_amount ?? "").trim() || undefined,
      };
    } else {
      // Backward compat: top-level fields define crosschain
      payload.crosschain = {
        dst_chain: payload.dst_chain!,
        dst_token_address: payload.dst_token_address!,
        slippage_bps: payload.slippage_bps ?? 50,
        mode: payload.mode,
        reserve_amount: payload.reserve_amount,
      };
    }

    if (!payload.crosschain.dst_chain || !payload.crosschain.dst_token_address) {
      throw new Error("跨链模式需要填写目标链和目标 Token 地址");
    }
  }

  if (
    !payload.wallet_id ||
    !payload.src_chain ||
    !payload.token_address ||
    !payload.threshold_amount ||
    !payload.deposit_address
  ) {
    throw new Error("wallet_id, src_chain, token_address, threshold_amount, and deposit_address are required");
  }
  if (!ethers.isAddress(payload.deposit_address)) {
    throw new Error("deposit_address must be a valid EVM address");
  }
  if (!Number.isInteger(payload.interval_sec) || payload.interval_sec <= 0) {
    throw new Error("interval_sec must be a positive integer");
  }
  return payload;
}

export function arbitrageRoutes(session: SessionManager): Router {
  const router = Router();

  router.post("/dex-to-cex/preview", async (req, res) => {
    try {
      const payload = normalizeDexToCexPayload(req.body);
      const balance = await getWalletTokenBalance(
        payload.wallet_id,
        payload.src_chain,
        payload.token_address,
        session,
        req,
      );
      const threshold = Number(payload.threshold_amount);
      const willExecute = Number(balance.formatted) > threshold;
      res.json({
        ok: true,
        balance_available: balance.formatted,
        threshold_amount: payload.threshold_amount,
        will_execute: willExecute,
        deposit_chain: payload.crosschain ? payload.crosschain.dst_chain : payload.src_chain,
        has_crosschain: !!payload.crosschain,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: "BAD_REQUEST", message });
    }
  });

  router.post("/dex-to-cex/start", async (req, res) => {
    try {
      ensureRuntimeHydrated(session, req);
      if (taskRuntime.getActiveTask()) {
        res.status(409).json({
          ok: false,
          error: "SCHEDULE_RUNNING",
          message: "已有任务在运行，请先停止",
        });
        return;
      }

      const payload = normalizeDexToCexPayload(req.body);
      const now = new Date().toISOString();
      const job: TaskJob = {
        id: `d2c_${crypto.randomUUID()}`,
        job_type: "dex_to_cex_arbitrage",
        state: "running",
        interval_sec: payload.interval_sec,
        total_count: 0,
        done_count: 0,
        next_run_at: null,
        created_at: now,
        updated_at: now,
        payload,
        progress: { phase: "check_source_balance", completed_count: 0 },
        logs: [],
      };

      hydrateTask(job, session, req);
      void taskRuntime.runNow(job.id);
      res.json({ ok: true, job: taskRuntime.getTask(job.id) ?? job });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: "BAD_REQUEST", message });
    }
  });

  router.get("/dex-to-cex/history", (req, res) => {
    const limit = Number(req.query.limit) || 20;
    const offset = Number(req.query.offset) || 0;
    res.json({
      ok: true,
      records: listDepositTransferHistory(limit, offset),
      total: countDepositTransferHistory(),
    });
  });

  return router;
}
