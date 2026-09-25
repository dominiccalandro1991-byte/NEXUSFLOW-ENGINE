import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { migrationDir } from "../paths.ts";
import { log, safeError } from "../log.ts";

export async function applyMigrations(pool: pg.Pool, directory = migrationDir()): Promise<string[]> {
  const client = await pool.connect();
  const appliedNow: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('nexusflow:migrate'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS nf_schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const names = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
    const existing = await client.query<{ version: string }>("SELECT version FROM nf_schema_migrations");
    const have = new Set(existing.rows.map((row) => row.version));
    for (const name of names) {
      const version = name.slice(0, -4);
      if (have.has(version)) continue;
      const sql = await readFile(path.join(directory, name), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO nf_schema_migrations (version) VALUES ($1)", [version]);
        await client.query("COMMIT");
        appliedNow.push(version);
        log("info", "migration applied", { version });
      } catch (error) {
        await client.query("ROLLBACK");
        log("error", "migration failed", { version, error: safeError(error) });
        throw error;
      }
    }
    return appliedNow;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('nexusflow:migrate'))").catch(() => undefined);
    client.release();
  }
}

const isDirect = process.argv[1]?.endsWith("migrate.ts") || process.argv[1]?.endsWith("migrate.js");
if (isDirect) {
  const { loadConfig } = await import("../config.ts");
  const { createPool } = await import("./pool.ts");
  const { setLogLevel } = await import("../log.ts");
  const config = loadConfig(process.env);
  setLogLevel(config.logLevel);
  const pool = createPool(config);
  try {
    const applied = await applyMigrations(pool);
    console.log(JSON.stringify({ applied }));
  } finally {
    await pool.end();
  }
}
