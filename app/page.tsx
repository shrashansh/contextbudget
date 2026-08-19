"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Tier = "signature" | "skeleton" | "full";

interface PackedSymbol {
  id: string;
  tier: Tier;
  tokens: number;
  reason: string;
}

interface Evicted {
  id: string;
  tokens: number;
  reason: string;
}

interface PackResponse {
  selected: PackedSymbol[];
  evicted: Evicted[];
  totals: { signature: number; doc: number; body: number; total: number };
  budget: number;
  tokenSource: "estimate" | "count_tokens";
}


// The ten tasks from eval/tasks.json, with the recall@20 each actually scored in
// eval/score.ts. Shown honestly, failures included, a demo that reports where it
// does badly is more useful than one that only ships its wins.
const EXAMPLES: { repo: string; task: string; recall: number }[] = [
  { repo: "fastapi", task: "register a custom exception handler", recall: 1.0 },
  { repo: "fastapi", task: "add a WebSocket endpoint", recall: 1.0 },
  { repo: "fastapi", task: "include a sub-router with a URL prefix", recall: 1.0 },
  { repo: "fastapi", task: "add a request/response middleware", recall: 1.0 },
  { repo: "fastapi", task: "add per-route rate limiting", recall: 0.4 },
  { repo: "httpx", task: "use a mock transport in tests", recall: 1.0 },
  { repo: "httpx", task: "make a POST request with a JSON body", recall: 0.75 },
  { repo: "httpx", task: "set a timeout and connection limits", recall: 0.67 },
  { repo: "httpx", task: "stream a large response body", recall: 0.67 },
  { repo: "httpx", task: "send a custom authentication header", recall: 0.0 },
];

type View = "dashboard" | "about" | "howto" | "glossary" | "limits";

const NAV: { id: View; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "about", label: "What this is" },
  { id: "howto", label: "How to use" },
  { id: "glossary", label: "Glossary" },
  { id: "limits", label: "Limits" },
];

const BUDGETS = [4000, 8000, 16000, 32000];
// Repo list comes from the server, which derives it from snapshots/ on disk. That
// is what lets someone index their own Python project and have it appear here with
// no code change.

export default function Page() {
  const [repo, setRepo] = useState<string>("fastapi");
  const [repos, setRepos] = useState<string[]>(["fastapi", "httpx"]);
  const [view, setView] = useState<View>("dashboard");
  const [task, setTask] = useState<string>("add per-route rate limiting");
  const [budget, setBudget] = useState<number>(8000);
  const [pins, setPins] = useState<string[]>([]);
  const [evicts, setEvicts] = useState<string[]>([]);
  const [pack, setPack] = useState<PackResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [stepOutput, setStepOutput] = useState<string[]>([]);
  const [cost, setCost] = useState<string>("no run yet");
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const doPack = useCallback(async (p = pins, e = evicts, b = budget) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/pack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo, task, budget: b, pins: p, evicts: e }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? `pack failed: ${res.status}`);
        setPack(null);
      } else {
        setPack(data as PackResponse);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [repo, task, budget, pins, evicts]);

  useEffect(() => {
    fetch("/api/repos")
      .then((r) => r.json())
      .then((d: { repos?: { repo: string }[] }) => {
        const names = (d.repos ?? []).map((r) => r.repo);
        if (!names.length) return;
        setRepos(names);
        // A reviewer indexing only their own project will not have "fastapi".
        if (!names.includes(repo)) setRepo(names[0]);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-pack when the repo changes, and clear pins/evicts first: their ids belong
  // to the previous snapshot, so keeping them made the next pin or run post
  // foreign ids and 400. Previously this effect was mount-only ([] deps), so
  // switching repo or editing the task left the pack stale and the agent turn ran
  // against the PREVIOUS task's context.
  useEffect(() => {
    setPins([]);
    setEvicts([]);
    doPack([], [], budget);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo]);

  // Re-pack on task/budget change. Task is debounced because it is a text input.
  useEffect(() => {
    const id = setTimeout(() => doPack(), 300);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task, budget]);

  const togglePin = (id: string) => {
    const next = pins.includes(id) ? pins.filter((x) => x !== id) : [...pins, id];
    setPins(next);
    doPack(next, evicts);
  };
  const toggleEvict = (id: string) => {
    const next = evicts.includes(id) ? evicts.filter((x) => x !== id) : [...evicts, id];
    setEvicts(next);
    doPack(pins, next);
  };
  const setTier = (id: string, tier: Tier) => {
    // expand: request the symbol be admitted at the given tier. We approximate
    // by pinning it (pins are admitted at full); the pack re-renders the delta.
    if (tier === "full" && !pins.includes(id)) {
      const next = [...pins, id];
      setPins(next);
      doPack(next, evicts);
    }
  };

  const runStep = async () => {
    if (running) return;
    setRunning(true);
    setStepOutput([]);
    setCost("running…");
    const abort = new AbortController();
    abortRef.current = abort;
    // selection = ids + tiers currently in the pack
    const selection = (pack?.selected ?? []).map((s) => ({ id: s.id, tier: s.tier }));
    try {
      const res = await fetch("/api/step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The task MUST be sent. Previously this posted messages: [], so the model
        // received the context pack with no instruction and had nothing to answer.
        body: JSON.stringify({
          repo,
          selection,
          messages: [{ role: "user", parts: [{ text: task }] }],
        }),
        signal: abort.signal,
      });

      // /api/step returns text/event-stream. res.json() throws on it, which is why
      // the run panel never showed output, read the stream frame by frame instead.
      if (!res.ok || !res.body) {
        let msg = `step returned ${res.status}`;
        try {
          const j = await res.json();
          if (j?.error) msg = j.error;
        } catch {
          /* non-JSON error body */
        }
        setStepOutput((prev) => [...prev, msg]);
        return;
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let text = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // Normalise CRLF: the upstream SSE uses \r\n\r\n frame separators.
        buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        const frames = buf.split("\n\n");
        buf = frames.pop() ?? "";
        for (const f of frames) {
          const payload = f
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim())
            .join("");
          if (!payload) continue;
          let ev: {
            type?: string;
            text?: string;
            error?: string;
            replay?: boolean;
            projection?: { model: string; totalUsd: number; free: boolean; served: boolean }[];
          };
          try {
            ev = JSON.parse(payload);
          } catch {
            continue;
          }
          if (ev.type === "delta" && ev.text) {
            text += ev.text;
            setStepOutput([text]);
          } else if (ev.type === "status" && ev.replay) {
            setStepOutput((prev) => [...prev, "[REPLAY, recorded run, not live]"]);
          } else if (ev.type === "error" && ev.error) {
            setStepOutput((prev) => [...prev, ev.error!]);
          } else if (ev.type === "done" && ev.projection) {
            // The API sends `projection` (per-model), never a flat `cost` field.
            // Showing "$0.0000" for the free tier reads as a broken readout, so the
            // serving model is labelled instead of printed as a zero.
            setCost(
              ev.projection
                .map((pr) => {
                  const name = pr.model.replace(/^(claude|gemini)-/, "");
                  const amount = pr.free ? "free" : `$${pr.totalUsd.toFixed(4)}`;
                  return pr.served ? `${name} ${amount} (ran here)` : `${name} ${amount}`;
                })
                .join("  ·  "),
            );
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setStepOutput((prev) => [...prev, err instanceof Error ? err.message : String(err)]);
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const interrupt = () => {
    abortRef.current?.abort();
    setRunning(false);
  };

  // group selected symbols by file (id format: "<file>::<qualname>")
  const byFile = new Map<string, PackedSymbol[]>();
  for (const s of pack?.selected ?? []) {
    const file = s.id.split("::")[0];
    const list = byFile.get(file) ?? [];
    list.push(s);
    byFile.set(file, list);
  }

  // promotion story: count full-tier bodies, the scarce resource
  const fullCount = (pack?.selected ?? []).filter((s) => s.tier === "full").length;


  const totals = pack?.totals;
  const counted = pack?.tokenSource === "count_tokens";
  // A pack far under its ceiling means the budget is not the binding constraint , 
  // the repo simply has little relevant context. Saying so is the product working,
  // not failing: httpx on a FastAPI-flavoured task packs ~1.1k of a 32k budget.
  const notBinding = !!totals && totals.total < pack!.budget * 0.5;
  const pct = (n: number) => (totals && totals.total > 0 ? (n / pack!.budget) * 100 : 0);


  const load = (repo: string, task: string) => {
    setRepo(repo);
    setTask(task);
    setView("dashboard");
  };

  return (
    <>
      <nav className="cb-nav">
        <div className="cb-brand">
          ContextBudget
          <span className="cb-brand-rule" />
        </div>
        <div className="cb-nav-links">
          {NAV.map((n) => (
            <button
              key={n.id}
              className="cb-nav-link"
              aria-current={view === n.id}
              onClick={() => setView(n.id)}
            >
              {n.label}
            </button>
          ))}
        </div>
        <div className="cb-nav-meta">
          {pack ? `${pack.selected.length} in pack · ${totals?.total.toLocaleString()} tok` : "…"}
        </div>
      </nav>

      {view === "dashboard" && (
        <div className="cb-shell">
          {/* ---------------- LEFT: the context decision ---------------- */}
          <section className="cb-pane">
            <h1 className="cb-title">The context pack</h1>
            <p className="cb-sub">
              Which parts of this repo should the model see, and what does that cost?
              New here? Read <button className="cb-inline" onClick={() => setView("about")}>what this is</button>{" "}
              or <button className="cb-inline" onClick={() => setView("glossary")}>the glossary</button>.
            </p>

            <div className="cb-row">
              <div>
                <label className="cb-label" htmlFor="repo">Repository</label>
                <select id="repo" className="cb-select" value={repo} onChange={(e) => setRepo(e.target.value)}>
                  {repos.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </div>
              <div style={{ flex: "2 1 260px" }}>
                <label className="cb-label" htmlFor="task">Task</label>
                <input
                  id="task"
                  className="cb-field"
                  value={task}
                  onChange={(e) => setTask(e.target.value)}
                  placeholder="add per-route rate limiting"
                />
              </div>
            </div>

            <label className="cb-label">Token budget</label>
            <div className="cb-budgets" style={{ marginBottom: 18 }}>
              {BUDGETS.map((b) => (
                <button key={b} className="cb-budget" aria-pressed={budget === b} onClick={() => setBudget(b)}>
                  {b / 1000}k
                </button>
              ))}
            </div>

            {error && <div className="cb-note cb-note--err">{error}</div>}

            {notBinding && (
              <div className="cb-note cb-note--warn">
                <strong>Budget is not binding.</strong> Only {pack!.selected.length} symbols are
                relevant to this task, so the pack is {totals!.total.toLocaleString()} tokens, not{" "}
                {pack!.budget.toLocaleString()}. Paying for more context would buy nothing.
              </div>
            )}

            <div className="cb-card">
              <div className="cb-card-head">
                <span className="cb-card-title">Token meter</span>
                {pack && (
                  <span className={`cb-badge ${counted ? "cb-badge--counted" : "cb-badge--estimate"}`}>
                    {counted ? "counted" : "estimated tokens"}
                  </span>
                )}
              </div>

              <div className="cb-meter" role="img" aria-label="token usage by component">
                {totals && (
                  <>
                    <div className="cb-meter-seg" style={{ width: `${pct(totals.signature)}%`, background: "var(--tier-signature)" }} />
                    <div className="cb-meter-seg" style={{ width: `${pct(totals.doc)}%`, background: "var(--tier-skeleton)" }} />
                    <div className="cb-meter-seg" style={{ width: `${pct(totals.body)}%`, background: "var(--tier-full)" }} />
                  </>
                )}
                <div className="cb-meter-free" />
              </div>

              <div className="cb-legend">
                <span><i className="cb-swatch" style={{ background: "var(--tier-signature)" }} />signature {totals?.signature ?? 0}</span>
                <span><i className="cb-swatch" style={{ background: "var(--tier-skeleton)" }} />docstring {totals?.doc ?? 0}</span>
                <span><i className="cb-swatch" style={{ background: "var(--tier-full)" }} />body {totals?.body ?? 0}</span>
              </div>

              <p style={{ marginBottom: 0, marginTop: 12, fontSize: "0.8125rem" }}>
                <strong>{totals?.total.toLocaleString() ?? 0}</strong> / {pack?.budget.toLocaleString() ?? 0} tokens
                {" · "}
                <strong style={{ color: "var(--tier-full)" }}>{fullCount}</strong> at full body
              </p>
              <p className="cb-sub" style={{ margin: "6px 0 0" }}>
                Bodies cost hundreds of tokens each, signatures tens. Which bodies you can
                afford is the decision this whole screen exists to show.
              </p>
            </div>

            <div className="cb-card">
              <div className="cb-card-head">
                <span className="cb-card-title">In the pack, {pack?.selected.length ?? 0}</span>
                {loading && <span className="cb-badge">packing</span>}
              </div>
              <p className="cb-sub" style={{ marginTop: 0 }}>
                <strong>keep</strong> forces a symbol in at full detail ·{" "}
                <strong>drop</strong> excludes it · the budget is fixed, so keeping one thing
                pushes another out.
              </p>
              {[...byFile.entries()].map(([file, syms]) => (
                <div key={file} className="cb-file">
                  <div className="cb-file-name">{file}</div>
                  {syms.map((s) => {
                    const degraded = s.reason.startsWith("kept (degraded");
                    return (
                      <div key={s.id} className="cb-sym">
                        <span className={`cb-tier cb-tier--${s.tier}`}>{s.tier.slice(0, 4)}</span>
                        <span className="cb-sym-name">
                          {s.id.split("::")[1]}
                          <br />
                          <span className={degraded ? "cb-reason cb-reason--degraded" : "cb-reason"}>
                            {s.reason}
                          </span>
                        </span>
                        <span className="cb-sym-tok">{s.tokens}</span>
                        <button
                          className="cb-btn"
                          aria-pressed={pins.includes(s.id)}
                          title="Keep: force this symbol in at full detail"
                          onClick={() => togglePin(s.id)}
                        >
                          keep
                        </button>
                        <button
                          className="cb-btn"
                          title="Drop: exclude it so the budget goes elsewhere"
                          onClick={() => toggleEvict(s.id)}
                        >
                          drop
                        </button>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>

            {!!pack?.evicted.length && (
              <div className="cb-card">
                <div className="cb-card-head">
                  <span className="cb-card-title">Left out, {pack.evicted.length}</span>
                </div>
                {pack.evicted.slice(0, 40).map((e) => (
                  <div key={e.id} className="cb-sym cb-evicted">
                    <span className="cb-sym-name">{e.id.split("::")[1]}</span>
                    <span className="cb-reason">{e.reason}</span>
                    <button className="cb-btn" title="Return it to the pool" onClick={() => toggleEvict(e.id)}>
                      put back
                    </button>
                  </div>
                ))}
                {pack.evicted.length > 40 && (
                  <p className="cb-sub" style={{ margin: "8px 0 0" }}>
                    +{pack.evicted.length - 40} more
                  </p>
                )}
              </div>
            )}
          </section>

          {/* ---------------- RIGHT: the run ---------------- */}
          <section className="cb-pane">
            <div className="cb-card-head" style={{ marginBottom: 14 }}>
              <span className="cb-card-title">Agent run</span>
              <span className="cb-cost">{cost}</span>
            </div>

            <div className="cb-row" style={{ marginBottom: 14 }}>
              <button className="cb-btn cb-btn--lg cb-btn--go" onClick={runStep} disabled={running || !pack?.selected.length}>
                {running ? "running…" : "run turn"}
              </button>
              <button className="cb-btn cb-btn--lg cb-btn--stop" onClick={interrupt} disabled={!running}>
                interrupt
              </button>
            </div>

            <p className="cb-sub" style={{ marginTop: 0 }}>
              Runs on exactly the {pack?.selected.length ?? 0} symbols on the left, nothing
              else. Diffs are proposed, never applied.
            </p>

            <div className="cb-out">
              {stepOutput.length ? stepOutput.join("\n") : "No run yet. Press RUN TURN."}
            </div>
          </section>
        </div>
      )}

      {view !== "dashboard" && (
        <main className="cb-doc">
          {view === "about" && (
            <>
              <h2 className="cb-doc-h">The problem</h2>
              <p>
                When you ask an AI to change code, something has to choose which functions to
                show it. FastAPI&apos;s source is 170,878 tokens and a typical budget is 8,000, so
                something silently discards about 95% of the repo before the model sees a thing.
              </p>
              <p>
                Every AI coding tool makes that choice invisibly. Which means when the answer is
                wrong, you cannot tell whether the model was weak or simply never shown the right
                code. This makes that choice the interface.
              </p>

              <h2 className="cb-doc-h">What is built</h2>
              <div className="cb-facts">
                <div className="cb-fact"><b>1,054</b><span>symbols indexed</span></div>
                <div className="cb-fact"><b>1,527</b><span>graph edges</span></div>
                <div className="cb-fact"><b>78.2%</b><span>recall @20</span></div>
                <div className="cb-fact"><b>0.00%</b><span>budget drift</span></div>
              </div>
              <p>
                Two repos indexed at the <em>symbol</em> level, functions and classes, not files.
                File-level cannot work here. <code>routing.py</code> alone is 57,350 tokens,
                nearly twice the largest budget, so a file-based tool could never include the
                repo&apos;s most important file.
              </p>
              <p>
                Ranking is BM25 plus graph expansion, measured against ten hand-labelled tasks.
                Token counts are real (Gemini <code>countTokens</code>), not estimates, and the
                pack is asserted never to exceed its budget by counting the assembled text, 0.00%
                drift at every budget on both repos.
              </p>

              <h2 className="cb-doc-h">Why you cannot paste a repo URL</h2>
              <p>
                Indexing cannot happen inside a web request. Cloning FastAPI is 57&nbsp;MB and
                counting its tokens is ~1,500 API calls taking about a minute; Vercel caps a
                serverless function at 60 seconds. A URL box would work locally and fail in
                production.
              </p>
              <p>
                So indexing stays an offline step, but it works on <em>any</em> local Python
                project, with no code changes:
              </p>
              <pre>python3 scripts/build_snapshot.py \
  --path ~/code/your-project \
  --name yourproject --tokens</pre>
              <p>
                It finds the package directory itself and writes
                <code>snapshots/yourproject.json</code>. The repo list is read from disk, so your
                project simply appears in the picker. Verified on Python&apos;s stdlib
                <code>json</code> package: 31 symbols, 11,778 tokens.
              </p>
            </>
          )}

          {view === "howto" && (
            <>
              <h2 className="cb-doc-h">Four steps</h2>
              <ol className="cb-steps">
                <li><strong>Pick a repo and type a task</strong>, or click a measured example below.</li>
                <li><strong>Move the budget</strong> between 4k and 32k and watch what enters and leaves.</li>
                <li><strong>Override it.</strong> <em>keep</em> something you know matters, <em>drop</em> something irrelevant. The budget is fixed, so keeping one thing pushes another out.</li>
                <li><strong>Press RUN TURN.</strong> An AI answers using exactly that pack and nothing else, and streams a proposed diff.</li>
              </ol>

              <h2 className="cb-doc-h">Measured examples, click to load</h2>
              <p>
                The percentage is how much of the hand-labelled ground truth each task recovers.
                The failure is shown too.
              </p>
              <div className="cb-try">
                {EXAMPLES.map((ex) => (
                  <button key={ex.repo + ex.task} className="cb-try-item" onClick={() => load(ex.repo, ex.task)}>
                    <span className="cb-try-repo">{ex.repo}</span>
                    <span className="cb-try-task">{ex.task}</span>
                    <span className="cb-try-score" data-bad={ex.recall === 0}>
                      {(ex.recall * 100).toFixed(0)}%
                    </span>
                  </button>
                ))}
              </div>
              <p style={{ marginTop: 14 }}>
                <strong>Why one scores 0%:</strong> &ldquo;send a custom authentication
                header&rdquo; finds nothing because &ldquo;authentication&rdquo; never matches the
                token <code>auth</code>, there is no stemming. No lexical match means no seed,
                and graph expansion cannot rescue a query it has no way into. It amplifies a
                foothold, it cannot create one. That is a real limit of the approach and it is
                left visible.
              </p>
            </>
          )}

          {view === "glossary" && (
            <>
              <h2 className="cb-doc-h">What everything on screen means</h2>
              <table className="cb-gloss">
                <tbody>
                  <tr><th>Budget</th><td>Hard ceiling in tokens. The pack is never allowed past it. That is the one invariant with an automated test behind it.</td></tr>
                  <tr><th><span className="cb-tier cb-tier--signature">sign</span></th><td><strong>Signature only.</strong> The declaration line. Median 20 tokens on fastapi, 14 on httpx, but the spread is huge: fastapi&apos;s keyword-heavy signatures push its mean to about 189.</td></tr>
                  <tr><th><span className="cb-tier cb-tier--skeleton">skel</span></th><td><strong>Signature + first docstring line.</strong> A cheap hint at what the thing does.</td></tr>
                  <tr><th><span className="cb-tier cb-tier--full">full</span></th><td><strong>The entire body.</strong> Hundreds of tokens each. Choosing which bodies you can afford is the real decision.</td></tr>
                  <tr><th>Token meter</th><td>One bar split by what you are spending on: blue for signature, yellow for docstring, red for body. The hatched area is unspent budget. Red dominating is the normal picture, not a problem.</td></tr>
                  <tr><th>bm25</th><td>Chosen because the task words match this symbol&apos;s name, signature or docstring.</td></tr>
                  <tr><th>graph:N from X</th><td>Chosen because it is N hops from X in the import/call/type graph. Text search would have missed it. This is the part that finds the interface you must not break.</td></tr>
                  <tr><th>keep</th><td>You forced it in at full detail, whatever the ranking thought.</td></tr>
                  <tr><th>kept (degraded)</th><td>You kept it, but the full body would not fit, so it was included at a cheaper tier rather than breaking the budget.</td></tr>
                  <tr><th>drop</th><td>You excluded it, freeing that budget for something else.</td></tr>
                  <tr><th>no match for this task</th><td>Left out because nothing in the task matched it. Most of the repo, usually.</td></tr>
                  <tr><th>ran out of budget</th><td>Left out because it was relevant but the ceiling was reached first. These are the interesting exclusions.</td></tr>
                  <tr><th>Cost row</th><td>What this exact turn <em>would</em> cost on each model. The one marked <em>ran here</em> actually served it. It says <em>free</em> because it runs on a free tier, not because the number failed to load.</td></tr>
                </tbody>
              </table>
            </>
          )}

          {view === "limits" && (
            <>
              <h2 className="cb-doc-h">Known limits</h2>
              <p>
                Everything here is measured, not guessed. Where a number contradicts something
                I claimed earlier, the number won.
              </p>

              <h2 className="cb-doc-h">Python only</h2>
              <p>
                The parser is Python&apos;s standard library <code>ast</code> module. Adding
                another language means swapping in tree-sitter and writing a query set for each
                one. Two repos ship pre-indexed, but any local Python project works with one
                command, so the limit is the language and not the repo count.
              </p>

              <h2 className="cb-doc-h">Signature cost is not uniform, and that matters</h2>
              <p>
                I originally claimed a whole repo&apos;s signatures cost almost nothing, so the
                only real decision was which bodies to include. That was wrong, and the real
                token counts show why.
              </p>
              <p>
                All 510 fastapi signatures come to 96,244 tokens, three times the largest budget.
                All 544 httpx signatures come to 14,788. The median fastapi signature is 20
                tokens but the mean is about 189, because its API takes forty-odd keyword
                arguments per function. So on httpx you really can hold the whole repo&apos;s
                shape and spend the rest on bodies. On fastapi the budget binds at every tier,
                including signatures.
              </p>
              <p>
                Same tool, opposite behaviour, decided entirely by the API style of the code
                being indexed. I only found this by measuring after switching from estimated
                token counts to real ones.
              </p>

              <h2 className="cb-doc-h">The budget slider does nothing on httpx</h2>
              <p>
                Only 2 of 544 httpx symbols match a task phrased for fastapi, so the pack stays
                at 1,113 tokens whether you ask for 4k or 32k. That is correct behaviour, since
                padding the context with irrelevant code would be worse than leaving the budget
                unspent. The dashboard says so in a banner rather than hiding it.
              </p>

              <h2 className="cb-doc-h">No stemming</h2>
              <p>
                The word &ldquo;authentication&rdquo; does not match the token <code>auth</code>,
                so one of the ten measured tasks scores 0%. With no lexical match there is no
                seed, and graph expansion cannot rescue a query it has no way into. It amplifies
                a foothold, it cannot create one.
              </p>

              <h2 className="cb-doc-h">Nothing is written, ever</h2>
              <p>
                Diffs are proposed and streamed to the screen. Nothing touches disk, the agent
                has no shell, and the file tool is read-only against the snapshot.
              </p>

              <h2 className="cb-doc-h">A deliberately small model</h2>
              <p>
                Turns run on a free-tier model, so diff quality is below what a frontier model
                would give. That is a cost decision, not a technical one. The pack format does
                not care which model consumes it, so swapping is a config change.
              </p>

              <h2 className="cb-doc-h">No evaluation against mined pull requests</h2>
              <p>
                This was the biggest thing cut for time. Ten hand-labelled tasks stand in for it.
                With longer, the approach would be to take merged pull requests from these repos,
                use the title as the task and the files it touched as ground truth. That gives
                unlimited real labels instead of ten written by hand.
              </p>

              <h2 className="cb-doc-h">Smaller things still open</h2>
              <p>
                The global spend ceiling never increments because nothing calls the recorder,
                which is harmless on a free tier where the real limit is provider quota, but it
                needs wiring before any paid key. Replay has nothing recorded yet, so a
                rate-limited visitor sees an error instead of a labelled recorded run. Six more
                are listed in <code>DECISIONS.md</code>.
              </p>
            </>
          )}
        </main>
      )}
    </>
  );
}
