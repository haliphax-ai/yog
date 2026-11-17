/**
 * The descriptor registry: a FUSE-op adapter over the descriptor tree. It
 * owns path resolution, open-file (fd) state, write buffering with
 * commit-on-flush/release, and every FUSE operation (getattr/readdir/open/
 * create/mkdir/read/write/flush/release/truncate/rename/unlink/rmdir),
 * gated by descriptor capability flags and hooks.
 */
import type { FuseOps } from "fuse-native";
import { ENOENT } from "./constants.ts";
import { DescriptorFolder, type DescriptorChild } from "./node.ts";
import { normalizePath, resolve, resolveParent, resolveSlot } from "./paths.ts";
import {
  bufferWrite,
  commitOpen,
  createEntry,
  openEntry,
  readBytes,
  truncateEntry,
} from "./ops/io.ts";
import { listingFor, mkdirEntry, rmdirEntry, statFor, unlinkEntry } from "./ops/dirs.ts";
import { renameEntry } from "./ops/rename.ts";
import { type Ctx, type OpenFile, type ReadWire, type WriteWire } from "./ops/types.ts";

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

  /** Mutable registry state, shared with the per-op modules. */
  private get ctx(): Ctx {
    return {
      root: this.root,
      open: this.open,
      allocFd: () => this.nextFd++,
      markTruncate: () => {
        this.pendingTruncate = true;
      },
      takeTruncate: () => {
        const pending = this.pendingTruncate;
        this.pendingTruncate = false;
        return pending;
      },
    };
  }

  constructor(entries: readonly (readonly [string, DescriptorChild])[] = []) {
    for (const [path, node] of entries) this.add(path, node);
  }

  /**
   * Register a node at the given mount path (leading slash optional).
   * Intermediate folders are auto-created if missing.
   */
  add(path: string, node: DescriptorChild): void {
    const segments = normalizePath(path).split("/").filter(Boolean);
    if (segments.length === 0) throw new Error("cannot register the mount root itself");
    const name = segments[segments.length - 1] as string;
    const parent = this.rootFor(segments, path);
    parent.add(name, node);
    parent.onChildCreate?.(name, node);
  }

  /**
   * Walk to the parent folder of a registration path, auto-creating missing
   * intermediates; a non-folder intermediate is a registration error.
   */
  private rootFor(segments: string[], path: string): DescriptorFolder {
    let parent = this.root;
    for (let i = 0; i < segments.length - 1; i++) {
      parent = this.descend(parent, segments[i] as string, path);
    }
    return parent;
  }

  /** One registration-path hop: reuse or auto-create the intermediate folder. */
  private descend(parent: DescriptorFolder, segment: string, path: string): DescriptorFolder {
    const intermediate = parent.get(segment);
    if (intermediate === undefined) {
      const folder = new DescriptorFolder();
      parent.add(segment, folder);
      return folder;
    }
    if (intermediate.kind !== "folder") {
      throw new Error(`descriptor path ${path} has non-folder intermediate "${segment}"`);
    }
    return intermediate;
  }

  has(path: string): boolean {
    return this.resolve(normalizePath(path)) !== undefined;
  }

  /** Resolve a normalized path through the node tree. */
  private resolve(path: string): DescriptorChild | undefined {
    return resolve({ root: this.root }, path);
  }

  /** The parent folder + child name for a normalized path (child must exist). */
  private resolveParent(
    path: string,
  ): { parent: DescriptorFolder; name: string; node: DescriptorChild } | undefined {
    return resolveParent({ root: this.root }, path);
  }

  /** The destination folder+name for a normalized path (child may not exist). */
  private resolveSlot(path: string): { parent: DescriptorFolder; name: string } | undefined {
    return resolveSlot({ root: this.root }, path);
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
    if (o.mode === "append") this.commitAppend(o);
    if (o.mode === "replace") this.commitReplace(o);
    // mode === 'read': never commits.
    o.committedChunks = o.chunks.length;
  }

  /** Commit the not-yet-committed chunk tail as an append. */
  private commitAppend(o: OpenFile): void {
    const fresh = Buffer.concat(o.chunks.slice(o.committedChunks));
    const text = fresh.toString("utf8");
    const rc = o.file.onWrite?.("append", text);
    if (rc === undefined || rc >= 0) o.file.commit?.("append", text);
  }

  /**
   * Commit the buffered whole as a replace. The kernel does not guarantee
   * FLUSH lands after WRITE (page-cache writeback), so an empty buffer
   * still commits when a pending truncate marks the write destructive.
   */
  private commitReplace(o: OpenFile): void {
    const destructive = o.truncPending || this.pendingTruncate;
    this.pendingTruncate = false;
    if (o.chunks.length === 0 && !destructive) return;
    const text = Buffer.concat(o.chunks).toString("utf8");
    const rc = o.file.onWrite?.("replace", text);
    if (rc === undefined || rc >= 0) o.file.commit?.("replace", text);
  }

  /** Build the flat FUSE operation set backed by the registered descriptors. */
  buildOps(): FuseOps {
    return {
      getattr: (path, cb) => {
        const stat = statFor(this.ctx, path);
        if (stat === undefined) {
          cb(ENOENT);
          return;
        }
        cb(null, stat);
      },

      readdir: (path, cb) => {
        const listing = listingFor(this.ctx, path);
        if (typeof listing === "number") {
          cb(listing);
          return;
        }
        cb(null, listing);
      },

      open: (path, flags, cb) => {
        openEntry(this.ctx, normalizePath(path), flags, cb);
      },

      create: (path, _mode, cb) => {
        // Only existing writable file descriptors may be (re)created.
        createEntry(this.ctx, normalizePath(path), cb);
      },

      mkdir: (path, mode, cb) => {
        mkdirEntry(this.ctx, normalizePath(path), mode, cb);
      },

      // The positional wire (path, fd, buf, len, pos, cb) is fixed by
      // fuse-native; the rest pattern keeps the adapter to a single
      // short-hand destructured line and hands the named pieces on.
      read: (...[, fd, buf, len, pos, cb]: ReadWire) => {
        readBytes(this.ctx, { fd, buf, len, pos, cb });
      },

      write: (...[, fd, buf, len, , cb]: WriteWire) => {
        bufferWrite(this.ctx, fd, buf, len);
        cb(len);
      },

      flush: (_path, fd, cb) => {
        const o = this.open.get(fd);
        if (o !== undefined) commitOpen(this.ctx, o);
        cb(0);
      },

      release: (_path, fd, cb) => {
        const o = this.open.get(fd);
        if (o !== undefined) this.open.delete(fd);
        if (o !== undefined) commitOpen(this.ctx, o);
        cb(0);
      },

      truncate: (path, size, cb) => {
        truncateEntry(this.ctx, normalizePath(path), size, cb);
      },

      rename: (src, dest, cb) => {
        renameEntry(this.ctx, normalizePath(src), normalizePath(dest), cb);
      },

      unlink: (path, cb) => {
        unlinkEntry(this.ctx, normalizePath(path), cb);
      },

      rmdir: (path, cb) => {
        rmdirEntry(this.ctx, normalizePath(path), cb);
      },
    };
  }
}
