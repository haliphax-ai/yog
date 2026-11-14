/**
 * Shared skill types.
 *
 * A *skill* is an [`Agent Skills`](https://agentskills.io)-style instruction
 * bundle the agent can inspect and load on demand: a `SKILL.md` document
 * (YAML frontmatter + markdown body) and an optional package structure
 * (`scripts/`, `references/`, `assets/`) next to it.
 * A skill may opt out of agent invocation with
 * `disable-model-invocation: true` in its frontmatter: it is then hidden
 * from the available-skills list and cannot be loaded by the agent.
 * (Loading such skills for the agent from the operator side is planned but
 * not implemented yet.)
 *
 * Skills are discovered from up to three sources (system, agent home, working
 * directory); see `discover.ts`.
 */

/** Where a skill was discovered. Sources are scanned in this order. */
export type SkillSource = "system" | "agent" | "cwd";

/** A discovered skill, as reported by discovery (no body parsed yet). */
export interface SkillMetadata {
  /** Validated, unique skill name (`^[a-z0-9]+(-[a-z0-9]+)*$`, 1–64 chars). */
  readonly name: string;
  /** `<parent name>:<child name>` for one level of child skills, else `name`. */
  readonly fullName: string;
  /** Owning (parent) skill's `fullName`, or the top-level `name` when none. */
  readonly parentName: string | undefined;
  /** Name of this skill's child skills, in directory order. */
  readonly childNames: readonly string[];
  /** `true` when this is a child (namespaced) skill. */
  readonly isChild: boolean;
  /** Source directory this skill was discovered in. */
  readonly source: SkillSource;
  /** Absolute path of the skill directory. */
  readonly path: string;
  /** Absolute path of the skill's `SKILL.md`. */
  readonly skillFile: string;
  /** Absolute path of the `scripts/` directory, when present. */
  readonly scriptsDir: string | undefined;
  /** Absolute path of the `references/` directory, when present. */
  readonly referencesDir: string | undefined;
  /** Absolute path of the `assets/` directory, when present. */
  readonly assetsDir: string | undefined;
  /** Top-level skill name for child skills; equals `name` otherwise. */
  readonly trunkName: string;
}

/** Parsed YAML frontmatter of a `SKILL.md`. */
export interface SkillFrontmatter {
  readonly name: string;
  readonly description: string;
  readonly license: string | undefined;
  readonly compatibility: string | undefined;
  readonly metadata: Readonly<Record<string, unknown>> | undefined;
  readonly allowedTools: readonly string[] | undefined;
  /** True when `disable-model-invocation: true` hides this from the agent. */
  readonly disableModelInvocation: boolean;
  /** Any frontmatter keys outside the known set (kept for round-tripping). */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** A loaded skill: metadata plus parsed `SKILL.md` content. */
export interface Skill extends SkillMetadata {
  readonly frontmatter: SkillFrontmatter;
  /** Markdown body of `SKILL.md` (frontmatter stripped), trimmed. */
  readonly body: string;
  /** `SKILL.md` size in bytes as read from disk. */
  readonly sizeBytes: number;
}

/** Per-session loaded-skill record (persisted shape). */
export interface SkillState {
  readonly name: string;
  /** Epoch ms when the skill was loaded. */
  readonly loadedAt: number;
  readonly source: SkillSource;
  readonly path: string;
}

/** In-memory record of a loaded skill, with its resolved script dir. */
export interface LoadedSkillState extends SkillState {
  readonly scriptsDir: string | undefined;
}

/** Result of a `load` / `unload` operation. */
export interface SkillCommandResult {
  readonly ok: boolean;
  readonly name: string;
  readonly status: "loaded" | "unloaded" | "noop" | "not_found" | "error";
  readonly message: string;
  readonly scriptsDir?: string;
  readonly unloaded?: readonly string[];
}

/** One row of `yog skills list`. */
export interface SkillListEntry {
  readonly name: string;
  readonly source: SkillSource;
  readonly path: string;
  readonly loaded: boolean;
  readonly description: string | undefined;
  readonly isChild: boolean;
  readonly hasScripts: boolean;
}

/** One row of `yog skills status`. */
export interface SkillStatusEntry {
  readonly name: string;
  readonly source: SkillSource;
  readonly path: string;
  readonly loadedAt: number;
  readonly scriptsDir: string | undefined;
}

/** Structured result of a `yog skills` command. */
export interface SkillsCommandResult {
  readonly command: "list" | "load" | "unload" | "status" | "help";
  readonly ok: boolean;
  readonly entries?: readonly SkillListEntry[] | readonly SkillStatusEntry[];
  readonly result?: SkillCommandResult;
  readonly message?: string;
}

/**
 * Descriptors for the skills commands (see `server/commands.ts` for the
 * shared `CommandDescriptor` shape). `SKILLS_COMMANDS` itself lives in
 * `server/commands.ts` because the skills domain sits below the server and
 * may not import from it (domain-entry-only); serve.ts wires it.
 */
