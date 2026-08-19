import { NextResponse } from "next/server";
import { loadSnapshot, isValidRepo, validateIds, availableRepos } from "@/lib/snapshot";
import { checkPerVisitor, checkGlobalSpend } from "@/lib/cap";
import { outputTokens, accountedFor, project } from "@/lib/cost";
import { render } from "@/lib/pack";
import type { Tier } from "@/lib/pack";

const MAX_BODY = 64 * 1024;
const MODEL = "gemini-3.5-flash-lite";
const MAX_OUTPUT_TOKENS = 8192;
const UPSTREAM_TIMEOUT_MS = 45_000; // fail loudly before the platform kills us
// Server pins model + maxOutputTokens. None client-settable.
// Tool-use is DELIBERATELY excluded (BUILD thesis): the pack is supposed to make
// fetching more unnecessary, and measured output from the pack alone was 6538
// chars with finishReason STOP. Declaring tools without functionCall handling
// dead-ended the turn at a dropped functionCall part.
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`;

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) {
      return NextResponse.json({ error: "request body too large" }, { status: 413 });
    }
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const req = body as { repo?: unknown; selection?: unknown; messages?: unknown };
  if (!req || typeof req !== "object") {
    return NextResponse.json({ error: "body must be an object" }, { status: 400 });
  }
  if (!isValidRepo(req.repo)) {
    return NextResponse.json({ error: `repo must be one of: ${availableRepos().join(", ")}` }, { status: 400 });
  }
  if (!Array.isArray(req.selection)) {
    return NextResponse.json({ error: "selection is required" }, { status: 400 });
  }
  if (!Array.isArray(req.messages)) {
    return NextResponse.json({ error: "messages is required" }, { status: 400 });
  }
  // Trust boundary: client messages are spliced raw into the provider payload,
  // so whitelist the exact shape {role, parts:[{text}]}. Reject anything else —
  // do not rely on the provider to enforce our boundary.
  for (const m of req.messages) {
    const msg = m as { role?: unknown; parts?: unknown };
    const roleOk = msg?.role === "user" || msg?.role === "model";
    const partsOk =
      Array.isArray(msg?.parts) &&
      msg.parts.length > 0 &&
      msg.parts.every((p) => typeof (p as { text?: unknown })?.text === "string");
    if (!roleOk || !partsOk) {
      return NextResponse.json(
        { error: "each message must be { role: 'user'|'model', parts: [{ text: string }] }" },
        { status: 400 },
      );
    }
  }

  // Client sends ids + tiers ONLY; the server renders the pack. Validate every
  // id against the snapshot and reject unknown ids (trust boundary §5).
  const snapshot = loadSnapshot(req.repo);
  // The agent loop NEVER runs on approximate numbers (BUILD §3): estimated
  // snapshots are for the UI preview only.
  if (!snapshot.tokensCounted || snapshot.tokenSource !== "count_tokens") {
    return NextResponse.json(
      { error: "cannot run agent turn: snapshot has tokenSource='estimate' (approximate); rebuild with --tokens" },
      { status: 422 },
    );
  }
  const known = new Set(snapshot.symbols.map((s) => s.id));
  const tiers = new Set<Tier>(["signature", "skeleton", "full"]);
  for (const item of req.selection) {
    const it = item as { id?: unknown; tier?: unknown };
    if (typeof it?.id !== "string" || !known.has(it.id)) {
      return NextResponse.json({ error: `unknown symbol id in selection: ${String(it?.id)}` }, { status: 400 });
    }
    if (typeof it?.tier !== "string" || !tiers.has(it.tier as Tier)) {
      return NextResponse.json({ error: `invalid tier: ${String(it?.tier)}` }, { status: 400 });
    }
  }

  // Spend cap layers: per-visitor + global, checked before each turn.
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  const visitor = await checkPerVisitor(ip);
  if (!visitor.ok) return NextResponse.json({ error: visitor.message }, { status: 429 });
  const global = await checkGlobalSpend();
  if (!global.ok) return NextResponse.json({ error: global.message }, { status: 429 });

  // Key check AFTER validation + caps: input validation needs no secrets, and a
  // misconfigured server should still reject garbage rather than mask it as a
  // config error. This is also the reachable no-key path (501).
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    // BUILD §5: missing-key path must fail LOUDLY, not degrade silently.
    return NextResponse.json(
      { error: "GEMINI_API_KEY is not configured on the server. /api/step cannot run without it." },
      { status: 500 },
    );
  }

  // Render the pack from the snapshot (client sent ids+tiers only; server
  // renders the text — trust boundary §5). Reject unknown ids already done above.
  const byId = new Map(snapshot.symbols.map((s) => [s.id, s]));
  const packText = req.selection
    .map((item) => {
      const it = item as { id: string; tier: Tier };
      return render(byId.get(it.id)!, it.tier);
    })
    .join("");

  // Build Gemini contents: system pack as the first user turn, then the
  // conversation so far.
  const system = {
    role: "user",
    parts: [{ text: `You are ContextBudget. Here is the selected context pack:\n\n${packText}\n\nRespond to the task by proposing per-file diffs.` }],
  };
  // Rebuild each message from validated fields only. Splicing the client's
  // objects through would carry unknown keys into the provider payload; Gemini
  // happens to reject them, but that is the provider enforcing our boundary.
  const safeMessages = (req.messages as { role: string; parts: { text: string }[] }[]).map((m) => ({
    role: m.role,
    parts: m.parts.map((pt) => ({ text: pt.text })),
  }));
  const contents = [system, ...safeMessages];

  const geminiBody = {
    contents,
    generationConfig: {
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      // MEASURED. gemini-3.6-flash thinks unboundedly by default: 62.4s on a bare
      // prompt, past 120s on an 8k pack — and Vercel Hobby caps functions at 60s,
      // so it fails in production even when it works locally. thinkingBudget 512
      // brought that to 8.4s (0 is rejected, 400 INVALID_ARGUMENT).
      //
      // But flash-lite is the better answer: 0.8s, ZERO thinking tokens, and a
      // SEPARATE free-tier quota pool — 3.6-flash was already 429-exhausted while
      // lite still served. ~15x less quota burn per turn and 48x lower latency.
      // No thinkingConfig needed; lite does not think.
    },
  };

  // Replay: try live first; on 429/5xx play back a prior run for this repo+task.
  const live = await streamTurn(geminiBody, key, req.repo, String(req.messages?.length ?? 0));
  if (live.ok) return live.res;

  // 429 or provider error -> replay from Redis (if any), visibly labelled.
  const replay = await loadReplay(req.repo);
  if (replay) {
    return replayResponse(replay, req.repo, true);
  }
  return NextResponse.json(
    { error: `live turn failed and no replay available: ${live.error}` },
    { status: live.status },
  );
}

// ---- Gemini streaming turn (SSE) + cost accounting + record to Redis ----

async function streamTurn(
  geminiBody: unknown,
  key: string,
  repo: string,
  turnKey: string,
): Promise<{ ok: boolean; res: NextResponse; error?: string; status?: number }> {
  let upstream: Response;
  try {
    upstream = await fetch(GEMINI_URL, {
      method: "POST",
      // Key in a header, not the query string — query strings land in access logs.
      headers: { "Content-Type": "application/json", "X-goog-api-key": key },
      body: JSON.stringify(geminiBody),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, res: new NextResponse(null), error: String(e), status: 500 };
  }
  if (upstream.status === 429 || upstream.status >= 500 || !upstream.ok) {
    // Surface the provider's descriptive message (truncated) so failures aren't
    // opaque "provider 400"s — and log it server-side.
    let detail = "";
    try {
      const j = (await upstream.json()) as { error?: { message?: string } };
      detail = (j?.error?.message ?? "").slice(0, 200);
    } catch {
      // non-JSON body
    }
    const msg = `provider ${upstream.status}${detail ? `: ${detail}` : ""}`;
    console.error(`[step] ${msg}`);
    return { ok: false, res: new NextResponse(null), error: msg, status: upstream.status };
  }

  const encoder = new TextEncoder();
  const reader = upstream.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let candidatesTokenCount = 0;
  let thoughtsTokenCount = 0;
  let promptTokenCount = 0;
  let totalTokenCount = 0;
  let liveText = "";

  const stream = new ReadableStream({
    async start(controller) {
      // First SSE frame: mark as live.
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "status", live: true })}\n\n`));
      let frame = "";
      const processFrame = (raw: string) => {
        // Collect the JSON from all `data:` lines in a complete SSE frame
        // (a frame may span multiple lines; terminated by a blank line).
        let payload = "";
        for (const line of raw.split("\n")) {
          const t = line.trim();
          if (t.startsWith("data:")) payload += t.slice(5).trim();
        }
        if (!payload || payload === "[DONE]") return;
        let chunk: any;
        try {
          chunk = JSON.parse(payload);
        } catch {
          return; // partial/malformed frame
        }
        const cand = chunk?.candidates?.[0];
        const text = cand?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
        if (text) {
          liveText += text;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "delta", text })}\n\n`));
        }
        const usage = chunk?.usageMetadata;
        if (usage) {
          // Gemini streamGenerateContent returns usageMetadata with CUMULATIVE
          // per-chunk counts (running totals), not per-chunk deltas. Overwrite,
          // never += — summing cumulative counts double-counts output.
          candidatesTokenCount = usage.candidatesTokenCount ?? candidatesTokenCount;
          thoughtsTokenCount = usage.thoughtsTokenCount ?? thoughtsTokenCount;
          promptTokenCount = usage.promptTokenCount ?? promptTokenCount;
          totalTokenCount = usage.totalTokenCount ?? totalTokenCount;
        }
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // Gemini's SSE uses CRLF: frames are separated by "\r\n\r\n", never
        // "\n\n". Splitting on "\n\n" matched nothing, so every frame piled up in
        // the buffer and the trailing flush tried to JSON.parse the whole
        // concatenated stream — which threw into a silent catch. Result: a 25s
        // wait and zero output. Normalise first.
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        // SSE frames are terminated by a blank line.
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const f of frames) processFrame(f);
      }
      // Flush any trailing partial frame.
      if (buffer.trim()) processFrame(buffer);
      // Cost accounting: output = candidates + thoughts (BUILD §6); assert
      // accountedFor so a missed field fails loudly.
      const usage = {
        promptTokenCount,
        candidatesTokenCount,
        thoughtsTokenCount,
        totalTokenCount,
      };
      // A stream that ends with zero usage did not complete — it was cut, timed
      // out, or never started. Reporting a `done` frame with zeros presents a
      // failed turn as a successful one, which is exactly what hid the unbounded
      // -thinking timeout. Fail loudly instead.
      if (totalTokenCount === 0) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "error", error: "upstream produced no usage — turn was cut or timed out before completing" })}\n\n`,
          ),
        );
        controller.close();
        return;
      }
      if (!accountedFor(usage)) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", error: "cost accounting mismatch (accountedFor failed)" })}\n\n`));
      } else {
        const proj = project(usage);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "done", usage, projection: proj, outputTokens: outputTokens(usage) })}\n\n`));
        // Record HERE, not after streamTurn returns. start() runs lazily when the
        // consumer first reads, so a call placed after the return fired with
        // liveText === "" and nothing was ever recorded — which is why the 429
        // replay fallback had nothing to play back. Success path only.
        if (liveText) recordReplay(repo, turnKey, liveText).catch(() => {});
      }
      controller.close();
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });

  return { ok: true, res: new NextResponse(stream, { headers: { "Content-Type": "text/event-stream" } }) };
}

// ---- replay persistence (Upstash Redis, best-effort) ----

function upstash(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

async function recordReplay(repo: string, turnKey: string, text: string): Promise<void> {
  const cfg = upstash();
  if (!cfg || !text) return;
  const key = `replay:${repo}`;
  const body = JSON.stringify({ repo, turnKey, text, ts: Date.now() });
  await fetch(`${cfg.url}/lpush/${key}/${encodeURIComponent(body)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}` },
  }).catch(() => {});
}

async function loadReplay(repo: string): Promise<string | null> {
  const cfg = upstash();
  if (!cfg) return null;
  const res = await fetch(`${cfg.url}/lrange/replay:${repo}/0/0`, {
    headers: { Authorization: `Bearer ${cfg.token}` },
  }).catch(() => null);
  if (!res?.ok) return null;
  const data = (await res.json()) as { result?: string[] };
  if (!data.result?.length) return null;
  try {
    return JSON.parse(data.result[0]).text as string;
  } catch {
    return null;
  }
}

function replayResponse(text: string, repo: string, _replay: boolean): NextResponse {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "status", live: false, replay: true, note: "REPLAY — this is a prior recorded run, not a live result" })}\n\n`));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "delta", text })}\n\n`));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "done", replay: true })}\n\n`));
      controller.close();
    },
  });
  void repo;
  return new NextResponse(stream, { headers: { "Content-Type": "text/event-stream" } });
}
