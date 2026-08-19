// Three-layer spend cap (BUILD.md §5). Plumbing is complete; it activates when
// the Upstash env vars are present. When absent, checks report disabled rather
// than failing the request - the deploy sets these vars.

const GLOBAL_CEILING_CENTS = 2500; // spend is accumulated in CENTS; comparing
// against 25 tripped the cap at $0.25 // dollars
const PER_VISITOR_LIMIT = 3; // runs per IP per 24h

export interface CapResult {
  ok: boolean;
  layer: "per-visitor" | "global" | "ok" | "disabled";
  message?: string;
}

function upstashConfig(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}

async function redisIncr(key: string, ttlSeconds?: number): Promise<number> {
  const cfg = upstashConfig();
  if (!cfg) throw new Error("Upstash not configured");
  const res = await fetch(`${cfg.url}/incr/${key}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}` },
  });
  if (!res.ok) throw new Error(`upstash incr failed: ${res.status}`);
  const data = (await res.json()) as { result?: number };
  // Arm the TTL ONLY when the counter is newly created (incr returns 1). Setting
  // it on every incr re-armed the 24h window on each request, so an active visitor
  // pushed their own expiry forward forever and stayed blocked permanently.
  if (ttlSeconds && data.result === 1) {
    // Best-effort TTL for the per-visitor window.
    await fetch(`${cfg.url}/expire/${key}/${ttlSeconds}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}` },
    }).catch(() => {});
  }
  return data.result ?? 0;
}

async function redisGet(key: string): Promise<number> {
  const cfg = upstashConfig();
  if (!cfg) throw new Error("Upstash not configured");
  const res = await fetch(`${cfg.url}/get/${key}`, {
    headers: { Authorization: `Bearer ${cfg.token}` },
  });
  const data = (await res.json()) as { result?: number | string };
  return Number(data.result ?? 0);
}

// Per-visitor: 3 runs / IP / 24h. keyed by IP; 86400s TTL.
export async function checkPerVisitor(ip: string): Promise<CapResult> {
  if (!upstashConfig()) return { ok: true, layer: "disabled" };
  const key = `cap:ip:${ip}`;
  const count = await redisIncr(key, 86400);
  if (count > PER_VISITOR_LIMIT) {
    return { ok: false, layer: "per-visitor", message: `over per-visitor limit (${count}/${PER_VISITOR_LIMIT} runs)` };
  }
  return { ok: true, layer: "ok" };
}

// Global: $25 ceiling, checked BEFORE each turn.
export async function checkGlobalSpend(): Promise<CapResult> {
  if (!upstashConfig()) return { ok: true, layer: "disabled" };
  const spent = await redisGet("cap:global:spend");
  if (spent >= GLOBAL_CEILING_CENTS) {
    return { ok: false, layer: "global", message: `global spend ${spent.toFixed(2)} >= ${GLOBAL_CEILING_CENTS}` };
  }
  return { ok: true, layer: "ok" };
}

// Record spend after a turn, priced by the layered accounting.
export async function recordSpend(usd: number): Promise<void> {
  if (!upstashConfig()) return;
  await fetch(`${upstashConfig()!.url}/incrby/cap:global:spend/${Math.round(usd * 100)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${upstashConfig()!.token}` },
  }).catch(() => {});
}
