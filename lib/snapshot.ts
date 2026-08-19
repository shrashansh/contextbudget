// Shared server-side snapshot loading and validation (BUILD.md §5 trust boundary).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Snapshot } from "./pack";

// Repos are DISCOVERED from snapshots/, not hardcoded: a reviewer can index their
// own Python project with `build_snapshot.py --path ... --name ...` and it appears
// with no code change. Indexing cannot happen in a request (cloning FastAPI is
// 57 MB and counting tokens takes ~1min), so it stays an offline step.
const NAME_RE = /^[A-Za-z0-9_-]+$/;

export function availableRepos(): string[] {
  try {
    return readdirSync(join(process.cwd(), "snapshots"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .filter((n) => NAME_RE.test(n))
      .sort();
  } catch {
    return [];
  }
}

// Snapshots live at snapshots/<repo>.json, committed to the repo (§6).
export function snapshotPath(repo: string): string {
  return join(process.cwd(), "snapshots", `${repo}.json`);
}

export function loadSnapshot(repo: string): Snapshot {
  const p = snapshotPath(repo);
  return JSON.parse(readFileSync(p, "utf8")) as Snapshot;
}

// Every id in a request must exist in the snapshot. Reject unknown ids rather
// than skipping them (BUILD §5) - an unknown id is a hostile or corrupt input.
export function validateIds(snapshot: Snapshot, ids: string[]): string | null {
  const known = new Set(snapshot.symbols.map((s) => s.id));
  for (const id of ids) {
    if (!known.has(id)) return `unknown symbol id: ${id}`;
  }
  return null;
}

// Distinct file paths present in the snapshot - used to key read_file lookups.
export function snapshotFiles(snapshot: Snapshot): string[] {
  const files = new Set(snapshot.symbols.map((s) => s.file));
  return [...files].sort();
}

// Two gates, both required. The name pattern stops traversal via the repo name
// (it is interpolated into a file path); the directory listing is the whitelist of
// what actually exists.
export function isValidRepo(v: unknown): v is string {
  return typeof v === "string" && NAME_RE.test(v) && availableRepos().includes(v);
}
