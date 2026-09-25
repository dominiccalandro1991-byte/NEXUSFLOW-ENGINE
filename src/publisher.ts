import type pg from "pg";
import type { AppConfig } from "./config.ts";
import { claimOutbox, markOutboxPublished, markOutboxRetry, type OutboxRow } from "./db/repositories/outbox.ts";
import { log, safeError } from "./log.ts";

export type OutboxSink = (event: OutboxRow) => Promise<void>;

let sink: OutboxSink = async () => undefined;

export function setOutboxSink(next: OutboxSink): void {
  sink = next;
}

export function resetOutboxSink(): void {
  sink = async () => undefined;
}

/**
 * Publishes committed outbox rows. Delivery failure never rolls back a trade.
 */
export class OutboxPublisher {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private current: Promise<void> | null = null;
  private config: AppConfig;
  private pool: pg.Pool;

  constructor(config: AppConfig, pool: pg.Pool) {
    this.config = config;
    this.pool = pool;
  }

  start(): void {
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.current) await this.current.catch(() => undefined);
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.current = this.tick().finally(() => {
        this.current = null;
      });
    }, delay);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    try {
      const batch = await claimOutbox(this.pool, this.config.outboxBatchSize);
      for (const event of batch) {
        try {
          await sink(event);
          await markOutboxPublished(this.pool, event.event_id);
        } catch (error) {
          await markOutboxRetry(this.pool, event.event_id, safeError(error));
          log("warn", "outbox delivery failed", {
            eventId: event.event_id,
            error: safeError(error),
          });
        }
      }
    } catch (error) {
      log("error", "outbox poll failed", { error: safeError(error) });
    }
    this.schedule(this.config.outboxPollIntervalMs);
  }
}
