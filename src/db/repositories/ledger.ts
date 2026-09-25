import type { Queryable } from "../pool.ts";
import { newId } from "../../ids.ts";
import { assertBalanced, type LedgerPosting } from "../../settlement.ts";

export class BusinessRejection extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "BusinessRejection";
    this.code = code;
  }
}

export async function ensureBalance(db: Queryable, userId: string, assetId: string): Promise<void> {
  await db.query(
    `INSERT INTO nf_balances (user_id, asset_id, available, locked)
     VALUES ($1, $2, 0, 0)
     ON CONFLICT (user_id, asset_id) DO NOTHING`,
    [userId, assetId],
  );
}

export async function lockAvailable(
  db: Queryable,
  userId: string,
  assetId: string,
  qty: number,
): Promise<void> {
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new BusinessRejection("INVALID_AMOUNT", "Reservation amount is invalid.");
  }
  await ensureBalance(db, userId, assetId);
  const result = await db.query(
    `UPDATE nf_balances
     SET available = available - $3, locked = locked + $3
     WHERE user_id = $1 AND asset_id = $2 AND available >= $3`,
    [userId, assetId, qty],
  );
  if (result.rowCount !== 1) {
    throw new BusinessRejection("INSUFFICIENT_AVAILABLE", "Insufficient available balance.");
  }
}

export async function unlock(
  db: Queryable,
  userId: string,
  assetId: string,
  qty: number,
): Promise<void> {
  if (qty === 0) return;
  if (!Number.isInteger(qty) || qty < 0) {
    throw new BusinessRejection("INVALID_AMOUNT", "Release amount is invalid.");
  }
  const result = await db.query(
    `UPDATE nf_balances
     SET locked = locked - $3, available = available + $3
     WHERE user_id = $1 AND asset_id = $2 AND locked >= $3`,
    [userId, assetId, qty],
  );
  if (result.rowCount !== 1) throw new Error("INSUFFICIENT_LOCKED");
}

export async function consumeLocked(
  db: Queryable,
  userId: string,
  assetId: string,
  qty: number,
): Promise<void> {
  const result = await db.query(
    `UPDATE nf_balances SET locked = locked - $3
     WHERE user_id = $1 AND asset_id = $2 AND locked >= $3`,
    [userId, assetId, qty],
  );
  if (result.rowCount !== 1) {
    throw new BusinessRejection("INSUFFICIENT_AVAILABLE", "Reserved balance is insufficient.");
  }
}

export async function consumeAvailable(
  db: Queryable,
  userId: string,
  assetId: string,
  qty: number,
): Promise<void> {
  const result = await db.query(
    `UPDATE nf_balances SET available = available - $3
     WHERE user_id = $1 AND asset_id = $2 AND available >= $3`,
    [userId, assetId, qty],
  );
  if (result.rowCount !== 1) {
    throw new BusinessRejection("INSUFFICIENT_AVAILABLE", "Insufficient available balance.");
  }
}

export async function creditAvailable(
  db: Queryable,
  userId: string,
  assetId: string,
  qty: number,
): Promise<void> {
  await ensureBalance(db, userId, assetId);
  const result = await db.query(
    `UPDATE nf_balances SET available = available + $3
     WHERE user_id = $1 AND asset_id = $2`,
    [userId, assetId, qty],
  );
  if (result.rowCount !== 1) throw new Error("BALANCE_CREDIT_FAILED");
}

export async function insertBalancedPosting(
  db: Queryable,
  posting: LedgerPosting,
  kind: "trade" | "reservation" | "release" | "adjustment",
  commandId: string,
): Promise<void> {
  assertBalanced(posting.lines);
  await db.query(
    `INSERT INTO nf_ledger_transactions (transaction_id, kind, command_id)
     VALUES ($1, $2, $3)`,
    [posting.transactionId, kind, commandId],
  );
  for (const line of posting.lines) {
    if (!Number.isInteger(line.debit) || !Number.isInteger(line.credit)) {
      throw new Error("NON_INTEGER_LEDGER");
    }
    await db.query(
      `INSERT INTO nf_ledger (
         entry_id, transaction_id, user_id, asset_id, debit, credit, event_hash
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        newId("led"),
        posting.transactionId,
        line.accountId,
        line.assetId,
        line.debit,
        line.credit,
        posting.eventHash,
      ],
    );
  }
}
