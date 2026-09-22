export class TokenBucket {
  private tokens: number;
  private last = Date.now();
  private capacity: number;
  private refillPerSec: number;
  constructor(capacity: number, refillPerSec: number) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.tokens = capacity;
  }

  take(n = 1): boolean {
    const now = Date.now();
    const elapsed = (now - this.last) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    this.last = now;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

export class AccountLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  private capacity: number;
  private refillPerSec: number;
  constructor(capacity = 30, refillPerSec = 10) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
  }

  allow(accountId: string): boolean {
    let b = this.buckets.get(accountId);
    if (!b) {
      b = new TokenBucket(this.capacity, this.refillPerSec);
      this.buckets.set(accountId, b);
    }
    return b.take();
  }
}
