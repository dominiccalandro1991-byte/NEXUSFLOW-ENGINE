import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MatchingEngine } from "../src/MatchingEngine.ts";
import type { RestingOrder } from "../src/types.ts";

function resting(partial: Partial<RestingOrder> & Pick<RestingOrder, "id" | "seq" | "side">): RestingOrder {
  return {
    accountId: partial.side === "buy" ? "buyer" : "seller",
    instrumentId: "BTC-USD",
    type: "limit",
    priceTicks: 100,
    quantity: 5,
    remaining: 5,
    status: "open",
    ts: 1,
    ...partial,
  };
}

describe("recovery insertion", () => {
  it("restores FIFO without emitting trades", () => {
    const engine = new MatchingEngine("BTC-USD");
    const seen: string[] = [];
    engine.on((event) => seen.push(event.type));
    engine.restoreResting(resting({ id: "s1", seq: 1, side: "sell" }));
    engine.restoreResting(resting({ id: "s2", seq: 4, side: "sell" }));
    engine.restoreSequence(7);
    assert.deepEqual(seen, []);
    assert.equal(engine.sequence(), 7);
    assert.deepEqual(
      engine.restingInMatchOrder().map((order) => order.id),
      ["s1", "s2"],
    );
    const matched = engine.submit({
      id: "b1",
      accountId: "taker",
      instrumentId: "BTC-USD",
      side: "buy",
      type: "limit",
      priceTicks: 100,
      quantity: 5,
    });
    assert.equal(matched.fills.length, 1);
    assert.equal(matched.fills[0]?.makerOrderId, "s1");
    assert.equal(engine.getOrder("s2")?.remaining, 5);
    assert.equal(engine.sequence(), 8);
  });

  it("refuses out-of-order recovery and sequence regression", () => {
    const engine = new MatchingEngine("BTC-USD");
    engine.restoreResting(resting({ id: "s2", seq: 3, side: "sell" }));
    assert.throws(
      () => engine.restoreResting(resting({ id: "s1", seq: 2, side: "sell" })),
      /increasing sequence/,
    );
    engine.restoreSequence(3);
    assert.throws(() => engine.restoreSequence(2), /backwards/);
  });

  it("does not match a restored order against another restored order", () => {
    const engine = new MatchingEngine("BTC-USD");
    engine.restoreResting(resting({ id: "s1", seq: 1, side: "sell", priceTicks: 100 }));
    engine.restoreResting(resting({ id: "b1", seq: 2, side: "buy", priceTicks: 100 }));
    assert.equal(engine.resting().length, 2);
    assert.equal(engine.bestBid(), 100);
    assert.equal(engine.bestAsk(), 100);
  });
});
