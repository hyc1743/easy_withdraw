import type { WithdrawRequest } from "../exchange/types.js";

export type TaskJobType =
  | "withdraw"
  | "sell_market"
  | "crosschain_oft"
  | "arbitrage"
  | "dex_to_cex_arbitrage";
export type TaskState = "running" | "completed" | "stopped";

export interface SellMarketTaskPayload {
  account_id: string;
  symbol: string;
  base_asset: string;
  quote_asset: string;
  step_amount: string;
  interval_sec: number;
}

export interface CrosschainOftTaskPayload {
  wallet_id: string;
  symbol: string;
  src_chain: string;
  dst_chain: string;
  token_address?: string;
  dst_token_address?: string;
  amount: string;
  recipient: string;
  slippage_bps: number;
  lz_options?: {
    executor?: {
      lzReceive?: {
        gasLimit?: string;
      };
      nativeDrops?: Array<{
        amount: string;
        receiver: string;
      }>;
    };
  };
  compose_msg?: string;
  oft_cmd?: string;
  interval_sec?: number;
  /** "api" (LayerZero Transfer API, requires API key) or "direct" (on-chain OFT contract) */
  mode?: "api" | "direct";
  /** When true: each round reads wallet token balance via RPC and sends ALL of it.
      The `amount` field is ignored; total_count is forced to 0 (indefinite). */
  dynamic_amount?: boolean;
  /** Sweep mode: amount to keep on the source wallet (human-readable).
      The sweep sends max(0, balance - reserve_amount). */
  reserve_amount?: string;
}

export type CrosschainOftPhase =
  | "ready_to_send"
  | "waiting_delivery"
  | "delivered";

export interface CrosschainOftTaskProgress {
  phase?: CrosschainOftPhase;
  source_tx_hash?: string;
  destination_tx_hash?: string;
  guid?: string;
  quote_id?: string;
  lz_status?: string;
  approval_tx_hash?: string;
  delivered_count?: number;
  /** The on-chain token balance read at the start of the last sweep round (human-readable) */
  dynamic_balance?: string;
}

// --------------- Arbitrage (搬砖) Types ---------------

export type ArbitragePhase =
  | "check_balance"
  | "wait_withdrawal"
  | "do_crosschain"
  | "wait_delivery";

export interface ArbitrageTaskPayload {
  account_id: string;
  asset: string;
  network: string;
  address: string;
  address_tag?: string | null;
  threshold_amount: string;
  interval_sec: number;
  crosschain?: {
    wallet_id: string;
    src_chain: string;
    dst_chain: string;
    token_address: string;
    dst_token_address?: string;
    recipient: string;
    slippage_bps: number;
    mode?: "api" | "direct";
    reserve_amount?: string;
    symbol?: string;
  };
}

export interface ArbitrageTaskProgress {
  phase?: ArbitragePhase;
  withdraw_count: number;
  last_balance?: string;
  last_withdraw_id?: string;
  source_tx_hash?: string;
  destination_tx_hash?: string;
  guid?: string;
  lz_status?: string;
  delivered_count?: number;
  waiting_since?: string;
}

// --------------- DEX -> CEX Arbitrage Types ---------------

export type DexToCexArbitragePhase =
  | "check_source_balance"
  | "do_crosschain"
  | "wait_delivery"
  | "do_deposit_transfer"
  | "wait_deposit_confirmed";

export interface DexToCexArbitrageTaskPayload {
  wallet_id: string;
  symbol: string;
  src_chain: string;
  dst_chain?: string;
  token_address: string;
  dst_token_address?: string;
  threshold_amount: string;
  interval_sec: number;
  deposit_address: string;
  slippage_bps?: number;
  mode?: "api" | "direct";
  reserve_amount?: string;
  crosschain?: {
    dst_chain: string;
    dst_token_address: string;
    slippage_bps?: number;
    mode?: "api" | "direct";
    reserve_amount?: string;
  };
}

export interface DexToCexArbitrageTaskProgress {
  phase?: DexToCexArbitragePhase;
  completed_count: number;
  last_source_balance?: string;
  crosschain_amount?: string;
  crosschain_done?: boolean;
  dst_balance_before_raw?: string;
  source_tx_hash?: string;
  destination_tx_hash?: string;
  status_lookup?: string;
  guid?: string;
  lz_status?: string;
  deposit_amount?: string;
  deposit_tx_hash?: string;
}

// --------------- Union Types ---------------

export type TaskPayload =
  | WithdrawRequest
  | SellMarketTaskPayload
  | CrosschainOftTaskPayload
  | ArbitrageTaskPayload
  | DexToCexArbitrageTaskPayload;

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
  | CrosschainOftTaskProgress
  | ArbitrageTaskProgress
  | DexToCexArbitrageTaskProgress
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
