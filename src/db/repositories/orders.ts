import type { Queryable } from "../pool.ts";

export interface OrderRecord {
  order_id: string;
  user_id: string;
  instrument_id: string;
  side: "buy" | "sell";
  order_type: "limit" | "market";
  price_ticks: number | null;
  quantity: number;
  remaining: number;
  status: string;
  sequence_no: number;
  client_order_id: string | null;
}

export async function insertOrder(
  db: Queryable,
  row: {
    orderId: string;
    userId: string;
    instrumentId: string;
    side: "buy" | "sell";
    orderType: "limit" | "market";
    priceTicks: number | null;
    quantity: number;
    remaining: number;
    status: string;
    sequenceNo: number;
    clientOrderId: string | null;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO nf_orders (
       order_id, user_id, instrument_id, side, order_type, price_ticks, quantity, remaining,
       status, sequence_no, client_order_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      row.orderId,
      row.userId,
      row.instrumentId,
      row.side,
      row.orderType,
      row.priceTicks,
      row.quantity,
      row.remaining,
      row.status,
      row.sequenceNo,
      row.clientOrderId,
    ],
  );
}

export async function updateOrderFill(
  db: Queryable,
  orderId: string,
  status: string,
  remaining: number,
): Promise<void> {
  const result = await db.query(
    `UPDATE nf_orders
     SET status = $2, remaining = $3, updated_at = now()
     WHERE order_id = $1`,
    [orderId, status, remaining],
  );
  if (result.rowCount !== 1) throw new Error(`ORDER_UPDATE_MISSING:${orderId}`);
}

export async function lockOrder(db: Queryable, orderId: string): Promise<OrderRecord | null> {
  const result = await db.query<OrderRecord>(
    `SELECT order_id, user_id, instrument_id, side, order_type, price_ticks, quantity,
            remaining, status, sequence_no, client_order_id
     FROM nf_orders WHERE order_id = $1 FOR UPDATE`,
    [orderId],
  );
  return result.rows[0] ?? null;
}

export async function readOrder(db: Queryable, orderId: string): Promise<OrderRecord | null> {
  const result = await db.query<OrderRecord>(
    `SELECT order_id, user_id, instrument_id, side, order_type, price_ticks, quantity,
            remaining, status, sequence_no, client_order_id
     FROM nf_orders WHERE order_id = $1`,
    [orderId],
  );
  return result.rows[0] ?? null;
}

export interface DepthLevel {
  price_ticks: number;
  quantity: number;
  order_count: number;
}

export async function bookDepth(
  db: Queryable,
  instrumentId: string,
): Promise<{ sequence: number; bids: DepthLevel[]; asks: DepthLevel[] }> {
  const state = await db.query<{ last_sequence: number }>(
    "SELECT last_sequence FROM nf_book_state WHERE instrument_id = $1",
    [instrumentId],
  );
  const levels = await db.query<DepthLevel & { side: "buy" | "sell" }>(
    `SELECT side, price_ticks, SUM(remaining)::bigint AS quantity, COUNT(*)::int AS order_count
     FROM nf_orders
     WHERE instrument_id = $1
       AND status IN ('open', 'partially_filled')
       AND remaining > 0
       AND price_ticks IS NOT NULL
     GROUP BY side, price_ticks`,
    [instrumentId],
  );
  const bids = levels.rows
    .filter((row) => row.side === "buy")
    .map(({ price_ticks, quantity, order_count }) => ({ price_ticks, quantity, order_count }))
    .sort((a, b) => b.price_ticks - a.price_ticks);
  const asks = levels.rows
    .filter((row) => row.side === "sell")
    .map(({ price_ticks, quantity, order_count }) => ({ price_ticks, quantity, order_count }))
    .sort((a, b) => a.price_ticks - b.price_ticks);
  return { sequence: state.rows[0]?.last_sequence ?? 0, bids, asks };
}
