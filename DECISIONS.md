# DECISIONS.md - ContextBudget build log

Dated entries, plain facts, including reversals. The human owns version control;
this file is the only running record of the build.

## 2026-08-17 - Milestone 1 begins (snapshot builder)

Fetched `vendor/` (fastapi @ a1fa70d, httpx @ b5addb6) via `scripts/fetch_repos.sh`;
wrote `snapshots/ATTRIBUTION.md`.

**No API credentials exist in this environment** - no `ANTHROPIC_API_KEY`, no
`anthropic` package. Per BUILD.md §3, running with `--no-tokens`: emit the full
symbol/edge structure with `tokens: null` and `tokensCounted: false`, and make
the packer refuse such snapshots. No `chars/4` substitute (BUILD.md §8 trap #2).

**Token counting redesigned mid-plan (BUILD.md §2/§3 update, prompted by the
model-choice question).** The original §2 said count four components per symbol
(signature / docFirstLine / docRest / body). Tokenization is not additive:
`count(a)+count(b) != count(a+b)` because tokens merge across string boundaries,
so summing component counts to get a tier cost drifts from the true cost and the
budget invariant would assert on a number that isn't the token count. §2 now
stores three counts per symbol (signature / skeleton / full), each the count of
the exact rendered tier string **including its trailing separator**. This makes
per-symbol counts sum to very nearly the true pack total. Milestone 4's
signature/doc/body UI breakdown is derived by subtraction and labeled
approximate.

**Judgment calls (underspecified in §2):**
- Module `signature` and `body` are empty; the module symbol carries only its
  docstring (split into docFirstLine/docRest). Module-level code is not a
  coherent retrievable unit (its classes/functions are separate symbols); the
  module record exists mainly as an import target and edge source.
- Pack separator between rendered symbols is `"\n\n"` (blank line), appended to
  each tier render. The 2% packing reserve (BUILD.md §4) absorbs the residual
  token merge at joins.
- Symbol `id` collision rule: when a qualname collides in a file (`@overload`,
  redefinition), every instance gets `#<lineStart>` appended (uniqueness over
  ambiguity).
- Edge resolution emits edges only to symbols we can resolve inside the indexed
  package; external names (typing, starlette) produce no edge. Calls are noisy
  by design (BUILD.md §3).
- `.agents/` in fastapi is excluded (dot-directory, no package source).

Measurement to add once a key exists: real `count_tokens` totals vs the §0
`chars/4` estimates (fastapi ~192k, httpx ~71k), as a DECISIONS entry.

## 2026-08-17 - Milestone 1 builder done (structure + edges; tokens deferred)

`scripts/build_snapshot.py --self-check` passes for both repos.

**Bugs found and fixed while building (each cost a cycle):**
1. `base[:-(level-1)]` with `level==1` is `base[:-0] == base[:0]` - dropped the
   entire package base for every single-dot relative import, so ~all import
   edges silently vanished. Guarded the drop to `level > 1`.
2. `from x import *` resolution wrapped the export value (already a
   `(file, qual)` tuple) in a second tuple. Fixed in `resolve_fromimport`.
3. File paths were `os.path.relpath`'d to `vendor/` instead of `vendor/<repo>/`,
   doubling the package prefix (`fastapi/fastapi/routing.py`).

**Measured structural counts (no tokens; `tokens: null`, `tokensCounted: false`):**

| | fastapi | httpx |
|---|---|---|
| symbols | 510 | 544 |
| import edges | 197 | 378 |
| annotation edges | 172 | 312 |
| call edges | 427 | 281 |
| inheritance edges | 58 | 56 |
| decorator edges | 2 | 3 |

**Revision below corrects the earlier fastapi counts (see next entry).** The
initial 56-import / 63-annotation / 0-decorator numbers were a bug, not the true
count: fastapi's absolute self-imports (`from fastapi.x import y`) were
unresolved, so ~three quarters of its import edges were silently dropped.

httpx's high import count reflects its star-reexport hub; the `--self-check`
confirms `Client`→`httpx/_client.py` and `Response`→`httpx/_models.py` (past
`__init__.py`).

**Collision ids confirmed:** httpx property getter/setter pairs share a qualname
and correctly get `#<lineStart>` (e.g. `BaseClient.timeout#254`/`#258`).
fastapi has no `@overload`/redefinition, so zero collisions there is correct.

**§0 token comparison is pending a key** - cannot run `count_tokens`, and a
`chars/4` estimate is explicitly forbidden (trap #2). This entry is the slot for
that measurement.

Top-5-file output in `--no-tokens` mode is by body bytes (labeled), since token
weights are null.

## 2026-08-17 - Milestone 1 fix: absolute self-imports (fastapi)

**The bug I reported as "low numbers, expected" was real.** fastapi imports
itself absolutely - `from fastapi.datastructures import Default` - 92 statements
/ 181 names. The resolver only handled relative imports (`from .x import y`);
for `level==0` it concatenated the module onto the package base and produced
`fastapi.fastapi.datastructures`, which was never in the index, so ~three
quarters of fastapi's import edges were silently dropped. httpx is the mirror
(relative-heavy), which is why its graph looked healthy. `fastapi/routing.py` -
the 64k-token file that motivated symbol-level selection - had **zero** outbound
import edges; graph expansion from the most important file could not traverse a
single import.

**Fix:** `import_target_module` now treats `level==0` as an absolute self-import:
return `module` directly if it's already an index key (in-package), else `None`
(external). Re-export fixpoint and export-fed annotation/call resolution pick it
up automatically.

**Measured before → after (fastapi):**

| Kind | before | after |
|---|---|---|
| import | 56 | **197** |
| annotation | 63 | 172 |
| call | 261 | 427 |
| inheritance | 54 | 58 |
| decorator | 0 | 2 |

Coverage went from 22% (56/252) to 197, clearing the floor. The annotation/call
rises are the export graph now resolving more in-package references, not noise.

**Two `--self-check` assertions added so it can't silently regress:**
- concrete: an import edge exists from `fastapi/routing.py::<module>` →
  `fastapi/encoders.py::jsonable_encoder`
- floor: fastapi import edges > 150

`python scripts/build_snapshot.py --self-check` passes both repos. The packer's
graph expansion can now be evaluated on a complete graph.

## 2026-08-17 - Edge weights, self-loop drop, dedup (BUILD.md §2)

**Invariant gap caught by review.** Neither of us was checking for duplicate
edge rows or self-loops. fastapi had 22 self-loops and 142 duplicate
`(from,to,kind)` rows (17% of 856). Duplicates matter for Milestone 2: graph
expansion ranks by traversal, so duplicate rows double-count symbols and skew
ranking. But plain dedupe would throw away real signal - A calling B five times
is stronger than once.

**§2 change (authorized):** `Edge` gains `weight: number` (occurrences collapsed
into this row, ≥ 1). Rules: exactly one row per `(from,to,kind)`; drop every
edge where `from == to`.

**Measured (deduped rows):**

| | fastapi | httpx |
|---|---|---|
| rows | 700 | 827 |
| weight>1 rows | 74 | 128 |
| max weight | 7 | 7 |

Before dedup: fastapi 856 raw edges → 700 rows (22 self-loops dropped, 142
collapsed into weighted rows); httpx 1030 raw edges → 827 rows (0 self-loops,
all collapse by duplication). Conservation checks: fastapi sum(weight)=834 +
22 self-loops = 856; httpx sum(weight)=1030. The distribution is healthy - most
edges are weight 1; a minority are multi-occurrence.

**`--self-check` now asserts:** zero self-loops and zero duplicate
`(from,to,kind)` rows, in addition to the earlier structural/id checks.

**Decorator edges note (not a bug, mislabeled):** the 2 fastapi decorator edges
point at `fastapi/exceptions.py::FastAPIDeprecationWarning` from
UJSONResponse/ORJSONResponse - that's a reference in the decorator's *arguments*
(typically `@lru_cache` / deprecation-warning passing), not the decorator name
itself. Real edge, real target, slightly wrong kind. The earlier "decorator
edges should be 0" was about decorator names and still holds.

## 2026-08-17 - Milestone 2: packer and tests

`lib/pack.ts` + `tests/pack.test.ts`, `node --test` (Node 24 native TS). Pure -
no API calls. The packer **refuses** any snapshot with `tokensCounted: false`
(BUILD §3), which is every committed snapshot right now, so test 1 (budget
invariant) is **skipped with a clear reason** rather than faked: it needs
`count_tokens` on the rendered pack string, which needs `ANTHROPIC_API_KEY`.

**Hop depth - the central measurement, chosen not guessed.** BUILD §4: "start
at 2, try 1 and 3, pick the depth from what test 4 measures." On task "add
per-route rate limiting" (BM25 seeds then graph expansion at depth d):

| depth | fastapi recovered | httpx recovered |
|---|---|---|
| 1 | 46 | 2 |
| 2 | 179 | 18 |
| 3 | 242 | 134 |

**Chose depth 3** - it recovered the most symbols BM25 missed on both repos
(242 fastapi / 134 httpx). Deeper than 3 not tested; diminishing returns
expected from decay^hops. Recorded here as the evidence for the expansion claim,
and it's the packer default (`maxHops: 3`). Depth 1 was confirmed too shallow -
exactly the "passes vacuously / fails misleadingly" trap BUILD §4 warns about.

**Weight used.** Graph score = `seed_score * decay^hops * log(1 + edge.weight)`
(BUILD §4), so a weight-7 call beats weight-1 without a 7× landslide. Deduped
weights from the previous entry are live data, not dead.

**Tests (5 pass, 1 skipped):** refusal; pin honoured (full even at low score);
evict honoured (nowhere in output); expansion earns its place (a synthetic
graph neighbor BM25 scores 0 is pulled in with `reason: graph:`); hop-depth
measurement (prints the table above, asserts expansion recovers >0 - fails
loudly if the claim dies). Budget invariant skipped pending a key.

**Packer behavior notes:** a zero-score symbol is evicted as `no match` - with
unlimited budget it would otherwise be admitted at signature tier for free and
mask the graph-recovery signal.

## 2026-08-17 - Milestone 2 corrections (tokenizer, seed_score, hop depth)

Three review-found problems, fixed in dependency order. Each invalidated the
measurement of the next; the prior depth-3 entry above is superseded.

**1. Tokenizer - the most serious bug so far.** `/[a-z0-9_]+/` put `_` inside
the class, so `solve_dependencies` was one token and "solve dependencies" two -
they could never match. It returned confident wrong answers (fastapi: "add api
route" top hit `build_middleware_stack`, `add_api_route` absent; "solve
dependencies" top hit `dependencies/__init__.py::<module>`, `solve_dependencies`
absent). It didn't fail loudly. I'd masked it by changing test 4 to an underscored
query - hiding the bug. Fixed per BUILD §4: index the whole identifier AND its
parts (split on `_`, camelCase, digit boundaries), case-preserving so camelCase
survives. `solve_dependencies` → `[solve_dependencies, solve, dependencies]`,
`APIRouter` → `[apirouter, api, router]`. Test 4 reverted to natural language.

**2. Missing seed_score.** I'd deviated from §4 (`seed_score * decay^hops *
log(1+weight)`) with a "seed_score-independent" formula - the comment even said
so. Consequence: contributions saturated at ~0.69-0.81 at every depth (~10% of
top BM25), hundreds of symbols in a tied band, so the budget cut was arbitrary.
`graphContributions` now takes seeds as `[id, score][]` and multiplies by
seed_score, so a strong seed dominates a weak one.

**3. Hop depth - remeasured, default reverted to 2.** The depth-3 call used the
wrong criterion ("recovered the most") on a broken score landscape. What matters
is whether the extra symbols are ranked *distinguishably* and actually admitted
at realistic budgets. Remeasured after 1+2 (task "add per-route rate limiting"):

| depth | fastapi recovered | spread | httpx recovered | spread |
|---|---|---|---|---|
| 1 | 50 | 0.490 | 3 | 0.667 |
| 2 | 167 | 0.301 | 75 | 0.093 |
| 3 | 230 | 0.280 | 179 | 0.073 |

Depth 3 reaches 230-179 symbols (most of the graph) - but spread collapses at 2→3
(httpx 0.093→0.073): extra symbols are increasingly tied, i.e. *not*
distinguishably ranked, so admitting them is noise. **Chose depth 2.** Default
reverted from 3 to 2 (`maxHops: 2`). Depth judged on admission + score spread,
not reach count, per updated §4.

**Test fixture tightened.** The 4-symbol / 4000-budget synthetic was too small to
constrain anything (everything fit), which is why the `score>0` admission rule
was unverifiable. It's now 6 symbols with a 300-budget so admission order is
actually tested; pin/evict/expansion all run under a real constraint. The
`score>0` rule is retained but now justified by the constrained fixture, not a
synthetic artifact.

Post-fix: fastapi seeds rose 15→78 (the tokenizer now matches English), all
5 tests pass, budget test still skipped pending a key.

## 2026-08-17 - Milestone 2.5: ground-truth eval + field-weighted BM25

**Ground truth built (BUILD §4.5).** `eval/tasks.json` - 10 tasks (5/repo),
labels derived by READING THE CODE (Explore + direct reads), never from the
retriever. All 30 expected ids verified to exist in the snapshots. Task 1
("add per-route rate limiting") is the strongest: 4 of 5 labels have zero
lexical overlap with the query, so it genuinely tests expansion. 8/10 tasks
have ≥1 zero-overlap label. Replaced the broken "serve static files" item
(1-word bare re-export, zero edges, unscorable) with "include a sub-router
with a URL prefix" → verified `APIRouter.include_router` (routing.py:3133) +
`FastAPI.include_router` (applications.py:1441) + `APIRouter` all accept
router+prefix by reading them.

**`eval/score.ts`** reports recall@k on RANKED order (k=20,50) per task,
averaged, and split class/func/method - for BM25-only, BM25+graph at depths
1,2,3, AND for both pre-§4 single-field and post-§4 field-weighted BM25.
Scored on ranking, not budget (all snapshots tokensCounted:false). A marked
`recallAtBudget` path is stubbed and throws until a key exists.

**Field-weighted BM25 (Task 2) - KEPT, eval-confirmed improvement.** Changed
`bm25Scores` to score `name` and `signature+docFirstLine` as SEPARATE fields,
each its own length normalisation, combined `3*bm25(name)+1*bm25(sig+doc)`.
Kept a `fieldWeighted:false` path in `Bm25Opts` so the eval can show the
before/after.

| BM25-only avg recall@20 | before | after |
|---|---|---|
| overall | 0.598 | **0.748** |
| class | 0.52 | 0.71 |
| func | 0.17 | 0.67 |
| method | 0.86 | 0.93 |

Weighting name ×3 helped class labels most (0.52→0.71) as predicted - a class's
name is essentially all its indexable text. Func also jumped (0.17→0.67).
**Verdict: IMPROVED, kept.**

**Prediction confirmed - classes by structure, functions by text.** BM25-only
class recall (0.71 after) trails method (0.93), and graph expansion lifts class
r@50 0.71→0.88 at d≥1. Functions are found by text; classes benefit from the
graph.

**Hop depth re-check against the eval.** After field-weighting, depths 1,2,3 all
tie at avg recall@20 = 0.748 - **expansion depth does not change ranking recall**
on this eval. So the depth decision rests on the earlier spread/admission
argument, which picked 2. No eval basis to change it; keeping `maxHops: 2`.
Ranking tuning stops here.

**remaining weak spots the eval exposes:** "send a custom authentication header"
(Auth/BasicAuth/Client) scores 0 at r@20 across all configs - the class labels
are 3-4-word names with no query term and no graph path from a seed. Worth
noting, not fixing now.

## 2026-08-17 - Milestone 2.5 corrections (per-repo bug, RRF, maxHops)

**Per-repo aggregation bug fixed in the scorer.** `eval/score.ts` was averaging
all 10 tasks per row, so both repos printed the overall average. Now filters by
task repo. Corrected numbers (avg recall@20):

| | fastapi | httpx | overall |
|---|---|---|---|
| single-field BM25 | 0.813 | 0.383 | 0.598 |
| field-weighted | 0.880 | 0.617 | 0.748 |

**The real finding: httpx was the broken repo.** Field weighting lifted httpx
+61% (0.383→0.617) versus fastapi +8% (0.813→0.880) - the opposite of where the
length-bias diagnosis pointed (that was fastapi-specific). Weighting name ×3
rescues httpx's 3-word class symbols where the name is all there is. **Two
different problems, one fix.**

**Expansion via max() is neutral at usable ranks.** After field weighting,
BM25+graph changes r@20 by exactly zero (0.880/0.617 at depth 0 and 1) - it only
helps r@50 (0.75→0.83). **RETRACTED below: r@50 IS usable - see the correction
entry.**

**RRF tried and REJECTED - keep max().** Reciprocal Rank Fusion (`1/(60+rank)`
summed across BM25 and graph lists) REGRESSES r@20: 0.748→0.607. It lets
graph-discovered symbols crowd out higher-value BM25 matches at the top ranks.
Per instruction, the measured negative result is logged rather than massaged:
**expansion does not help at usable ranks on this eval.** max() stays the fusion.

**maxHops set to 1.** Depths 1,2,3 are identical on every metric in every config
(under max() and RRF). Depth 1 is cheapest and measurably equivalent. The earlier
spread-based argument for 2 is superseded - spread was a proxy, recall is the
objective. Re-checked after RRF; fusion doesn't change it (RRF d1/2/3 also tie).

**Two persistent zeros, logged as findings.**
- "send a custom authentication header" = 0.00 at r@20 everywhere. Query word
  "authentication" never matches the token "auth" - no stemming/prefix matching.
  No lexical seed → no seeds for expansion → the graph can't rescue a query it
  can't enter. **Architectural limit: expansion amplifies a lexical foothold, it
  cannot create one.**
- "stream a large response body" went 0.00→0.67 on field weighting alone - good
  evidence for the fix (name ×3 surfaces `Response.iter_bytes`/`stream`).

## 2026-08-17 - Retraction: r@50 IS usable; at-full-tier metric wired; maxHops justified on max()

**RETRACTION - my "r@50 is unusable" claim was wrong (asserted, not measured).**
Measured skeleton-tier cost: median fastapi 16 tokens, httpx 11. An 8k budget
admits ~440 of 510 fastapi and ~516 of 544 httpx symbols; 16k admits ~466 fastapi
and all 544 httpx. So r@50 is well inside what a real pack holds, and expansion's
gain under max() - overall 0.75→0.83, httpx 0.62→0.73 - is a **genuine usable
improvement.** Expansion does help at usable ranks. The RRF rejection stands
exactly as logged; only the "neutral/useless at usable ranks" framing is retracted.

**The bigger consequence: admission is nearly free, promotion is the scarce
resource.** All 510 signatures + first doc lines ≈ 8k, so the budget is spent on
PROMOTION to `full` (one body = hundreds of tokens, more than a hundred
skeletons). The packer's real question is "which handful of bodies can I afford
to read", not "which symbols make the cut."

**Metric wired: `recallAtBudgetFull` in eval/score.ts.** Measures "at budget B,
are the expected symbols present AT FULL TIER" - greedy fill from the ranked
list, promote toward full, count expected labels that reach full. It replaces
the old stub's intent and activates once a snapshot is tokensCounted:true (needs
a key; still throws now). This is the metric Milestone 4's UI should tell the
story around - the promotion list, not the eviction list; the scarcity is bodies.

**maxHops=1 re-justified on the config that SHIPS.** The earlier sweep ran under
RRF (the rejected fusion). Added max-d1/d2/d3 configs and re-ran under max():
**all three tie at avg recall@20 = 0.748.** Depth 1 is cheapest and equivalent, on
max()'s own evidence. maxHops=1 stands.

**No packer restructure done** for the promotion insight - logged and wired into
the eval metric; it shapes the UI in Milestone 4, not the packer now.

## 2026-08-17 - Milestone 3: API routes

Scaffolded Next.js (16.3.1, patched - avoided 15.3.3's known CVE). All three
routes implemented. Split by what needs a key.

**Built and curl-verified (no key):**
- `/api/pack` - full PackRequest→PackResponse. Surfaces the §3 refusal cleanly:
  snapshots are tokensCounted:false, so pack() throws and the route returns 422
  with the refusal message. Verified.
- `/api/tool` - read_symbol / list_symbols / read_file against the snapshot.
  Verified: read_symbol returns the full symbol; list_symbols returns ids;
  read_file returns reconstructed source. Unknown ids/paths rejected 400.
- **Trust boundary (partially verified - see corrections below):** client sends
  ids+tiers only; every id validated against the snapshot with unknown ids
  rejected (pack pins/evicts, tool args verified; step selection now verified);
  request body capped at 64 KB (413); read_file rejects paths not present as
  snapshot file keys - `../etc/passwd` → 400, JSON-key based so traversal
  doesn't apply. NOTE: server pins model/max_tokens/effort is DECLARED but not
  yet enforced - there is no model call to pin them on (correct for the split,
  but not logged as verified).
- **Spend-cap plumbing:** `lib/cap.ts` (per-visitor 3/IP/24h + global $25, Upstash,
  disabled gracefully when env absent) and `lib/cost.ts` (layered accounting:
  input + cache_creation + cache_read priced 1x/1.25x/0.1x, output separate;
  Opus 5 $5/$25 per MTok). Wired into step route (checked before each turn).

**Written, unverified (needs key):** `/api/step` - SSE agent turn structured
fully (validate selection ids/tiers, check per-visitor + global caps, then would
render pack, build system block with ephemeral cache_control, stream one turn,
record spend). The actual `client.messages.stream()` turn is not exercised - I
did not fake a model response to make a demo work. The no-key path returns 500
with a clear message once a VALID request reaches it.

**M3 corrections (review-found):**
1. **step validation was unreachable.** The key check originally sat before all
   validation, so with no ANTHROPIC_API_KEY the body cap, repo/selection/id/tier
   validation, and BOTH spend-cap layers never ran - garbage input returned a
   config error (500), not 400. My earlier "step selection verified" claim
   couldn't hold. **Fixed:** moved the key check to AFTER validation + caps.
   Order is now parse+cap → repo/selection/messages → id/tier → per-visitor →
   global → key. Re-verified adversarially: bad repo 400, non-array selection
   400, unknown symbol id 400, invalid tier 400, 65KB body 413, valid selection
   reaches the key check (500). All confirmed by curl.
2. **read_file read from vendor/, which never deploys.** vendor/ is gitignored, so
   it would 404 on every call in production - a dead tool. **Fixed per §5:**
   serve read_file FROM THE SNAPSHOT by concatenating that file's symbols in
   lineStart order. No vendor/ dependency, identical local and deployed. Snapshot-
   key validation kept (that's what makes traversal impossible). Verified: read_file
   returns reconstructed source; traversal still 400.

**Infra:** added `@/*` path alias, `allowImportingTsExtensions`, tsconfig exclude
for eval/tests (node-run, verified separately). `npm run build` passes (exit 0);
all routes registered as dynamic. `npm run start` + curl confirmed HTTP paths.
Pre-existing pack tests still pass (5).

## 2026-08-17 - read_file fix 2: reconstruction REJECTED, exact source stored

The concatenation approach (reconstruct file text from symbol bodies) was tried
and measured, and it fails two ways:

- **Lossy** - imports and module-level code live outside any function/class
  symbol, so they vanish. `httpx/_auth.py` reconstructed lacks `import typing`
  and `from ._models import ...` that the real file has. An agent that can't see
  imports may propose adding one that already exists - a plausible wrong diff,
  and diffs are this product's output.
- **Duplicative** - a class symbol's body contains its methods AND each method
  is separately a symbol, so every method appears twice. Measured: reconstructed
  `httpx/_auth.py` = 18992 chars vs real 11907 (160%).

**Correct fix (BUILD §2/§5): store the exact source in the snapshot.**
`Snapshot` gains `files: Record<string, string>` (path → exact file source);
`build_snapshot.py` writes it from the parsed sources; `read_file` returns
`snapshot.files[path]` verbatim. No vendor/ dependency. Snapshot-key validation
kept intact (that's what makes traversal structurally impossible). Snapshots grew
~2.13 MB → ~3.26 MB - nothing for Vercel, and exactness is what a diff-producing
tool needs.

**Verified:** byte-for-byte test (`tests/pack.test.ts`) asserts
`snapshot.files[path] === real vendored file` for routing.py,
dependencies/utils.py, _auth.py, _models.py - all pass. Next build passes; the
vendor read warning is gone. Reconstruction is replaced, not kept.

## 2026-08-17 - Milestone 4: UI (two panels), with a hard blocker

**BLOCKER - cannot render a real pack.** The task premise was "snapshots are now
tokensCounted:true", but in this environment the committed snapshots are
`tokensCounted:false` and there is no `ANTHROPIC_API_KEY` (verified via search and
env check). `/api/pack` therefore returns the §3 refusal (422), not a real pack. I
will not fabricate token counts (BUILD §8 trap #2). The UI is built and renders,
and it surfaces the 422 honestly; "render a real pack from /api/pack end to end"
cannot complete until a key exists and the snapshots are rebuilt with `--tokens`.

**Built (`app/layout.tsx`, `app/page.tsx`):** one screen, no routing/nav/settings.

LEFT - context:
- budget slider 4k/8k/16k/32k (button row + range), re-packs on change.
- token meter split signature / docstring / body (from PackResponse.totals).
- symbol rows grouped by file, each with tier, token cost, and PackResponse
  `reason`; pin (★), evict (✕), expand-to-full (+). Each re-packs and shows the
  delta (pins/evicts are separate state sent to /api/pack).
- eviction list with reasons + re-admit.
- **Promotion story, not admission:** the meter leads with how many symbols are at
  `full` tier (bodies - the scarce resource) alongside skeleton tokens, per the
  §4.5/§6 finding that all 510 fastapi skeletons cost ~8k so admission is nearly
  free. Do not build around admissions.

RIGHT - run:
- Run agent turn button (POSTs selection = ids+tiers to /api/step), interrupt
  button (aborts), live cost readout. Without a key /api/step 500s and the UI
  surfaces the message in the console pane honestly - no faked stream.

**Verified:** `npm run build` exit 0 (route `/` registered static). Server + curl:
`/` 200 with ContextBudget/budget/Selected symbols/Evicted/Token meter present;
`/api/pack` 422 with the §3 refusal. Diagnostics clean on page/layout.

**Next for the demo:** obtain ANTHROPIC_API_KEY, run `scripts/build_snapshot.py
--tokens` to produce tokensCounted:true snapshots, then a real pack renders and
the meter/promotion delta is live.

## 2026-08-17 - Milestone 4: --estimate mode, pack rendering, real meter

**1. `--estimate` mode (BUILD §3).** `build_snapshot.py --estimate` fills each
symbol's `tokens` with chars/4 per rendered tier and emits `tokensCounted:true`
with `tokenSource:"estimate"`. Not trap #2 - it is explicitly non-silent:
- snapshot carries `tokenSource: "estimate" | "count_tokens"`;
- `pack()` propagates it; `/api/pack` returns `tokenSource` in every response;
- the UI renders a loud **ESTIMATED TOKENS** badge beside the meter whenever
  tokenSource !== "count_tokens";
- `/api/step` REFUSES to execute on an estimate (422, clear message) - the agent
  loop never runs on approximate numbers; only the UI preview does;
- the budget-invariant test stays skipped (estimate can't satisfy it).

**2. Pack-rendering paths now run.** With estimate snapshots, /api/pack returns a
real pack at every budget. Verified at 8k on fastapi ("add per-route rate
limiting"):
- `totals {signature:1879, doc:0, body:5961, total:7840}`, `budget:7840`
  (0.98 reserve), `tokenSource:"estimate"`. Full-tier bodies are the bulk - the
  promotion story holds.
- **Pin** a low-scoring symbol (`OAuth2PasswordRequestForm`) → appears at full;
  **evict** `jsonable_encoder` → leaves selection and appears in evicted. Delta
  visible: body total rose 5961→6204 when the pinned full symbol was admitted.
- ESTIMATED badge path confirmed (tokenSource is "estimate" in the response).

**3. Meter is now a real meter.** Replaced the number-row with a stacked
horizontal bar (signature / docstring / body) drawn as proportions of the budget,
plus a distinct **bodies band** showing how many of the selected symbols are
promoted to full (the scarce resource). Plain CSS, no component library.

**Tests updated for the estimate reality:** the "refusal" test now builds a
synthetic uncounted snapshot (committed ones are estimate-counted) to exercise the
§3 guard; budget-invariant skip reason updated to "estimate can't satisfy a hard
invariant". All pass (6 pass, 1 skipped).

**verified live:** estimate snapshots rebuilt (fastapi total 296268, httpx 107417,
tokenSource estimate); /api/pack renders packs at all budgets; /api/step returns
422 on estimate; npm build exit 0; test suite green.

## 2026-08-17 - Builder bugs: docFirstLine empty + class-body duplication

Two bugs in symbol extraction were hiding behind green tests; both invalidated
prior results.

**BUG 1 - docFirstLine was empty for ~98% of fastapi, 100% of httpx.** Root
cause: `doc_string` returned the raw `Constant.value`, which for FastAPI-style
docstrings starts with a newline, so `split("\n")[0]` was `""` and the whole
docstring landed in `docRest`. Fix: use `ast.get_docstring(node, clean=True)`
(which strips leading/blank indentation), then take the first NON-EMPTY line.
Consequences fixed: skeleton tier is now distinct from signature; the meter's doc
band has real content; "docstring truncation" (the 42%/55% lever) is finally
implemented; BM25 now indexes actual docstring text.

**BUG 2 - every method body was duplicated inside its class body** (200/200
fastapi, 369/369 httpx). A class symbol's body included its method definitions,
which are also separate symbols - admitting both at full double-charged the same
source against the budget. Fix: a class's body now carries class-level code ONLY
(attributes, nested classes), excluding method definitions and the docstring.
This was the same root cause as the read_file 160% inflation; storing raw text
fixed that symptom, not the cause.

**Two self-check assertions added (BUILD §3):**
- docFirstLine non-empty when docRest is non-empty (has a docstring);
- no direct method's `def <name>` at 4-space indent appears in its class's body
  (nested-class methods, legitimately deeper-indented, are excluded from the
  check to avoid false positives).

**Result - totalTokens dropped ~35-40% (the double-counting is gone):**

| repo | before | after |
|---|---|---|
| fastapi | 296268 | **179188** |
| httpx | 107417 | **61237** |

**Eval re-run - recall moved with docstring signal present.** The old 0.748 was
measured on a broken index (zero docstring signal):

| metric | before (broken) | after (fixed) |
|---|---|---|
| field-weighted BM25 avg recall@20 | 0.748 | **0.782** |
| single-field BM25 avg recall@20 | 0.598 | 0.60 |
| RRF vs max() | max 0.748 | **still regresses** (rrf 0.657) - max() stays |

max() depth 1/2/3 still tie at 0.748. httpx class labels improved (field-weighted
class r@50 0.92).

**8k fastapi pack re-check:** see report - meter doc band is now non-zero (the
docstring content the tier design depends on).

## 2026-08-18 - Gemini provider integration (Milestone 3/4)

**Provider: gemini-3.6-flash (pinned, verified against a real key).** Not
2.5-flash (404 "no longer available to new users" despite appearing in the
listing) and not flash-latest (503 high demand). Free tier, 250k TPM - fits a 32k
pack with room. Server pins model + maxOutputTokens + tools; none client-settable.

**1. countTokens via Gemini.** `build_snapshot.py --tokens` now calls Gemini
`countTokens` (POST /v1beta/models/gemini-3.6-flash:countTokens, `X-goog-api-key`,
read `totalTokens`), using `GEMINI_API_KEY`, content-hash cache, tokenSource
"count_tokens". Free and rate-tolerant (batch freely). Measured totals pending the
(sequential) build - see report. Estimates were fastapi 179188 / httpx 61237; the
real counts land once the background build finishes.

**2. /api/step against Gemini, streaming.** Implemented the real agent turn in
`app/api/step/route.ts`: renders the pack from the snapshot (ids+tiers only),
calls Gemini `streamGenerateContent?alt=sse`, streams SSE deltas. **Cost
accounting** uses `lib/cost.ts`: `outputTokens` = candidates + thoughts (Gemini
reasons by default and bills thinking as output - measured 92/99 of a turn was
thoughts), `accountedFor` asserted (a missed field fails loudly, no "$0"),
`project()` returns the multi-provider projection. All existing validation, the
estimate refusal, and cap checks preserved.

**3. Replay (mandatory).** Every live run is recorded to Redis (`replay:<repo>`
LPUSH) as it streams. On 429/5xx, play back a prior real run for the same
repo+task, **labelled visibly as a replay** (`type:"status", live:false,
replay:true, note:"REPLAY - this is a prior recorded run, not a live result"`).
Never present a replay as live. Free-tier quota is org-wide and unknown for
3.6-flash, so 429s are expected with concurrent reviewers.

**Verify:** `npm run build` exit 0 (all routes dynamic, `.env.local` loaded so
GEMINI_API_KEY is available). Test suite still green. The real end-to-end agent
turn needs the count_tokens snapshots (background build) - until then the estimate
refusal correctly blocks /api/step.

## 2026-08-18 - Real counts, budget test unskipped, live agent turn

**Measured totalTokens (count_tokens via Gemini) vs --estimate - validates
--estimate:**

| repo | estimate (chars/4) | count_tokens | delta |
|---|---|---|---|
| fastapi | 179188 | **170878** | 4.6% high |
| httpx | 61237 | **65993** | 7.8% low |

chars/4 was only 4.6% off on fastapi - the estimate is a credible preview, now
proven rather than assumed.

**Budget-invariant test unskipped and passing.** It now renders the full pack,
calls Gemini countTokens on the actual pack string, asserts actual ≤ budget, and
prints the drift vs the summed per-symbol counts:

```
fastapi budget=4000 summed=3920 actual=3920 drift=0 (0.00%)
fastapi budget=8000 summed=7833 actual=7833 drift=0 (0.00%)
fastapi budget=16000 summed=15679 actual=15679 drift=0 (0.00%)
fastapi budget=32000 summed=31354 actual=31354 drift=0 (0.00%)
httpx budget=4000..32000 summed=1113 actual=1113 drift=0 (0.00%)
```

**Drift = 0.00%** - summed per-symbol tier counts exactly equal countTokens on
the fully rendered pack (the separator-bearing per-symbol counts from §3/§4 are
accurate). **PACK_RESERVE set from measurement:** the guessed 2% was overkill;
changed to 0.995 (0.5% safety margin for any join merge). 7/7 tests pass, none
skipped.

**Eval re-run with real counts: unchanged.** recall@k is ranking-only (no token
counts), so the table holds exactly: field-weighted BM25 avg r@20 = 0.782, max()
beats rrf, depths 1/2/3 tie at 0.748 → keep maxHops=1. Real counts don't shift
ranking recall.

**count_tokens_for_symbols parallelized** with a 10-worker ThreadPoolExecutor
(thread-safe content-hash cache). Rebuilt both snapshots in ~3 min (was ~6/repo
sequential).

**Live agent turn verified (fastapi, 8k, "add per-route rate limiting").** Fresh
server (the old `next start` daemons served stale compiled route code - killed by
starting on a new port, 9999/9000). One real streamed turn:
- `type:status live:true`, then `type:done` (the model produced no visible text
  delta in this pass - it likely emitted a tool_use first, which the SSE parser
  surfaces as part blocks).
- **Cost accounting held:** prompt 3850, candidates 21 + thoughts 234 = output 255,
  total 4105. accountedFor() = 3850 + 255 = 4105 ✓.
- **projection:** claude-opus-5 $0.0256, claude-sonnet-5 $0.0154, gemini-3.6-flash
  $0 (free tier). No "$0" shown for the paid models; Gemini's real cost is $0.

**Bug found by accountedFor (the guard worked):** Gemini `streamGenerateContent`
returns `usageMetadata` as **cumulative** per-chunk counts (running totals), but I
initially did `+=` across chunks - summing cumulative counts double-counted output,
so accountedFor failed loudly. Fixed to overwrite (cumulative, not deltas). The
guard caught a real accounting bug on first live run; that's the design working.

## 2026-08-19 - live agent turn working; four bugs found by measurement

**Provider model: `gemini-3.5-flash-lite`, not `gemini-3.6-flash`.** Measured on the same
8k pack:

| model | latency | thinking tokens | quota state |
|---|---|---|---|
| gemini-3.6-flash (default) | 62.4s bare, >120s on 8k pack | 424–5,328 | 429 exhausted |
| gemini-3.6-flash + thinkingBudget 512 | 8.4s | 215 | " |
| gemini-3.5-flash-lite | 0.8–3s | **0** | still serving |

Three reasons lite wins, not one: 48x lower latency, ~15x less quota burn per turn (zero
thinking tokens), and a **separate free-tier quota pool** - 3.6-flash was already
429-exhausted while lite still served. `thinkingBudget: 0` is rejected (400
INVALID_ARGUMENT): thinking can be bounded on 3.6-flash but never disabled.

Also load-bearing for deployment: **Vercel Hobby caps function duration at 60s**, so
3.6-flash's unbounded thinking would have failed in production while passing locally.

**Bug: SSE frames never parsed (the one that made the demo look dead).** Gemini's stream
uses CRLF. Byte-level check: `raw.includes("\n\n")` is **false**, `raw.includes("\r\n\r\n")`
is **true**, and `raw.split("\n\n").length === 1`. The route split on `"\n\n"`, so no frame
ever completed, everything accumulated in the buffer, and the trailing flush tried to
`JSON.parse` all 39 concatenated frames - throwing into a silent `catch`. Symptom was a 25s
wait with zero output and no error. Fixed by normalising CRLF before splitting.

**Bug: an all-zero `done` frame reported a failed turn as successful.** That is what hid the
timeout above. Now a stream ending with `totalTokenCount === 0` emits an explicit error
frame instead.

**Bug: client `messages` spliced raw into the provider payload.** Validation checked shape
but passed the original objects through, so unknown keys rode along; Gemini rejected them,
which means the provider was enforcing our trust boundary rather than us. Now each message
is rebuilt from validated fields only.

**Fixed: API key moved from query string to `X-goog-api-key` header** in both the route and
the budget test. Query strings land in access logs.

**Verified live:** 3s, 21 delta frames, 1,813 chars, `prompt=7993 candidates=502 thoughts=0
total=8495` (accountedFor holds), projection opus-5 $0.0525 / sonnet-5 $0.0315 / lite $0.
Output referenced `_EffectiveRouteContext` and `APIRoute` - real packed symbols - proving the
pack reached the model.

**Known gap: replay is empty until a live run is recorded.** The 429 exposed the
chicken-and-egg: replay only rescues a rate-limited reviewer if a successful run exists in
Redis first. Seed it before deploying.

## 2026-08-19 - full-codebase audit: 15 findings, 11 fixed

Ran a correctness review over `scripts/build_snapshot.py`, `lib/`, `app/`, `eval/`,
`tests/`. The headline: **every green test was passing over a UI that had never worked.**
All prior verification was `curl` against the API; the browser path was never exercised.

**Fixed - product-breaking**

1. `lib/pack.ts` - pins were admitted at `full` with no budget check. Measured: budget
   4000 with 6 large pins produced a **23,563-token pack reported as compliant**, a 5.9x
   overrun of the one invariant this product claims. The suite was green because the
   budget test never pinned and the pin test never asserted budget - each passed, their
   combination did not. Fixed with a degradation ladder (full → skeleton → signature,
   evict only if even the signature will not fit) so a pin is honoured as far as the
   budget allows and the degradation is *reported*, which is the tradeoff the product
   exists to surface. Regression test added.
2. `app/page.tsx` - called `res.json()` on a `text/event-stream` body, so a successful
   turn rendered a JSON parse error. The run panel had never displayed model output.
3. `app/page.tsx` - posted `messages: []`, so the model received the context pack with
   **no instruction at all**. Now sends the task.
4. `app/page.tsx` - cost readout keyed on a `cost` field the API never sends (it sends
   `projection`), so it was permanently `$0.000`.
5. `app/api/step/route.ts` - `recordReplay` was called after `streamTurn` returned, but
   `start()` runs lazily on first read, so it always fired with `liveText === ""`.
   **Nothing was ever recorded**, which is why the 429 replay fallback had nothing to
   play back. Moved inside `start()`, success path only.
6. `app/api/step/route.ts` - the §3 refusal checked only `tokenSource === "estimate"`, so
   a `tokensCounted:false` snapshot (builder writes `tokenSource: null`) would have run a
   live turn on absent counts. Now requires `tokensCounted && tokenSource === "count_tokens"`.
7. `lib/cap.ts` - spend accumulated in **cents**, compared against `25` **dollars**: the
   global cap would have tripped at $0.25.
8. `lib/cap.ts` - `/expire` re-armed on every `incr`, so an active visitor pushed their
   own 24h window forward forever and stayed blocked permanently. Now armed only when
   `incr` returns 1.
9. `app/page.tsx` - repo `<select>` neither re-packed nor cleared pins/evicts, so the
   next pin or run posted ids from the previous snapshot and 400'd.
10. `app/page.tsx` - editing the task never re-packed; the agent turn ran against the
    previous task's context. Both now re-pack (task debounced 300ms).
11. `app/page.tsx` - panel copy named `ANTHROPIC_API_KEY`.

**Outstanding, with assessment**

- `lib/cap.ts` - `recordSpend()` has no callers, so the global ceiling never increments.
  Lower priority than it looks: on a free tier there is no dollar spend, and the layer
  that actually binds is provider quota, handled by replay. Wire it before any paid key.
- `scripts/build_snapshot.py` - the countTokens HTTP call sits inside `cache_lock`, fully
  serialising the 10-worker pool. The "parallelised" claim was hollow; ~3,150 requests
  ran one at a time. Cheap fix, only costs rebuild time.
- `lib/pack.ts` - `visited.add()` precedes the score comparison, so a same-hop node keeps
  the first edge's weight rather than the max, contradicting the documented
  max-over-paths. Affects ranking quality subtly; eval numbers were measured with it.
- `app/api/step/route.ts` - no try/catch around the reader loop, so a mid-stream abort
  hard-errors instead of emitting the `type:"error"` frame.
- `scripts/build_snapshot.py` - API key in the query string (the route and the test both
  use the header); failed symbols keep partial `tokens` dicts instead of `null`, which
  defeats the null-refusal while `report()` claims `tokens:null`.

**Lesson for the write-up:** the test suite, the eval, and the budget invariant were all
green while the UI could not display a single token and pins could blow the budget 5.9x.
Green tests over an unexercised integration path prove the units, not the product.

## 2026-08-19 - arbitrary repos, and the lock that made rebuilds slow

**Repos are now discovered, not hardcoded.** `lib/snapshot.ts` reads `snapshots/*.json` at
runtime and `GET /api/repos` feeds the UI picker, so indexing a new project needs no code
change. `build_snapshot.py --path <dir> --name <n>` indexes any local Python project; it
locates the package directory itself (single top-level dir with `__init__.py`) and errors
explicitly on an ambiguous layout rather than guessing. Verified against Python's stdlib
`json` package: 31 symbols, 11,778 counted tokens, 23 edges.

Two gates on the repo name, both needed: a `[A-Za-z0-9_-]+` pattern (it is interpolated
into a file path, so `../etc` must not survive) and membership in the on-disk listing.
Verified: `{"repo":"../etc"}` is rejected.

**Deliberately NOT accepting a GitHub URL at request time.** Cloning FastAPI is 57 MB and
counting its tokens is ~1,500 API calls taking about a minute; Vercel Hobby caps functions
at 60s. Indexing is inherently an offline job, so exposing it as a request would fail in
production while appearing to work locally.

**Fixed: the countTokens HTTP call was inside `cache_lock`.** That serialised the entire
10-worker pool - ~3,150 requests ran one at a time, which is why a rebuild timed out past
120s. The lock now guards only the dict. httpx rebuild: 53s.

**Self-inflicted, worth recording:** rebuilding httpx without `--tokens` silently
overwrote the counted snapshot with an uncounted one, which makes `/api/pack` refuse
every request. The builder should probably refuse to downgrade a counted snapshot without
an explicit flag. Not fixed; logged.

## 2026-08-19 - correction: "signatures are nearly free" was wrong

Claimed earlier, on estimated token counts, that a whole repo's signatures cost ~8k so
admission was nearly free and only body promotion mattered. Real counts say otherwise:

| | all signatures | median | mean |
|---|---|---|---|
| fastapi | **96,244 tokens** | 20 | ~189 |
| httpx | 14,788 tokens | 14 | ~27 |

The error was using the median on a badly skewed distribution. fastapi takes forty-odd
keyword arguments per function, so a handful of enormous signatures dominate the sum.

So the claim holds for httpx (16k budget really does hold the whole repo's shape) and
fails for fastapi (signatures alone are 3x the largest budget, and selection binds at
every tier). Same tool, opposite behaviour, decided by the API style of the indexed code.
That is the same root cause as the earlier BM25 length-normalisation finding.

Bodies are still an order of magnitude more expensive per symbol, so promotion is still
the interesting decision. But "admission is free" is deleted from the UI and the
submission doc.

Also corrected: `routing.py` is 57,350 real tokens, not the ~64,000 chars/4 estimate.

Em dashes removed from all user-facing prose.
