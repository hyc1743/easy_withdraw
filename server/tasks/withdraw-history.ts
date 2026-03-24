import { getDb } from "../db.js";

export interface WithdrawHistoryRecord {
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

const db = getDb();

export function appendWithdrawHistory(record: WithdrawHistoryRecord): void {
  db.prepare(
    `INSERT INTO withdraw_history(
      timestamp, account_id, exchange, asset, network, address, amount, withdraw_id, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.timestamp,
    record.account_id,
    record.exchange,
    record.asset,
    record.network,
    record.address,
    record.amount,
    record.withdraw_id,
    record.status,
  );
}

export function listWithdrawHistory(limit: number, offset: number): WithdrawHistoryRecord[] {
  return db
    .prepare(
      `SELECT
        timestamp, account_id, exchange, asset, network, address, amount, withdraw_id, status
      FROM withdraw_history
      ORDER BY id DESC
      LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as WithdrawHistoryRecord[];
}

export function countWithdrawHistory(): number {
  const row = db.prepare("SELECT COUNT(1) as n FROM withdraw_history").get() as {
    n: number;
  };
  return row.n;
}
