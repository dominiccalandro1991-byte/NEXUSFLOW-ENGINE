export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type NodeEnv = "development" | "test" | "production";
export type DatabaseSslMode = "disable" | "require" | "no-verify";
export type AuthMode = "hmac" | "supabase";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface AppConfig {
  nodeEnv: NodeEnv;
  port: number;
  databaseUrl: string;
  databaseSsl: DatabaseSslMode;
  pgPoolMax: number;
  statementTimeoutMs: number;
  queryTimeoutMs: number;
  connectionTimeoutMs: number;
  supabaseUrl: string | null;
  supabaseJwtSecret: string | null;
  authMode: AuthMode;
  jwtIssuer: string;
  jwtAudience: string;
  matcherLockKey: string;
  matcherInstanceId: string;
  commandPollIntervalMs: number;
  commandWaitMs: number;
  maxCommandQueueDepth: number;
  commandLeaseMs: number;
  maxBodyBytes: number;
  rateLimitCapacity: number;
  rateLimitRefillPerSec: number;
  outboxPollIntervalMs: number;
  outboxBatchSize: number;
  lockHeartbeatMs: number;
  shutdownDrainMs: number;
  logLevel: LogLevel;
  autoMigrate: boolean;
  requiredSchemaVersion: string;
}

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

function emptyToNull(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function requiredUrl(env: NodeJS.ProcessEnv, key: string): string {
  const value = emptyToNull(env[key]);
  if (!value) throw new ConfigError(`Missing required configuration: ${key}`);
  return value;
}

function intEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^-?\d+$/.test(raw.trim())) throw new ConfigError(`${key} must be an integer`);
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigError(`${key} must be between ${min} and ${max}`);
  }
  return value;
}

function boolEnv(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new ConfigError(`${key} must be true or false`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnvRaw = (env.NODE_ENV ?? "development").trim();
  if (nodeEnvRaw !== "development" && nodeEnvRaw !== "test" && nodeEnvRaw !== "production") {
    throw new ConfigError("NODE_ENV must be development, test, or production");
  }
  const nodeEnv = nodeEnvRaw;
  const databaseUrl = requiredUrl(env, "DATABASE_URL");
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new ConfigError("DATABASE_URL is not a valid URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new ConfigError("DATABASE_URL must use the postgres or postgresql scheme");
  }
  if (!parsed.hostname) throw new ConfigError("DATABASE_URL is missing a host");

  const sslRaw = (env.DATABASE_SSL ?? "").trim();
  let databaseSsl: DatabaseSslMode;
  if (sslRaw === "") {
    const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    databaseSsl = local ? "disable" : "require";
  } else if (sslRaw === "disable" || sslRaw === "require" || sslRaw === "no-verify") {
    databaseSsl = sslRaw;
  } else {
    throw new ConfigError("DATABASE_SSL must be disable, require, or no-verify");
  }
  if (
    nodeEnv === "production" &&
    databaseSsl === "disable" &&
    parsed.hostname !== "localhost" &&
    parsed.hostname !== "127.0.0.1"
  ) {
    throw new ConfigError("DATABASE_SSL=disable is not allowed for remote databases in production");
  }

  const supabaseUrl = emptyToNull(env.SUPABASE_URL);
  if (supabaseUrl) {
    let supabase: URL;
    try {
      supabase = new URL(supabaseUrl);
    } catch {
      throw new ConfigError("SUPABASE_URL is not a valid URL");
    }
    if (nodeEnv === "production" && supabase.protocol !== "https:") {
      throw new ConfigError("SUPABASE_URL must use https in production");
    }
  }

  const jwtSecret =
    emptyToNull(env.NEXUSFLOW_JWT_SECRET) ?? emptyToNull(env.SUPABASE_JWT_SECRET);
  const authRaw = (env.NEXUSFLOW_AUTH_MODE ?? "").trim();
  let authMode: AuthMode;
  if (authRaw === "") authMode = supabaseUrl && !jwtSecret ? "supabase" : "hmac";
  else if (authRaw === "hmac" || authRaw === "supabase") authMode = authRaw;
  else throw new ConfigError("NEXUSFLOW_AUTH_MODE must be hmac or supabase");

  if (authMode === "hmac" && !jwtSecret) {
    throw new ConfigError(
      "Missing required configuration: NEXUSFLOW_JWT_SECRET or SUPABASE_JWT_SECRET",
    );
  }
  if (authMode === "supabase" && !supabaseUrl) {
    throw new ConfigError("Missing required configuration: SUPABASE_URL");
  }
  if (jwtSecret !== null && jwtSecret.length < 16) {
    throw new ConfigError("JWT secret must be at least 16 characters");
  }

  const issuerDefault =
    authMode === "supabase" && supabaseUrl
      ? `${supabaseUrl.replace(/\/$/, "")}/auth/v1`
      : "nexusflow-local";
  const jwtIssuer = (env.JWT_ISSUER ?? issuerDefault).trim();
  const jwtAudience = (env.JWT_AUDIENCE ?? "authenticated").trim();
  if (!jwtIssuer || !jwtAudience) {
    throw new ConfigError("JWT_ISSUER and JWT_AUDIENCE must be non-empty");
  }

  const logLevelRaw = (env.LOG_LEVEL ?? (nodeEnv === "test" ? "error" : "info")).trim();
  if (!LOG_LEVELS.includes(logLevelRaw as LogLevel)) {
    throw new ConfigError("LOG_LEVEL must be debug, info, warn, or error");
  }

  const matcherLockKey = (env.MATCHER_LOCK_KEY ?? "nexusflow:global-matcher").trim();
  if (!matcherLockKey || matcherLockKey.length > 200) {
    throw new ConfigError("MATCHER_LOCK_KEY must be 1 to 200 characters");
  }

  const instanceDefault = `nf-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
  const matcherInstanceId = (env.MATCHER_INSTANCE_ID ?? instanceDefault).trim();
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(matcherInstanceId)) {
    throw new ConfigError("MATCHER_INSTANCE_ID contains unsupported characters");
  }

  return {
    nodeEnv,
    port: intEnv(env, "PORT", 8080, 0, 65535),
    databaseUrl,
    databaseSsl,
    pgPoolMax: intEnv(env, "PG_POOL_MAX", 8, 1, 32),
    statementTimeoutMs: intEnv(env, "STATEMENT_TIMEOUT_MS", 10000, 100, 120000),
    queryTimeoutMs: intEnv(env, "QUERY_TIMEOUT_MS", 10000, 100, 120000),
    connectionTimeoutMs: intEnv(env, "CONNECTION_TIMEOUT_MS", 3000, 100, 30000),
    supabaseUrl,
    supabaseJwtSecret: jwtSecret,
    authMode,
    jwtIssuer,
    jwtAudience,
    matcherLockKey,
    matcherInstanceId,
    commandPollIntervalMs: intEnv(env, "COMMAND_POLL_INTERVAL_MS", 50, 5, 60000),
    commandWaitMs: intEnv(env, "COMMAND_WAIT_MS", 2000, 0, 30000),
    maxCommandQueueDepth: intEnv(env, "MAX_COMMAND_QUEUE_DEPTH", 1000, 1, 100000),
    commandLeaseMs: intEnv(env, "COMMAND_LEASE_MS", 30000, 1000, 300000),
    maxBodyBytes: intEnv(env, "MAX_BODY_BYTES", 16384, 128, 1_000_000),
    rateLimitCapacity: intEnv(env, "RATE_LIMIT_CAPACITY", 30, 1, 100000),
    rateLimitRefillPerSec: intEnv(env, "RATE_LIMIT_REFILL_PER_SEC", 10, 0, 100000),
    outboxPollIntervalMs: intEnv(env, "OUTBOX_POLL_INTERVAL_MS", 200, 10, 60000),
    outboxBatchSize: intEnv(env, "OUTBOX_BATCH_SIZE", 50, 1, 1000),
    lockHeartbeatMs: intEnv(env, "LOCK_HEARTBEAT_MS", 2000, 100, 60000),
    shutdownDrainMs: intEnv(env, "SHUTDOWN_DRAIN_MS", 5000, 100, 120000),
    logLevel: logLevelRaw as LogLevel,
    autoMigrate: boolEnv(env, "AUTO_MIGRATE", nodeEnv !== "production"),
    requiredSchemaVersion: "20260925120000_production_service",
  };
}
