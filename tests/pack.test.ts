import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  pack,
  requireTokens,
  measureHopDepth,
  renderPack,
  type Snapshot,
  type SymbolRec,
  type Edge,
} from "../lib/pack.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadSnapshot(repo: "fastapi" | "httpx"): Snapshot {
  const raw = readFileSync(join(__dirname, "..", "snapshots", `${repo}.json`), "utf8");
  return JSON.parse(raw) as Snapshot;
}

// countTokens on a rendered pack string (BUILD §4 budget invariant). Uses the
// same Gemini countTokens endpoint as the builder.
async function geminiCount(text: string): Promise<number> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:countTokens`,
    { method: "POST", headers: { "Content-Type": "application/json", "X-goog-api-key": key }, body: JSON.stringify({ contents: [{ parts: [{ text }] }] }) },
  );
  if (!res.ok) throw new Error(`countTokens failed: ${res.status}`);
  const data = (await res.json()) as { totalTokens?: number };
  return data.totalTokens ?? 0;
}

function makeSymbol(
  id: string,
  name: string,
  signature: string,
  sig: number,
  full: number,
  docFirstLine = "",
): SymbolRec {
  return {
    id,
    file: id.split("::")[0],
    kind: name[0] === name[0].toUpperCase() ? "class" : "func",
    name,
    qualname: name,
    lineStart: 1,
    lineEnd: 1,
    signature,
    docFirstLine,
    docRest: "",
    body: "",
    tokens: { signature: sig, skeleton: sig + 1, full },
  };
}

function synthSnapshot(): Snapshot {
  // Sized so the budget actually constrains (unlike a 4-symbol / 4000-token
  // fixture where everything fits and admission order is untested). Task
  // "add per-route rate limiting" matches rate/route/limit terms.
  const symbols: SymbolRec[] = [
    makeSymbol("a.py::RateLimiter", "RateLimiter", "class RateLimiter:", 20, 200, "per route"),
    makeSymbol("a.py::rate_limit", "rate_limit", "def rate_limit():", 15, 120, "apply per route"),
    makeSymbol("b.py::Request", "Request", "class Request:", 10, 90),
    makeSymbol("b.py::Response", "Response", "class Response:", 10, 90),
    makeSymbol("c.py::AuthMiddleware", "AuthMiddleware", "class AuthMiddleware:", 30, 150),
    makeSymbol("c.py::auth_middleware", "auth_middleware", "def auth_middleware():", 25, 130),
  ];
  const edges: Edge[] = [
    { from: "a.py::RateLimiter", to: "b.py::Request", kind: "annotation", weight: 1 },
    { from: "a.py::rate_limit", to: "a.py::RateLimiter", kind: "call", weight: 3 },
  ];
  return {
    repo: "synth",
    commit: "x",
    builtAt: "now",
    totalTokens: 0,
    tokensCounted: true,
    symbols,
    edges,
  };
}

test("refusal: pack throws on a snapshot with tokensCounted=false", () => {
  // The committed snapshots are estimate-counted now; build an uncounted one to
  // exercise the §3 guard regardless of committed snapshot state.
  const base = loadSnapshot("fastapi");
  const uncounted: Snapshot = {
    ...base,
    tokensCounted: false,
    symbols: base.symbols.map((s) => ({ ...s, tokens: null })),
  };
  assert.throws(
    () => pack(uncounted, { repo: "fastapi", task: "add per-route rate limiting", budget: 4000 }),
    /tokensCounted=false/,
  );
  assert.throws(() => requireTokens(uncounted), /tokensCounted=false/);
});

test("budget invariant — pack total under budget (count_tokens on rendered pack)", async () => {
  for (const repo of ["fastapi", "httpx"] as const) {
    const s = loadSnapshot(repo);
    for (const budget of [4000, 8000, 16000, 32000]) {
      const r = pack(s, { repo, task: "add per-route rate limiting", budget });
      const packText = renderPack(s, r);
      // Sum of per-symbol tier counts (what the packer optimizes against).
      const summed = r.selected.reduce((a, p) => a + p.tokens, 0);
      // Actual countTokens on the fully rendered pack string (BUILD §4: the real
      // number, not the sum).
      const actual = await geminiCount(packText);
      const drift = actual - summed;
      console.log(
        `${repo} budget=${budget} summed=${summed} actual=${actual} drift=${drift} (${((drift / summed) * 100).toFixed(2)}%)`,
      );
      assert.ok(actual <= budget, `budget ${budget} exceeded: actual ${actual} > ${budget}`);
    }
  }
});

test("pin honoured: a low-score symbol appears at full even when it loses on score", () => {
  const s = synthSnapshot();
  const id = "c.py::AuthMiddleware"; // no task-term match -> BM25 0, would lose
  const r = pack(s, { repo: "synth", task: "add per-route rate limiting", budget: 300, pins: [id] });
  const found = r.selected.find((p) => p.id === id);
  assert.ok(found, "kept symbol must be selected");
  assert.equal(found.tier, "full");
  assert.equal(found.reason, "kept");
});

test("evict honoured: an evicted symbol appears nowhere", () => {
  const s = synthSnapshot();
  const id = "b.py::Request";
  const r = pack(s, { repo: "synth", task: "add per-route rate limiting", budget: 300, evicts: [id] });
  assert.ok(!r.selected.some((p) => p.id === id));
  assert.ok(!r.evicted.some((e) => e.id === id));
});

test("expansion earns its place: a graph neighbor BM25 misses is included", () => {
  const s = synthSnapshot();
  // Natural language: the tokenizer splits snake_case/camelCase, so
  // "rate limiting" matches the seeds `rate_limit`/`RateLimiter` (rate, limit).
  // `Request` matches no task term (BM25 0) but is the annotation neighbor of
  // the `RateLimiter` seed, so graph expansion must admit it with reason graph:.
  const r = pack(s, { repo: "synth", task: "add per-route rate limiting", budget: 300 });
  const req = r.selected.find((p) => p.id === "b.py::Request");
  assert.ok(
    req,
    "FAIL: expansion did not include a graph neighbor BM25 missed — the central claim is dead.",
  );
  assert.match(req!.reason, /^graph:/);
});

test("hop depth measurement on real graphs (records chosen depth)", () => {
  for (const repo of ["fastapi", "httpx"] as const) {
    const s = loadSnapshot(repo);
    const m = measureHopDepth(s, "add per-route rate limiting", [1, 2, 3]);
    const line =
      `${repo}: seeds=${m.seeds.length} recovered(1/2/3)=` +
      `[${m.recovered.get(1)}, ${m.recovered.get(2)}, ${m.recovered.get(3)}] ` +
      `spread(1/2/3)=[${m.spread.get(1)?.toFixed(3)}, ${m.spread.get(2)?.toFixed(3)}, ${m.spread.get(3)?.toFixed(3)}] ` +
      `best=depth ${m.best.depth} recovering ${m.best.recovered}`;
    console.log(line);
    assert.ok(
      m.best.recovered > 0,
      `FAIL: expansion recovered nothing at any depth on ${repo}.`,
    );
  }
});

// BUILD §5: snapshot.files[path] must equal the real vendored source
// byte-for-byte — read_file serves it verbatim, and if it drifts the agent sees
// wrong imports/module-level code. (Reconstruction was tried and rejected: 160%
// size, imports missing.)
test("snapshot.files matches vendored source byte-for-byte", () => {
  const targets: Record<string, string[]> = {
    fastapi: ["fastapi/routing.py", "fastapi/dependencies/utils.py"],
    httpx: ["httpx/_auth.py", "httpx/_models.py"],
  };
  for (const repo of Object.keys(targets)) {
    const snap = loadSnapshot(repo as "fastapi" | "httpx");
    for (const rel of targets[repo]) {
      const real = readFileSync(join(__dirname, "..", "vendor", repo, rel), "utf8");
      assert.ok(snap.files[rel] !== undefined, `snapshot.files missing ${rel}`);
      assert.equal(snap.files[rel], real, `byte mismatch on ${repo}/${rel}`);
    }
  }
});

// Regression: pins used to bypass the budget entirely. Measured at the time:
// budget 4000 with 6 large pins -> 23,563 tokens, reported as compliant. The
// suite was green because the budget test never pinned and the pin test never
// asserted budget — each passed, their combination did not.
test("pins do not break the budget (regression)", () => {
  const s = loadSnapshot("fastapi");
  const big = s.symbols
    .filter((x) => x.tokens && x.tokens.full > 3000)
    .slice(0, 6)
    .map((x) => x.id);
  assert.ok(big.length > 0, "fixture needs some large symbols");
  const r = pack(s, { repo: "fastapi", task: "add per-route rate limiting", budget: 4000, pins: big });
  assert.ok(
    r.totals.total <= r.budget,
    `pinned pack exceeded budget: ${r.totals.total} > ${r.budget}`,
  );
  // At least one pin should have been degraded or evicted rather than silently
  // blowing the budget.
  const degradedOrEvicted =
    r.selected.some((x) => x.reason.startsWith("kept (degraded")) ||
    r.evicted.some((x) => x.reason === "kept, but no budget left");
  assert.ok(degradedOrEvicted, "expected a pin to be degraded or evicted under a tight budget");
});
