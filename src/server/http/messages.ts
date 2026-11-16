import type { MsgCtx, SessionResolvers } from "./types.ts";

import type { HttpDeps, SessionRecord } from "./types.ts";
import type { CompactionKind } from "../compaction.ts";
import type { SkillManager } from "../../skills/index.ts";

/**
 * `session.detach`: optional `purge` is an immediate irreversible
 * delete — the session row is gone, so subsequent messages all hit 404 —
 * while plain detach is open → dormant with `detached_at` stamped and
 * nothing forfeited; idempotent (a second detach on a dormant session is a
 * no-op that still returns success).
 */
export async function handleSessionDetach(
  deps: HttpDeps,
  resolvers: SessionResolvers,
  session: SessionRecord,
  ctx: MsgCtx,
): Promise<void> {
  const { store, sessions, lookupSession } = resolvers;
  const { id, data } = ctx;
  if (data.purge !== undefined && typeof data.purge !== "boolean") {
    ctx.fail("invalid_request", "purge must be a boolean");
    return;
  }
  const purge = data.purge === true;
  if (purge) {
    // Immediate irreversible delete. After this the session
    // row is gone: subsequent messages all hit 404 unknown_session.
    const purged =
      !!store && typeof store.purgeSession === "function"
        ? await store!.purgeSession(id)
        : (sessions.delete(id), 1);
    if (purged === 0) ctx.fail("unknown_session", `session ${id} not found`);
    else ctx.reply(200, { ok: true, deleted: true, id });
    return;
  }
  // Detach: status open → dormant, detached_at stamped,
  // nothing forfeited. Idempotent — a second detach on an already
  // dormant session is a no-op that still returns success.
  let detached: SessionRecord = session;
  if (session.status === "open") {
    if (!!store && typeof store.detachSession === "function") {
      await store!.detachSession(id, Date.now());
      detached = (await lookupSession(id)) ?? { ...session, status: "dormant" };
    } else {
      // In-memory fallback: mutate the map's record in place.
      session.status = "dormant";
      session.detached_at = Date.now();
      session.updated_at = session.detached_at;
    }
  }
  ctx.reply(200, { session: detached });
}

/**
 * `compaction.run`: run the injected compaction/handoff runner (see
 * compaction.ts); misconfiguration and unknown sessions surface as the
 * mapped error codes, everything else as provider_error.
 */
export async function handleCompactionRun(deps: HttpDeps, ctx: MsgCtx): Promise<void> {
  const { id, data } = ctx;
  const compaction = deps.compaction;
  if (typeof compaction !== "function") {
    ctx.fail("internal", "compaction is not configured on this server");
    return;
  }
  if (data.kind !== "compact" && data.kind !== "handoff") {
    ctx.fail("invalid_request", 'kind must be "compact" or "handoff"');
    return;
  }
  if (data.guidance !== undefined && typeof data.guidance !== "string") {
    ctx.fail("invalid_request", "guidance must be a string");
    return;
  }
  const kind = data.kind as CompactionKind;
  const guidance = typeof data.guidance === "string" ? data.guidance : undefined;
  try {
    const result = await compaction(id, kind, guidance);
    const targetId = typeof result.sessionId === "string" ? result.sessionId : id;
    ctx.reply(200, {
      ok: true,
      kind,
      summary: result.summary,
      model: result.model,
      truncated: result.truncated === true,
      sessionId: targetId,
    });
  } catch (err) {
    const code =
      (err as { code?: string }).code === "unknown_session" ? "unknown_session" : "provider_error";
    ctx.fail(code, err instanceof Error ? err.message : String(err));
  }

  return;
}

/**
 * `transcript.shake`: run the injected transcript shake runner (see
 * shake.ts); misconfiguration surfaces as `internal`, runner failure as an
 * internal error with the runner's message.
 */
export async function handleTranscriptShake(
  deps: HttpDeps,
  resolvers: SessionResolvers,
  session: SessionRecord,
  ctx: MsgCtx,
): Promise<void> {
  const { lookupSession } = resolvers;
  const { id } = ctx;
  const shake = deps.shake;
  if (typeof shake !== "function") {
    ctx.fail("internal", "shake is not configured on this server");
    return;
  }
  try {
    const outcome = await shake(id);
    const after = await lookupSession(id);
    ctx.reply(200, {
      ok: true,
      ...outcome,
      session: after ?? session,
    });
  } catch (err) {
    ctx.fail("internal", err instanceof Error ? err.message : String(err));
  }

  return;
}

/**
 * `skills.*` dispatch: list/status/load/unload against the injected
 * SkillManager (see skills/manager.ts); the daemon's skills session is the
 * default target unless the request names one.
 */
export async function handleSkillsCommand(
  deps: HttpDeps,
  session: SessionRecord,
  ctx: MsgCtx,
): Promise<void> {
  const { id, data } = ctx;
  const manager = deps.skills as SkillManager | undefined;
  const configured =
    !!manager &&
    typeof manager.list === "function" &&
    typeof manager.load === "function" &&
    typeof manager.unload === "function";
  if (!configured) {
    ctx.fail("internal", "skills system is not configured on this server");
    return;
  }
  const sessionId = typeof deps.skillsSessionId === "string" ? deps.skillsSessionId : id;
  const sub = ctx.type.slice("skills.".length);
  const badName =
    (sub === "load" || sub === "unload") &&
    (typeof data.name !== "string" || (data.name as string).trim() === "");
  if (badName) {
    ctx.fail("invalid_request", `"name" must be a non-empty string`);
    return;
  }
  if (sub === "list") {
    ctx.reply(200, { skills: await manager!.list(sessionId) });
  } else if (sub === "status") {
    ctx.reply(200, { skills: manager!.status(sessionId) });
  } else if (sub === "load" || sub === "unload") {
    const result =
      sub === "load"
        ? await manager!.load(data.name as string, sessionId)
        : await manager!.unload(data.name as string, sessionId);
    ctx.reply(result.ok ? 200 : 404, result);
  } else {
    ctx.fail("invalid_request", `unsupported skills command: ${sub}`);
  }
}

/**
 * Reply to `transcript.get`: the rehydration dump. Readable while the
 * row exists, including dormant sessions within the 30-day retention window
 * (dormancy never blocks reads); store-less fakes get a documented minimal
 * empty dump rather than a crash.
 */
