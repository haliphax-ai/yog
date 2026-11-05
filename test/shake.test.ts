import { describe, expect, it, vi } from "vitest";
import { bashTool, ToolRegistry } from "../src/toolkit/index.ts";
import { TRUNCATION_IDENTIFIER, createShakeRunner } from "../src/server/shake.ts";
import { createDaemon } from "../src/server/serve.ts";

const registry = new ToolRegistry([bashTool]);
const noTools = new ToolRegistry([]);

function stubStore(rows: Array<Record<string, unknown>>) {
  const updateMessage = vi.fn(async () => {});
  return {
    getTranscript: async () => rows,
    updateMessage,
  };
}

describe("bash truncateArgs", () => {
  it("middle-truncates a long command to 500 chars with the marker", () => {
    const args = JSON.stringify({ command: "x".repeat(900) });
    const out = JSON.parse(registry.get("bash")!.truncateArgs!(args));
    const command = out.command as string;
    expect(command.length).toBe(500);
    expect(command).toContain(TRUNCATION_IDENTIFIER);
    const parts = command.split(TRUNCATION_IDENTIFIER);
    const head = parts[0]!;
    const tail = parts[1]!;
    expect(head).toBe("x".repeat(head.length));
    expect(tail).toBe("x".repeat(tail.length));
    expect(head).toBe("x".repeat(head.length));
    expect(tail).toBe("x".repeat(tail.length));
  });

  it("leaves short commands untouched", () => {
    const args = JSON.stringify({ command: "echo hi" });
    expect(registry.get("bash")!.truncateArgs!(args)).toBe(args);
  });
});

describe("bash truncateResult", () => {
  it("fairly splits the 500-char budget when both streams are huge", () => {
    const tool = registry.get("bash")!;
    const result = tool.truncateResult!({
      stdout: "o".repeat(1000),
      stderr: "e".repeat(1000),
      runtimeMs: 1,
      exitCode: 0,
    }) as { stdout: string; stderr: string };
    expect(result.stdout).toContain(TRUNCATION_IDENTIFIER);
    expect(result.stderr).toContain(TRUNCATION_IDENTIFIER);
    expect(result.stdout.length).toBe(250);
    expect(result.stderr.length).toBe(250);
  });

  it("gives one stream's unused share to the other", () => {
    const tool = registry.get("bash")!;
    const result = tool.truncateResult!({
      stdout: "o".repeat(100),
      stderr: "e".repeat(2000),
      runtimeMs: 1,
      exitCode: 0,
    }) as { stdout: string; stderr: string };
    expect(result.stdout).toBe("o".repeat(100)); // untouched — inside its share
    expect(result.stderr).toContain(TRUNCATION_IDENTIFIER);
    expect(result.stderr.length).toBe(400); // 500 − stdout's 100
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
    const rows = [
      {
        seq: 1,
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "bash", arguments: JSON.stringify({ command: "y".repeat(700) }) },
          },
        ],
      },
      {
        seq: 2,
        role: "tool",
        name: "bash",
        tool_call_id: "c1",
        content: JSON.stringify({ stdout: "o".repeat(900), stderr: "e".repeat(900), exitCode: 0 }),
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
    expect(argsPatch?.tool_calls_json).toBeDefined();
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
            function: { name: "bash", arguments: '{"command":"echo hi"}' },
          },
        ],
      },
      {
        seq: 2,
        role: "tool",
        name: "bash",
        tool_call_id: "c1",
        content: JSON.stringify({ stdout: "ok", stderr: "", exitCode: 0 }),
      },
    ];
    const store = stubStore(rows);
    const shake = createShakeRunner({ store, registry });
    const outcome = await shake("s1");
    expect(outcome).toEqual({ argsTruncated: 0, resultsTruncated: 0 });
    expect(store.updateMessage).not.toHaveBeenCalled();
  });

  it("applies the generic fallback blob for tools without truncators", async () => {
    const rows = [
      {
        seq: 1,
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "custom", arguments: JSON.stringify({ x: "z".repeat(700) }) },
          },
        ],
      },
      {
        seq: 2,
        role: "tool",
        name: "custom",
        tool_call_id: "c1",
        content: JSON.stringify({ data: "q".repeat(700) }),
      },
    ];
    const store = stubStore(rows);
    const shake = createShakeRunner({ store, registry: noTools });
    const outcome = await shake("s1");

    expect(outcome).toEqual({ argsTruncated: 1, resultsTruncated: 1 });
    const updateCalls = store.updateMessage.mock.calls as unknown as Array<
      [string, number, { tool_calls_json?: string; content?: string }]
    >;
    const argsPatch = updateCalls.find((c) => c[1] === 1)?.[2];
    const calls = JSON.parse(argsPatch!.tool_calls_json!);
    const argsBlob = JSON.parse(calls[0].function.arguments);
    expect(argsBlob.truncated).toContain(TRUNCATION_IDENTIFIER);

    const resultPatch = updateCalls.find((c) => c[1] === 2)?.[2];
    const resultBlob = JSON.parse(resultPatch!.content!);
    expect(resultBlob.truncated).toContain(TRUNCATION_IDENTIFIER);
  });
});

describe("HTTP /shake route", () => {
  it("returns truncation counts and the refreshed session", async () => {
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
      const created = await fetch(`${daemon.url}/v1/sessions`, { method: "POST" });
      const session = ((await created.json()) as { session: { id: string } }).session;
      const res = await fetch(`${daemon.url}/v1/sessions/${session.id}/shake`, {
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
