import { z } from "zod";
import type {
  ChatCompletionFunctionTool,
  ChatCompletionTool,
} from "openai/resources/chat/completions/completions.mjs";

/**
 * Shared plumbing for harness tools, backed by zod schemas.
 *
 * A harness tool is a model-facing function: it declares a zod schema for its
 * arguments, derives the OpenAI function definition from that schema, and
 * runs. The `ToolRegistry` holds the active tools and executes calls by name,
 * so adding a tool is just implementing `ToolSpec` and registering it.
 */

/**
 * Result envelope for every tool. `error` is set instead of running the tool
 * when the call fails schema validation, and carries the exception message
 * when the tool itself throws.
 */
export interface ToolResult {
  error?: string;
  [key: string]: unknown;
}

export interface ToolSpec<
  TArgs extends Record<string, unknown> = Record<string, unknown>,
  TResult extends ToolResult = ToolResult,
> {
  /** OpenAI function name. */
  name: string;
  /** Human-readable description for the model. */
  description: string;
  /** Zod schema for the tool's arguments. */
  schema: z.ZodType<TArgs>;
  /** Response shape used when the call is aborted (validation error / exception). */
  failure(error: string): TResult;
  run(args: TArgs): Promise<TResult>;
}

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
