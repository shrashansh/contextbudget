import { NextResponse } from "next/server";
import { availableRepos, loadSnapshot } from "@/lib/snapshot";

export const runtime = "nodejs";

// Lets the UI populate its repo picker from whatever snapshots are present, so
// indexing a new project needs no code change.
export async function GET(): Promise<NextResponse> {
  const repos = availableRepos().map((repo) => {
    try {
      const s = loadSnapshot(repo);
      return { repo, symbols: s.symbols.length, totalTokens: s.totalTokens, tokenSource: s.tokenSource };
    } catch {
      return { repo, symbols: 0, totalTokens: 0, tokenSource: null };
    }
  });
  return NextResponse.json({ repos });
}
