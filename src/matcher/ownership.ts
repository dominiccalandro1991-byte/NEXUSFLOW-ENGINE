import type { AppConfig } from "../config.ts";
import { createDedicatedClient } from "../db/pool.ts";
import { log, safeError } from "../log.ts";
import type pg from "pg";

/**
 * Session-level advisory lock. The dedicated connection is the ownership lease:
 * if it dies, PostgreSQL releases the lock and this process fails closed.
 */
export class MatcherOwnership {
  private client: pg.Client | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private held = false;
  private closing = false;
  private config: AppConfig;
  private onLoss: (reason: string) => void;

  constructor(config: AppConfig, onLoss: (reason: string) => void) {
    this.config = config;
    this.onLoss = onLoss;
  }

  isHeld(): boolean {
    return this.held;
  }

  async acquire(): Promise<boolean> {
    const client = await createDedicatedClient(
      this.config,
      `nexusflow-lock-${this.config.matcherInstanceId}`,
    );
    this.client = client;
    const lose = (reason: string) => {
      if (this.closing || !this.held) return;
      this.held = false;
      log("error", "matcher lock lost", { reason, instanceId: this.config.matcherInstanceId });
      this.onLoss(reason);
    };
    client.on("error", (error) => lose(`LOCK_CONNECTION_ERROR:${safeError(error)}`));
    client.on("end", () => lose("LOCK_CONNECTION_CLOSED"));
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [this.config.matcherLockKey],
    );
    if (result.rows[0]?.locked !== true) {
      this.closing = true;
      await client.end().catch(() => undefined);
      this.client = null;
      this.closing = false;
      return false;
    }
    this.held = true;
    this.timer = setInterval(() => {
      client.query("SELECT 1").catch((error) => lose(`LOCK_HEARTBEAT_FAILED:${safeError(error)}`));
    }, this.config.lockHeartbeatMs);
    this.timer.unref?.();
    return true;
  }

  async release(): Promise<void> {
    this.closing = true;
    this.held = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [this.config.matcherLockKey]);
    } catch {
      // Session close releases a session advisory lock.
    }
    await client.end().catch(() => undefined);
  }
}
