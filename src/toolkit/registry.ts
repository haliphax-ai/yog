/**
 * The tool registry and its OpenAI-function-derivation helpers. Split out of
 * the toolkit barrel so tools can import types without a cycle.
 */
import { z } from "zod";
import type {
  ChatCompletionFunctionTool,
  ChatCompletionTool,
} from "openai/resources/chat/completions/completions.mjs";
import { type ToolResult, type ToolSpec } from "./types.ts";
import { capToolResult } from "./truncation.ts";

/** Derive the OpenAI function definition from a tool spec's zod schema. */
export function toFunctionTool(spec: ToolSpec): ChatCompletionFunctionTool {
  return {
    type: "function",
    function: {
      name: spec.name,
      description: spec.description,
      parameters: z.toJSONSchema(spec.schema),
    },
  };
}

/** One in-flight (or just-finished) tool call, as observed by the hooks. */
export interface ToolCall {
  /** Tool name (e.g. `bash`). */
  name: string;
  /** Validated arguments object. */
  args: Record<string, unknown>;
}

/**
 * Optional context for a registry execution. The turn engine passes the
 * engine's abort signal, the owning session id (the tool-level abort key),
 * and start/end hooks so the server can address the tool call that is
 * currently running for a session.
 */
export interface ToolExecuteContext {
  /** Already-aborted signal ⇒ the call fails before the tool runs. */
  signal?: AbortSignal;
  /**
   * Abort sentinel polled while the tool runs (same contract as the turn
   * engine's `isAborted`). When it flips, the call rejects with an
   * `AbortError` so the engine's unwind/heal path synthetically resolves
   * the announced call instead of waiting for a tool that may never settle.
   * Callers that already pass `signal` derived from the same source get
   * identical behaviour from either mechanism; predicate-only callers
   * (no `signal`) still unwind mid-tool instead of hanging.
   */
  isAborted?: () => boolean;
  /** Owning session id — forwarded to the tool as the abort key. */
  sessionId?: string;
  /** Explicit persistent-state override (bash shell snapshots); the daemon path derives it per session. */
  stateDir?: string;
  /** Fired just before the tool runs. */
  onStart?: (call: ToolCall) => void;
  /** Fired when the tool settles (result or throw). */
  onEnd?: (call: ToolCall) => void;
}

/** Format a zod error the way the harness reports validation failures. */
export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "arguments";
      if (issue.code === "unrecognized_keys") {
        const keys = (issue as { keys?: string[] }).keys ?? [];
        return keys.map((key) => `unexpected field "${key}"`).join("; ");
      }
      if (issue.code === "invalid_type" && /received undefined/.test(issue.message)) {
        // zod v4 reports missing required fields as invalid_type with an
        // undefined received value baked into the message
        return `missing required field "${path}"`;
      }
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * Registry of harness tools keyed by tool name. New tools are added by
 * implementing `ToolSpec` and calling `registry.add(tool)`.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolSpec>();

  constructor(tools: ToolSpec[] = []) {
    for (const tool of tools) this.add(tool);
  }

  add(tool: ToolSpec): void {
    this.tools.set(tool.name, tool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** The registered spec for `name`, or undefined. */
  get(name: string): ToolSpec | undefined {
    return this.tools.get(name);
  }

  get definitions(): ChatCompletionTool[] {
    return [...this.tools.values()].map(toFunctionTool);
  }

  /**
   * Execute one tool call: validate arguments against the tool's zod schema,
   * abort with `error` set when validation fails, and convert thrown
   * exceptions into `error` on the response. Returns undefined when the tool
   * name is unknown.
   *
   * The optional context carries turn-abort plumbing: `signal` (an already
   * aborted signal rejects the call immediately) and the observation hooks
   * the server uses to address a running call (`onStart`/`onEnd`). Existing
   * two-argument callers are unaffected — context is optional.
   */
  async execute(
    name: string,
    rawArgs: string | null,
    ctx: ToolExecuteContext = {},
  ): Promise<ToolResult | undefined> {
    const tool = this.tools.get(name);
    if (!tool) return undefined;

    const makeAbortError = (): Error => {
      const err = new Error("tool call aborted");
      err.name = "AbortError";
      return err;
    };
    const isAbortedNow = (): boolean => {
      if (ctx.signal?.aborted === true) return true;
      try {
        return ctx.isAborted?.() === true;
      } catch {
        return false;
      }
    };
    if (isAbortedNow()) throw makeAbortError();

    let parsed: unknown;
    try {
      parsed = rawArgs === null || rawArgs.trim() === "" ? {} : JSON.parse(rawArgs);
    } catch (err) {
      return tool.failure(`invalid JSON arguments: ${(err as Error).message}`);
    }

    const result = tool.schema.safeParse(parsed);
    if (!result.success) {
      return tool.failure(formatZodError(result.error));
    }

    const call: ToolCall = { name, args: parsed as Record<string, unknown> };
    // Fallback output cap (issue #29): a tool that does not limit itself gets
    // its serialized result middle-truncated at the registry boundary, so a
    // huge file read or web fetch can never crash the model's context window.
    // The bash tool already caps its own streams; this covers every tool.
    const runP = tool
      .run(result.data as Record<string, unknown>, {
        ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}),
        ...(ctx.stateDir !== undefined ? { stateDir: ctx.stateDir } : {}),
      })
      .then((res) => capToolResult(res));
    // A thrown tool run becomes a failure result (never a turn unwind),
    // matching the no-abort path below. Abort rejections are the only
    // exceptions that propagate: they trigger the engine's heal path.
    const settledP: Promise<ToolResult> = runP.catch((err: unknown) =>
      tool.failure(err instanceof Error ? (err.message as string) : String(err)),
    );
    void settledP.catch(() => undefined);
    try {
      ctx.onStart?.(call);
      if (ctx.signal || ctx.isAborted) {
        // Turn abort mid-call: reject so the turn engine's unwind/heal path
        // runs (the announced-but-unanswered call is stubbed there). The
        // tool's own late settlement is discarded — the turn is unwinding.
        // An already-aborted signal rejects immediately: the `abort` event
        // fired before this listener could attach, so check the flag first.
        const abortErr = makeAbortError();
        if (isAbortedNow()) throw abortErr;
        const abortP = new Promise<never>((_resolve, reject) => {
          if (ctx.signal) {
            ctx.signal.addEventListener("abort", () => reject(abortErr), { once: true });
          }
          if (ctx.isAborted) {
            const timer = setInterval(() => {
              if (isAbortedNow()) {
                clearInterval(timer);
                reject(abortErr);
              }
            }, 10);
            timer.unref?.();
            void settledP.then(
              () => clearInterval(timer),
              () => clearInterval(timer),
            );
          }
        });
        return await Promise.race([settledP, abortP]);
      }
      return await settledP;
    } finally {
      ctx.onEnd?.(call);
    }
  }
}
