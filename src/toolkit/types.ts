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
  run(args: TArgs): Promise<TResult>;
}
