/**
 * Store domain barrel — the single public door for the session store.
 *
 * The store itself lives in `./sessions.ts` (`SessionStore`,
 * `openSessionsDb`); transcript row shaping and usage aggregation are
 * decomposed into `./transcript.ts` and `./usage.ts`.
 */
export * from "./sessions.ts";
