/**
 * Skills layer barrel: the single public door for the agent-skills subsystem.
 *
 * A skill is an `agentskills.io`-style instruction bundle (`SKILL.md` plus
 * an optional `scripts/`, `references/`, `assets/` package structure)
 * discovered from the system, the agent's `$HOME`, or the cwd. The
 * `SkillManager` owns discovery, load/unload, PATH injection, and the
 * concatenated instructions handed to the turn engine.
 *
 * Nothing outside `src/skills/` may import these internals directly
 * (depcruise `skills-entry-only`).
 */
export * from "./types.ts";
export * from "./validator.ts";
export * from "./parser.ts";
export * from "./package.ts";
export * from "./discover.ts";
export * from "./manager.ts";
export * from "./commands.ts";
