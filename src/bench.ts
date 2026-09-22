import { MatchingEngine } from "./MatchingEngine.ts";

export function runEngineBench(n = 2000): Record<string, number> {
  const e = new MatchingEngine("BTC-USD");
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    e.submit({
      id: `s${i}`,
      accountId: `mm${i % 20}`,
      instrumentId: "BTC-USD",
      side: "sell",
      type: "limit",
      priceTicks: 10_000 + (i % 50),
      quantity: 1,
    });
  }
  const insertMs = performance.now() - t0;
  const t1 = performance.now();
  for (let i = 0; i < 200; i++) e.bestAsk();
  const bestMs = performance.now() - t1;
  const t2 = performance.now();
  for (let i = 0; i < 200; i++) e.cancel(`s${i}`, `mm${i % 20}`);
  const cancelMs = performance.now() - t2;
  const t3 = performance.now();
  e.submit({
    id: "mkt",
    accountId: "taker",
    instrumentId: "BTC-USD",
    side: "buy",
    type: "market",
    priceTicks: null,
    quantity: 400,
  });
  const matchMs = performance.now() - t3;
  return {
    n,
    insertMs: round(insertMs),
    insertPerSec: round((n / insertMs) * 1000),
    bestLookup200Ms: round(bestMs),
    cancel200Ms: round(cancelMs),
    match400Ms: round(matchMs),
  };
}
function round(n: number): number { return Math.round(n * 100) / 100; }
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(runEngineBench(), null, 2));
}
