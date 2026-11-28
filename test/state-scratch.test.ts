import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RUNS_DIR_NAME,
  SCRATCH_MAX_AGE_MS,
  harnessStateRoot,
  runScratchDir,
  sweepRunScratchDirs,
} from "../src/state/index.ts";

const dirs: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "yog-scratch-"));
  dirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("runScratchDir", () => {
  it("derives <root>/harness/<sid>/runs/<uuid>, unique per call", async () => {
    const root = await tempRoot();
    const a = runScratchDir("sess-1", root);
    const b = runScratchDir("sess-1", root);
    const prefix = join(harnessStateRoot(root), "sess-1", RUNS_DIR_NAME) + "/";
    expect(a.startsWith(prefix)).toBe(true);
    expect(a).not.toBe(b);
    // The leaf is a uuid-shaped segment (no separators, nonempty).
    const leaf = a.slice(a.lastIndexOf("/") + 1);
    expect(leaf).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects unsafe session ids like the harness state dir does", () => {
    for (const bad of ["", ".", "..", "../evil", "a/b"]) {
      expect(() => runScratchDir(bad, "/srv/yog")).toThrow(/invalid session id/);
    }
  });
});

describe("sweepRunScratchDirs", () => {
  it("maxAgeMs 0 wipes every run dir unconditionally (startup sweep)", async () => {
    const root = await tempRoot();
    const runs = join(harnessStateRoot(root), "sess-wipe", RUNS_DIR_NAME);
    await mkdir(join(runs, "fresh"), { recursive: true });
    await writeFile(join(runs, "fresh", "env"), "export X=1\n");
    const pruned = await sweepRunScratchDirs("sess-wipe", root, { maxAgeMs: 0 });
    expect(pruned).toEqual(["fresh"]);
  });

  it("default (24h) prunes only dirs untouched past the cutoff", async () => {
    const root = await tempRoot();
    const runs = join(harnessStateRoot(root), "sess-age", RUNS_DIR_NAME);
    await mkdir(join(runs, "stale"), { recursive: true });
    await mkdir(join(runs, "live"), { recursive: true });
    const staleAt = new Date(Date.now() - SCRATCH_MAX_AGE_MS - 60_000);
    await writeFile(join(runs, "stale", "env"), "old\n");
    await utimes(join(runs, "stale"), staleAt, staleAt);
    await utimes(join(runs, "stale", "env"), staleAt, staleAt);
    await writeFile(join(runs, "live", "env"), "new\n"); // fresh mtime
    const pruned = await sweepRunScratchDirs("sess-age", root);
    expect(pruned).toEqual(["stale"]);
    await expect(sweepRunScratchDirs("sess-age", root)).resolves.toEqual([]);
  });

  it("a fresh file mtime inside an old dir keeps the record alive", async () => {
    const root = await tempRoot();
    const runs = join(harnessStateRoot(root), "sess-hot", RUNS_DIR_NAME);
    const dir = join(runs, "in-flight");
    await mkdir(dir, { recursive: true });
    const oldAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await utimes(dir, oldAt, oldAt);
    // The wrapper rewrites cwd/env per call: the newest file wins, so a
    // live call's dir is never a reaper candidate.
    await writeFile(join(dir, "cwd"), "/tmp\n");
    const pruned = await sweepRunScratchDirs("sess-hot", root, { now: Date.now() });
    expect(pruned).toEqual([]);
  });

  it("treats a missing runs root (and stray non-dir entries) as nothing to prune", async () => {
    const root = await tempRoot();
    await expect(sweepRunScratchDirs("ghost", root)).resolves.toEqual([]);
    const runs = join(harnessStateRoot(root), "stray", RUNS_DIR_NAME);
    await mkdir(runs, { recursive: true });
    await writeFile(join(runs, "not-a-dir"), "keep");
    await expect(sweepRunScratchDirs("stray", root)).resolves.toEqual([]);
    await expect(rm(join(runs, "not-a-dir"), { force: true })).resolves.toBeUndefined();
  });

  it("fails loudly on an unsafe session id (same guard as the harness dir)", async () => {
    await expect(sweepRunScratchDirs("a/b", "/srv/yog")).rejects.toThrow(/invalid session id/);
  });
});
