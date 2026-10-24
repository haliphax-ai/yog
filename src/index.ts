/**
 * fuse-overlay-harness — agent harness with a virtual FUSE filesystem.
 *
 * Usage: npm start -- <modelId> "<prompt>"
 *
 * Mounts ./sys (containing the virtual `list` file) and runs a streaming
 * chat completion with tools against the given model, exiting when the stream
 * ends.
 */
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions.mjs";
import { tools, descriptors } from "./register.ts";
import { mountSys, unmountSys } from "./mount.ts";
import { runTurn } from "./turn.ts";

const USAGE = 'usage: npm start -- <modelId> "<prompt>"';

async function main(): Promise<void> {
  const [modelId, ...promptParts] = process.argv.slice(2);
  if (!modelId || promptParts.length === 0) {
    console.error(USAGE);
    process.exit(1);
  }
  const prompt = promptParts.join(" ");

  // Env vars are used when set, for OpenAI-compatible proxies; otherwise the
  // SDK defaults (OPENAI_BASE_URL / OPENAI_API_KEY) apply.
  const client = new OpenAI({
    ...(process.env["OPENAI_BASE_URL"] ? { baseURL: process.env["OPENAI_BASE_URL"] } : {}),
    ...(process.env["OPENAI_API_KEY"] ? { apiKey: process.env["OPENAI_API_KEY"] } : {}),
  });

  // Registries come from the wiring manifest (register.ts).
  let fuse: Awaited<ReturnType<typeof mountSys>> | undefined;
  try {
    fuse = await mountSys(descriptors.buildOps());
  } catch (err) {
    console.error(
      `warning: could not mount ./sys (${(err as Error).message}); continuing without the virtual filesystem`,
    );
  }

  const messages: ChatCompletionMessageParam[] = [{ role: "user", content: prompt }];

  let code = 0;
  try {
    await runTurn(client, modelId, messages, tools);
  } catch (err) {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    code = 1;
  } finally {
    // Teardown is best-effort and bounded: a hung unmount or an open stream
    // handle must not keep the harness alive after the answer is delivered.
    await Promise.race([unmountSys(fuse), new Promise((resolve) => setTimeout(resolve, 1500))]);
    process.exitCode = code;
    setTimeout(() => process.exit(code), 250).unref();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
