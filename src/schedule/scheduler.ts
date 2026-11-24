/**
 * Scheduler — a cancelable-timeout primitive with an injectable clock and
 * timer implementation.
 *
 * This is infrastructure, not a job-queue framework: no persistence, no
 * priorities, no workers. It exists so time-based daemon behavior (wake
 * ladders, per-job caps, scratch-dir reapers) is deterministic under test:
 * tests inject a fake clock + timer implementation and drive time by hand,
 * while production uses the real node timers (`nodeTimer`, the default).
 *
 * Two properties are deliberate:
 *
 * - Absolute leaf: this module imports nothing from `src/` — no host, no
 *   config, no log (depcruise `schedule-leaf`). Deterministic time needs a
 *   dependency-free floor.
 * - Never holds the process open: production timers are unref'd at
 *   creation, so a pending timeout alone cannot keep the daemon alive.
 *
 * Callbacks run in the timer implementation's error domain: a throwing
 * callback propagates to the impl (an uncaught exception under node
 * timers), so consumers wrap their own callbacks.
 */

/** Opaque handle created by a {@link TimerImpl} (cleared via the same impl). */
export type TimerHandle = object;

/** A `setTimeout`-shaped timer implementation — node timers, or a test fake. */
export interface TimerImpl {
  /** Run `fn` after `ms` milliseconds; returns an opaque handle. */
  setTimeout(fn: () => void, ms: number): TimerHandle;
  /** Cancel a pending timeout created by {@link setTimeout}. */
  clearTimeout(handle: TimerHandle): void;
}

/** Production timer implementation: node timers, unref'd at creation. */
export const nodeTimer: TimerImpl = {
  setTimeout(fn, ms) {
    const timer = setTimeout(fn, ms);
    timer.unref();
    return timer;
  },
  clearTimeout(timer) {
    clearTimeout(timer as NodeJS.Timeout);
  },
};

/** Options for {@link Scheduler}: the injected clock + timer seams. */
export interface SchedulerOptions {
  /** Wall clock in ms (tests inject a fake). Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Timer implementation (tests inject a fake). Defaults to {@link nodeTimer}. */
  readonly timer?: TimerImpl;
}

/** Cancel handle for a timeout scheduled with `Scheduler.after`. */
export interface CancelHandle {
  /** True while the timeout is pending — neither fired nor canceled. */
  readonly active: boolean;
  /** Clock reading (from the injected `now`) at which the timeout fires. */
  readonly dueAt: number;
}

/** Internal bookkeeping for one scheduled timeout. */
interface TimerRecord {
  state: "pending" | "fired" | "canceled";
  /** Timer-impl handle; set synchronously right after scheduling. */
  timer: TimerHandle | undefined;
  dueAt: number;
  fn: () => void;
}

/**
 * Cancelable timeouts on an injectable clock.
 *
 * `after` schedules, `cancel` / `cancelAll` retract, and handles report
 * liveness. Time is read only through the injected `now` (exposed as
 * `now()`), so a fake clock drives both scheduling stamps and consumer
 * logic consistently in tests. Canceling a fired or unknown handle is a
 * no-op, and a timer cannot fire twice.
 */
export class Scheduler {
  readonly #now: () => number;
  readonly #timer: TimerImpl;
  readonly #pending = new Map<CancelHandle, TimerRecord>();

  constructor(opts: SchedulerOptions = {}) {
    this.#now = opts.now ?? (() => Date.now());
    this.#timer = opts.timer ?? nodeTimer;
  }

  /**
   * Run `fn` after `ms` milliseconds. Returns a handle for `cancel` /
   * `cancelAll`; the timeout stays cancelable until it fires, and canceling
   * after a fire is a no-op. Timers scheduled through `nodeTimer` are
   * unref'd: a pending timeout never holds the process open.
   */
  after(ms: number, fn: () => void): CancelHandle {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(
        `scheduler delay must be a finite non-negative number of ms (got ${ms})`,
      );
    }
    const dueAt = this.#now() + ms;
    const record: TimerRecord = { state: "pending", timer: undefined, dueAt, fn };
    const handle: CancelHandle = {
      get active() {
        return record.state === "pending";
      },
      get dueAt() {
        return record.dueAt;
      },
    };
    record.timer = this.#timer.setTimeout(() => this.#fire(handle), ms);
    this.#pending.set(handle, record);
    return handle;
  }

  /**
   * Current clock reading (ms) from the injected clock. Consumers read
   * time here rather than calling `Date.now()` directly, so fake-clock
   * tests drive scheduler and consumer through one seam.
   */
  now(): number {
    return this.#now();
  }

  /** Cancel a pending timeout. Fired, canceled, or unknown handles: no-op. */
  cancel(handle: CancelHandle): void {
    const record = this.#pending.get(handle);
    if (!record || record.state !== "pending") return;
    this.#timer.clearTimeout(record.timer as TimerHandle);
    record.state = "canceled";
    this.#pending.delete(handle);
  }

  /** Cancel every pending timeout (idempotent; leaves fired timers alone). */
  cancelAll(): void {
    for (const [handle, record] of this.#pending) {
      this.#timer.clearTimeout(record.timer as TimerHandle);
      record.state = "canceled";
      this.#pending.delete(handle);
    }
  }

  /** Timer-impl callback: settle the record, then run the callback once. */
  #fire(handle: CancelHandle): void {
    const record = this.#pending.get(handle);
    if (!record || record.state !== "pending") return; // canceled, or a misbehaving impl fired twice
    record.state = "fired";
    this.#pending.delete(handle);
    record.fn();
  }
}
