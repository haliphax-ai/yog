import { describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import { createDaemon } from "../src/server/serve.ts";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions.mjs";
import {
  buildCompactionMessages,
  createCompactionRunner,
  loadCompactionTemplate,
  resolveCompactionModel,
  serializeTranscript,
  type CompactionKind,
} from "../src/server/compaction.ts";

const TEMPLATE_SECTIONS = [
  "# <Title>",
  "## Goal",
  "## Plan overview",
  "## Progress",
  "### Completed",
  "### To-do",
  "## Additional context",
  "## Opaque identifiers",
];

/** Fake OpenAI client streaming a single summary completion. */
function summaryClient(text: string): OpenAI {
  return {
    chat: {
      completions: {
        create: async () => {
          return (async function* () {
            yield { choices: [{ delta: { content: text } }] };
          })();
        },
      },
    },
  } as unknown as OpenAI;
}

function stubStore(rows: Array<Record<string, unknown>>) {
  const resetTranscript = vi.fn(
    async (_sessionId: string, msgs: ChatCompletionMessageParam[]) => msgs,
  );
  return {
    getSession: async () => ({ id: "s1", status: "open" }),
    getTranscript: async () => rows,
    resetTranscript,
  };
}

describe("compaction template", () => {
  it("exists and contains every boilerplate section", async () => {
    const template = await loadCompactionTemplate();
    for (const section of TEMPLATE_SECTIONS) {
      expect(template).toContain(section);
    }
  });
});

describe("message building", () => {
  const rows = [
    { role: "system", content: "be concise" },
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi there" },
    { role: "tool", name: "bash", content: "ok", tool_call_id: "c1" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function" }] },
  ];

  it("serializes the transcript into a readable block", () => {
    const text = serializeTranscript(rows);
    expect(text).toContain("[1] system: be concise");
    expect(text).toContain("[2] user: hello");
    expect(text).toContain("[3] assistant: hi there");
    expect(text).toContain("bash — ok");
    expect(text).toContain("tool_calls:");
  });

  it("builds strict system+user messages with the template for both kinds", async () => {
    const template = await loadCompactionTemplate();
    for (const kind of ["compact", "handoff"] as const) {
      const messages = buildCompactionMessages(template, rows, kind);
      expect(messages).toHaveLength(2);
      expect(messages[0]!.role).toBe("system");
      expect(messages[1]!.role).toBe("user");
      const system = String(messages[0]!.content);
      const user = String(messages[1]!.content);
      // Strict output instruction in both paths.
      expect(system).toContain("ONLY the completed markdown document");
      expect(system).toContain("no preamble");
      // Per-kind instruction present.
      if (kind === "compact") {
        expect(system).toContain("compacting a work session");
        expect(system).toContain("tangents");
      } else {
        expect(system).toContain("handoff document");
        expect(system).toContain("taking over this work");
      }
      // Template + transcript embedded in the user message.
      expect(user).toContain("# <Title>");
      expect(user).toContain("== Conversation transcript ==");
      expect(user).toContain("[1] system: be concise");
    }
  });
});

describe("resolveCompactionModel", () => {
  it("defaults to the session model; uses the configured compaction model when set", () => {
    expect(resolveCompactionModel("gpt-4o-mini")).toBe("gpt-4o-mini");
    expect(resolveCompactionModel("gpt-4o-mini", "claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(resolveCompactionModel("gpt-4o-mini", "")).toBe("gpt-4o-mini");
  });
});

describe("createCompactionRunner", () => {
  const summary = "# Compacted\n\n## Goal\nFinish the feature.";

  it("runs an orphan summary turn and resets the transcript with the artifact", async () => {
    const store = stubStore([
      { role: "system", content: "system seed" },
      { role: "user", content: "hello" },
    ]);
    const runner = createCompactionRunner({
      client: summaryClient(summary),
      store,
      model: "session-model",
    });

    const result = await runner("s1", "compact" as CompactionKind);
    expect(result.model).toBe("session-model");
    expect(result.summary).toBe(summary.trim());
    expect(store.resetTranscript).toHaveBeenCalledTimes(1);
    const fresh = store.resetTranscript.mock.calls[0]![1] as ChatCompletionMessageParam[];
    expect(fresh.map((m) => m.role)).toEqual(["system", "assistant"]);
    expect(fresh[1]!.content).toBe(summary.trim());
  });

  it("uses the configured compaction model when present", async () => {
    const store = stubStore([{ role: "user", content: "hello" }]);
    const runner = createCompactionRunner({
      client: summaryClient(summary),
      store,
      model: "session-model",
      compactionModel: "big-model",
    });
    const result = await runner("s1", "handoff" as CompactionKind);
    expect(result.model).toBe("big-model");
  });

  it("throws for an unknown session", async () => {
    const store = {
      getSession: async () => null,
      getTranscript: async () => [],
      resetTranscript: vi.fn(),
    };
    const runner = createCompactionRunner({
      client: summaryClient(summary),
      store,
      model: "session-model",
    });
    await expect(runner("nope", "compact" as CompactionKind)).rejects.toMatchObject({
      code: "unknown_session",
    });
  });

  it("throws when the model produces an empty artifact", async () => {
    const store = stubStore([{ role: "user", content: "hello" }]);
    const runner = createCompactionRunner({
      client: summaryClient("   "),
      store,
      model: "session-model",
    });
    await expect(runner("s1", "compact" as CompactionKind)).rejects.toThrow(/empty summary/);
  });
});

describe("HTTP compaction routes", () => {
  it("compact/handoff run the boundary and return the artifact", async () => {
    const compaction = vi.fn(async (id: string, kind: CompactionKind) => ({
      kind,
      summary: `# ${kind} summary for ${id}`,
      model: "m",
    }));
    const daemon = await createDaemon({
      host: "127.0.0.1",
      port: 0,
      deps: {
        capabilities: {
          contractVersion: "v1",
          models: ["m"],
          tools: [],
          features: ["sse", "transcript", "compact", "handoff"],
        },
        compaction,
      },
    });
    try {
      const created = await fetch(`${daemon.url}/v1/sessions`, { method: "POST" });
      expect(created.status).toBe(201);
      const session = ((await created.json()) as { session: { id: string } }).session;

      for (const kind of ["compact", "handoff"] as const) {
        const res = await fetch(`${daemon.url}/v1/sessions/${session.id}/${kind}`, {
          method: "POST",
        });
        expect(res.status).toBe(200);
        const body: any = await res.json();
        expect(body.ok).toBe(true);
        expect(body.kind).toBe(kind);
        expect(body.summary).toBe(`# ${kind} summary for ${session.id}`);
        expect(compaction).toHaveBeenCalledWith(session.id, kind);
      }
    } finally {
      await daemon.close();
    }
  });

  it("404s for an unknown session", async () => {
    const daemon = await createDaemon({
      host: "127.0.0.1",
      port: 0,
      deps: {
        capabilities: { contractVersion: "v1", models: [], tools: [], features: [] },
        compaction: async () => ({ kind: "compact", summary: "", model: "m" }),
      },
    });
    try {
      const res = await fetch(`${daemon.url}/v1/sessions/nope/compact`, { method: "POST" });
      expect(res.status).toBe(404);
    } finally {
      await daemon.close();
    }
  });
});
