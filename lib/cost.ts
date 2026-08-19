// Cost is a PROJECTION, not a bill (BUILD.md §6). The demo runs on Gemini's free
// tier, so real spend is $0 - but showing "$0" throws away the product's point.
// Price the pack against published rates for several models instead.
//
// CRITICAL: gemini-3.6-flash reasons by default and bills thinking as output.
// Measured on a one-word reply: prompt=6, candidates=1, thoughts=92, total=99.
// Thinking was 93% of the turn. Output = candidates + thoughts, never candidates
// alone - that undercounts by an order of magnitude.

export interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
}

export interface Projection {
  model: string;
  inputUsd: number;
  outputUsd: number;
  totalUsd: number;
  /** True when this model is on a free tier: showing "$0.0000" reads as a broken
   *  readout, so the UI labels it instead of printing a zero. */
  free: boolean;
  /** True for the model that actually served this turn; the others are what the
   *  same pack WOULD have cost elsewhere. */
  served: boolean;
}

// $ per million tokens, [input, output].
/** The model actually running turns. Everything else in RATES is a comparison. */
export const SERVING_MODEL = "gemini-3.5-flash-lite";

const RATES: Record<string, [number, number]> = {
  "claude-opus-5": [5, 25],
  "claude-sonnet-5": [3, 15],
  "gemini-3.5-flash-lite": [0, 0], // free tier - the model actually serving turns
};

export function promptTokens(u: GeminiUsage): number {
  return u.promptTokenCount ?? 0;
}

/** Billable output = visible answer + reasoning tokens. */
export function outputTokens(u: GeminiUsage): number {
  return (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
}

/** Sanity check against the API's own total; drift means a field was missed. */
export function accountedFor(u: GeminiUsage): boolean {
  const total = u.totalTokenCount;
  if (total === undefined) return true;
  return promptTokens(u) + outputTokens(u) === total;
}

/** What this turn would have cost on each model. */
export function project(u: GeminiUsage): Projection[] {
  const inTok = promptTokens(u);
  const outTok = outputTokens(u);
  return Object.entries(RATES).map(([model, [i, o]]) => {
    const inputUsd = (inTok * i) / 1e6;
    const outputUsd = (outTok * o) / 1e6;
    return {
      model,
      inputUsd,
      outputUsd,
      totalUsd: inputUsd + outputUsd,
      free: i === 0 && o === 0,
      served: model === SERVING_MODEL,
    };
  });
}
