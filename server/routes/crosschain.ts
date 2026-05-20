import crypto from "node:crypto";
import { Router } from "express";
import type { SessionManager } from "../security.js";
import { listOftRoutesByTokenAddress, listOfts } from "../onchain/layerzero.js";
import { countCrosschainHistory, listCrosschainHistory } from "../onchain/history.js";
import { previewCrosschainOft } from "../onchain/oft.js";
import { listValueTransferRoutesByTokenAddress } from "../onchain/value-transfer.js";
import { ensureRuntimeHydrated, hydrateTask } from "../tasks/hydration.js";
import { taskRuntime } from "../tasks/runtime.js";
import type { CrosschainOftTaskPayload, TaskJob } from "../tasks/types.js";

function parsePositiveInt(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return parsed;
}

function normalizePayload(body: Partial<CrosschainOftTaskPayload>): CrosschainOftTaskPayload {
  const nativeDropAmount = String(
    (body.lz_options?.executor?.nativeDrops?.[0]?.amount ?? ""),
  ).trim();
  const nativeDropReceiver = String(
    (body.lz_options?.executor?.nativeDrops?.[0]?.receiver ?? ""),
  ).trim();
  const nativeDrops = nativeDropAmount && nativeDropReceiver
    ? [{ amount: nativeDropAmount, receiver: nativeDropReceiver }]
    : undefined;
  const gasLimit = String(body.lz_options?.executor?.lzReceive?.gasLimit ?? "").trim();
  const dynamicAmount = body.dynamic_amount === true || String(body.dynamic_amount ?? "") === "true";
  const payload = {
    wallet_id: String(body.wallet_id ?? "").trim(),
    symbol: String(body.symbol ?? "").trim().toUpperCase() || "TRANSFER",
    src_chain: String(body.src_chain ?? "").trim(),
    dst_chain: String(body.dst_chain ?? "").trim(),
    token_address: String(body.token_address ?? "").trim(),
    dst_token_address: String(body.dst_token_address ?? "").trim(),
    amount: dynamicAmount ? "0" : String(body.amount ?? "").trim(),
    recipient: String(body.recipient ?? "").trim(),
    slippage_bps: Number(body.slippage_bps ?? 50),
    lz_options: gasLimit || nativeDrops
      ? {
        executor: {
          ...(gasLimit ? { lzReceive: { gasLimit } } : {}),
          ...(nativeDrops ? { nativeDrops } : {}),
        },
      }
      : undefined,
    compose_msg: String(body.compose_msg ?? "").trim() || undefined,
    oft_cmd: String(body.oft_cmd ?? "").trim() || undefined,
    interval_sec: body.interval_sec === undefined ? undefined : Number(body.interval_sec),
    mode: body.mode === "direct" ? "direct" as const : undefined,
    dynamic_amount: dynamicAmount || undefined,
    reserve_amount: (String(body.reserve_amount ?? "").trim()) || undefined,
  };
  if (!payload.wallet_id || !payload.src_chain || !payload.dst_chain || !payload.recipient) {
    throw new Error("wallet_id, src_chain, dst_chain, recipient are required");
  }
  if (!dynamicAmount && !payload.amount) {
    throw new Error("amount is required when not in sweep mode");
  }
  if (!payload.token_address || !payload.dst_token_address) {
    throw new Error("token_address and dst_token_address are required");
  }
  if (!Number.isInteger(payload.slippage_bps)) {
    throw new Error("slippage_bps must be an integer");
  }
  return payload;
}

export function crosschainRoutes(session: SessionManager): Router {
  const router = Router();

  router.get("/ofts", async (req, res) => {
    try {
      const symbol = typeof req.query.symbol === "string" ? req.query.symbol : undefined;
      const tokens = await listOfts({ symbol });
      res.json({ ok: true, tokens });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: "BAD_REQUEST", message });
    }
  });

  router.get("/routes", async (req, res) => {
    try {
      const srcChain = String(req.query.src_chain ?? "").trim();
      const tokenAddress = String(req.query.token_address ?? "").trim();
      if (!srcChain || !tokenAddress) {
        throw new Error("src_chain and token_address query params are required");
      }
      const [oftRoutes, valueTransferRoutes] = await Promise.all([
        listOftRoutesByTokenAddress(srcChain, tokenAddress).catch(() => []),
        listValueTransferRoutesByTokenAddress(srcChain, tokenAddress).catch(() => []),
      ]);
      const oftRouteKeys = new Set(oftRoutes.map((route) => `${route.dstChain}:${route.dstDeployment.address.toLowerCase()}`));
      const routes = [
        ...oftRoutes,
        ...valueTransferRoutes.filter((route) =>
          !oftRouteKeys.has(`${route.dstChain}:${route.dstDeployment.address.toLowerCase()}`),
        ),
      ];
      res.json({
        ok: true,
        routes,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: "BAD_REQUEST", message });
    }
  });

  router.post("/oft/preview", async (req, res) => {
    try {
      const payload = normalizePayload(req.body);
      const preview = await previewCrosschainOft(payload, session, req, payload.mode);
      res.json({ ok: true, preview });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: "BAD_REQUEST", message });
    }
  });

  router.post("/oft/execute", async (req, res) => {
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

      const payload = normalizePayload(req.body);
      const now = new Date().toISOString();
      const job: TaskJob = {
        id: `cc_${crypto.randomUUID()}`,
        job_type: "crosschain_oft",
        state: "running",
        interval_sec: 10,
        total_count: payload.dynamic_amount ? 0 : 1,
        done_count: 0,
        next_run_at: null,
        created_at: now,
        updated_at: now,
        payload,
        progress: { phase: "ready_to_send" },
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

  router.post("/oft/schedule/start", async (req, res) => {
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

      const payload = normalizePayload(req.body.crosschain ?? req.body);
      const intervalSec = parsePositiveInt(req.body.interval_sec ?? payload.interval_sec, "interval_sec");
      payload.interval_sec = intervalSec;

      const now = new Date().toISOString();
      const job: TaskJob = {
        id: `cc_${crypto.randomUUID()}`,
        job_type: "crosschain_oft",
        state: "running",
        interval_sec: intervalSec,
        total_count: payload.dynamic_amount ? 0 : parsePositiveInt(req.body.count, "count"),
        done_count: 0,
        next_run_at: null,
        created_at: now,
        updated_at: now,
        payload,
        progress: { phase: "ready_to_send" },
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

  router.get("/history", (req, res) => {
    const limit = Number(req.query.limit) || 20;
    const offset = Number(req.query.offset) || 0;
    res.json({
      ok: true,
      records: listCrosschainHistory(limit, offset),
      total: countCrosschainHistory(),
    });
  });

  return router;
}
