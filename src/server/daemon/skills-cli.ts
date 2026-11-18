/**
 * The `skills` command for the agent-CLI registry (the `/bin/yog` shim's
 * `/v1/agent-cli` endpoint).
 *
 * The registry lives in the server domain; the command's behavior comes
 * from the skills domain (`dispatchSkillsCommand`). This module adapts the
 * structured result to the CLI's line-oriented output contract.
 */
import {
  dispatchSkillsCommand,
  type SkillListEntry,
  type SkillManager,
  type SkillStatusEntry,
} from "../../skills/index.ts";
import { registerCommand, type CliCommand } from "../cli.ts";

/** Render one `skills list` / `skills status` entry as a CLI row. */
function entryRow(entry: SkillListEntry | SkillStatusEntry): string {
  const loadedAt = "loadedAt" in entry ? String(entry.loadedAt) : "";
  return [entry.name, entry.source, loadedAt].filter(Boolean).join(" ");
}

/** The command the agent-CLI registry serves for the skills subsystem. */
export function skillsCliCommand(manager: SkillManager): CliCommand {
  return {
    name: "skills",
    description: "List, load, or unload skills (list|load|unload|status [name])",
    usage: "skills <list|load|unload|status> [name]",
    async execute(args) {
      const [sub = "list", ...rest] = args;
      const result = await dispatchSkillsCommand(manager, [sub, ...rest]);
      if (result.message !== undefined) return `${result.message}\n`;
      if (result.result !== undefined) return `${result.result.message}\n`;
      if (result.entries !== undefined && result.entries.length > 0) {
        return result.entries.map(entryRow).join("\n") + "\n";
      }
      return "(none)\n";
    },
  };
}

/** Register the `skills` command with the agent-CLI registry. */
export function registerSkillsCliCommand(manager: SkillManager): void {
  registerCommand(skillsCliCommand(manager));
}
