import { describe, expect, it } from "vitest";
import { ListDescriptor } from "../src/fs/list.ts";
import {
  type DescriptorFile,
  DescriptorFlags,
  DescriptorFolder,
  DescriptorRegistry,
  DIR_MODE,
  ENOENT,
  EPERM,
  FILE_MODE,
} from "../src/fs/index.ts";

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

describe("DescriptorFlags unlink behavior", () => {
  function removableFile(): DescriptorFile {
    return {
      kind: "file",
      mode: FILE_MODE,
      flags: DescriptorFlags.Removable,
      size: 0,
      render: () => "",
      commit: () => {},
      reset: () => {},
    };
  }

  function permanentFile(): DescriptorFile {
    return {
      kind: "file",
      mode: FILE_MODE,
      flags: DescriptorFlags.None,
      size: 0,
      render: () => "",
      commit: () => {},
      reset: () => {},
    };
  }

  it("denies unlink for a descriptor without Removable", async () => {
    const registry = new DescriptorRegistry([["/perm", permanentFile()]]);
    const ops = registry.buildOps();
    const err = await new Promise<number | null>((resolve) => {
      ops.unlink!("/perm", (e) => resolve(e));
    });
    expect(err).toBe(EPERM);
    expect(registry.has("/perm")).toBe(true);
  });

  it("allows unlink for a Removable descriptor", async () => {
    const registry = new DescriptorRegistry([["/mutable", removableFile()]]);
    const ops = registry.buildOps();
    const err = await new Promise<number | null>((resolve) => {
      ops.unlink!("/mutable", (e) => resolve(e));
    });
    expect(err).toBe(0);
    expect(registry.has("/mutable")).toBe(false);
  });

  it("removes a Removable child from a folder via unlink", async () => {
    const sessions = new DescriptorFolder();
    sessions.add("s1", removableFile());
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
