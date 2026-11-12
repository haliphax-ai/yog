import { join } from "node:path";

/**
 * Token estimation profiles — the seam between tokenx and the daemon.
 *
 * tokenx (`estimateTokenCount`) prices text by character-class heuristics;
 * the right constants depend on the model family (measured native rates on
 * agent-transcript content vary ~2.5x across models: ~2.0 c/t for
 * GLM/ernie-class vs 2.56 c/t for nemotron-3-ultra). No profile ships
 * pre-baked: the shipped {@link DEFAULT_PROFILE} is deliberately neutral,
 * and per-model overlays are *fitted from recorded traffic* by
 * `yog calibrate <sessionId>` (see docs; fit writes
 * `$STATE_ROOT/profiles/<slug>.json` which this loader reads).
 *
 * The estimator is not load-bearing for safety: native provider usage
 * (Layer 1) is authoritative whenever a session has any, and display uses
 * the profile only to bridge the one-round gap before the next usage chunk
 * lands (native provider usage is authoritative whenever a session has any).
 */

/** Single-pass token-estimation profile for tokenx. */
export interface TokenProfile {
  /** Chars per token for segments no language config prices (default 7). */
  defaultCharsPerToken: number;
  /** Ordered class detectors; the first match wins for a segment. */
  languageConfigs?: Array<{ pattern: RegExp; averageCharsPerToken: number }>;
}

/**
 * Neutral default used until a per-model overlay is fitted. Documented
 * band on agent-transcript content across observed models: ~-40%
 * (nemotron-class) to ~+50% (GLM/ernie-class) vs native counts, worse on
 * prose-heavy content. Fine for the bridged tail; never treated as truth.
 */
export const DEFAULT_PROFILE: TokenProfile = { defaultCharsPerToken: 1.5 };

/** Options object for tokenx built from a profile (pattern objects survive
 *  JSON round-trips as `{source, flags}`, so they are rehydrated here). */
export function profileOptions(profile: TokenProfile): {
  defaultCharsPerToken: number;
  languageConfigs?: Array<{ pattern: RegExp; averageCharsPerToken: number }>;
} {
  const configs = profile.languageConfigs?.map((c) => ({
    pattern: new RegExp(
      typeof c.pattern === "string"
        ? (c as unknown as { pattern: string }).pattern
        : c.pattern.source,
      typeof c.pattern === "string"
        ? ((c as unknown as { flags?: string }).flags ?? "")
        : c.pattern.flags,
    ),
    averageCharsPerToken: c.averageCharsPerToken,
  }));
  return {
    defaultCharsPerToken: profile.defaultCharsPerToken,
    ...(configs !== undefined ? { languageConfigs: configs } : {}),
  };
}

/** Serialize a profile for an overlay file (regexes -> strings). */
export function profileToJson(profile: TokenProfile): string {
  return JSON.stringify(
    {
      defaultCharsPerToken: profile.defaultCharsPerToken,
      ...(profile.languageConfigs !== undefined
        ? {
            languageConfigs: profile.languageConfigs.map((c) => ({
              source: c.pattern.source,
              flags: c.pattern.flags,
              averageCharsPerToken: c.averageCharsPerToken,
            })),
          }
        : {}),
    },
    null,
    2,
  );
}
/**
 * Overlay-file loader factory: returns a resolver `modelId -> TokenProfile`
 * for a state root. File layout: `<stateRoot>/profiles/<slug>.json` where
 * slug = model id with `/` → `_` and a `:free` suffix folded onto the base
 * model (an overlay fitted from free-tier traffic applies to the paid slug
 * of the same base model and vice versa; native rates are a tokenizer
 * property, not a routing property).
 *
 * The daemon builds this once at startup (§plan: no hot reload; a restart
 * applies newly written overlays). Missing files fall through; malformed
 * files are logged once and ignored — a bad overlay must degrade to the
 * neutral default, never break a turn.
 */
export function createOverlayLoader(
  stateRoot: string,
  opts: {
    readFile: (path: string) => Promise<string>;
    log?: (msg: string) => void;
  },
): (modelId: string) => Promise<TokenProfile> {
  const cache = new Map<string, Promise<TokenProfile>>();
  const { readFile, log = () => {} } = opts;
  return (modelId) => {
    const slug = overlaySlug(modelId);
    const key = slug;
    let entry = cache.get(key);
    if (entry === undefined) {
      entry = (async () => {
        const file = join(stateRoot, "profiles", `${slug}.json`);
        try {
          const raw = JSON.parse(await readFile(file));
          const profile = overlayFromJson(raw);
          log(
            `[token-profiles] overlay ${file}: defaultCharsPerToken=${profile.defaultCharsPerToken}`,
          );
          return profile;
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
            log(
              `[token-profiles] overlay ${file} unreadable (${(err as Error).message}); using default`,
            );
          }
          return DEFAULT_PROFILE;
        }
      })();
      cache.set(key, entry);
    }
    return entry;
  };
}

/** Model id → overlay slug: `/` → `_`, `:free` and other `:…` suffixes dropped. */
export function overlaySlug(modelId: string): string {
  const [base] = modelId.split(":");
  return (base ?? modelId).replaceAll("/", "_");
}

/** Parse an overlay file (see `profileToJson`) into a live profile. */
export function overlayFromJson(raw: unknown): TokenProfile {
  if (typeof raw !== "object" || raw === null) throw new Error("overlay: not an object");
  const r = raw as Record<string, unknown>;
  const rate = r.defaultCharsPerToken;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
    throw new Error("overlay: defaultCharsPerToken must be a positive number");
  }
  let configs: TokenProfile["languageConfigs"];
  if (r.languageConfigs !== undefined) {
    if (!Array.isArray(r.languageConfigs))
      throw new Error("overlay: languageConfigs must be an array");
    configs = r.languageConfigs.map((c) => {
      if (typeof c !== "object" || c === null) throw new Error("overlay: bad languageConfig");
      const cc = c as Record<string, unknown>;
      if (typeof cc.source !== "string" || typeof cc.averageCharsPerToken !== "number") {
        throw new Error("overlay: languageConfig needs {source, averageCharsPerToken}");
      }
      return {
        pattern: new RegExp(cc.source, typeof cc.flags === "string" ? cc.flags : ""),
        averageCharsPerToken: cc.averageCharsPerToken,
      };
    });
  }
  return {
    defaultCharsPerToken: rate,
    ...(configs !== undefined ? { languageConfigs: configs } : {}),
  };
}
