/**
 * SessionOrchestrator — runs turns for many sessions concurrently.
 *
 * Design (see PLAN.md §"SessionOrchestrator (parallel, async)"):
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
   * tool/model here to observe concurrency and ordering.
   */
  executeTurn?: (sessionId: string, req: TurnRequest) => Promise<unknown>;
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

export class SessionOrchestrator {
  private readonly deps: SessionOrchestratorDeps;
  /** Per-session FIFO tail: the last queued turn's completion promise. */
  private readonly tails = new Map<string, Promise<void>>();

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

    // The queued unit of work: runs only after this session's previous turn
    // settles, and is skipped entirely if aborted while still queued.
    const turn: Promise<unknown> = prev.then(async () => {
      if (aborted) throw makeAbortError(abortReason);
      const executeTurn = this.deps.executeTurn;
      if (typeof executeTurn !== "function") {
        throw new Error("executeTurn dependency not provided");
      }
      return await executeTurn(sessionId, req);
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

    // Bridge the internal turn outcome to the caller-visible handle promise.
    turn.then(
      (value) => settle({ ok: true, value }),
      (error) => settle({ ok: false, error }),
    );

    const abort = (reason?: unknown): void => {
      if (aborted) return;
      aborted = true;
      abortReason = reason;
      // Reject the handle immediately, whether the turn is queued or
      // mid-flight. If still queued, the `aborted` flag above makes its
      // queue slot a no-op — effectively removing it from the queue so
      // later turns on this session aren't delayed by it.
      settle({ ok: false, error: makeAbortError(reason) });
    };

    return { promise, abort };
  }
}
