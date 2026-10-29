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
  /** Owning session id — forwarded to the tool as the abort key. */
  sessionId?: string;
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

    if (ctx.signal?.aborted) {
      return tool.failure("aborted before the tool call started");
    }

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
    const runP = tool.run(result.data as Record<string, unknown>, {
      ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}),
    });
    if (ctx.signal) {
      // Turn abort mid-call: reject so the turn engine's unwind/heal path
      // runs (the announced-but-unanswered call is stubbed there). The
      // tool's own late settlement is discarded — the turn is unwinding.
      // An already-aborted signal rejects immediately: the `abort` event
      // fired before this listener could attach, so check the flag first.
      void runP.catch(() => undefined);
      const abortErr = new Error("tool call aborted");
      abortErr.name = "AbortError";
      if (ctx.signal.aborted) throw abortErr;
      return await Promise.race([
        runP,
        new Promise<never>((_resolve, reject) => {
          ctx.signal!.addEventListener("abort", () => reject(abortErr), { once: true });
        }),
      ]);
    }
    try {
      return await runP;
    } catch (err) {
      return tool.failure(err instanceof Error ? (err.message as string) : String(err));
    } finally {
      ctx.onEnd?.(call);
    }
  }
}
