/**
 * The descriptor registry: a FUSE-op adapter over the descriptor tree. It
 * owns path resolution, open-file (fd) state, write buffering with
 * commit-on-flush/release, and every FUSE operation (getattr/readdir/open/
 * create/mkdir/read/write/flush/release/truncate/rename/unlink/rmdir),
 * gated by descriptor capability flags and hooks.
 */
import type { FuseOps } from "fuse-native";
import {
  DescriptorFlags,
  DIR_MODE,
  EACCES,
  EBADF,
  EEXIST,
  EINVAL,
  EISDIR,
  ENOENT,
  ENOSYS,
  ENOTDIR,
  ENOTEMPTY,
  EPERM,
  OWNER_GID,
  OWNER_UID,
  type WriteMode,
} from "./constants.ts";
import { DescriptorFolder, type DescriptorChild, type DescriptorFile } from "./node.ts";

const O_APPEND = 0x400;
const O_TRUNC = 0x200;

/** Normalize a mount path to a canonical leading-slash form. */
function normalizePath(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return p.replace(/\/+$/, "") || "/";
}

interface OpenFile {
  file: DescriptorFile;
  mode: WriteMode;
  truncPending: boolean;
  chunks: Buffer[];
  /** How many chunks have already been committed (flush/release). */
  committedChunks: number;
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
  private resolveSlot(path: string): { parent: DescriptorFolder; name: string } | undefined {
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

  /**
   * Commit an open file handle's buffered writes. Called from both `flush`
   * and `release`. The kernel does not guarantee that FLUSH arrives after the
   * WRITEs (with page-cache writeback a flush can precede the writes), so we
   * commit only what is new since the last commit (`committedChunks`) and
   * leave the rest for a later flush/release — this makes an early empty
   * flush a no-op instead of a premature commit.
   */
  private commitOpen(o: OpenFile): void {
    if (o.committedChunks >= o.chunks.length) return;
    const total = Buffer.concat(o.chunks);
    const fresh = Buffer.concat(o.chunks.slice(o.committedChunks));
    if (o.mode === "append") {
      const text = fresh.toString("utf8");
      const rc = o.file.onWrite?.("append", text);
      if (rc === undefined || rc >= 0) o.file.commit?.("append", text);
    } else if (o.mode === "replace") {
      const destructive = o.truncPending || this.pendingTruncate;
      this.pendingTruncate = false;
      if (o.chunks.length > 0 || destructive) {
        const rc = o.file.onWrite?.("replace", total.toString("utf8"));
        if (rc === undefined || rc >= 0) o.file.commit?.("replace", total.toString("utf8"));
      }
    }
    // mode === 'read': never commits.
    o.committedChunks = o.chunks.length;
  }

  /**
   * Whether `descendantPath` sits at or below `ancestorPath` in the node tree
   * (used to keep folder renames from nesting a folder inside itself).
   */
  private isInside(ancestorPath: string, descendantPath: string): boolean {
    const a = normalizePath(ancestorPath).split("/").filter(Boolean);
    const d = normalizePath(descendantPath).split("/").filter(Boolean);
    if (a.length === 0) return true;
    if (d.length < a.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== d[i]) return false;
    }
    return true;
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
        const rc = node.onRead?.();
        if (rc !== undefined && rc < 0) {
          cb(rc);
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
          committedChunks: 0,
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
          committedChunks: 0,
        });
        cb(0, fd);
      },

      mkdir: (path, mode, cb) => {
        const slot = this.resolveSlot(normalizePath(path));
        if (!slot) {
          cb(ENOENT);
          return;
        }
        if (slot.parent.get(slot.name)) {
          cb(EEXIST);
          return;
        }
        if (slot.parent !== this.root && (slot.parent.flags & DescriptorFlags.CanWrite) === 0) {
          cb(EACCES);
          return;
        }
        const dirMode = ((mode & 0o7777) | 0o40000) >>> 0;
        const folder = new DescriptorFolder({ mode: dirMode });
        const childRc = slot.parent.onChildCreate?.(slot.name, folder);
        if (childRc !== undefined && childRc < 0) {
          cb(childRc);
          return;
        }
        const writeRc = slot.parent.onWrite?.("append", slot.name);
        if (writeRc !== undefined && writeRc < 0) {
          cb(writeRc);
          return;
        }
        slot.parent.add(slot.name, folder);
        cb(0);
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

      flush: (_path, fd, cb) => {
        const o = this.open.get(fd);
        if (o) this.commitOpen(o);
        cb(0);
      },

      release: (_path, fd, cb) => {
        const o = this.open.get(fd);
        if (o) {
          this.open.delete(fd);
          this.commitOpen(o);
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

        const srcParent = srcFound.parent;
        const srcName = srcFound.name;

        // Renaming a node onto itself is a no-op.
        if (srcNorm === destNorm) {
          cb(0);
          return;
        }

        const destNode = this.resolve(destNorm);
        const destSlot = this.resolveSlot(destNorm);
        if (!destSlot) {
          cb(ENOENT);
          return;
        }

        // The source folder is notified before it loses the child.
        const leave = (): number | void => srcParent.onChildRename?.(srcName, srcFound.node);

        // Rename-overwrite: destination is an existing file descriptor. The
        // registry handles CanOverwrite unless the descriptor defines its own
        // onOverwrite handler.
        if (destNode && destNode.kind === "file") {
          if (srcFound.node.kind !== "file") {
            cb(EISDIR);
            return;
          }
          const target = destNode;
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
          const lr = leave();
          if (lr !== undefined && lr < 0) {
            cb(lr);
            return;
          }
          srcParent.remove(srcName);
          cb(0);
          return;
        }

        // Destination slot is occupied by a folder.
        if (destNode && destNode.kind === "folder") {
          // A folder source must never be nested inside itself or a descendant.
          if (srcFound.node.kind === "folder") {
            if (this.isInside(srcNorm, destNorm)) {
              cb(EINVAL);
              return;
            }
            // If the destination folder opts into overwrite (onOverwrite handler
            // or CanOverwrite flag), replace it with the source folder. A custom
            // handler decides for itself; flag-based replacement requires the
            // destination to be empty.
            const hasOverwriteHandler = Boolean(destNode.onOverwrite);
            const wantsReplace =
              hasOverwriteHandler || (destNode.flags & DescriptorFlags.CanOverwrite) !== 0;
            if (!wantsReplace) {
              if ((srcFound.node.flags & DescriptorFlags.CanRename) === 0) {
                cb(EPERM);
                return;
              }
              if (destNode !== this.root && (destNode.flags & DescriptorFlags.CanWrite) === 0) {
                cb(EACCES);
                return;
              }
              if (destNode.has(srcName) && srcParent !== destNode) {
                cb(EEXIST);
                return;
              }
              const rc = srcFound.node.onRename?.();
              if (rc !== undefined && rc < 0) {
                cb(rc);
                return;
              }
              const lr = leave();
              if (lr !== undefined && lr < 0) {
                cb(lr);
                return;
              }
              const childRc = destNode.onChildRename?.(srcName, srcFound.node);
              if (childRc !== undefined && childRc < 0) {
                cb(childRc);
                return;
              }
              destNode.add(srcName, srcFound.node);
              srcParent.remove(srcName);
              cb(0);
              return;
            }
            if ((srcFound.node.flags & DescriptorFlags.CanRename) === 0) {
              cb(EPERM);
              return;
            }
            if (hasOverwriteHandler) {
              const hrc = destNode.onOverwrite?.(srcFound.node);
              if (hrc !== undefined && hrc < 0) {
                cb(hrc);
                return;
              }
            } else if (destNode.children().size > 0) {
              cb(ENOTEMPTY);
              return;
            }
            const delChildRc = destSlot.parent.onChildDelete?.(destSlot.name, destNode);
            if (delChildRc !== undefined && delChildRc < 0) {
              cb(delChildRc);
              return;
            }
            const delRc = destNode.onDelete?.();
            if (delRc !== undefined && delRc < 0) {
              cb(delRc);
              return;
            }
            const srcRc = srcFound.node.onRename?.();
            if (srcRc !== undefined && srcRc < 0) {
              cb(srcRc);
              return;
            }
            const lr = leave();
            if (lr !== undefined && lr < 0) {
              cb(lr);
              return;
            }
            const childRc = destSlot.parent.onChildRename?.(destSlot.name, srcFound.node);
            if (childRc !== undefined && childRc < 0) {
              cb(childRc);
              return;
            }
            destSlot.parent.remove(destSlot.name);
            destSlot.parent.add(destSlot.name, srcFound.node);
            srcParent.remove(srcName);
            cb(0);
            return;
          }

          // File source: becomes that directory's child.
          if ((srcFound.node.flags & DescriptorFlags.CanRename) === 0) {
            cb(EPERM);
            return;
          }
          if (destNode !== this.root && (destNode.flags & DescriptorFlags.CanWrite) === 0) {
            cb(EACCES);
            return;
          }
          if (destNode.has(srcName) && srcParent !== destNode) {
            cb(EEXIST);
            return;
          }
          const rc = srcFound.node.onRename?.();
          if (rc !== undefined && rc < 0) {
            cb(rc);
            return;
          }
          const lr = leave();
          if (lr !== undefined && lr < 0) {
            cb(lr);
            return;
          }
          const childRc = destNode.onChildRename?.(srcName, srcFound.node);
          if (childRc !== undefined && childRc < 0) {
            cb(childRc);
            return;
          }
          destNode.add(srcName, srcFound.node);
          srcParent.remove(srcName);
          cb(0);
          return;
        }

        // Pure repositioning: destination slot is empty. The registry handles
        // CanRename; the node may run its own onRename housekeeping.
        if (srcFound.node.kind === "folder" && this.isInside(srcNorm, destNorm)) {
          cb(EINVAL);
          return;
        }
        if ((srcFound.node.flags & DescriptorFlags.CanRename) === 0) {
          cb(EPERM);
          return;
        }
        if (
          destSlot.parent !== this.root &&
          (destSlot.parent.flags & DescriptorFlags.CanWrite) === 0
        ) {
          cb(EACCES);
          return;
        }
        const rc = srcFound.node.onRename?.();
        if (rc !== undefined && rc < 0) {
          cb(rc);
          return;
        }
        const lr = leave();
        if (lr !== undefined && lr < 0) {
          cb(lr);
          return;
        }
        const childRc = destSlot.parent.onChildRename?.(destSlot.name, srcFound.node);
        if (childRc !== undefined && childRc < 0) {
          cb(childRc);
          return;
        }
        destSlot.parent.add(destSlot.name, srcFound.node);
        srcParent.remove(srcName);
        cb(0);
      },

      unlink: (path, cb) => {
        const found = this.resolveParent(normalizePath(path));
        if (!found) {
          cb(ENOENT);
          return;
        }
        // unlink removes files only; folders are removed via rmdir.
        if (found.node.kind === "folder") {
          cb(EISDIR);
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

      rmdir: (path, cb) => {
        const found = this.resolveParent(normalizePath(path));
        if (!found) {
          cb(ENOENT);
          return;
        }
        // rmdir removes folders only; files are removed via unlink.
        if (found.node.kind !== "folder") {
          cb(ENOTDIR);
          return;
        }
        if (found.node.children().size > 0) {
          cb(ENOTEMPTY);
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
        const writeRc = found.parent.onWrite?.("replace", found.name);
        if (writeRc !== undefined && writeRc < 0) {
          cb(writeRc);
          return;
        }
        found.parent.remove(found.name);
        cb(0);
      },
    };
  }
}
