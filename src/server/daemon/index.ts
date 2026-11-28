/**
 * Daemon barrel — the single public door for the daemon's assembly.
 *
 * The daemon modules (`runtime.ts`, `bash-wiring.ts`, `turn-runner.ts`,
 * `openai.ts`, `skills-cli.ts`, `jobs-cli.ts`) are internal to the server
 * domain; the rest of the domain reaches them only through this barrel
 * (depcruise `domain-entry-only:server`), and nothing outside the domain
 * may reach the internals directly.
 */
export { createRuntime, type Runtime } from "./runtime.ts";
export {
  skillPathProvider,
  unwireBashTool,
  wireBashExecutor,
  wireBashTool,
} from "./bash-wiring.ts";
export { makeExecuteTurn, type TurnRuntime, type UsageBySession } from "./turn-runner.ts";
export { openaiClient, isOpenRouterHostname } from "./openai.ts";
export { registerSkillsCliCommand, skillsCliCommand } from "./skills-cli.ts";
export { registerJobsCliCommand, jobsCliCommand } from "./jobs-cli.ts";
export {
  createPreludeSink,
  deliverPrelude,
  serializePrelude,
  HARNESS_NOTICE_HINT,
  HARNESS_NOTICE_TOOL,
  PRELUDE_MAX_CHARS,
  type PreludeSink,
  type PreludeNotice,
  type PreludePayload,
  type PreludeCallRow,
  type PreludeToolRow,
  type DeliveredPrelude,
} from "./prelude.ts";
