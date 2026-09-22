import { MatchingEngine } from "./MatchingEngine.ts";
import { INSTRUMENTS } from "./instruments.ts";
import { SingleWriterSequencer } from "./sequencer.ts";

const engines = new Map<string, MatchingEngine>();
export const matchingSequencer = new SingleWriterSequencer();

export function engineFor(instrumentId: string): MatchingEngine {
  let e = engines.get(instrumentId);
  if (!e) {
    if (!INSTRUMENTS.some((i) => i.id === instrumentId)) {
      throw new Error("UNKNOWN_INSTRUMENT");
    }
    e = new MatchingEngine(instrumentId);
    engines.set(instrumentId, e);
  }
  return e;
}

export function allEngines(): MatchingEngine[] {
  for (const inst of INSTRUMENTS) engineFor(inst.id);
  return [...engines.values()];
}

export function resetEngines(): void {
  engines.clear();
}
