# Plan: Token Accuracy — Default Profile + Per-Session Calibration Script

**Repo:** `~/workspace/yog` · **Status:** plan (v3) · **Origin:** session `ebbc0bd8` incident (2026-11-12)

> **Implementation note.** P0+P1+P2 of this plan shipped on `feat/token-accuracy`
> (calibrated estimator + native-usage capture + `yog calibrate`). P3
> (OpenRouter `/generation` reconciliation, reroute events, class-based fits)
> remains open. The in-session write-behind fitter discussed in review is also
> still open — the offline gate-protected script is the only overlay writer
> for now.

> **v3 changes.** Per-model profiles shipped in code are dead (they vary 2.5× across
> models and drift with upstream routing). What ships instead: one documented default
> profile + `yog calibrate <sessionId>` — an offline script the daemon user runs
> against a session's own recorded traffic to fit a profile for that session's model.
> v2's context guard stays dead: the goal is accurate counts, not intervention.
> New: measured synthetic→native latency and the one-round display bridge it implies.

---

## 1. What we now know (evidence, unchanged from v2)

1. **`prompt_tokens` is not window occupancy when the cache is warm.** Identical
   ~529k-char prefixes measured 516,717 (fresh cache), 170,883 (warm round), and
   ≥1,048,576 (evicted, rejected) on the same provider. Cache-cold reported values are
   accurate; warm values are billing-relevant, not occupancy-relevant.
2. **OpenRouter reports native-tokenizer usage on every response** — always, both APIs,
   no flag (the `usage:{include:true}` family is a documented deprecated no-op). yog
   merges three summary fields in `turn.ts` and discards `prompt_tokens_details`,
   `cost`, and the `gen-…` id.
3. **Estimator accuracy is content-class-dependent and model-dependent.** Measured
   native rates on agent-transcript classes: tool results 2.56 c/t (nemotron-3-ultra),
   ~2.0 (GLM-5.3-flash), ~2.05 (ernie); prose 3.7; short user strings 3–4.2.
   tokenx defaults under-count tool-heavy content by ~33%; the old hand-rolled toolkit
   fork by ~2×; the v1 1.0 c/t floor over-counts nemotron by ~2×.

## 2. Synthetic vs native: the one-round gap (measured)

`tool.result` events carry the tokenx estimate (`resultTokens`) **immediately**; the
native count covering those bytes lands with the **next** round's usage chunk — i.e.
one full model round-trip later (tool execution + next stream), or at `turn.finished`
for the terminal round. From the incident session:

| turn (model, rounds) | median | p90   | max   |
| -------------------- | ------ | ----- | ----- |
| 68 (ernie, 124)      | 4.1s   | 7.5s  | 18.1s |
| 74 (GLM, 263)        | 7.6s   | 24.1s | 77.1s |

Consequences:

- **The native gauge is structurally one round stale.** When it lands it covers
  everything up through the request that carried the previous results — but newer
  results have already been appended.
- **The estimator's display job is to bridge that gap**, not to re-estimate the whole
  transcript: `display = last_native + calibrated(bytes appended since)`. This is why a
  rough default profile is acceptable: the bridged delta is small relative to the
  transcript, and native truth replaces it every round.
- The one case with no native anchor at all is a session's **first** round and
  post-restart display — the default profile covers those, labeled as an estimate.

## 3. Architecture (v3)

```
┌────────────────────────────────────────────────────────────────────┐
│ L2  OpenRouter enrichment (feature-detected, optional)             │
│     /generation reconcile · provider_name reroutes · cost          │
├────────────────────────────────────────────────────────────────────┤
│ L1  Standard native-usage capture (any OpenAI-compatible provider) │
│     prompt_tokens(+details) verbatim · gen/request ids · error path│
├────────────────────────────────────────────────────────────────────┤
│ L0  Calibrated estimator: DEFAULT profile + per-session script     │
│     `yog calibrate <sessionId>` · overlay files, nothing pre-baked │
└────────────────────────────────────────────────────────────────────┘
```

### 3.1 Layer 0 — one estimator, default profile, calibrated overlays

- Kill the hand-rolled `estimateTokenCount` in `src/toolkit/truncation.ts`; re-export
  tokenx-with-profiles from `src/toolkit/index.ts`. `/shake`'s `contextSize` and
  compaction budgeting use it.
- New `src/toolkit/token-profiles.ts`:
  ```ts
  export interface TokenProfile {
    /** Base rate for unmatched segments (chars per token). */
    defaultCharsPerToken: number;
    languageConfigs: Array<{ pattern: RegExp; averageCharsPerToken: number }>;
  }
  /**
   * Neutral default until calibrated. Documented band on agent-transcript
   * content across observed models: −40% (nemotron-class) to +50%
   * (GLM/ernie-class), degrading to ±100% on prose-heavy content.
   * Display prefers native usage (L1) and uses this only for the
   * not-yet-covered tail (§2) — the default is rarely load-bearing.
   */
  export const DEFAULT_PROFILE: TokenProfile = { defaultCharsPerToken: 1.5 };
  export function profileFor(modelId: string, load: OverlayLoader): TokenProfile {
    return load(modelId) ?? DEFAULT_PROFILE;
  }
  ```
- **Overlay loader**: reads `$STATE_ROOT/profiles/<model-slug>.json` at daemon start
  (slug = model id with `/`→`_`, `:free` suffix folded onto the base model). If the
  file exists it wins; malformed overlays are logged once and ignored. No hot-reload
  in v1 of this plan (restart applies).
- Nothing else ships pre-baked. The nemotron profile produced during calibration lives
  in `~/workspace/yog-token-calibration/` as an **example artifact**, not in code.

### 3.2 `yog calibrate <sessionId>` — the per-session script

New CLI subcommand (alongside the existing `skills` dispatch in `src/cli.ts` /
`src/skills/commands.ts` pattern). Offline, read-only against the DB except for the
overlay write; no API key, no network.

**Inputs:** session id (required); optional `--out <path>`, `--min-samples <n>`
(default 4), `--classes` (fit class-based vs single-rate; default auto).

**Sample extraction** (pure DB work, mirrors the incident analysis):

1. Reconstruct per-round `(chars_prefix, prompt_tokens)` pairs: cumulative
   `length(content) + length(tool_calls_json)` of all rows before each assistant round,
   paired with the `usage.prompt_tokens` recorded on that round's `tool.result` events.
2. **Quality filter — this is the part that makes per-session fitting sound:**
   keep only rounds where the reported count is trustworthy:
   - round 1 of a turn (cold by construction), or
   - rounds whose captured `prompt_tokens_details.cached_tokens` (L1) is 0/absent, or
   - L2-reconciled `native_tokens_prompt` values (OpenRouter; strongest tier).
     Drop cache-warm rounds — they're the −50% dimmed liars that ruined naive fits.
3. **Intercept:** `tokens = intercept + rate × chars`. The intercept is fit from the
   data — round 1 of the session's first turn (tiny transcript) measures system prompt
   - tool schemas + wire overhead in one number (~250 tokens in the incident session).
     It's the _useful_ overhead: present in every subsequent request.
4. **Fit:** default = intercept + single rate (robust at n=3–5). If ≥10 qualified
   samples, fit tokenx's class axes (JSON punct / code punct / words / default) with
   the intercept, regularized toward the default profile so small sessions can't
   produce wild classes. Write whatever fit quality supports; single-rate otherwise.
5. **Quality gate:** refuse to write an overlay if qualified samples < `--min-samples`
   or fit MAPE > 15%; print how many more cold rounds are needed instead. A bad
   profile is worse than the default, and the default is explicitly not load-bearing.
6. **Output:** `profiles/<model-slug>.json`:
   ```json
   {
     "model": "nvidia/nemotron-3-ultra-550b-a55b",
     "profile": { "defaultCharsPerToken": 2.56, "languageConfigs": ["…"] },
     "fit": {
       "kind": "classes",
       "mape": 0.017,
       "worst": 0.121,
       "samples": 11,
       "interceptTokens": 250
     },
     "source": { "sessionId": "ebbc0bd8…", "fittedAt": 1794457000000 }
   }
   ```

**Expectation setting:** the incident session yields a GLM profile at ~1.02 c/t from
3 cold anchors (t73 r1, t68-end ernie aside) + the overflow boundary — i.e. the script
delivers useful profiles from ordinary sessions without any synthetic traffic. For
higher-class-resolution fits, sessions with more rounds (like 74's 263) give the full
class breakdown.

### 3.3 Layer 1 — native usage capture (standard schema)

Unchanged from v2: widen `TurnUsage` with `prompt_tokens_details`,
`completion_tokens_details`, `requestId` (chunk `id`); merge extra fields at the
`chunk.usage` boundary; emit terminal `usageRaw` verbatim on `turn.finished`; emit
last-known round usage on the error path. **The `cached_tokens` field is what makes
§3.2's quality filter possible — capture-first is not optional.**

### 3.4 Layer 2 — OpenRouter enrichment (feature-detected)

Unchanged from v2 in mechanism: hostname static gate (hoist `isOpenRouterHostname`
out of `serve.ts`), dynamic confirmation via `usage.cost` or `^gen-` id, reconciler
polling `GET /api/v1/generation?id=` post-turn for `native_tokens_prompt`,
`native_tokens_cached`, `provider_name`, `total_cost`; unhealthy reconciler = log once,
stop trying. Adds to §3.2 as the strongest calibration tier and surfaces
`provider.rerouted` when `provider_name` changes mid-turn.

## 4. Display surface (v3)

- Status bar: **native `prompt_tokens`** when available (always, on OpenRouter), with
  the calibrated tail-bridge (§2) for the uncovered delta; pure estimate only when no
  native anchor exists (pre-round-1, post-restart), labeled `~`.
- Cached fraction (`cached_tokens / prompt_tokens`) shown alongside: it explains the
  round-to-round jumps and is the input to §3.2's filter.
- `/shake` `contextSize` and compaction budgets: calibrated profile, native-anchored
  when the session has any.

## 5. Test plan

| file                              | coverage                                                                                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| new `test/token-profiles.test.ts` | overlay load/slug/fold rules; malformed overlay ignored; default fallback; tail-bridge arithmetic                                                                     |
| new `test/calibrate.test.ts`      | fixture DB (incident corpus subset): sample extraction, cache-warm exclusion, intercept fit, single-rate vs class fit selection, quality-gate refusals, output schema |
| `test/turn.test.ts`               | fake provider emitting details + gen-id; `usageRaw` capture; error-path usage                                                                                         |
| `test/shake.test.ts`              | `contextSize` uses profile; overlay wins over default                                                                                                                 |
| new `test/capabilities.test.ts`   | hostname × dynamic confirmation; reconciler degradation                                                                                                               |

## 6. Rollout

| phase | content                                                                                 |
| ----- | --------------------------------------------------------------------------------------- |
| P0    | de-fork toolkit estimator + `DEFAULT_PROFILE` + overlay loader; shake/compaction switch |
| P1    | L1 native capture (`usageRaw`, details, error path)                                     |
| P2    | `yog calibrate <sessionId>` (single-rate fit + quality gate + overlay write)            |
| P3    | L2 OpenRouter reconcile + reroute events; class-based fit upgrade                       |

P0–P2 are each independently shippable; nothing waits on OpenRouter.

## 7. Open questions

- Overlay discoverability: `yog calibrate` could print a "profile quality" summary and
  suggest running a longer session when the gate refuses — is CLI output enough, or
  should the daemon surface `profile.stale` hints in status? (Deferred.)
- Should the fit job ever run _inside_ the daemon automatically after turn N? v3 says
  no (explicit user action only) — auto-fitting risks surprise behavior changes from
  background writes.
- GLM/ernie examples for docs: regenerate from the incident corpus via the script once
  P2 lands, rather than shipping numbers that age.
- `models.json` `requestOverhead` field: the intercept largely supersedes it for
  in-daemon purposes; keep harness-only unless display wants a pre-round-1 estimate of
  the first request.

## Appendix A — incident numbers

Fatal request (t81): 1,059,362 transcript chars; window 1,048,576; tokenx-defaults
284,562 (27%); toolkit fork 367,051 (35%); stale reported 539,037 (51%); provider
verdict ≥1,048,576. Cache evidence: t73 r1 516,717 (cold) vs t74 r1 170,883 (warm) vs
t81 ≥1,048,576 (cold, evicted); ernie t68 ended with a −95,550 `promptDelta` (silent
eviction). Calibrated rates (cold/boundary): GLM ≈1.02 c/t, ernie ≈1.05, nemotron
2.56 — the 2.5× spread that killed pre-baked profiles.

## Appendix B — artifacts

- `~/workspace/yog-token-calibration/` — v2 harness (`harness.mjs`, uses
  `~/workspace/.env.openrouter`, nemotron-3-ultra), grid scripts, `ground-truth.json`
  (17 samples, native usage + gen ids), `estimates.json`, `PROFILE.md` (example
  artifact — not shipped), `samples/`.
- Incident extracts for script test fixtures: `/tmp/calib.pkl`, `/tmp/rows.jsonl`
  (transient; regenerate from `sessions.db` per Appendix A query).
