/**
 * Single-writer mutation gate. JavaScript is not a lock-free concurrent
 * data-structure runtime; this serializes matching-state ownership.
 */
export class SingleWriterSequencer {
  private busy = false;
  private seq = 0;
  private queue: Array<() => void> = [];

  get sequence(): number {
    return this.seq;
  }

  runSync<T>(fn: (seq: number) => T): T {
    if (this.busy) {
      throw new Error("CONCURRENT_MUTATION");
    }
    this.busy = true;
    try {
      this.seq += 1;
      if (this.seq <= 0) throw new Error("SEQUENCE_OVERFLOW");
      return fn(this.seq);
    } finally {
      this.busy = false;
    }
  }

  async run<T>(fn: (seq: number) => T | Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      const kick = () => resolve();
      this.queue.push(kick);
      if (this.queue.length === 1) kick();
    });
    try {
      this.seq += 1;
      return await fn(this.seq);
    } finally {
      this.queue.shift();
      this.queue[0]?.();
    }
  }
}
