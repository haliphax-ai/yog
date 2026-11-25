/**
 * Server-advertised slash commands (the user-facing projection of the
 * dispatch table).
 *
 * Capabilities carry a `commands` array of {@link CommandDescriptor}s so
 * clients can surface the daemon's interactions beside their own local
 * commands: `name` is the slash token, `message` the messages-channel type
 * an invocation dispatches, `data` the static payload merged into every
 * call, and `argField` the data field free-text line args land in. The
 * slash name is client-side sugar and never sent to the server.
 *
 * Descriptors live next to their implementations (compaction, shake, jobs)
 * and the composition root concatenates by what actually wired, so
 * presence in the list IS availability — a command the daemon cannot serve
 * is never advertised.
 * skills) and the composition root concatenates by what actually wired, so
 * presence in the list IS availability — a command the daemon cannot serve
 * is never advertised.
 */

/** One server-advertised slash command. */
export interface CommandDescriptor {
  /** Slash token clients complete after "/", without the leading slash. */
  name: string;
  /** One-liner for the autocomplete menu. */
  summary: string;
  /** Argument syntax hint shown on an exact-match menu. */
  args?: string;
  /** The messages-channel type an invocation dispatches. */
  message: string;
  /** Static payload merged into every invocation's `data`. */
  data?: Record<string, unknown>;
  /** The `data` field free-text line args land in (single remainder string). */
  argField?: string;
  /** True when the client must wait for an idle turn before dispatching. */
  requiresIdle?: boolean;
}

/** `/compact [guidance]` — compact the session into a fresh summary transcript. */
export const COMPACT_COMMAND: CommandDescriptor = {
  name: "compact",
  summary: "compact the session into a fresh summary transcript",
  args: "[guidance]",
  message: "compaction.run",
  data: { kind: "compact" },
  argField: "guidance",
  requiresIdle: true,
};

/** `/handoff [guidance]` — handoff document + fresh transcript (max continuity). */
export const HANDOFF_COMMAND: CommandDescriptor = {
  name: "handoff",
  summary: "prepare a handoff document and start a fresh transcript",
  args: "[guidance]",
  message: "compaction.run",
  data: { kind: "handoff" },
  argField: "guidance",
  requiresIdle: true,
};

/** Descriptors for the compaction runner: compact + handoff. */
export const COMPACTION_COMMANDS: readonly CommandDescriptor[] = [COMPACT_COMMAND, HANDOFF_COMMAND];

/** `/shake` — truncate oversized tool args/results in the transcript in place. */
export const SHAKE_COMMAND: CommandDescriptor = {
  name: "shake",
  summary: "truncate oversized tool args/results in the transcript",
  message: "transcript.shake",
  requiresIdle: true,
};
