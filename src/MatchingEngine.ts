/**
 * Deterministic single-writer matching engine.
 *
 * Complexity model (P = active price levels, M = consumed resting orders,
 * L = emptied price levels):
 *   best bid/ask lookup ............. O(1)  (cached extrema)
 *   order insertion ................. O(log P)
 *   order cancellation .............. O(log P) worst case
 *                                   (O(1) index lookup + O(1) FIFO unlink;
 *                                    O(log P) only if the price level empties)
 *   matching ........................ O(M + L log P)
 *   amortized work per consumed order O(1) book-node work
 *
 * Not claimed: unconditional O(1) total matching, lock-free shared-memory
 * semantics, or real-world latency bounds from Big-O.
 */
import { NEXUS_LIMITS } from "./limits.ts";
import { AvlPriceTree } from "./price-tree.ts";
import {
  EngineError,
  type BookSnapshot,
  type EngineEvent,
  type EngineOrderStatus,
  type Fill,
  type RestingOrder,
  type Side,
  type SubmitOrderInput,
} from "./types.ts";

class OrderNode {
  prev: OrderNode | null = null;
  next: OrderNode | null = null;
  order: RestingOrder;
  constructor(order: RestingOrder) {
    this.order = order;
  }
}

class PriceLevel {
  head: OrderNode | null = null;
  tail: OrderNode | null = null;
  totalRemaining = 0;
  count = 0;
  priceTicks: number;
  constructor(priceTicks: number) {
    this.priceTicks = priceTicks;
  }

  enqueue(node: OrderNode): void {
    node.prev = this.tail;
    node.next = null;
    if (this.tail) this.tail.next = node;
    else this.head = node;
    this.tail = node;
    this.count += 1;
    this.totalRemaining += node.order.remaining;
  }

  unlink(node: OrderNode): void {
    if (node.prev) node.prev.next = node.next;
    else this.head = node.next;
    if (node.next) node.next.prev = node.prev;
    else this.tail = node.prev;
    node.prev = node.next = null;
    this.count -= 1;
    this.totalRemaining -= node.order.remaining;
  }

  empty(): boolean {
    return this.head === null;
  }
}

export class MatchingEngine {
  private readonly bids = new AvlPriceTree<PriceLevel>();
  private readonly asks = new AvlPriceTree<PriceLevel>();
  private readonly orders = new Map<string, OrderNode>();
  private readonly openByAccount = new Map<string, number>();
  private seq = 0;
  private lastRestoreSeq = 0;
  private writerLocked = false;
  private readonly listeners = new Set<(e: EngineEvent) => void>();

  instrumentId: string;
  constructor(instrumentId: string) {
    this.instrumentId = instrumentId;
  }

  on(fn: (e: EngineEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  sequence(): number {
    return this.seq;
  }

  bestBid(): number | null {
    return this.bids.max()?.key ?? null;
  }

  bestAsk(): number | null {
    return this.asks.min()?.key ?? null;
  }

  openOrderCount(accountId: string): number {
    return this.openByAccount.get(accountId) ?? 0;
  }

  getOrder(id: string): RestingOrder | null {
    return this.orders.get(id)?.order ?? null;
  }

  submit(input: SubmitOrderInput): { order: RestingOrder; fills: Fill[] } {
    return this.mutate(() => this.submitLocked(input));
  }

  cancel(id: string, accountId?: string): RestingOrder | null {
    return this.mutate(() => this.cancelLocked(id, accountId));
  }

  snapshot(depth = 16): BookSnapshot {
    const bids = this.bids.collectDesc(depth).map(({ key, value }) => ({
      priceTicks: key,
      quantity: value.totalRemaining,
      orderCount: value.count,
    }));
    const asks = this.asks.collectAsc(depth).map(({ key, value }) => ({
      priceTicks: key,
      quantity: value.totalRemaining,
      orderCount: value.count,
    }));
    return {
      instrumentId: this.instrumentId,
      seq: this.seq,
      bids,
      asks,
      bestBid: this.bestBid(),
      bestAsk: this.bestAsk(),
    };
  }

  resting(): RestingOrder[] {
    return [...this.orders.values()].map((n) => ({ ...n.order }));
  }

  /**
   * Resting orders in book walk order: bids high-to-low, asks low-to-high,
   * and FIFO (head to tail) inside each price level. Recovery validation uses this.
   * It does not mutate the book and does not match.
   */
  restingInMatchOrder(): RestingOrder[] {
    const out: RestingOrder[] = [];
    const walk = (tree: AvlPriceTree<PriceLevel>, desc: boolean) => {
      const levels = desc ? tree.collectDesc(tree.size) : tree.collectAsc(tree.size);
      for (const level of levels) {
        let node = level.value.head;
        while (node) {
          out.push({ ...node.order });
          node = node.next;
        }
      }
    };
    walk(this.bids, true);
    walk(this.asks, false);
    return out;
  }

  /**
   * Recovery-only insertion. Restores one previously accepted resting order
   * without crossing or emitting trades. Call in strictly increasing `seq` order
   * so price-level FIFO matches the durable sequence.
   */
  restoreResting(snapshot: RestingOrder): void {
    this.mutate(() => this.restoreRestingLocked(snapshot));
  }

  /**
   * Moves the book sequence up to a durable high-water mark. Never matches.
   * Refuses to move backwards.
   */
  restoreSequence(seq: number): void {
    this.mutate(() => {
      if (!Number.isInteger(seq) || seq < 0) {
        throw new EngineError("INVALID_SEQUENCE", "Sequence must be a non-negative integer");
      }
      if (seq < this.seq) {
        throw new EngineError(
          "SEQUENCE_REGRESSION",
          "Refusing to move the book sequence backwards",
          { current: this.seq, requested: seq },
        );
      }
      this.seq = seq;
    });
  }

  private mutate<T>(fn: () => T): T {
    if (this.writerLocked) {
      throw new EngineError(
        "CONCURRENT_MUTATION",
        "Matching state admits a single writer",
      );
    }
    this.writerLocked = true;
    try {
      return fn();
    } finally {
      this.writerLocked = false;
    }
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  private emit(type: EngineEvent["type"], payload: unknown, seq: number): void {
    const e: EngineEvent = { type, seq, ts: Date.now(), payload };
    for (const fn of this.listeners) fn(e);
  }

  private submitLocked(input: SubmitOrderInput): {
    order: RestingOrder;
    fills: Fill[];
  } {
    if (this.orders.has(input.id)) {
      throw new EngineError("DUPLICATE_ORDER", "Order id already exists", {
        orderId: input.id,
      });
    }
    if (input.instrumentId !== this.instrumentId) {
      throw new EngineError("INSTRUMENT_MISMATCH", "Wrong book", {
        instrumentId: input.instrumentId,
      });
    }
    if (
      !Number.isInteger(input.quantity) ||
      input.quantity < NEXUS_LIMITS.MIN_QUANTITY
    ) {
      throw new EngineError("INVALID_QUANTITY", "Quantity must be a positive integer");
    }
    if (input.quantity > NEXUS_LIMITS.MAX_ORDER_SIZE) {
      throw new EngineError("MAX_ORDER_SIZE", "Order exceeds MAX_ORDER_SIZE");
    }
    if (input.type === "limit") {
      if (
        input.priceTicks === null ||
        !Number.isInteger(input.priceTicks) ||
        input.priceTicks < NEXUS_LIMITS.MIN_PRICE_TICKS
      ) {
        throw new EngineError("INVALID_PRICE", "Limit orders require a positive tick price");
      }
    }
    const open = this.openByAccount.get(input.accountId) ?? 0;
    if (open >= NEXUS_LIMITS.MAX_OPEN_ORDERS_PER_ACCOUNT) {
      throw new EngineError(
        "MAX_OPEN_ORDERS",
        "Account exceeded MAX_OPEN_ORDERS_PER_ACCOUNT",
      );
    }
    if (
      this.bids.size + this.asks.size >= NEXUS_LIMITS.MAX_PRICE_LEVELS &&
      input.type === "limit"
    ) {
      const tree = input.side === "buy" ? this.bids : this.asks;
      if (input.priceTicks !== null && tree.get(input.priceTicks) === null) {
        throw new EngineError("MAX_PRICE_LEVELS", "Book rejected new price level");
      }
    }

    const seq = this.nextSeq();
    const taker: RestingOrder = {
      id: input.id,
      accountId: input.accountId,
      instrumentId: input.instrumentId,
      side: input.side,
      type: input.type,
      priceTicks: input.priceTicks ?? 0,
      quantity: input.quantity,
      remaining: input.quantity,
      seq,
      status: "open",
      ts: Date.now(),
    };

    const fills: Fill[] = [];
    while (taker.remaining > 0) {
      const opp = taker.side === "buy" ? this.asks : this.bids;
      const best = taker.side === "buy" ? opp.min() : opp.max();
      if (!best) break;
      const crosses =
        taker.type === "market" ||
        (taker.side === "buy"
          ? taker.priceTicks >= best.key
          : taker.priceTicks <= best.key);
      if (!crosses) break;

      const level = best.value;
      const makerNode = level.head;
      if (!makerNode) {
        opp.remove(best.key);
        continue;
      }
      if (level.count > NEXUS_LIMITS.MAX_QUEUE_DEPTH) {
        throw new EngineError("MAX_QUEUE_DEPTH", "Price level exceeded MAX_QUEUE_DEPTH");
      }

      const maker = makerNode.order;
      const qty = Math.min(taker.remaining, maker.remaining);
      maker.remaining -= qty;
      taker.remaining -= qty;
      level.totalRemaining -= qty;

      const fill: Fill = {
        tradeId: `${this.instrumentId}:${seq}:${fills.length}`,
        instrumentId: this.instrumentId,
        makerOrderId: maker.id,
        takerOrderId: taker.id,
        makerAccountId: maker.accountId,
        takerAccountId: taker.accountId,
        priceTicks: maker.priceTicks,
        quantity: qty,
        seq,
        ts: Date.now(),
      };
      fills.push(fill);
      this.emit("trade", fill, seq);

      if (maker.remaining === 0) {
        maker.status = "filled";
        level.unlink(makerNode);
        this.orders.delete(maker.id);
        this.decOpen(maker.accountId);
        if (level.empty()) opp.remove(best.key);
      } else {
        maker.status = "partially_filled";
      }
    }

    if (taker.remaining === 0) {
      taker.status = "filled";
    } else if (taker.type === "market") {
      taker.status = "cancelled";
    } else {
      const tree = taker.side === "buy" ? this.bids : this.asks;
      let level = tree.get(taker.priceTicks);
      if (!level) {
        level = new PriceLevel(taker.priceTicks);
        tree.insert(taker.priceTicks, level);
      }
      if (level.count >= NEXUS_LIMITS.MAX_QUEUE_DEPTH) {
        throw new EngineError("MAX_QUEUE_DEPTH", "Price level at capacity");
      }
      taker.status = taker.remaining < taker.quantity ? "partially_filled" : "open";
      const node = new OrderNode(taker);
      level.enqueue(node);
      this.orders.set(taker.id, node);
      this.incOpen(taker.accountId);
    }

    this.emit("order_accepted", { order: { ...taker }, fills }, seq);
    this.emit("book", this.snapshot(), seq);
    return { order: { ...taker }, fills };
  }

  private cancelLocked(id: string, accountId?: string): RestingOrder | null {
    const node = this.orders.get(id);
    if (!node) return null;
    if (accountId && node.order.accountId !== accountId) {
      throw new EngineError("NOT_OWNER", "Cannot cancel another account's order");
    }
    const seq = this.nextSeq();
    const tree = node.order.side === "buy" ? this.bids : this.asks;
    const level = tree.get(node.order.priceTicks);
    if (level) {
      level.unlink(node);
      if (level.empty()) tree.remove(node.order.priceTicks);
    }
    node.order.status = "cancelled";
    this.orders.delete(id);
    this.decOpen(node.order.accountId);
    this.emit("order_cancelled", { ...node.order }, seq);
    this.emit("book", this.snapshot(), seq);
    return { ...node.order };
  }

  private restoreRestingLocked(snapshot: RestingOrder): void {
    if (snapshot.instrumentId !== this.instrumentId) {
      throw new EngineError("INSTRUMENT_MISMATCH", "Wrong book", {
        instrumentId: snapshot.instrumentId,
      });
    }
    if (this.orders.has(snapshot.id)) {
      throw new EngineError("DUPLICATE_ORDER", "Order id already exists", {
        orderId: snapshot.id,
      });
    }
    if (snapshot.status !== "open" && snapshot.status !== "partially_filled") {
      throw new EngineError("NOT_RESTING", "Only open or partially filled orders can be restored");
    }
    if (
      !Number.isInteger(snapshot.quantity) ||
      snapshot.quantity < NEXUS_LIMITS.MIN_QUANTITY ||
      !Number.isInteger(snapshot.remaining) ||
      snapshot.remaining <= 0 ||
      snapshot.remaining > snapshot.quantity
    ) {
      throw new EngineError("INVALID_QUANTITY", "Resting remainder is invalid");
    }
    if (
      !Number.isInteger(snapshot.priceTicks) ||
      snapshot.priceTicks < NEXUS_LIMITS.MIN_PRICE_TICKS
    ) {
      throw new EngineError("INVALID_PRICE", "Resting orders require a positive tick price");
    }
    if (!Number.isInteger(snapshot.seq) || snapshot.seq <= 0) {
      throw new EngineError("INVALID_SEQUENCE", "Resting order sequence is invalid");
    }
    if (snapshot.seq <= this.lastRestoreSeq) {
      throw new EngineError(
        "OUT_OF_ORDER_RECOVERY",
        "Recovery must insert resting orders in increasing sequence order",
        { orderId: snapshot.id, seq: snapshot.seq, lastRestoreSeq: this.lastRestoreSeq },
      );
    }
    if (snapshot.side !== "buy" && snapshot.side !== "sell") {
      throw new EngineError("INVALID_SIDE", "Resting side is invalid");
    }
    const order: RestingOrder = {
      id: snapshot.id,
      accountId: snapshot.accountId,
      instrumentId: snapshot.instrumentId,
      side: snapshot.side,
      type: snapshot.type,
      priceTicks: snapshot.priceTicks,
      quantity: snapshot.quantity,
      remaining: snapshot.remaining,
      seq: snapshot.seq,
      status: snapshot.status,
      ts: snapshot.ts,
    };
    const tree = order.side === "buy" ? this.bids : this.asks;
    let level = tree.get(order.priceTicks);
    if (!level) {
      level = new PriceLevel(order.priceTicks);
      tree.insert(order.priceTicks, level);
    }
    const node = new OrderNode(order);
    level.enqueue(node);
    this.orders.set(order.id, node);
    this.incOpen(order.accountId);
    this.lastRestoreSeq = order.seq;
    if (order.seq > this.seq) this.seq = order.seq;
  }

  private incOpen(accountId: string): void {
    this.openByAccount.set(accountId, (this.openByAccount.get(accountId) ?? 0) + 1);
  }

  private decOpen(accountId: string): void {
    const n = (this.openByAccount.get(accountId) ?? 1) - 1;
    if (n <= 0) this.openByAccount.delete(accountId);
    else this.openByAccount.set(accountId, n);
  }
}

export function statusFromEngine(s: EngineOrderStatus): string {
  if (s === "partially_filled") return "PARTIALLY_FILLED";
  if (s === "filled") return "FILLED";
  if (s === "cancelled") return "CANCELLED";
  if (s === "rejected") return "REJECTED";
  return "QUEUED";
}

export function crosses(side: Side, limitTicks: number, bestOpp: number | null): boolean {
  if (bestOpp === null) return false;
  return side === "buy" ? limitTicks >= bestOpp : limitTicks <= bestOpp;
}
