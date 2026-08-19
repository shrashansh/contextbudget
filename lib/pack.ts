// ContextBudget packer (Milestone 2). Consumes the frozen snapshot shape in
// BUILD.md §2 and produces a budget-constrained selection. Pure — no network,
// no token-counting calls. Counts come precomputed in the snapshot (BUILD §3).

export type Tier = "signature" | "skeleton" | "full";

export interface SymbolRec {
  id: string;
  file: string;
  kind: "module" | "class" | "func" | "method";
  name: string;
  qualname: string;
  lineStart: number;
  lineEnd: number;
  signature: string;
  docFirstLine: string;
  docRest: string;
  body: string;
  tokens: { signature: number; skeleton: number; full: number } | null;
}

export interface Edge {
  from: string;
  to: string;
  kind: "import" | "annotation" | "inheritance" | "call" | "decorator";
  weight: number;
}

export interface Snapshot {
  repo: string;
  commit: string;
  builtAt: string;
  totalTokens: number;
  tokensCounted: boolean;
  tokenSource?: "estimate" | "count_tokens"; // absent when tokensCounted=false
  files: Record<string, string>; // path -> exact file source (BUILD §2/§5)
  symbols: SymbolRec[];
  edges: Edge[];
}

export interface PackRequest {
  repo: string;
  task: string;
  budget: number;
  pins?: string[];
  evicts?: string[];
}

export interface PackedSymbol {
  id: string;
  tier: Tier;
  tokens: number; // cost at the admitted tier
  reason: string; // "bm25" | "graph:<hops> from <id>" | "kept" | "kept (degraded ...)"
}

export interface PackResponse {
  selected: PackedSymbol[];
  evicted: { id: string; tokens: number; reason: string }[];
  totals: { signature: number; doc: number; body: number; total: number };
  budget: number;
  tokenSource: "estimate" | "count_tokens";
}

// BUILD.md §4 packing reserve. Measured 2026-08-18 (budget-invariant test):
// summed per-symbol tier counts == countTokens on the full rendered pack,
// drift = 0.00% at every budget on both repos. The guessed 2% was overkill; a
// small 0.5% safety margin covers any token merge at joins.
const PACK_RESERVE = 0.995;
const TIERS: Tier[] = ["full", "skeleton", "signature"];

// ---------------------------------------------------------------- refusal (§3)

export function requireTokens(snapshot: Snapshot): void {
  if (!snapshot.tokensCounted) {
    throw new Error(
      `cannot pack ${snapshot.repo}: snapshot has tokensCounted=false ` +
        "(BUILD.md §3 refusal; run scripts/build_snapshot.py --tokens with an API key)",
    );
  }
  if (snapshot.symbols.some((s) => s.tokens === null)) {
    throw new Error(
      `cannot pack ${snapshot.repo}: at least one symbol has tokens=null ` +
        "(BUILD.md §3 refusal)",
    );
  }
}

// ---------------------------------------------------------------- BM25

// Index the whole identifier AND its parts (BUILD.md §4). Python is snake_case,
// users type English, so "solve_dependencies" must match "solve dependencies".
// Keeping the whole token preserves exact-query ranking.
function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.match(/[A-Za-z0-9_]+/g) ?? []) {
    const whole = m.toLowerCase();
    out.push(whole);
    // snake_case + camelCase + digit boundaries, split case-preserving so the
    // camelCase boundary survives lowercasing. APIRouter -> api, router.
    const boundary = /(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[a-z])(?=[0-9])|(?<=[0-9])(?=[a-z])/;
    for (const chunk of m.split("_")) {
      if (!chunk) continue;
      for (const p of chunk.split(boundary)) {
        const lc = p.toLowerCase();
        if (lc && lc !== whole) out.push(lc);
      }
    }
  }
  return out;
}

// BM25 over one field's docs, each doc its own length-normalised unit.
function bm25Field(docs: string[][], query: string[]): number[] {
  const n = docs.length;
  const avgdl = n ? docs.reduce((a, d) => a + d.length, 0) / n : 0;
  const df = new Map<string, number>();
  for (const d of docs) {
    for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const k1 = 1.5;
  const b = 0.75;
  return docs.map((d) => {
    const dl = d.length;
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const q of query) {
      const nq = df.get(q) ?? 0;
      const idf = Math.log((n - nq + 0.5) / (nq + 0.5) + 1);
      const f = tf.get(q) ?? 0;
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (dl / Math.max(avgdl, 1)))));
    }
    return score;
  });
}

export interface Bm25Opts {
  // fieldWeighted=true: score name and signature+docFirstLine as separate
  // fields, 3*bm25(name)+1*bm25(sig). fieldWeighted=false: single concatenated
  // document (the pre-§4 behavior). Defaults to true.
  fieldWeighted?: boolean;
}

// Field-weighted BM25 (BUILD.md §4): `name` and `signature + docFirstLine` are
// scored as SEPARATE fields, each with its own length normalisation, then
// combined 3*bm25(name) + 1*bm25(signature+doc). A long FastAPI signature must
// not bury the short name via a shared avgdl. name is the dominant signal.
export function bm25Scores(
  snapshot: Snapshot,
  task: string,
  opts: Bm25Opts = {},
): Map<string, number> {
  const syms = snapshot.symbols;
  const query = tokenize(task);
  const fieldWeighted = opts.fieldWeighted ?? true;
  const scores = new Map<string, number>();
  if (fieldWeighted) {
    const nameField = syms.map((s) => tokenize(s.name));
    const sigField = syms.map((s) => tokenize(`${s.signature} ${s.docFirstLine}`));
    const nameScore = bm25Field(nameField, query);
    const sigScore = bm25Field(sigField, query);
    for (let i = 0; i < syms.length; i++) {
      scores.set(syms[i].id, 3 * nameScore[i] + 1 * sigScore[i]);
    }
  } else {
    const docs = syms.map((s) => tokenize(`${s.name} ${s.signature} ${s.docFirstLine}`));
    const single = bm25Field(docs, query);
    for (let i = 0; i < syms.length; i++) {
      scores.set(syms[i].id, single[i]);
    }
  }
  return scores;
}

// ---------------------------------------------------------------- graph expansion

export interface GraphContribution {
  score: number;
  hops: number;
  from: string;
}

// Undirected adjacency over edges, weighted by edge.weight.
function adjacency(snapshot: Snapshot): Map<string, Array<[string, number]>> {
  const adj = new Map<string, Array<[string, number]>>();
  const add = (a: string, bv: string, w: number) => {
    const list = adj.get(a);
    if (list) list.push([bv, w]);
    else adj.set(a, [[bv, w]]);
  };
  for (const e of snapshot.edges) {
    add(e.from, e.to, e.weight);
    add(e.to, e.from, e.weight);
  }
  return adj;
}

// BFS from the seeds up to maxHops. Contribution = seed_score * decay^hops *
// log(1 + weight) (BUILD.md §4), taken as the max over all seed paths that reach
// the symbol. Seeds are [id, score][] so a strong seed dominates a weak one
// instead of all neighbors landing in a tied band.
export function graphContributions(
  snapshot: Snapshot,
  seeds: Array<[string, number]>,
  maxHops: number,
  decay = 0.5,
): Map<string, GraphContribution> {
  const adj = adjacency(snapshot);
  const contrib = new Map<string, GraphContribution>();
  for (const [seed, seedScore] of seeds) {
    const visited = new Set<string>([seed]);
    let frontier: string[] = [seed];
    for (let hops = 1; hops <= maxHops; hops++) {
      const next: string[] = [];
      for (const cur of frontier) {
        for (const [nb, w] of adj.get(cur) ?? []) {
          if (visited.has(nb)) continue;
          visited.add(nb);
          const sc = seedScore * decay ** hops * Math.log(1 + w);
          const prev = contrib.get(nb);
          if (!prev || sc > prev.score) {
            contrib.set(nb, { score: sc, hops, from: seed });
          }
          next.push(nb);
        }
      }
      frontier = next;
    }
  }
  return contrib;
}

export interface HopMeasurement {
  seeds: string[];
  seedSet: Set<string>;
  recovered: Map<number, number>;
  spread: Map<number, number>;
  best: { depth: number; recovered: number };
}

// Measure how many non-seed symbols expansion reaches at each hop depth. This is
// pure-graph — works on uncounted snapshots, so hop depth can be chosen by
// measurement (BUILD.md §4) before any API key exists.
export function measureHopDepth(
  snapshot: Snapshot,
  task: string,
  depths: number[] = [1, 2, 3],
  decay = 0.5,
): HopMeasurement {
  const scores = bm25Scores(snapshot, task);
  const seeds = [...scores.entries()].filter(([, v]) => v > 0);
  const seedSet = new Set(seeds.map(([id]) => id));
  const recovered = new Map<number, number>();
  const spread = new Map<number, number>();
  let best = { depth: depths[0] ?? 2, recovered: 0 };
  for (const d of depths) {
    const contrib = graphContributions(snapshot, seeds, d, decay);
    const vals = [...contrib.values()].map((c) => c.score).sort((a, b) => a - b);
    const n = [...contrib.keys()].filter((id) => !seedSet.has(id)).length;
    recovered.set(d, n);
    // Score spread: ratio of distinct contribution values — a tie-band means
    // the budget cut is arbitrary. Spread > ~0 means distinguishable ranks.
    spread.set(d, vals.length ? new Set(vals.map((v) => v.toFixed(4))).size / vals.length : 0);
    if (n > best.recovered) best = { depth: d, recovered: n };
  }
  return { seeds: seeds.map(([id]) => id), seedSet, recovered, best, spread };
}

// ---------------------------------------------------------------- packing

export interface PackOptions {
  maxHops?: number;
  decay?: number;
  seedLimit?: number;
}

export function pack(
  snapshot: Snapshot,
  request: PackRequest,
  opts: PackOptions = {},
): PackResponse {
  requireTokens(snapshot);
  const maxHops = opts.maxHops ?? 1; // eval: depths 1,2,3 tied; 1 is cheapest (DECISIONS)
  const decay = opts.decay ?? 0.5;
  const seedLimit = opts.seedLimit ?? 15;

  const byId = new Map(snapshot.symbols.map((s) => [s.id, s]));
  const tokens = snapshot.symbols[0]?.tokens;
  void tokens;

  const evictSet = new Set(request.evicts ?? []);
  const pinSet = new Set(request.pins ?? []);

  // Refuse unknown pin/evict ids (BUILD §5 trust boundary: validate against snapshot).
  for (const id of [...pinSet, ...evictSet]) {
    if (!byId.has(id)) throw new Error(`unknown symbol id in pins/evicts: ${id}`);
  }

  // Scores: BM25 seeds, then graph expansion.
  const scores = bm25Scores(snapshot, request.task);
  const seeds = [...scores.entries()]
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, seedLimit);
  const contrib = graphContributions(snapshot, seeds, maxHops, decay);

  const finalScore = (id: string): number =>
    Math.max(scores.get(id) ?? 0, contrib.get(id)?.score ?? 0);
  const reasonOf = (id: string): string => {
    const c = contrib.get(id);
    const bm = scores.get(id) ?? 0;
    if (c && c.score > bm) return `graph:${c.hops} from ${c.from}`;
    return "bm25";
  };

  const budget = Math.floor(request.budget * PACK_RESERVE);
  const selected: PackedSymbol[] = [];
  const evicted: { id: string; tokens: number; reason: string }[] = [];
  let remaining = budget;

  // Pins: admitted first and preferred at `full`, but they DO NOT get to break
  // the budget. Measured before this guard: budget 4000 with 6 large pins produced
  // a 23,563-token pack reported as compliant — a 5.9x overrun of the one invariant
  // this product claims to hold.
  //
  // A pin means "I want this", so degrade the tier rather than drop it: full ->
  // skeleton -> signature, taking whichever fits. Only if even the signature does
  // not fit is the pin evicted, with a reason saying so. The degradation is
  // reported so the UI can show it — a pin that could not be honoured at full IS
  // the tradeoff this product exists to surface.
  for (const id of pinSet) {
    const s = byId.get(id)!;
    const tk = s.tokens!;
    const ladder: { tier: Tier; cost: number }[] = [
      { tier: "full", cost: tk.full },
      { tier: "skeleton", cost: tk.skeleton },
      { tier: "signature", cost: tk.signature },
    ];
    const fit = ladder.find((step) => step.cost <= remaining);
    if (!fit) {
      evicted.push({ id, tokens: tk.signature, reason: "kept, but no budget left" });
      continue;
    }
    selected.push({
      id,
      tier: fit.tier,
      tokens: fit.cost,
      reason: fit.tier === "full" ? "kept" : `kept (degraded to ${fit.tier}: full did not fit)`,
    });
    remaining -= fit.cost;
  }

  // Evicts: never admitted, never appear.
  const candidates = snapshot.symbols
    .filter((s) => !pinSet.has(s.id) && !evictSet.has(s.id))
    .map((s) => ({ s, score: finalScore(s.id) }))
    .sort((a, b) => b.score - a.score);

  for (const { s, score } of candidates) {
    if (score <= 0) {
      evicted.push({ id: s.id, tokens: 0, reason: "no match for this task" });
      continue;
    }
    const t = s.tokens!;
    let placed: Tier | null = null;
    for (const tier of TIERS) {
      const cost = t[tier];
      if (cost > 0 && cost <= remaining) {
        placed = tier;
        break;
      }
    }
    if (placed) {
      selected.push({ id: s.id, tier: placed, tokens: t[placed], reason: reasonOf(s.id) });
      remaining -= t[placed];
    } else {
      evicted.push({
        id: s.id,
        tokens: t.signature,
        reason: "ran out of budget",
      });
    }
  }

  // Totals (BUILD §2): per-component derived by subtraction from tier counts,
  // labeled approximate.
  let sig = 0;
  let doc = 0;
  let body = 0;
  for (const p of selected) {
    const t = byId.get(p.id)!.tokens!;
    sig += t.signature;
    if (p.tier === "skeleton" || p.tier === "full") doc += Math.max(0, t.skeleton - t.signature);
    if (p.tier === "full") body += Math.max(0, t.full - t.skeleton);
  }
  const total = selected.reduce((a, p) => a + p.tokens, 0);

  return {
    selected,
    evicted,
    totals: { signature: sig, doc, body, total },
    budget,
    tokenSource: snapshot.tokenSource ?? "count_tokens",
  };
}

// Render the admitted pack text (BUILD §2: server renders from the snapshot).
export function render(sym: SymbolRec, tier: Tier): string {
  const parts = [sym.signature];
  if ((tier === "skeleton" || tier === "full") && sym.docFirstLine) parts.push(sym.docFirstLine);
  if (tier === "full") {
    if (sym.docRest) parts.push(sym.docRest);
    if (sym.body) parts.push(sym.body);
  }
  return parts.join("\n") + "\n\n";
}

export function renderPack(snapshot: Snapshot, response: PackResponse): string {
  const byId = new Map(snapshot.symbols.map((s) => [s.id, s]));
  return response.selected.map((p) => render(byId.get(p.id)!, p.tier)).join("");
}
