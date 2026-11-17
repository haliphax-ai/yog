/**
 * The directory-tree FUSE ops: GETATTR/READDIR metadata and listing, the
 * MKDIR entry, and the UNLINK/RMDIR removals. Gates return the errno an op
 * must fail with (or undefined to proceed); entries sequence the gate, the
 * descriptor hooks, and the tree mutation.
 */
import {
  DescriptorFlags,
  EACCES,
  EEXIST,
  EISDIR,
  ENOENT,
  ENOTDIR,
  ENOTEMPTY,
  EPERM,
  getAgentOwnership,
} from "../constants.ts";
import { DescriptorFolder, type DescriptorChild, type DescriptorFile } from "../node.ts";
import { normalizePath, resolve, resolveParent, resolveSlot } from "../paths.ts";
import { refused } from "./rename.ts";
import type { Ctx } from "./types.ts";

/**
 * The stat struct served for a mount path: the root is itself a folder
 * (its own mode/size), a resolved node reports its mode/size/owner
 * (nlink 2 for folders, 1 for files); unknown paths are ENOENT.
 */
export function statFor(
  ctx: Ctx,
  path: string,
): { mode: number; size: number; nlink: number; uid: number; gid: number } | undefined {
  const own = getAgentOwnership();
  const node = path === "/" ? ctx.root : resolve(ctx, normalizePath(path));
  if (node === undefined) return undefined;
  return {
    mode: node.mode,
    size: node.size ?? 0,
    nlink: node.kind === "folder" ? 2 : 1,
    uid: node.uid ?? own.uid,
    gid: node.gid ?? own.gid,
  };
}

/**
 * A folder's child names (readdir payload), or the errno the listing must
 * fail with: the target must exist and be a readable folder whose onRead
 * housekeeping accepts the listing.
 */
export function listingFor(ctx: Ctx, path: string): number | string[] {
  const node = path === "/" ? ctx.root : resolve(ctx, normalizePath(path));
  if (node === undefined) return ENOENT;
  if (node.kind !== "folder") return ENOTDIR;
  if ((node.flags & DescriptorFlags.CanRead) === 0) return EACCES;
  const veto = refused(() => node.onRead?.());
  if (veto !== undefined) return veto;
  return [...node.children().keys()];
}

/**
 * The errno an mkdir at `path` must fail with, or undefined when the op may
 * proceed: the slot must be free and the parent folder restructurable.
 */
export function mkdirGate(
  ctx: Ctx,
  slot: { parent: DescriptorFolder; name: string },
): number | undefined {
  if (slot.parent.get(slot.name) !== undefined) return EEXIST;
  if (slot.parent !== ctx.root && (slot.parent.flags & DescriptorFlags.CanWrite) === 0) {
    return EACCES;
  }
  return undefined;
}

/**
 * Mkdir entry: resolve the destination slot, gate it, let the parent's
 * onChildCreate/onWrite hooks accept the new folder, then add it.
 */
export function mkdirEntry(
  ctx: Ctx,
  path: string,
  mode: number,
  cb: (err: number | null) => void,
): void {
  const slot = resolveSlot(ctx, path);
  if (slot === undefined) {
    cb(ENOENT);
    return;
  }
  const gate = mkdirGate(ctx, slot);
  if (gate !== undefined) {
    cb(gate);
    return;
  }
  const folder = new DescriptorFolder({ mode: ((mode & 0o7777) | 0o40000) >>> 0 });
  const veto =
    refused(() => slot.parent.onChildCreate?.(slot.name, folder)) ??
    refused(() => slot.parent.onWrite?.("append", slot.name));
  if (veto !== undefined) {
    cb(veto);
    return;
  }
  slot.parent.add(slot.name, folder);
  cb(0);
}

/**
 * The errno an unlink at `path` must fail with, or undefined when the op
 * may proceed: the target must exist, be a file (folders leave via rmdir),
 * and opt into removal (CanRemove).
 */
export function unlinkGate(
  found: { parent: DescriptorFolder; name: string; node: DescriptorChild } | undefined,
): number | undefined {
  if (found === undefined) return ENOENT;
  if (found.node.kind === "folder") return EISDIR;
  if ((found.node.flags & DescriptorFlags.CanRemove) === 0) return EPERM;
  return undefined;
}

/** Unlink entry: gate, let the delete hooks accept, then drop the child. */
export function unlinkEntry(ctx: Ctx, path: string, cb: (err: number | null) => void): void {
  const found = resolveParent(ctx, path);
  const gate = unlinkGate(found);
  if (gate !== undefined) {
    cb(gate);
    return;
  }
  const target = found as { parent: DescriptorFolder; name: string; node: DescriptorFile };
  const veto =
    refused(() => target.parent.onChildDelete?.(target.name, target.node)) ??
    refused(() => target.node.onDelete?.());
  if (veto !== undefined) {
    cb(veto);
    return;
  }
  target.parent.remove(target.name);
  cb(0);
}

/**
 * The errno an rmdir at `path` must fail with, or undefined when the op
 * may proceed: the target must exist, be a folder (files leave via
 * unlink), be empty, and opt into removal (CanRemove).
 */
export function rmdirGate(
  found: { parent: DescriptorFolder; name: string; node: DescriptorChild } | undefined,
): number | undefined {
  if (found === undefined) return ENOENT;
  if (found.node.kind !== "folder") return ENOTDIR;
  if (found.node.children().size > 0) return ENOTEMPTY;
  if ((found.node.flags & DescriptorFlags.CanRemove) === 0) return EPERM;
  return undefined;
}

/** Rmdir entry: gate, let the delete hooks accept, then drop the folder. */
export function rmdirEntry(ctx: Ctx, path: string, cb: (err: number | null) => void): void {
  const found = resolveParent(ctx, path);
  const gate = rmdirGate(found);
  if (gate !== undefined) {
    cb(gate);
    return;
  }
  const target = found as { parent: DescriptorFolder; name: string; node: DescriptorFolder };
  const veto =
    refused(() => target.parent.onChildDelete?.(target.name, target.node)) ??
    refused(() => target.node.onDelete?.()) ??
    refused(() => target.parent.onWrite?.("replace", target.name));
  if (veto !== undefined) {
    cb(veto);
    return;
  }
  target.parent.remove(target.name);
  cb(0);
}
