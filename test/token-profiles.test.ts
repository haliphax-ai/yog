import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROFILE,
  createOverlayLoader,
  overlayFromJson,
  overlaySlug,
  profileOptions,
  profileToJson,
  type TokenProfile,
} from "../src/toolkit/index.ts";
import { estimateTokenCountWithProfile } from "../src/toolkit/index.ts";

const readFileOf = (files: Record<string, string>) => async (path: string) => {
  // The loader passes a stateRoot-joined path; match on the profiles/ suffix.
  const key = Object.keys(files).find((k) => path.endsWith(k));
  if (key === undefined) {
    const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  }
  return files[key] as string;
};

describe("overlaySlug", () => {
  it("folds / to _ and drops provider-tier suffixes", () => {
    expect(overlaySlug("nvidia/nemotron-3-ultra-550b-a55b")).toBe(
      "nvidia_nemotron-3-ultra-550b-a55b",
    );
    expect(overlaySlug("nvidia/nemotron-3-ultra-550b-a55b:free")).toBe(
      "nvidia_nemotron-3-ultra-550b-a55b",
    );
    expect(overlaySlug("z-ai/glm-5.3-flash:free")).toBe("z-ai_glm-5.3-flash");
  });
});

describe("overlay load rules", () => {
  it("falls through to the default when no overlay exists", async () => {
    const load = createOverlayLoader("/state", { readFile: readFileOf({}) });
    await expect(load("nvidia/nemotron-3-ultra")).resolves.toEqual(DEFAULT_PROFILE);
  });

  it("uses the overlay for the exact slug (:free folds to base)", async () => {
    const profile: TokenProfile = {
      defaultCharsPerToken: 2.0,
      languageConfigs: [{ pattern: /[{}[\]":,]/, averageCharsPerToken: 2.6 }],
    };
    const load = createOverlayLoader("/state", {
      readFile: readFileOf({ "profiles/nvidia_nemotron-3-ultra.json": profileToJson(profile) }),
    });
    await expect(load("nvidia/nemotron-3-ultra:free")).resolves.toMatchObject({
      defaultCharsPerToken: 2.0,
    });
  });

  it("ignores malformed overlays and degrades to the default", async () => {
    const log = vi.fn();
    const load = createOverlayLoader("/state", {
      readFile: readFileOf({ "profiles/broken.json": "{ not json" }),
      log,
    });
    await expect(load("broken")).resolves.toEqual(DEFAULT_PROFILE);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("unreadable"));
  });

  it("rejects overlays with a non-positive rate", () => {
    expect(() => overlayFromJson({ defaultCharsPerToken: 0 })).toThrow(/positive/);
    expect(() => overlayFromJson({})).toThrow(/positive/);
    expect(() => overlayFromJson("nope")).toThrow(/not an object/);
    expect(() =>
      overlayFromJson({ defaultCharsPerToken: 2, languageConfigs: [{ averageCharsPerToken: 1 }] }),
    ).toThrow(/languageConfig/);
  });

  it("round-trips a class-based profile through JSON", () => {
    const profile: TokenProfile = {
      defaultCharsPerToken: 2.0,
      languageConfigs: [
        { pattern: /[{}\[\]":,]/, averageCharsPerToken: 2.6 },
        { pattern: /[A-Za-z]{2,}/, averageCharsPerToken: 3.5 },
      ],
    };
    const parsed = overlayFromJson(JSON.parse(profileToJson(profile)));
    expect(parsed.defaultCharsPerToken).toBe(2.0);
    expect(parsed.languageConfigs).toHaveLength(2);
    // Live regex survives the round trip and prices JSON at the class rate.
    const opts = profileOptions(parsed);
    expect(opts.languageConfigs?.[0]?.pattern.test('{"a":1}')).toBe(true);
  });
});

describe("estimateTokenCountWithProfile", () => {
  it("scales with the profile rate on unmatched segments", () => {
    const text = "abcdefghij"; // 10-char word: past tokenx's single-token word threshold
    expect(estimateTokenCountWithProfile(text, { defaultCharsPerToken: 1.5 })).toBe(7);
    expect(estimateTokenCountWithProfile(text, { defaultCharsPerToken: 2.5 })).toBe(4);
    expect(estimateTokenCountWithProfile(text, DEFAULT_PROFILE)).toBe(7);
  });

  it("applies languageConfig classes before the default rate", () => {
    // 12 chars of pure JSON punctuation: the custom class config wins over
    // tokenx's built-in 6 c/t punctuation rule (rate 10 halves the count vs
    // the built-in; rate 2 raises it). Values are pinned observations.
    const t = `{}[]":,{}[]":,`;
    const at = (r: number): number =>
      estimateTokenCountWithProfile(t, {
        defaultCharsPerToken: 3,
        languageConfigs: [{ pattern: /[{}\[\]":,]/, averageCharsPerToken: r }],
      });
    expect(at(10)).toBe(2);
    expect(at(2)).toBe(7);
    expect(at(4)).toBe(4);
  });
});
