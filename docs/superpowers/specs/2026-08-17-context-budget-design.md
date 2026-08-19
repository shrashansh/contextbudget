# ContextBudget — Design Spec

**Date:** 2026-08-17
**For:** Superbrain "Founding AI Engineer III" take-home
**Constraint:** 2–3 days build time, deployed on Vercel, public GitHub repo

> **This document holds rationale and measurements.** The implementation
> contract — frozen interfaces, milestones, acceptance checks, security
> requirements — lives in [`BUILD.md`](../../../BUILD.md), which is what gets fed
> to the coding agent. Where the two differ on an implementation detail,
> `BUILD.md` wins. Keeping the contract in one place avoids drift between them.

---

## 1. What this is and why

**ContextBudget** is a web app that answers one question: *given a repo and a coding task, what should you actually feed the model — and what does it cost?*

Paste-free flow: pick a pre-indexed repo, type a task in plain English, set a token budget. The app assembles a context pack under that budget, shows you every inclusion and eviction decision with its token cost, lets you pin and evict, then runs an agent on that exact pack and streams its proposed diffs back.

### Why this, and not a quiz app

The assignment offers three example projects (live quiz, FPV game, real-time collaborative app). All three are real-time state-sync problems, which is a signal — but none of them demonstrate anything about working on a context engine.

Superbrain has three parts: an IDE, an agent harness, and a context engine claiming a 60–80% token cut with full repo awareness. Section 1 of the assignment asks me to understand the product. Section 2 asks me to build something. Treating those as independent is the obvious reading; making the build *answer* section 1 is the better one.

So: build a small, honest version of the hardest part of their stack, and make the thing that's invisible in every AI IDE — what the model was actually given — the entire product surface.

This also makes my section 3A answer a working prototype rather than a suggestion.

### Non-goal

This is not a claim to have rebuilt their engine in three days. It's a deliberately scoped instrument for reasoning about the problem, with its limitations stated. The value is the reasoning and the measurements, not the completeness.

---

## 2. Target repos, measured

Chosen for token weight and structural shape, not popularity.

| Repo | Files | LOC | Est. tokens (`chars/4`) |
|---|---|---|---|
| FastAPI (`fastapi/`) | 48 | 21,048 | ~192k |
| httpx (`httpx/`) | 23 | 8,827 | ~71k |

Token figures are estimates. Real counts come from `messages.count_tokens` at snapshot-build time, and for code they will likely run **higher** than `chars/4`, not lower.

FastAPI is **6× oversubscribed against a 32k budget.** The premise is not a close call.

### Three measurements that drove the design

**Measurement 1 — one file exceeds the whole budget.**

| File | Est. tokens |
|---|---|
| `fastapi/routing.py` | ~64k |
| `fastapi/applications.py` | ~46k |
| `fastapi/param_functions.py` | ~17k |

`routing.py` alone is **twice the largest budget offered (32k)**. A file-granular packer can therefore never include the single most relevant file in the repo — it is structurally incapable of representing FastAPI at any budget.

→ **The unit of selection is the symbol, not the file.** Hard requirement.

**Measurement 2 — FastAPI's bulk is prose, not logic.**

| File | Docstring + comment share |
|---|---|
| `fastapi/routing.py` | 41.9% |
| `fastapi/param_functions.py` | 55.4% |
| `httpx/_client.py` | 20.1% |

Keeping only the first line of each docstring cuts ~40% off FastAPI's largest file *before a single relevance decision is made*.

→ Docstring truncation is a first-class, separately controllable lever.

**Measurement 3 — the two repos exercise opposite halves of the engine.**

- **FastAPI**: few enormous prose-heavy files → tests *intra-file* compression.
- **httpx**: 23 small dense files, clean layering → tests *cross-file* graph expansion.

Two repos that told the same story would be wasted work. These don't.

### Rejected repos

React, TypeScript compiler, Django, anything with a `packages/` directory (monorepo build noise, multiple grammars, generated files). VS Code itself is also excluded — auditing a context engine against the codebase they forked is a distraction, not a flex.

---

## 3. Architecture

### The browser drives the agent loop

```
browser (owns message history + loop control)
   │
   ├── POST /api/pack   → build context pack under budget        (short, cacheable)
   ├── POST /api/step   → ONE agent turn, SSE-streamed           (short)
   └── POST /api/tool   → execute a read-only tool vs snapshot   (short)
```

Three reasons, in priority order:

1. **Vercel function timeouts.** A full server-side agent loop can exceed the limit on a non-trivial task. One turn per invocation never does.
2. **Interrupt costs nothing.** The browser stops calling `/api/step`. No cancellation tokens, no server-side session state, no orphaned work.
3. **Pin/evict costs nothing.** A modified pack goes in the next `/api/step` body. There is no server state to reconcile.

The Anthropic key stays server-side. The browser never talks to the API directly.

### Snapshots are built offline and committed

Each repo is parsed once, offline, into a committed JSON snapshot. No GitHub API at request time, no cold-start indexing, no rate limits, no tree-sitter WASM in the request path.

```
snapshots/
  fastapi.json   { symbols[], edges[], files{}, tokenCounts{} }
  httpx.json
```

The snapshot builder is a local script, not a deployed route. This is the single largest laziness win in the design: the expensive, slow, dependency-heavy work happens on my machine and ships as data.

### Language split — stated explicitly

| Component | Language | Why |
|---|---|---|
| Snapshot builder (`scripts/build_snapshot.py`) | **Python**, stdlib `ast` | Offline. See below. |
| Packer (`lib/pack.ts`) | **TypeScript** | Runs inside `/api/pack` |
| Routes + UI | TypeScript / Next.js | Vercel |

**Parsing with Python's stdlib `ast`, not tree-sitter.** tree-sitter's advantage is being language-agnostic — and multi-language is cut (§8). For Python-only parsing, `ast` is stdlib, exact, zero-dependency, needs no WASM binary and no query language. It is both the lazier and the more correct choice once the multi-language requirement is gone. tree-sitter becomes the upgrade path the day a second language matters, not the default. Logged as a decision.

---

## 4. The context engine

### Symbol extraction

Python stdlib `ast` → one record per top-level symbol (module, class, method, function):

```ts
type Symbol = {
  id: string            // "fastapi/routing.py::APIRouter.add_api_route"
  file: string
  kind: "class" | "func" | "method" | "module"
  signature: string     // def add_api_route(self, path: str, endpoint: Callable, ...) -> None
  docFirstLine: string
  body: string
  tokens: { signature: number; docFirstLine: number; docRest: number; body: number }
}
```

Token counts per component, measured with `messages.count_tokens` at build time. Zero token-counting API calls at request time.

### Graph edges

Python's graph is mushier than TypeScript's. Four edge sources, all syntactically recoverable, and both chosen repos are unusually favourable:

| Edge | Source | Note |
|---|---|---|
| import | `from x import y`, `import x` | Both repos use `from`-style consistently |
| annotation | `def f(x: Request) -> Response` | **Strongest signal here.** FastAPI's entire premise is type annotations |
| inheritance | `class Foo(Bar)` | Reliable from syntax alone |
| call | name-based, resolved locally then via imports | Weakest; accept the noise |
| decorator | `@app.get`, `@property` | Loud task signal in FastAPI specifically |

**Known trap: `__init__.py` re-exports.** httpx re-exports its whole public surface through `__init__.py`. Naive resolution points every edge at that one file and the graph collapses into a useless hub. Resolution must follow re-export chains to the *defining* module. This is explicitly tested.

### Ranking

Three stacked signals. No embeddings.

1. **BM25** over symbol name + signature + `docFirstLine`.
2. **Graph expansion** — 1–2 hops from the BM25 seeds. This is the differentiator: BM25 finds the file that *mentions* the concept; graph expansion finds the interface three hops away that you must not break, which mentions it nowhere.
**Dropping embeddings is deliberate.** It removes a dependency, an API bill, and a vector store, and graph expansion is the part that actually beats naive retrieval. Recorded in the decision log with that reasoning.

**Churn was also cut.** An earlier draft added a third signal: per-file commit-touch count, on the theory that files changed often get changed again. It needed deep git history (clones are `--depth 1`, and FastAPI's full checkout is 57 MB), it was the weakest of the three signals, and with the evaluation out of scope there was no way to measure whether it helped. Shipping an unmeasurable ranking signal is decoration. Cut, with the deep-clone complexity it was driving.

### The packer

Knapsack under the token budget. Each symbol has three admission tiers at increasing cost:

| Tier | Contents | Typical cost |
|---|---|---|
| `signature` | signature only | ~15–40 tok |
| `skeleton` | signature + `docFirstLine` | ~30–80 tok |
| `full` | signature + full doc + body | 100s–1000s |

Greedy fill by `score / tokens`, promoting high-scorers to `full` only while budget remains. Pins are admitted at `full` before anything else and are never evicted. Evictions are recorded with their reason so the UI can display them — the eviction list is a feature, not a byproduct.

**Invariant: the emitted pack never exceeds the budget.** Tested.

---

## 5. Model and API

| Setting | Value | Why |
|---|---|---|
| Model | `claude-opus-5` | Default tier; demo quality *is* the deliverable |
| Thinking | adaptive (on by default on Opus 5) | Omitting the field runs adaptive on this model |
| Effort | `output_config: { effort: "high" }` | |
| Streaming | `client.messages.stream()` | Required at this `max_tokens`; also the UX |
| `max_tokens` | 16000 | Hard per-response ceiling |

Pricing: **$5 / $25 per MTok** (input / output).

### Prompt caching

`cache_control` on the last system block, which carries the context pack. The pack is stable across turns within a run, so turns 2..n read it at ~0.1×. Opus 5's minimum cacheable prefix is **512 tokens**, so even a 4k-budget pack caches.

Estimated cost per run: ~40k input + ~6k output ≈ **$0.35 uncached, ~$0.12 with cache reads.** 100 reviewer runs ≈ $15–35.

### Token counting

`messages.count_tokens`. **Not `tiktoken`** — it is OpenAI's tokenizer, undercounts Claude by 15–20%, and worse on code. The entire product is a token meter; using the wrong tokenizer would be its most embarrassing possible bug.

### Cost accounting — the subtle part

`usage.input_tokens` is the **uncached remainder only**. Real prompt size is:

```
input_tokens + cache_creation_input_tokens + cache_read_input_tokens
```

Priced at 1× / 1.25× / 0.1× respectively. Summing only `input_tokens` under-reports spend by most of the prompt once caching is working — which would quietly defeat the spend cap.

---

## 6. Spend cap and replay

### Three layers

| Layer | Mechanism | Enforced by |
|---|---|---|
| Per response | `max_tokens: 16000` | Anthropic API |
| Per visitor | 3 runs / IP / 24h | Upstash counter |
| Global | $25 ceiling, pre-turn gate | Upstash counter + priced usage |

The global cap is checked **before** each turn, not after. Over budget → serve a recorded replay instead of erroring, so the demo degrades rather than breaks.

### Why not `task_budget`

The API has a Task Budgets beta (`task-budgets-2026-03-13`) which looks like the right tool and isn't. It is **advisory** — the model sees a countdown and paces itself, but nothing stops it — and its minimum is 20,000 tokens. For a hard dollar ceiling on a public endpoint, an advisory signal with a floor above my per-run budget is the wrong instrument. Evaluated and rejected; recorded in the decision log with this reasoning.

### Replay

Every live run streams to Redis as it executes. When the cap trips or the API errors, the app plays back a real prior run on the same repo and task. The replay library grows itself; no fixtures to author.

Replays are visibly labelled as replays. Presenting a recording as a live run would be the one genuinely dishonest thing this project could do.

### Trust boundary — not optional

`/api/step` is a public endpoint holding my API key. Treated as hostile input:

- **Server pins `model`, `max_tokens`, and `effort`.** The client cannot set them. A client-settable `max_tokens` is a direct spend-injection vector.
- **Request body size capped**, and prompt size checked with `count_tokens` against a ceiling before any API call.
- **Tool paths validated against snapshot keys.** Lookups are JSON-key based, so traversal doesn't apply, but unknown keys are rejected rather than passed through.
- Tools are **read-only**. No writes, no shell, no network egress from tool execution.

---

## 7. UI

Two panels, one screen.

**Left — context.** Budget slider (4k/8k/16k/32k). Token meter broken down by **signature / docstring / body**, because that's where the compression actually comes from. Symbol rows grouped by file, each showing tier, token cost, and why it was selected (BM25 hit / graph hop from X / churn). Eviction list below the fold with reasons. Pin, evict, expand.

**Right — run.** Streamed agent output: plan, then per-file proposed diffs. Live cost readout in dollars. Interrupt button.

Changing a pin re-runs the pack and shows the delta. That interaction *is* the section 3A argument, made executable.

---

## 8. Scope for 3 days

### In

- `scripts/fetch_repos.sh` → gitignored `vendor/`, plus `snapshots/ATTRIBUTION.md`
- Snapshot builder for FastAPI + httpx (stdlib `ast`, symbols, 5 edge types, `count_tokens`)
- Packer with 3 tiers, pins, evictions, budget invariant
- `/api/pack`, `/api/step` (SSE), `/api/tool`
- Three-layer spend cap + replay record/playback
- Two-panel UI with pin/evict/interrupt
- Design doc, decision log, section 3 answers
- One runnable test (§10)

### Out — stated in the doc, not hidden

| Cut | Why | Cost of adding |
|---|---|---|
| Recall@budget eval vs mined PRs | The strongest rigor signal, and genuinely doesn't fit 3 days | ~2 days; the mining approach is written up as future work |
| Arbitrary repo URL | Live indexing means cold starts and rate limits | ~1 day + a queue |
| Embeddings ranking | Graph expansion is the differentiator; this adds a bill and a store | ~half a day |
| Multi-language | Python-only lets the builder use stdlib `ast` | ~1 day: swap `ast` for tree-sitter, add a grammar + query set per language |
| Applying edits / git ops | Diffs are sufficient to judge context quality | needs a sandbox |
| Auth, multi-user, persistence | No user model in a demo | — |

Anything bounded that ships gets logged as bounded. A silent cap reads as "covered everything" when it didn't.

### Day plan

- **Day 1** — snapshot builder end to end, both repos committed. Packer + test passing. No UI.
- **Day 2** — three API routes, spend cap, streaming wired to a minimal UI. First real end-to-end run.
- **Day 3** — UI, replay, deploy, write-up. Buffer lives here.

Buffer is deliberately on day 3 because the write-up is graded and half-finished polish is worth less than a finished argument.

---

## 9. Decision log seeds

`DECISIONS.md`, dated entries, including things that were killed. Killed-with-a-number is the highest-trust signal available.

Already earned before any code:

1. Measured the repos before designing → found `routing.py` at ~64k tokens → **file-level selection abandoned for symbol-level.** A design that skipped measurement would have shipped a packer structurally incapable of representing FastAPI.
2. Measured docstring share (42% / 55%) → docstring truncation promoted to its own control.
3. Rejected `task_budget` for the spend cap — advisory, 20k minimum.
4. Dropped embeddings — cost and dependency for the least differentiating signal.
5. Corrected my own repo-selection criterion mid-design: file count was the wrong metric, token weight and distribution is the right one. FastAPI has 48 files and ~192k tokens.
6. Dropped tree-sitter for Python's stdlib `ast` once multi-language was cut. tree-sitter buys language-agnosticism; with one language it is a WASM binary and a query language bought for nothing.
7. Cut the churn ranking signal. It was driving a deep-clone requirement (FastAPI's checkout is 57 MB at depth 1), it was the weakest of three signals, and with the eval cut it was unmeasurable. Killed the feature that cost the most and was worth the least.
8. `vendor/` gitignored, snapshots committed. The app never needs upstream source at runtime, and 57 MB of someone else's code in a submission repo is noise. Snapshots embed verbatim signatures and docstrings, so `snapshots/ATTRIBUTION.md` carries both upstream licenses (MIT, BSD-3) — required, and cheap.

To be added during the build: at minimum one measured before/after for graph expansion vs BM25-only on a real task.

---

## 10. Verification

The packer is a scoring loop under a constraint — exactly the shape of code that drifts silently. It gets a real check.

**`tests/pack.test.ts`** — `node:test` + `node:assert`, both stdlib. No framework, no fixtures.

1. **Budget invariant** — emitted pack tokens ≤ budget, across all four budgets and both repos.
2. **Pin honoured** — a pinned symbol appears at `full` tier even when it loses on score.
3. **Evict honoured** — an evicted symbol appears nowhere in the emitted pack.
4. **Graph expansion earns its place** — on a fixed task, BM25-only misses a specific symbol that expansion includes. This is the differentiator; if it ever stops holding, the design's central claim is dead and the test should say so loudly.

**Builder:** `build_snapshot.py --self-check` asserts that an edge through httpx's `__init__.py` resolves to the defining module rather than the hub. Lives in the builder because that's where re-export resolution lives — a separate test file for one assertion would be scaffolding.

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| Symbol extraction takes longer than expected | Builder is offline and uses stdlib `ast` — no grammar or WASM to fight. Lowest-risk component in the build. |
| Agent proposes diffs against symbols that were only included as skeletons | Prompt states the tier of every symbol explicitly; agent must call `read_file` to expand before editing. Tests the pack's honesty. |
| Cost overrun | Three-layer cap; global gate is pre-turn |
| Day 3 compresses | Write-up drafted incrementally from `DECISIONS.md`, not written at the end |
| Reads as "I rebuilt your moat in 3 days" | Framed explicitly as a scoped instrument with stated limits (§1 non-goal) |

---

## 12. Section 3 (product strategy) — approach

Not answerable from imagination. Requires several hours of real Superbrain use on a real repo, with a timestamped friction log and screenshots. Every complaint gets a repro.

**3A — what I'd build next.** One or two changes, defended with cost/benefit rather than a wishlist. Leading candidate: **context transparency.** Their engine decides what the model sees; when output is wrong, the user cannot tell whether the model was weak or the context was missing. A panel showing what was included, what was evicted, and allowing a pin is a feature only their architecture can ship. ContextBudget is that argument as working code.

**3B — UI issues.** Grounded in the friction log. Expected themes: opaque long agent runs with no intermediate diffs, no interrupt-and-steer, multi-file diff review, token cost invisible until the bill.

---

## Open items

- Version control is entirely manual and deliberate: the coding agent is forbidden from touching git (`BUILD.md` §1), and the repo gets initialized and committed by hand once the work is judged ready. Trade-off accepted knowingly — see below.
- **Consequence:** there will be no incremental commit history from the build. Since the assignment evaluates decision-making, `DECISIONS.md` has to carry that whole load: dated entries written as the work happens, including reversals. It is the process record, not a supplement to one.
