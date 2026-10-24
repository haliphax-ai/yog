/**
 * fuse-overlay-harness — agent harness with a virtual FUSE filesystem.
 *
 * Usage: npm start -- <modelId> "<prompt>"
 *
 * Mounts ./sys (containing the virtual `tool` list file) and runs a streaming
 * chat completion with tools against the given model, exiting when the stream
 * ends.
 */
import OpenAI from 'openai'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions/completions.mjs'
import { ListStore } from './store.ts'
import { mountSys, unmountSys } from './mount.ts'
import { executeToolCall, toolDefinitions } from './tools.ts'

const USAGE = 'usage: npm start -- <modelId> "<prompt>"'

async function main(): Promise<void> {
  const [modelId, ...promptParts] = process.argv.slice(2)
  if (!modelId || promptParts.length === 0) {
    console.error(USAGE)
    process.exit(1)
  }
  const prompt = promptParts.join(' ')

  // Env vars are used when set, for OpenAI-compatible proxies; otherwise the
  // SDK defaults (OPENAI_BASE_URL / OPENAI_API_KEY) apply.
  const client = new OpenAI({
    ...(process.env['OPENAI_BASE_URL'] ? { baseURL: process.env['OPENAI_BASE_URL'] } : {}),
    ...(process.env['OPENAI_API_KEY'] ? { apiKey: process.env['OPENAI_API_KEY'] } : {}),
  })

  const store = new ListStore()
  let fuse: Awaited<ReturnType<typeof mountSys>> | undefined
  try {
    fuse = await mountSys(store)
  } catch (err) {
    console.error(
      `warning: could not mount ./sys (${(err as Error).message}); continuing without the virtual filesystem`,
    )
  }

  const messages: ChatCompletionMessageParam[] = [{ role: 'user', content: prompt }]

  let code = 0
  try {
    await runLoop(client, modelId, messages)
  } catch (err) {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err))
    code = 1
  } finally {
    // Teardown is best-effort and bounded: a hung unmount or an open stream
    // handle must not keep the harness alive after the answer is delivered.
    await Promise.race([
      unmountSys(fuse),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ])
    process.exitCode = code
    setTimeout(() => process.exit(code), 250).unref()
  }
}

/**
 * Stream one completion, execute any tool calls it contains (feeding the
 * results back in), and repeat until the model answers without tools.
 */
async function runLoop(
  client: OpenAI,
  modelId: string,
  messages: ChatCompletionMessageParam[],
): Promise<void> {
  // Bound the tool-call loop so a misbehaving model cannot spin forever.
  for (let round = 0; round < 16; round++) {
    const stream = await client.chat.completions.create({
      model: modelId,
      messages,
      tools: toolDefinitions,
      stream: true,
    })

    const toolCalls = new Map<number, { id: string; name: string; args: string }>()

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta
      if (!delta) continue

      if (delta.content) {
        process.stdout.write(delta.content)
      }

      for (const tc of delta.tool_calls ?? []) {
        const index = tc.index ?? 0
        const entry = toolCalls.get(index) ?? { id: '', name: '', args: '' }
        if (tc.id) entry.id = tc.id
        if (tc.function?.name) entry.name = tc.function.name
        if (tc.function?.arguments) entry.args += tc.function.arguments
        toolCalls.set(index, entry)
      }
    }

    if (toolCalls.size === 0) {
      process.stdout.write('\n')
      return
    }

    const ordered = [...toolCalls.entries()].sort(([a], [b]) => a - b)

    // Replay the assistant turn, then append one tool message per call.
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: ordered.map(([i, tc]) => ({
        id: tc.id || `call_${i}`,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.args },
      })),
    })

    for (const [i, tc] of ordered) {
      const result = await executeToolCall(tc.name, tc.args)
      // Tool activity goes to stderr so stdout remains a clean response stream.
      console.error(
        `[tool] ${tc.name}(${tc.args}) -> ` +
          (result === undefined
            ? 'unknown tool'
            : result['error']
              ? `error: ${result['error']}`
              : `exitCode=${result['exitCode']} runtimeMs=${result['runtimeMs']}`),
      )
      const payload =
        result === undefined
          ? JSON.stringify({ error: `unknown tool "${tc.name}"` })
          : JSON.stringify(result)
      messages.push({
        role: 'tool',
        tool_call_id: tc.id || `call_${i}`,
        content: payload,
      })
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err))
  process.exit(1)
})