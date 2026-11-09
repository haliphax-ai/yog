import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentFSState,
  HARNESS_STATE_RETENTION_DAYS,
  harnessStateDir,
  harnessStateRoot,
  newSessionId,
  pruneStaleHarnessState,
  stateDbPath,
} from "../src/state/index.ts";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "yog-state-"));
  dirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("session ids", () => {
  it("produces 22-char base62 tokens", () => {
    for (let i = 0; i < 100; i++) {
      expect(newSessionId()).toMatch(/^[0-9A-Za-z]{22}$/);
    }
  });

  it("are unique across many draws", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newSessionId()));
    expect(ids.size).toBe(500);
  });
});

describe("AgentFSState", () => {
  it("creates a db file and stamps the session_id extension column", async () => {
    const dir = await tempDir();
    const dbPath = join(dir, "state.db");
    const state = await AgentFSState.open({ path: dbPath });

    const rows = (await state
      .getDatabase()
      .prepare("SELECT name FROM pragma_table_info('tool_calls') WHERE name = 'session_id'")
      .all()) as unknown[];
    expect(rows).toHaveLength(1);

    await state.close();
  });

  it("records tool calls with the session id", async () => {
    const dir = await tempDir();
    const state = await AgentFSState.open({ path: join(dir, "s.db") });
    const sessionId = newSessionId();

    await state.recordToolCall({
      name: "bash",
      parameters: { command: "echo hi" },
      result: { stdout: "hi\n", exitCode: 0 },
      startedAt: 1_700_000_000_000,
      completedAt: 1_700_000_000_250,
      durationMs: 250,
      sessionId,
    });
    await state.recordToolCall({
      name: "bash",
      parameters: { command: "exit 1" },
      error: "exit code 1",
      startedAt: 1_700_000_000_500,
      completedAt: 1_700_000_000_700,
      durationMs: 200,
      sessionId,
    });

    const rows = (await state
      .getDatabase()
      .prepare("SELECT * FROM tool_calls ORDER BY id")
      .all()) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);

    const first = rows[0]!;
    expect(first.name).toBe("bash");
    expect(JSON.parse(String(first.parameters))).toEqual({ command: "echo hi" });
    expect(JSON.parse(String(first.result))).toEqual({ stdout: "hi\n", exitCode: 0 });
    expect(first.error).toBeNull();
    expect(first.session_id).toBe(sessionId);
    expect(first.duration_ms).toBe(250);
    expect(first.started_at).toBe(1_700_000_000);
    expect(first.completed_at).toBe(1_700_000_000);

    const second = rows[1]!;
    expect(second.error).toBe("exit code 1");
    expect(second.result).toBeNull();
    expect(second.session_id).toBe(sessionId);

    await state.close();
  });

  it("supports snapshot/restore via cp of the db file", async () => {
    const dir = await tempDir();
    const dbPath = join(dir, "agent.db");
    const snapshotPath = join(dir, "snapshot.db");

    const state = await AgentFSState.open({ path: dbPath });
    await state.recordToolCall({
      name: "bash",
      parameters: { command: "echo snap" },
      result: { stdout: "snap\n", exitCode: 0 },
      startedAt: 1_700_000_000_000,
      completedAt: 1_700_000_000_100,
      durationMs: 100,
      sessionId: newSessionId(),
    });

    // Snapshot: checkpoint WAL into the main file, then copy the single
    // SQLite file (the AgentFS `cp agent.db snapshot.db` idiom).
    await state.snapshotTo(snapshotPath);
    await state.close();

    // Restore: reopen the copy — prior state is intact.
    const restored = await AgentFSState.open({ path: snapshotPath });
    const rows = (await restored.getDatabase().prepare("SELECT * FROM tool_calls").all()) as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("bash");
    await restored.close();
  });

  it("derives per-agent database paths from the agent id", async () => {
    expect(stateDbPath("alpha", "/srv/yog")).toBe("/srv/yog/agentfs/alpha.db");
    expect(stateDbPath("omega", "/srv/yog")).toBe("/srv/yog/agentfs/omega.db");
    expect(stateDbPath("alpha", "/srv/yog")).not.toBe(stateDbPath("omega", "/srv/yog"));
  });

  it("opens distinct databases per agent id under an injected root", async () => {
    const root = await tempDir();
    const a = await AgentFSState.open({ agentId: "alpha", root });
    const b = await AgentFSState.open({ agentId: "omega", root });
    expect(b.path).not.toBe(a.path);
    await a.recordToolCall({
      name: "bash",
      parameters: { command: "echo a" },
      result: { stdout: "a\n" },
      startedAt: 1_700_000_000_000,
      completedAt: 1_700_000_000_100,
      durationMs: 100,
      sessionId: newSessionId(),
    });
    const aRows = (await a
      .getDatabase()
      .prepare("SELECT id FROM tool_calls ORDER BY id")
      .all()) as unknown[];
    const bRows = (await b
      .getDatabase()
      .prepare("SELECT id FROM tool_calls ORDER BY id")
      .all()) as unknown[];
    expect(aRows).toHaveLength(1);
    expect(bRows).toHaveLength(0);
    await a.close();
    await b.close();
  });

  it("persists and reloads the shell snapshot across opens", async () => {
    const dir = await tempDir();
    const dbPath = join(dir, "home.db");

    const state = await AgentFSState.open({ path: dbPath });
    await state.saveShellSnapshot("abc", { cwd: "/tmp", env: "x", functions: "" });
    await state.close();

    const reopened = await AgentFSState.open({ path: dbPath });
    await expect(reopened.loadShellSnapshot("abc")).resolves.toEqual({
      cwd: "/tmp",
      env: "x",
      functions: "",
    });
    await expect(reopened.loadShellSnapshot("nope")).resolves.toBeUndefined();
    await reopened.close();
  });
});

describe("per-session harness state", () => {
  it("derives the harness dir under the state root, keyed by session", () => {
    expect(harnessStateRoot("/srv/yog")).toBe("/srv/yog/harness");
    expect(harnessStateRoot()).toBe("/var/lib/yog/harness");
    expect(harnessStateDir("sess-1", "/srv/yog")).toBe("/srv/yog/harness/sess-1");
    expect(harnessStateDir("daemon")).toBe("/var/lib/yog/harness/daemon");
    expect(harnessStateDir("a", "/srv/yog")).not.toBe(harnessStateDir("b", "/srv/yog"));
    expect(HARNESS_STATE_RETENTION_DAYS).toBe(7);
  });

  it("rejects session ids that would escape the harness root", () => {
    for (const bad of ["", ".", "..", "../evil", "a/b", "a\\b", "a\0b"]) {
      expect(() => harnessStateDir(bad, "/srv/yog")).toThrow(/invalid session id/);
    }
  });

  it("prunes only directories untouched for over 7 days", async () => {
    const root = await tempDir();
    const harnessRoot = harnessStateRoot(root);
    const oldDir = harnessStateDir("old-session", root);
    const freshDir = harnessStateDir("fresh-session", root);
    const activeDir = harnessStateDir("active-session", root);
    await mkdir(oldDir, { recursive: true });
    await mkdir(freshDir, { recursive: true });
    await mkdir(activeDir, { recursive: true });
    await writeFile(join(oldDir, "env"), "export OLD=1\n");
    await writeFile(join(freshDir, "env"), "export FRESH=1\n");
    await writeFile(join(activeDir, "env"), "export ACTIVE=1\n");
    // A stray file in the harness root is not a harness record.
    await writeFile(join(harnessRoot, "stray.txt"), "keep me");

    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(oldDir, eightDaysAgo, eightDaysAgo);
    await utimes(join(oldDir, "env"), eightDaysAgo, eightDaysAgo);
    // Fresh dir's dir mtime is old, but its env file was touched now:
    // the newest file wins, so it survives (wrapper rewrites env per call).
    await utimes(freshDir, eightDaysAgo, eightDaysAgo);

    const pruned = await pruneStaleHarnessState(root);
    expect(pruned).toEqual(["old-session"]);
    await expect(pruneStaleHarnessState(root)).resolves.toEqual([]);
  });

  it("treats a missing harness root as nothing to prune", async () => {
    const root = await tempDir();
    await expect(pruneStaleHarnessState(root)).resolves.toEqual([]);
  });

  it("prunes stale shell-snapshot mirrors but keeps fresh and non-shell rows", async () => {
    const dir = await tempDir();
    const state = await AgentFSState.open({ path: join(dir, "home.db") });
    await state.saveShellSnapshot("old", { cwd: "/tmp", env: "old", functions: "" });
    await state.saveShellSnapshot("fresh", { cwd: "/tmp", env: "fresh", functions: "" });
    // Backdate the old row past the 7-day cutoff (kv updated_at is
    // unixepoch seconds, refreshed on set).
    const oldSec = Math.floor(Date.now() / 1000) - 8 * 24 * 60 * 60;
    await state
      .getDatabase()
      .prepare("UPDATE kv_store SET updated_at = ? WHERE key = 'session:old:shell'")
      .run(oldSec);
    // A non-shell kv row must survive even when stale.
    await state
      .getDatabase()
      .prepare("INSERT INTO kv_store (key, value, updated_at) VALUES ('other', '\"x\"', ?)")
      .run(oldSec);

    await state.pruneStaleShellSnapshots();

    await expect(state.loadShellSnapshot("old")).resolves.toBeUndefined();
    await expect(state.loadShellSnapshot("fresh")).resolves.toEqual({
      cwd: "/tmp",
      env: "fresh",
      functions: "",
    });
    const other = (await state
      .getDatabase()
      .prepare("SELECT value FROM kv_store WHERE key = 'other'")
      .get()) as { value?: unknown } | undefined;
    expect(other).toBeDefined();
    await state.close();
  });
});
