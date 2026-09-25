import type { Server } from "node:http";
import { loadConfig, type AppConfig } from "./config.ts";
import { applyMigrations } from "./db/migrate.ts";
import { createPool } from "./db/pool.ts";
import { assertSchema, SchemaError } from "./db/schema-check.ts";
import { HealthState } from "./health.ts";
import { createHttpServer } from "./http/app.ts";
import { gracefulShutdown } from "./lifecycle.ts";
import { log, safeError, setLogLevel } from "./log.ts";
import { BookSet } from "./matcher/books.ts";
import { MatcherOwnership } from "./matcher/ownership.ts";
import { CommandProcessor } from "./matcher/processor.ts";
import { reconcileAbandoned, recoverBooks } from "./matcher/recovery.ts";
import { OutboxPublisher } from "./publisher.ts";
import { AccountLimiter } from "./rate-limit.ts";
import type pg from "pg";

export interface RunningService {
  config: AppConfig;
  state: HealthState;
  pool: pg.Pool;
  port: number;
  baseUrl: string;
  shutdown: (signal: string) => Promise<number>;
}

export async function startService(env: NodeJS.ProcessEnv = process.env): Promise<RunningService> {
  const config = loadConfig(env);
  setLogLevel(config.logLevel);
  const state = new HealthState();
  state.configValid = true;
  state.instanceId = config.matcherInstanceId;
  const pool = createPool(config);
  const books = new BookSet();
  let server: Server | null = null;
  let ownership: MatcherOwnership | null = null;
  let shuttingDown = false;

  const processor = new CommandProcessor(config, pool, books, state, (reason) => failClosed(reason));
  const publisher = new OutboxPublisher(config, pool);

  function failClosed(reason: string): void {
    if (state.failure && state.failure !== "LOCK_NOT_ACQUIRED") return;
    state.lockHeld = ownership?.isHeld() ?? false;
    state.failure = reason.slice(0, 300);
    state.processorActive = false;
    log("error", "fail closed", { reason: state.failure, instanceId: config.matcherInstanceId });
    void processor.abortActive();
    void processor.stop();
  }

  try {
    await pool.query("SELECT 1");
    state.dbHealthy = true;
  } catch (error) {
    state.dbHealthy = false;
    state.failure = "DB_UNAVAILABLE";
    log("error", "database unavailable", { error: safeError(error) });
  }

  if (state.dbHealthy && config.autoMigrate && state.failure === null) {
    try {
      await applyMigrations(pool);
    } catch (error) {
      state.failure = "MIGRATION_FAILED";
      log("error", "migration failed", { error: safeError(error) });
    }
  }

  if (state.dbHealthy && state.failure === null) {
    try {
      await assertSchema(pool);
      state.schemaValid = true;
    } catch (error) {
      state.schemaValid = false;
      state.failure = error instanceof SchemaError ? error.message : "SCHEMA_INVALID";
      log("error", "schema check failed", { error: safeError(error) });
    }
  }

  if (state.schemaValid && state.failure === null) {
    ownership = new MatcherOwnership(config, (reason) => {
      state.lockHeld = false;
      failClosed(reason);
    });
    try {
      const locked = await ownership.acquire();
      state.lockHeld = locked;
      if (!locked) {
        state.failure = "LOCK_NOT_ACQUIRED";
        log("error", "advisory lock not acquired", { instanceId: config.matcherInstanceId });
      } else {
        const abandoned = await reconcileAbandoned(pool);
        log("info", "reconciled abandoned commands", { abandoned });
        await recoverBooks(pool, books);
        state.recoveryCompleted = true;
        processor.start();
        publisher.start();
      }
    } catch (error) {
      state.recoveryCompleted = false;
      state.failure = `RECOVERY_FAILED:${safeError(error)}`.slice(0, 300);
      log("error", "recovery failed", { error: safeError(error) });
    }
  }

  const limiter = new AccountLimiter(config.rateLimitCapacity, config.rateLimitRefillPerSec);
  server = createHttpServer({ config, pool, state, processor, limiter });
  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject);
    server?.listen(config.port, "0.0.0.0", () => resolve());
  });
  state.ingressOpen = true;
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  log("info", "ingress listening", { port, ready: state.ready, instanceId: config.matcherInstanceId });

  return {
    config,
    state,
    pool,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    shutdown: async (signal: string) => {
      if (shuttingDown) return 0;
      shuttingDown = true;
      return gracefulShutdown({
        signal,
        state,
        stopProcessor: () => processor.stop(),
        stopPublisher: () => publisher.stop(),
        stopIngress: () =>
          new Promise((resolve) => {
            if (!server) {
              resolve();
              return;
            }
            server.close(() => resolve());
          }),
        releaseLock: () => ownership?.release() ?? Promise.resolve(),
        closePool: () => pool.end(),
      });
    },
  };
}
