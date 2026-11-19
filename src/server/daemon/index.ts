/**
 * Daemon barrel — the single public door for the daemon's assembly.
 *
 * The daemon modules (`runtime.ts`, `bash-wiring.ts`, `turn-runner.ts`,
 * `openai.ts`, `skills-cli.ts`) are internal to the server domain; the rest
 * of the domain reaches them only through this barrel (depcruise
 * `domain-entry-only:server`), and nothing outside the domain may reach the
 * internals directly.
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
