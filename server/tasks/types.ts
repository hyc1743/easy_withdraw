import type { WithdrawRequest } from "../exchange/types.js";

export type TaskJobType = "withdraw" | "sell_market";
export type TaskState = "running" | "completed" | "stopped";

export interface SellMarketTaskPayload {
  account_id: string;
  symbol: string;
  base_asset: string;
  quote_asset: string;
  step_amount: string;
  interval_sec: number;
}

export type TaskPayload = WithdrawRequest | SellMarketTaskPayload;

export interface WithdrawTaskProgress {
  done_count?: number;
}

export interface SellMarketTaskProgress {
  done_count?: number;
  sold_total?: string;
  last_order_id?: string;
  last_executed_qty?: string;
  last_quote_qty?: string;
  last_price?: string;
  final_round?: boolean;
}

export type TaskProgress =
  | WithdrawTaskProgress
  | SellMarketTaskProgress
  | Record<string, never>;

export interface TaskLogRecord {
  timestamp: string;
  ok: boolean;
  message: string;
}

export interface TaskJob {
  id: string;
  job_type: TaskJobType;
  state: TaskState;
  interval_sec: number;
  total_count: number;
  done_count: number;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
  payload: TaskPayload;
  progress: TaskProgress;
  logs: TaskLogRecord[];
}

export interface TaskJobRow {
  id: string;
  job_type?: TaskJobType | null;
  state: TaskState;
  interval_sec: number;
  total_count: number;
  done_count: number;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
  payload_json?: string | null;
  progress_json?: string | null;
  request_json?: string | null;
}
