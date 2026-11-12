/**
 * Skill layer tests: parser, validator, manager, and the CLI surface
 * (`yog skills` dispatch + the daemon-side `/v1/agent-cli` registry).
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSkillMarkdown } from "../src/skills/parser.ts";
import {
  isModelInvocationDisabled,
  skillNameError,
  splitFullName,
  toFrontmatter,
} from "../src/skills/validator.ts";
import { SkillManager } from "../src/skills/manager.ts";
import { availableSkillsBlock, dispatchSkillsCommand } from "../src/skills/commands.ts";
import { getCommand, registerCommand, type CliCommand } from "../src/server/cli.ts";
import { parseYamlSubset } from "../src/skills/parser.ts";

const SKILL_MD = `---
name: demo
description: A demo skill for testing
---
Demo skill body.
`;

/** A temp tree with `<dir>/.yog/skills/<name>/` (SKILL.md + scripts/). */
function makeSkillTree(name: string, children: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "yog-skills-"));
  const skillDir = join(dir, ".yog", "skills", name);
  mkdirSync(skillDir, { recursive: true });
  mkdirSync(join(skillDir, "scripts"), { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), SKILL_MD.replace("demo", name));
  writeFileSync(join(skillDir, "scripts", "hello.sh"), "#!/bin/sh\ntrue\n");
  for (const child of children) {
    const childDir = join(skillDir, child);
    mkdirSync(childDir, { recursive: true });
    writeFileSync(join(childDir, "SKILL.md"), SKILL_MD.replace("demo", child));
  }
  return dir;
}

/** Options with the cwd-only skill source (keeps host-installed skills out). */
function testDiscover(dir: string) {
  return {
    sources: [{ source: "cwd" as const, dir: ".yog/skills" }],
    cwd: dir,
  };
}

/** Register a minimal `skills` agent-CLI command over `manager` (test shim). */
function registerTestSkillsCommand(manager: SkillManager): void {
  const cmd: CliCommand = {
    name: "skills",
    description: "skills test command",
    usage: "skills",
    async execute(args) {
      const [sub = "list", ...rest] = args;
      const result = await dispatchSkillsCommand(manager, [sub, ...rest]);
      if (result.message !== undefined) return `${result.message}\n`;
      if (result.result !== undefined) return `${result.result.message}\n`;
      if (result.entries !== undefined && result.entries.length > 0) {
        return (
          (result.entries as unknown as Array<{ name: string }>).map((e) => e.name).join("\n") +
          "\n"
        );
      }
      return "(none)\n";
    },
  };
  registerCommand(cmd);
}

describe("parseSkillMarkdown", () => {
  it("splits frontmatter from body", () => {
    const parsed = parseSkillMarkdown(SKILL_MD);
    expect(parsed.frontmatter.name).toBe("demo");
    expect(parsed.frontmatter.description).toBe("A demo skill for testing");
    expect(parsed.body.trim()).toBe("Demo skill body.");
  });

  it("rejects a missing frontmatter fence", () => {
    expect(() => parseSkillMarkdown("no frontmatter here")).toThrow();
  });

  it("rejects a missing description", () => {
    expect(() => parseSkillMarkdown("---\nname: demo\n---\nbody")).toThrow();
  });
});
describe("disable-model-invocation frontmatter", () => {
  it("parses the key and types it as a boolean", () => {
    const parsed = parseSkillMarkdown(
      "---\nname: hidden\ndescription: shh\ndisable-model-invocation: true\n---\nbody",
    );
    expect(parsed.frontmatter.disableModelInvocation).toBe(true);
    expect(parsed.frontmatter.extra["disable-model-invocation"]).toBeUndefined();
    expect(isModelInvocationDisabled(parsed.frontmatter)).toBe(true);
  });

  it("defaults to false and rejects non-boolean values", () => {
    const plain = parseSkillMarkdown("---\nname: shown\ndescription: hello\n---\nbody");
    expect(plain.frontmatter.disableModelInvocation).toBe(false);
    expect(isModelInvocationDisabled(plain.frontmatter)).toBe(false);
    expect(() =>
      parseSkillMarkdown(
        '---\nname: bad\ndescription: hello\ndisable-model-invocation: "yes"\n---\nbody',
      ),
    ).toThrow(/must be a boolean/);
    expect(toFrontmatter(parseYamlSubset("disable-model-invocation: true"))).toMatchObject({
      disableModelInvocation: true,
    });
  });
});

describe("validator", () => {
  it("accepts lowercase slug names", () => {
    expect(skillNameError("demo")).toBeUndefined();
    expect(skillNameError("a-b-c")).toBeUndefined();
  });

  it("rejects invalid names", () => {
    expect(skillNameError("Demo")).toBeDefined();
    expect(skillNameError("a b")).toBeDefined();
    expect(skillNameError("")).toBeDefined();
    expect(skillNameError("a".repeat(65))).toBeDefined();
  });

  it("splits namespaced names", () => {
    expect(splitFullName("parent:child")).toEqual(["parent", "child"]);
    expect(splitFullName("bare")).toEqual(["bare", undefined]);
  });
});

describe("SkillManager", () => {
  it("discovers bare and package skills", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yog-skills-"));
    const skillsDir = join(dir, ".yog", "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "bare.md"), SKILL_MD.replace("demo", "bare"));
    const pkgDir = join(skillsDir, "pkg");
    mkdirSync(pkgDir, { recursive: true });
    mkdirSync(join(pkgDir, "scripts"), { recursive: true });
    writeFileSync(join(pkgDir, "SKILL.md"), SKILL_MD.replace("demo", "pkg"));
    const mgr = new SkillManager({ discover: testDiscover(dir) });
    await mgr.discover();
    const list = await mgr.list("s");
    expect(list.map((e) => e.name).sort()).toEqual(["bare", "pkg"]);
    expect(list.find((e) => e.name === "pkg")?.hasScripts).toBe(true);
    expect(list.find((e) => e.name === "bare")?.hasScripts).toBe(false);
  });

  it("ignores a top-level SKILL.md in a source directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yog-skills-"));
    const skillsDir = join(dir, ".yog", "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "SKILL.md"), SKILL_MD);
    const mgr = new SkillManager({ discover: testDiscover(dir) });
    await mgr.discover();
    expect(await mgr.list("s")).toEqual([]);
  });

  it("lists child skills only when the parent is loaded", async () => {
    const dir = makeSkillTree("parent", ["child"]);
    const mgr = new SkillManager({ discover: testDiscover(dir) });
    await mgr.discover();
    const before = await mgr.list("s");
    expect(before.map((e) => e.name).sort()).toEqual(["parent"]);
    // Loading a child while the parent is unloaded fails.
    expect(await mgr.load("parent:child", "s")).toMatchObject({ ok: false });
    expect(await mgr.load("parent", "s")).toMatchObject({ ok: true });
    const after = await mgr.list("s");
    expect(after.map((e) => e.name).sort()).toEqual(["parent", "parent:child"]);
    expect(await mgr.unload("parent", "s")).toMatchObject({ ok: true });
    expect((await mgr.list("s")).map((e) => e.name)).toEqual(["parent"]);
  });

  it("load/unload tracks scripts and instructions per session", async () => {
    const dir = makeSkillTree("demo");
    const mgr = new SkillManager({ discover: testDiscover(dir) });
    await mgr.discover();
    expect(mgr.getScriptPathsFor("s")).toEqual([]);
    expect(await mgr.load("demo", "s")).toMatchObject({ ok: true, status: "loaded" });
    expect(mgr.getScriptPathsFor("s")).toEqual([join(dir, ".yog", "skills", "demo", "scripts")]);
    expect(mgr.getScriptPathsFor("other")).toEqual([]);
    const instructions = await mgr.getInstructions("s");
    expect(instructions).toContain("demo");
    expect(await mgr.getInstructions("other")).toBe("");
    expect(await mgr.unload("demo", "s")).toMatchObject({ ok: true });
    expect(mgr.getScriptPathsFor("s")).toEqual([]);
    expect(await mgr.getInstructions("s")).toBe("");
  });

  it("loading twice is a no-op", async () => {
    const dir = makeSkillTree("demo");
    const mgr = new SkillManager({ discover: testDiscover(dir) });
    await mgr.discover();
    expect(await mgr.load("demo", "s")).toMatchObject({ ok: true, status: "loaded" });
    expect(await mgr.load("demo", "s")).toMatchObject({ ok: true, status: "noop" });
  });

  it("unloading an unloaded skill is a no-op", async () => {
    const dir = makeSkillTree("demo");
    const mgr = new SkillManager({ discover: testDiscover(dir) });
    await mgr.discover();
    expect(await mgr.unload("demo", "s")).toMatchObject({ ok: false, status: "noop" });
  });

  it("loading an unknown skill fails", async () => {
    const dir = makeSkillTree("demo");
    const mgr = new SkillManager({ discover: testDiscover(dir) });
    await mgr.discover();
    expect(await mgr.load("nope", "s")).toMatchObject({ ok: false });
  });

  it("status reports loaded skills for the session", async () => {
    const dir = makeSkillTree("demo");
    const mgr = new SkillManager({ discover: testDiscover(dir) });
    await mgr.discover();
    expect(await mgr.status("s")).toEqual([]);
    await mgr.load("demo", "s");
    const status = await mgr.status("s");
    expect(status.map((e) => e.name)).toEqual(["demo"]);
    await mgr.unload("demo", "s");
    expect(await mgr.status("s")).toEqual([]);
  });
});

describe("skills commands", () => {
  it("lists available skills with a --verbose block", async () => {
    const dir = makeSkillTree("demo");
    const mgr = new SkillManager({ discover: testDiscover(dir) });
    await mgr.discover();
    const result = await dispatchSkillsCommand(mgr, ["list", "--verbose"]);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("demo");
  });

  it("load/unload/status round-trip", async () => {
    const dir = makeSkillTree("demo");
    const mgr = new SkillManager({ discover: testDiscover(dir) });
    await mgr.discover();
    expect(await dispatchSkillsCommand(mgr, ["load", "demo"])).toMatchObject({ ok: true });
    expect(await dispatchSkillsCommand(mgr, ["status"])).toMatchObject({ ok: true });
    expect(await dispatchSkillsCommand(mgr, ["unload", "demo"])).toMatchObject({ ok: true });
  });

  it("load requires a name", async () => {
    const dir = makeSkillTree("demo");
    const mgr = new SkillManager({ discover: testDiscover(dir) });
    await mgr.discover();
    const result = await dispatchSkillsCommand(mgr, ["load"]);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("usage");
  });

  it("unknown subcommands fail", async () => {
    const dir = makeSkillTree("demo");
    const mgr = new SkillManager({ discover: testDiscover(dir) });
    await mgr.discover();
    expect(await dispatchSkillsCommand(mgr, ["frobnicate"])).toMatchObject({ ok: false });
  });
});

describe("agent-cli registry", () => {
  it("renders skill entries as text", async () => {
    const dir = makeSkillTree("demo");
    const mgr = new SkillManager({ discover: testDiscover(dir) });
    await mgr.discover();
    registerTestSkillsCommand(mgr);
    const text = await getCommand("skills")!.execute(["list"]);
    expect(text).toContain("demo");
  });

  it("reports load failures as text", async () => {
    const dir = makeSkillTree("demo");
    const mgr = new SkillManager({ discover: testDiscover(dir) });
    await mgr.discover();
    registerTestSkillsCommand(mgr);
    const ok = await getCommand("skills")!.execute(["load", "demo"]);
    expect(ok).toContain("loaded");
    const fail = await getCommand("skills")!.execute(["load", "nope"]);
    expect(fail).toContain("nope");
  });
});

describe("skills command via agent-cli registry", () => {
  it("help describes the skills command", () => {
    const dir = makeSkillTree("demo");
    const mgr = new SkillManager({ discover: testDiscover(dir) });
    registerTestSkillsCommand(mgr);
    const help = getCommand("help")!.execute([]);
    expect(help).toContain("skills");
  });
});

describe("available-skills prompt block", () => {
  it("lists skills with descriptions and points at `yog skills help`", async () => {
    const dir = makeSkillTree("demo");
    const mgr = new SkillManager({ discover: testDiscover(dir) });
    await mgr.discover();
    const block = await availableSkillsBlock(mgr, "s");
    expect(block).toContain("# Available skills");
    expect(block).toContain("- **demo** — A demo skill for testing");
    expect(block).toContain("`yog skills help`");
    expect(block).not.toContain("yog skills load");
  });

  it("hides loaded skills, gates child skills on the parent, and marks children", async () => {
    const dir = makeSkillTree("parent", ["child"]);
    const mgr = new SkillManager({ discover: testDiscover(dir) });
    await mgr.discover();
    // While the parent is unloaded the child is not loadable, so neither
    // appears in the block (only top-level entries are advertised).
    const before = await availableSkillsBlock(mgr, "s");
    expect(before).toContain("- **parent** — A demo skill for testing");
    expect(before).not.toContain("parent:child");
    // Once the parent is loaded the child shows up with its marker, and the
    // parent itself drops out (it is loaded).
    await mgr.load("parent", "s");
    const after = await availableSkillsBlock(mgr, "s");
    expect(after).not.toContain("parent (child skill)");
    expect(after).toContain("- **parent:child (child skill)** — A demo skill for testing");
    expect(after).not.toContain("- **parent** —");
  });
});

describe("disable-model-invocation behavior", () => {
  it("hides the skill from list, verbose list, and the prompt block", async () => {
    const dir = makeSkillTree("loud");
    const skillsDir = join(dir, ".yog", "skills");
    writeFileSync(
      join(skillsDir, "shy.md"),
      "---\nname: shy\ndescription: A hidden skill\ndisable-model-invocation: true\n---\nSecret body.\n",
    );
    const mgr = new SkillManager({ discover: testDiscover(dir) });
    await mgr.discover();
    const rows = await mgr.list("s");
    expect(rows.map((e) => e.name)).toEqual(["loud"]);
    const result = await dispatchSkillsCommand(mgr, ["list", "--verbose"]);
    expect(result.message).toContain("loud");
    expect(result.message).not.toContain("shy");
    const block = await availableSkillsBlock(mgr, "s");
    expect(block).toContain("- **loud** — A demo skill for testing");
    expect(block).not.toContain("shy");
  });

  it("refuses to load a hidden skill from the agent surface", async () => {
    const dir = makeSkillTree("loud");
    const skillsDir = join(dir, ".yog", "skills");
    writeFileSync(
      join(skillsDir, "shy.md"),
      "---\nname: shy\ndescription: A hidden skill\ndisable-model-invocation: true\n---\nSecret body.\n",
    );
    const mgr = new SkillManager({ discover: testDiscover(dir) });
    await mgr.discover();
    const result = await dispatchSkillsCommand(mgr, ["load", "shy"]);
    expect(result.ok).toBe(false);
    expect(result.result).toMatchObject({ ok: false, status: "not_found" });
    expect(result.result?.message).toContain("not available to this agent");
    expect(await mgr.status("s")).toEqual([]);
  });
});
