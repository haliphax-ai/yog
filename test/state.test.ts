import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentFSState, newSessionId } from "../src/state/index.ts";

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
      parameters: { script: "echo hi" },
      result: { stdout: "hi\n", exitCode: 0 },
      startedAt: 1_700_000_000_000,
      completedAt: 1_700_000_000_250,
      durationMs: 250,
      sessionId,
    });
    await state.recordToolCall({
      name: "bash",
      parameters: { script: "exit 1" },
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
    expect(JSON.parse(String(first.parameters))).toEqual({ script: "echo hi" });
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
      parameters: { script: "echo snap" },
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
