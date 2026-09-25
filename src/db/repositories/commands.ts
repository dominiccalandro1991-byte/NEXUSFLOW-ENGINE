import type pg from "pg";
import type { Queryable } from "../pool.ts";

export type CommandType = "PLACE_ORDER" | "CANCEL_ORDER";
export type CommandStatus =
  | "PENDING"
  | "PROCESSING"
  | "COMPLETED"
  | "REJECTED"
  | "FAILED_RETRYABLE";

export interface CommandRow {
  command_id: string;
  account_id: string;
  idempotency_key: string;
  correlation_id: string;
  command_type: CommandType;
  payload: Record<string, unknown>;
  status: CommandStatus;
  result: Record<string, unknown> | null;
  error_code: string | null;
  error_message: string | null;
}

const COLUMNS = `command_id, account_id, idempotency_key, correlation_id, command_type,
  payload, status, result, error_code, error_message`;

export async function insertCommand(
  db: Queryable,
  row: {
    commandId: string;
    accountId: string;
    idempotencyKey: string;
    correlationId: string;
    commandType: CommandType;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO nf_commands (
       command_id, account_id, idempotency_key, correlation_id, command_type, payload, status
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'PENDING')`,
    [
      row.commandId,
      row.accountId,
      row.idempotencyKey,
      row.correlationId,
      row.commandType,
      JSON.stringify(row.payload),
    ],
  );
}

export async function getByIdempotency(
  db: Queryable,
  accountId: string,
  idempotencyKey: string,
): Promise<CommandRow | null> {
  const result = await db.query<CommandRow>(
    `SELECT ${COLUMNS} FROM nf_commands WHERE account_id = $1 AND idempotency_key = $2`,
    [accountId, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

export async function getCommand(db: Queryable, commandId: string): Promise<CommandRow | null> {
  const result = await db.query<CommandRow>(
    `SELECT ${COLUMNS} FROM nf_commands WHERE command_id = $1`,
    [commandId],
  );
  return result.rows[0] ?? null;
}

export async function countQueued(db: Queryable): Promise<number> {
  const result = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM nf_commands WHERE status IN ('PENDING', 'PROCESSING')`,
  );
  return result.rows[0]?.n ?? 0;
}

export async function claimNext(pool: pg.Pool, instanceId: string): Promise<CommandRow | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<CommandRow>(
      `WITH next_cmd AS (
         SELECT command_id
         FROM nf_commands
         WHERE status IN ('PENDING', 'FAILED_RETRYABLE')
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE nf_commands AS c
       SET status = 'PROCESSING', locked_by = $1, locked_at = now(), updated_at = now()
       FROM next_cmd
       WHERE c.command_id = next_cmd.command_id
       RETURNING c.command_id, c.account_id, c.idempotency_key, c.correlation_id,
                 c.command_type, c.payload, c.status, c.result, c.error_code, c.error_message`,
      [instanceId],
    );
    await client.query("COMMIT");
    return result.rows[0] ?? null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function markCompleted(
  db: Queryable,
  commandId: string,
  result: Record<string, unknown>,
): Promise<void> {
  const updated = await db.query(
    `UPDATE nf_commands
     SET status = 'COMPLETED', result = $2::jsonb, error_code = NULL, error_message = NULL,
         updated_at = now()
     WHERE command_id = $1 AND status = 'PROCESSING'`,
    [commandId, JSON.stringify(result)],
  );
  if (updated.rowCount !== 1) throw new Error("COMMAND_COMPLETE_CONFLICT");
}

export async function markRejected(
  pool: pg.Pool,
  commandId: string,
  code: string,
  message: string,
): Promise<CommandRow | null> {
  const result = await pool.query<CommandRow>(
    `UPDATE nf_commands
     SET status = 'REJECTED', error_code = $2, error_message = $3, updated_at = now()
     WHERE command_id = $1 AND status = 'PROCESSING'
     RETURNING ${COLUMNS}`,
    [commandId, code, message.slice(0, 400)],
  );
  return result.rows[0] ?? null;
}
