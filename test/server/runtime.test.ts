import { afterEach, describe, expect, it } from "vitest";
import { agentSpawnOptions, onAgentSpawn } from "../../src/worker/index.ts";
import { getAgentOwnership } from "../../src/vfs/index.ts";
import { createRuntime } from "../../src/server/daemon/runtime.ts";

/**
 * The agent-user split must be registered before the worker pool exists:
 * the pool spawns its worker processes in its constructor, and options
 * registered after that deadline are silently ignored (the createDaemon
 * decomposition, PR #78, produced workers running as the daemon user with
 * the daemon HOME). These tests pin the contract that createRuntime — not
 * the caller — performs the registration, and that a pool built by
 * createRuntime observes the configured split.
 */
describe("createRuntime agent-user split", () => {
  afterEach(() => {
    onAgentSpawn({});
  });

  it("registers the worker spawn drop and descriptor ownership from config", async () => {
    const runtime = await createRuntime({
      agentUid: 12345,
      agentGid: 54321,
      agentHome: "/tmp/yog-runtime-test-home",
      mountPoint: "/tmp/yog-runtime-test-mount-does-not-exist",
      stateRoot: "/tmp/yog-runtime-test-state",
    } as never);
    try {
      expect(agentSpawnOptions()).toEqual({
        uid: 12345,
        gid: 54321,
        home: "/tmp/yog-runtime-test-home",
      });
      expect(getAgentOwnership()).toEqual({ uid: 12345, gid: 54321 });
    } finally {
      await runtime.close().catch(() => {});
    }
  });

  it("falls back to the process ids when the config omits the split", async () => {
    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;
    const runtime = await createRuntime({
      mountPoint: "/tmp/yog-runtime-test-mount-does-not-exist",
      stateRoot: "/tmp/yog-runtime-test-state",
    } as never);
    try {
      expect(agentSpawnOptions()).toEqual({});
      expect(getAgentOwnership()).toEqual({ uid, gid });
    } finally {
      await runtime.close().catch(() => {});
    }
  });
});
