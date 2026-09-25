import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Server } from "node:http";
import type pg from "pg";
import type { AppConfig } from "../config.ts";
import { countQueued, getByIdempotency, getCommand, insertCommand } from "../db/repositories/commands.ts";
import { bookDepth, readOrder } from "../db/repositories/orders.ts";
import type { HealthState } from "../health.ts";
import { newId, stableStringify } from "../ids.ts";
import { AccountLimiter } from "../rate-limit.ts";
import type { CommandProcessor } from "../matcher/processor.ts";
import { authenticate, AuthError } from "./auth.ts";
import { parseIdempotencyKey, parseOrderId, parsePlaceBody, readJsonBody, ValidationError } from "./validation.ts";

export interface HttpDeps {
  config: AppConfig;
  pool: pg.Pool;
  state: HealthState;
  processor: CommandProcessor;
  limiter: AccountLimiter;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function terminalStatus(status: string): boolean {
  return status === "COMPLETED" || status === "REJECTED";
}

export function createHttpServer(deps: HttpDeps): Server {
  return createServer((req, res) => {
    void route(deps, req, res).catch((error) => {
      const message = error instanceof Error ? error.message : "INTERNAL";
      if (!res.headersSent) send(res, 500, { error: { code: "INTERNAL", message: "Request failed." } });
      else res.end();
      void message;
    });
  });
}

async function route(deps: HttpDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;
  if (req.method === "GET" && path === "/healthz") {
    send(res, 200, { status: "ok" });
    return;
  }
  if (req.method === "GET" && path === "/readyz") {
    try {
      await deps.pool.query("SELECT 1");
      deps.state.dbHealthy = true;
    } catch {
      deps.state.dbHealthy = false;
      if (!deps.state.failure) deps.state.failure = "DB_UNHEALTHY";
      deps.state.processorActive = false;
    }
    send(res, deps.state.ready ? 200 : 503, { ready: deps.state.ready, checks: deps.state.checks() });
    return;
  }
  const bookMatch = path.match(/^\/v1\/books\/([^/]+)$/);
  if (req.method === "GET" && bookMatch) {
    if (!deps.state.dbHealthy || !deps.state.schemaValid) {
      send(res, 503, { error: { code: "NOT_READY", message: "Read model is unavailable." } });
      return;
    }
    let instrumentId: string;
    try {
      instrumentId = decodeURIComponent(bookMatch[1] ?? "");
      if (!/^[A-Z0-9-]{1,32}$/.test(instrumentId)) throw new ValidationError("instrumentId is invalid.");
    } catch {
      send(res, 400, { error: { code: "INVALID_REQUEST", message: "instrumentId is invalid." } });
      return;
    }
    const known = await deps.pool.query("SELECT 1 FROM nf_instruments WHERE id = $1", [instrumentId]);
    if (known.rowCount !== 1) {
      send(res, 404, { error: { code: "NOT_FOUND", message: "Instrument was not found." } });
      return;
    }
    const depth = await bookDepth(deps.pool, instrumentId);
    send(res, 200, {
      instrumentId,
      sequence: depth.sequence,
      bids: depth.bids.map((level) => ({
        priceTicks: level.price_ticks,
        quantity: level.quantity,
        orderCount: level.order_count,
      })),
      asks: depth.asks.map((level) => ({
        priceTicks: level.price_ticks,
        quantity: level.quantity,
        orderCount: level.order_count,
      })),
      bestBid: depth.bids[0]?.price_ticks ?? null,
      bestAsk: depth.asks[0]?.price_ticks ?? null,
    });
    return;
  }

  const cancelMatch = path.match(/^\/v1\/orders\/([^/]+)\/cancel$/);
  const orderMatch = path.match(/^\/v1\/orders\/([^/]+)$/);
  try {
    if (req.method === "POST" && path === "/v1/orders") {
      await placeOrder(deps, req, res);
      return;
    }
    if (req.method === "POST" && cancelMatch) {
      await cancelOrder(deps, req, res, cancelMatch[1] ?? "");
      return;
    }
    if (req.method === "GET" && orderMatch && orderMatch[1] !== undefined) {
      await readOwnedOrder(deps, req, res, orderMatch[1]);
      return;
    }
  } catch (error) {
    if (error instanceof AuthError) {
      send(res, 401, { error: { code: "UNAUTHORIZED", message: "Authentication required." } });
      return;
    }
    if (error instanceof ValidationError) {
      const code = error.message === "BODY_TOO_LARGE" ? "BODY_TOO_LARGE" : "INVALID_REQUEST";
      const status = code === "BODY_TOO_LARGE" ? 413 : 400;
      send(res, status, { error: { code, message: error.message } });
      return;
    }
    throw error;
  }
  send(res, 404, { error: { code: "NOT_FOUND", message: "Route was not found." } });
}

async function accountStatus(pool: pg.Pool, accountId: string): Promise<string | null> {
  const result = await pool.query<{ status: string }>(
    "SELECT status FROM nf_accounts WHERE user_id = $1",
    [accountId],
  );
  return result.rows[0]?.status ?? null;
}

function respondCommand(
  res: ServerResponse,
  row: {
    command_id: string;
    status: string;
    result: Record<string, unknown> | null;
    error_code: string | null;
    error_message: string | null;
  },
  created: boolean,
): void {
  if (row.status === "COMPLETED") {
    send(res, created ? 201 : 200, { commandId: row.command_id, status: row.status, ...row.result });
    return;
  }
  if (row.status === "REJECTED") {
    send(res, 422, {
      commandId: row.command_id,
      status: row.status,
      error: { code: row.error_code ?? "REJECTED", message: row.error_message ?? "Rejected." },
    });
    return;
  }
  send(res, 202, { commandId: row.command_id, status: row.status });
}

async function placeOrder(deps: HttpDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req, deps.config.maxBodyBytes);
  const accountId = await authenticate(req.headers.authorization, deps.config);
  const place = parsePlaceBody(body);
  const idempotencyKey = parseIdempotencyKey(req.headers["idempotency-key"] as string | undefined);
  const status = await accountStatus(deps.pool, accountId);
  if (status !== "active") {
    send(res, 403, { error: { code: "ACCOUNT_NOT_ACTIVE", message: "Account is not active." } });
    return;
  }
  const existing = await getByIdempotency(deps.pool, accountId, idempotencyKey);
  if (existing) {
    const prior = (existing.payload.request ?? null) as unknown;
    if (stableStringify(prior) !== stableStringify(place)) {
      send(res, 409, { error: { code: "IDEMPOTENCY_CONFLICT", message: "Idempotency key was reused with a different payload." } });
      return;
    }
    if (!terminalStatus(existing.status)) {
      const waited = await deps.processor.waitFor(existing.command_id, deps.config.commandWaitMs);
      const current = waited ?? (await getCommand(deps.pool, existing.command_id)) ?? existing;
      if (!terminalStatus(current.status) && !deps.state.ready) {
        send(res, 503, { error: { code: "NOT_READY", message: "Matcher is not ready." } });
        return;
      }
      respondCommand(res, current, false);
      return;
    }
    respondCommand(res, existing, false);
    return;
  }
  if (!deps.state.ready || !deps.state.ingressOpen) {
    send(res, 503, { error: { code: "NOT_READY", message: "Matcher is not ready." } });
    return;
  }
  if (!deps.limiter.allow(accountId)) {
    send(res, 429, { error: { code: "RATE_LIMITED", message: "Slow down." } });
    return;
  }
  if ((await countQueued(deps.pool)) >= deps.config.maxCommandQueueDepth) {
    send(res, 429, { error: { code: "QUEUE_DEPTH", message: "Command queue is full." } });
    return;
  }
  const commandId = newId("cmd");
  const orderId = newId("ord");
  const correlationId =
    (typeof req.headers["x-request-id"] === "string" && req.headers["x-request-id"].slice(0, 128)) ||
    newId("req");
  const pending = deps.processor.waitFor(commandId, deps.config.commandWaitMs);
  try {
    await insertCommand(deps.pool, {
      commandId,
      accountId,
      idempotencyKey,
      correlationId,
      commandType: "PLACE_ORDER",
      payload: { request: place, orderId },
    });
  } catch (error) {
    deps.processor.cancelWait(commandId);
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      const raced = await getByIdempotency(deps.pool, accountId, idempotencyKey);
      if (raced) {
        respondCommand(res, raced, false);
        return;
      }
    }
    throw error;
  }
  deps.processor.kick();
  const completed = await pending;
  const row = completed ?? (await getCommand(deps.pool, commandId));
  if (!row) {
    send(res, 503, { error: { code: "NOT_READY", message: "Matcher is not ready." } });
    return;
  }
  if (!terminalStatus(row.status) && !deps.state.ready) {
    send(res, 503, { commandId, error: { code: "NOT_READY", message: "Matcher is not ready." } });
    return;
  }
  respondCommand(res, row, true);
}

async function cancelOrder(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  rawOrderId: string,
): Promise<void> {
  await readJsonBody(req, deps.config.maxBodyBytes);
  const accountId = await authenticate(req.headers.authorization, deps.config);
  const orderId = parseOrderId(decodeURIComponent(rawOrderId));
  const idempotencyKey = parseIdempotencyKey(req.headers["idempotency-key"] as string | undefined);
  const status = await accountStatus(deps.pool, accountId);
  if (status !== "active") {
    send(res, 403, { error: { code: "ACCOUNT_NOT_ACTIVE", message: "Account is not active." } });
    return;
  }
  const request = { orderId };
  const existing = await getByIdempotency(deps.pool, accountId, idempotencyKey);
  if (existing) {
    const prior = (existing.payload.request ?? null) as unknown;
    if (stableStringify(prior) !== stableStringify(request)) {
      send(res, 409, { error: { code: "IDEMPOTENCY_CONFLICT", message: "Idempotency key was reused with a different payload." } });
      return;
    }
    respondCommand(res, existing, false);
    return;
  }
  if (!deps.state.ready || !deps.state.ingressOpen) {
    send(res, 503, { error: { code: "NOT_READY", message: "Matcher is not ready." } });
    return;
  }
  if (!deps.limiter.allow(accountId)) {
    send(res, 429, { error: { code: "RATE_LIMITED", message: "Slow down." } });
    return;
  }
  if ((await countQueued(deps.pool)) >= deps.config.maxCommandQueueDepth) {
    send(res, 429, { error: { code: "QUEUE_DEPTH", message: "Command queue is full." } });
    return;
  }
  const commandId = newId("cmd");
  const correlationId =
    (typeof req.headers["x-request-id"] === "string" && req.headers["x-request-id"].slice(0, 128)) ||
    newId("req");
  const pending = deps.processor.waitFor(commandId, deps.config.commandWaitMs);
  await insertCommand(deps.pool, {
    commandId,
    accountId,
    idempotencyKey,
    correlationId,
    commandType: "CANCEL_ORDER",
    payload: { request, orderId },
  });
  deps.processor.kick();
  const completed = await pending;
  const row = completed ?? (await getCommand(deps.pool, commandId));
  if (!row) {
    send(res, 503, { error: { code: "NOT_READY", message: "Matcher is not ready." } });
    return;
  }
  respondCommand(res, row, true);
}

async function readOwnedOrder(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  rawOrderId: string,
): Promise<void> {
  const accountId = await authenticate(req.headers.authorization, deps.config);
  const orderId = parseOrderId(decodeURIComponent(rawOrderId));
  if (!deps.state.dbHealthy || !deps.state.schemaValid) {
    send(res, 503, { error: { code: "NOT_READY", message: "Read model is unavailable." } });
    return;
  }
  const order = await readOrder(deps.pool, orderId);
  if (!order || order.user_id !== accountId) {
    send(res, 404, { error: { code: "NOT_FOUND", message: "Order was not found." } });
    return;
  }
  const fills = await deps.pool.query<{
    trade_id: string;
    price_ticks: number;
    quantity: number;
    maker_order_id: string;
    taker_order_id: string;
  }>(
    `SELECT trade_id, price_ticks, quantity, maker_order_id, taker_order_id
     FROM nf_trades
     WHERE maker_order_id = $1 OR taker_order_id = $1
     ORDER BY sequence_no, trade_id`,
    [orderId],
  );
  send(res, 200, {
    orderId: order.order_id,
    instrumentId: order.instrument_id,
    side: order.side,
    type: order.order_type,
    priceTicks: order.price_ticks,
    quantity: order.quantity,
    remaining: order.remaining,
    status: order.status,
    sequenceNo: order.sequence_no,
    clientOrderId: order.client_order_id,
    fills: fills.rows.map((fill) => ({
      tradeId: fill.trade_id,
      priceTicks: fill.price_ticks,
      quantity: fill.quantity,
      makerOrderId: fill.maker_order_id,
      takerOrderId: fill.taker_order_id,
    })),
  });
}
