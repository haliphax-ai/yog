/**
 * Schedule domain barrel — the single public door for the scheduler.
 *
 * A minimal time primitive for the daemon: cancelable timeouts over an
 * injectable clock + timer implementation, so time-based behavior (wake
 * ladders, per-job caps, scratch-dir reapers) is deterministic under test.
 * Infrastructure, not a job queue: no persistence, no priorities, no
 * workers.
 *
 * The scheduler is an absolute leaf: nothing under `src/schedule/` imports
 * outside the folder (depcruise `schedule-leaf`), and nothing outside
 * `src/schedule/` reaches past this barrel (depcruise
 * `domain-entry-only:schedule`).
 */
export {
  Scheduler,
  nodeTimer,
  type CancelHandle,
  type SchedulerOptions,
  type TimerHandle,
  type TimerImpl,
} from "./scheduler.ts";
