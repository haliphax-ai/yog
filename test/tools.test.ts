import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashTool, setBashExecutor, toFunctionTool, ToolRegistry } from "../src/toolkit/index.ts";
import { WorkerClient } from "../src/worker/index.ts";

const registry = new ToolRegistry([bashTool]);
const bashDefinition = toFunctionTool(bashTool);

let worker: WorkerClient | undefined;

beforeAll(async () => {
  // Wire a real worker as the bash executor (mirrors the composition root).
  worker = await WorkerClient.start();
  setBashExecutor((script, opts) => worker!.runBash(script, opts?.stateDir, opts?.restore));
});

afterAll(async () => {
  await worker?.close().catch(() => {});
});

describe("tool definitions", () => {
  it("exposes a single bash tool for starters", () => {
    expect(registry.has("bash")).toBe(true);
    expect(registry.definitions).toHaveLength(1);
    expect((registry.definitions[0] as { function: { name: string } }).function.name).toBe("bash");
  });

  it("requires a single command string", () => {
    const params = bashDefinition.function.parameters as {
      required: string[];
      properties: Record<string, { type?: unknown }>;
    };
    expect(params.required).toEqual(["command"]);
    expect(params.properties["command"]?.type).toBe("string");
  });
});

describe("schema validation", () => {
  it("accepts a valid call", () => {
    expect(bashTool.schema.safeParse({ command: "echo hi" }).success).toBe(true);
  });

  it("rejects a missing required field", () => {
    const r = bashTool.schema.safeParse({});
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toMatch(/command/);
  });

  it("rejects extra fields", () => {
    const r = bashTool.schema.safeParse({ command: "echo", cwd: "/tmp" });
    expect(r.success).toBe(false);
  });

  it("rejects an invalid field type", () => {
    const r = bashTool.schema.safeParse({ command: 42 });
    expect(r.success).toBe(false);
  });
});

describe("registry.execute", () => {
  it("runs bash and returns stdout/exitCode", async () => {
    const result = await registry.execute("bash", JSON.stringify({ command: "echo hello" }));
    expect(result?.error).toBeUndefined();
    expect(result?.["stdout"]).toBe("hello\n");
    expect(result?.["exitCode"]).toBe(0);
    expect(typeof result?.["runtimeMs"]).toBe("number");
  });

  it("reports the exit code of a failing script", async () => {
    const result = await registry.execute("bash", JSON.stringify({ command: "exit 7" }));
    expect(result?.["exitCode"]).toBe(7);
    expect(result?.error).toBeUndefined();
  });

  it("aborts on schema violation with error and null output fields", async () => {
    const result = await registry.execute("bash", JSON.stringify({}));
    expect(result?.["error"]).toMatch(/missing required field "command"/);
    expect(result?.["stdout"]).toBeNull();
    expect(result?.["stderr"]).toBeNull();
    expect(result?.["exitCode"]).toBeNull();
  });

  it("aborts on extra fields", async () => {
    const result = await registry.execute("bash", JSON.stringify({ command: "echo", shell: true }));
    expect(result?.["error"]).toMatch(/unexpected field "shell"/);
    expect(result?.["stdout"]).toBeNull();
  });

  it("sets error on invalid JSON arguments", async () => {
    const result = await registry.execute("bash", "{not json");
    expect(result?.["error"]).toMatch(/invalid JSON arguments/);
    expect(result?.["exitCode"]).toBeNull();
  });

  it("returns undefined for unknown tools", async () => {
    expect(await registry.execute("nope", "{}")).toBeUndefined();
  });
});

describe("host environment hiding", () => {
  it("does not expose host secrets to tool children", async () => {
    process.env["OPENAI_API_KEY"] = "sk-super-secret";
    process.env["GH_TOKEN"] = "ghp_super-secret";
    try {
      const result = await registry.execute("bash", JSON.stringify({ command: "env | sort" }));
      expect(result?.error).toBeUndefined();
      const envOut = String(result?.["stdout"]);
      // secrets gone
      expect(envOut).not.toContain("OPENAI_API_KEY");
      expect(envOut).not.toContain("GH_TOKEN");
      expect(envOut).not.toContain("sk-super-secret");
      // essentials kept
      expect(envOut).toMatch(/^HOME=/m);
      expect(envOut).toMatch(/^PATH=/m);
      // host env beyond the minimal allowlist is not passed through
      expect(envOut).not.toContain("GEMINI_TOKEN");
      expect(envOut).not.toContain("OPENROUTER_TOKEN");
      expect(envOut).not.toContain("NODE_VERSION");
    } finally {
      delete process.env["OPENAI_API_KEY"];
      delete process.env["GH_TOKEN"];
    }
  });
});

describe("bash shell state persistence", () => {
  it("persists cwd, exported variables, and functions across calls", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "harness-state-"));
    try {
      const r1 = await registry.execute(
        "bash",
        JSON.stringify({
          command: "cd /tmp && export FOO=bar && myfn() { echo fn-ok; }",
        }),
        { stateDir },
      );
      expect(r1?.error).toBeUndefined();
      expect(r1?.["exitCode"]).toBe(0);

      const r2 = await registry.execute(
        "bash",
        JSON.stringify({ command: 'printf "%s|%s|" "$PWD" "$FOO"; myfn' }),
        { stateDir },
      );
      expect(r2?.error).toBeUndefined();
      expect(r2?.["stdout"]).toBe("/tmp|bar|fn-ok\n");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
