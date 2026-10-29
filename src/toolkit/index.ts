/**
 * Toolkit barrel — the single public door for the harness-tool domain.
 *
 * A harness tool is a model-facing function: it declares a zod schema for its
 * arguments, derives the OpenAI function definition from that schema, and
 * runs. The `ToolRegistry` holds the active tools and executes calls by name.
 *
 * Nothing outside `src/toolkit/` may import these internals directly
 * (depcruise `toolkit-entry-only`); tools themselves import `types.ts`/`registry.ts`
 * rather than this barrel to avoid a cycle.
 */
export * from "./types.ts";
export * from "./registry.ts";
export {
  abortBash,
  bashTool,
  setBashAbort,
  setBashExecutor,
  setShellStateProvider,
} from "./tools/bash.ts";
export type {
  BashAbort,
  BashArgs,
  BashExecutionResult,
  BashExecutor,
  BashRequestOpts,
  BashResult,
  ShellStateProvider,
} from "./tools/bash.ts";
