import type pg from "pg";
import type { AppConfig } from "../config.ts";
import { getCommand, claimNext, markRejected, type CommandRow } from "../db/repositories/commands.ts";
import { BusinessRejection } from "../db/repositories/ledger.ts";
import { log, safeError } from "../log.ts";
import type { HealthState } from "../health.ts";
import { BookSet } from "./books.ts";
import { testFaults } from "./faults.ts";
import { executeCancel, executePlace } from "./transaction.ts";

type Waiter = (row: CommandRow | null) => void;

/**
 * One in-process loop. Combined with the PostgreSQL advisory lock, commands
 * are applied to MatchingEngine strictly one at a time.
 */
export class CommandProcessor {
  private stopped = false;
  private running = false;
  private current: Promise<void> | null = null;
  private active: pg.PoolClient | null = null;
  private wake: (() => void) | null = null;
  private readonly waiters = new Map<string, Waiter[]>();
  private config: AppConfig;
  private pool: pg.Pool;
  private books: BookSet;
  private state: HealthState;
  private failClosed: (reason: string) => void;

  constructor(
    config: AppConfig,
    pool: pg.Pool,
    books: BookSet,
    state: HealthState,
    failClosed: (reason: string) => void,
  ) {
    this.config = config;
    this.pool = pool;
    this.books = books;
    this.state = state;
    this.failClosed = failClosed;
  }

  start(): void {
    if (this.running) return;
    this.stopped = false;
    this.running = true;
    this.state.processorActive = true;
    void this.loop();
  }

  kick(): void {
    this.wake?.();
  }

  waitFor(commandId: string, timeoutMs: number): Promise<CommandRow | null> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (row: CommandRow | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const list = this.waiters.get(commandId) ?? [];
        this.waiters.set(
          commandId,
          list.filter((waiter) => waiter !== finish),
        );
        resolve(row);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      const list = this.waiters.get(commandId) ?? [];
      list.push(finish);
      this.waiters.set(commandId, list);
    });
  }

  cancelWait(commandId: string): void {
    this.notify(commandId, null);
  }

  private notify(commandId: string, row: CommandRow | null): void {
    const list = this.waiters.get(commandId) ?? [];
    this.waiters.delete(commandId);
    for (const waiter of list) waiter(row);
  }

  abortWaiters(): void {
    for (const commandId of [...this.waiters.keys()]) this.notify(commandId, null);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.kick();
    await this.abortActive();
    if (this.current) {
      await Promise.race([
        this.current.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, this.config.shutdownDrainMs)),
      ]);
    }
    this.state.processorActive = false;
    this.abortWaiters();
  }

  async abortActive(): Promise<void> {
    const client = this.active;
    if (!client) return;
    await client.query("ROLLBACK").catch(() => undefined);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }

  private async loop(): Promise<void> {
    try {
      while (!this.stopped && this.state.lockHeld && this.state.failure === null) {
        if (testFaults.pauseClaim) {
          await this.sleep(this.config.commandPollIntervalMs);
          continue;
        }
        let command: CommandRow | null = null;
        try {
          command = await claimNext(this.pool, this.config.matcherInstanceId);
        } catch (error) {
          this.failClosed(`CLAIM_FAILED:${safeError(error)}`);
          return;
        }
        if (!command) {
          await this.sleep(this.config.commandPollIntervalMs);
          continue;
        }
        this.current = this.handle(command);
        await this.current.catch(() => undefined);
        this.current = null;
      }
    } finally {
      this.running = false;
      this.state.processorActive = false;
    }
  }

  private async handle(command: CommandRow): Promise<void> {
    const client = await this.pool.connect();
    this.active = client;
    try {
      await client.query("BEGIN");
      if (command.command_type === "PLACE_ORDER") await executePlace(client, this.books, command);
      else if (command.command_type === "CANCEL_ORDER") await executeCancel(client, this.books, command);
      else throw new BusinessRejection("INVALID_PAYLOAD", "Unsupported command.");
      await client.query("COMMIT");
      try {
        this.notify(command.command_id, await getCommand(this.pool, command.command_id));
      } catch (error) {
        log("error", "command readback failed", {
          commandId: command.command_id,
          error: safeError(error),
        });
        this.notify(command.command_id, null);
      }
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof BusinessRejection) {
        try {
          const stored = await markRejected(
            this.pool,
            command.command_id,
            error.code,
            error.message,
          );
          this.notify(command.command_id, stored);
          log("info", "command rejected", { commandId: command.command_id, code: error.code });
        } catch (markError) {
          this.notify(command.command_id, null);
          this.failClosed(`REJECT_MARK_FAILED:${safeError(markError)}`);
        }
        return;
      }
      log("error", "command failed closed", {
        commandId: command.command_id,
        error: safeError(error),
      });
      this.notify(command.command_id, null);
      this.failClosed(`COMMAND_FAILED:${safeError(error)}`);
    } finally {
      if (this.active === client) this.active = null;
      client.release();
    }
  }
}
