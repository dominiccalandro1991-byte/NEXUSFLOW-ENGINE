import path from "node:path";
import { pathToFileURL } from "node:url";
import { log, safeError } from "./log.ts";
import { startService } from "./service.ts";

async function main(): Promise<void> {
  let service: Awaited<ReturnType<typeof startService>>;
  try {
    service = await startService(process.env);
  } catch (error) {
    log("error", "startup rejected", { error: safeError(error) });
    process.exit(1);
  }
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    service.shutdown(signal).then(
      (code) => process.exit(code),
      (error) => {
        log("error", "shutdown failed", { error: safeError(error) });
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entry) {
  void main();
}
