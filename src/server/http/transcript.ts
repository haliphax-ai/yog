import { attributionFromEvent, appendSyntheticRunningRows } from "./rows.ts";

import type { MsgCtx, RoundAttribution } from "./types.ts";

import type { HttpDeps, SessionRecord, StoreBoundary } from "./types.ts";
import { toWireMessage } from "./wire.ts";

/**
 * Round attribution for tool result rows comes from the turns' persisted
 * tool.result events (the live envelope data), so the dump carries the same
 * usage/promptDelta the stream did: one attribution round per turn (all
 * results of a round share it), while per-call resultTokens are keyed by
 * tool call id instead — each result's own estimate rides its own row.
 */
export async function collectTranscriptAttribution(
  store: StoreBoundary,
  id: string,
): Promise<{
  attribution: Map<number, RoundAttribution>;
  resultTokensByCall: Map<string, number>;
}> {
  const attribution = new Map<number, { usage?: unknown; promptDelta?: number }>();
  const resultTokensByCall = new Map<string, number>();
  if (typeof store.listEvents === "function") {
    for (const ev of ((await store.listEvents(id)) ?? []) as Array<Record<string, unknown>>) {
      const round = attributionFromEvent(ev, resultTokensByCall);
      if (round !== undefined) attribution.set(Number(ev.turn_id), round);
    }
  }
  return { attribution, resultTokensByCall };
}

/**
 * Round attribution for tool result rows comes from the turns' persisted
 * tool.result events (the live envelope data), so the dump carries the same
 * usage/promptDelta the stream did: one attribution round per turn (all
 * results of a round share it), while per-call resultTokens are keyed by
 * tool call id instead — each result's own estimate rides its own row.
 */
/**
 * In-flight (running) turns have no canonical transcript rows yet: serve.ts
 * only appends `messages.slice(startLen)` at settle time, so a reconnecting
 * client polling the dump would see only the previous turn while the
 * in-flight turn generates. Reconstruct the running turn's completed rounds
 * from its persisted `turn_events` (the sink records every event
 * incrementally) and append them as synthetic transcript rows so a poll
 * rehydrates the in-flight turn progressively; settled turns use the real
 * rows and get no synthetic duplicates.
 */
/**
 * Per-turn metrics (usage/duration) ride alongside the dump so a client can
 * rebuild per-turn summaries without replaying events. Each row carries its
 * settle status — `running` for an in-flight (typically lingered) turn, then
 * `finished` / `aborted` / `error` / `interrupted` — so a reconnecting
 * client can tell the session still has an active turn (busy gate,
 * poll-to-settle) and can mark a failed (provider-error) turn distinctly
 * from an aborted one on rehydrate. A running row has no stored
 * usage/duration yet (both are stamped at settle time), so the snapshot
 * from `onUsageFor` fills the usage in: the client's "last known context
 * total" then stays live instead of showing the pre-turn figure until the
 * row settles.
 */
export async function collectTurnSummaries(
  store: StoreBoundary,
  deps: HttpDeps,
  id: string,
): Promise<unknown[]> {
  if (typeof store.listTurns !== "function") return [];
  let turns: unknown[] = [];
  const rows = ((await store.listTurns(id)) ?? []) as Array<Record<string, unknown>>;
  const usageById = new Map<number, { usage?: unknown; durationMs?: number }>();
  if (typeof store.listTurnUsages === "function") {
    for (const m of ((await store.listTurnUsages(id)) ?? []) as Array<{
      turnId: number;
      usage?: unknown;
      durationMs?: number;
    }>) {
      usageById.set(m.turnId, {
        ...(m.usage !== undefined ? { usage: m.usage } : {}),
        ...(m.durationMs !== undefined ? { durationMs: m.durationMs } : {}),
      });
    }
  }
  const liveUsage = deps.onUsageFor?.(id);
  turns = rows.map((r) => {
    const turnId = Number(r.id);
    const status = typeof r.status === "string" ? r.status : "finished";
    const stored = usageById.get(turnId) ?? {};
    const running = status === "running";
    return {
      turnId,
      status,
      ...(running && liveUsage !== undefined ? { usage: liveUsage } : stored),
      ...(typeof r.duration_ms === "number" ? { durationMs: r.duration_ms } : {}),
    };
  });
  return turns;
}

/**
 * `session.detach`: optional `purge` is an immediate irreversible
 * delete — the session row is gone, so subsequent messages all hit 404 —
 * while plain detach is open → dormant with `detached_at` stamped and
 * nothing forfeited; idempotent (a second detach on a dormant session is a
 * no-op that still returns success).
 */

/**
 * Reply to `transcript.get`: the rehydration dump. Readable while the
 * row exists, including dormant sessions within the 30-day retention window
 * (dormancy never blocks reads); store-less fakes get a documented minimal
 * empty dump rather than a crash.
 */
export async function replyTranscriptGet(
  deps: HttpDeps,
  store: StoreBoundary | undefined,
  session: SessionRecord,
  ctx: MsgCtx,
): Promise<void> {
  if (!!store && typeof store.getTranscript === "function") {
    const afterRaw = (ctx.data.afterSeq ?? ctx.data.after) as unknown;
    const limitRaw = ctx.data.limit as unknown;
    const afterSeq = afterRaw !== undefined ? Number(afterRaw) : undefined;
    const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
    const { attribution, resultTokensByCall } = await collectTranscriptAttribution(store!, ctx.id);
    const messages = (
      await store!.getTranscript(ctx.id, {
        ...(afterSeq !== undefined && Number.isFinite(afterSeq) ? { afterSeq: afterSeq } : {}),
        ...(limit !== undefined && Number.isFinite(limit) ? { limit: limit } : {}),
        ...(attribution.size > 0 ? { roundAttribution: attribution } : {}),
        ...(resultTokensByCall.size > 0 ? { resultTokensByCall } : {}),
      })
    ).map(toWireMessage);
    await appendSyntheticRunningRows(store!, ctx.id, messages as Array<Record<string, unknown>>);
    const turns = await collectTurnSummaries(store!, deps, ctx.id);
    ctx.reply(200, {
      session,
      messages,
      ...(turns.length > 0 ? { turns } : {}),
    });
    return;
  }
  // Store-less fallback (test mode): documented minimal response — an
  // empty transcript rather than a crash.
  ctx.reply(200, { session, messages: [] });
}
