import { isAddress } from "ethers";
import type { AppConfig } from "../config.js";
import type { ArbitrageTaskPayload, DexToCexArbitrageTaskPayload, TaskJob } from "./types.js";

export function editStoppedArbitrage(
  job: TaskJob,
  input: Record<string, unknown>,
  config: Pick<AppConfig, "accounts" | "onchain_wallets">,
): TaskJob {
  if (job.state !== "stopped") throw new Error("仅已停止任务可以编辑");
  if (!["arbitrage", "dex_to_cex_arbitrage"].includes(job.job_type)) throw new Error("仅支持编辑搬砖任务");
  const allowed = ["updated_at", "source_id", "target_address", "threshold_amount", "interval_sec"];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error("包含不支持的编辑字段");
  const threshold = String(input.threshold_amount ?? "").trim();
  const interval = Number(input.interval_sec);
  if (!threshold || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(threshold) || !Number.isFinite(Number(threshold))) {
    throw new Error("触发阈值必须为非负数");
  }
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > 2147483) {
    throw new Error("扫描间隔必须为 1 至 2147483 的整数秒");
  }
  const source = String(input.source_id ?? "").trim();
  const target = String(input.target_address ?? "").trim();
  if (!source || !target || target.length > 256 || /\s/.test(target)) throw new Error("请选择有效的来源和目标地址");
  const result = structuredClone(job);
  const d2c = job.job_type === "dex_to_cex_arbitrage";
  const payload = result.payload as ArbitrageTaskPayload | DexToCexArbitrageTaskPayload;
  const oldSource = d2c ? (payload as DexToCexArbitrageTaskPayload).wallet_id : (payload as ArbitrageTaskPayload).account_id;
  const cexPayload = payload as ArbitrageTaskPayload;
  const oldTarget = d2c ? (payload as DexToCexArbitrageTaskPayload).deposit_address
    : cexPayload.crosschain
      ? cexPayload.crosschain.recipient || config.onchain_wallets.find(wallet => wallet.id === cexPayload.crosschain?.wallet_id)?.address || cexPayload.address
      : cexPayload.address;
  const changed = source !== oldSource || target !== oldTarget;
  const idlePhase = d2c ? "check_source_balance" : "check_balance";
  if (changed && (job.progress as { phase?: string }).phase !== idlePhase) {
    throw new Error("当前阶段存在未完成操作，只能修改阈值和扫描间隔；完成本轮后再更换账户");
  }
  if (d2c) {
    if (!config.onchain_wallets.some(wallet => wallet.id === source)) throw new Error("来源钱包不存在");
    if (!isAddress(target)) throw new Error("目标必须是有效的 EVM 充值地址");
    (payload as DexToCexArbitrageTaskPayload).wallet_id = source;
    (payload as DexToCexArbitrageTaskPayload).deposit_address = target;
  } else {
    if (!config.accounts.some(account => account.id === source)) throw new Error("来源交易所账户不存在");
    const cex = payload as ArbitrageTaskPayload;
    if (cex.crosschain) {
      if (!isAddress(target)) throw new Error("跨链收款地址必须是有效的 EVM 地址");
      cex.crosschain.recipient = target;
    } else {
      if (cex.address_tag && target !== cex.address) throw new Error("此任务包含 Memo/Tag，请新建任务以同时确认地址和 Memo/Tag");
      cex.address = target;
    }
    cex.account_id = source;
  }
  payload.threshold_amount = threshold;
  payload.interval_sec = interval;
  result.interval_sec = interval;
  result.next_run_at = null;
  result.updated_at = new Date(Math.max(Date.now(), Date.parse(job.updated_at) + 1)).toISOString();
  if (changed) {
    result.progress = d2c
      ? { phase: "check_source_balance", completed_count: (job.progress as { completed_count?: number }).completed_count ?? job.done_count }
      : { phase: "check_balance", withdraw_count: (job.progress as { withdraw_count?: number }).withdraw_count ?? 0,
          delivered_count: (job.progress as { delivered_count?: number }).delivered_count ?? 0 };
  }
  return result;
}
