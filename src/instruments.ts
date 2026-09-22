import type { Instrument } from "./types.ts";

/** Token-agnostic instrument registry. A future asset is another row. */
export const INSTRUMENTS: Instrument[] = [
  { id: "BTC-USD", baseAsset: "BTC", quoteAsset: "USD", tickSize: 1, lotSize: 1, minNotional: 1 },
  { id: "ETH-USD", baseAsset: "ETH", quoteAsset: "USD", tickSize: 1, lotSize: 1, minNotional: 1 },
  { id: "SOL-USD", baseAsset: "SOL", quoteAsset: "USD", tickSize: 1, lotSize: 1, minNotional: 1 },
];

export const ASSETS = [
  { id: "USD", name: "US Dollar", decimals: 2, kind: "fiat" },
  { id: "BTC", name: "Bitcoin", decimals: 8, kind: "crypto" },
  { id: "ETH", name: "Ether", decimals: 8, kind: "crypto" },
  { id: "SOL", name: "Solana", decimals: 8, kind: "crypto" },
] as const;

export function getInstrument(id: string): Instrument | undefined {
  return INSTRUMENTS.find((i) => i.id === id);
}

/** Display helpers: engine stores integer ticks / lots. */
export function formatPrice(instrumentId: string, ticks: number): string {
  const inst = getInstrument(instrumentId);
  if (!inst) return String(ticks);
  if (instrumentId.startsWith("BTC")) return ticks.toLocaleString("en-US");
  return ticks.toLocaleString("en-US");
}

export function formatQty(qty: number, decimals = 4): string {
  return (qty / 10 ** 4).toFixed(decimals);
}
