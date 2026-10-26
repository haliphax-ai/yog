/**
 * fuse-overlay-harness — agent harness with a virtual FUSE filesystem.
 *
 * Usage: yog run <modelId> "<prompt>"
 *
 * Mounts /yog (containing the virtual `list` file) and runs a streaming
 * chat completion with tools against the given model, exiting when the stream
 * ends.
 */
import { homedir } from "node:os";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions.mjs";
import { tools, descriptors } from "./register.ts";
import { AgentFSState, DEFAULT_AGENT_ID, newSessionId } from "./state/index.ts";
import { setBashExecutor, setShellStateProvider } from "./toolkit/index.ts";
import { shutdownAllWorkers, WorkerClient } from "./worker/index.ts";
import { parseCliArgs } from "./cli.ts";
import { mountSys, unmountSys } from "./mount.ts";
import { TurnEngine } from "./turn.ts";
import { StdoutSink } from "./turn/sink.ts";
import { exists, mkdir, readdir, stat } from "./host.ts";

/** The path the virtual filesystem is mounted at. */
const MOUNT_POINT = "/yog";

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

/**
 * Ensure `mnt` exists and is readable by the current user before mounting over
 * it. FUSE requires the mountpoint to exist and be accessible to the mounting
 * user; failing here produces a precise error instead of fuse-native's opaque
 * "failed to open mountpoint" message.
 */
async function ensureMountPoint(mnt: string): Promise<void> {
  if (!(await exists(mnt))) {
    await mkdir(mnt, { recursive: true });
  }
  const st = await stat(mnt);
  if (!st.isDirectory()) {
    throw new Error(`mountpoint ${mnt} exists but is not a directory`);
  }
  const currentUid = process.getuid?.() ?? -1;
  const currentGid = process.getgid?.() ?? -1;
  // mode bits (rwx for owner = 0o700); access is meaningful only when we can
  // *read* the directory (r) and *traverse* it (x).
  const mode = st.mode & 0o777;
  const isOwner = st.uid === currentUid;
  const isGroup = st.gid === currentGid;
  const canRead =
    (isOwner && (mode & 0o400) !== 0) || (isGroup && (mode & 0o040) !== 0) || (mode & 0o004) !== 0;
  const canExec =
    (isOwner && (mode & 0o100) !== 0) || (isGroup && (mode & 0o010) !== 0) || (mode & 0o001) !== 0;
  if (!canRead || !canExec) {
    throw new Error(
      `mountpoint ${mnt} (uid=${st.uid} gid=${st.gid} mode=${mode.toString(8)}) is not ` +
        `readable+searchable by the current user (uid=${currentUid} gid=${currentGid}); ` +
        "ensure the mountpoint is owned by / accessible to the harness user",
    );
  }
  await readdir(mnt);
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
  // Agent identity is a runtime value, not an env var — multi-agent
  // orchestration will open a state db per agent id.
  const agentId = DEFAULT_AGENT_ID;

  // Startup diagnostics: the daemon/agent split is sensitive to which user
  // the harness runs as, where its home is, and whether the mountpoint is
  // accessible — print the facts up front so misconfiguration is obvious.
  console.error(
    `[yog] run uid=${process.getuid?.() ?? "?"} gid=${process.getgid?.() ?? "?"} ` +
      `home=${homedir()} cwd=${process.cwd()} mount=${MOUNT_POINT}`,
  );

  // The agent state/audit trail is best-effort: if the database cannot be
  // opened, the harness continues without it.
  let state: AgentFSState | undefined;
  try {
    state = await AgentFSState.open({ agentId });
  } catch (err) {
    console.error(
      `warning: opening agent state failed (${(err as Error).message}); ` +
        "continuing without audit trail (ensure /var/lib/yog is writable by the yog user, " +
        "or set YOG_STATE_PATH to a writable path)",
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
    await ensureMountPoint(MOUNT_POINT);
    fuse = await mountSys(descriptors.buildOps(), MOUNT_POINT);
  } catch (err) {
    console.error(
      `warning: could not mount ${MOUNT_POINT} (${(err as Error).message}); ` +
        "continuing without the virtual filesystem",
    );
  }

  const messages: ChatCompletionMessageParam[] = [{ role: "user", content: prompt }];

  let code = 0;
  try {
    await new TurnEngine(new StdoutSink()).run(client, modelId, messages, tools, {
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
