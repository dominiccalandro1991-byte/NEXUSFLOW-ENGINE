import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import pg from "pg";
import { repoRoot } from "../../src/paths.ts";
import { startService, type RunningService } from "../../src/service.ts";
import { testFaults } from "../../src/matcher/faults.ts";
import { resetOutboxSink, setOutboxSink } from "../../src/publisher.ts";

const SECRET = "test-jwt-secret-not-production";
const DB = process.env.DATABASE_URL ?? "postgres://postgres@127.0.0.1:5432/nexusflow_test";

function databaseUrl(database: string): string {
  const url = new URL(DB);
  url.pathname = `/${database}`;
  return url.toString();
}

pg.types.setTypeParser(20, (value) => Number(value));

function mint(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub,
      role: "authenticated",
      aud: "authenticated",
      iss: "nexusflow-test",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", SECRET).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    DATABASE_URL: DB,
    DATABASE_SSL: "disable",
    NEXUSFLOW_JWT_SECRET: SECRET,
    NEXUSFLOW_AUTH_MODE: "hmac",
    JWT_ISSUER: "nexusflow-test",
    JWT_AUDIENCE: "authenticated",
    AUTO_MIGRATE: "true",
    PORT: "0",
    COMMAND_POLL_INTERVAL_MS: "15",
    COMMAND_WAIT_MS: "2500",
    OUTBOX_POLL_INTERVAL_MS: "20",
    RATE_LIMIT_CAPACITY: "1000",
    RATE_LIMIT_REFILL_PER_SEC: "1000",
    LOCK_HEARTBEAT_MS: "200",
    SHUTDOWN_DRAIN_MS: "2000",
    STATEMENT_TIMEOUT_MS: "15000",
    CONNECTION_TIMEOUT_MS: "2000",
    LOG_LEVEL: "error",
    ...extra,
  };
}

let admin: pg.Client;
let chain: Promise<unknown> = Promise.resolve();

function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function resetDb(): Promise<void> {
  await admin.query(`
    TRUNCATE nf_outbox, nf_ledger, nf_ledger_transactions, nf_order_events, nf_trades,
             nf_orders, nf_commands, nf_audit, nf_api_usage, nf_book_state, nf_balances
    RESTART IDENTITY CASCADE
  `);
  await admin.query("DELETE FROM nf_accounts WHERE user_id <> 'liquidity-bot'");
  testFaults.beforeCommit = null;
  testFaults.pauseClaim = false;
  resetOutboxSink();
}

async function fund(userId: string, amount = 1_000_000_000): Promise<void> {
  await admin.query(
    "INSERT INTO nf_accounts (user_id, status) VALUES ($1, 'active') ON CONFLICT (user_id) DO NOTHING",
    [userId],
  );
  for (const asset of ["USD", "BTC", "ETH", "SOL"]) {
    await admin.query(
      `INSERT INTO nf_balances (user_id, asset_id, available, locked)
       VALUES ($1, $2, $3, 0)
       ON CONFLICT (user_id, asset_id) DO UPDATE SET available = EXCLUDED.available, locked = 0`,
      [userId, asset, amount],
    );
  }
}

async function api(
  base: string,
  method: string,
  urlPath: string,
  token: string | null,
  body?: unknown,
  idempotencyKey?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  const response = await fetch(`${base}${urlPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body: parsed };
}

function orderOf(body: Record<string, unknown>): Record<string, unknown> {
  return body.order as Record<string, unknown>;
}

before(async () => {
  const root = new pg.Client({ connectionString: databaseUrl("postgres") });
  await root.connect();
  const exists = await root.query("SELECT 1 FROM pg_database WHERE datname = 'nexusflow_test'");
  if (exists.rowCount === 0) await root.query("CREATE DATABASE nexusflow_test");
  const empty = await root.query("SELECT 1 FROM pg_database WHERE datname = 'nexusflow_nomig'");
  if (empty.rowCount === 0) await root.query("CREATE DATABASE nexusflow_nomig");
  await root.end();
  admin = new pg.Client({ connectionString: DB });
  await admin.connect();
  const boot = await startService(env());
  await boot.shutdown("boot");
});

after(async () => {
  await admin.end();
});

describe("production service", () => {
  it("persists limits, partial fills, full fills, cancels, books, and idempotency", async () => {
    await exclusive(async () => {
      await resetDb();
      await fund("maker");
      await fund("taker");
      await fund("other");
      const svc = await startService(env());
      try {
        const ready = await api(svc.baseUrl, "GET", "/readyz", null);
        const health = await api(svc.baseUrl, "GET", "/healthz", null);
        assert.equal(health.status, 200);
        assert.deepEqual(health.body, { status: "ok" });
        assert.equal(ready.status, 200);
        assert.equal(ready.body.ready, true);

        const sell = await api(
          svc.baseUrl,
          "POST",
          "/v1/orders",
          mint("maker"),
          { instrumentId: "BTC-USD", side: "sell", type: "limit", priceTicks: 50, quantity: 10 },
          "sell-1",
        );
        assert.equal(sell.status, 201);
        const sellOrder = orderOf(sell.body);
        assert.equal(sellOrder.status, "open");
        assert.equal(sellOrder.remaining, 10);

        const partial = await api(
          svc.baseUrl,
          "POST",
          "/v1/orders",
          mint("taker"),
          { instrumentId: "BTC-USD", side: "buy", type: "limit", priceTicks: 50, quantity: 4 },
          "buy-partial",
        );
        assert.equal(partial.status, 201);
        const fills = partial.body.fills as Array<Record<string, unknown>>;
        assert.equal(fills.length, 1);
        assert.equal(fills[0]?.quantity, 4);
        assert.equal(fills[0]?.priceTicks, 50);
        const makerAfter = await api(
          svc.baseUrl,
          "GET",
          `/v1/orders/${sellOrder.orderId as string}`,
          mint("maker"),
        );
        assert.equal(makerAfter.status, 200);
        assert.equal(makerAfter.body.remaining, 6);
        assert.equal(makerAfter.body.status, "partially_filled");
        const hidden = await api(
          svc.baseUrl,
          "GET",
          `/v1/orders/${sellOrder.orderId as string}`,
          mint("other"),
        );
        assert.equal(hidden.status, 404);

        const rest = await api(
          svc.baseUrl,
          "POST",
          "/v1/orders",
          mint("taker"),
          { instrumentId: "BTC-USD", side: "buy", type: "limit", priceTicks: 50, quantity: 6 },
          "buy-rest",
        );
        assert.equal(rest.status, 201);
        const makerDone = await api(
          svc.baseUrl,
          "GET",
          `/v1/orders/${sellOrder.orderId as string}`,
          mint("maker"),
        );
        assert.equal(makerDone.body.status, "filled");
        assert.equal(makerDone.body.remaining, 0);

        const bid = await api(
          svc.baseUrl,
          "POST",
          "/v1/orders",
          mint("taker"),
          { instrumentId: "BTC-USD", side: "buy", type: "limit", priceTicks: 10, quantity: 3 },
          "bid-1",
        );
        assert.equal(bid.status, 201);
        const bidId = orderOf(bid.body).orderId as string;
        const book = await api(svc.baseUrl, "GET", "/v1/books/BTC-USD", null);
        assert.equal(book.status, 200);
        assert.equal((book.body.bids as Array<{ quantity: number }>)[0]?.quantity, 3);

        const denied = await api(svc.baseUrl, "POST", `/v1/orders/${bidId}/cancel`, mint("other"), null, "cancel-no");
        assert.equal(denied.status, 422);
        assert.equal((denied.body.error as { code: string }).code, "NOT_OWNER");
        const still = await api(svc.baseUrl, "GET", `/v1/orders/${bidId}`, mint("taker"));
        assert.equal(still.body.status, "open");

        const cancelled = await api(
          svc.baseUrl,
          "POST",
          `/v1/orders/${bidId}/cancel`,
          mint("taker"),
          null,
          "cancel-yes",
        );
        assert.equal(cancelled.status, 201);
        assert.equal(orderOf(cancelled.body).status, "cancelled");
        const locked = await admin.query<{ locked: number }>(
          "SELECT locked FROM nf_balances WHERE user_id = 'taker' AND asset_id = 'USD'",
        );
        assert.equal(locked.rows[0]?.locked, 0);

        const replay = await api(
          svc.baseUrl,
          "POST",
          "/v1/orders",
          mint("maker"),
          { instrumentId: "BTC-USD", side: "sell", type: "limit", priceTicks: 50, quantity: 10 },
          "sell-1",
        );
        assert.equal(replay.status, 200);
        assert.equal(replay.body.commandId, sell.body.commandId);
        const count = await admin.query<{ n: number }>(
          "SELECT COUNT(*)::int AS n FROM nf_orders WHERE user_id = 'maker' AND order_type = 'limit' AND price_ticks = 50 AND quantity = 10",
        );
        assert.equal(count.rows[0]?.n, 1);
        const conflict = await api(
          svc.baseUrl,
          "POST",
          "/v1/orders",
          mint("maker"),
          { instrumentId: "BTC-USD", side: "sell", type: "limit", priceTicks: 51, quantity: 10 },
          "sell-1",
        );
        assert.equal(conflict.status, 409);

        const ledger = await admin.query<{ debit: number; credit: number }>(
          "SELECT COALESCE(SUM(debit),0)::bigint AS debit, COALESCE(SUM(credit),0)::bigint AS credit FROM nf_ledger",
        );
        assert.equal(ledger.rows[0]?.debit, ledger.rows[0]?.credit);
        assert.ok((ledger.rows[0]?.debit ?? 0) > 0);
        const totals = await admin.query<{ asset_id: string; total: number }>(
          "SELECT asset_id, SUM(available + locked)::bigint AS total FROM nf_balances GROUP BY asset_id",
        );
        const byAsset = new Map(totals.rows.map((row) => [row.asset_id, row.total]));
        assert.equal(byAsset.get("BTC"), 3_000_000_000);
        assert.equal(byAsset.get("USD"), 3_000_000_000);

        const published = await waitFor(async () => {
          const row = await admin.query<{ n: number }>(
            "SELECT COUNT(*)::int AS n FROM nf_outbox WHERE published_at IS NOT NULL",
          );
          return (row.rows[0]?.n ?? 0) > 0 ? row.rows[0]?.n : null;
        });
        assert.ok(published > 0);
      } finally {
        await svc.shutdown("test");
      }
    });
  });

  it("persists a market order and unfilled remainder without leaving a reservation", async () => {
    await exclusive(async () => {
      await resetDb();
      await fund("maker");
      await fund("taker");
      const svc = await startService(env());
      try {
        await api(
          svc.baseUrl,
          "POST",
          "/v1/orders",
          mint("maker"),
          { instrumentId: "BTC-USD", side: "sell", type: "limit", priceTicks: 10, quantity: 2 },
          "m-sell-a",
        );
        await api(
          svc.baseUrl,
          "POST",
          "/v1/orders",
          mint("maker"),
          { instrumentId: "BTC-USD", side: "sell", type: "limit", priceTicks: 11, quantity: 2 },
          "m-sell-b",
        );
        const market = await api(
          svc.baseUrl,
          "POST",
          "/v1/orders",
          mint("taker"),
          { instrumentId: "BTC-USD", side: "buy", type: "market", priceTicks: null, quantity: 10 },
          "m-buy",
        );
        assert.equal(market.status, 201);
        assert.equal(orderOf(market.body).status, "cancelled");
        assert.equal(orderOf(market.body).remaining, 6);
        const fills = market.body.fills as Array<{ quantity: number }>;
        assert.equal(fills.reduce((sum, fill) => sum + fill.quantity, 0), 4);
        const locked = await admin.query<{ locked: number }>(
          "SELECT COALESCE(SUM(locked),0)::bigint AS locked FROM nf_balances WHERE user_id = 'taker'",
        );
        assert.equal(locked.rows[0]?.locked, 0);
        const trades = await admin.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM nf_trades");
        assert.equal(trades.rows[0]?.n, 2);
      } finally {
        await svc.shutdown("test");
      }
    });
  });

  it("restarts from PostgreSQL, preserves FIFO, and does not rematch recovered orders", async () => {
    await exclusive(async () => {
      await resetDb();
      await fund("maker");
      await fund("taker");
      const first = await startService(env());
      let firstId = "";
      let secondId = "";
      try {
        const a = await api(
          first.baseUrl,
          "POST",
          "/v1/orders",
          mint("maker"),
          { instrumentId: "BTC-USD", side: "sell", type: "limit", priceTicks: 80, quantity: 2 },
          "fifo-a",
        );
        const b = await api(
          first.baseUrl,
          "POST",
          "/v1/orders",
          mint("maker"),
          { instrumentId: "BTC-USD", side: "sell", type: "limit", priceTicks: 80, quantity: 2 },
          "fifo-b",
        );
        firstId = orderOf(a.body).orderId as string;
        secondId = orderOf(b.body).orderId as string;
        const crossing = await api(
          first.baseUrl,
          "POST",
          "/v1/orders",
          mint("taker"),
          { instrumentId: "BTC-USD", side: "buy", type: "limit", priceTicks: 70, quantity: 1 },
          "fifo-resting-buy",
        );
        assert.equal(orderOf(crossing.body).status, "open");
      } finally {
        await first.shutdown("restart");
      }
      const before = await admin.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM nf_trades");
      const second = await startService(env());
      try {
        const during = await admin.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM nf_trades");
        assert.equal(during.rows[0]?.n, before.rows[0]?.n);
        const book = await api(second.baseUrl, "GET", "/v1/books/BTC-USD", null);
        assert.equal((book.body.asks as Array<{ quantity: number; orderCount: number }>)[0]?.quantity, 4);
        assert.equal((book.body.asks as Array<{ orderCount: number }>)[0]?.orderCount, 2);
        const buy = await api(
          second.baseUrl,
          "POST",
          "/v1/orders",
          mint("taker"),
          { instrumentId: "BTC-USD", side: "buy", type: "limit", priceTicks: 80, quantity: 2 },
          "fifo-take",
        );
        const fills = buy.body.fills as Array<{ makerOrderId: string; quantity: number }>;
        assert.equal(fills.length, 1);
        assert.equal(fills[0]?.makerOrderId, firstId);
        assert.notEqual(fills[0]?.makerOrderId, secondId);
      } finally {
        await second.shutdown("done");
      }
      const third = await startService(env());
      try {
        const again = await api(
          third.baseUrl,
          "POST",
          "/v1/orders",
          mint("taker"),
          { instrumentId: "BTC-USD", side: "buy", type: "limit", priceTicks: 80, quantity: 2 },
          "fifo-take-2",
        );
        const fills = again.body.fills as Array<{ makerOrderId: string }>;
        assert.equal(fills[0]?.makerOrderId, secondId);
      } finally {
        await third.shutdown("third");
      }
    });
  });

  it("reconciles an abandoned processing command on startup", async () => {
    await exclusive(async () => {
      await resetDb();
      await fund("maker");
      const orderId = "ord_abandoned0001";
      await admin.query(
        `INSERT INTO nf_commands (
           command_id, account_id, idempotency_key, correlation_id, command_type, payload, status, locked_by, locked_at
         ) VALUES ($1, 'maker', 'abandoned-key', 'corr-1', 'PLACE_ORDER', $2::jsonb, 'PROCESSING', 'dead', now())`,
        [
          "cmd_abandoned0001",
          JSON.stringify({
            request: { instrumentId: "BTC-USD", side: "sell", type: "limit", priceTicks: 15, quantity: 1 },
            orderId,
          }),
        ],
      );
      const svc = await startService(env());
      try {
        const row = await waitFor(async () => {
          const found = await admin.query<{ status: string }>(
            "SELECT status FROM nf_orders WHERE order_id = $1",
            [orderId],
          );
          return found.rows[0]?.status === "open" ? found.rows[0] : null;
        });
        assert.equal(row.status, "open");
        const command = await admin.query<{ status: string }>(
          "SELECT status FROM nf_commands WHERE command_id = 'cmd_abandoned0001'",
        );
        assert.equal(command.rows[0]?.status, "COMPLETED");
      } finally {
        await svc.shutdown("abandoned");
      }
    });
  });

  it("rolls back a forced commit failure with no partial order, trade, or ledger", async () => {
    await exclusive(async () => {
      await resetDb();
      await fund("maker");
      testFaults.beforeCommit = () => {
        throw new Error("FORCED_FAILURE");
      };
      const svc = await startService(env({ COMMAND_WAIT_MS: "1000" }));
      try {
        const response = await api(
          svc.baseUrl,
          "POST",
          "/v1/orders",
          mint("maker"),
          { instrumentId: "BTC-USD", side: "sell", type: "limit", priceTicks: 20, quantity: 1 },
          "forced-1",
        );
        assert.equal(response.status, 503);
        const ready = await api(svc.baseUrl, "GET", "/readyz", null);
        assert.equal(ready.status, 503);
        const orders = await admin.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM nf_orders");
        const trades = await admin.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM nf_trades");
        const ledger = await admin.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM nf_ledger");
        const locked = await admin.query<{ locked: number }>(
          "SELECT COALESCE(SUM(locked),0)::bigint AS locked FROM nf_balances",
        );
        assert.equal(orders.rows[0]?.n, 0);
        assert.equal(trades.rows[0]?.n, 0);
        assert.equal(ledger.rows[0]?.n, 0);
        assert.equal(locked.rows[0]?.locked, 0);
        const command = await admin.query<{ status: string }>("SELECT status FROM nf_commands");
        assert.equal(command.rows[0]?.status, "PROCESSING");
      } finally {
        testFaults.beforeCommit = null;
        await svc.shutdown("forced");
      }
    });
  });

  it("rejects unbalanced and mutable ledger writes", async () => {
    await exclusive(async () => {
      await resetDb();
      try {
        await admin.query("BEGIN");
        await admin.query(
          "INSERT INTO nf_ledger_transactions (transaction_id, kind) VALUES ('tx_bad', 'adjustment')",
        );
        await admin.query(
          `INSERT INTO nf_ledger (entry_id, transaction_id, user_id, asset_id, debit, credit, event_hash)
           VALUES ('led_bad', 'tx_bad', 'liquidity-bot', 'USD', 5, 0, 'abcd')`,
        );
        await assert.rejects(admin.query("COMMIT"), /UNBALANCED_LEDGER/);
      } finally {
        await admin.query("ROLLBACK");
      }
      await assert.rejects(
        admin.query(
          `INSERT INTO nf_ledger (entry_id, transaction_id, user_id, asset_id, debit, credit, event_hash)
           VALUES ('led_mixed', 'tx_mixed', 'liquidity-bot', 'USD', 1, 1, 'abcd')`,
        ),
        /nf_ledger_no_mixed_line|check constraint/i,
      );
      await admin.query("BEGIN");
      await admin.query(
        "INSERT INTO nf_ledger_transactions (transaction_id, kind) VALUES ('tx_ok', 'adjustment')",
      );
      await admin.query(
        `INSERT INTO nf_ledger (entry_id, transaction_id, user_id, asset_id, debit, credit, event_hash)
         VALUES ('led_ok_d', 'tx_ok', 'liquidity-bot', 'USD', 1, 0, 'abcd')`,
      );
      await admin.query(
        `INSERT INTO nf_ledger (entry_id, transaction_id, user_id, asset_id, debit, credit, event_hash)
         VALUES ('led_ok_c', 'tx_ok', 'liquidity-bot', 'USD', 0, 1, 'abcd')`,
      );
      await admin.query("COMMIT");
      await assert.rejects(
        admin.query("UPDATE nf_ledger SET debit = 2 WHERE entry_id = 'led_ok_d'"),
        /IMMUTABLE_ROW/,
      );
      await assert.rejects(
        admin.query("DELETE FROM nf_ledger_transactions WHERE transaction_id = 'tx_ok'"),
        /IMMUTABLE_ROW/,
      );
    });
  });

  it("keeps a committed trade when outbox delivery fails", async () => {
    await exclusive(async () => {
      await resetDb();
      await fund("maker");
      setOutboxSink(async () => {
        throw new Error("SINK_DOWN");
      });
      const svc = await startService(env());
      try {
        const response = await api(
          svc.baseUrl,
          "POST",
          "/v1/orders",
          mint("maker"),
          { instrumentId: "BTC-USD", side: "sell", type: "limit", priceTicks: 9, quantity: 1 },
          "outbox-1",
        );
        assert.equal(response.status, 201);
        const row = await waitFor(async () => {
          const found = await admin.query<{ attempts: number; published_at: Date | null }>(
            "SELECT attempts, published_at FROM nf_outbox ORDER BY created_at LIMIT 1",
          );
          return (found.rows[0]?.attempts ?? 0) > 0 ? found.rows[0] : null;
        });
        assert.equal(row.published_at, null);
        const orders = await admin.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM nf_orders");
        assert.equal(orders.rows[0]?.n, 1);
      } finally {
        resetOutboxSink();
        await svc.shutdown("outbox");
      }
    });
  });

  it("refuses a second matcher while the lock is held", async () => {
    await exclusive(async () => {
      await resetDb();
      await fund("maker");
      const primary = await startService(env({ MATCHER_INSTANCE_ID: "primary-a" }));
      const secondary = await startService(env({ MATCHER_INSTANCE_ID: "secondary-b" }));
      try {
        assert.equal((await api(primary.baseUrl, "GET", "/readyz", null)).status, 200);
        const other = await api(secondary.baseUrl, "GET", "/readyz", null);
        assert.equal(other.status, 503);
        assert.equal(other.body.ready, false);
        const rejected = await api(
          secondary.baseUrl,
          "POST",
          "/v1/orders",
          mint("maker"),
          { instrumentId: "BTC-USD", side: "buy", type: "limit", priceTicks: 3, quantity: 1 },
          "second-writer",
        );
        assert.equal(rejected.status, 503);
        const accepted = await api(
          primary.baseUrl,
          "POST",
          "/v1/orders",
          mint("maker"),
          { instrumentId: "BTC-USD", side: "buy", type: "limit", priceTicks: 3, quantity: 1 },
          "primary-writer",
        );
        assert.equal(accepted.status, 201);
      } finally {
        await secondary.shutdown("secondary");
        await primary.shutdown("primary");
      }
    });
  });

  it("fails closed when the advisory lock session dies", async () => {
    await exclusive(async () => {
      await resetDb();
      await fund("maker");
      const svc = await startService(env());
      try {
        const placed = await api(
          svc.baseUrl,
          "POST",
          "/v1/orders",
          mint("maker"),
          { instrumentId: "BTC-USD", side: "buy", type: "limit", priceTicks: 4, quantity: 1 },
          "before-loss",
        );
        assert.equal(placed.status, 201);
        const pid = await admin.query<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE application_name = $1",
          [`nexusflow-lock-${svc.config.matcherInstanceId}`],
        );
        assert.ok(pid.rows[0]?.pid);
        await admin.query("SELECT pg_terminate_backend($1)", [pid.rows[0]?.pid]);
        const ready = await waitFor(async () => {
          const response = await api(svc.baseUrl, "GET", "/readyz", null);
          return response.status === 503 ? response : null;
        });
        assert.equal(ready.body.ready, false);
        const next = await api(
          svc.baseUrl,
          "POST",
          "/v1/orders",
          mint("maker"),
          { instrumentId: "BTC-USD", side: "buy", type: "limit", priceTicks: 4, quantity: 1 },
          "after-loss",
        );
        assert.equal(next.status, 503);
        const still = await api(
          svc.baseUrl,
          "GET",
          `/v1/orders/${orderOf(placed.body).orderId as string}`,
          mint("maker"),
        );
        assert.equal(still.status, 200);
        assert.equal(still.body.status, "open");
      } finally {
        await svc.shutdown("lock-loss");
      }
    });
  });

  it("reports alive but not ready when PostgreSQL is unreachable", async () => {
    await exclusive(async () => {
      const svc = await startService(
        env({
          DATABASE_URL: "postgres://postgres@127.0.0.1:1/nexusflow_test",
          CONNECTION_TIMEOUT_MS: "400",
          AUTO_MIGRATE: "false",
        }),
      );
      try {
        assert.equal((await api(svc.baseUrl, "GET", "/healthz", null)).status, 200);
        const ready = await api(svc.baseUrl, "GET", "/readyz", null);
        assert.equal(ready.status, 503);
        assert.equal(ready.body.ready, false);
      } finally {
        await svc.shutdown("db-down");
      }
    });
  });

  it("reports not ready when required migrations are absent", async () => {
    await exclusive(async () => {
      const svc = await startService(
        env({
          DATABASE_URL: databaseUrl("nexusflow_nomig"),
          AUTO_MIGRATE: "false",
        }),
      );
      try {
        assert.equal((await api(svc.baseUrl, "GET", "/healthz", null)).status, 200);
        const ready = await api(svc.baseUrl, "GET", "/readyz", null);
        assert.equal(ready.status, 503);
        assert.equal(ready.body.ready, false);
        const checks = ready.body.checks as { schema: boolean };
        assert.equal(checks.schema, false);
      } finally {
        await svc.shutdown("no-schema");
      }
    });
  });

  it("rate limits before inserting a command and rejects a full queue", async () => {
    await exclusive(async () => {
      await resetDb();
      await fund("maker");
      const limited = await startService(
        env({ RATE_LIMIT_CAPACITY: "1", RATE_LIMIT_REFILL_PER_SEC: "0", MATCHER_INSTANCE_ID: "rate-1" }),
      );
      try {
        const first = await api(
          limited.baseUrl,
          "POST",
          "/v1/orders",
          mint("maker"),
          { instrumentId: "BTC-USD", side: "buy", type: "limit", priceTicks: 2, quantity: 1 },
          "rate-a",
        );
        assert.equal(first.status, 201);
        const second = await api(
          limited.baseUrl,
          "POST",
          "/v1/orders",
          mint("maker"),
          { instrumentId: "BTC-USD", side: "buy", type: "limit", priceTicks: 2, quantity: 1 },
          "rate-b",
        );
        assert.equal(second.status, 429);
        const inserted = await admin.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM nf_commands");
        assert.equal(inserted.rows[0]?.n, 1);
      } finally {
        await limited.shutdown("rate");
      }
      await resetDb();
      await fund("maker");
      testFaults.pauseClaim = true;
      const queued = await startService(
        env({
          MAX_COMMAND_QUEUE_DEPTH: "1",
          MATCHER_INSTANCE_ID: "queue-1",
          COMMAND_WAIT_MS: "300",
        }),
      );
      try {
        const first = await api(
          queued.baseUrl,
          "POST",
          "/v1/orders",
          mint("maker"),
          { instrumentId: "BTC-USD", side: "buy", type: "limit", priceTicks: 2, quantity: 1 },
          "queue-a",
        );
        assert.equal(first.status, 202);
        const second = await api(
          queued.baseUrl,
          "POST",
          "/v1/orders",
          mint("maker"),
          { instrumentId: "BTC-USD", side: "buy", type: "limit", priceTicks: 2, quantity: 1 },
          "queue-b",
        );
        assert.equal(second.status, 429);
        assert.equal((second.body.error as { code: string }).code, "QUEUE_DEPTH");
      } finally {
        testFaults.pauseClaim = false;
        await queued.shutdown("queue");
      }
    });
  });

  it("returns the stored result when the same idempotency key is retried after commit", async () => {
    await exclusive(async () => {
      await resetDb();
      await fund("maker");
      const svc = await startService(env({ COMMAND_WAIT_MS: "0" }));
      try {
        const first = await api(
          svc.baseUrl,
          "POST",
          "/v1/orders",
          mint("maker"),
          { instrumentId: "ETH-USD", side: "buy", type: "limit", priceTicks: 6, quantity: 2 },
          "timeout-key",
        );
        assert.ok(first.status === 201 || first.status === 202);
        const completed = await waitFor(async () => {
          const row = await admin.query<{ status: string; result: { order: { orderId: string } } }>(
            "SELECT status, result FROM nf_commands WHERE idempotency_key = 'timeout-key'",
          );
          return row.rows[0]?.status === "COMPLETED" ? row.rows[0] : null;
        });
        const retry = await api(
          svc.baseUrl,
          "POST",
          "/v1/orders",
          mint("maker"),
          { instrumentId: "ETH-USD", side: "buy", type: "limit", priceTicks: 6, quantity: 2 },
          "timeout-key",
        );
        assert.equal(retry.status, 200);
        assert.equal(orderOf(retry.body).orderId, completed.result.order.orderId);
        const count = await admin.query<{ n: number }>(
          "SELECT COUNT(*)::int AS n FROM nf_orders WHERE instrument_id = 'ETH-USD'",
        );
        assert.equal(count.rows[0]?.n, 1);
      } finally {
        await svc.shutdown("retry");
      }
    });
  });

  it("stops on SIGTERM without running the benchmark", async () => {
    await exclusive(async () => {
      await resetDb();
      const port = 18081;
      const child = spawn(process.execPath, ["--experimental-strip-types", "src/main.ts"], {
        cwd: repoRoot(),
        env: {
          ...env({ PORT: String(port), MATCHER_INSTANCE_ID: "signal-1", AUTO_MIGRATE: "true" }),
          PATH: process.env.PATH,
          HOME: process.env.HOME,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let logs = "";
      child.stdout?.on("data", (chunk) => {
        logs += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        logs += chunk.toString();
      });
      try {
        await waitFor(async () => {
          try {
            const response = await fetch(`http://127.0.0.1:${port}/readyz`);
            return response.status === 200 ? true : null;
          } catch {
            return null;
          }
        }, 8000);
        assert.equal(child.exitCode, null);
        assert.doesNotMatch(logs, /insertPerSec/);
        child.kill("SIGTERM");
        const code = await waitExit(child);
        assert.equal(code, 0);
        const again = spawn(process.execPath, ["--experimental-strip-types", "src/main.ts"], {
          cwd: repoRoot(),
          env: {
            ...env({ PORT: "18082", MATCHER_INSTANCE_ID: "signal-2", AUTO_MIGRATE: "true" }),
            PATH: process.env.PATH,
            HOME: process.env.HOME,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        try {
          await waitFor(async () => {
            try {
              const response = await fetch("http://127.0.0.1:18082/readyz");
              return response.status === 200 ? true : null;
            } catch {
              return null;
            }
          }, 8000);
          again.kill("SIGINT");
          assert.equal(await waitExit(again), 0);
        } catch (error) {
          again.kill("SIGKILL");
          throw error;
        }
      } catch (error) {
        child.kill("SIGKILL");
        throw new Error(`${error instanceof Error ? error.message : error}\n${logs}`);
      }
    });
  });
});

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 4000): Promise<T> {
  const start = Date.now();
  let last: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw last instanceof Error ? last : new Error("timed out");
}

function waitExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("shutdown timed out")), 8000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

void randomUUID;
void 0 as unknown as RunningService;
