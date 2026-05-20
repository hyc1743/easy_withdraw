import { getDb } from "../db.js";

export interface CrosschainHistoryRecord {
  timestamp: string;
  wallet_id: string;
  symbol: string;
  src_chain: string;
  dst_chain: string;
  amount: string;
  recipient: string;
  source_tx_hash?: string | null;
  destination_tx_hash?: string | null;
  guid?: string | null;
  lz_status: string;
  status: string;
  message: string;
}

export function appendCrosschainHistory(record: CrosschainHistoryRecord): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO crosschain_history(
      timestamp, wallet_id, symbol, src_chain, dst_chain, amount, recipient,
      source_tx_hash, destination_tx_hash, guid, lz_status, status, message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.timestamp,
    record.wallet_id,
    record.symbol,
    record.src_chain,
    record.dst_chain,
    record.amount,
    record.recipient,
    record.source_tx_hash ?? null,
    record.destination_tx_hash ?? null,
    record.guid ?? null,
    record.lz_status,
    record.status,
    record.message,
  );
}

export function listCrosschainHistory(
  limit: number,
  offset: number,
): Array<CrosschainHistoryRecord & { id: number }> {
  const db = getDb();
  return db
    .prepare(
      `SELECT
        id, timestamp, wallet_id, symbol, src_chain, dst_chain, amount, recipient,
        source_tx_hash, destination_tx_hash, guid, lz_status, status, message
      FROM crosschain_history
      ORDER BY id DESC
      LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as Array<CrosschainHistoryRecord & { id: number }>;
}

export function countCrosschainHistory(): number {
  const db = getDb();
  const row = db
    .prepare("SELECT COUNT(1) as n FROM crosschain_history")
    .get() as { n: number };
  return row.n;
}
