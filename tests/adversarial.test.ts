import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MatchingEngine } from "../src/MatchingEngine.ts";
import { NEXUS_LIMITS } from "../src/limits.ts";
import { AccountLimiter } from "../src/rate-limit.ts";
import { SingleWriterSequencer } from "../src/sequencer.ts";

describe("adversarial — Node 13-16", () => {
  it("cannot degenerate FIFO with cancel in the middle of a level", () => {
    const e = new MatchingEngine("BTC-USD");
    e.submit({
      id: "a",
      accountId: "mm",
      instrumentId: "BTC-USD",
      side: "sell",
      type: "limit",
      priceTicks: 10,
      quantity: 1,
    });
    e.submit({
      id: "b",
      accountId: "mm",
      instrumentId: "BTC-USD",
      side: "sell",
      type: "limit",
      priceTicks: 10,
      quantity: 1,
    });
    e.submit({
      id: "c",
      accountId: "mm",
      instrumentId: "BTC-USD",
      side: "sell",
      type: "limit",
      priceTicks: 10,
      quantity: 1,
    });
    e.cancel("b", "mm");
    const { fills } = e.submit({
      id: "t",
      accountId: "taker",
      instrumentId: "BTC-USD",
      side: "buy",
      type: "limit",
      priceTicks: 10,
      quantity: 2,
    });
    assert.deepEqual(
      fills.map((f) => f.makerOrderId),
      ["a", "c"],
    );
  });

  it("enforces open-order cap per account", () => {
    const e = new MatchingEngine("BTC-USD");
    const orig = NEXUS_LIMITS.MAX_OPEN_ORDERS_PER_ACCOUNT;
    (NEXUS_LIMITS as { MAX_OPEN_ORDERS_PER_ACCOUNT: number }).MAX_OPEN_ORDERS_PER_ACCOUNT = 3;
    try {
      e.submit({
        id: "1",
        accountId: "x",
        instrumentId: "BTC-USD",
        side: "buy",
        type: "limit",
        priceTicks: 1,
        quantity: 1,
      });
      e.submit({
        id: "2",
        accountId: "x",
        instrumentId: "BTC-USD",
        side: "buy",
        type: "limit",
        priceTicks: 2,
        quantity: 1,
      });
      e.submit({
        id: "3",
        accountId: "x",
        instrumentId: "BTC-USD",
        side: "buy",
        type: "limit",
        priceTicks: 3,
        quantity: 1,
      });
      assert.throws(
        () =>
          e.submit({
            id: "4",
            accountId: "x",
            instrumentId: "BTC-USD",
            side: "buy",
            type: "limit",
            priceTicks: 4,
            quantity: 1,
          }),
        /MAX_OPEN_ORDERS/,
      );
    } finally {
      (NEXUS_LIMITS as { MAX_OPEN_ORDERS_PER_ACCOUNT: number }).MAX_OPEN_ORDERS_PER_ACCOUNT = orig;
    }
  });

  it("rate limiter trips", () => {
    const lim = new AccountLimiter(2, 0);
    assert.equal(lim.allow("a"), true);
    assert.equal(lim.allow("a"), true);
    assert.equal(lim.allow("a"), false);
    assert.equal(lim.allow("b"), true);
  });

  it("sequencer serializes async mutations", async () => {
    const s = new SingleWriterSequencer();
    const order: number[] = [];
    await Promise.all([
      s.run(async (seq) => {
        await new Promise((r) => setTimeout(r, 20));
        order.push(seq);
      }),
      s.run(async (seq) => {
        order.push(seq);
      }),
    ]);
    assert.deepEqual(order, [1, 2]);
  });

  it("cannot cancel another account's order", () => {
    const e = new MatchingEngine("BTC-USD");
    e.submit({
      id: "o",
      accountId: "owner",
      instrumentId: "BTC-USD",
      side: "buy",
      type: "limit",
      priceTicks: 5,
      quantity: 1,
    });
    assert.throws(() => e.cancel("o", "attacker"), /another account/);
  });
});
