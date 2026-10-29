import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemon, type DaemonOptions } from "../../src/server/serve.ts";
import type { Daemon } from "../../src/server/serve.ts";
import { SessionStore } from "../../src/server/store/sessions.ts";
import { newSessionId } from "../../src/state/index.ts";

/** Minimal SSE frame parser: splits `event:`/`data:` blocks. */
interface Frame {
  event: string;
  data: any;
}

function parseSse(text: string): Frame[] {
  const frames: Frame[] = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    let event = "";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (event) frames.push({ event, data: JSON.parse(data) });
  }
  return frames;
}

/** `Response.json()` with a loose type: assertions do the checking. */
async function json(res: Response): Promise<any> {
  return (await res.json()) as any;
}

/** Fake model that captures the `messages` argument it receives. */
function capturingModel() {
  const captured: { messages: any[]; prompt: string; model: string }[] = [];
  return {
    captured,
    async runTurn(
      _sessionId: string,
      req: any,
      ctx: { emit: (ev: any) => Promise<void>; signal?: AbortSignal },
    ) {
      captured.push({
        messages: req.messages ?? [],
        prompt: req.prompt,
        model: req.model ?? "fake",
      });
      const turnId = newSessionId();
      await ctx.emit({
        id: 1,
        type: "turn.started",
        version: 1,
        ts: Date.now(),
        data: { turnId, model: req.model ?? "fake", ts: Date.now() },
      });
      await ctx.emit({
        id: 2,
        type: "message.delta",
        version: 1,
        ts: Date.now(),
        data: { text: "ack" },
      });
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 30);
        ctx.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          resolve();
        });
      });
      await ctx.emit({
        id: 3,
        type: "turn.finished",
        version: 1,
        ts: Date.now(),
        data: { turnId, durationMs: 1 },
      });
    },
  };
}

let daemon: Daemon;
let base: string;
let dir: string;
let store: SessionStore;
let model: ReturnType<typeof capturingModel>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "yog-exec-"));
  store = new SessionStore(join(dir, "sessions.db"));
  model = capturingModel();
  const opts: DaemonOptions = {
    host: "127.0.0.1",
    port: 0,
    deps: {
      capabilities: {
        contractVersion: "v1",
        models: ["fake-model"],
        tools: ["bash"],
        features: ["sse"],
      },
      store: store as any,
      model: model as any,
    },
  };
  daemon = await createDaemon(opts);
  base = daemon.url;
});

afterAll(async () => {
  await daemon?.close();
  store?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("executeTurn (orchestrator path)", () => {
  it("hydrates prior transcript and persists this turn's messages", async () => {
    const sessionRes = await fetch(`${base}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const session = (await sessionRes.json()) as { session: { id: string } };
    const sid = session.session.id;

    const r1 = await fetch(`${base}/v1/sessions/${sid}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hello" }),
    });
    await r1.text();

    const r2 = await fetch(`${base}/v1/sessions/${sid}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "world" }),
    });
    await r2.text();

    const captured = model.captured as {
      messages: any[];
      prompt: string;
      model: string;
    }[];
    expect(captured).toHaveLength(2);
    const turn2Messages = captured[1]!.messages;
    const userMsgs = turn2Messages.filter((m) => m.role === "user");
    expect(userMsgs.some((m) => m.content === "hello")).toBe(true);
    expect(userMsgs.some((m) => m.content === "world")).toBe(true);

    const transcript = store.getTranscript(sid);
    const roles = transcript.map((m: any) => m.role);
    expect(roles.filter((r) => r === "user")).toHaveLength(2);
  });

  it("does not bleed transcript across sessions", async () => {
    const mk = async () => {
      const r = await fetch(`${base}/v1/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      return ((await r.json()) as { session: { id: string } }).session.id;
    };
    const a = await mk();
    const b = await mk();

    await (
      await fetch(`${base}/v1/sessions/${a}/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "alpha" }),
      })
    ).text();
    await (
      await fetch(`${base}/v1/sessions/${b}/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "beta" }),
      })
    ).text();

    const ta = store.getTranscript(a);
    const tb = store.getTranscript(b);
    expect(ta.some((m: any) => m.content === "beta")).toBe(false);
    expect(tb.some((m: any) => m.content === "alpha")).toBe(false);
  });

  it("persists nothing on a failed turn", async () => {
    const sessionRes = await fetch(`${base}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const sid = ((await sessionRes.json()) as { session: { id: string } }).session.id;

    const before = store.getTranscript(sid);
    expect(before).toHaveLength(0);

    const failModel = {
      captured: [] as any[],
      async runTurn() {
        this.captured.push({ messages: [], prompt: "fail", model: "fake" });
        throw new Error("boom");
      },
    };
    const failDaemon = await createDaemon({
      host: "127.0.0.1",
      port: 0,
      deps: {
        capabilities: {
          contractVersion: "v1",
          models: ["fake-model"],
          tools: ["bash"],
          features: ["sse"],
        },
        store: store as any,
        model: failModel as any,
      },
    });
    try {
      const r = await fetch(`${failDaemon.url}/v1/sessions/${sid}/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "fail" }),
      });
      await r.text();
    } finally {
      await failDaemon.close();
    }

    const after = store.getTranscript(sid);
    expect(after).toHaveLength(0);
  });
});
