import { describe, expect, it } from "vitest";
import {
  calibrateFromSamples,
  extractCalibrationSamples,
  fitRate,
  type CalibSample,
} from "../src/calibrate.ts";

describe("extractCalibrationSamples", () => {
  const toolResult = (turnId: number, usage: unknown, extra: Record<string, unknown> = {}) => ({
    turn_id: turnId,
    type: "tool.result",
    payload: { usage, ...extra },
  });

  it("pairs each assistant round with the usage recorded on its tool.result", () => {
    const rows = [
      { role: "user", content: "hello", turn_id: 1 },
      { role: "assistant", content: "", tool_calls_json: '{"name":"bash"}', turn_id: 1 },
      { role: "tool", content: '{"stdout":"out"}', turn_id: 1 },
      { role: "assistant", content: "done", turn_id: 2 },
    ];
    const events = [toolResult(1, { prompt_tokens: 500 })];
    const samples = extractCalibrationSamples(rows, events);
    expect(samples).toHaveLength(1);
    // Boundary semantics: the sample covers all rows *before* the assistant
    // row (the request as sent) — here, the 5-char user row.
    expect(samples[0]).toMatchObject({ chars: 5, tokens: 500, tier: "reported" });
  });

  it("excludes cache-warm rounds (cached_tokens > 0) from the fit", () => {
    const rows = [
      { role: "assistant", content: "", turn_id: 1 },
      { role: "assistant", content: "", turn_id: 2 },
    ];
    const events = [
      toolResult(1, { prompt_tokens: 500, prompt_tokens_details: { cached_tokens: 0 } }),
      toolResult(2, { prompt_tokens: 170, prompt_tokens_details: { cached_tokens: 346 } }),
    ];
    const samples = extractCalibrationSamples(rows, events);
    expect(samples).toHaveLength(1);
    expect(samples[0]?.tokens).toBe(500);
  });

  it("keeps warm rounds when a reconciled native count overrides them", () => {
    const rows = [{ role: "assistant", content: "", turn_id: 1 }];
    const events = [
      toolResult(
        1,
        { prompt_tokens: 170, prompt_tokens_details: { cached_tokens: 346 } },
        { native_tokens_prompt: 517 },
      ),
    ];
    const samples = extractCalibrationSamples(rows, events);
    expect(samples).toEqual([{ chars: 0, tokens: 517, tier: "native" }]);
  });

  it("sums content + tool_calls chars cumulatively across rows", () => {
    const rows = [
      { role: "user", content: "12345", turn_id: 1 },
      { role: "assistant", content: "", tool_calls_json: "1234567890", turn_id: 1 },
      { role: "tool", content: "x", turn_id: 1 },
      { role: "assistant", content: "abc", turn_id: 2 },
    ];
    const events = [
      toolResult(1, { prompt_tokens: 100 }),
      toolResult(2, { prompt_tokens: 150 }),
    ];
    const samples = extractCalibrationSamples(rows, events);
    // Round 1 request = the user row (5). Round 2 request adds the
    // assistant row (10) + tool result (1) -> 16. The final assistant's own
    // 3 chars land after its sample (they belong to a next request).
    expect(samples.map((s) => s.chars)).toEqual([5, 16]);
  });
});

describe("fitRate + quality gate", () => {
  const perfect: CalibSample[] = [
    { chars: 0, tokens: 250, tier: "reported" },
    { chars: 100_000, tokens: 350, tier: "reported" },
    { chars: 400_000, tokens: 650, tier: "reported" },
    { chars: 800_000, tokens: 1050, tier: "reported" },
  ];

  it("fits intercept + rate on clean data", () => {
    const fit = fitRate(perfect);
    expect(fit.interceptTokens).toBeCloseTo(250, 0);
    expect(fit.rate).toBeCloseTo(1 / 1000, 5);
  });

  it("writes the overlay when gate passes and profile slug applies", async () => {
    const writes: Array<[string, string]> = [];
    const outcome = await calibrateFromSamples("nvidia/nemotron-3-ultra:free", perfect, {
      slugFor: (m) => m.split(":")[0] ?? m,
      writeOverlay: async (slug, json) => {
        writes.push([slug, json]);
        return `/state/profiles/${slug}.json`;
      },
    });
    expect(outcome.written).toBe(true);
    if (!outcome.written) throw new Error("unreachable");
    expect(writes[0]?.[0]).toBe("nvidia/nemotron-3-ultra");
    const parsed = JSON.parse(writes[0]?.[1] as string);
    expect(parsed.profile.defaultCharsPerToken).toBeCloseTo(1000, 0);
    expect(parsed.fit.samples).toBe(4);
  });

  it("refuses when too few cold samples", async () => {
    const outcome = await calibrateFromSamples("m", perfect.slice(0, 3), {
      slugFor: (m) => m,
      writeOverlay: async () => "/never",
    });
    expect(outcome.written).toBe(false);
    if (outcome.written) throw new Error("unreachable");
    expect(outcome.reason).toMatch(/trustworthy/);
    expect(outcome.needed).toBe(4);
  });

  it("refuses when the fit is bad (outlier rounds)", async () => {
    const dirty: CalibSample[] = [
      ...perfect,
      { chars: 200_000, tokens: 5_000, tier: "reported" }, // poisoned round
    ];
    const outcome = await calibrateFromSamples("m", dirty, {
      slugFor: (m) => m,
      writeOverlay: async () => "/never",
    });
    expect(outcome.written).toBe(false);
    if (outcome.written) throw new Error("unreachable");
    expect(outcome.reason).toMatch(/MAPE/);
  });
});
