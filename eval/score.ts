// ContextBudget eval scorer (BUILD.md §4.5). Ground-truth labels in tasks.json
// were derived by reading the code, never from the retriever. Reports recall@k
// on RANKED order (k=20,50) per task and averaged, split class vs func/method,
// for BM25-only and BM25+graph at depths 1,2,3 - for BOTH the pre-§4 single-field
// BM25 and the post-§4 field-weighted BM25 so the change can be judged.
//
// Scoring is on ranking, not budget: recall@budget needs token counts and every
// snapshot is tokensCounted:false (BUILD §3). A marked recall@budget path below
// activates once a key exists.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bm25Scores, graphContributions, type Snapshot } from "../lib/pack.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TASKS = JSON.parse(readFileSync(join(__dirname, "tasks.json"), "utf8"));
const SEED_LIMIT = 15;
const DECAY = 0.5;
const KS = [20, 50];
const KINDS = ["class", "func", "method", "module"];

function loadSnapshot(repo: string): Snapshot {
  return JSON.parse(readFileSync(join(__dirname, "..", "snapshots", `${repo}.json`), "utf8"));
}

interface RankConfig {
  label: string; // e.g. "fieldWeighted+graph-d2"
  fieldWeighted: boolean;
  maxHops: number; // 0 = BM25 only
  fusion: "max" | "rrf"; // how to combine BM25 + graph scores
}

// Reciprocal Rank Fusion (BUILD §4): rank separately by BM25 and by graph
// contribution, then score each symbol as sum of 1/(60 + rank) across the two
// lists. Scale-free - a weak lexical match no longer outranks every
// graph-discovered symbol the way max() does on incommensurable scales.
function rrfScore(bmRanks: Map<string, number>, graphRanks: Map<string, number>): Map<string, number> {
  const K = 60;
  const score = new Map<string, number>();
  for (const [id, r] of bmRanks) score.set(id, (score.get(id) ?? 0) + 1 / (K + r));
  for (const [id, r] of graphRanks) score.set(id, (score.get(id) ?? 0) + 1 / (K + r));
  return score;
}

// Return ranked symbol ids under a config. fieldWeighted=false is the pre-§4
// single-document BM25 baseline.
function rank(snapshot: Snapshot, task: string, cfg: RankConfig): string[] {
  const bm = bm25Scores(snapshot, task, { fieldWeighted: cfg.fieldWeighted });
  if (cfg.maxHops === 0) {
    return [...bm.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }
  const seeds = [...bm.entries()]
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, SEED_LIMIT);
  const contrib = graphContributions(snapshot, seeds, cfg.maxHops, DECAY);
  if (cfg.fusion === "rrf") {
    const bmRanks = new Map([...bm.entries()].sort((a, b) => b[1] - a[1]).map(([id], i) => [id, i]));
    const graphRanks = new Map(
      [...contrib.entries()].sort((a, b) => b[1].score - a[1].score).map(([id], i) => [id, i]),
    );
    return [...rrfScore(bmRanks, graphRanks).entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }
  const final = new Map<string, number>();
  for (const [id] of bm) {
    final.set(id, Math.max(bm.get(id) ?? 0, contrib.get(id)?.score ?? 0));
  }
  return [...final.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

// recall@k for one task: fraction of expected labels in top-k of the ranked list.
function recallAtK(ranked: string[], expect: string[], k: number): number {
  const top = new Set(ranked.slice(0, k));
  return expect.filter((id) => top.has(id)).length / expect.length;
}

function kindOf(snapshot: Snapshot, id: string): string {
  const s = snapshot.symbols.find((x) => x.id === id);
  return s ? s.kind : "module";
}

interface Report {
  configs: RankConfig[];
  snapshots: Map<string, Snapshot>;
  results: Map<string, Map<string, { task: string; k20: number; k50: number }>>;
}

function run(repo: string, cfg: RankConfig, report: Report): void {
  const snap = report.snapshots.get(repo)!;
  const cfgKey = cfg.label;
  const taskResults = report.results.get(cfgKey)!;
  for (const t of TASKS) {
    if (t.repo !== repo) continue;
    const ranked = rank(snap, t.task, cfg);
    taskResults.set(t.task, {
      task: t.task,
      k20: recallAtK(ranked, t.expect, 20),
      k50: recallAtK(ranked, t.expect, 50),
    });
  }
}

function avg(nums: number[]): number {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

// --- recall@budget, measured AT FULL TIER (BUILD §4.5) ---
// The scarce resource is promotion to `full` (a body costs hundreds of tokens,
// more than a hundred skeletons), so the metric that matters is: at budget B,
// are the expected symbols present AT FULL tier? Greedily fill by rank/score,
// promoting toward full, and count which expected labels reach full.
// Needs per-symbol token counts - activates once snapshots are tokensCounted:true.
function recallAtBudgetFull(repo: string, budget: number, cfg: RankConfig): number {
  const snap = loadSnapshot(repo);
  if (!snap.tokensCounted) {
    throw new Error("recall@budget needs tokensCounted:true (BUILD §3); run --tokens with a key");
  }
  const tiers: Array<"signature" | "skeleton" | "full"> = ["full", "skeleton", "signature"];
  let covered = 0;
  let total = 0;
  for (const t of TASKS) {
    if (t.repo !== repo) continue;
    total += t.expect.length;
    const ranked = rank(snap, t.task, cfg);
    const byId = new Map(snap.symbols.map((s) => [s.id, s]));
    let remaining = budget;
    let fullPresent = new Set<string>();
    for (const id of ranked) {
      const s = byId.get(id)!;
      if (!s.tokens) continue;
      for (const tier of tiers) {
        const cost = s.tokens[tier];
        if (cost > 0 && cost <= remaining) {
          remaining -= cost;
          if (tier === "full") fullPresent.add(id);
          break;
        }
      }
    }
    covered += t.expect.filter((id: string) => fullPresent.has(id)).length;
  }
  return total ? covered / total : 0;
}

function printTables(report: Report, fieldWeightedLabel: "single-field" | "field-weighted"): void {
  const repos = ["fastapi", "httpx"];
  console.log(`\n======== recall (${fieldWeightedLabel} BM25) ========`);
  for (const cfg of report.configs) {
    const rows: string[] = [];
    const k20: number[] = [];
    const k50: number[] = [];
    for (const repo of repos) {
      const taskResults = report.results.get(cfg.label)!;
      // Aggregate only the tasks for this repo - taskResults holds both repos.
      const repoTasks = TASKS.filter((t: { repo: string }) => t.repo === repo)
        .map((t: { task: string }) => taskResults.get(t.task))
        .filter(Boolean);
      const r20 = avg(repoTasks.map((r) => (r as { k20: number }).k20));
      const r50 = avg(repoTasks.map((r) => (r as { k50: number }).k50));
      k20.push(r20);
      k50.push(r50);
      rows.push(`${repo}: r@20=${r20.toFixed(2)} r@50=${r50.toFixed(2)}`);
    }
    console.log(`\n[${cfg.label}]  ${rows.join("  |  ")}  avg r@20=${avg(k20).toFixed(2)} avg r@50=${avg(k50).toFixed(2)}`);
    // per-kind breakdown
    for (const kind of KINDS) {
      const ck20: number[] = [];
      const ck50: number[] = [];
      for (const repo of repos) {
        const snap = report.snapshots.get(repo)!;
        for (const t of TASKS) {
          if (t.repo !== repo) continue;
          const expect = t.expect.filter((id: string) => kindOf(snap, id) === kind);
          if (!expect.length) continue;
          const ranked = rank(snap, t.task, cfg);
          ck20.push(recallAtK(ranked, expect, 20));
          ck50.push(recallAtK(ranked, expect, 50));
        }
      }
      if (ck20.length) {
        console.log(`    kind=${kind}: avg r@20=${avg(ck20).toFixed(2)} avg r@50=${avg(ck50).toFixed(2)} (${ck20.length} tasks)`);
      }
    }
    // per-task lines
    for (const repo of repos) {
      const taskResults = report.results.get(cfg.label)!;
      for (const t of TASKS) {
        if (t.repo !== repo) continue;
        const r = taskResults.get(t.task)!;
        console.log(`    ${repo} "${t.task}" r@20=${r.k20.toFixed(2)} r@50=${r.k50.toFixed(2)}`);
      }
    }
  }
}

function buildConfigs(fieldWeighted: boolean, labelPrefix: string): RankConfig[] {
  return [
    { label: `${labelPrefix}+bm25`, fieldWeighted, maxHops: 0, fusion: "max" },
    { label: `${labelPrefix}+max-d1`, fieldWeighted, maxHops: 1, fusion: "max" },
    { label: `${labelPrefix}+max-d2`, fieldWeighted, maxHops: 2, fusion: "max" },
    { label: `${labelPrefix}+max-d3`, fieldWeighted, maxHops: 3, fusion: "max" },
    { label: `${labelPrefix}+rrf-d1`, fieldWeighted, maxHops: 1, fusion: "rrf" },
    { label: `${labelPrefix}+rrf-d2`, fieldWeighted, maxHops: 2, fusion: "rrf" },
    { label: `${labelPrefix}+rrf-d3`, fieldWeighted, maxHops: 3, fusion: "rrf" },
  ];
}

function main(): void {
  const snapshots = new Map<string, Snapshot>([
    ["fastapi", loadSnapshot("fastapi")],
    ["httpx", loadSnapshot("httpx")],
  ]);

  // "before": single-field BM25 (pre-§4). "after": field-weighted.
  const beforeConfigs = buildConfigs(false, "before");
  const afterConfigs = buildConfigs(true, "after");

  const reportBefore: Report = {
    configs: beforeConfigs,
    snapshots,
    results: new Map(beforeConfigs.map((c) => [c.label, new Map()])),
  };
  const reportAfter: Report = {
    configs: afterConfigs,
    snapshots,
    results: new Map(afterConfigs.map((c) => [c.label, new Map()])),
  };

  for (const repo of ["fastapi", "httpx"]) {
    for (const cfg of beforeConfigs) run(repo, cfg, reportBefore);
    for (const cfg of afterConfigs) run(repo, cfg, reportAfter);
  }

  printTables(reportBefore, "single-field");
  printTables(reportAfter, "field-weighted");

  // Field-weighting verdict on the headline metric (BM25-only r@20, averaged).
  const beforeBm25 = reportBefore.results.get("before+bm25")!;
  const afterBm25 = reportAfter.results.get("after+bm25")!;
  const b20 = avg([...beforeBm25.values()].map((r) => r.k20));
  const a20 = avg([...afterBm25.values()].map((r) => r.k20));
  console.log(`\n=== FIELD-WEIGHTING VERDICT (BM25-only avg recall@20) ===`);
  console.log(`before=${b20.toFixed(3)}  after=${a20.toFixed(3)}  ${a20 > b20 ? "IMPROVED" : a20 < b20 ? "REGRESSED" : "UNCHANGED"}`);

  // RRF vs max() verdict: does fusion let graph-discovered symbols enter the
  // top-20? Compare field-weighted BM25+graph via max() vs via RRF at depth 1.
  const max20 = avg([...reportAfter.results.get("after+max-d1")!.values()].map((r) => r.k20));
  const rrf20 = avg([...reportAfter.results.get("after+rrf-d1")!.values()].map((r) => r.k20));
  console.log(`\n=== FUSION VERDICT (field-weighted, depth 1, avg recall@20) ===`);
  console.log(`max()=${max20.toFixed(3)}  rrf=${rrf20.toFixed(3)}  ${rrf20 > max20 ? "RRF IMPROVES" : rrf20 < max20 ? "RRF REGRESSES" : "RRF EQUAL"}`);
  const kept = rrf20 > max20 ? "rrf" : "max";
  console.log(`KEEP: ${kept}`);

  // Hop-depth verdict under RRF: which depth maxes recall@20. Depths may tie.
  const rrfDepth = [1, 2, 3].map((d) => {
    const m = reportAfter.results.get(`after+rrf-d${d}`)!;
    return avg([...m.values()].map((r) => r.k20));
  });
  rrfDepth.forEach((v, i) => console.log(`after+rrf-d${i + 1} avg r@20=${v.toFixed(3)}`));
  const rrfTied = rrfDepth.every((v) => Math.abs(v - rrfDepth[0]) < 1e-9);
  if (rrfTied) {
    console.log(`HOP-DEPTH VERDICT (RRF): depths 1,2,3 all tied at avg r@20=${rrfDepth[0].toFixed(3)}`);
  } else {
    let best = 1;
    rrfDepth.forEach((v, i) => { if (v > rrfDepth[best - 1] + 1e-9) best = i + 1; });
    console.log(`HOP-DEPTH VERDICT (RRF): best depth = ${best} (avg r@20=${rrfDepth[best - 1].toFixed(3)})`);
  }

  // Hop-depth verdict under max() - the config that SHIPS. Justifies maxHops.
  const maxDepth = [1, 2, 3].map((d) => {
    const m = reportAfter.results.get(`after+max-d${d}`)!;
    return avg([...m.values()].map((r) => r.k20));
  });
  maxDepth.forEach((v, i) => console.log(`after+max-d${i + 1} avg r@20=${v.toFixed(3)}`));
  const maxTied = maxDepth.every((v) => Math.abs(v - maxDepth[0]) < 1e-9);
  if (maxTied) {
    console.log(`HOP-DEPTH VERDICT (max()): depths 1,2,3 all tied at avg r@20=${maxDepth[0].toFixed(3)} - use depth 1 (cheapest)`);
  } else {
    let best = 1;
    maxDepth.forEach((v, i) => { if (v > maxDepth[best - 1] + 1e-9) best = i + 1; });
    console.log(`HOP-DEPTH VERDICT (max()): best depth = ${best} (avg r@20=${maxDepth[best - 1].toFixed(3)})`);
  }
}

main();
