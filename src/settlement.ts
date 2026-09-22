export interface LedgerLine {
  accountId: string;
  assetId: string;
  debit: number;
  credit: number;
}

export interface LedgerPosting {
  transactionId: string;
  lines: LedgerLine[];
  eventHash: string;
}

export function hashEvent(parts: Array<string | number>): string {
  let h = 2166136261;
  const s = parts.join("|");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Double-entry invariant: Σ debit = Σ credit for every posting. */
export function assertBalanced(lines: LedgerLine[]): void {
  const debit = lines.reduce((a, l) => a + l.debit, 0);
  const credit = lines.reduce((a, l) => a + l.credit, 0);
  if (debit !== credit) {
    throw new Error(`UNBALANCED_LEDGER debit=${debit} credit=${credit}`);
  }
  if (lines.some((l) => l.debit < 0 || l.credit < 0)) {
    throw new Error("NEGATIVE_LEDGER_AMOUNT");
  }
  if (lines.some((l) => l.debit > 0 && l.credit > 0)) {
    throw new Error("MIXED_LINE");
  }
}

/**
 * Settlement of a trade at maker price:
 *   buyer pays quote, receives base
 *   seller pays base, receives quote
 */
export function tradePosting(input: {
  transactionId: string;
  buyerId: string;
  sellerId: string;
  baseAsset: string;
  quoteAsset: string;
  quantity: number;
  quoteAmount: number;
}): LedgerPosting {
  const lines: LedgerLine[] = [
    { accountId: input.buyerId, assetId: input.quoteAsset, debit: 0, credit: input.quoteAmount },
    { accountId: input.sellerId, assetId: input.quoteAsset, debit: input.quoteAmount, credit: 0 },
    { accountId: input.buyerId, assetId: input.baseAsset, debit: input.quantity, credit: 0 },
    { accountId: input.sellerId, assetId: input.baseAsset, debit: 0, credit: input.quantity },
  ];
  assertBalanced(lines);
  return {
    transactionId: input.transactionId,
    lines,
    eventHash: hashEvent([
      input.transactionId,
      input.buyerId,
      input.sellerId,
      input.quantity,
      input.quoteAmount,
    ]),
  };
}

export class InMemoryBalances {
  private available = new Map<string, number>();
  private locked = new Map<string, number>();

  private k(accountId: string, assetId: string): string {
    return `${accountId}:${assetId}`;
  }

  get(accountId: string, assetId: string): { available: number; locked: number } {
    const k = this.k(accountId, assetId);
    return {
      available: this.available.get(k) ?? 0,
      locked: this.locked.get(k) ?? 0,
    };
  }

  creditAvailable(accountId: string, assetId: string, qty: number): void {
    const k = this.k(accountId, assetId);
    this.available.set(k, (this.available.get(k) ?? 0) + qty);
  }

  lock(accountId: string, assetId: string, qty: number): void {
    const k = this.k(accountId, assetId);
    const av = this.available.get(k) ?? 0;
    if (av < qty) throw new Error("INSUFFICIENT_AVAILABLE");
    this.available.set(k, av - qty);
    this.locked.set(k, (this.locked.get(k) ?? 0) + qty);
  }

  unlock(accountId: string, assetId: string, qty: number): void {
    const k = this.k(accountId, assetId);
    const lk = this.locked.get(k) ?? 0;
    if (lk < qty) throw new Error("INSUFFICIENT_LOCKED");
    this.locked.set(k, lk - qty);
    this.available.set(k, (this.available.get(k) ?? 0) + qty);
  }

  consumeLocked(accountId: string, assetId: string, qty: number): void {
    const k = this.k(accountId, assetId);
    const lk = this.locked.get(k) ?? 0;
    if (lk < qty) throw new Error("INSUFFICIENT_LOCKED");
    this.locked.set(k, lk - qty);
  }

  apply(posting: LedgerPosting, lockBase: boolean, lockQuote: boolean): void {
    for (const line of posting.lines) {
      if (line.debit > 0) this.creditAvailable(line.accountId, line.assetId, line.debit);
      if (line.credit > 0) {
        const isBaseLock =
          lockBase && line.assetId !== posting.lines.find((l) => l.credit > 0 && l !== line)?.assetId;
        void isBaseLock;
        this.consumeLocked(line.accountId, line.assetId, line.credit);
      }
    }
  }
}
