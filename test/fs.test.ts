import { describe, expect, it } from "vitest";
import { ListDescriptor } from "../src/fs/list.ts";
import {
  type DescriptorFile,
  DescriptorFlags,
  DescriptorFolder,
  DescriptorRegistry,
  DIR_MODE,
  EACCES,
  EISDIR,
  ENOENT,
  EPERM,
  FILE_MODE,
} from "../src/fs/index.ts";

/** A file descriptor with controllable flags and simple string content. */
function fileDescriptor(flags: DescriptorFlags, content = ""): DescriptorFile {
  return {
    kind: "file",
    mode: FILE_MODE,
    flags,
    size: content.length,
    render: () => content,
    commit: () => {},
    reset: () => {},
  };
}

describe("DescriptorFolder", () => {
  it("starts empty", () => {
    const folder = new DescriptorFolder();
    expect(folder.children().size).toBe(0);
    expect(folder.has("x")).toBe(false);
    expect(folder.get("x")).toBeUndefined();
    expect(folder.kind).toBe("folder");
  });

  it("add/has/get/remove round-trip children", () => {
    const folder = new DescriptorFolder();
    const child = new ListDescriptor();
    folder.add("list", child);
    expect(folder.has("list")).toBe(true);
    expect(folder.get("list")).toBe(child);
    expect(folder.children().get("list")).toBe(child);
    expect(folder.remove("list")).toBe(true);
    expect(folder.has("list")).toBe(false);
    expect(folder.remove("list")).toBe(false);
  });

  it("uses directory mode by default", () => {
    expect(new DescriptorFolder().mode).toBe(DIR_MODE);
  });
});

describe("DescriptorRegistry path hierarchy", () => {
  it("registers nested folders and resolves paths through them", async () => {
    const sessions = new DescriptorFolder();
    const s1 = new ListDescriptor();
    sessions.add("s1", s1);

    const registry = new DescriptorRegistry([["/sessions", sessions]]);

    expect(registry.has("/sessions")).toBe(true);
    expect(registry.has("/sessions/s1")).toBe(true);
    expect(registry.has("/sessions/s2")).toBe(false);
    expect(registry.has("/other")).toBe(false);

    const ops = registry.buildOps();

    // getattr on the folder
    const dirStat = await new Promise<{ mode?: number }>((resolve) => {
      ops.getattr!("/sessions", (err, st) => resolve(err ? {} : (st ?? {})));
    });
    expect(dirStat.mode).toBe(DIR_MODE);

    // getattr on the nested file
    const fileStat = await new Promise<{ mode?: number; size?: number }>((resolve) => {
      ops.getattr!("/sessions/s1", (err, st) => resolve(err ? {} : (st ?? {})));
    });
    expect(fileStat.mode).toBe(FILE_MODE);
    expect(fileStat.size).toBe(0);

    // readdir on the folder lists children
    const names = await new Promise<string[]>((resolve) => {
      ops.readdir!("/sessions", (err, n) => resolve(err ? [] : (n ?? [])));
    });
    expect(names).toEqual(["s1"]);
  });

  it("requires intermediate folders to exist", () => {
    const registry = new DescriptorRegistry();
    const child = new ListDescriptor();
    expect(() => registry.add("/a/b", child)).toThrow(/intermediate folder/);
  });

  it("rejects registering the root", () => {
    const registry = new DescriptorRegistry();
    expect(() => registry.add("/", new ListDescriptor())).toThrow(/root/);
  });
});

describe("DescriptorFlags gating", () => {
  it("denies reads on a non-Readable file", async () => {
    const registry = new DescriptorRegistry([
      ["/perm", fileDescriptor(DescriptorFlags.None, "secret")],
    ]);
    const ops = registry.buildOps();
    const err = await new Promise<number | null>((resolve) => {
      ops.open!("/perm", 0, (e, fd) => resolve(e === 0 && fd !== undefined ? 0 : e));
    });
    expect(err).toBe(EACCES);
  });

  it("denies writes on a non-Writable file", async () => {
    const registry = new DescriptorRegistry([
      ["/ro", fileDescriptor(DescriptorFlags.Readable, "hello")],
    ]);
    const ops = registry.buildOps();
    const err = await new Promise<number | null>((resolve) => {
      ops.open!("/ro", 1, (e, fd) => resolve(e === 0 && fd !== undefined ? 0 : e));
    });
    expect(err).toBe(EACCES);
  });

  it("allows reads on a Readable file", async () => {
    const registry = new DescriptorRegistry([
      ["/ro", fileDescriptor(DescriptorFlags.Readable, "hello")],
    ]);
    const ops = registry.buildOps();
    const fd = await new Promise<number>((resolve) => {
      ops.open!("/ro", 0, (e, f) => resolve(e === 0 ? (f ?? -1) : -1));
    });
    expect(fd).toBeGreaterThanOrEqual(1000);
  });

  it("allows writes on a Writable file", async () => {
    const registry = new DescriptorRegistry([
      ["/rw", fileDescriptor(DescriptorFlags.Readable | DescriptorFlags.Writable, "")],
    ]);
    const ops = registry.buildOps();
    const fd = await new Promise<number>((resolve) => {
      ops.open!("/rw", 1, (e, f) => resolve(e === 0 ? (f ?? -1) : -1));
    });
    expect(fd).toBeGreaterThanOrEqual(1000);
  });
});

describe("DescriptorFlags unlink behavior", () => {
  it("denies unlink for a descriptor without Removable", async () => {
    const registry = new DescriptorRegistry([
      ["/perm", fileDescriptor(DescriptorFlags.Readable, "x")],
    ]);
    const ops = registry.buildOps();
    const err = await new Promise<number | null>((resolve) => {
      ops.unlink!("/perm", (e) => resolve(e));
    });
    expect(err).toBe(EPERM);
    expect(registry.has("/perm")).toBe(true);
  });

  it("allows unlink for a Removable descriptor", async () => {
    const registry = new DescriptorRegistry([
      ["/mutable", fileDescriptor(DescriptorFlags.Removable, "x")],
    ]);
    const ops = registry.buildOps();
    const err = await new Promise<number | null>((resolve) => {
      ops.unlink!("/mutable", (e) => resolve(e));
    });
    expect(err).toBe(0);
    expect(registry.has("/mutable")).toBe(false);
  });

  it("removes a Removable child from a folder via unlink", async () => {
    const sessions = new DescriptorFolder();
    sessions.add("s1", fileDescriptor(DescriptorFlags.Removable, "x"));
    const registry = new DescriptorRegistry([["/sessions", sessions]]);
    const ops = registry.buildOps();
    const err = await new Promise<number | null>((resolve) => {
      ops.unlink!("/sessions/s1", (e) => resolve(e));
    });
    expect(err).toBe(0);
    expect(registry.has("/sessions/s1")).toBe(false);
    expect(registry.has("/sessions")).toBe(true);
  });

  it("returns ENOENT for unknown unlink targets", async () => {
    const registry = new DescriptorRegistry();
    const ops = registry.buildOps();
    const err = await new Promise<number | null>((resolve) => {
      ops.unlink!("/nope", (e) => resolve(e));
    });
    expect(err).toBe(ENOENT);
  });
});

describe("rename-as-replace to list", () => {
  it("renames a file onto list and replaces its content", async () => {
    const list = new ListDescriptor();
    const registry = new DescriptorRegistry([["/list", list]]);
    const ops = registry.buildOps();

    // seed the list
    list.commit("replace", "old\n");

    // create a scratch file with fresh content
    const scratch = fileDescriptor(DescriptorFlags.Readable, "fresh\n");
    registry.add("/scratch", scratch);

    const err = await new Promise<number | null>((resolve) => {
      ops.rename!("/scratch", "/list", (e) => resolve(e));
    });
    expect(err).toBe(0);
    expect(list.items).toEqual(["fresh"]);
    expect(registry.has("/scratch")).toBe(false);
  });

  it("denies renaming the list node itself", async () => {
    const list = new ListDescriptor();
    const registry = new DescriptorRegistry([["/list", list]]);
    const ops = registry.buildOps();

    const err = await new Promise<number | null>((resolve) => {
      ops.rename!("/list", "/away", (e) => resolve(e));
    });
    expect(err).toBe(EPERM);
    expect(registry.has("/list")).toBe(true);
  });

  it("denies renaming onto a non-list descriptor", async () => {
    const registry = new DescriptorRegistry([
      ["/list", new ListDescriptor()],
      ["/scratch", fileDescriptor(DescriptorFlags.Readable, "x")],
      ["/other", new ListDescriptor()],
    ]);
    const ops = registry.buildOps();

    const err = await new Promise<number | null>((resolve) => {
      ops.rename!("/scratch", "/other", (e) => resolve(e));
    });
    expect(err).toBe(EPERM);
  });

  it("returns ENOENT when the source is missing", async () => {
    const registry = new DescriptorRegistry([["/list", new ListDescriptor()]]);
    const ops = registry.buildOps();

    const err = await new Promise<number | null>((resolve) => {
      ops.rename!("/missing", "/list", (e) => resolve(e));
    });
    expect(err).toBe(ENOENT);
  });

  it("denies renaming a folder onto list", async () => {
    const registry = new DescriptorRegistry([
      ["/list", new ListDescriptor()],
      ["/dir", new DescriptorFolder()],
    ]);
    const ops = registry.buildOps();

    const err = await new Promise<number | null>((resolve) => {
      ops.rename!("/dir", "/list", (e) => resolve(e));
    });
    expect(err).toBe(EISDIR);
  });

  it("denies renaming a non-Readable source onto list", async () => {
    const registry = new DescriptorRegistry([
      ["/list", new ListDescriptor()],
      ["/secret", fileDescriptor(DescriptorFlags.None, "hidden")],
    ]);
    const ops = registry.buildOps();

    const err = await new Promise<number | null>((resolve) => {
      ops.rename!("/secret", "/list", (e) => resolve(e));
    });
    expect(err).toBe(EACCES);
  });
});