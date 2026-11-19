/**
 * Tools barrel — the concrete harness tools, composed by the toolkit barrel.
 *
 * These modules stay internal to the toolkit domain (depcruise
 * `domain-entry-only:toolkit`): `../index.ts` consumes them through this
 * barrel so the domain keeps a single public door and new tools slot in
 * without touching importers.
 */
export {
  abortBash,
  bashTool,
  setBashAbort,
  setBashExecutor,
  setShellStateProvider,
  setSkillPathProvider,
  type BashAbort,
  type BashArgs,
  type BashExecutionResult,
  type BashExecutor,
  type BashRequestOpts,
  type BashResult,
  type ShellStateProvider,
  type SkillPathProvider,
} from "./bash.ts";
