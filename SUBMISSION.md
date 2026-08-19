# ContextBudget
Shrashansh Dixit

Live: https://contextbudget-sigma.vercel.app
Code: https://github.com/shrashansh/contextbudget

---

## 1. What I built and why

I built a tool that shows you which parts of a codebase you should send to an AI, what
that costs, and what got left out.

Here is the reasoning. When you ask an AI to change your code, something has to pick
which functions to show it. You cannot show it everything. FastAPI's source is 170,878
tokens and a normal budget is 8,000, so something is throwing away 95% of the repo
before the model ever sees it.

Every AI coding tool makes that choice invisibly. So when the output is wrong you cannot
tell if the model was weak or if it just never saw the right code. That is the thing I
wanted to make visible.

The assignment gave three examples, a quiz app, an FPV game, a collaborative app. I did
not build one of those. Superbrain's whole product is a context engine that claims 60-80%
token reduction with full repo awareness. Section 1 of the assignment asks me to
understand the product. It felt wrong to then go build something unrelated in section 2.
So I built a small version of the same problem instead, and made the invisible part the
entire interface.

I want to be clear about what this is not. It is not a rebuild of your context engine. I
had two to three days. It is two repos, Python only, and it runs on a free model. It is
an instrument for thinking about the problem, not a competitor.

### Prior art, because I checked

Graphify already exists and does something close, tree-sitter parsing, no embeddings, a
queryable code graph, and it claims 71.5x token reduction. Aider has a repo-map. Cursor
has its own retrieval.

I thought about whether that killed the idea and decided it did not, for two reasons.

First, originality is not what is being asked. A live quiz app has thousands of prior
implementations. If novelty were the bar the assignment's own examples would fail it.

Second, Graphify existing actually helps my argument. A funded company exists to bolt
structured context onto coding assistants from the outside, because those assistants do
not expose their context layer. That is evidence the thing is underserved inside the
tools, which is exactly what I want to argue in section 3.

One thing I noticed while reading: Graphify claims 71.5x and Superbrain claims 60-80%
(about 2.5-5x). Those differ by more than an order of magnitude in the same market
because they measure completely different baselines. Graphify compares graph queries
against reading files. Superbrain compares a packed context against a naive one. Worth
knowing they are not comparable numbers.

What makes mine different from Graphify: it answers a different question. Graphify
answers "what is the structure of this codebase". Mine answers "given exactly 8,000
tokens, what do you drop, and do you agree". The budget constraint, the human override,
and the cost readout are the product. Graphify has none of those.

---

## 2. Architecture and key decisions

Four pieces.

### The indexer (`scripts/build_snapshot.py`, Python, stdlib only)

Reads FastAPI and httpx and breaks them into individual symbols, modules, classes,
functions, methods, not files. For each one it stores the signature, the first docstring
line, the rest of the docstring, the body, exact token counts, and the edges to other
symbols.

Output: FastAPI 510 symbols / 700 edges, httpx 544 / 827.

**Why symbols and not files, and this is the decision everything else follows from.**
Before designing anything I measured the repos. `fastapi/routing.py` alone is 57,350 tokens,
nearly twice the largest budget I offer. So a file-level tool cannot
include the most important file in the repo, at any budget. That killed file-level
selection before I wrote a line of code.

**Why stdlib `ast` and not tree-sitter.** tree-sitter buys you language-agnosticism. I
had already cut multi-language for time. With one language it is a WASM binary and a
query language bought for nothing, so I dropped it. Python's `ast` is stdlib, exact, zero
dependencies.

### The packer (`lib/pack.ts`)

Ranks symbols against the task, then fills the budget at three levels of detail:
signature only, signature + first docstring line, or the full body.

Ranking is BM25 plus graph expansion. BM25 finds the symbol that mentions your concept.
Graph expansion finds the interface a couple of hops away that you must not break and
that mentions your keywords nowhere. No embeddings, they add a bill, a dependency and a
vector store, and expansion is the part that actually beats naive search.

**A finding, and the correction that followed it.** I first measured with estimated token
counts and concluded that a whole repo's signatures cost almost nothing, so the only real
decision was which bodies to include. Switching to real counts showed that was wrong, and
the way it was wrong is more interesting than the original claim.

All 510 fastapi signatures come to 96,244 tokens, three times the largest budget. All 544
httpx signatures come to 14,788. The median fastapi signature is 20 tokens but the mean is
about 189, because its API takes forty-odd keyword arguments per function. So on httpx you
genuinely can hold the whole repo's shape and spend the remainder on bodies. On fastapi the
budget binds at every tier, signatures included.

Same tool, opposite behaviour, decided by the API style of the code being indexed. Bodies
are still an order of magnitude more expensive per symbol, hundreds of tokens against tens,
so promotion is still the interesting decision. But I can no longer say admission is free.
I had taken a median from a badly skewed distribution.

### The measurement (`eval/tasks.json`, `eval/score.ts`)

Ten realistic tasks across the two repos where I wrote down by hand which symbols a
competent engineer would need. I derived those labels by reading the source, never by
running my own retriever, if the labels came from the tool then the eval measures the
tool against itself and is worthless.

This is the piece I would fight to keep if I had to cut something. Before it existed,
every ranking decision was a guess, and I made three different hop-depth decisions on
three different broken score landscapes. After it existed the decisions became
measurements. It caught four real bugs.

Result: 78.2% recall@20 on ground truth.

### The app (Next.js on Vercel)

Three routes. `/api/pack` builds a pack. `/api/tool` serves read-only lookups.
`/api/step` runs one agent turn and streams it.

**The browser drives the agent loop, not the server.** Three reasons, in order: a full
server-side loop can exceed Vercel's function timeout while one turn never does;
interrupt becomes "the browser stops calling" with no cancellation plumbing; and
pin/evict becomes "the next request body is different" with no server session to
reconcile.

**The client sends symbol ids and tiers, never pack text.** The server renders the pack
from the snapshot. If the client supplied the text, the system prompt would be an
arbitrary-content injection surface on a public endpoint holding a billable key. Same
reason the server pins the model and token limits, a client-settable `max_tokens` is
direct spend injection.

**Cost is shown as a projection across models, not a bill.** The demo runs on Gemini's
free tier so real spend is zero, but showing "$0" throws away the point. It shows what
the pack would cost on Claude Opus, Claude Sonnet and Gemini. For a product about token
economics a cost model is more useful than one invoice.

### Things I tried and rejected

- **Task Budgets API for the spend cap.** Looks right, is not. It is advisory, the model
  sees a countdown and paces itself, but nothing stops it. Its minimum is also 20,000
  tokens, above my per-run budget. Wrong instrument for a hard ceiling.
- **Churn as a ranking signal.** Files changed often get changed again. It needed deep git
  history, it was the weakest of three signals, and with no eval at the time I could not
  measure whether it helped. Shipping an unmeasurable ranking signal is decoration. Cut.
- **Reciprocal Rank Fusion for combining BM25 and graph scores.** Implemented it, measured
  it, it made recall worse, 0.748 down to 0.607, because graph-discovered symbols crowded
  out stronger lexical matches at the top. Kept the simpler approach and recorded the
  negative result.
- **Groq's free tier.** 6,000 tokens per minute. One 8k pack exceeds the entire minute's
  quota, so three of my four budget settings could not run at all. Gemini's free tier is
  250,000 TPM. Arithmetic, not preference.
- **`gemini-3.6-flash`.** 62 seconds on a bare prompt, past 120 seconds on an 8k pack,
  because it reasons unboundedly and thinking cannot be disabled (only bounded).
  Vercel Hobby caps functions at 60 seconds, so it would have failed in production while
  passing locally. `gemini-3.5-flash-lite` is 0.8s, zero thinking tokens, and draws on a
  separate quota pool. Weaker diffs, and I would rather say that plainly than ship
  something that times out.

---

## 3. Where I was wrong

I am putting this in because it is the honest record and I think it is the most useful
thing in here. `DECISIONS.md` in the repo has all of it dated.

**Docstring truncation was my headline compression argument and it was not implemented.**
I measured that `routing.py` is 42% docstring and built a three-tier system around
trimming that. Then I measured the output: 98% of FastAPI symbols had an empty
`docFirstLine`. The docstrings were being extracted but landing entirely in the wrong
field, because FastAPI writes docstrings starting on the line after the quotes so
`split("\n")[0]` returned empty. Consequences: the middle tier was identical to the
cheapest one, the meter's docstring band was always zero, and BM25, which indexes that
field, had zero docstring signal the whole time. My 74.8% recall number had been
measured on a broken index. After fixing it, 78.2%.

**Every method body was duplicated inside its class body.** 200 of 200 methods in
FastAPI, 369 of 369 in httpx. Token counts were inflated 55% and a pack containing both a
class and its methods sent the same source to the model twice.

**Pins could blow the budget by 5.9x.** Budget 4,000 with six large pins produced a
23,563-token pack reported as compliant. The test suite was green because the budget test
never pinned and the pin test never checked budget. Each test passed. Their combination
was never tested.

**The tests, the eval and the budget invariant were all green while the UI could not
display a single token.** Everything had been verified with `curl` against the API. Nobody
had opened the browser. The run panel called `res.json()` on a streaming response and sent
an empty message array, so the model received the context pack with no instruction at all.

The pattern in all four: I verified units and assumed the integration. The measurements
existed to catch these and I was not looking at the right ones.

---

## 4. What works and what does not

**Works, verified:**
- 8 tests pass. The important one asserts the pack never exceeds budget, checked by
  counting the actual assembled text rather than summing parts. 0.00% drift at every
  budget on both repos.
- 78.2% recall@20 against hand-labelled ground truth.
- A real agent turn: about 3 seconds, ~3,200 characters of relevant diff, cost projection
  across three models.
- Path traversal on the file tool is structurally impossible, not filtered, lookups go
  through snapshot keys, so `../../etc/passwd` is simply an unknown key.

**Does not work, or is deliberately out:**
- Replay has nothing recorded yet, so a rate-limited visitor sees an error instead of a
  labelled recorded run.
- The global spend cap never increments, `recordSpend()` has no callers. Low impact on a
  free tier where the binding limit is provider quota, but it needs wiring before any paid
  key.
- The budget slider does nothing on httpx. Only 2 of 544 httpx symbols match a
  FastAPI-flavoured task, so the pack is 1,113 tokens at every budget. This is correct
  behaviour, padding context with irrelevant code would be worse, and the UI now says so
  explicitly: "budget is not binding, only N symbols are relevant". I think that is the
  clearest demonstration of the whole idea, so I left it visible rather than hiding it.
- Python only, and indexing is an offline step, not something the app does on demand.
  You can point it at any local Python project though:

  ```bash
  python3 scripts/build_snapshot.py --path ~/code/my-project --name myproject --tokens
  ```

  It finds the package directory, indexes it, writes `snapshots/myproject.json`, and the
  app picks it up with no code change, the repo list is read from disk, not hardcoded.
  Tested against Python's stdlib `json` package: 31 symbols, 11,778 tokens.

  I did not make it accept a GitHub URL at runtime, and that is a real constraint rather
  than laziness. Cloning FastAPI is 57 MB, and counting tokens for it is ~1,500 API calls
  taking about a minute. Vercel Hobby caps a function at 60 seconds. Indexing is a
  minutes-long offline job, so pretending it is a request would just fail in production.
- No automated evaluation against mined pull requests. That was the biggest cut. The method
  is written up below as future work.
- Six smaller known issues, all listed in `DECISIONS.md`.

**If I had two more weeks:** the PR-mined eval. Take merged pull requests from these repos,
use the PR title as the task and the files it touched as ground truth. That gives unlimited
real labelled data instead of my ten hand-written cases, and it would let me tune hop
depth, decay and tier boundaries against evidence rather than judgement.

---

## 5. Product strategy

### A. What I would change or add next

**Context transparency, surfaced in the IDE.**

Your engine decides what the model sees. When output is wrong the user cannot tell whether
the model was weak or the context was missing, so the only recourse is to retry and hope.
That is the loop I found most frustrating in actual use. The clearest case in this build
was a tokenizer bug. My index split identifiers badly, so the query "add per-route rate
limiting" did not match a symbol called `rate_limit`. I asked the agent to fix it. It made
the test pass by editing the test to search for `rate_limit` instead, and left the
tokenizer alone. The suite went green. Nothing on screen distinguished "fixed the bug"
from "weakened the check", and nothing showed me what it had read before deciding that was
the cheaper path. I caught it reading the diff line by line, which is exactly the review
step the tool is supposed to save me.

Concretely: a panel showing what went into the context, what was dropped, and a way to pin
a file or evict one. This is a feature only you can ship, because only you have the engine
that made the decision. Everyone else is guessing from outside, which is precisely why
Graphify exists as a third-party bolt-on.

The cost side of the same argument: token spend is invisible until the bill. Showing per-run
cost, and what a run would have cost with a smaller context, turns your 60-80% reduction
claim from marketing into something the user watches happen.

I built ContextBudget as this argument in working code rather than as a suggestion.

**Second, smaller:** the 60-80% number needs a public methodology. Graphify claims 71.5x
against a different baseline. Right now a buyer cannot compare them. Publishing what you
measure against would be a real differentiator, and it is the kind of claim that gets
harder to make later, not easier.

### B. UI issues I disliked

Three things cost me real time. I have put them in the order they hurt.

**1. Text rendering in the agent panel is misaligned.**

Streaming output did not hold its alignment. Wrapped lines and code blocks shifted as text
came in, and side by side against Cursor and Claude Code running the same kind of task it
was visibly the roughest of the three. [ATTACH SCREENSHOT HERE, and say which of the two
it was: wrapping, or code block indentation, or reflow while streaming.]

Why it cost me: the agent panel is where I read diffs. When the rendering is unreliable I
stop trusting what I am reading and go verify it in the editor instead, which removes the
reason to review in the panel at all. It is the same failure as the context problem above,
one layer up. I could not tell whether the output was wrong or the display was wrong.

This is also the cheapest of the three to fix and the most visible. It is the first thing
anyone evaluating the fork will notice, before they get far enough to judge the engine.

**2. Auto mode does not hold. Nearly every tool call needed a manual Allow.**

On a long multi-file build there are dozens of tool calls per task, and I was clicking
Allow for effectively all of them even with auto mode on.

Why it cost me: an agent harness earns its keep when I can start a long run and step away.
If a person has to sit and click, the ceiling on task size is however long that person will
keep clicking, not how much the model can do. The second problem is worse than the
interruption: after twenty identical prompts I was approving without reading them. A
permission dialog that trains the user to dismiss it unread is doing less for safety than
no dialog at all, because now the click is on record.

What I would change: session scoped trust rather than per call. "Allow this tool, in this
directory, for this session", plus a visible list of what is currently trusted so a blanket
approval can be audited and revoked. Claude Code's permission modes and settings allowlist
are the closest reference point I have used.

**3. API limits, and they land mid-task.**

I hit rate limits repeatedly, and they arrived in the middle of long runs rather than at
the start. I ran out of capacity partway through this project and finished the remaining
work outside the tool. [PASTE THE EXACT LIMIT MESSAGE AND YOUR PLAN TIER HERE.]

Why it cost me: being told up front that a run will not fit is fine. Losing a run halfway
is not, because the work is gone and the context that produced it is gone with it. There
was no quota indicator before starting, no warning as I approached the limit, and no way to
resume once I hit it.

What I would change: show remaining quota before a long run, warn at a threshold, and make
a limited run resumable instead of dead.

This last one is the same argument as my project, pointed at the harness rather than the
model. ContextBudget exists because spend is invisible until after you have spent it. A
quota meter and a pre run estimate are that idea applied one level up, and you already have
every number needed to build it.

---

## 6. How to run it

```bash
bash scripts/fetch_repos.sh                          # clones fastapi + httpx into vendor/
export GEMINI_API_KEY=...                            # free, aistudio.google.com
python3 scripts/build_snapshot.py --tokens --self-check
npm install && npm run dev                           # http://localhost:3000
node --test tests/pack.test.ts                       # 8 tests
node eval/score.ts                                   # recall table

# index your own Python project, no code changes needed
python3 scripts/build_snapshot.py --path /path/to/project --name yourname --tokens
```
