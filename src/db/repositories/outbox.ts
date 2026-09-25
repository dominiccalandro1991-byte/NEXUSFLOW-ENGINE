import type pg from "pg";
import type { Queryable } from "../pool.ts";

export interface OutboxRow {
  event_id: string;
  command_id: string | null;
  account_id: string | null;
  topic: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export async function enqueueOutbox(
  db: Queryable,
  row: {
    eventId: string;
    commandId: string;
    accountId: string;
    topic: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO nf_outbox (event_id, command_id, account_id, topic, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [row.eventId, row.commandId, row.accountId, row.topic, JSON.stringify(row.payload)],
  );
}

export async function claimOutbox(pool: pg.Pool, limit: number): Promise<OutboxRow[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<OutboxRow>(
      `WITH next AS (
         SELECT event_id
         FROM nf_outbox
         WHERE published_at IS NULL AND next_attempt_at <= now()
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE nf_outbox AS o
       SET attempts = o.attempts + 1
       FROM next
       WHERE o.event_id = next.event_id
       RETURNING o.event_id, o.command_id, o.account_id, o.topic, o.payload, o.attempts`,
      [limit],
    );
    await client.query("COMMIT");
    return result.rows;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function markOutboxPublished(pool: pg.Pool, eventId: string): Promise<void> {
  await pool.query(
    `UPDATE nf_outbox SET published_at = now(), last_error = NULL WHERE event_id = $1`,
    [eventId],
  );
}

export async function markOutboxRetry(pool: pg.Pool, eventId: string, error: string): Promise<void> {
  await pool.query(
    `UPDATE nf_outbox
     SET next_attempt_at = now() + interval '1 second', last_error = $2
     WHERE event_id = $1`,
    [eventId, error.slice(0, 300)],
  );
}
