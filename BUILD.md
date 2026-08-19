# BUILD.md - ContextBudget

This is the authoritative build brief. Follow it in order.

`docs/superpowers/specs/2026-08-17-context-budget-design.md` holds the reasoning
and the measurements behind these choices - read it for context, but this file
is the contract. Where they differ, this file wins.

---

## 0. What you are building, and why

A web app that answers one question: *given a repo and a coding task, what
should you actually feed a model - and what does it cost?*

Pick a pre-indexed repo, type a task in plain English, set a token budget. The
app assembles a context pack under that budget, shows every inclusion and
eviction with its token cost, lets the user pin and evict, then runs an agent on
that exact pack and streams proposed diffs back.

The point of the product is **visibility**. Every AI coding tool decides what
the model sees and shows the user none of it. Here that decision is the entire
interface. Keep that in mind when you have a judgment call: if a change makes
the packing decisions more legible, it's probably right; if it hides them behind
a nicer summary, it's wrong.

Two facts that shape everything:

- FastAPI's `fastapi/` package is roughly 192k tokens. A 32k budget is ~6x
  oversubscribed.
- `fastapi/routing.py` alone is roughly 64k tokens - **twice the largest
  budget, in one file.** So file-level selection cannot work. The unit of
  selection is the symbol.

Both figures are `chars/4` estimates and Milestone 1 replaces them with measured
counts.

---

## 1. Ground rules

**Stack**
- Builder: Python, standard library only. `ast` for parsing. No tree-sitter, no
  third-party parsers. Only dep: `google-genai` for token counting.
- App: TypeScript, Next.js, deployed on Vercel.
- Tests: `node:test` + `node:assert`. No test framework, no fixtures library.
- State: Upstash Redis. No other datastore.

**Scope**
- Build what the current milestone asks for, nothing else.
- Section 7 is a hard out-list. Don't build those, and don't build toward them.
- No abstractions with one implementation. No config for values that never
  change. No error handling for cases that cannot happen.
- If you think this brief is wrong, say so in one line and continue with the
  brief as written. Don't silently redesign.

**Interfaces**
- Section 2's types are frozen. Changing them means the Python and TypeScript
  sides disagree, which is the one failure that costs a whole day. If a change
  is genuinely necessary, stop and say so before writing code.

**Git - do not touch it**
- Do not run `git init`. Do not stage, commit, branch, tag, push, or revert.
- Do not create or modify `.gitignore`, `.git/`, or any git config.
- If a task seems to need a git operation, say so and stop. Don't do it.
- The human owns all version control and will commit the finished work.
- Consequence: `DECISIONS.md` is the only running record of how the build went.
  Keep it current as you work rather than reconstructing it at the end.

**Decisions**
- After any non-obvious choice, append a dated entry to `DECISIONS.md`: what you
  chose, what you rejected, why. One short paragraph, plain facts.
- Include the ones that didn't work. "Tried X, measured Y, reverted" is the most
  valuable kind of entry.

**Prose**
- Write code, tests, and `DECISIONS.md` entries. Do not write README essays,
  architecture narratives, or submission text. A human is writing those in their
  own voice, deliberately.

**Before writing any code**, restate in a few lines: the milestone you're
starting, the files you expect to create, and anything in Section 2 you think is
underspecified. Cheap check that we agree.

---

## 2. Frozen interfaces

The Python builder emits these; the TypeScript packer consumes them.

```ts
type Tier = "signature" | "skeleton" | "full";

type Symbol = {
  id: string;                    // "fastapi/routing.py::APIRouter.add_api_route"
  file: string;                  // "fastapi/routing.py" - relative to vendor/<repo>/
  kind: "module" | "class" | "func" | "method";
  name: string;                  // "add_api_route"
  qualname: string;              // "APIRouter.add_api_route"
  lineStart: number;
  lineEnd: number;
  signature: string;             // "def add_api_route(self, path: str, ...) -> None"
  docFirstLine: string;          // "" when absent
  docRest: string;               // "" when absent
  body: string;                  // source minus signature and docstring

  // Cost of the EXACT rendered string emitted at each tier, separator included.
  // These are authoritative - the packer uses them directly. See §3 on why
  // per-component counts summed together would be wrong.
  tokens: {
    signature: number;           // render(sym, "signature")
    skeleton: number;            // render(sym, "skeleton")
    full: number;                // render(sym, "full")
  };
};
```

**Symbol `id` scheme.** `<file>::<qualname>`, where `file` is relative to
`vendor/<repo>/` and `qualname` is the dot-joined chain of enclosing scopes.

| Case | `id` |
|---|---|
| Module itself | `fastapi/routing.py::<module>` |
| Top-level function | `fastapi/routing.py::get_request_handler` |
| Method | `fastapi/routing.py::APIRouter.add_api_route` |
| Collision (`@overload`, redefinition) | append `#<lineStart>` - deterministic, only on collision |

**Nested functions are not separate symbols.** A closure or inner `def` stays
inside its parent's `body`. Only module-level functions and classes, and their
methods, get records. Inner functions aren't independently retrievable units and
emitting them multiplies the graph for no gain.

```ts

type Edge = {
  from: string;                  // Symbol.id
  to: string;                    // Symbol.id
  kind: "import" | "annotation" | "inheritance" | "call" | "decorator";
  weight: number;                // occurrences collapsed into this row, >= 1
};

type Snapshot = {
  repo: string;                  // "fastapi"
  commit: string;                // short sha of the parsed checkout
  builtAt: string;               // ISO 8601
  totalTokens: number;
  symbols: Symbol[];
  edges: Edge[];
  files: Record<string, string>;  // path -> exact file source. See §5 read_file.
};
```

Request and response shapes:

```ts
type PackRequest = {
  repo: "fastapi" | "httpx";
  task: string;
  budget: 4000 | 8000 | 16000 | 32000;
  pins?: string[];               // Symbol.id - admitted at "full", never evicted
  evicts?: string[];             // Symbol.id - never admitted
};

type PackedSymbol = {
  id: string;
  tier: Tier;
  tokens: number;                // cost at the admitted tier
  reason: string;                // "bm25" | "graph:<hops> from <id>" | "pinned"
};

type PackResponse = {
  selected: PackedSymbol[];
  evicted: { id: string; tokens: number; reason: string }[];
  totals: { signature: number; doc: number; body: number; total: number };
  budget: number;
};

// The client sends back only ids and tiers. The server renders the pack text
// from the snapshot. See Section 5 for why.
type StepRequest = {
  repo: "fastapi" | "httpx";
  selection: { id: string; tier: Tier }[];
  messages: unknown[];           // conversation so far, including tool_results
};
```

---

## 3. Milestone 1 - snapshot builder

**Prerequisite:** `bash scripts/fetch_repos.sh` - shallow-clones both repos into
`vendor/` and writes `snapshots/ATTRIBUTION.md`. `vendor/` is already gitignored;
57 MB of upstream source does not belong in this repo. Run it if `vendor/` is
empty. This is the one script that runs `git clone`, and it is not a version
control operation on this repo - §1's git prohibition does not block it.

**File:** `scripts/build_snapshot.py`
**Input:** `vendor/fastapi`, `vendor/httpx`
**Output:** `snapshots/fastapi.json`, `snapshots/httpx.json`

Parse only the package directory (`vendor/fastapi/fastapi/`,
`vendor/httpx/httpx/`) - not tests, docs, or examples. That's 912 KB and 328 KB
respectively, versus 57 MB for the full FastAPI checkout.

**Symbols.** One record per module, class, function, and method, per Section 2.
Split each symbol into signature / first docstring line / rest of docstring /
body, because those are priced and admitted independently.

**Two extraction rules that were both got wrong once - verify them explicitly.**

*`docFirstLine` must be the first NON-EMPTY line.* Python docstrings commonly open on
the line after the quotes, so `get_docstring(...).split("\n")[0]` yields `""`. Measured
failure: 98% of fastapi and 100% of httpx symbols ended up with an empty `docFirstLine`
while `docRest` was populated - which silently made the `skeleton` tier identical to
`signature` (median difference: 0 tokens), killed the meter's doc band, and stripped all
docstring signal out of BM25, which indexes `docFirstLine`. Use
`ast.get_docstring(node, clean=True)`, then the first line with content.

*A class's `body` must EXCLUDE its methods.* Methods are separate symbols, so leaving
them inside the class body duplicates every one of them. Measured: 200/200 fastapi
methods and 369/369 httpx methods appeared twice, inflating `totalTokens` to 296,268
against ~192k of actual source. In a pack this is a correctness bug, not just a
reporting one - admitting a class at `full` alongside its methods at `full` sends the
same source to the model twice and charges the budget twice. A class body should carry
class-level code only: its docstring and attributes.

Self-check both: assert `docFirstLine` is non-empty for a symbol known to have a
docstring, and assert no method's `def <name>` appears in its parent class's `body`.

**Token counts.** Use Gemini's `countTokens` endpoint with
`model: "gemini-3.6-flash"` (response field is `totalTokens`) - the tokenizer is model-specific and packs are consumed
by that model, so counting against anything else produces numbers that don't
describe the real cost. `countTokens` is free and does not consume TPM quota, which is
why the whole product can run at zero cost.

Do not use `tiktoken` or any character-count heuristic. `tiktoken` is OpenAI's
tokenizer; it undercounts Claude by 15-20% and worse on code. This product is a
token meter - a wrong tokenizer would be its most embarrassing possible bug.

**Count rendered tier strings, not components.** Tokenization is not additive:
`count(a) + count(b) != count(a + b)`, because tokens merge across string
boundaries. So counting `signature`, `docFirstLine`, `docRest`, and `body`
separately and summing them to get a tier cost drifts from the real cost - and
the budget invariant would then be asserting on a number that isn't the token
count, passing green while the emitted pack overruns.

Instead: for each symbol, render the exact string that will be emitted at each
tier - **including the trailing separator between symbols** - and count that.
Three counts per symbol. Making each counted unit self-contained means per-symbol
counts sum to very nearly the true pack total, which is what keeps the invariant
honest.

The UI's signature / docstring / body breakdown is derived by subtraction from
those three numbers and displayed as approximate. Don't spend calls on it.

Counting happens here, at build time, so the request path makes zero
token-counting calls. Cache by content hash - there are a few thousand symbols
and you will re-run this many times. `count_tokens` isn't billed as inference,
but it is rate-limited, so an uncached re-run is slow rather than expensive.

**If no API credentials are available**, two modes:

`--no-tokens` - emit structure with `tokens: null`, `tokensCounted: false`. The packer
refuses. Use when you want nothing downstream to run.

`--estimate` - emit `chars/4` counts, `tokensCounted: true`, **and
`tokenSource: "estimate"`**. This unblocks the packer and the whole UI without a key.
It is not trap #2, because trap #2 is an estimate that *silently* becomes the displayed
number, and this one cannot be silent:

- The snapshot carries `tokenSource: "estimate" | "count_tokens"`.
- `/api/pack` returns `tokenSource` in every response.
- The UI renders a loud `ESTIMATED TOKENS` badge whenever it isn't `count_tokens`, next
  to the meter, not buried in a footer.
- **`/api/step` refuses to execute against an estimated snapshot.** The agent loop never
  runs on approximate numbers - only the UI preview does. That's the boundary that makes
  this safe.
- The budget-invariant test stays skipped. It needs real counts and an estimate cannot
  satisfy it.

Swap to `--tokens` the moment a key exists, and record both figures - the estimate
versus the measured count - in `DECISIONS.md`. That comparison is itself a useful
number.

**Edges.** All five kinds:

| Kind | Source | Measured yield |
|---|---|---|
| `import` | **Three forms, all required:** relative `from .x import y`; **absolute self-import `from <pkg>.x import y`**; and plain `import <pkg>.x` | fastapi leans almost entirely on the absolute form (92 stmts / 181 names) while httpx is almost entirely relative (204 names). Handling only one form silently guts one repo |
| `call` | call sites by name: resolve against module-local defs first, then imported names. Noisy; accept it | fastapi 261, httpx 281 - the workhorse on fastapi |
| `annotation` | parameter and return annotations | **httpx 312, fastapi ~63.** Strong on httpx, which annotates with its own types; weak on fastapi, whose annotations are overwhelmingly `typing`, builtins, and starlette (`Scope`, `Receive`). ~8% of fastapi's 786 annotation expressions resolve in-package. This is correct, not a bug |
| `inheritance` | `class Foo(Bar)` base clauses | fastapi 54, httpx 56 |
| `decorator` | decorator names | **fastapi 0, httpx 3 - and 0 is correct.** All 47 of fastapi's decorator applications are `dataclass`, `property`, `classmethod`, `lru_cache`, `wraps` etc. - every one external, nothing in-package to point at. `@app.get` appears in FastAPI's *docs and user code*, never in its own source. Keep the edge kind, expect ~nothing from it, don't debug it |

Measured yields are from the real snapshots. If a number moves a lot, something
changed - investigate before assuming the new number is better.

**The re-export trap.** httpx re-exports its whole public surface through
`__init__.py`. Naive resolution points every edge at that one file and the graph
collapses into a hub with no useful structure. Resolution must follow re-export
chains through to the *defining* module.

**No churn signal.** An earlier draft ranked partly on per-file commit-touch
count. It's cut: it needs deep git history (the clones are `--depth 1`), it was
the weakest of three signals, and with the evaluation out of scope there is no
way to measure whether it helps. An unmeasurable ranking signal is decoration.
Don't add it back. Already logged in `DECISIONS.md`.

**Edge rows are unique; repetition becomes `weight`.** Exactly one row per
`(from, to, kind)`. When the same relationship is observed N times - five call
sites from `A` to `B` - that is `weight: 5`, not five rows. Repeated rows
double-count during graph expansion and silently skew Milestone 2's ranking;
a weight keeps the signal and makes it usable.

**No self-loops.** Drop any edge where `from == to`. A symbol pointing at itself
burns an expansion hop reaching something already in the pack.

**Self-check.** A `--self-check` flag that asserts all of the following and exits
non-zero on any failure:

1. An edge into an httpx symbol resolves to its defining module, not to
   `httpx/__init__.py` (the re-export trap).
2. An import edge exists from `fastapi/routing.py::<module>` to
   `fastapi/encoders.py::jsonable_encoder`, and fastapi import edges exceed 150
   (guard on the absolute-self-import bug: 56 before the fix, 197 after).
3. Every `edge.from` and `edge.to` resolves to a real symbol id.
4. **Zero self-loops and zero duplicate `(from, to, kind)` rows.**

These live in the builder rather than a test file because they guard the
builder's own invariants; a separate test module would be scaffolding.

**Done when:**
```
python scripts/build_snapshot.py --self-check
```
passes for both repos, and prints per repo: total token count, symbol count,
edge count by kind, and the top 5 files by token weight.

Report those numbers back. The estimates in Section 0 are `chars/4` guesses and
I want to know how far off they were - that comparison is a `DECISIONS.md` entry.

---

## 4. Milestone 2 - packer and its tests

**Files:** `lib/pack.ts`, `tests/pack.test.ts`

**Ranking**, two stacked signals:

1. **BM25, field-weighted - not one flat bag of text.** Score `name` and
   `signature + docFirstLine` as **separate fields with their own length
   normalisation**, then combine: `3 * bm25(name) + 1 * bm25(signature+doc)`.

   Concatenating them into one document breaks retrieval on fastapi. Measured:
   fastapi's median indexed length is 12 words, but `FastAPI.__init__` is 2936
   words and `FastAPI.get` / `.put` / `.post` / `.delete` are 1413 each - because
   FastAPI's API is keyword-argument-heavy. Signatures are 79% of indexed text, and
   62 of 510 symbols exceed 100 words. BM25's length normalisation then penalises
   the most important symbols in the repo by roughly 20×: `add_api_route` (164
   words) lost to `add_api_websocket_route` (26 words) on the query "add api route",
   ranking #6 while the superset name took #1 and #2.

   httpx has **zero** symbols over 100 words, so it shows none of this. Same
   config, opposite behaviour, purely from API design style - which is why this has
   to be measured per repo rather than assumed.

   Weighting `name` highest is also just correct: it's the highest-signal field and
   it's short, so it carries no length pathology.

   **Identifiers must be split, or this signal does not work.** Python is
   snake_case and users type English. A tokenizer that treats `_` as a word
   character makes `solve_dependencies` a single token, which the task
   "solve dependencies" can never match. Measured on the real snapshot, that
   tokenizer returns confidently wrong top hits: "add api route" ranked
   `build_middleware_stack` first and did not surface `add_api_route` at all,
   while "add_api_route" ranked it correctly at 6.88.

   Index **both the whole identifier and its parts**: `solve_dependencies` →
   `["solve_dependencies", "solve", "dependencies"]`, `APIRouter` →
   `["apirouter", "api", "router"]`. Split on `_`, on camelCase boundaries, and on
   digit boundaries. Keeping the whole token preserves exact-query ranking; adding
   the parts is what makes natural-language tasks work at all.
2. **Graph expansion** - hops out from the BM25 seeds. This is the feature that
   justifies the project: BM25 finds the symbol that *mentions* the concept,
   expansion finds the interface a few hops away that you must not break and that
   mentions it nowhere.

   **Use `edge.weight` AND the seed's score.** Contribution must be
   `seed_score * decay^hops * log(1 + weight)` - all three factors. Logarithmic on
   weight so a weight-7 edge beats weight-1 without a 7× landslide.

   The `seed_score` factor is load-bearing, not decoration. Drop it and every
   graph-discovered symbol is scored purely by hop count and edge weight, so a
   symbol adjacent to a 7.18-scoring seed ranks identically to one adjacent to a
   0.9-scoring seed. Measured consequence of omitting it: contributions saturate
   at ~0.7–0.8 regardless of depth (~10% of top BM25), hundreds of symbols land in
   a tied band, and which ones survive the budget cut becomes arbitrary.

   This means `graphContributions` must take seeds as `[id, score][]`, not
   `string[]`. A `string[]` signature makes the specified formula impossible.

   **Hop depth is a measurement - but "reached the most symbols" is the wrong
   criterion.** Reaching 252 of fastapi's 510 symbols is a dragnet, not retrieval;
   the product exists to *drop* things. Depth must be chosen on whether the extra
   symbols are ranked *distinguishably*, not on how many there are.

   Only decide depth after the tokenizer and `seed_score` are fixed - both reshape
   the score landscape, so any depth chosen before them is chosen on noise. Then
   ask: at each depth, do the newly reached symbols actually get **admitted** to
   the pack at realistic budgets, and does the score spread among them stay wide
   enough to rank? If depth 3's additions never clear the budget, depth 3 is wasted
   compute - use 2.

No embeddings, and no churn signal (see Milestone 1). Not a simplification to revisit - they add a bill, a dependency,
and a store, and expansion is the part that actually beats naive retrieval.

3. **Combine the two signals by RANK, not by raw score.** BM25 scores and graph
   contributions live on different scales - BM25 reaches ~13 on these repos, graph
   contributions far less. `max(bm25, graph)` therefore lets any weak lexical match
   outrank every graph-discovered symbol, so expansion cannot reach the top of the
   ranking by construction. Measured: expansion is **exactly neutral at r@20** in
   every configuration while helping at r@50 - and an 8k budget never admits 50
   symbols, so the lift lands where the product can't use it.

   **Resolved by measurement: `max()` wins, RRF was tried and rejected.** RRF
   (`Σ 1/(60 + rank)`) regressed r@20 from 0.748 to 0.607 - it lets graph-discovered
   symbols crowd out stronger lexical matches at the top. Under `max()`, expansion is
   neutral at r@20 and **positive at r@50** (overall 0.75 → 0.83; httpx 0.62 → 0.73).
   Keep `max()`. Do not revisit fusion without a new hypothesis and an eval run.

   A weighted fusion (BM25 weighted above graph) is the obvious untried variant.
   Left deliberately untried - name it as future work rather than burning the
   remaining time tuning toward a nicer number.

### What the budget is actually spent on

Measured, and it reframes the product. Median **skeleton-tier** cost is 16 tokens on
fastapi and 11 on httpx. So:

| budget | fastapi symbols admitted at skeleton | httpx |
|---|---|---|
| 4k | ~350 of 510 | ~420 of 544 |
| 8k | ~440 | ~516 |
| 16k | ~466 | 544 (all) |

**The whole repo's shape fits in roughly 8–16k tokens.** Admission is therefore nearly
free; the scarce resource is **promotion to `full`**. One full body for
`routing.py::APIRouter.add_api_route` costs several hundred tokens - more than a
hundred skeletons.

So the packer's real question is not "which symbols make the cut" but "which handful of
bodies can you afford to read." Build the UI and the meter around that: the eviction
list matters far less than the promotion list, and the interesting scarcity is bodies.

(Costs are `chars/4` estimates - real `count_tokens` figures will shift them, but not
by the order of magnitude that would change this conclusion.)

**Admission.** Three tiers at increasing cost:

| Tier | Contents |
|---|---|
| `signature` | signature only |
| `skeleton` | signature + `docFirstLine` |
| `full` | signature + full docstring + body |

Greedy fill by `score / tokens`, promoting high scorers toward `full` while
budget remains. Pins are admitted at `full` first and never evicted. Evicts are
never admitted. Every eviction records a reason - the eviction list is a
displayed feature, not a byproduct.

**Pack to `budget * 0.98`, not `budget`.** Per-symbol counts include their
separator (§3), so summed counts land very close to the true total - but not
exactly, because tokens can still merge at joins. A 2% reserve absorbs that.
Test 1 below measures the real drift; once you have a number, tune the reserve to
it and record the measurement in `DECISIONS.md`. Don't leave it a guess.

Docstring truncation is the cheapest lever available: `routing.py` is 42%
docstring and comment, `param_functions.py` is 55%. Dropping to `docFirstLine`
cuts ~40% off FastAPI's largest file before a single relevance decision is made.
Keep the tier boundary exactly where Section 2 puts it.

**Tests** - `tests/pack.test.ts`, `node:test` + `node:assert`:

1. **Budget invariant.** For all four budgets across both repos: assemble the
   pack, then call `count_tokens` on **the fully rendered pack string** and assert
   the result ≤ budget. Not the sum of per-symbol counts - the actual count of the
   actual string. Summed counts are what the packer optimizes against; this test
   exists to prove those sums don't lie. Print the drift (summed vs actual) so the
   §4 reserve can be set from a measurement.

   This is the one test that must never break, and it is the only place an API
   call in a test is justified.
2. **Pin honoured.** A pinned symbol appears at `full` even when it loses on
   score.
3. **Evict honoured.** An evicted symbol appears nowhere in the output.
4. **Expansion earns its place.** On a fixed task, assert BM25-only misses a
   specific symbol that expansion includes. If this test ever stops holding, the
   project's central claim is dead and the failure should say so in plain words.

**Done when:** `node --test` passes, and a script prints the pack for
`"add per-route rate limiting"` on FastAPI at all four budgets with totals under
budget.

---

## 4.5. Milestone 2.5 - the hand-labelled eval

**Files:** `eval/tasks.json`, `eval/score.ts`

Every ranking decision so far has been a guess that the next bugfix invalidated.
Hop depth has been chosen three times on three different score landscapes, none
against ground truth. Three real bugs - the underscore tokenizer, the dropped
`seed_score`, the BM25 length bias - were all found by ad-hoc measurement rather
than by a test. That stops here.

**`eval/tasks.json`** - 10 tasks, 5 per repo:

```jsonc
[{
  "repo": "fastapi",
  "task": "add per-route rate limiting",      // natural language, as a user types
  "expect": [                                  // 2-5 symbol ids
    "fastapi/routing.py::APIRouter.add_api_route",
    "fastapi/routing.py::APIRoute"
  ],
  "why": "one line: why these are the symbols you'd need"
}]
```

**Derive the labels by reading the code - never by running the packer.** Use file
reads, grep, and git history to decide what a competent engineer would need. If the
labels come from `pack()` or `bm25Scores()` output, the eval measures the retriever
against itself and is worth nothing. This is the single rule that makes it valid.

**`eval/score.ts`** - reports **recall@k on ranked order** (k = 20 and 50), per task
and averaged, for three configurations: BM25 only, BM25 + graph expansion, and
expansion at each hop depth.

Score on **ranking, not budget**. `recall@budget` needs token counts and every
snapshot is `tokensCounted: false`, so it cannot run yet. Ranking recall needs no
tokens. Leave a clearly marked `recall@budget` path that activates once a key
exists.

**Done when:** `node eval/score.ts` prints a table, and the numbers either justify
`maxHops: 2` or change it. Log whichever happens.

---

## 5. Milestone 3 - API routes

**Files:** `app/api/pack/route.ts`, `app/api/step/route.ts`, `app/api/tool/route.ts`

The **browser drives the agent loop**. Each route handles one short unit of work
and returns. Three reasons, in order: a full server-side loop can exceed
Vercel's function timeout while one turn never does; interrupt becomes "the
browser stops calling"; and pin/evict becomes "the next request body differs",
with no server session to reconcile.

- `POST /api/pack` - `PackRequest` → `PackResponse`.
- `POST /api/step` - `StepRequest` → SSE stream of one agent turn. Returns any
  `tool_use` blocks to the client.
- `POST /api/tool` - executes one read-only tool against the snapshot.

Tools available to the agent: `read_symbol(id)`, `read_file(path, range?)`,
`list_symbols(file)`. Read-only. No writes, no shell, no network.

**`read_file` must be served from the snapshot, not from `vendor/`.** `vendor/` is
gitignored and never deployed (§3), so a disk-backed `read_file` works locally and
404s on every call in production. Shipping a tool that always fails is worse than
omitting it - the model will call it, fail, retry, and burn turns discovering that.

**Serve it from `snapshot.files[path]`, which stores the exact source.** An earlier
version of this brief said to reconstruct file content by concatenating a file's
symbols. That was wrong and was measured to fail two ways at once on
`httpx/_auth.py`:

- **Lossy** - imports and module-level code sit outside any function or class symbol,
  so they disappear. `import typing` and `from ._models import` were both absent. An
  agent that can't see the imports may propose adding one that already exists, and
  this product's output is diffs.
- **Duplicative** - 160% of the real length (18,992 vs 11,907 chars), because a class
  symbol's `body` contains its methods *and* each method is separately a symbol.

Storing raw text costs ~1.1 MB (committed snapshots go ~2.13 MB → ~3.26 MB), which is
nothing for Vercel, and it's exact - which a diff-producing tool needs. Getting
concatenation right is fiddlier than storing the text.

Keep validating `path` against snapshot keys exactly as now - that's what makes
traversal structurally impossible rather than filtered.

**Provider: Google Gemini free tier.** Chosen because it is the only free tier whose
per-minute token allowance is larger than this product's own context pack:

| provider free tier | TPM | fits a 32k pack? |
|---|---|---|
| **Gemini** | **250,000** | yes, with room for multi-turn history |
| Groq | 6,000 | no - one 8k pack exceeds the whole minute |
| Anthropic | none (paid only) | n/a |

**Use `gemini-3.6-flash`. Verified working against a real key on 2026-08-18.**

Do not use `gemini-2.5-flash` - it returns 404 `"no longer available to new users"`
even though it still appears in the `models` listing, so the listing is not an
availability signal. Do not use the `gemini-flash-latest` alias either; it returned
503 `"high demand"`. Pin an explicit version.

1,048,576 input token limit, 65,536 output - the 32k pack is not remotely near the
ceiling.

**Model configuration**, server-side and not client-settable:

```ts
{
  model: "gemini-3.6-flash",
  generationConfig: { maxOutputTokens: 8192 },
}
```

Stream the turn. Gemini's free tier does not give the ~0.1x cached-prefix economics
Anthropic does, so multi-turn resends the pack at full token cost - fine at 250k TPM,
but it means the run's TPM footprint grows with turn count. Track it.

**Honest tradeoff to state in the write-up:** `gemini-2.5-flash` produces weaker code
diffs than a frontier model. The pack is the product here and the agent is the consumer,
so this is acceptable - but say so rather than letting a reviewer assume otherwise. The
pack format is provider-agnostic; swapping the consumer is a config change.

### Trust boundary - do not simplify any of this

`/api/step` is a public endpoint holding an API key that bills a real card.
Treat every field as hostile.

- **Server pins `model`, `max_tokens`, and `effort`.** A client-settable
  `max_tokens` is a direct spend-injection vector.
- **The client sends symbol ids and tiers, never pack text.** The server renders
  the pack from the snapshot. This is why `StepRequest` looks the way it does:
  if the client supplied the text, the system block would be an arbitrary-content
  injection surface. Validate every id against the snapshot and reject unknown
  ids rather than skipping them.
- **Cap request body size**, and check total prompt size with `count_tokens`
  against a ceiling before any API call.
- **Validate tool arguments against snapshot keys.** Lookups are JSON-key based
  so path traversal doesn't apply, but reject unknown keys explicitly.

### Spend cap - three layers

| Layer | Mechanism |
|---|---|
| Per response | `maxOutputTokens: 8192`, enforced by the API |
| Per visitor | 3 runs per IP per 24h, Upstash counter |
| Provider quota | Gemini free tier is **org-wide**: 250k TPM, 10 RPM, 250 RPD |

The third layer is the one that actually bites on a free tier. Quota is shared across
every visitor, so two reviewers clicking at once will 429 each other - which makes the
**replay fallback mandatory, not optional**. On a 429, play back a recorded run and label
it as a replay. There is no dollar ceiling to enforce because there is no dollar cost.

**Cost is a PROJECTION, not a bill.** The demo runs on Gemini's free tier, so actual
spend is $0. Do not display $0 - that throws away the product's whole point. Instead,
price the pack against published rates for several models and show what it *would* cost:

| model | $/MTok in | $/MTok out |
|---|---|---|
| claude-opus-5 | 5 | 25 |
| claude-sonnet-5 | 3 | 15 |
| gemini-2.5-flash (free tier) | 0 | 0 |

**Read `thoughtsTokenCount` or you will undercount by an order of magnitude.**
`gemini-3.6-flash` reasons by default and bills thinking as output. Measured on a
one-word reply: `promptTokenCount: 6`, `candidatesTokenCount: 1`,
**`thoughtsTokenCount: 92`**, `totalTokenCount: 99`. Thinking was 93% of the turn.

So output tokens = `candidatesTokenCount + thoughtsTokenCount`. Summing only
`candidatesTokenCount` is the same class of bug as summing Anthropic's uncached
`input_tokens` - it silently reports a fraction of the truth. Prefer `totalTokenCount`
as the cross-check: it should equal prompt + candidates + thoughts. A cost *model* across providers is a better artifact than one
invoice, and it makes the provider choice a footnote rather than a limitation.

**Do not use the Task Budgets beta for this.** It looks like the right tool and
isn't: it's advisory (the model sees a countdown and paces itself, nothing stops
it) and its minimum is 20,000 tokens, above the per-run budget. Wrong instrument
for a hard dollar ceiling. This is already a `DECISIONS.md` entry - don't
re-litigate it in code.

Over the cap → serve a recorded replay rather than an error, so the demo
degrades instead of breaking.

**Done when:** all three routes work end to end from `curl`; the pack total is
under budget for every budget on both repos; and a scripted run that exceeds the
global cap falls back to replay instead of erroring.

---

## 6. Milestone 4 - UI, replay, deploy

**Two panels, one screen.** No routing, no nav, no settings page.

**Left - context.** Budget slider (4k/8k/16k/32k). Token meter broken down by
**signature / docstring / body**, because that breakdown is where the
compression actually comes from and hiding it defeats the product. Symbol rows
grouped by file, each showing tier, token cost, and its `reason`. Eviction list
with reasons. Pin, evict, expand. Changing a pin re-packs and shows the delta.

**Right - run.** Streamed agent output: plan, then per-file proposed diffs. Live
cost readout in dollars. Interrupt button.

**Replay.** Every live run streams to Redis as it executes. When the cap trips or
the API errors, play back a real prior run for the same repo and task. The
library grows itself, so there are no fixtures to author.

Label replays visibly as replays. Presenting a recording as a live run is the one
genuinely dishonest thing this project could do.

**Deploy.** Vercel. Environment: `ANTHROPIC_API_KEY`, Upstash URL and token.
Snapshots are committed to the repo, so there is no build-time indexing step.

**Done when:** the deployed URL runs a full task end to end on both repos, cost
readout is non-zero and matches the layered accounting above, interrupt works
mid-run, and pin/evict visibly changes the pack.

---

## 7. Out of scope

Do not build these. They are deliberate cuts, documented as such.

- Recall evaluation against **PR-mined** ground truth (the automated version - a
  hand-labelled 10-task set is now **in** scope, see Milestone 2.5)
- Arbitrary repo URLs or any live indexing
- Embeddings-based ranking, vector stores
- Churn / git-history ranking signals
- Committing `vendor/` - snapshots only
- Any language other than Python
- Applying edits to the indexed repos, writing to `vendor/`
- Any git operation at all (see §1), including `git init` and `.gitignore` edits
- PR creation
- Auth, accounts, multi-user, persistence beyond the replay log
- Any language other than TypeScript in the app, or Python in the builder
- A settings page, a theme switcher, or a landing page

If a milestone seems to need something on this list, say so instead of building
it.

---

## 8. Traps, collected

Each of these has cost someone a day somewhere.

1. **File-level selection.** `routing.py` is ~64k tokens, twice the largest
   budget. Symbol-level or the product cannot represent FastAPI at all.
2. **`tiktoken` or `chars/4` for token counts.** Wrong tokenizer, wrong numbers,
   in the one product where the numbers are the whole point.
3. **`__init__.py` re-exports.** Unresolved, the httpx graph becomes a hub and
   expansion returns noise.
4. **Summing `input_tokens` for cost.** It's the uncached remainder. Undercounts
   by most of the prompt once caching works, and silently breaks the spend cap.
5. **Client-settable `max_tokens` or client-supplied pack text.** Spend
   injection and prompt injection respectively.
6. **Server-side agent loop.** Exceeds the Vercel function timeout on real tasks
   and makes interrupt hard for no benefit.
7. **Schema drift.** Changing Section 2 mid-build desynchronizes the Python and
   TypeScript sides. Stop and say so first.
