import path from "node:path";
import { fileURLToPath } from "node:url";

export function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function migrationDir(): string {
  return path.join(repoRoot(), "supabase", "migrations");
}
