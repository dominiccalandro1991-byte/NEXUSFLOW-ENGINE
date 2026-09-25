import type pg from "pg";
import { getInstrument } from "../instruments.ts";
import { mul, newId } from "../ids.ts";
import { hashEvent, tradePosting } from "../settlement.ts";
import { EngineError, type Fill, type Side } from "../types.ts";
import { markCompleted, type CommandRow } from "../db/repositories/commands.ts";
import {
  BusinessRejection,
  consumeAvailable,
  consumeLocked,
  creditAvailable,
  ensureBalance,
  insertBalancedPosting,
  lockAvailable,
  unlock,
} from "../db/repositories/ledger.ts";
import { insertOrder, lockOrder, updateOrderFill } from "../db/repositories/orders.ts";
import { enqueueOutbox } from "../db/repositories/outbox.ts";
import { BookSet, rebuildEngine } from "./books.ts";
import { testFaults } from "./faults.ts";

interface PlaceRequest {
  instrumentId: string;
  side: Side;
  type: "limit" | "market";
  priceTicks: number | null;
  quantity: number;
  clientOrderId?: string;
}

interface PlacePayload {
  request: PlaceRequest;
  orderId: string;
}

function asPlace(payload: Record<string, unknown>): PlacePayload {
  const request = payload.request as PlaceRequest | undefined;
  const orderId = payload.orderId;
  if (!request || typeof orderId !== "string") {
    throw new BusinessRejection("INVALID_PAYLOAD", "Command payload is invalid.");
  }
  return { request, orderId };
}

function mapError(error: unknown): unknown {
  if (error instanceof EngineError) return new BusinessRejection(error.code, error.message);
  if (error instanceof Error && error.message === "NON_INTEGER_AMOUNT") {
    return new BusinessRejection("INVALID_AMOUNT", "Amount must be an integer.");
  }
  if (error instanceof Error && error.message === "AMOUNT_OVERFLOW") {
    return new BusinessRejection("AMOUNT_OVERFLOW", "Notional exceeds the integer range.");
  }
  return error;
}

async function advanceSequence(
  client: pg.PoolClient,
  instrumentId: string,
  preSeq: number,
  nextSeq: number,
): Promise<void> {
  const current = await client.query<{ last_sequence: number }>(
    "SELECT last_sequence FROM nf_book_state WHERE instrument_id = $1 FOR UPDATE",
    [instrumentId],
  );
  const dbSeq = current.rows[0]?.last_sequence ?? 0;
  if (dbSeq !== preSeq) {
    throw new Error(`BOOK_SEQUENCE_DIVERGENCE db=${dbSeq} memory=${preSeq}`);
  }
  if (nextSeq < preSeq) throw new Error("BOOK_SEQUENCE_REGRESSION");
  await client.query(
    `INSERT INTO nf_book_state (instrument_id, last_sequence)
     VALUES ($1, $2)
     ON CONFLICT (instrument_id) DO UPDATE
     SET last_sequence = EXCLUDED.last_sequence, updated_at = now()`,
    [instrumentId, nextSeq],
  );
}

async function writeEvent(
  client: pg.PoolClient,
  orderId: string,
  sequenceNo: number,
  previous: string | null,
  next: string,
  actor: string,
): Promise<void> {
  await client.query(
    `INSERT INTO nf_order_events (
       event_id, order_id, sequence_no, previous_state, new_state, actor, event_hash
     ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      newId("evt"),
      orderId,
      sequenceNo,
      previous,
      next,
      actor,
      hashEvent([orderId, sequenceNo, previous ?? "", next, actor]),
    ],
  );
}

async function writeAudit(
  client: pg.PoolClient,
  userId: string,
  action: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO nf_audit (audit_id, domain, user_id, action, payload)
     VALUES ($1, 'orders', $2, $3, $4::jsonb)`,
    [newId("aud"), userId, action, JSON.stringify(payload)],
  );
}

async function applyFill(
  client: pg.PoolClient,
  fill: Fill,
  taker: PlaceRequest,
  baseAsset: string,
  quoteAsset: string,
  commandId: string,
): Promise<void> {
  const quoteAmount = mul(fill.priceTicks, fill.quantity);
  const buyerIsTaker = taker.side === "buy";
  const buyerId = buyerIsTaker ? fill.takerAccountId : fill.makerAccountId;
  const sellerId = buyerIsTaker ? fill.makerAccountId : fill.takerAccountId;
  await ensureBalance(client, buyerId, baseAsset);
  await ensureBalance(client, buyerId, quoteAsset);
  await ensureBalance(client, sellerId, baseAsset);
  await ensureBalance(client, sellerId, quoteAsset);
  await consumeLocked(client, sellerId, baseAsset, fill.quantity);
  if (!buyerIsTaker || taker.type === "limit") {
    await consumeLocked(client, buyerId, quoteAsset, quoteAmount);
  } else {
    await consumeAvailable(client, buyerId, quoteAsset, quoteAmount);
  }
  await creditAvailable(client, buyerId, baseAsset, fill.quantity);
  await creditAvailable(client, sellerId, quoteAsset, quoteAmount);
  if (buyerIsTaker && taker.type === "limit") {
    if (taker.priceTicks === null) {
      throw new BusinessRejection("INVALID_PRICE", "Limit orders require a positive tick price.");
    }
    const improvement = mul(taker.priceTicks - fill.priceTicks, fill.quantity);
    if (improvement < 0) throw new Error("NEGATIVE_PRICE_IMPROVEMENT");
    if (improvement > 0) await unlock(client, buyerId, quoteAsset, improvement);
  }
  const posting = tradePosting({
    transactionId: fill.tradeId,
    buyerId,
    sellerId,
    baseAsset,
    quoteAsset,
    quantity: fill.quantity,
    quoteAmount,
  });
  await insertBalancedPosting(client, posting, "trade", commandId);
}

export async function executePlace(
  client: pg.PoolClient,
  books: BookSet,
  command: CommandRow,
): Promise<void> {
  const { request, orderId } = asPlace(command.payload);
  const known = getInstrument(request.instrumentId);
  const row = await client.query<{ id: string; base_asset: string; quote_asset: string; status: string }>(
    "SELECT id, base_asset, quote_asset, status FROM nf_instruments WHERE id = $1",
    [request.instrumentId],
  );
  const instrument = row.rows[0];
  if (!known || !instrument || instrument.status !== "active") {
    throw new BusinessRejection("UNKNOWN_INSTRUMENT", "Instrument is not active.");
  }
  if (request.side === "buy" && request.type === "limit") {
    if (request.priceTicks === null) {
      throw new BusinessRejection("INVALID_PRICE", "Limit orders require a positive tick price.");
    }
    await lockAvailable(client, command.account_id, instrument.quote_asset, mul(request.priceTicks, request.quantity));
  } else if (request.side === "sell") {
    await lockAvailable(client, command.account_id, instrument.base_asset, request.quantity);
  } else if (request.type === "market") {
    await ensureBalance(client, command.account_id, instrument.quote_asset);
  }

  const engine = books.engine(request.instrumentId);
  const preOrders = engine.resting();
  const preSeq = engine.sequence();
  try {
    const outcome = engine.submit({
      id: orderId,
      accountId: command.account_id,
      instrumentId: request.instrumentId,
      side: request.side,
      type: request.type,
      priceTicks: request.priceTicks,
      quantity: request.quantity,
      clientOrderId: request.clientOrderId,
    });
    for (const fill of outcome.fills) {
      await applyFill(client, fill, request, instrument.base_asset, instrument.quote_asset, command.command_id);
    }
    const resting =
      outcome.order.status === "open" || outcome.order.status === "partially_filled";
    if (!resting && request.side === "sell" && outcome.order.remaining > 0) {
      await unlock(client, command.account_id, instrument.base_asset, outcome.order.remaining);
    }
    const makerIds = [...new Set(outcome.fills.map((fill) => fill.makerOrderId))];
    for (const makerId of makerIds) {
      const previous = await client.query<{ status: string }>(
        "SELECT status FROM nf_orders WHERE order_id = $1 FOR UPDATE",
        [makerId],
      );
      const live = engine.getOrder(makerId);
      const status = live?.status ?? "filled";
      const remaining = live?.remaining ?? 0;
      await updateOrderFill(client, makerId, status, remaining);
      await writeEvent(
        client,
        makerId,
        outcome.order.seq,
        previous.rows[0]?.status ?? null,
        status,
        command.account_id,
      );
    }
    await insertOrder(client, {
      orderId,
      userId: command.account_id,
      instrumentId: request.instrumentId,
      side: request.side,
      orderType: request.type,
      priceTicks: request.type === "market" ? null : request.priceTicks,
      quantity: outcome.order.quantity,
      remaining: outcome.order.remaining,
      status: outcome.order.status,
      sequenceNo: outcome.order.seq,
      clientOrderId: request.clientOrderId ?? null,
    });
    for (const fill of outcome.fills) {
      await client.query(
        `INSERT INTO nf_trades (
           trade_id, instrument_id, maker_order_id, taker_order_id, maker_user_id, taker_user_id,
           price_ticks, quantity, sequence_no
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          fill.tradeId,
          fill.instrumentId,
          fill.makerOrderId,
          fill.takerOrderId,
          fill.makerAccountId,
          fill.takerAccountId,
          fill.priceTicks,
          fill.quantity,
          fill.seq,
        ],
      );
      await enqueueOutbox(client, {
        eventId: newId("obx"),
        commandId: command.command_id,
        accountId: command.account_id,
        topic: "trade.executed",
        payload: {
          tradeId: fill.tradeId,
          instrumentId: fill.instrumentId,
          priceTicks: fill.priceTicks,
          quantity: fill.quantity,
          makerOrderId: fill.makerOrderId,
          takerOrderId: fill.takerOrderId,
        },
      });
    }
    await writeEvent(client, orderId, outcome.order.seq, null, outcome.order.status, command.account_id);
    const result = {
      order: {
        orderId,
        instrumentId: request.instrumentId,
        side: request.side,
        type: request.type,
        priceTicks: request.type === "market" ? null : request.priceTicks,
        quantity: outcome.order.quantity,
        remaining: outcome.order.remaining,
        status: outcome.order.status,
        sequenceNo: outcome.order.seq,
      },
      fills: outcome.fills.map((fill) => ({
        tradeId: fill.tradeId,
        priceTicks: fill.priceTicks,
        quantity: fill.quantity,
        makerOrderId: fill.makerOrderId,
        takerOrderId: fill.takerOrderId,
      })),
    };
    await enqueueOutbox(client, {
      eventId: newId("obx"),
      commandId: command.command_id,
      accountId: command.account_id,
      topic: "order.accepted",
      payload: result as unknown as Record<string, unknown>,
    });
    await writeAudit(client, command.account_id, "PLACE_ORDER", {
      commandId: command.command_id,
      orderId,
      status: outcome.order.status,
    });
    await advanceSequence(client, request.instrumentId, preSeq, engine.sequence());
    if (testFaults.beforeCommit) testFaults.beforeCommit();
    await markCompleted(client, command.command_id, result as unknown as Record<string, unknown>);
  } catch (error) {
    books.replace(request.instrumentId, rebuildEngine(request.instrumentId, preOrders, preSeq));
    throw mapError(error);
  }
}

export async function executeCancel(
  client: pg.PoolClient,
  books: BookSet,
  command: CommandRow,
): Promise<void> {
  const request = (command.payload.request ?? {}) as { orderId?: string };
  const orderId = request.orderId;
  if (!orderId) throw new BusinessRejection("INVALID_PAYLOAD", "Cancel payload is invalid.");
  const row = await lockOrder(client, orderId);
  if (!row) throw new BusinessRejection("ORDER_NOT_FOUND", "Order was not found.");
  if (row.user_id !== command.account_id) {
    throw new BusinessRejection("NOT_OWNER", "You do not own this order.");
  }
  if (row.status !== "open" && row.status !== "partially_filled") {
    throw new BusinessRejection("ORDER_NOT_OPEN", "Order is not open.");
  }
  const instrument = getInstrument(row.instrument_id);
  if (!instrument) throw new BusinessRejection("UNKNOWN_INSTRUMENT", "Instrument is not active.");
  const engine = books.engine(row.instrument_id);
  const preOrders = engine.resting();
  const preSeq = engine.sequence();
  try {
    const cancelled = engine.cancel(orderId, command.account_id);
    if (!cancelled) throw new Error("BOOK_ORDER_MISSING");
    if (row.side === "buy") {
      if (row.price_ticks === null) throw new Error("BUY_PRICE_MISSING");
      await unlock(client, row.user_id, instrument.quoteAsset, mul(row.price_ticks, row.remaining));
    } else {
      await unlock(client, row.user_id, instrument.baseAsset, row.remaining);
    }
    await updateOrderFill(client, orderId, "cancelled", cancelled.remaining);
    await writeEvent(client, orderId, engine.sequence(), row.status, "cancelled", command.account_id);
    const result = {
      order: {
        orderId,
        instrumentId: row.instrument_id,
        side: row.side,
        type: row.order_type,
        priceTicks: row.price_ticks,
        quantity: row.quantity,
        remaining: cancelled.remaining,
        status: "cancelled",
        sequenceNo: engine.sequence(),
      },
      fills: [],
    };
    await enqueueOutbox(client, {
      eventId: newId("obx"),
      commandId: command.command_id,
      accountId: command.account_id,
      topic: "order.cancelled",
      payload: result as unknown as Record<string, unknown>,
    });
    await writeAudit(client, command.account_id, "CANCEL_ORDER", {
      commandId: command.command_id,
      orderId,
    });
    await advanceSequence(client, row.instrument_id, preSeq, engine.sequence());
    if (testFaults.beforeCommit) testFaults.beforeCommit();
    await markCompleted(client, command.command_id, result as unknown as Record<string, unknown>);
  } catch (error) {
    books.replace(row.instrument_id, rebuildEngine(row.instrument_id, preOrders, preSeq));
    throw mapError(error);
  }
}
