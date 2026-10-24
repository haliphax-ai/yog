import type { FuseOps } from "fuse-native";

/**
 * Shared plumbing for FUSE descriptor tools.
 *
 * A descriptor is a virtual file the harness exposes through the mount. To add
 * a new descriptor, implement `DescriptorFile` and register it (with its
 * mount path) on a `DescriptorRegistry` — the FUSE wiring (attribute
 * reporting, open/create fd handling, write buffering, commit-on-release,
 * truncate, unlink denial, errno constants) is handled here, so a new tool
 * only supplies its content and mutation semantics.
 */

export const EPERM = -1;
export const ENOENT = -2;
export const EACCES = -13;
export const EBADF = -9;
export const EEXIST = -17;
export const ENOTDIR = -20;

/** Mount root: read/traverse-only under default_permissions. */
export const DIR_MODE = 0o40555;
/** Base mode for regular-file descriptors (owner read/write, world read). */
export const FILE_MODE = 0o100644;

export const OWNER_UID = process.getuid?.() ?? 0;
export const OWNER_GID = process.getgid?.() ?? 0;

/** Open access mode classification. */
export type WriteMode = "read" | "append" | "replace";

const O_APPEND = 0x400;
const O_TRUNC = 0x200;

/** Normalize a mount path to a canonical leading-slash form. */
function normalizePath(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return p.replace(/\/+$/, "") || "/";
}

/**
 * A single virtual file exposed by a descriptor tool. Implementations decide
 * what the file contains and how writes are applied. The mount path is NOT
 * part of the descriptor — it is assigned by the registry at registration
 * time.
 */
export interface DescriptorFile {
  /** POSIX mode bits (include S_IFREG). */
  readonly mode: number;
  /** Current size in bytes. */
  readonly size: number;
  /** Content served for reads. */
  render(): string;
  /**
   * Apply a committed mutation. `kind` is 'append' for O_APPEND opens and
   * 'replace' for destructive writes; `text` is the fully buffered bytes.
   */
  commit(kind: Exclude<WriteMode, "read">, text: string): void;
  /** Reset to empty content (standalone truncate-to-zero). */
  reset(): void;
}

interface OpenFile {
  file: DescriptorFile;
  mode: WriteMode;
  truncPending: boolean;
  chunks: Buffer[];
}

/**
 * Registry of FUSE descriptors keyed by mount path. Paths are assigned here,
 * at registration time, not inside the descriptor itself — mirroring how
 * harness tools are registered by name.
 */
export class DescriptorRegistry {
  private readonly descriptors = new Map<string, DescriptorFile>();
  private readonly open = new Map<number, OpenFile>();
  private nextFd = 1000;
  private pendingTruncate = false;

  constructor(entries: readonly (readonly [string, DescriptorFile])[] = []) {
    for (const [path, descriptor] of entries) this.add(path, descriptor);
  }

  /** Register a descriptor at the given mount path (leading slash optional). */
  add(path: string, descriptor: DescriptorFile): void {
    this.descriptors.set(normalizePath(path), descriptor);
  }

  has(path: string): boolean {
    return this.descriptors.has(normalizePath(path));
  }

  /** Registered descriptors keyed by their normalized mount paths. */
  get entries(): ReadonlyMap<string, DescriptorFile> {
    return this.descriptors;
  }

  /** Build the flat FUSE operation set backed by the registered descriptors. */
  buildOps(): FuseOps {
    return {
      getattr: (path, cb) => {
        if (path === "/") {
          cb(null, {
            mode: DIR_MODE,
            size: 4096,
            nlink: 2,
            uid: OWNER_UID,
            gid: OWNER_GID,
          });
          return;
        }
        const file = this.descriptors.get(normalizePath(path));
        if (!file) {
          cb(ENOENT);
          return;
        }
        cb(null, {
          mode: file.mode,
          size: file.size,
          nlink: 1,
          uid: OWNER_UID,
          gid: OWNER_GID,
        });
      },

      readdir: (path, cb) => {
        if (path !== "/") {
          cb(ENOTDIR);
          return;
        }
        cb(
          null,
          [...this.descriptors.keys()].map((p) => p.slice(1)),
        );
      },

      open: (path, flags, cb) => {
        const file = this.descriptors.get(normalizePath(path));
        if (!file) {
          cb(ENOENT, 0);
          return;
        }
        const acc = flags & 3;
        const mode: WriteMode =
          acc === 0 ? "read" : (flags & O_APPEND) !== 0 ? "append" : "replace";
        const fd = this.nextFd++;
        this.open.set(fd, {
          file,
          mode,
          truncPending: (flags & O_TRUNC) !== 0,
          chunks: [],
        });
        cb(0, fd);
      },

      create: (path, _mode, cb) => {
        // Only registered descriptors may be (re)created.
        const file = this.descriptors.get(normalizePath(path));
        if (!file) {
          cb(EACCES, 0);
          return;
        }
        const fd = this.nextFd++;
        this.open.set(fd, { file, mode: "replace", truncPending: true, chunks: [] });
        cb(0, fd);
      },

      read: (_path, fd, buf, len, pos, cb) => {
        const o = this.open.get(fd);
        if (!o) {
          cb(EBADF);
          return;
        }
        const data = Buffer.from(o.file.render(), "utf8");
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
            o.file.commit("append", text);
          } else if (o.mode === "replace") {
            const destructive = o.truncPending || this.pendingTruncate;
            this.pendingTruncate = false;
            if (o.chunks.length > 0 || destructive) o.file.commit("replace", text);
          }
          // mode === 'read': never commits.
        }
        cb(0);
      },

      truncate: (path, size, cb) => {
        if (size === 0) {
          const file = this.descriptors.get(normalizePath(path));
          if (file) {
            if (this.open.size > 0) {
              // Truncate belonging to an open handle: defer to release so
              // subsequent writes land first.
              this.pendingTruncate = true;
            } else {
              file.reset();
            }
          }
        }
        cb(0);
      },

      unlink: (path, cb) => {
        if (!this.descriptors.has(normalizePath(path))) {
          cb(ENOENT);
          return;
        }
        // Descriptors are permanent — deletion always fails.
        cb(EPERM);
      },
    };
  }
}
