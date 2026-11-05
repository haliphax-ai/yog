import { describe, expect, it, vi } from "vitest";
import { bashTool, ToolRegistry } from "../src/toolkit/index.ts";
import { TRUNCATION_IDENTIFIER, createShakeRunner } from "../src/server/shake.ts";
import { createDaemon } from "../src/server/serve.ts";

const registry = new ToolRegistry([bashTool]);

function stubStore(rows: any[]) {
  const updateMessage = vi.fn(async () => undefined);
  return { rows, updateMessage, getTranscript: vi.fn(async () => rows) };
}

describe("bash truncateArgs", () => {
  it("middle-truncates a long command to 1000 chars with the marker", () => {
    const args = JSON.stringify({ command: "x".repeat(1500) });
    const out = JSON.parse(registry.get("bash")!.truncateArgs!(args));
    const command = out.command as string;
    expect(command.length).toBe(1000);
    expect(command).toContain(TRUNCATION_IDENTIFIER);
    const parts = command.split(TRUNCATION_IDENTIFIER);
    const head = parts[0]!;
    const tail = parts[1]!;
    expect(head).toBe("x".repeat(head.length));
    expect(tail).toBe("x".repeat(tail.length));
  });

  it("leaves short commands untouched", () => {
    const args = JSON.stringify({ command: "echo hi" });
    expect(registry.get("bash")!.truncateArgs!(args)).toBe(args);
  });
});

describe("bash truncateResult", () => {
  it("fairly splits the 1000-char budget when both streams are huge", () => {
    const tool = registry.get("bash")!;
    const result = tool.truncateResult!({
      stdout: "o".repeat(2000),
      stderr: "e".repeat(2000),
      runtimeMs: 1,
      exitCode: 0,
    }) as { stdout: string; stderr: string };
    expect(result.stdout).toContain(TRUNCATION_IDENTIFIER);
    expect(result.stderr).toContain(TRUNCATION_IDENTIFIER);
    expect(result.stdout.length).toBe(500);
    expect(result.stderr.length).toBe(500);
  });

  it("gives one stream its unused share to the other", () => {
    const tool = registry.get("bash")!;
    const result = tool.truncateResult!({
      stdout: "o".repeat(100),
      stderr: "e".repeat(2000),
      runtimeMs: 1,
      exitCode: 0,
    }) as { stdout: string; stderr: string };
    expect(result.stdout).toBe("o".repeat(100));
    expect(result.stderr).toContain(TRUNCATION_IDENTIFIER);
    expect(result.stderr.length).toBe(900);
  });

  it("returns undefined when nothing needs truncation", () => {
    const tool = registry.get("bash")!;
    expect(
      tool.truncateResult!({ stdout: "ok", stderr: "", runtimeMs: 1, exitCode: 0 }),
    ).toBeUndefined();
  });
});

describe("createShakeRunner", () => {
  it("rewrites assistant args and tool results in place", async () => {
    const longArgs = JSON.stringify({ command: "x".repeat(1200) });
    const longResult = JSON.stringify({
      stdout: "o".repeat(1200),
      stderr: "e".repeat(1200),
      runtimeMs: 1,
      exitCode: 0,
    });
    const rows = [
      {
        seq: 1,
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "bash", arguments: longArgs },
          },
        ],
      },
      {
        seq: 2,
        role: "tool",
        tool_call_id: "c1",
        name: "bash",
        content: longResult,
      },
    ];
    const store = stubStore(rows);
    const shake = createShakeRunner({ store, registry });
    const outcome = await shake("s1");

    expect(outcome).toEqual({ argsTruncated: 1, resultsTruncated: 1 });
    expect(store.updateMessage).toHaveBeenCalledTimes(2);

    const updateCalls = store.updateMessage.mock.calls as unknown as Array<
      [string, number, { tool_calls_json?: string; content?: string }]
    >;
    const argsPatch = updateCalls.find((c) => c[1] === 1)?.[2];
    expect(argsPatch).toBeDefined();
    const calls = JSON.parse(argsPatch!.tool_calls_json!);
    expect(calls[0].function.arguments).toContain(TRUNCATION_IDENTIFIER);

    const resultPatch = updateCalls.find((c) => c[1] === 2)?.[2];
    const parsed = JSON.parse(resultPatch!.content!);
    expect(parsed.stdout).toContain(TRUNCATION_IDENTIFIER);
    expect(parsed.stderr).toContain(TRUNCATION_IDENTIFIER);
  });

  it("is a no-op when nothing is oversized", async () => {
    const rows = [
      {
        seq: 1,
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: {
              name: "bash",
              arguments: JSON.stringify({ command: "echo hi" }),
            },
          },
        ],
      },
      {
        seq: 2,
        role: "tool",
        tool_call_id: "c1",
        name: "bash",
        content: JSON.stringify({ stdout: "hi", stderr: "", runtimeMs: 1, exitCode: 0 }),
      },
    ];
    const store = stubStore(rows);
    const shake = createShakeRunner({ store, registry });
    const outcome = await shake("s1");
    expect(outcome).toEqual({ argsTruncated: 0, resultsTruncated: 0 });
    expect(store.updateMessage).not.toHaveBeenCalled();
  });
});

describe("generic fallback without per-tool truncators", () => {
  it("wraps oversized args in a truncated blob", async () => {
    const rawArgs = "y".repeat(1200);
    const rows = [
      {
        seq: 1,
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "bash", arguments: rawArgs },
          },
        ],
      },
    ];
    const store = stubStore(rows);
    const shake = createShakeRunner({ store, registry: new ToolRegistry([]) });
    const outcome = await shake("s1");
    expect(outcome.argsTruncated).toBe(1);

    const argsPatch = (
      store.updateMessage.mock.calls as unknown as Array<
        [string, number, { tool_calls_json?: string }]
      >
    )[0]?.[2];
    const calls = JSON.parse(argsPatch!.tool_calls_json!);
    const blob = JSON.parse(calls[0].function.arguments);
    expect(blob.truncated).toBeDefined();
    expect(blob.truncated.length).toBe(1000);
    expect(blob.truncated).toContain(TRUNCATION_IDENTIFIER);
  });

  it("wraps oversized results in a truncated blob", async () => {
    const longContent = "z".repeat(1200);
    const rows = [
      {
        seq: 1,
        role: "tool",
        tool_call_id: "c1",
        name: "bash",
        content: longContent,
      },
    ];
    const store = stubStore(rows);
    await createShakeRunner({ store, registry: new ToolRegistry([]) })("s1");
    const contentPatch = (
      store.updateMessage.mock.calls as unknown as Array<[string, number, { content?: string }]>
    )[0]?.[2];

    const blob = JSON.parse(contentPatch!.content!);
    expect(blob.truncated).toBeDefined();
    expect(blob.truncated.length).toBe(1000);
    expect(blob.truncated).toContain(TRUNCATION_IDENTIFIER);
  });
});

describe("HTTP /shake route", () => {
  it("returns truncation counts from the boundary", async () => {
    const shake = vi.fn(async () => ({ argsTruncated: 2, resultsTruncated: 1 }));
    const daemon = await createDaemon({
      host: "127.0.0.1",
      port: 0,
      deps: {
        capabilities: {
          contractVersion: "v1",
          models: ["m"],
          tools: [],
          features: ["sse", "transcript", "shake"],
        },
        shake,
      },
    });
    try {
      const created = await fetch(daemon.url + "/v1/sessions", { method: "POST" });
      expect(created.status).toBe(201);
      const session = ((await created.json()) as { session: { id: string } }).session;
      const res = await fetch(daemon.url + "/v1/sessions/" + session.id + "/shake", {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body).toMatchObject({ ok: true, argsTruncated: 2, resultsTruncated: 1 });
      expect(shake).toHaveBeenCalledWith(session.id);
    } finally {
      await daemon.close();
    }
  });
});
