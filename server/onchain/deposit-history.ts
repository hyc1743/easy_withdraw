import { getDb } from "../db.js";

export interface DepositTransferHistoryRecord {
  timestamp: string;
  wallet_id: string;
  symbol: string;
  chain: string;
  token_address: string;
  deposit_address: string;
  amount: string;
  tx_hash: string;
  status: string;
  message: string;
}

const db = getDb();

export function appendDepositTransferHistory(record: DepositTransferHistoryRecord): void {
  db.prepare(
    `INSERT INTO deposit_transfer_history(
      timestamp, wallet_id, symbol, chain, token_address, deposit_address, amount, tx_hash, status, message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.timestamp,
    record.wallet_id,
    record.symbol,
    record.chain,
    record.token_address,
    record.deposit_address,
    record.amount,
    record.tx_hash,
    record.status,
    record.message,
  );
}

export function listDepositTransferHistory(limit = 20, offset = 0): DepositTransferHistoryRecord[] {
  return db.prepare(
    `SELECT timestamp, wallet_id, symbol, chain, token_address, deposit_address, amount, tx_hash, status, message
    FROM deposit_transfer_history
    ORDER BY id DESC
    LIMIT ? OFFSET ?`,
  ).all(limit, offset) as DepositTransferHistoryRecord[];
}

export function countDepositTransferHistory(): number {
  const row = db
    .prepare("SELECT COUNT(1) as n FROM deposit_transfer_history")
    .get() as { n: number };
  return row.n;
}
