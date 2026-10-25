import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendFile,
  chmod,
  copyFile,
  exists,
  mkdir,
  readFile,
  readdir,
  rename,
  rm as hostRm,
  spawn,
  stat,
  writeFile,
} from "../src/host.ts";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "yog-host-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("host proxy", () => {
  it("write/read round-trips", async () => {
    const p = join(dir, "a.txt");
    await writeFile(p, "hello");
    expect(await readFile(p)).toBe("hello");
  });

  it("appendFile accumulates", async () => {
    const p = join(dir, "b.txt");
    await writeFile(p, "line1\n");
    await appendFile(p, "line2\n");
    expect(await readFile(p)).toBe("line1\nline2\n");
  });

  it("exists/stat reflect the filesystem", async () => {
    const p = join(dir, "c.txt");
    expect(await exists(p)).toBe(false);
    await writeFile(p, "x");
    expect(await exists(p)).toBe(true);
    const s = await stat(p);
    expect(s.isFile()).toBe(true);
    expect(s.size).toBe(1);
  });

  it("mkdir + readdir", async () => {
    const sub = join(dir, "nested/deeper");
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, "f.txt"), "v");
    expect(await readdir(sub)).toEqual(["f.txt"]);
    expect((await readdir(dir)).sort()).toContain("nested");
  });

  it("rename moves a file", async () => {
    const src = join(dir, "r1.txt");
    const dst = join(dir, "r2.txt");
    await writeFile(src, "moved");
    await rename(src, dst);
    expect(await exists(src)).toBe(false);
    expect(await readFile(dst)).toBe("moved");
  });

  it("copyFile copies content", async () => {
    const src = join(dir, "cp1.txt");
    const dst = join(dir, "cp2.txt");
    await writeFile(src, "copy");
    await copyFile(src, dst);
    expect(await readFile(dst)).toBe("copy");
  });

  it("rm removes files and trees", async () => {
    const f = join(dir, "d.txt");
    await writeFile(f, "x");
    await hostRm(f);
    expect(await exists(f)).toBe(false);

    const tree = join(dir, "tree");
    await mkdir(tree, { recursive: true });
    await writeFile(join(tree, "x"), "x");
    await hostRm(tree, { recursive: true, force: true });
    expect(await exists(tree)).toBe(false);
  });

  it("chmod updates mode bits", async () => {
    const p = join(dir, "e.txt");
    await writeFile(p, "x");
    await chmod(p, 0o600);
    const s = await stat(p);
    expect(s.mode & 0o777).toBe(0o600);
  });

  it("spawn runs a subprocess and captures stdout", async () => {
    const child = spawn(process.execPath, ["-e", "process.stdout.write('hi-from-sub')"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const { code, stdout } = await collect(child);
    expect(code).toBe(0);
    expect(stdout).toBe("hi-from-sub");
  });

  it("spawn surfaces a non-zero exit code", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(3)"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const { code } = await collect(child);
    expect(code).toBe(3);
  });
});

/** Run a child to completion, returning its exit code and captured stdout. */
function collect(child: ReturnType<typeof spawn>): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(chunks).toString("utf8") }));
  });
}
