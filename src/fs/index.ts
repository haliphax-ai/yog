import type { FuseOps } from "fuse-native";

/**
 * Shared plumbing for FUSE descriptor tools.
 *
 * A descriptor is a node in the virtual filesystem the harness exposes through
 * the mount. Nodes form a tree: `DescriptorFolder` nodes manage their own
 * children (files or folders), and `DescriptorFile` nodes are leaf content.
 * Features shared by every descriptor (kind, mode, capability flags, size)
 * live on the `DescriptorNode` parent so they flow uniformly to both files
 * and folders.
 *
 * Capability flags declare what a node supports (reading, writing, removal,
 * renaming). The registry gates every operation on the relevant flag, so a
 * descriptor that does not support an operation is not forced to implement a
 * stub that raises an error — it simply omits the flag (and may omit the
 * corresponding method).
 *
 * To add a new descriptor, implement `DescriptorFile` (or use a
 * `DescriptorFolder` for a managed subtree) and register it — with its mount
 * path — on a `DescriptorRegistry`; the FUSE wiring (attribute reporting,
 * open/create fd handling, write buffering, commit-on-release, truncate,
 * rename, unlink, errno constants) is handled here.
 */

export const EPERM = -1;
export const ENOENT = -2;
export const EACCES = -13;
export const EBADF = -9;
export const EEXIST = -17;
export const ENOTDIR = -20;
export const EISDIR = -21;
export const EINVAL = -22;
export const ENOSYS = -38;

/**
 * Mount root mode. 0755: the kernel does not pre-empt mutations, so the
 * descriptor registry is the sole guard for every mutating op (create,
 * unlink, rename, …) — behavior emerges from registered descriptors.
 */
export const DIR_MODE = 0o40755;
/** Base mode for regular-file descriptors (owner read/write, world read). */
export const FILE_MODE = 0o100644;

export const OWNER_UID = process.getuid?.() ?? 0;
export const OWNER_GID = process.getgid?.() ?? 0;

/** Open access mode classification. */
export type WriteMode = "read" | "append" | "replace";

/**
 * Bit flags describing a descriptor's capabilities. A descriptor advertises
 * what it allows; absence of a flag means the default (denied) behavior for
 * that operation. Const-object form (not a TS enum) so it survives Node's
 * strip-only TS mode.
 */
export const DescriptorFlags = {
  /** No optional capabilities — permanent, non-readable, non-writable. */
  None: 0,
  /** Content may be read. */
  CanRead: 1 << 0,
  /** Content may be written (append/replace/truncate). */
  CanWrite: 1 << 1,
  /** The node may be unlinked (removed) from its parent folder. */
  CanRemove: 1 << 2,
  /** The node may be renamed (moved) within the mount. */
  CanRename: 1 << 3,
  /** The node accepts being overwritten by another node's rename (unless onOverwrite is defined). */
  CanOverwrite: 1 << 4,
} as const;

export type DescriptorFlags = (typeof DescriptorFlags)[keyof typeof DescriptorFlags];

/** Discriminator for descriptor nodes. */
export type DescriptorKind = "file" | "folder";

/** Normalize a mount path to a canonical leading-slash form. */
function normalizePath(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return p.replace(/\/+$/, "") || "/";
}

/**
 * The parent node type: every feature shared by all descriptors lives here so
 * it flows to both files and folders. The mount path is NOT part of the node —
 * it is assigned by the registry/parent at registration time.
 */
export interface DescriptorNode {
  readonly kind: DescriptorKind;
  /** POSIX mode bits (include S_IFREG / S_IFDIR). */
  readonly mode: number;
  /** Capability bit flags. */
  readonly flags: DescriptorFlags;
  /** Current size in bytes (0 when unspecified). */
  readonly size?: number;
  /**
   * Optional housekeeping hook invoked when this node is renamed within the
   * mount. Return a negative errno to refuse the rename.
   */
  onRename?(): number | void;
  /**
   * Optional housekeeping hook invoked when this node's content is read.
   * Return a negative errno to refuse the read.
   */
  onRead?(): number | void;
  /**
   * Optional housekeeping hook invoked before content is committed (append or
   * replace). Return a negative errno to refuse the write.
   */
  onWrite?(kind: Exclude<WriteMode, "read">, text: string): number | void;
  /**
   * Optional housekeeping hook invoked before the node is truncated to empty.
   * Return a negative errno to refuse the truncation.
   */
  onTruncate?(): number | void;
  /**
   * Optional housekeeping hook invoked before this node is removed from its
   * parent. Return a negative errno to refuse the deletion.
   */
  onDelete?(): number | void;
}

/**
 * A leaf descriptor: a virtual file. Implementations decide what the file
 * contains and how writes are applied; methods may be omitted when the
 * corresponding capability flag is not set.
 */
export interface DescriptorFile extends DescriptorNode {
  readonly kind: "file";
  /** Content served for reads (required when CanRead). */
  render?(): string;
  /**
   * Apply a committed mutation (required when CanWrite). `kind` is 'append'
   * for O_APPEND opens and 'replace' for destructive writes; `text` is the
   * fully buffered bytes.
   */
  commit?(kind: Exclude<WriteMode, "read">, text: string): void;
  /** Reset to empty content (required when CanWrite). */
  reset?(): void;
  /**
   * Optional custom handler for rename-overwrite. If defined, the registry
   * calls it instead of checking the CanOverwrite flag; return 0/undefined
   * to accept (the source node is then removed), or a negative errno to
   * refuse.
   */
  onOverwrite?(source: DescriptorFile): number | void;
}

/**
 * A directory descriptor: dynamically manages its own children. Children are
 * files or folders; `DescriptorFolder` provides the storage + CRUD API, and
 * subclasses may override `children`/`get` for fully dynamic behavior.
 */
export class DescriptorFolder implements DescriptorNode {
  readonly kind = "folder" as const;
  readonly mode: number;
  readonly flags: DescriptorFlags;

  /**
   * Optional housekeeping hook invoked when a child of this folder is renamed
   * (within or out of this folder). Return a negative errno to refuse.
   */
  onChildRename?(name: string, child: DescriptorChild): number | void;

  /**
   * Optional housekeeping hook invoked when a child is created in this folder.
   * Return a negative errno to refuse the creation.
   */
  onChildCreate?(name: string, child: DescriptorChild): number | void;

  /**
   * Optional housekeeping hook invoked when a child of this folder is deleted.
   * Return a negative errno to refuse the deletion.
   */
  onChildDelete?(name: string, child: DescriptorChild): number | void;

  #children = new Map<string, DescriptorChild>();

  constructor(opts: { mode?: number; flags?: DescriptorFlags } = {}) {
    this.mode = opts.mode ?? DIR_MODE;
    this.flags = opts.flags ?? DescriptorFlags.CanRead;
  }

  get size(): number {
    return 4096;
  }

  /** Snapshot of current children, keyed by name. */
  children(): ReadonlyMap<string, DescriptorChild> {
    return this.#children;
  }

  has(name: string): boolean {
    return this.#children.has(name);
  }

  get(name: string): DescriptorChild | undefined {
    return this.#children.get(name);
  }

  /** Add or replace a child node. */
  add(name: string, node: DescriptorChild): void {
    this.#children.set(name, node);
  }

  /** Remove a child; returns whether it was present. */
  remove(name: string): boolean {
    return this.#children.delete(name);
  }
}

/** Any concrete node: a file or a folder. */
export type DescriptorChild = DescriptorFile | DescriptorFolder;

interface OpenFile {
  file: DescriptorFile;
  mode: WriteMode;
  truncPending: boolean;
  chunks: Buffer[];
}

/**
 * Registry of FUSE descriptor nodes keyed by mount path — the mount's root is
 * itself a folder, and top-level names resolve to the registered nodes. Paths
 * are assigned here, at registration time, not inside the descriptor itself —
 * mirroring how harness tools are registered by name.
 */
export class DescriptorRegistry {
  private readonly root = new DescriptorFolder();
  private readonly open = new Map<number, OpenFile>();
  private nextFd = 1000;
  private pendingTruncate = false;

  constructor(entries: readonly (readonly [string, DescriptorChild])[] = []) {
    for (const [path, node] of entries) this.add(path, node);
  }

  /**
   * Register a node at the given mount path (leading slash optional).
   * Intermediate path segments must already exist as folders.
   */
  add(path: string, node: DescriptorChild): void {
    const segments = normalizePath(path).split("/").filter(Boolean);
    if (segments.length === 0) throw new Error("cannot register the mount root itself");
    let parent: DescriptorFolder = this.root;
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i] as string;
      const intermediate = parent.get(segment);
      if (!intermediate || intermediate.kind !== "folder") {
        throw new Error(`descriptor path ${path} requires intermediate folder "${segment}"`);
      }
      parent = intermediate;
    }
    const name = segments[segments.length - 1] as string;
    parent.add(name, node);
    parent.onChildCreate?.(name, node);
  }

  has(path: string): boolean {
    return this.resolve(normalizePath(path)) !== undefined;
  }

  /** Resolve a normalized path through the node tree. */
  private resolve(path: string): DescriptorChild | undefined {
    const segments = path.split("/").filter(Boolean);
    let node: DescriptorChild | undefined = this.root;
    for (const segment of segments) {
      if (!node || node.kind !== "folder") return undefined;
      node = node.get(segment);
    }
    return node;
  }

  /** Resolve the parent folder and child name for a normalized path. */
  private resolveParent(
    path: string,
  ): { parent: DescriptorFolder; name: string; node: DescriptorChild } | undefined {
    const segments = path.split("/").filter(Boolean);
    if (segments.length === 0) return undefined;
    let parent: DescriptorFolder = this.root;
    for (let i = 0; i < segments.length - 1; i++) {
      const intermediate = parent.get(segments[i] as string);
      if (!intermediate || intermediate.kind !== "folder") return undefined;
      parent = intermediate;
    }
    const name = segments[segments.length - 1] as string;
    const node = parent.get(name);
    if (!node) return undefined;
    return { parent, name, node };
  }

  /** Resolve the destination folder+name for a normalized path (child may not exist). */
  private resolveSlot(
    path: string,
  ): { parent: DescriptorFolder; name: string } | undefined {
    const segments = path.split("/").filter(Boolean);
    if (segments.length === 0) return undefined;
    let parent: DescriptorFolder = this.root;
    for (let i = 0; i < segments.length - 1; i++) {
      const intermediate = parent.get(segments[i] as string);
      if (!intermediate || intermediate.kind !== "folder") return undefined;
      parent = intermediate;
    }
    return { parent, name: segments[segments.length - 1] as string };
  }

  /** Build the flat FUSE operation set backed by the registered descriptors. */
  buildOps(): FuseOps {
    return {
      getattr: (path, cb) => {
        if (path === "/") {
          cb(null, {
            mode: DIR_MODE,
            size: this.root.size,
            nlink: 2,
            uid: OWNER_UID,
            gid: OWNER_GID,
          });
          return;
        }
        const node = this.resolve(normalizePath(path));
        if (!node) {
          cb(ENOENT);
          return;
        }
        if (node.kind === "folder") {
          cb(null, {
            mode: node.mode,
            size: node.size ?? 0,
            nlink: 2,
            uid: OWNER_UID,
            gid: OWNER_GID,
          });
          return;
        }
        cb(null, {
          mode: node.mode,
          size: node.size ?? 0,
          nlink: 1,
          uid: OWNER_UID,
          gid: OWNER_GID,
        });
      },

      readdir: (path, cb) => {
        const node = path === "/" ? this.root : this.resolve(normalizePath(path));
        if (!node) {
          cb(ENOENT);
          return;
        }
        if (node.kind !== "folder") {
          cb(ENOTDIR);
          return;
        }
        if ((node.flags & DescriptorFlags.CanRead) === 0) {
          cb(EACCES);
          return;
        }
        cb(null, [...node.children().keys()]);
      },

      open: (path, flags, cb) => {
        const node = this.resolve(normalizePath(path));
        if (!node) {
          cb(ENOENT, 0);
          return;
        }
        if (node.kind !== "file") {
          cb(EISDIR, 0);
          return;
        }
        const acc = flags & 3;
        const mode: WriteMode =
          acc === 0 ? "read" : (flags & O_APPEND) !== 0 ? "append" : "replace";
        if (mode === "read" && (node.flags & DescriptorFlags.CanRead) === 0) {
          cb(EACCES, 0);
          return;
        }
        if (mode !== "read" && (node.flags & DescriptorFlags.CanWrite) === 0) {
          cb(EACCES, 0);
          return;
        }
        const fd = this.nextFd++;
        this.open.set(fd, {
          file: node,
          mode,
          truncPending: (flags & O_TRUNC) !== 0,
          chunks: [],
        });
        cb(0, fd);
      },

      create: (path, _mode, cb) => {
        // Only existing writable file descriptors may be (re)created.
        const node = this.resolve(normalizePath(path));
        if (!node || node.kind !== "file") {
          cb(EACCES, 0);
          return;
        }
        if ((node.flags & DescriptorFlags.CanWrite) === 0) {
          cb(EACCES, 0);
          return;
        }
        const fd = this.nextFd++;
        this.open.set(fd, {
          file: node,
          mode: "replace",
          truncPending: true,
          chunks: [],
        });
        cb(0, fd);
      },

      read: (_path, fd, buf, len, pos, cb) => {
        const o = this.open.get(fd);
        if (!o) {
          cb(EBADF);
          return;
        }
        const rc = o.file.onRead?.();
        if (rc !== undefined && rc < 0) {
          cb(rc);
          return;
        }
        const data = Buffer.from(o.file.render?.() ?? "", "utf8");
        if (pos >= data.length) {
          cb(0);
          return;
        }
        const part = data.subarray(pos, pos + len);
        part.copy(buf, 0);
        cb(part.length);
      },

      write: (_path, fd, buf, len, _pos, cb) => {
        const o = this.open.get(fd);
        if (!o) {
          cb(EBADF);
          return;
        }
        o.chunks.push(Buffer.from(buf.subarray(0, len)));
        cb(len);
      },

      release: (_path, fd, cb) => {
        const o = this.open.get(fd);
        if (o) {
          this.open.delete(fd);
          const text = Buffer.concat(o.chunks).toString("utf8");
          if (o.mode === "append") {
            const rc = o.file.onWrite?.("append", text);
            if (rc === undefined || rc >= 0) o.file.commit?.("append", text);
          } else if (o.mode === "replace") {
            const destructive = o.truncPending || this.pendingTruncate;
            this.pendingTruncate = false;
            if (o.chunks.length > 0 || destructive) {
              const rc = o.file.onWrite?.("replace", text);
              if (rc === undefined || rc >= 0) o.file.commit?.("replace", text);
            }
          }
          // mode === 'read': never commits.
        }
        cb(0);
      },

      truncate: (path, size, cb) => {
        if (size !== 0) {
          cb(EINVAL);
          return;
        }
        const node = this.resolve(normalizePath(path));
        if (!node) {
          cb(ENOENT);
          return;
        }
        if (node.kind !== "file") {
          cb(EISDIR);
          return;
        }
        if ((node.flags & DescriptorFlags.CanWrite) === 0) {
          cb(EACCES);
          return;
        }
        if (!node.reset) {
          cb(ENOSYS);
          return;
        }
        if (this.open.size > 0) {
          // Truncate belonging to an open handle: defer to release so
          // subsequent writes land first.
          this.pendingTruncate = true;
          cb(0);
          return;
        }
        const rc = node.onTruncate?.();
        if (rc !== undefined && rc < 0) {
          cb(rc);
          return;
        }
        node.reset();
        cb(0);
      },

      rename: (src, dest, cb) => {
        const srcNorm = normalizePath(src);
        const destNorm = normalizePath(dest);

        const srcFound = this.resolveParent(srcNorm);
        if (!srcFound) {
          cb(ENOENT);
          return;
        }

        const destNode = this.resolve(destNorm);
        const destSlot = this.resolveSlot(destNorm);
        if (!destSlot) {
          cb(ENOENT);
          return;
        }

        // Rename-overwrite: destination is an existing file descriptor. The
        // registry handles CanOverwrite unless the descriptor defines its own
        // onOverwrite handler.
        if (destNode && destNode.kind === "file") {
          if (srcFound.node.kind !== "file") {
            cb(EISDIR);
            return;
          }
          const target = destNode;
          if (target.kind !== "file") {
            cb(EISDIR);
            return;
          }
          if (target.onOverwrite) {
            const rc = target.onOverwrite(srcFound.node);
            if (rc !== undefined && rc < 0) {
              cb(rc);
              return;
            }
          } else {
            if ((target.flags & DescriptorFlags.CanOverwrite) === 0) {
              cb(EPERM);
              return;
            }
            if ((srcFound.node.flags & DescriptorFlags.CanRead) === 0 || !srcFound.node.render) {
              cb(EACCES);
              return;
            }
            if (!target.commit) {
              cb(EACCES);
              return;
            }
            target.commit("replace", srcFound.node.render());
          }
          srcFound.parent.remove(srcFound.name);
          cb(0);
          return;
        }

        // Rename into a directory: becomes that directory's child.
        if (destNode && destNode.kind === "folder") {
          if ((srcFound.node.flags & DescriptorFlags.CanRename) === 0) {
            cb(EPERM);
            return;
          }
          if ((destNode.flags & DescriptorFlags.CanWrite) === 0) {
            cb(EACCES);
            return;
          }
          const rc = srcFound.node.onRename?.();
          if (rc !== undefined && rc < 0) {
            cb(rc);
            return;
          }
          const childRc = destNode.onChildRename?.(srcFound.name, srcFound.node);
          if (childRc !== undefined && childRc < 0) {
            cb(childRc);
            return;
          }
          destNode.add(srcFound.name, srcFound.node);
          srcFound.parent.remove(srcFound.name);
          cb(0);
          return;
        }

        // Pure repositioning: destination slot is empty. The registry handles
        // CanRename; the node may run its own onRename housekeeping.
        if ((srcFound.node.flags & DescriptorFlags.CanRename) === 0) {
          cb(EPERM);
          return;
        }
        if ((destSlot.parent.flags & DescriptorFlags.CanWrite) === 0) {
          cb(EACCES);
          return;
        }
        const rc = srcFound.node.onRename?.();
        if (rc !== undefined && rc < 0) {
          cb(rc);
          return;
        }
        const childRc = destSlot.parent.onChildRename?.(destSlot.name, srcFound.node);
        if (childRc !== undefined && childRc < 0) {
          cb(childRc);
          return;
        }
        destSlot.parent.add(destSlot.name, srcFound.node);
        srcFound.parent.remove(srcFound.name);
        cb(0);
      },

      unlink: (path, cb) => {
        const found = this.resolveParent(normalizePath(path));
        if (!found) {
          cb(ENOENT);
          return;
        }
        // A descriptor governs its own removability via its capability flags.
        if ((found.node.flags & DescriptorFlags.CanRemove) === 0) {
          cb(EPERM);
          return;
        }
        const childRc = found.parent.onChildDelete?.(found.name, found.node);
        if (childRc !== undefined && childRc < 0) {
          cb(childRc);
          return;
        }
        const rc = found.node.onDelete?.();
        if (rc !== undefined && rc < 0) {
          cb(rc);
          return;
        }
        found.parent.remove(found.name);
        cb(0);
      },
    };
  }
}

const O_APPEND = 0x400;
const O_TRUNC = 0x200;