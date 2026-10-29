/**
 * SessionOrchestrator — runs turns for many sessions concurrently.
 *
 * Design:
 *  - Sessions run in parallel: one session's slow turn must never block
 *    another session's turn (no global serialization).
 *  - Within a session, turns run FIFO (submission order).
 *
 * Implementation:
 *  - A per-session tail promise (`Map<sessionId, Promise>`) is the queue.
 *    Each new turn chains onto its session's tail, so turns on the same
 *    session start strictly in submission order, while different sessions
 *    chain onto independent tails and therefore overlap in wall-clock time.
 *  - `abort()` rejects the handle's promise immediately; a queued (not yet
 *    started) turn is skipped when its slot in the queue comes around.
 */

import type { SessionStore } from "./store/sessions.ts";
import type { WorkerPool } from "./workpool.ts";

/**
 * Injected dependencies. All fields are optional so tests can inject
 * fakes (slow fake tool/model, in-memory store, etc.) without casts.
 */
export interface SessionOrchestratorDeps {
  /** Session persistence (real `SessionStore`). */
  store?: SessionStore | unknown;
  /** Worker pool (real `WorkerPool`). */
  pool?: WorkerPool | unknown;
  /**
   * Entry point invoked once per turn. Tests inject a slow fake
   * tool/model here to observe concurrency and ordering. The third
   * parameter carries abort plumbing; existing two-argument fakes keep
   * working (extra args are ignored).
   */
  executeTurn?: (sessionId: string, req: TurnRequest, ctx?: TurnExecuteContext) => Promise<unknown>;
}

/** Request payload for a single turn. */
export interface TurnRequest {
  /** The user prompt for this turn. */
  prompt: string;
  /** Model identifier (optional; server default when omitted). */
  model?: string;
  /** Arbitrary extra fields (correlation data, client metadata, ...). */
  [key: string]: unknown;
}

/** Handle returned by `runTurn`: settle the turn, or abort it. */
export interface TurnHandle {
  /** Resolves with the turn result, or rejects on failure/abort. */
  promise: Promise<unknown>;
  /** Abort the turn (best effort). */
  abort: (reason?: unknown) => void;
}

/** Normalize an abort reason into an `AbortError`-style Error. */
function makeAbortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const err = new Error(reason === undefined || reason === null ? "turn aborted" : String(reason));
  err.name = "AbortError";
  return err;
}

/** Turn context passed to `executeTurn` (abort plumbing). */
export interface TurnExecuteContext {
  signal?: AbortSignal;
}

export class SessionOrchestrator {
  private readonly deps: SessionOrchestratorDeps;
  /** Per-session FIFO tail: the last queued turn's completion promise. */
  private readonly tails = new Map<string, Promise<void>>();
  /** Live turn per session: abort controller + handle (queued or in-flight). */
  private readonly turns = new Map<string, TurnHandle>();

  constructor(deps: SessionOrchestratorDeps = {}) {
    this.deps = deps;
  }

  /**
   * Start a turn for `sessionId`.
   *
   * Returns immediately with `{ promise, abort }`; the promise settles when
   * the turn finishes. Turns on different sessions must overlap in wall-clock
   * time; turns on the same session run in submission order.
   */
  runTurn(sessionId: string, req: TurnRequest): TurnHandle {
    // Chain onto this session's previous tail: the turn body only starts
    // after every earlier turn on this session has settled (strict FIFO).
    // Different sessions have independent tails, so they run concurrently.
    const prev = this.tails.get(sessionId) ?? Promise.resolve();

    let settle: (
      outcome: { ok: true; value: unknown } | { ok: false; error: unknown },
    ) => void = () => undefined;
    const promise = new Promise<unknown>((resolve, reject) => {
      settle = (outcome) => {
        if (outcome.ok) resolve(outcome.value);
        else reject(outcome.error);
      };
    });
    // Ensure an aborted/rejected turn nobody awaits never surfaces as an
    // unhandled rejection; awaiting callers still observe the rejection.
    promise.catch(() => undefined);

    let aborted = false;
    let abortReason: unknown;

    const controller = new AbortController();
    const handle: TurnHandle = {
      promise,
      abort: (reason?: unknown): void => {
        if (aborted) return;
        aborted = true;
        abortReason = reason;
        controller.abort(reason);
        // Reject the handle immediately, whether the turn is queued or
        // mid-flight. If still queued, the `aborted` flag above makes its
        // queue slot a no-op — effectively removing it from the queue so
        // later turns on this session aren't delayed by it.
        settle({ ok: false, error: makeAbortError(reason) });
      },
    };
    this.turns.set(sessionId, handle);

    // The queued unit of work: runs only after this session's previous turn
    // settles, and is skipped entirely if aborted while still queued.
    const turn: Promise<unknown> = prev.then(async () => {
      if (aborted) throw makeAbortError(abortReason);
      const executeTurn = this.deps.executeTurn;
      if (typeof executeTurn !== "function") {
        throw new Error("executeTurn dependency not provided");
      }
      return await executeTurn(sessionId, req, { signal: controller.signal });
    });

    // The new session tail: swallow errors so a failed/aborted turn never
    // wedges the queue for subsequent turns on the same session.
    const tail: Promise<void> = turn.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(sessionId, tail);
    void tail.then(() => {
      // Drop the settled tail so the map doesn't grow unbounded, but only
      // if no newer turn has chained on since.
      if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId);
    });

    // Bridge the internal turn outcome to the caller-visible handle promise,
    // then drop the registry entry so the map doesn't grow unbounded.
    turn.then(
      (value) => {
        if (this.turns.get(sessionId) === handle) this.turns.delete(sessionId);
        settle({ ok: true, value });
      },
      (error) => {
        if (this.turns.get(sessionId) === handle) this.turns.delete(sessionId);
        settle({ ok: false, error });
      },
    );

    return handle;
  }

  /**
   * Abort the session's current turn (operator-driven turn abort):
   *
   * 1. `killTool` runs first — the tool call in flight dies before anything
   *    else unwinds (the caller passes the harness's tool-kill hook).
   * 2. The abort controller signal fans out to the turn's `executeTurn`
   *    (model stream closes, engine probe unwinds the loop).
   * 3. The orchestrator handle rejects, so a queued-but-not-started turn is
   *    skipped and an SSE subscriber sees the stream end.
   *
   * Returns false when the session has no live turn — nothing was aborted.
   */
  async abortTurn(
    sessionId: string,
    killTool?: (sessionId: string) => Promise<boolean> | boolean,
  ): Promise<boolean> {
    const handle = this.turns.get(sessionId);
    if (!handle) return false;
    try {
      if (killTool) await killTool(sessionId);
    } catch {
      // Tool kill is best effort: the turn unwinds regardless.
    }
    handle.abort(abortTurnReason());
    return true;
  }
}

/** Canonical abort reason for operator-driven turn aborts. */
function abortTurnReason(): Error {
  const err = new Error("turn aborted by operator");
  err.name = "AbortError";
  return err;
}
