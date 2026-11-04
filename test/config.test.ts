import { describe, expect, it } from "vitest";
import { chmod, mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG_PATH,
  YogConfigSchema,
  readConfigFile,
  resolveConfig,
} from "../src/config.ts";

describe("YogConfigSchema", () => {
  it("yields a working loopback daemon from an empty object", () => {
    const config = YogConfigSchema.parse({});
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8111);
    expect(config.model).toBe("gpt-4o-mini");
    expect(config.stateRoot).toBe("/var/lib/yog");
    expect(config.mountPoint).toBe("/yog");
    expect(config.maxRoundsPerTurn).toBe(200);
    expect(config.dbSlowMs).toBe(50);
    expect(config.allowOther).toBe(false);
    expect(config.apiToken).toBeUndefined();
    expect(config.providerApiKey).toBeUndefined();
    // The agent split is ON by default (documented UID scheme): agent 1100,
    // daemon 900 runs the process itself. Model-executed code never runs as
    // the daemon.
    expect(config.agentUid).toBe(1100);
    expect(config.agentGid).toBe(1100);
    expect(config.agentHome).toBe("/home/agent");
  });

  it("rejects unknown fields and out-of-range values", () => {
    expect(YogConfigSchema.safeParse({ nope: true }).success).toBe(false);
    expect(YogConfigSchema.safeParse({ port: 70000 }).success).toBe(false);
    expect(YogConfigSchema.safeParse({ port: "8111" }).success).toBe(false);
    expect(YogConfigSchema.safeParse({ maxRoundsPerTurn: 0 }).success).toBe(false);
    expect(YogConfigSchema.safeParse({ workers: 0 }).success).toBe(false);
  });

  it("accepts partial overrides", () => {
    const config = YogConfigSchema.parse({ port: 9000, apiToken: "secret" });
    expect(config.port).toBe(9000);
    expect(config.apiToken).toBe("secret");
    expect(config.host).toBe("127.0.0.1");
  });
});

describe("readConfigFile", () => {
  it("returns undefined for a missing path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yog-config-"));
    expect(await readConfigFile(join(dir, "absent.json"))).toBeUndefined();
  });

  it("returns undefined for a directory at the path (compose stub mount)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yog-config-"));
    const stub = join(dir, "config.json");
    await mkdir(stub);
    expect(await readConfigFile(stub)).toBeUndefined();
  });

  it("reads a JSON file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yog-config-"));
    const file = join(dir, "config.json");
    await writeFile(file, JSON.stringify({ port: 9001 }));
    expect(await readConfigFile(file)).toEqual({ port: 9001 });
  });

  it("returns undefined for an empty file (touched/zero bytes)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yog-config-"));
    const file = join(dir, "config.json");
    await writeFile(file, "");
    expect(await readConfigFile(file)).toBeUndefined();
  });

  it("returns undefined for a whitespace-only file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yog-config-"));
    const file = join(dir, "config.json");
    await writeFile(file, "   ");
    expect(await readConfigFile(file)).toBeUndefined();
  });

  it("throws on malformed JSON (fail loudly)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yog-config-"));
    const file = join(dir, "config.json");
    await writeFile(file, "{not json");
    await expect(readConfigFile(file)).rejects.toThrow();
  });

  it("throws when a present file is unreadable (mounted-but-inaccessible)", async () => {
    // Tests may run as root, which bypasses DAC checks — skip when so.
    if (process.getuid?.() === 0) return;
    const dir = await mkdtemp(join(tmpdir(), "yog-config-"));
    const file = join(dir, "config.json");
    await writeFile(file, JSON.stringify({ port: 9001 }));
    await chmod(file, 0o000);
    try {
      await expect(readConfigFile(file)).rejects.toThrow(/cannot be read/);
    } finally {
      await chmod(file, 0o644);
    }
  });
});

describe("resolveConfig", () => {
  it("uses defaults when no file exists at the path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yog-config-"));
    const config = await resolveConfig({ configPath: join(dir, "absent.json") });
    expect(config.port).toBe(8111);
    expect(config.maxRoundsPerTurn).toBe(200);
  });

  it("merges the file over defaults (partial file keeps the split)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yog-config-"));
    const file = join(dir, "config.json");
    // A config like this (host + model only) must NOT disable the agent
    // split — the merge keeps the schema defaults for untouched keys.
    await writeFile(file, JSON.stringify({ host: "0.0.0.0", model: "inception/mercury-3" }));
    const config = await resolveConfig({ configPath: file });
    expect(config.host).toBe("0.0.0.0");
    expect(config.model).toBe("inception/mercury-3");
    expect(config.port).toBe(8111);
    expect(config.agentUid).toBe(1100);
    expect(config.agentGid).toBe(1100);
    expect(config.agentHome).toBe("/home/agent");
  });

  it("uses defaults for an empty file (touched mount, no content)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yog-config-"));
    const file = join(dir, "config.json");
    await writeFile(file, "");
    const config = await resolveConfig({ configPath: file });
    expect(config.host).toBe("127.0.0.1");
    expect(config.agentUid).toBe(1100);
    expect(config.agentGid).toBe(1100);
    expect(config.agentHome).toBe("/home/agent");
  });

  it("injected config wins over the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yog-config-"));
    const file = join(dir, "config.json");
    await writeFile(file, JSON.stringify({ host: "0.0.0.0", port: 9000 }));
    const config = await resolveConfig({
      configPath: file,
      config: { host: "127.0.0.1" },
    });
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(9000);
  });

  it("validates the merged result (bad file fails loudly)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yog-config-"));
    const file = join(dir, "config.json");
    await writeFile(file, JSON.stringify({ port: 70000 }));
    await expect(resolveConfig({ configPath: file })).rejects.toThrow();
  });

  it("an injected override replaces a bad file value (merge wins last)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yog-config-"));
    const file = join(dir, "config.json");
    await writeFile(file, JSON.stringify({ port: 70000 }));
    const config = await resolveConfig({ configPath: file, config: { port: 1 } });
    expect(config.port).toBe(1);
  });

  it("default path is /var/lib/yog/config.json", () => {
    expect(DEFAULT_CONFIG_PATH).toBe("/var/lib/yog/config.json");
  });
});
