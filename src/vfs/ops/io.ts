/**
 * The byte-transfer + handle-lifecycle FUSE ops: READ/WRITE buffering,
 * FLUSH/RELEASE commit, and the open/create/truncate entries. The kernelside
 * wire is positional (see `ops/types.ts`); the registry hands us the named
 * pieces.
 */
import { DescriptorFlags, EACCES, EBADF, EINVAL, EISDIR, ENOENT, ENOSYS } from "../constants.ts";
import type { DescriptorChild, DescriptorFile } from "../node.ts";
import { resolve } from "../paths.ts";
import { refused } from "./rename.ts";
import type { Ctx, OpenFile, WriteMode } from "./types.ts";

const O_APPEND = 0x400;
const O_TRUNC = 0x200;

/** Buffer one WRITE chunk against its open handle (bad fd is a no-op). */
export function bufferWrite(ctx: Ctx, fd: number, buf: Buffer, len: number): void {
  const o = ctx.open.get(fd);
  if (o !== undefined) o.chunks.push(Buffer.from(buf.subarray(0, len)));
}

/**
 * Serve one READ: refuse on a negative `onRead` rc, else copy the rendered
 * bytes at `pos` (up to `len`) into `buf`; short read when fewer remain.
 */
export function readBytes(
  ctx: Ctx,
  read: { fd: number; buf: Buffer; len: number; pos: number; cb: (bytes: number) => void },
): void {
  const o = ctx.open.get(read.fd);
  if (o === undefined) {
    read.cb(EBADF);
    return;
  }
  const veto = refused(() => o.file.onRead?.());
  if (veto !== undefined) {
    read.cb(veto);
    return;
  }
  const data = Buffer.from(o.file.render?.() ?? "", "utf8");
  if (read.pos >= data.length) {
    read.cb(0);
    return;
  }
  const part = data.subarray(read.pos, read.pos + read.len);
  part.copy(read.buf, 0);
  read.cb(part.length);
}

/**
 * Commit an open file handle's buffered writes. Called from both `flush`
 * and `release`. The kernel does not guarantee that FLUSH arrives after the
 * WRITEs (with page-cache writeback a flush can precede them), so any
 * uncommitted tail is flushed here on both paths.
 */
export function commitOpen(ctx: Ctx, o: OpenFile): void {
  if (o.mode === "append") commitAppend(o);
  if (o.mode === "replace") commitReplace(ctx, o);
  // mode === 'read': never commits.
  o.committedChunks = o.chunks.length;
}

/** Commit the not-yet-committed chunk tail as an append. */
function commitAppend(o: OpenFile): void {
  const fresh = Buffer.concat(o.chunks.slice(o.committedChunks));
  const text = fresh.toString("utf8");
  const veto = refused(() => o.file.onWrite?.("append", text));
  if (veto === undefined) o.file.commit?.("append", text);
}

/**
 * Commit the buffered whole as a replace. The kernel does not guarantee
 * FLUSH lands after WRITE (page-cache writeback), so an empty buffer
 * still commits when a pending truncate marks the write destructive.
 */
function commitReplace(ctx: Ctx, o: OpenFile): void {
  const destructive = o.truncPending || ctx.takeTruncate();
  if (o.chunks.length === 0 && !destructive) return;
  const text = Buffer.concat(o.chunks).toString("utf8");
  const veto = refused(() => o.file.onWrite?.("replace", text));
  if (veto === undefined) o.file.commit?.("replace", text);
}

/**
 * The WriteMode an open at `path`/`flags` resolves to, or the errno the
 * op must fail with: the target must exist and be a file whose capability
 * flags admit the requested access.
 */
export function openModeFor(node: DescriptorChild | undefined, flags: number): WriteMode | number {
  if (node === undefined) return ENOENT;
  if (node.kind !== "file") return EISDIR;
  const acc = flags & 3;
  const mode: WriteMode = acc === 0 ? "read" : (flags & O_APPEND) !== 0 ? "append" : "replace";
  if (mode === "read" && (node.flags & DescriptorFlags.CanRead) === 0) return EACCES;
  if (mode !== "read" && (node.flags & DescriptorFlags.CanWrite) === 0) return EACCES;
  return mode;
}

/** Allocate an fd-backed handle over `node` and hand it to the kernel. */
export function openHandle(
  ctx: Ctx,
  node: DescriptorFile,
  mode: WriteMode,
  truncating: boolean,
  cb: (err: number | null, fd?: number) => void,
): void {
  const fd = ctx.allocFd();
  ctx.open.set(fd, {
    file: node,
    mode,
    truncPending: truncating,
    chunks: [],
    committedChunks: 0,
  });
  cb(0, fd);
}

/** Open entry: gate the mode, then allocate the handle. */
export function openEntry(
  ctx: Ctx,
  path: string,
  flags: number,
  cb: (err: number | null, fd?: number) => void,
): void {
  const mode = openModeFor(resolve(ctx, path), flags);
  if (typeof mode === "number") {
    cb(mode, 0);
    return;
  }
  openHandle(ctx, resolve(ctx, path) as DescriptorFile, mode, (flags & O_TRUNC) !== 0, cb);
}

/**
 * Create entry: only existing writable file descriptors may be (re)created.
 */
export function createEntry(
  ctx: Ctx,
  path: string,
  cb: (err: number | null, fd?: number) => void,
): void {
  const node = resolve(ctx, path);
  if (node === undefined || node.kind !== "file" || (node.flags & DescriptorFlags.CanWrite) === 0) {
    cb(EACCES, 0);
    return;
  }
  openHandle(ctx, node, "replace", true, cb);
}

/**
 * The errno a truncate at `path` must fail with, or undefined when the op
 * may proceed (size must be zero and the target a writable resettable
 * file descriptor).
 */
export function truncateGate(ctx: Ctx, path: string, size: number): number | undefined {
  if (size !== 0) return EINVAL;
  const node = resolve(ctx, path);
  if (node === undefined) return ENOENT;
  if (node.kind !== "file") return EISDIR;
  if ((node.flags & DescriptorFlags.CanWrite) === 0) return EACCES;
  return node.reset === undefined ? ENOSYS : undefined;
}

/**
 * Truncate entry: resolve the (already gated) target; a live handle defers
 * the truncation to release so subsequent writes land first, otherwise the
 * onTruncate hook must accept before the reset lands.
 */
export function truncateEntry(
  ctx: Ctx,
  path: string,
  size: number,
  cb: (err: number | null) => void,
): void {
  const gate = truncateGate(ctx, path, size);
  if (gate !== undefined) {
    cb(gate);
    return;
  }
  const node = resolve(ctx, path) as DescriptorFile;
  if (ctx.open.size > 0) {
    // Truncate belonging to an open handle: defer to release so
    // subsequent writes land first.
    ctx.markTruncate();
    cb(0);
    return;
  }
  const veto = refused(() => node.onTruncate?.());
  if (veto !== undefined) {
    cb(veto);
    return;
  }
  node.reset?.();
  cb(0);
}
