import type { HealthState } from "./health.ts";
import { log, safeError } from "./log.ts";

export async function gracefulShutdown(input: {
  signal: string;
  state: HealthState;
  stopProcessor: () => Promise<void>;
  stopPublisher: () => Promise<void>;
  stopIngress: () => Promise<void>;
  releaseLock: () => Promise<void>;
  closePool: () => Promise<void>;
}): Promise<number> {
  input.state.ingressOpen = false;
  log("info", "shutdown begin", { signal: input.signal, instanceId: input.state.instanceId });
  try {
    await input.stopProcessor();
    await input.stopPublisher();
    await input.stopIngress();
    await input.releaseLock();
    input.state.lockHeld = false;
    input.state.processorActive = false;
    await input.closePool();
    log("info", "shutdown complete", { signal: input.signal, instanceId: input.state.instanceId });
    return 0;
  } catch (error) {
    log("error", "shutdown failed", { signal: input.signal, error: safeError(error) });
    return 1;
  }
}
