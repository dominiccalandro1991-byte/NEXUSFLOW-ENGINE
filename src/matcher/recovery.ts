import type pg from "pg";
import { INSTRUMENTS } from "../instruments.ts";
import type { RestingOrder } from "../types.ts";
import { BookSet, rebuildEngine } from "./books.ts";

export class RecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoveryError";
  }
}

interface OrderRow {
  order_id: string;
  user_id: string;
  instrument_id: string;
  side: "buy" | "sell";
  order_type: "limit" | "market";
  price_ticks: number | null;
  quantity: number;
  remaining: number;
  status: "open" | "partially_filled";
  sequence_no: number;
  ts_ms: number;
}

export async function reconcileAbandoned(pool: pg.Pool): Promise<number> {
  const result = await pool.query(
    `UPDATE nf_commands
     SET status = 'PENDING', locked_by = NULL, locked_at = NULL, updated_at = now()
     WHERE status = 'PROCESSING'`,
  );
  return result.rowCount ?? 0;
}

export async function recoverBooks(pool: pg.Pool, books: BookSet): Promise<void> {
  const instruments = await pool.query<{ id: string }>(
    "SELECT id FROM nf_instruments WHERE status = 'active' ORDER BY id",
  );
  const dbIds = new Set(instruments.rows.map((row) => row.id));
  for (const instrument of INSTRUMENTS) {
    if (!dbIds.has(instrument.id)) {
      throw new RecoveryError(`SCHEMA_INSTRUMENT_MISSING:${instrument.id}`);
    }
  }
  for (const row of instruments.rows) {
    if (!INSTRUMENTS.some((instrument) => instrument.id === row.id)) {
      throw new RecoveryError(`SCHEMA_INSTRUMENT_UNSUPPORTED:${row.id}`);
    }
  }

  for (const instrument of INSTRUMENTS) {
    const state = await pool.query<{ last_sequence: number }>(
      "SELECT last_sequence FROM nf_book_state WHERE instrument_id = $1",
      [instrument.id],
    );
    const lastSequence = state.rows[0]?.last_sequence ?? 0;
    const rows = await pool.query<OrderRow>(
      `SELECT order_id, user_id, instrument_id, side, order_type, price_ticks, quantity,
              remaining, status, sequence_no,
              (EXTRACT(EPOCH FROM created_at) * 1000)::bigint AS ts_ms
       FROM nf_orders
       WHERE instrument_id = $1
         AND status IN ('open', 'partially_filled')
         AND remaining > 0
       ORDER BY sequence_no ASC, order_id ASC`,
      [instrument.id],
    );
    const resting: RestingOrder[] = rows.rows.map((row) => {
      if (row.price_ticks === null) {
        throw new RecoveryError(`RECOVERY_NULL_PRICE:${row.order_id}`);
      }
      return {
        id: row.order_id,
        accountId: row.user_id,
        instrumentId: row.instrument_id,
        side: row.side,
        type: row.order_type,
        priceTicks: row.price_ticks,
        quantity: row.quantity,
        remaining: row.remaining,
        seq: row.sequence_no,
        status: row.status,
        ts: row.ts_ms,
      };
    });
    const engine = rebuildEngine(instrument.id, resting, lastSequence);
    if (engine.sequence() !== lastSequence) {
      throw new RecoveryError(
        `RECOVERY_SEQUENCE_MISMATCH:${instrument.id}:${engine.sequence()}:${lastSequence}`,
      );
    }
    const memory = new Map(engine.resting().map((order) => [order.id, order]));
    if (memory.size !== resting.length) {
      throw new RecoveryError(`RECOVERY_COUNT_MISMATCH:${instrument.id}`);
    }
    for (const order of resting) {
      const restored = memory.get(order.id);
      if (
        !restored ||
        restored.remaining !== order.remaining ||
        restored.priceTicks !== order.priceTicks ||
        restored.side !== order.side ||
        restored.seq !== order.seq ||
        restored.accountId !== order.accountId
      ) {
        throw new RecoveryError(`RECOVERY_ORDER_MISMATCH:${order.id}`);
      }
    }
    const fifo = engine.restingInMatchOrder();
    const prices = new Set(resting.map((order) => `${order.side}:${order.priceTicks}`));
    for (const key of prices) {
      const [side, priceText] = key.split(":");
      const price = Number(priceText);
      const expected = resting
        .filter((order) => order.side === side && order.priceTicks === price)
        .sort((a, b) => a.seq - b.seq)
        .map((order) => order.id);
      const actual = fifo
        .filter((order) => order.side === side && order.priceTicks === price)
        .map((order) => order.id);
      if (expected.join(",") !== actual.join(",")) {
        throw new RecoveryError(`RECOVERY_FIFO_MISMATCH:${instrument.id}:${key}`);
      }
    }
    books.replace(instrument.id, engine);
  }
}
