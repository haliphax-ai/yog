import { describe, expect, it } from "vitest";
import { ListDescriptor } from "../src/vfs/descriptors/list.ts";
import {
  AGENT_GID,
  AGENT_UID,
  type DescriptorFile,
  DescriptorFlags,
  DescriptorFolder,
  DescriptorRegistry,
  DIR_MODE,
  EACCES,
  EEXIST,
  EINVAL,
  EISDIR,
  ENOENT,
  ENOTDIR,
  ENOTEMPTY,
  EPERM,
  FILE_MODE,
} from "../src/vfs/index.ts";

/** A file descriptor with controllable flags, simple string content, and optional hooks. */
function fileDescriptor(
  flags: DescriptorFlags,
  content = "",
  hooks: {
    onRename?: () => number | void;
    onRead?: () => number | void;
    onWrite?: (kind: "append" | "replace", text: string) => number | void;
    onTruncate?: () => number | void;
    onDelete?: () => number | void;
    onOverwrite?: (source: DescriptorFile) => number | void;
  } = {},
  owner: { uid?: number; gid?: number } = {},
): DescriptorFile {
  return {
    kind: "file",
    mode: FILE_MODE,
    flags,
    size: content.length,
    render: () => content,
    commit: () => {},
    reset: () => {},
    ...owner,
    ...hooks,
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
  it("denies reads on a non-CanRead file", async () => {
    const registry = new DescriptorRegistry([
      ["/perm", fileDescriptor(DescriptorFlags.None, "secret")],
    ]);
    const ops = registry.buildOps();
    const err = await new Promise<number | null>((resolve) => {
      ops.open!("/perm", 0, (e, fd) => resolve(e === 0 && fd !== undefined ? 0 : e));
    });
    expect(err).toBe(EACCES);
  });

  it("denies writes on a non-CanWrite file", async () => {
    const registry = new DescriptorRegistry([
      ["/ro", fileDescriptor(DescriptorFlags.CanRead, "hello")],
    ]);
    const ops = registry.buildOps();
    const err = await new Promise<number | null>((resolve) => {
      ops.open!("/ro", 1, (e, fd) => resolve(e === 0 && fd !== undefined ? 0 : e));
    });
    expect(err).toBe(EACCES);
  });

  it("allows reads on a CanRead file", async () => {
    const registry = new DescriptorRegistry([
      ["/ro", fileDescriptor(DescriptorFlags.CanRead, "hello")],
    ]);
    const ops = registry.buildOps();
    const fd = await new Promise<number>((resolve) => {
      ops.open!("/ro", 0, (e, f) => resolve(e === 0 ? (f ?? -1) : -1));
    });
    expect(fd).toBeGreaterThanOrEqual(1000);
  });

  it("allows writes on a CanWrite file", async () => {
    const registry = new DescriptorRegistry([
      ["/rw", fileDescriptor(DescriptorFlags.CanRead | DescriptorFlags.CanWrite, "")],
    ]);
    const ops = registry.buildOps();
    const fd = await new Promise<number>((resolve) => {
      ops.open!("/rw", 1, (e, f) => resolve(e === 0 ? (f ?? -1) : -1));
    });
    expect(fd).toBeGreaterThanOrEqual(1000);
  });
});

describe("DescriptorFlags unlink behavior", () => {
  it("denies unlink for a descriptor without CanRemove", async () => {
    const registry = new DescriptorRegistry([
      ["/perm", fileDescriptor(DescriptorFlags.CanRead, "x")],
    ]);
    const ops = registry.buildOps();
    const err = await new Promise<number | null>((resolve) => {
      ops.unlink!("/perm", (e) => resolve(e));
    });
    expect(err).toBe(EPERM);
    expect(registry.has("/perm")).toBe(true);
  });

  it("allows unlink for a CanRemove descriptor", async () => {
    const registry = new DescriptorRegistry([
      ["/mutable", fileDescriptor(DescriptorFlags.CanRemove, "x")],
    ]);
    const ops = registry.buildOps();
    const err = await new Promise<number | null>((resolve) => {
      ops.unlink!("/mutable", (e) => resolve(e));
    });
    expect(err).toBe(0);
    expect(registry.has("/mutable")).toBe(false);
  });

  it("removes a CanRemove child from a folder via unlink", async () => {
    const sessions = new DescriptorFolder();
    sessions.add("s1", fileDescriptor(DescriptorFlags.CanRemove, "x"));
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

describe("rename behavior (emergent from descriptors)", () => {
  it("renames a file onto list and replaces its content (list declares onOverwrite)", async () => {
    const list = new ListDescriptor();
    const registry = new DescriptorRegistry([["/list", list]]);
    const ops = registry.buildOps();

    // seed the list
    list.commit("replace", "old\n");

    // create a scratch file with fresh content
    const scratch = fileDescriptor(DescriptorFlags.CanRead, "fresh\n");
    registry.add("/scratch", scratch);

    const err = await new Promise<number | null>((resolve) => {
      ops.rename!("/scratch", "/list", (e) => resolve(e));
    });
    expect(err).toBe(0);
    expect(list.items).toEqual(["fresh"]);
    expect(registry.has("/scratch")).toBe(false);
  });

  it("allows overwrite via CanOverwrite when target has no onOverwrite", async () => {
    const target = fileDescriptor(
      DescriptorFlags.CanRead | DescriptorFlags.CanWrite | DescriptorFlags.CanOverwrite,
      "old",
    );
    const registry = new DescriptorRegistry([
      ["/scratch", fileDescriptor(DescriptorFlags.CanRead, "new")],
      ["/target", target],
    ]);
    const ops = registry.buildOps();

    const err = await new Promise<number | null>((resolve) => {
      ops.rename!("/scratch", "/target", (e) => resolve(e));
    });
    expect(err).toBe(0);
    expect(registry.has("/scratch")).toBe(false);
  });

  it("denies rename-overwrite onto a file without CanOverwrite and no onOverwrite", async () => {
    const registry = new DescriptorRegistry([
      ["/scratch", fileDescriptor(DescriptorFlags.CanRead, "x")],
      ["/target", fileDescriptor(DescriptorFlags.CanRead | DescriptorFlags.CanWrite, "y")],
    ]);
    const ops = registry.buildOps();

    const err = await new Promise<number | null>((resolve) => {
      ops.rename!("/scratch", "/target", (e) => resolve(e));
    });
    expect(err).toBe(EPERM);
  });

  it("uses onOverwrite when declared, overriding CanOverwrite", async () => {
    let called = false;
    const target = fileDescriptor(DescriptorFlags.CanRead | DescriptorFlags.CanWrite, "old", {
      onOverwrite: () => {
        called = true;
        return 0;
      },
    });
    const registry = new DescriptorRegistry([
      ["/scratch", fileDescriptor(DescriptorFlags.CanRead, "new")],
      ["/target", target],
    ]);
    const ops = registry.buildOps();

    const err = await new Promise<number | null>((resolve) => {
      ops.rename!("/scratch", "/target", (e) => resolve(e));
    });
    expect(err).toBe(0);
    expect(called).toBe(true);
    expect(registry.has("/scratch")).toBe(false);
  });

  it("denies renaming the list node itself (no CanRename)", async () => {
    const list = new ListDescriptor();
    const registry = new DescriptorRegistry([["/list", list]]);
    const ops = registry.buildOps();

    const err = await new Promise<number | null>((resolve) => {
      ops.rename!("/list", "/away", (e) => resolve(e));
    });
    expect(err).toBe(EPERM);
    expect(registry.has("/list")).toBe(true);
  });

  it("repositions a file with CanRename within the mount", async () => {
    const movable = fileDescriptor(DescriptorFlags.CanRead | DescriptorFlags.CanRename, "x");
    const registry = new DescriptorRegistry([["/a", movable]]);
    const ops = registry.buildOps();

    const err = await new Promise<number | null>((resolve) => {
      ops.rename!("/a", "/b", (e) => resolve(e));
    });
    expect(err).toBe(0);
    expect(registry.has("/a")).toBe(false);
    expect(registry.has("/b")).toBe(true);
  });

  it("denies repositioning a file without CanRename", async () => {
    const registry = new DescriptorRegistry([["/a", fileDescriptor(DescriptorFlags.CanRead, "x")]]);
    const ops = registry.buildOps();

    const err = await new Promise<number | null>((resolve) => {
      ops.rename!("/a", "/b", (e) => resolve(e));
    });
    expect(err).toBe(EPERM);
    expect(registry.has("/a")).toBe(true);
  });

  it("runs onRename housekeeping on the moved node", async () => {
    let renamed = false;
    const movable = fileDescriptor(DescriptorFlags.CanRead | DescriptorFlags.CanRename, "x", {
      onRename: () => {
        renamed = true;
        return 0;
      },
    });
    const registry = new DescriptorRegistry([["/a", movable]]);
    const ops = registry.buildOps();

    const err = await new Promise<number | null>((resolve) => {
      ops.rename!("/a", "/b", (e) => resolve(e));
    });
    expect(err).toBe(0);
    expect(renamed).toBe(true);
  });

  it("allows onRename to refuse a move", async () => {
    const movable = fileDescriptor(DescriptorFlags.CanRead | DescriptorFlags.CanRename, "x", {
      onRename: () => EPERM,
    });
    const registry = new DescriptorRegistry([["/a", movable]]);
    const ops = registry.buildOps();

    const err = await new Promise<number | null>((resolve) => {
      ops.rename!("/a", "/b", (e) => resolve(e));
    });
    expect(err).toBe(EPERM);
    expect(registry.has("/a")).toBe(true);
  });

  it("runs onChildRename on the destination folder", async () => {
    let notified = false;
    const destFolder = new DescriptorFolder({
      flags: DescriptorFlags.CanRead | DescriptorFlags.CanWrite,
    });
    destFolder.onChildRename = (_name, _child) => {
      notified = true;
      return 0;
    };
    const registry = new DescriptorRegistry([
      ["/a", fileDescriptor(DescriptorFlags.CanRead | DescriptorFlags.CanRename, "x")],
      ["/dest", destFolder],
    ]);
    const ops = registry.buildOps();

    const err = await new Promise<number | null>((resolve) => {
      ops.rename!("/a", "/dest", (e) => resolve(e));
    });
    expect(err).toBe(0);
    expect(notified).toBe(true);
    expect(registry.has("/dest/a")).toBe(true);
  });
});

describe("node lifecycle hooks", () => {
  it("fires onRead when content is read", async () => {
    let reads = 0;
    const file = fileDescriptor(DescriptorFlags.CanRead, "hello", {
      onRead: () => {
        reads++;
        return 0;
      },
    });
    const registry = new DescriptorRegistry([["/f", file]]);
    const ops = registry.buildOps();
    const fd = await new Promise<number>((resolve) => {
      ops.open!("/f", 0, (e, f) => resolve(e === 0 ? (f ?? -1) : -1));
    });
    const buf = Buffer.alloc(16);
    await new Promise<void>((resolve) => {
      ops.read!("/f", fd, buf, 5, 0, () => resolve());
    });
    expect(reads).toBe(1);
  });

  it("fires onWrite and commits when allowed", async () => {
    let writes: string[] = [];
    const file = fileDescriptor(DescriptorFlags.CanRead | DescriptorFlags.CanWrite, "", {
      onWrite: (_kind, text) => {
        writes.push(text);
        return 0;
      },
    });
    const registry = new DescriptorRegistry([["/f", file]]);
    const ops = registry.buildOps();
    const fd = await new Promise<number>((resolve) => {
      ops.open!("/f", 1, (e, f) => resolve(e === 0 ? (f ?? -1) : -1));
    });
    const buf = Buffer.from("abc");
    await new Promise<void>((resolve) => {
      ops.write!("/f", fd, buf, 3, 0, () => resolve());
    });
    await new Promise<void>((resolve) => {
      ops.release!("/f", fd, () => resolve());
    });
    expect(writes).toEqual(["abc"]);
  });

  it("onWrite can veto by returning a negative errno", async () => {
    let committed = false;
    const file = fileDescriptor(DescriptorFlags.CanRead | DescriptorFlags.CanWrite, "", {
      onWrite: () => EACCES,
    });
    const originalCommit = file.commit;
    file.commit = () => {
      committed = true;
    };
    const registry = new DescriptorRegistry([["/f", file]]);
    const ops = registry.buildOps();
    const fd = await new Promise<number>((resolve) => {
      ops.open!("/f", 1, (e, f) => resolve(e === 0 ? (f ?? -1) : -1));
    });
    const buf = Buffer.from("abc");
    await new Promise<void>((resolve) => {
      ops.write!("/f", fd, buf, 3, 0, () => resolve());
    });
    await new Promise<void>((resolve) => {
      ops.release!("/f", fd, () => resolve());
    });
    expect(committed).toBe(false);
    void originalCommit;
  });

  it("fires onTruncate before resetting", async () => {
    let truncated = 0;
    const file = fileDescriptor(DescriptorFlags.CanRead | DescriptorFlags.CanWrite, "abc", {
      onTruncate: () => {
        truncated++;
        return 0;
      },
    });
    const registry = new DescriptorRegistry([["/f", file]]);
    const ops = registry.buildOps();
    await new Promise<void>((resolve) => {
      ops.truncate!("/f", 0, () => resolve());
    });
    expect(truncated).toBe(1);
  });

  it("onDelete can veto unlink", async () => {
    let deleted = false;
    const file = fileDescriptor(DescriptorFlags.CanRemove, "x", {
      onDelete: () => {
        deleted = true;
        return EPERM;
      },
    });
    const registry = new DescriptorRegistry([["/f", file]]);
    const ops = registry.buildOps();
    const err = await new Promise<number | null>((resolve) => {
      ops.unlink!("/f", (e) => resolve(e));
    });
    expect(deleted).toBe(true);
    expect(err).toBe(EPERM);
    expect(registry.has("/f")).toBe(true);
  });
});

describe("shared child hooks", () => {
  it("calls onChildCreate when a child is registered into a folder", () => {
    const created: string[] = [];
    const folder = new DescriptorFolder({
      flags: DescriptorFlags.CanRead | DescriptorFlags.CanWrite,
    });
    folder.onChildCreate = (name) => {
      created.push(name);
      return 0;
    };
    const registry = new DescriptorRegistry([["/dir", folder]]);
    registry.add("/dir/s1", fileDescriptor(DescriptorFlags.CanRead, "x"));
    expect(created).toEqual(["s1"]);
  });

  it("calls onChildDelete before unlinking a child and can refuse", async () => {
    let notified = false;
    const folder = new DescriptorFolder({
      flags: DescriptorFlags.CanRead | DescriptorFlags.CanWrite,
    });
    folder.onChildDelete = (_name, _child) => {
      notified = true;
      return EPERM;
    };
    const child = fileDescriptor(DescriptorFlags.CanRemove, "x");
    folder.add("s1", child);
    const registry = new DescriptorRegistry([["/dir", folder]]);
    const ops = registry.buildOps();

    const err = await new Promise<number | null>((resolve) => {
      ops.unlink!("/dir/s1", (e) => resolve(e));
    });
    expect(notified).toBe(true);
    expect(err).toBe(EPERM);
    expect(registry.has("/dir/s1")).toBe(true);
  });

  it("denies repositioning into a missing parent", async () => {
    const movable = fileDescriptor(DescriptorFlags.CanRead | DescriptorFlags.CanRename, "x");
    const registry = new DescriptorRegistry([["/a", movable]]);
    const ops = registry.buildOps();

    const err = await new Promise<number | null>((resolve) => {
      ops.rename!("/a", "/nope/b", (e) => resolve(e));
    });
    expect(err).toBe(ENOENT);
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

  it("denies renaming a non-CanRead source onto list", async () => {
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

describe("mkdir", () => {
  it("creates a folder child under a writable parent", async () => {
    const registry = new DescriptorRegistry([
      [
        "/sessions",
        new DescriptorFolder({ flags: DescriptorFlags.CanRead | DescriptorFlags.CanWrite }),
      ],
    ]);
    const ops = registry.buildOps();
    const err = await new Promise<number | null>((resolve) => {
      ops.mkdir!("/sessions/s1", 0o755, (e) => resolve(e));
    });
    expect(err).toBe(0);
    expect(registry.has("/sessions/s1")).toBe(true);
    const st = await new Promise<{ mode?: number }>((resolve) => {
      ops.getattr!("/sessions/s1", (e, s) => resolve(e ? {} : (s ?? {})));
    });
    expect(st.mode).toBe(0o40755);
  });

  it("returns EEXIST when the child already exists", async () => {
    const registry = new DescriptorRegistry([
      ["/dir", new DescriptorFolder({ flags: DescriptorFlags.CanRead | DescriptorFlags.CanWrite })],
    ]);
    registry.add("/dir/x", fileDescriptor(DescriptorFlags.CanRead, ""));
    const ops = registry.buildOps();
    const err = await new Promise<number | null>((resolve) => {
      ops.mkdir!("/dir/x", 0o755, (e) => resolve(e));
    });
    expect(err).toBe(EEXIST);
  });

  it("denies mkdir under a non-writable parent", async () => {
    const registry = new DescriptorRegistry([
      ["/dir", new DescriptorFolder({ flags: DescriptorFlags.CanRead })],
    ]);
    const ops = registry.buildOps();
    const err = await new Promise<number | null>((resolve) => {
      ops.mkdir!("/dir/x", 0o755, (e) => resolve(e));
    });
    expect(err).toBe(EACCES);
  });

  it("fires onChildCreate on the parent", async () => {
    const created: string[] = [];
    const folder = new DescriptorFolder({
      flags: DescriptorFlags.CanRead | DescriptorFlags.CanWrite,
    });
    folder.onChildCreate = (name) => {
      created.push(name);
      return 0;
    };
    const registry = new DescriptorRegistry([["/dir", folder]]);
    const ops = registry.buildOps();
    await new Promise<void>((resolve) => {
      ops.mkdir!("/dir/new", 0o755, () => resolve());
    });
    expect(created).toEqual(["new"]);
  });
});

describe("rmdir", () => {
  it("removes an empty folder child", async () => {
    const registry = new DescriptorRegistry([
      ["/dir", new DescriptorFolder({ flags: DescriptorFlags.CanRead | DescriptorFlags.CanWrite })],
    ]);
    registry.add(
      "/dir/empty",
      new DescriptorFolder({ flags: DescriptorFlags.CanRead | DescriptorFlags.CanRemove }),
    );
    const ops = registry.buildOps();
    const err = await new Promise<number | null>((resolve) => {
      ops.rmdir!("/dir/empty", (e) => resolve(e));
    });
    expect(err).toBe(0);
    expect(registry.has("/dir/empty")).toBe(false);
  });

  it("refuses to remove a non-empty folder", async () => {
    const folder = new DescriptorFolder({
      flags: DescriptorFlags.CanRead | DescriptorFlags.CanWrite | DescriptorFlags.CanRemove,
    });
    folder.add("x", fileDescriptor(DescriptorFlags.CanRead, ""));
    const registry = new DescriptorRegistry([["/dir", folder]]);
    const ops = registry.buildOps();
    const err = await new Promise<number | null>((resolve) => {
      ops.rmdir!("/dir", (e) => resolve(e));
    });
    expect(err).toBe(ENOTEMPTY);
  });

  it("returns ENOTDIR for a file", async () => {
    const registry = new DescriptorRegistry([
      ["/f", fileDescriptor(DescriptorFlags.CanRemove, "")],
    ]);
    const ops = registry.buildOps();
    const err = await new Promise<number | null>((resolve) => {
      ops.rmdir!("/f", (e) => resolve(e));
    });
    expect(err).toBe(ENOTDIR);
  });

  it("denies rmdir without CanRemove on the folder", async () => {
    const registry = new DescriptorRegistry([
      ["/dir", new DescriptorFolder({ flags: DescriptorFlags.CanRead | DescriptorFlags.CanWrite })],
    ]);
    const ops = registry.buildOps();
    const err = await new Promise<number | null>((resolve) => {
      ops.rmdir!("/dir", (e) => resolve(e));
    });
    expect(err).toBe(EPERM);
  });

  it("fires onDelete on the folder and onChildDelete on its parent", async () => {
    let deleted = false;
    let notified = false;
    const child = new DescriptorFolder({
      flags: DescriptorFlags.CanRead | DescriptorFlags.CanRemove,
    });
    child.onDelete = () => {
      deleted = true;
      return 0;
    };
    const parent = new DescriptorFolder({
      flags: DescriptorFlags.CanRead | DescriptorFlags.CanWrite,
    });
    parent.onChildDelete = () => {
      notified = true;
      return 0;
    };
    parent.add("sub", child);
    const registry = new DescriptorRegistry([["/dir", parent]]);
    const ops = registry.buildOps();
    await new Promise<void>((resolve) => {
      ops.rmdir!("/dir/sub", () => resolve());
    });
    expect(deleted).toBe(true);
    expect(notified).toBe(true);
  });
});

describe("unlink vs folders", () => {
  it("returns EISDIR when unlinking a folder", async () => {
    const registry = new DescriptorRegistry([
      [
        "/dir",
        new DescriptorFolder({ flags: DescriptorFlags.CanRead | DescriptorFlags.CanRemove }),
      ],
    ]);
    const ops = registry.buildOps();
    const err = await new Promise<number | null>((resolve) => {
      ops.unlink!("/dir", (e) => resolve(e));
    });
    expect(err).toBe(EISDIR);
    expect(registry.has("/dir")).toBe(true);
  });
});

describe("folder rename guards", () => {
  it("notifies the source folder via onChildRename when a child leaves", async () => {
    let left = false;
    const srcFolder = new DescriptorFolder({
      flags: DescriptorFlags.CanRead | DescriptorFlags.CanWrite,
    });
    srcFolder.onChildRename = () => {
      left = true;
      return 0;
    };
    const movable = fileDescriptor(DescriptorFlags.CanRead | DescriptorFlags.CanRename, "x");
    srcFolder.add("m", movable);
    const registry = new DescriptorRegistry([
      ["/src", srcFolder],
      [
        "/dest",
        new DescriptorFolder({ flags: DescriptorFlags.CanRead | DescriptorFlags.CanWrite }),
      ],
    ]);
    const ops = registry.buildOps();
    const err = await new Promise<number | null>((resolve) => {
      ops.rename!("/src/m", "/dest", (e) => resolve(e));
    });
    expect(err).toBe(0);
    expect(left).toBe(true);
    expect(registry.has("/dest/m")).toBe(true);
    expect(registry.has("/src/m")).toBe(false);
  });

  it("denies nesting a folder inside itself", async () => {
    const outer = new DescriptorFolder({
      flags: DescriptorFlags.CanRead | DescriptorFlags.CanWrite | DescriptorFlags.CanRename,
    });
    const inner = new DescriptorFolder({
      flags: DescriptorFlags.CanRead | DescriptorFlags.CanWrite,
    });
    outer.add("inner", inner);
    const registry = new DescriptorRegistry([["/outer", outer]]);
    const ops = registry.buildOps();
    const err = await new Promise<number | null>((resolve) => {
      ops.rename!("/outer", "/outer/inner", (e) => resolve(e));
    });
    expect(err).toBe(EINVAL);
  });

  it("replaces an empty destination folder that declares CanOverwrite", async () => {
    const source = new DescriptorFolder({
      flags: DescriptorFlags.CanRead | DescriptorFlags.CanWrite | DescriptorFlags.CanRename,
    });
    source.add("item", fileDescriptor(DescriptorFlags.CanRead, "v"));
    const target = new DescriptorFolder({
      flags: DescriptorFlags.CanRead | DescriptorFlags.CanWrite | DescriptorFlags.CanOverwrite,
    });
    const registry = new DescriptorRegistry([
      ["/src", source],
      ["/dst", target],
    ]);
    const ops = registry.buildOps();
    const err = await new Promise<number | null>((resolve) => {
      ops.rename!("/src", "/dst", (e) => resolve(e));
    });
    expect(err).toBe(0);
    expect(registry.has("/src")).toBe(false);
    expect(registry.has("/dst/item")).toBe(true);
    expect(registry.has("/dst")).toBe(true);
  });

  it("refuses to replace a non-empty destination folder", async () => {
    const source = new DescriptorFolder({
      flags: DescriptorFlags.CanRead | DescriptorFlags.CanWrite | DescriptorFlags.CanRename,
    });
    const target = new DescriptorFolder({
      flags: DescriptorFlags.CanRead | DescriptorFlags.CanWrite | DescriptorFlags.CanOverwrite,
    });
    target.add("keep", fileDescriptor(DescriptorFlags.CanRead, "v"));
    const registry = new DescriptorRegistry([
      ["/src", source],
      ["/dst", target],
    ]);
    const ops = registry.buildOps();
    const err = await new Promise<number | null>((resolve) => {
      ops.rename!("/src", "/dst", (e) => resolve(e));
    });
    expect(err).toBe(ENOTEMPTY);
  });

  it("runs onOverwrite on a folder target when declared", async () => {
    let called = false;
    const source = new DescriptorFolder({
      flags: DescriptorFlags.CanRead | DescriptorFlags.CanWrite | DescriptorFlags.CanRename,
    });
    const target = new DescriptorFolder({
      flags: DescriptorFlags.CanRead | DescriptorFlags.CanWrite,
    });
    target.onOverwrite = () => {
      called = true;
      return 0;
    };
    const registry = new DescriptorRegistry([
      ["/src", source],
      ["/dst", target],
    ]);
    const ops = registry.buildOps();
    const err = await new Promise<number | null>((resolve) => {
      ops.rename!("/src", "/dst", (e) => resolve(e));
    });
    expect(err).toBe(0);
    expect(called).toBe(true);
    expect(registry.has("/src")).toBe(false);
  });
});

describe("folder onRead hook", () => {
  it("fires onRead on readdir", async () => {
    let reads = 0;
    const folder = new DescriptorFolder({ flags: DescriptorFlags.CanRead });
    folder.onRead = () => {
      reads++;
      return 0;
    };
    const registry = new DescriptorRegistry([["/dir", folder]]);
    const ops = registry.buildOps();
    await new Promise<void>((resolve) => {
      ops.readdir!("/dir", () => resolve());
    });
    expect(reads).toBe(1);
  });

  it("onRead can refuse readdir", async () => {
    const folder = new DescriptorFolder({ flags: DescriptorFlags.CanRead });
    folder.onRead = () => EACCES;
    const registry = new DescriptorRegistry([["/dir", folder]]);
    const ops = registry.buildOps();
    const err = await new Promise<number | null>((resolve) => {
      ops.readdir!("/dir", (e) => resolve(e));
    });
    expect(err).toBe(EACCES);
  });
});

describe("flush commits buffered writes before release", () => {
  it("commits append writes on flush and release does not double-commit", async () => {
    const list = new ListDescriptor();
    const registry = new DescriptorRegistry([["/list", list]]);
    const ops = registry.buildOps();

    // O_APPEND (0x400) | O_WRONLY (1)
    const fd = await new Promise<number>((resolve) => {
      ops.open!("/list", 0x401, (e, f) => resolve(e === 0 ? (f ?? -1) : -1));
    });
    const buf = Buffer.from("gamma\n");
    await new Promise<void>((resolve) => {
      ops.write!("/list", fd, buf, 6, 0, () => resolve());
    });

    await new Promise<void>((resolve) => {
      ops.flush!("/list", fd, () => resolve());
    });
    expect(list.items).toEqual(["gamma"]);

    await new Promise<void>((resolve) => {
      ops.release!("/list", fd, () => resolve());
    });
    expect(list.items).toEqual(["gamma"]);
  });

  it("flush commits a destructive replace while the handle is open", async () => {
    const list = new ListDescriptor();
    list.commit("replace", "old\n");
    const registry = new DescriptorRegistry([["/list", list]]);
    const ops = registry.buildOps();

    const fd = await new Promise<number>((resolve) => {
      ops.open!("/list", 1, (e, f) => resolve(e === 0 ? (f ?? -1) : -1));
    });
    const buf = Buffer.from("new\n");
    await new Promise<void>((resolve) => {
      ops.write!("/list", fd, buf, 4, 0, () => resolve());
    });

    await new Promise<void>((resolve) => {
      ops.flush!("/list", fd, () => resolve());
    });
    expect(list.items).toEqual(["new"]);
  });

  it("an early empty flush is a no-op; later writes still commit", async () => {
    const list = new ListDescriptor();
    const registry = new DescriptorRegistry([["/list", list]]);
    const ops = registry.buildOps();

    // O_APPEND (0x400) | O_WRONLY (1)
    const fd = await new Promise<number>((resolve) => {
      ops.open!("/list", 0x401, (e, f) => resolve(e === 0 ? (f ?? -1) : -1));
    });

    // Kernel page-cache writeback can deliver FLUSH before the WRITE.
    await new Promise<void>((resolve) => {
      ops.flush!("/list", fd, () => resolve());
    });
    expect(list.items).toEqual([]);

    const buf = Buffer.from("gamma\n");
    await new Promise<void>((resolve) => {
      ops.write!("/list", fd, buf, 6, 0, () => resolve());
    });
    await new Promise<void>((resolve) => {
      ops.flush!("/list", fd, () => resolve());
    });
    expect(list.items).toEqual(["gamma"]);

    await new Promise<void>((resolve) => {
      ops.release!("/list", fd, () => resolve());
    });
    expect(list.items).toEqual(["gamma"]);
  });
});

describe("per-descriptor ownership", () => {
  it("reports the agent user as the mount root owner", async () => {
    const registry = new DescriptorRegistry();
    const ops = registry.buildOps();
    const st = await new Promise<{ uid?: number; gid?: number }>((resolve) => {
      ops.getattr!("/", (err, s) => resolve(err ? {} : (s ?? {})));
    });
    expect(st.uid).toBe(AGENT_UID);
    expect(st.gid).toBe(AGENT_GID);
  });

  it("defaults file ownership to the agent user", async () => {
    const registry = new DescriptorRegistry([["/f", fileDescriptor(DescriptorFlags.CanRead, "x")]]);
    const ops = registry.buildOps();
    const st = await new Promise<{ uid?: number; gid?: number }>((resolve) => {
      ops.getattr!("/f", (err, s) => resolve(err ? {} : (s ?? {})));
    });
    expect(st.uid).toBe(AGENT_UID);
    expect(st.gid).toBe(AGENT_GID);
  });

  it("honors a descriptor-declared owner", async () => {
    const registry = new DescriptorRegistry([
      ["/f", fileDescriptor(DescriptorFlags.CanRead, "x", {}, { uid: 1234, gid: 5678 })],
    ]);
    const ops = registry.buildOps();
    const st = await new Promise<{ uid?: number; gid?: number }>((resolve) => {
      ops.getattr!("/f", (err, s) => resolve(err ? {} : (s ?? {})));
    });
    expect(st.uid).toBe(1234);
    expect(st.gid).toBe(5678);
  });

  it("honors a folder-declared owner", async () => {
    const folder = new DescriptorFolder({
      flags: DescriptorFlags.CanRead,
      uid: 1111,
      gid: 2222,
    });
    const registry = new DescriptorRegistry([["/dir", folder]]);
    const ops = registry.buildOps();
    const st = await new Promise<{ uid?: number; gid?: number }>((resolve) => {
      ops.getattr!("/dir", (err, s) => resolve(err ? {} : (s ?? {})));
    });
    expect(st.uid).toBe(1111);
    expect(st.gid).toBe(2222);
  });
});
