/**
 * Command handlers for the `yog skills` CLI / daemon-side registry.
 *
 * Each handler is pure over a {@link SkillManager} plus its arguments and
 * returns a structured result; formatting for humans happens in `cli.ts`
 * (or the HTTP adapter), never here.
 */
import { formatAvailableSkills } from "./discover.ts";
import type { SkillManager } from "./manager.ts";
import type { SkillCommandResult, SkillsCommandResult } from "./types.ts";

/** `yog skills list [--verbose]` — available skills with source and status. */
export async function listSkills(
  manager: SkillManager,
  opts: { verbose?: boolean } = {},
): Promise<SkillsCommandResult> {
  const entries = await manager.list();
  return {
    command: "list",
    ok: true,
    entries,
    ...(opts.verbose
      ? {
          message: formatAvailableSkills(
            (await manager.discover()).map((s) => ({
              ...s,
              description: s.frontmatter.description,
            })),
          ),
        }
      : {}),
  };
}

/** `yog skills load <name>` — activate a skill. */
export async function loadSkill(manager: SkillManager, name: string): Promise<SkillsCommandResult> {
  const result = await manager.load(name);
  return { command: "load", ok: result.ok, result };
}

/** `yog skills unload <name>` — deactivate a skill (and its children). */
export async function unloadSkill(
  manager: SkillManager,
  name: string,
): Promise<SkillsCommandResult> {
  const result = await manager.unload(name);
  return { command: "unload", ok: result.ok, result };
}

/** `yog skills status` — currently loaded skills. */
export function statusSkills(manager: SkillManager): SkillsCommandResult {
  const entries = manager.status();
  return { command: "status", ok: true, entries };
}

/** `yog skills` / `yog skills help` — usage text. */
export function skillsHelp(): SkillsCommandResult {
  return {
    command: "help",
    ok: true,
    message: [
      "usage: yog skills <command> [args]",
      "",
      "commands:",
      "  list      List discovered skills with source and status",
      "  load      Activate a skill (add to PATH, load instructions)",
      "  unload    Deactivate a skill",
      "  status    Show currently loaded skills",
      "  help      Show this help",
    ].join("\n"),
  };
}

/** Dispatch a `yog skills ...` argv tail (after `skills`) to a handler. */
export async function dispatchSkillsCommand(
  manager: SkillManager,
  argv: readonly string[],
): Promise<SkillsCommandResult> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "list":
      return listSkills(manager, { verbose: rest.includes("--verbose") || rest.includes("-v") });
    case "load": {
      const name = rest.find((a) => !a.startsWith("-"));
      if (!name) {
        return {
          command: "load",
          ok: false,
          message: "usage: yog skills load <name>",
        };
      }
      return loadSkill(manager, name);
    }
    case "unload": {
      const name = rest.find((a) => !a.startsWith("-"));
      if (!name) {
        return {
          command: "unload",
          ok: false,
          message: "usage: yog skills unload <name>",
        };
      }
      return unloadSkill(manager, name);
    }
    case "status":
      return statusSkills(manager);
    case "help":
    case undefined:
      return skillsHelp();
    default:
      return {
        command: "help",
        ok: false,
        message: `unknown skills command "${sub}" (expected list, load, unload, status, or help)`,
      };
  }
}

/** Instructions block for the system prompt (loaded skills), if any. */
export async function skillInstructions(manager: SkillManager): Promise<string> {
  const loaded = await manager.getInstructions();
  if (loaded === "") return "";
  return `# Loaded skill instructions\n\n${loaded}`;
}

/** Available-skills block for the system prompt, if any.
 *
 * Lists everything the session can *see* minus what is already loaded. A
 * child skill is visible only while its parent is loaded (the same rule as
 * `SkillManager.list`), so the prompt never advertises a skill the agent
 * cannot actually load.
 */
export async function availableSkillsBlock(
  manager: SkillManager,
  sessionId = manager.sessionId,
): Promise<string> {
  const available = await manager.discover();
  const visible = new Set((await manager.list(sessionId)).map((s) => s.name));
  const loaded = new Set(manager.getLoaded(sessionId).map((s) => s.fullName));
  return formatAvailableSkills(
    available
      .filter((s) => visible.has(s.fullName) && !loaded.has(s.fullName))
      .map((s) => ({ ...s, description: s.frontmatter.description })),
  );
}

export type { SkillCommandResult };
