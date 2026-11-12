/**
 * `yog calibrate <sessionId>` — fit a tokenx profile for a session's model
 * from the session's own recorded traffic.
 *
 * Offline and DB-only: reads the sessions store, fits
 * `tokens = intercept + rate x chars` over *trustworthy* rounds, writes
 * `$STATE_ROOT/profiles/<model-slug>.json` on success. No network, no key.
 *
 * Trustworthiness is the whole game: reported `prompt_tokens` on cache-warm
 * rounds excludes the cached prefix, so fitting against them under-counts
 * ~2.5x. The sample filter keeps only rounds whose report covers the full
 * prefix (cold by construction, cold by `cached_tokens: 0`, or reconciled
 * native counts — the strongest tier, when present).
 */

/** One trustworthy (chars, tokens) sample. */
export interface CalibSample {
  /** Serialized request size in chars (transcript + tool_calls JSON). */
  chars: number;
  /** Native prompt tokens reported for the request carrying that prefix. */
  tokens: number;
  /** Where the count came from — `native` outranks `reported`. */
  tier: "native" | "reported";
}

/** A fitted profile + its quality record, ready for overlay write. */
export interface CalibrationFit {
  model: string;
  interceptTokens: number;
  rate: number;
  mape: number;
  worst: number;
  samples: number;
}

/**
 * Extract calibration samples from one session's event log.
 *
 * Rounds are reconstructed exactly as the incident analysis did: cumulative
 * `content + tool_calls_json` length of all transcript rows *before* each
 * assistant round, paired with the `usage.prompt_tokens` that round's
 * `tool.result` events carried. Trust filter: round 1 of any turn (cold by
 * construction), rounds with `cached_tokens` 0/absent, and reconciled
 * `native_tokens_prompt` overrides when the event log carries them.
 */
export function extractCalibrationSamples(
  rows: Array<Record<string, unknown>>,
  events: Array<{ turn_id: number; type: string; payload: Record<string, unknown> }>,
): CalibSample[] {
  // tool.result events by turn: (prompt_tokens, cached, nativeOverride)
  type RoundUsage = { prompt?: number; cached?: number; native?: number };
  const byTurn = new Map<number, RoundUsage>();
  for (const ev of events) {
    if (ev.type !== "tool.result") continue;
    const usage = ev.payload.usage as Record<string, unknown> | undefined;
    if (usage === undefined) continue;
    const cur: RoundUsage = byTurn.get(ev.turn_id) ?? {};
    const p = usage.prompt_tokens;
    if (typeof p === "number" && cur.prompt === undefined) cur.prompt = p;
    const details = usage.prompt_tokens_details as Record<string, unknown> | undefined;
    const cached = details?.cached_tokens;
    if (typeof cached === "number" && cur.cached === undefined) cur.cached = cached;
    // L2 reconciliation writes native counts under a known key when present.
    const native = (ev.payload as Record<string, unknown>).native_tokens_prompt;
    if (typeof native === "number" && cur.native === undefined) cur.native = native;
    byTurn.set(ev.turn_id, cur);
  }

  // Cumulative chars; the usage recorded on turn T's tool.result events
  // measures the request that *preceded* the round — i.e. all rows before
  // turn T's assistant row. Snapshot the size at the boundary, then add the
  // row itself after sampling (assistant output of round T is part of the
  // *next* request, not this one).
  let chars = 0;
  const samples: CalibSample[] = [];
  for (const row of rows) {
    const role = String(row.role ?? "");
    const turnId = typeof row.turn_id === "number" ? row.turn_id : undefined;
    if (role === "assistant" && turnId !== undefined) {
      const u = byTurn.get(turnId);
      if (u !== undefined) {
        const tokens = u.native ?? u.prompt;
        // Cold-round filter: cached 0/absent (or native override, which is
        // the real total by construction). Warm rounds are skipped — they
        // report only the uncached tail and would poison the fit.
        const cold = u.native !== undefined || u.cached === undefined || u.cached === 0;
        if (tokens !== undefined && cold) {
          samples.push({ chars, tokens, tier: u.native !== undefined ? "native" : "reported" });
        }
      }
    }
    const content = typeof row.content === "string" ? (row.content as string) : "";
    const calls =
      row.tool_calls_json !== undefined && row.tool_calls_json !== null
        ? String(row.tool_calls_json)
        : Array.isArray(row.tool_calls)
          ? JSON.stringify(row.tool_calls)
          : "";
    chars += content.length + calls.length;
  }
  return samples;
}

/** Least-squares fit of `tokens = intercept + rate x chars` over samples. */
export function fitRate(samples: CalibSample[]): CalibrationFit {
  const n = samples.length;
  if (n < 2) throw new Error("need at least 2 samples to fit");
  let sx = 0,
    sy = 0,
    sxx = 0,
    sxy = 0;
  for (const s of samples) {
    sx += s.chars;
    sy += s.tokens;
    sxx += s.chars * s.chars;
    sxy += s.chars * s.tokens;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) {
    // Degenerate (all samples same size): rate from the mean ratio.
    const rate = samples.reduce((a, s) => a + s.tokens / Math.max(1, s.chars), 0) / n;
    const intercept = samples.reduce((a, s) => a + s.tokens, 0) / n - rate * (sx / n);
    return finalize({ interceptTokens: intercept, rate, samples: n }, samples);
  }
  const rate = (n * sxy - sx * sy) / denom;
  const intercept = (sy - rate * sx) / n;
  return finalize({ interceptTokens: intercept, rate, samples: n }, samples);
}

/** Attach fit-quality metrics (MAPE / worst over the sample set). */
function finalize(
  f: Omit<CalibrationFit, "mape" | "worst" | "model">,
  samples: CalibSample[],
): CalibrationFit {
  let absSum = 0;
  let worst = 0;
  for (const s of samples) {
    const pred = f.interceptTokens + f.rate * s.chars;
    const err = Math.abs(pred - s.tokens) / Math.max(1, s.tokens);
    absSum += err;
    if (err > worst) worst = err;
  }
  return { model: "", ...f, mape: absSum / samples.length, worst };
}

/** Result of trying to calibrate: either an overlay write or a refusal. */
export type CalibrateOutcome =
  | { written: true; path: string; fit: CalibrationFit }
  | { written: false; reason: string; qualified: number; needed: number };

export interface CalibrateOptions {
  /** Model id -> overlay slug (injected; the toolkit owns slug rules). */
  slugFor: (modelId: string) => string;
  /** Minimum trustworthy samples required before an overlay is written. */
  minSamples?: number;
  /** Max tolerated fit MAPE (default 0.15 = 15%). */
  maxMape?: number;
  /** Overlay writer (defaults to state root profiles dir via deps). */
  writeOverlay?: (slug: string, json: string) => Promise<string>;
}

/**
 * Run the fit for one session's samples and write the overlay when the
 * quality gate passes. Gate: >= minSamples qualified samples and MAPE <=
 * maxMape. A refused fit prints how many more cold rounds are needed — a
 * bad profile is worse than the neutral default.
 */
export async function calibrateFromSamples(
  model: string,
  samples: CalibSample[],
  opts: CalibrateOptions & { writeOverlay: (slug: string, json: string) => Promise<string> },
): Promise<CalibrateOutcome> {
  const minSamples = opts.minSamples ?? 4;
  const maxMape = opts.maxMape ?? 0.15;
  if (samples.length < minSamples) {
    return {
      written: false,
      reason: `only ${samples.length} trustworthy (cold) samples; need ${minSamples}`,
      qualified: samples.length,
      needed: minSamples,
    };
  }
  const fit = { ...fitRate(samples), model };
  if (fit.mape > maxMape) {
    return {
      written: false,
      reason: `fit MAPE ${(fit.mape * 100).toFixed(1)}% exceeds gate ${(maxMape * 100).toFixed(1)}%`,
      qualified: samples.length,
      needed: minSamples,
    };
  }
  const slug = opts.slugFor(model);
  const json = JSON.stringify(
    {
      model,
      profile: { defaultCharsPerToken: 1 / fit.rate },
      fit: {
        kind: "single-rate",
        mape: fit.mape,
        worst: fit.worst,
        samples: fit.samples,
        interceptTokens: Math.round(fit.interceptTokens),
      },
      source: { calibratedAt: new Date().toISOString() },
    },
    null,
    2,
  );
  const path = await opts.writeOverlay(slug, json);
  return { written: true, path, fit };
}
