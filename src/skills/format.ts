/**
 * Skill presentation + reference parsing: load full skills from discovery
 * metadata, parse `trunk:branch` references, and build the system-prompt
 * sections (available / loaded skills) the turn engine consumes.
 */
import { logger } from "../log.ts";
import { readSkillFile } from "./parser.ts";
import {
  isModelInvocationDisabled,
  isValidSkillName,
  skillNameError,
  splitFullName,
} from "./validator.ts";
import type { Skill, SkillCommandResult, SkillFrontmatter, SkillMetadata } from "./types.ts";
import { discoverSkills, type DiscoverOptions } from "./discover.ts";

/** Discover and fully load (parse `SKILL.md`) every available skill. */
export async function loadSkills(options: DiscoverOptions = {}): Promise<Skill[]> {
  const metas = await discoverSkills(options);
  const out: Skill[] = [];
  for (const meta of metas) {
    try {
      const doc = await readSkillFile(meta.skillFile);
      out.push({ ...meta, ...doc });
    } catch (err) {
      logger.warn(
        `[skills] skipping ${meta.fullName}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return out;
}

/** Split a `trunk:branch` reference; validates the trunk part. */
export function parseSkillRef(ref: string): { trunk: string; branch: string | undefined } {
  const [trunk, branch] = splitFullName(ref);
  if (!isValidSkillName(trunk)) {
    throw new Error(`invalid skill reference "${ref}": ${skillNameError(trunk) ?? "bad trunk"}`);
  }
  if (branch !== undefined && !isValidSkillName(branch)) {
    throw new Error(`invalid skill reference "${ref}": ${skillNameError(branch) ?? "bad branch"}`);
  }
  return { trunk, branch };
}

/** Whether a skill reference is a child (namespaced) reference. */
export function isChildRef(ref: string): boolean {
  return splitFullName(ref)[1] !== undefined;
}

/** `true` when a discovered skill must be hidden from the agent. */
export function isAgentVisible(s: Skill): boolean {
  return !isModelInvocationDisabled(s.frontmatter);
}

/** Build the system prompt section listing available (unloaded) skills.
 *
 * One bullet per skill with its frontmatter description; a generic pointer
 * to `yog skills help` follows (the agent learns the command surface from
 * the help doc, not from per-skill load lines).
 */
export function formatAvailableSkills(
  metas: readonly (SkillMetadata & Pick<SkillFrontmatter, "description">)[],
): string {
  if (metas.length === 0) return "";
  const bullets = metas.map((m) => {
    const desc = m.isChild ? `${m.fullName} (child skill)` : m.fullName;
    const summary = m.description || "(no description)";
    return `- **${desc}** — ${summary}`;
  });
  return [
    "# Available skills",
    "",
    ...bullets,
    "",
    "Interact with skills using `yog skills help` (list, load, unload, status).",
  ].join("\n");
}

/** Build the system prompt section for loaded skills (instructions). */
export function formatLoadedSkills(loaded: readonly Skill[]): string {
  if (loaded.length === 0) return "";
  const sections = loaded.map((s) => `## Skill: ${s.fullName}\n\n${s.body}`);
  return `# Loaded skill instructions\n\n${sections.join("\n\n---\n\n")}`;
}

/** Concatenate a session's loaded `SKILL.md` bodies (instructions for the
 * turn engine); empty string when nothing is loaded.
 */
export function getInstructions(loaded: readonly Skill[]): string {
  const sections: string[] = [];
  for (const s of loaded) {
    const desc = s.frontmatter.description ? `\n\n> ${s.frontmatter.description}` : "";
    sections.push(`## ${s.fullName}${desc}\n\n${s.body}`);
  }
  return sections.join("\n\n---\n\n");
}

/** Format a skills command result as human-readable text (CLI). */
export function formatCommandResult(result: SkillCommandResult): string {
  const lines: string[] = [];
  if (!result.ok) lines.push(`error: ${result.message}`);
  else if (result.status === "loaded") lines.push(`loaded ${result.name}`);
  else if (result.status === "unloaded") lines.push(`unloaded ${result.name}`);
  else lines.push(result.message);
  return lines.join("\n");
}
