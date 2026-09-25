import pg from "pg";
import type { AppConfig } from "../config.ts";

let parsersReady = false;

function installParsers(): void {
  if (parsersReady) return;
  pg.types.setTypeParser(20, (value) => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      throw new Error("BIGINT_OUT_OF_SAFE_INTEGER_RANGE");
    }
    return parsed;
  });
  parsersReady = true;
}

export function sslOption(config: AppConfig): false | { rejectUnauthorized: boolean } {
  if (config.databaseSsl === "disable") return false;
  if (config.databaseSsl === "no-verify") return { rejectUnauthorized: false };
  return { rejectUnauthorized: true };
}

export function createPool(config: AppConfig): pg.Pool {
  installParsers();
  return new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.pgPoolMax,
    statement_timeout: config.statementTimeoutMs,
    query_timeout: config.queryTimeoutMs,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    ssl: sslOption(config),
    application_name: "nexusflow-pool",
  });
}

export async function createDedicatedClient(
  config: AppConfig,
  applicationName: string,
): Promise<pg.Client> {
  installParsers();
  const client = new pg.Client({
    connectionString: config.databaseUrl,
    ssl: sslOption(config),
    application_name: applicationName,
    statement_timeout: config.statementTimeoutMs,
    query_timeout: config.queryTimeoutMs,
    connectionTimeoutMillis: config.connectionTimeoutMs,
  });
  await client.connect();
  return client;
}

export type Queryable = pg.Pool | pg.PoolClient | pg.Client;
