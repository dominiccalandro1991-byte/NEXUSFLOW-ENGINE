import type pg from "pg";
import { REQUIRED_MIGRATIONS, REQUIRED_TABLES, REQUIRED_TRIGGERS } from "./versions.ts";

export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaError";
  }
}

export async function assertSchema(pool: pg.Pool): Promise<void> {
  const versions = await pool.query<{ version: string }>(
    "SELECT version FROM nf_schema_migrations ORDER BY version",
  );
  const have = new Set(versions.rows.map((row) => row.version));
  for (const version of REQUIRED_MIGRATIONS) {
    if (!have.has(version)) {
      throw new SchemaError(`Missing required migration ${version}`);
    }
  }
  const tables = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [REQUIRED_TABLES],
  );
  const tableSet = new Set(tables.rows.map((row) => row.table_name));
  for (const table of REQUIRED_TABLES) {
    if (!tableSet.has(table)) throw new SchemaError(`Missing required table ${table}`);
  }
  const triggers = await pool.query<{ tgname: string }>(
    `SELECT tgname FROM pg_trigger WHERE tgname = ANY($1::text[]) AND NOT tgisinternal`,
    [REQUIRED_TRIGGERS],
  );
  const triggerSet = new Set(triggers.rows.map((row) => row.tgname));
  for (const trigger of REQUIRED_TRIGGERS) {
    if (!triggerSet.has(trigger)) throw new SchemaError(`Missing required trigger ${trigger}`);
  }
}
