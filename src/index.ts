/**
 * fuse-overlay-harness — agent harness with a virtual FUSE filesystem.
 *
 * Usage: yog run <modelId> "<prompt>"
 *
 * Mounts /yog (containing the virtual `list` file) and runs a streaming
 * chat completion with tools against the given model, exiting when the stream
 * ends.
 */
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions.mjs";
import { tools, descriptors } from "./register.ts";
import { AgentFSState, newSessionId } from "./state/index.ts";
import { setBashExecutor, setShellStateProvider } from "./toolkit/index.ts";
import { shutdownAllWorkers, WorkerClient } from "./worker/index.ts";
import { parseCliArgs } from "./cli.ts";
import { mountSys, unmountSys } from "./mount.ts";
import { runTurn } from "./turn.ts";

const USAGE = 'usage: yog run <modelId> "<prompt>"';

/**
 * Termination handling. The first SIGINT/SIGTERM aborts the in-flight model
 * stream and proceeds through the normal bounded teardown; a second signal
 * (or a stalled teardown) force-exits so the process never wedges.
 */
const abortController = new AbortController();
let exitRequested = false;

function requestExit(signal: NodeJS.Signals): void {
  if (exitRequested) {
    console.error(`forced exit after repeated ${signal}`);
    process.exit(130);
  }
  exitRequested = true;
  console.error(`received ${signal}; aborting turn and tearing down`);
  abortController.abort();
  setTimeout(() => process.exit(130), 3000).unref();
}

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(parsed.error);
    console.error(USAGE);
    process.exit(1);
  }
  const { modelId, prompt } = parsed;

  const sessionId = newSessionId();

  // The agent state/audit trail is best-effort: if the database cannot be
  // opened, the harness continues without it.
  let state: AgentFSState | undefined;
  try {
    state = await AgentFSState.open();
  } catch (err) {
    console.error(
      `warning: opening agent state failed (${(err as Error).message}); continuing without audit trail`,
    );
  }

  // Back the bash shell state with agentfs when the state db is available.
  setShellStateProvider(
    state
      ? {
          load: () => state.loadShellSnapshot(sessionId),
          save: (snapshot) => state.saveShellSnapshot(sessionId, snapshot),
        }
      : undefined,
  );

  // The worker executes bash on the harness's behalf. The composition root
  // owns its lifecycle and injects it into the bash tool — the tool layer
  // never talks to the worker directly.
  let worker: WorkerClient | undefined;
  try {
    worker = await WorkerClient.start();
    setBashExecutor((script, opts) => worker!.runBash(script, opts?.stateDir, opts?.restore));
  } catch (err) {
    console.error(
      `warning: starting worker failed (${(err as Error).message}); bash tool unavailable`,
    );
  }

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
    await runTurn(client, modelId, messages, tools, {
      signal: abortController.signal,
      sessionId,
      ...(state ? { recorder: { record: (rec) => state.recordToolCall(rec) } } : {}),
    });
  } catch (err) {
    if (abortController.signal.aborted) {
      code = 130;
    } else {
      console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
      code = 1;
    }
  } finally {
    // Teardown is best-effort and bounded: a hung unmount or an open stream
    // handle must not keep the harness alive after the answer is delivered.
    await Promise.race([unmountSys(fuse), new Promise((resolve) => setTimeout(resolve, 1500))]);
    if (state) {
      await state.close().catch(() => {});
    }
    await shutdownAllWorkers().catch(() => {});
    process.exitCode = code;
    setTimeout(() => process.exit(code), 250).unref();
  }
}

process.on("SIGINT", () => requestExit("SIGINT"));
process.on("SIGTERM", () => requestExit("SIGTERM"));

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
