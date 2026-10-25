import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions.mjs";
import type { ToolRegistry } from "./toolkit/index.ts";

/**
 * Agent turn engine: streams one chat completion, executes any tool calls it
 * contains (feeding results back in), and repeats until the model answers
 * without tools. This is the loop every agent run funnels through as the
 * harness grows.
 */
export interface TurnOptions {
  /** Abort the in-flight model stream (used for graceful SIGINT/SIGTERM). */
  signal?: AbortSignal;
}

export async function runTurn(
  client: OpenAI,
  modelId: string,
  messages: ChatCompletionMessageParam[],
  tools: ToolRegistry,
  opts: TurnOptions = {},
): Promise<void> {
  // Bound the tool-call loop so a misbehaving model cannot spin forever.
  for (let round = 0; round < 16; round++) {
    const stream = await client.chat.completions.create({
      model: modelId,
      messages,
      tools: tools.definitions,
      stream: true,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });

    const toolCalls = new Map<number, { id: string; name: string; args: string }>();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        process.stdout.write(delta.content);
      }

      for (const tc of delta.tool_calls ?? []) {
        const index = tc.index ?? 0;
        const entry = toolCalls.get(index) ?? { id: "", name: "", args: "" };
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name = tc.function.name;
        if (tc.function?.arguments) entry.args += tc.function.arguments;
        toolCalls.set(index, entry);
      }
    }

    if (toolCalls.size === 0) {
      process.stdout.write("\n");
      return;
    }

    const ordered = [...toolCalls.entries()].sort(([a], [b]) => a - b);

    // Replay the assistant turn, then append one tool message per call.
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: ordered.map(([i, tc]) => ({
        id: tc.id || `call_${i}`,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.args },
      })),
    });

    for (const [i, tc] of ordered) {
      const result = await tools.execute(tc.name, tc.args);
      // Tool activity goes to stderr so stdout remains a clean response stream.
      console.error(
        `[tool] ${tc.name}(${tc.args}) -> ` +
          (result === undefined
            ? "unknown tool"
            : result["error"]
              ? `error: ${result["error"]}`
              : `exitCode=${result["exitCode"]} runtimeMs=${result["runtimeMs"]}`),
      );
      const payload =
        result === undefined
          ? JSON.stringify({ error: `unknown tool "${tc.name}"` })
          : JSON.stringify(result);
      messages.push({
        role: "tool",
        tool_call_id: tc.id || `call_${i}`,
        content: payload,
      });
    }
  }
}
