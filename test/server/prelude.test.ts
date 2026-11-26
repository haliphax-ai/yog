import { describe, expect, it } from "vitest";
import {
  createPreludeSink,
  deliverPrelude,
  serializePrelude,
  HARNESS_NOTICE_HINT,
  HARNESS_NOTICE_TOOL,
  PRELUDE_MAX_CHARS,
  type PreludePayload,
} from "../../src/server/daemon/prelude.ts";

describe("PreludeSink", () => {
  it("drains in FIFO order, once — then the queue is empty", () => {
    const sink = createPreludeSink();
    expect(sink.drain("s1")).toBeUndefined();
    sink.push("s1", "kind-a", "first");
    sink.push("s1", "kind-b", "second");
    sink.push("s1", "kind-c", "third");
    const first = sink.drain("s1");
    expect(first).toEqual([
      { kind: "kind-a", body: "first" },
      { kind: "kind-b", body: "second" },
      { kind: "kind-c", body: "third" },
    ]);
    expect(sink.drain("s1")).toBeUndefined();
    sink.push("s1", "kind-d", "fourth");
    expect(sink.drain("s1")).toEqual([{ kind: "kind-d", body: "fourth" }]);
  });

  it("keys queues per session — draining one never touches another", () => {
    const sink = createPreludeSink();
    sink.push("a", "k", "for-a");
    sink.push("b", "k", "for-b");
    expect(sink.drain("a")).toEqual([{ kind: "k", body: "for-a" }]);
    expect(sink.drain("b")).toEqual([{ kind: "k", body: "for-b" }]);
    expect(sink.drain("a")).toBeUndefined();
    expect(sink.drain("b")).toBeUndefined();
  });

  it("clear purges without delivering — the next drain is empty", () => {
    const sink = createPreludeSink();
    sink.push("s", "kind", "never delivered");
    sink.push("s", "kind", "also gone");
    sink.clear("s");
    expect(sink.drain("s")).toBeUndefined();
    // clear on an unknown session is a no-op
    expect(() => sink.clear("ghost")).not.toThrow();
  });
});

describe("deliverPrelude (the harness_notice pair)", () => {
  it("returns undefined for an empty set — no pair, no rows", () => {
    expect(deliverPrelude([])).toBeUndefined();
  });

  it("frames the exact contractual pair: empty args, hint + notices in the result", () => {
    const pair = deliverPrelude([{ kind: "background-jobs", body: "job finished: 3 files" }]);
    expect(pair).toBeDefined();
    // Call row: assistant, null content, exactly one harness_notice call.
    expect(pair!.call.role).toBe("assistant");
    expect(pair!.call.content).toBeNull();
    expect(pair!.call.tool_calls).toHaveLength(1);
    const call = pair!.call.tool_calls[0]!;
    expect(call.type).toBe("function");
    expect(call.function.name).toBe(HARNESS_NOTICE_TOOL);
    expect(call.function.arguments).toBe("{}");
    expect(call.id).toMatch(/^call_hn_/);
    // Result row: answers the same id with the hint + notices payload.
    expect(pair!.result.role).toBe("tool");
    expect(pair!.result.tool_call_id).toBe(call.id);
    const payload = JSON.parse(pair!.result.content) as PreludePayload;
    expect(payload.hint).toBe(HARNESS_NOTICE_HINT);
    expect(payload.notices).toEqual([{ kind: "background-jobs", body: "job finished: 3 files" }]);
  });

  it("mints a fresh call id per delivery (pair ids never collide)", () => {
    const a = deliverPrelude([{ kind: "k", body: "1" }])!;
    const b = deliverPrelude([{ kind: "k", body: "2" }])!;
    expect(a.call.tool_calls[0]!.id).not.toBe(b.call.tool_calls[0]!.id);
    expect(a.result.tool_call_id).toBe(a.call.tool_calls[0]!.id);
    expect(b.result.tool_call_id).toBe(b.call.tool_calls[0]!.id);
  });

  it("keeps multiple notices in order within one pair", () => {
    const pair = deliverPrelude([
      { kind: "a", body: "one" },
      { kind: "b", body: "two" },
    ])!;
    const payload = JSON.parse(pair.result.content) as PreludePayload;
    expect(payload.notices.map((n) => n.kind)).toEqual(["a", "b"]);
    expect(payload.notices.map((n) => n.body)).toEqual(["one", "two"]);
  });
});

describe("serializePrelude (the safety clamp)", () => {
  it("passes a small payload through byte-identical", () => {
    const payload: PreludePayload = {
      hint: HARNESS_NOTICE_HINT,
      notices: [{ kind: "k", body: "small" }],
    };
    expect(serializePrelude(payload)).toBe(JSON.stringify(payload));
  });

  it("middle-truncates an over-long payload to the clamp (marker survives)", () => {
    const payload: PreludePayload = {
      hint: HARNESS_NOTICE_HINT,
      notices: [{ kind: "k", body: "x".repeat(PRELUDE_MAX_CHARS * 2) }],
    };
    const out = serializePrelude(payload);
    expect(out.length).toBeLessThanOrEqual(PRELUDE_MAX_CHARS);
    expect(out).toContain("TRUNCATED");
    // After a raw cut the JSON is no longer parseable — the clamp bounds
    // SIZE; what the contract pins is head (hint) + tail survival.
    const TAIL = `x` + String.fromCharCode(34) + `}]}`;
    expect(out.endsWith(TAIL)).toBe(true);
  });

  it("an exempt notice rides the clamp untouched (per-notice, producer-declared)", () => {
    const payload: PreludePayload = {
      hint: HARNESS_NOTICE_HINT,
      notices: [{ kind: "background jobs", body: "job bg_1 finished", exemptFromClamp: true }],
    };
    expect(serializePrelude(payload)).toBe(JSON.stringify(payload));
  });

  it("mixed exempt + clamped notices still clamp (the clamp is per-pair, not per-notice)", () => {
    const payload: PreludePayload = {
      hint: HARNESS_NOTICE_HINT,
      notices: [
        { kind: "background jobs", body: "tool result rides", exemptFromClamp: true },
        { kind: "k", body: "x".repeat(PRELUDE_MAX_CHARS * 2) },
      ],
    };
    const out = serializePrelude(payload);
    expect(out.length).toBeLessThanOrEqual(PRELUDE_MAX_CHARS);
    expect(out).toContain("TRUNCATED");
  });

  it("pushResult marks its notices exempt (the tool result is already capped)", () => {
    const sink = createPreludeSink();
    sink.pushResult("s1", "background jobs", "job bg_1 finished · exit 0", "bash", {
      stdout: "out",
      exitCode: 0,
    });
    expect(sink.drain("s1")![0]!.exemptFromClamp).toBe(true);
  });

  it("pushResult carries the tool name and settled result on the notice, verbatim", () => {
    const sink = createPreludeSink();
    const result = { stdout: "a".repeat(10_000), exitCode: 0 };
    sink.pushResult("s1", "background jobs", "job bg_1 finished · exit 0", "bash", result);
    const notices = sink.drain("s1")!;
    expect(notices).toHaveLength(1);
    expect(notices[0]!.kind).toBe("background jobs");
    expect(notices[0]!.tool).toBe("bash");
    // No truncation at the notice layer — the tool boundary owns that.
    expect(notices[0]!.result).toEqual(result);
  });

  it("a tool-result notice survives deliverPrelude + serializePrelude intact", () => {
    const sink = createPreludeSink();
    const result = { exitCode: 0, stdout: "out".repeat(500) };
    sink.pushResult("s1", "background jobs", "job bg_1 finished", "bash", result);
    const delivered = deliverPrelude(sink.drain("s1")!);
    const payload = JSON.parse(delivered!.result.content) as PreludePayload;
    expect(payload.notices[0]!.tool).toBe("bash");
    expect(payload.notices[0]!.result).toEqual(result);
  });
});
