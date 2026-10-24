// Live FUSE mount test. This exercises the real kernel/`fuse-native` path —
// it mounts a virtual filesystem and performs actual syscalls through it, so
// it requires a FUSE device and mount privileges.
//
// The suite is tagged `mount` and is therefore excluded from the default
// `npm test` run (which filters tags out). Run it explicitly with:
//
//   npm run test:mount
//
// If `/dev/fuse` is missing, the suite fails loudly instead of skipping.
//
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import {
  appendFile,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { mountSys, unmountSys } from "../src/mount.ts";
import { ListDescriptor } from "../src/fs/list.ts";
import { DescriptorRegistry } from "../src/fs/index.ts";

const mnt = "./sys-test";
const file = `${mnt}/list`;

const devFusePresent = existsSync("/dev/fuse");

describe("live FUSE mount", { tags: ["mount"] }, () => {
  let list: ListDescriptor;
  let fuse: Awaited<ReturnType<typeof mountSys>> | undefined;

  beforeAll(async () => {
    if (!devFusePresent) {
      throw new Error(
        "mount-tagged tests require /dev/fuse, but the FUSE device is not present in this environment.",
      );
    }
    list = new ListDescriptor();
    const descriptors = new DescriptorRegistry([["/list", list]]);
    fuse = await mountSys(descriptors.buildOps(), mnt, {
      // set FUSE_DEBUG=1 to see raw FUSE opcodes on stderr
      debug: process.env["FUSE_DEBUG"] === "1",
    });
  });

  afterAll(async () => {
    await unmountSys(fuse);
    await rm(mnt, { recursive: true, force: true });
  });

  it("readdir shows only list", async () => {
    const entries = await readdir(mnt);
    expect(entries).toEqual(["list"]);
  });

  it("stat of list reports an empty regular file", async () => {
    const st = await stat(file);
    expect(st.isFile()).toBe(true);
    expect(st.size).toBe(0);
  });

  it("read of empty list returns empty string", async () => {
    expect(await readFile(file, "utf8")).toBe("");
  });

  it("append then read round-trips", async () => {
    await appendFile(file, "alpha\nbeta\n");
    expect(await readFile(file, "utf8")).toBe("alpha\nbeta\n");
  });

  it("second append accumulates", async () => {
    await appendFile(file, "gamma\n");
    expect(await readFile(file, "utf8")).toBe("alpha\nbeta\ngamma\n");
  });

  it("store reflects appends", () => {
    expect(list.items).toEqual(["alpha", "beta", "gamma"]);
  });

  it("destructive rewrite replaces content", async () => {
    await writeFile(file, "solo\n");
    expect(await readFile(file, "utf8")).toBe("solo\n");
  });

  it("store reflects rewrite", () => {
    expect(list.items).toEqual(["solo"]);
  });

  it("delete fails and the list survives", async () => {
    let deleteErr: unknown = null;
    try {
      await rm(file);
    } catch (err) {
      deleteErr = err;
    }
    expect(deleteErr).not.toBeNull();
    expect(await readdir(mnt)).toContain("list");
  });

  it("cannot create a new file in the mount", async () => {
    let createErr: unknown = null;
    try {
      await writeFile(`${mnt}/nope`, "x");
    } catch (err) {
      createErr = err;
    }
    expect(createErr).not.toBeNull();
    expect(await readdir(mnt)).toEqual(["list"]);
  });

  it("big list size matches stat", async () => {
    const big = makeBigList();
    await writeFile(file, big);
    expect((await stat(file)).size).toBe(Buffer.byteLength(big));
  });

  it("multi-chunk read matches exactly", async () => {
    const big = makeBigList();
    expect(await readFile(file, "utf8")).toBe(big);
  });

  it("offset read returns the right slice", async () => {
    const big = makeBigList();
    const fh = await open(file, "r");
    try {
      const buf = Buffer.alloc(10);
      const { bytesRead } = await fh.read(buf, 0, 10, 100);
      expect(bytesRead).toBe(10);
      expect(buf.toString("utf8")).toBe(big.slice(100, 110));
    } finally {
      await fh.close();
    }
  });

  it("read crossing EOF returns the remainder", async () => {
    const big = makeBigList();
    const fh = await open(file, "r");
    try {
      const pbuf = Buffer.alloc(64);
      const { bytesRead } = await fh.read(pbuf, 0, 64, Buffer.byteLength(big) - 10);
      expect(bytesRead).toBe(10);
      expect(pbuf.subarray(0, bytesRead).toString("utf8")).toBe(big.slice(-10));
    } finally {
      await fh.close();
    }
  });

  it("read at and beyond EOF returns 0 bytes", async () => {
    const big = makeBigList();
    const size = Buffer.byteLength(big);
    const fh = await open(file, "r");
    try {
      const atEof = Buffer.alloc(8);
      expect((await fh.read(atEof, 0, 8, size)).bytesRead).toBe(0);
      const pastEof = Buffer.alloc(8);
      expect((await fh.read(pastEof, 0, 8, size + 500)).bytesRead).toBe(0);
    } finally {
      await fh.close();
    }
  });

  it("noReadStream range matches the slice", async () => {
    const big = makeBigList();
    const chunks: Buffer[] = [];
    const rs = createReadStream(file, { start: 10, end: 29 });
    await new Promise<void>((resolve, reject) => {
      rs.on("data", (c: Buffer) => chunks.push(c));
      rs.on("end", resolve);
      rs.on("error", reject);
    });
    expect(Buffer.concat(chunks).toString("utf8")).toBe(big.slice(10, 30));
  });

  it("reads do not mutate the store", () => {
    expect(list.items).toHaveLength(1000);
  });

  it("truncate + final full read round-trips", async () => {
    await writeFile(file, "alpha\n");
    expect(await readFile(file, "utf8")).toBe("alpha\n");
  });
});

/** 1000-line list used by the read battery. */
function makeBigList(): string {
  const lines: string[] = [];
  for (let i = 1; i <= 1000; i++) lines.push(`line-${String(i).padStart(4, "0")}`);
  return lines.join("\n") + "\n";
}
