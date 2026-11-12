import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bashTool,
  jsonEscapedLen,
  setBashExecutor,
  setShellStateProvider,
  setToolOutputBudgets,
  toFunctionTool,
  ToolRegistry,
  TOOL_OUTPUT_GRACE_CHARS,
  TOOL_OUTPUT_LIMIT_CHARS,
  type ToolSpec,
} from "../src/toolkit/index.ts";
import { TRUNCATION_IDENTIFIER } from "../src/toolkit/index.ts";
import { z } from "zod";
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

describe("shell snapshot provider keying", () => {
  it("loads and saves the snapshot under the call's session id", async () => {
    const loads: string[] = [];
    const saves: string[] = [];
    setShellStateProvider({
      async load(sessionId) {
        loads.push(sessionId);
        return { cwd: "/tmp", env: "export RESTORED=1\n", functions: "" };
      },
      async save(sessionId) {
        saves.push(sessionId);
      },
    });
    setBashExecutor(async (_script, opts) => {
      expect(opts?.restore).toEqual({ cwd: "/tmp", env: "export RESTORED=1\n", functions: "" });
      return {
        ok: true,
        stdout: "hi\n",
        stderr: "",
        exitCode: 0,
        state: { cwd: "/tmp", env: "export RESTORED=1\n", functions: "" },
      };
    });
    try {
      const result = await registry.execute("bash", JSON.stringify({ command: "echo hi" }), {
        sessionId: "sess-xyz",
      });
      expect(result?.error).toBeUndefined();
      expect(loads).toEqual(["sess-xyz"]);
      expect(saves).toEqual(["sess-xyz"]);
    } finally {
      setShellStateProvider(undefined);
      if (worker) {
        const w = worker;
        setBashExecutor((script, opts) => w.runBash(script, opts?.stateDir, opts?.restore));
      } else {
        setBashExecutor(undefined);
      }
    }
  });
});

describe("tool output limiting", () => {
  it("caps an oversized bash stdout with the shared truncation marker", async () => {
    setToolOutputBudgets(1000, 100);
    try {
      const result = await registry.execute(
        "bash",
        // `tr -d '\n'` keeps the payload newline-free so the JSON escaping
        // cannot push it past the grace window (the fallback must NOT engage
        // here — the bash tool's own cap is what's under test).
        JSON.stringify({ command: "yes | head -c 100000 | tr -d '\n'" }),
      );
      expect(result?.error).toBeUndefined();
      const stdout = String(result?.["stdout"]);
      const stderr = String(result?.["stderr"] ?? "");
      // The shared budget (limit + grace) bounds stdout + stderr together.
      expect(stdout.length + stderr.length).toBeLessThanOrEqual(1100);
      expect(stdout + stderr).toContain(TRUNCATION_IDENTIFIER);
      // The cut keeps head + tail, not a prefix-only cut.
      expect(stdout.length).toBeGreaterThan(0);
    } finally {
      setToolOutputBudgets(TOOL_OUTPUT_LIMIT_CHARS, TOOL_OUTPUT_GRACE_CHARS);
    }
  });

  it("leaves a small result untouched", async () => {
    setToolOutputBudgets(1000, 100);
    try {
      const result = await registry.execute("bash", JSON.stringify({ command: "echo hi" }));
      expect(result?.error).toBeUndefined();
      expect(result?.["stdout"]).toBe("hi\n");
    } finally {
      setToolOutputBudgets(TOOL_OUTPUT_LIMIT_CHARS, TOOL_OUTPUT_GRACE_CHARS);
    }
  });

  it("keeps escape-dense output within the budget where the fallback used to engage", async () => {
    // Regression (issue #48): the cap used to budget on raw `.length`, so
    // JSON-escaping inflated an "in-budget" result past limit + grace and the
    // registry fallback shredded it into a {"truncated": …} envelope. ANSI
    // escapes ( → \u001b, 6x) and backslashes/quotes (2x) are the
    // realistic offenders (colored build logs, jq-style output).
    setToolOutputBudgets(1000, 100);
    const commands: Array<[string, string]> = [
      ["ansi", "printf '\\033[32mok\\033[0m '%s $(yes | head -c 3000) | tr -d '\\n'"],
      ["backslashes", "printf 'a\\\\\\\\b%s' $(yes | head -c 3000) | tr -d '\\n'"],
      ["tabs and quotes", "printf 'x\\ty\\\"z\\\\%s' $(yes | head -c 3000) | tr -d '\\n'"],
    ];
    try {
      for (const [name, command] of commands) {
        const result = await registry.execute("bash", JSON.stringify({ command }));
        expect(result?.error).toBeUndefined();
        const out = String(result?.["stdout"] ?? "");
        const err = String(result?.["stderr"] ?? "");
        expect(out + err).toContain(TRUNCATION_IDENTIFIER);
        // The whole serialized result — escaping included — must fit
        // limit + grace; this is the invariant the fallback used to break.
        const serialized = JSON.stringify(result);
        expect(serialized.length).toBeLessThanOrEqual(1100);
        expect(Object.keys(result ?? {}).sort()).not.toEqual(["originalLength", "truncated"]);
        if (name === "ansi") expect(serialized).toContain("\\u001b");
      }
    } finally {
      setToolOutputBudgets(TOOL_OUTPUT_LIMIT_CHARS, TOOL_OUTPUT_GRACE_CHARS);
    }
  });

  it("measures jsonEscapedLen exactly as JSON.stringify escapes", async () => {
    // Property test pinning the counter to the engine (see jsonEscapedLen):
    // C0 controls, quotes/backslashes, lone surrogates expand; DEL, C1
    // controls, U+2028/2029, and BOM pass through raw on this engine.
    const samples = [
      "",
      "plain ascii",
      'tab\tnewline\ncr\rquote"backslash\\del\x7fnul\x00vt\x0besc\x1b',
      "\u2028\u2029\ufeff\u00ad\x85",
      "😀 flag 🇺🇸 marker [✂️ TRUNCATED]",
      "\ud800 lone high\udc00 lone low\ud83d\ude00 pair",
      Array.from({ length: 0x200 }, (_, i) => String.fromCodePoint(0x20 + i)).join(""),
    ];
    for (const s of samples) expect(jsonEscapedLen(s)).toBe(JSON.stringify(s).length);
  });
});

describe("registry fallback cap (capToolResult)", () => {
  let blobPayload = "x".repeat(2000);
  /** A tool with no truncation of its own: returns a payload verbatim. */
  const blobTool: ToolSpec = {
    name: "blob",
    description: "Return a payload (no self-limiting).",
    schema: z.object({}).strict(),
    failure: (error) => ({ error }),
    run: async () => ({ data: blobPayload }),
  };

  it("wraps an oversized serialized result in a truncated envelope", async () => {
    setToolOutputBudgets(200, 50);
    const local = new ToolRegistry([blobTool]);
    try {
      const result = await local.execute("blob", "{}");
      expect(result?.error).toBeUndefined();
      expect(Object.keys(result ?? {}).sort()).toEqual(["originalLength", "truncated"]);
      expect(result?.["originalLength"]).toBe(JSON.stringify({ data: "x".repeat(2000) }).length);
      const truncated = String(result?.["truncated"]);
      // The envelope's cut is in serialized space: the escaped length is
      // the budget (raw length sits just under — the envelope's own quotes
      // are the two extra chars), and re-serializing the envelope stays
      // within limit + grace.
      expect(jsonEscapedLen(truncated)).toBe(202); // content + the field's quotes
      expect(truncated.length).toBeLessThanOrEqual(200);
      expect(truncated).toContain(TRUNCATION_IDENTIFIER);
      // Head + tail survive a middle cut.
      expect(truncated.startsWith('{"data":"x')).toBe(true);
      expect(truncated.endsWith('xxx"}')).toBe(true);
    } finally {
      setToolOutputBudgets(TOOL_OUTPUT_LIMIT_CHARS, TOOL_OUTPUT_GRACE_CHARS);
    }
  });

  it("leaves a small serialized result untouched", async () => {
    setToolOutputBudgets(200, 50);
    blobPayload = "small payload";
    const local = new ToolRegistry([blobTool]);
    try {
      const result = await local.execute("blob", "{}");
      expect(result?.["data"]).toBe("small payload");
    } finally {
      blobPayload = "x".repeat(2000);
      setToolOutputBudgets(TOOL_OUTPUT_LIMIT_CHARS, TOOL_OUTPUT_GRACE_CHARS);
    }
  });
});

describe("registry abort of an active tool call (issue #35)", () => {
  const fastTool: ToolSpec<{ text: string }> = {
    name: "echo",
    description: "Echo text back.",
    schema: z.object({ text: z.string() }).strict(),
    failure: (error) => ({ error }),
    run: async (args) => ({ echo: args["text"], exitCode: 0, runtimeMs: 1 }),
  };
  const hangingTool: ToolSpec<{ text: string }> = {
    name: "hang",
    description: "Never settles.",
    schema: z.object({ text: z.string() }).strict(),
    failure: (error) => ({ error }),
    run: async () => new Promise<Record<string, unknown>>(() => undefined),
  };

  it("fires onStart/onEnd for a normal call with a signal (no stale in-flight entry)", async () => {
    const local = new ToolRegistry([fastTool]);
    const events: string[] = [];
    const ac = new AbortController();
    const result = await local.execute("echo", '{"text":"hi"}', {
      signal: ac.signal,
      onStart: (call) => void events.push(`start:${call.name}`),
      onEnd: (call) => void events.push(`end:${call.name}`),
    });
    expect(result).toMatchObject({ echo: "hi" });
    expect(events).toEqual(["start:echo", "end:echo"]);
  });

  it("fires onEnd when the call is aborted mid-run via signal", async () => {
    const local = new ToolRegistry([hangingTool]);
    const events: string[] = [];
    const ac = new AbortController();
    const run = local.execute("hang", '{"text":"hi"}', {
      signal: ac.signal,
      onStart: () => void events.push("start"),
      onEnd: () => void events.push("end"),
    });
    await new Promise((r) => setTimeout(r, 20));
    ac.abort(new Error("tool call aborted"));
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(events).toEqual(["start", "end"]);
  });

  it("rejects with AbortError when the signal is already aborted (does not run the tool)", async () => {
    let ran = false;
    const spyTool: ToolSpec<{ text: string }> = {
      ...fastTool,
      run: async (args) => {
        ran = true;
        return fastTool.run(args);
      },
    };
    const local = new ToolRegistry([spyTool]);
    const ac = new AbortController();
    ac.abort(new Error("tool call aborted"));
    await expect(
      local.execute("echo", '{"text":"hi"}', { signal: ac.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(ran).toBe(false);
  });

  it("rejects with AbortError when isAborted flips mid-run (predicate-only abort)", async () => {
    const local = new ToolRegistry([hangingTool]);
    let aborted = false;
    const run = local.execute("hang", '{"text":"hi"}', {
      isAborted: () => aborted,
    });
    await new Promise((r) => setTimeout(r, 20));
    aborted = true;
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
  });

  it("converts a throwing tool run into a failure result even with a signal", async () => {
    const throwingTool: ToolSpec<{ text: string }> = {
      name: "echo",
      description: "Always throws.",
      schema: z.object({ text: z.string() }).strict(),
      failure: (error) => ({ error }),
      run: async () => {
        throw new Error("tool blew up");
      },
    };
    const local = new ToolRegistry([throwingTool]);
    const ac = new AbortController();
    const result = await local.execute("echo", '{"text":"hi"}', { signal: ac.signal });
    expect(result).toMatchObject({ error: "tool blew up" });
  });
});
