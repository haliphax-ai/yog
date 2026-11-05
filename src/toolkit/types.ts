/**
 * Shared harness-tool types, split out of the toolkit barrel so tool
 * implementations can import them without creating a cycle through the barrel.
 */
import { z } from "zod";

/**
 * Result envelope for every tool. `error` is set instead of running the tool
 * when the call fails schema validation, and carries the exception message
 * when the tool itself throws.
 */
export interface ToolResult {
  error?: string;
  [key: string]: unknown;
}

/** Global marker used wherever /shake truncates args or tool output. */
export const TRUNCATION_IDENTIFIER = "[✂️ TRUNCATED]";

/**
 * Execution context passed through the registry into every tool run. Carries
 * the abort plumbing: the turn engine stamps the session id (the abort key
 * for the running script) on each call.
 */
export interface ToolContext {
  /** Abort key: the session id owning this tool call. */
  sessionId?: string;
  /**
   * Directory for the tool's persistent state (bash shell snapshots).
   * Injected from the runtime configuration by the caller; the tool itself
   * never reads configuration.
   */
  stateDir?: string;
}

export interface ToolSpec<
  TArgs extends Record<string, unknown> = Record<string, unknown>,
  TResult extends ToolResult = ToolResult,
> {
  /** OpenAI function name. */
  name: string;
  /** Human-readable description for the model. */
  description: string;
  /** Zod schema for the tool's arguments. */
  schema: z.ZodType<TArgs>;
  /** Response shape used when the call is aborted (validation error / exception). */
  failure(error: string): TResult;
  run(args: TArgs, ctx?: ToolContext): Promise<TResult>;
  /**
   * Optional transcript-rewrite hook for `/shake`: truncate a tool call's
   * raw arguments (JSON string as stored in the transcript). Return the
   * (possibly shortened) arguments string; append {@link TRUNCATION_IDENTIFIER}
   * where content is cut.
   */
  truncateArgs?(raw: string): string;
  /**
   * Optional transcript-rewrite hook for `/shake`: truncate a stored tool
   * result value (the parsed JSON of the tool row's content). Return the
   * replacement value; append {@link TRUNCATION_IDENTIFIER} where content is
   * cut. `undefined` leaves the result untouched.
   */
  truncateResult?(value: unknown): unknown | undefined;
}
