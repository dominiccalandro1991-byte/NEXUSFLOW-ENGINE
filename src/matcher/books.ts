import { MatchingEngine } from "../MatchingEngine.ts";
import type { RestingOrder } from "../types.ts";

export class BookSet {
  private readonly engines = new Map<string, MatchingEngine>();

  engine(instrumentId: string): MatchingEngine {
    let engine = this.engines.get(instrumentId);
    if (!engine) {
      engine = new MatchingEngine(instrumentId);
      this.engines.set(instrumentId, engine);
    }
    return engine;
  }

  replace(instrumentId: string, engine: MatchingEngine): void {
    this.engines.set(instrumentId, engine);
  }

  all(): MatchingEngine[] {
    return [...this.engines.values()];
  }
}

export function rebuildEngine(
  instrumentId: string,
  orders: RestingOrder[],
  sequence: number,
): MatchingEngine {
  const engine = new MatchingEngine(instrumentId);
  const sorted = [...orders].sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const order of sorted) engine.restoreResting(order);
  engine.restoreSequence(sequence);
  return engine;
}
