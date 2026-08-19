import { NextResponse } from "next/server";
import { pack, type PackRequest } from "@/lib/pack";
import { loadSnapshot, isValidRepo, validateIds, availableRepos } from "@/lib/snapshot";

// Cap request body size (BUILD §5 trust boundary).
const MAX_BODY = 64 * 1024; // 64 KB

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) {
      return NextResponse.json({ error: `request body too large (>${MAX_BODY} bytes)` }, { status: 413 });
    }
    body = JSON.parse(text);
  } catch (e) {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const req = body as Partial<PackRequest>;
  if (!req || typeof req !== "object") {
    return NextResponse.json({ error: "body must be an object" }, { status: 400 });
  }
  if (!isValidRepo(req.repo)) {
    return NextResponse.json({ error: `repo must be one of: ${availableRepos().join(", ")}` }, { status: 400 });
  }
  if (typeof req.task !== "string" || !req.task.trim()) {
    return NextResponse.json({ error: "task is required" }, { status: 400 });
  }
  const budgets = [4000, 8000, 16000, 32000];
  if (typeof req.budget !== "number" || !budgets.includes(req.budget)) {
    return NextResponse.json({ error: "budget must be one of 4000,8000,16000,32000" }, { status: 400 });
  }

  let snapshot;
  try {
    snapshot = loadSnapshot(req.repo);
  } catch {
    return NextResponse.json({ error: "snapshot not found for repo" }, { status: 500 });
  }

  const pins = req.pins ?? [];
  const evicts = req.evicts ?? [];
  if (!Array.isArray(pins) || !Array.isArray(evicts) || !pins.every((x) => typeof x === "string") || !evicts.every((x) => typeof x === "string")) {
    return NextResponse.json({ error: "pins/evicts must be string arrays" }, { status: 400 });
  }
  const badId = validateIds(snapshot, [...pins, ...evicts]);
  if (badId) {
    return NextResponse.json({ error: badId }, { status: 400 });
  }

  try {
    const result = pack(snapshot, { repo: req.repo, task: req.task, budget: req.budget, pins, evicts });
    return NextResponse.json(result);
  } catch (e) {
    // pack() throws the §3 refusal when tokens are uncounted — surface it clearly.
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 422 });
  }
}
