import type { LogLevel } from "./config.ts";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let minimum: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  minimum = level;
}

export function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/postgres(?:ql)?:\/\/\S+/gi, "postgres://redacted").slice(0, 400);
}

export function log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (RANK[level] < RANK[minimum]) return;
  const payload: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
  };
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (key === "databaseUrl" || key === "authorization" || key === "jwt") continue;
      payload[key] = value;
    }
  }
  console.log(JSON.stringify(payload));
}
