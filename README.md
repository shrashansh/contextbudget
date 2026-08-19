# ContextBudget

A tool that shows you which parts of a codebase to send to an AI, what that costs, and
what got left out.

**Live:** [paste vercel url]
**Write-up:** [SUBMISSION.md](SUBMISSION.md) is the assignment submission. Start there.

---

## The idea in one paragraph

When you ask an AI to change your code, something has to pick which functions to show it.
FastAPI's source is 170,878 tokens and a typical budget is 8,000, so something silently
discards about 95% of the repo before the model sees anything. Every AI coding tool makes
that choice invisibly, which means when the output is wrong you cannot tell whether the
model was weak or whether it just never saw the right code. This makes that choice the
interface: you see every symbol that made the pack, every one that did not, why, and what
it cost, and you can overrule it.

## Running it

```bash
bash scripts/fetch_repos.sh          # clones fastapi + httpx into vendor/ (gitignored)
export GEMINI_API_KEY=...            # free key from aistudio.google.com
python3 scripts/build_snapshot.py --tokens --self-check
npm install && npm run dev           # http://localhost:3000
```

Checks:

```bash
node --test tests/pack.test.ts        # 8 tests, incl. the budget invariant
node eval/score.ts                    # recall against hand-labelled ground truth
```

Index your own Python project, no code changes needed:

```bash
python3 scripts/build_snapshot.py --path ~/code/your-project --name yourproject --tokens
```

The repo list is read from `snapshots/` on disk, so it appears in the picker by itself.

## What is in here

| path | what it is |
|---|---|
| `scripts/build_snapshot.py` | indexer. Parses Python with stdlib `ast` into symbols, edges and real token counts |
| `lib/pack.ts` | the packer. BM25 plus graph expansion, three detail tiers, knapsack under a hard budget |
| `eval/` | ten hand-labelled tasks and a scorer. This is what turned ranking guesses into measurements |
| `app/` | Next.js UI and three API routes |
| `tests/pack.test.ts` | 8 tests. The important one asserts the pack never exceeds budget, by counting the assembled text |
| `snapshots/*.json` | pre-indexed fastapi and httpx, committed so the deploy needs no build-time indexing |
| `DECISIONS.md` | dated record of every decision, including the ones that turned out wrong |
| `BUILD.md` | the working brief I wrote for the coding agent, kept as a record of how the build was directed |

## Numbers

| | |
|---|---|
| symbols indexed | 1,054 (fastapi 510, httpx 544) |
| graph edges | 1,527 |
| recall@20 vs ground truth | 78.2% |
| budget drift | 0.00% at every budget, both repos |
| agent turn | about 3 seconds |

## Attribution

`snapshots/*.json` contain source extracted from FastAPI (MIT) and httpx (BSD-3-Clause).
Both licenses are reproduced in [snapshots/ATTRIBUTION.md](snapshots/ATTRIBUTION.md).
