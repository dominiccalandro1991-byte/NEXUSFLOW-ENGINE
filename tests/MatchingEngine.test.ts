import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MatchingEngine } from "../src/MatchingEngine.ts";
import { NEXUS_LIMITS } from "../src/limits.ts";
import { AvlPriceTree } from "../src/price-tree.ts";
import { assertBalanced, tradePosting } from "../src/settlement.ts";

function buy(id: string, price: number, qty: number, account = "a1") {
  return {
    id,
    accountId: account,
    instrumentId: "BTC-USD",
    side: "buy" as const,
    type: "limit" as const,
    priceTicks: price,
    quantity: qty,
  };
}
function sell(id: string, price: number, qty: number, account = "a2") {
  return {
    id,
    accountId: account,
    instrumentId: "BTC-USD",
    side: "sell" as const,
    type: "limit" as const,
    priceTicks: price,
    quantity: qty,
  };
}

describe("MatchingEngine", () => {
  it("FIFO at the same price", () => {
    const e = new MatchingEngine("BTC-USD");
    e.submit(sell("s1", 100, 5, "m1"));
    e.submit(sell("s2", 100, 5, "m2"));
    const { fills } = e.submit(buy("b1", 100, 5, "t1"));
    assert.equal(fills.length, 1);
    assert.equal(fills[0].makerOrderId, "s1");
    assert.equal(e.getOrder("s1"), null);
    assert.equal(e.getOrder("s2")?.remaining, 5);
  });

  it("partial then complete fill", () => {
    const e = new MatchingEngine("BTC-USD");
    e.submit(sell("s1", 50, 10));
    const r1 = e.submit(buy("b1", 50, 4));
    assert.equal(r1.fills[0].quantity, 4);
    assert.equal(e.getOrder("s1")?.status, "partially_filled");
    const r2 = e.submit(buy("b2", 50, 6));
    assert.equal(r2.fills[0].quantity, 6);
    assert.equal(e.getOrder("s1"), null);
  });

  it("O(1) unlink via index (cancel resting)", () => {
    const e = new MatchingEngine("BTC-USD");
    for (let i = 0; i < 40; i++) e.submit(sell(`s${i}`, 100 + (i % 5), 1, "mm"));
    const before = e.snapshot();
    const cancelled = e.cancel("s7", "mm");
    assert.ok(cancelled);
    assert.equal(cancelled?.status, "cancelled");
    assert.equal(e.getOrder("s7"), null);
    assert.equal(e.snapshot().asks.reduce((a, l) => a + l.orderCount, 0), 39);
    assert.ok(before.bestAsk !== null);
  });

  it("best bid/ask are cached O(1) pointers", () => {
    const e = new MatchingEngine("BTC-USD");
    e.submit(buy("b1", 99, 1));
    e.submit(buy("b2", 100, 1));
    e.submit(sell("s1", 101, 1));
    e.submit(sell("s2", 105, 1));
    assert.equal(e.bestBid(), 100);
    assert.equal(e.bestAsk(), 101);
    e.cancel("b2");
    assert.equal(e.bestBid(), 99);
    e.cancel("s1");
    assert.equal(e.bestAsk(), 105);
  });

  it("market order walks levels then cancels remainder", () => {
    const e = new MatchingEngine("BTC-USD");
    e.submit(sell("s1", 10, 2));
    e.submit(sell("s2", 11, 2));
    const { order, fills } = e.submit({
      id: "m1",
      accountId: "t",
      instrumentId: "BTC-USD",
      side: "buy",
      type: "market",
      priceTicks: null,
      quantity: 10,
    });
    assert.equal(fills.reduce((a, f) => a + f.quantity, 0), 4);
    assert.equal(order.status, "cancelled");
    assert.equal(order.remaining, 6);
  });

  it("rejects duplicate ids, bad qty, oversized orders", () => {
    const e = new MatchingEngine("BTC-USD");
    e.submit(buy("x", 1, 1));
    assert.throws(() => e.submit(buy("x", 1, 1)), /already exists/);
    assert.throws(() => e.submit(buy("y", 1, 0)), /INVALID_QUANTITY|positive integer/i);
    assert.throws(
      () => e.submit(buy("z", 1, NEXUS_LIMITS.MAX_ORDER_SIZE + 1)),
      /MAX_ORDER_SIZE/,
    );
  });

  it("rejects concurrent mutation", () => {
    const e = new MatchingEngine("BTC-USD");
    let nested = false;
    e.on(() => {
      if (nested) return;
      nested = true;
      assert.throws(() => e.submit(buy("n", 1, 1)), /single writer/);
    });
    e.submit(buy("b", 1, 1));
  });

  it("monotonic sequence", () => {
    const e = new MatchingEngine("BTC-USD");
    const s0 = e.sequence();
    e.submit(buy("b1", 1, 1));
    e.submit(sell("s1", 2, 1));
    e.cancel("b1");
    assert.ok(e.sequence() > s0);
    assert.equal(e.sequence(), 3);
  });

  it("self-trade still produces a fill (no hidden suppression)", () => {
    const e = new MatchingEngine("BTC-USD");
    e.submit(sell("s1", 10, 1, "same"));
    const { fills } = e.submit(buy("b1", 10, 1, "same"));
    assert.equal(fills.length, 1);
  });
});

describe("AvlPriceTree", () => {
  it("keeps min/max after interleaved insert/delete", () => {
    const t = new AvlPriceTree<string>();
    for (const k of [5, 3, 7, 1, 9, 4, 6]) t.insert(k, String(k));
    assert.equal(t.min()?.key, 1);
    assert.equal(t.max()?.key, 9);
    t.remove(1);
    t.remove(9);
    t.remove(5);
    assert.equal(t.min()?.key, 3);
    assert.equal(t.max()?.key, 7);
    assert.equal(t.size, 4);
  });
});

describe("ledger", () => {
  it("trade posting balances", () => {
    const p = tradePosting({
      transactionId: "tx1",
      buyerId: "b",
      sellerId: "s",
      baseAsset: "BTC",
      quoteAsset: "USD",
      quantity: 3,
      quoteAmount: 300,
    });
    assertBalanced(p.lines);
    const net = p.lines.reduce((a, l) => a + l.debit - l.credit, 0);
    assert.equal(net, 0);
  });
});
