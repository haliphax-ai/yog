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
   */
  async execute(name: string, rawArgs: string | null): Promise<ToolResult | undefined> {
    const tool = this.tools.get(name);
    if (!tool) return undefined;

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

    try {
      return await tool.run(result.data as Record<string, unknown>);
    } catch (err) {
      return tool.failure(err instanceof Error ? err.message : String(err));
    }
  }
}
