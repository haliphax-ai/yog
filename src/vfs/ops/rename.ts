/**
 * The rename family of FUSE ops, driven through descriptor capability flags
 * and hooks. Every helper returns the errno the op must fail with, or
 * undefined when the move may land; the tree only changes after all vetoes
 * clear.
 */
import { DescriptorFlags, EACCES, EISDIR, EINVAL, ENOENT, ENOTEMPTY, EPERM } from "../constants.ts";
import { DescriptorFolder, type DescriptorChild, type DescriptorFile } from "../node.ts";
import { normalizePath, resolve, resolveParent, resolveSlot } from "../paths.ts";
import type { Ctx } from "./types.ts";

/**
 * Run `hook` when it exists and treat a negative errno as a refusal: the
 * errno comes back so the caller can fail the op; undefined means the hook
 * is absent or it accepted (`>= 0` rc).
 */
export function refused(hook: (() => number | void) | undefined): number | undefined {
  const rc = hook?.();
  return rc !== undefined && rc < 0 ? rc : undefined;
}

/**
 * Rename-overwrite onto an existing file descriptor: the target's own
 * `onOverwrite` decides; without one, the registry requires CanOverwrite
 * on the target plus a renderable, committed source. `leave` runs the
 * source folder's onChildRename after the content lands. Returns the
 * errno to fail with, or undefined when the overwrite committed.
 */
export function renameOverwriteFile(
  source: DescriptorChild,
  target: DescriptorFile,
  leave: () => number | void,
): number | undefined {
  if (source.kind !== "file") return EISDIR;
  if (target.onOverwrite !== undefined) {
    return refused(() => target.onOverwrite?.(source)) ?? refused(leave);
  }
  if (
    (target.flags & DescriptorFlags.CanOverwrite) === 0 ||
    (source.flags & DescriptorFlags.CanRead) === 0 ||
    source.render === undefined ||
    target.commit === undefined
  ) {
    return (target.flags & DescriptorFlags.CanOverwrite) === 0 ? EPERM : EACCES;
  }
  target.commit("replace", source.render());
  return refused(leave);
}

/**
 * Folder overwrite: the destination folder is replaced by the source. A
 * custom `onOverwrite` decides for itself; flag-based replacement requires
 * the destination to be empty. Veto order: CanRename gate, overwrite
 * consent, destination removal hooks (child then self), source onRename,
 * leave, destination-slot rename hook — then the swap lands.
 */
export function replaceFolder(
  source: DescriptorFolder,
  dest: DescriptorFolder,
  destSlot: { parent: DescriptorFolder; name: string },
  leave: () => number | void,
): number | undefined {
  if ((source.flags & DescriptorFlags.CanRename) === 0) return EPERM;
  if (dest.onOverwrite !== undefined) {
    const veto = refused(() => dest.onOverwrite?.(source));
    if (veto !== undefined) return veto;
  } else if (dest.children().size > 0) {
    return ENOTEMPTY;
  }
  const veto =
    refused(() => destSlot.parent.onChildDelete?.(destSlot.name, dest)) ??
    refused(() => dest.onDelete?.()) ??
    refused(() => source.onRename?.()) ??
    refused(leave) ??
    refused(() => destSlot.parent.onChildRename?.(destSlot.name, source));
  if (veto !== undefined) return veto;
  destSlot.parent.remove(destSlot.name);
  destSlot.parent.add(destSlot.name, source);
  return undefined;
}

/**
 * Whether `descendantPath` sits at or below `ancestorPath` in the node tree
 * (keeps folder renames from nesting a folder inside itself).
 */
export function isInside(ancestorPath: string, descendantPath: string): boolean {
  const a = normalizePath(ancestorPath).split("/").filter(Boolean);
  const d = normalizePath(descendantPath).split("/").filter(Boolean);
  if (a.length === 0) return true;
  if (d.length < a.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== d[i]) return false;
  }
  return true;
}

/**
 * Pure repositioning into an empty destination slot: refuse self-nesting
 * folder moves and nodes without CanRename; the destination parent must be
 * restructurable. The hooks (onRename, leave, onChildRename) run in order
 * so a veto aborts before the tree mutates.
 */
export function renameReposition(
  ctx: Ctx,
  source: DescriptorChild,
  srcNorm: string,
  destSlot: { parent: DescriptorFolder; name: string },
  leave: () => number | void,
): number | undefined {
  if (source.kind === "folder" && isInside(srcNorm, `/${destSlot.name}`)) return EINVAL;
  if ((source.flags & DescriptorFlags.CanRename) === 0) return EPERM;
  if (destSlot.parent !== ctx.root && (destSlot.parent.flags & DescriptorFlags.CanWrite) === 0) {
    return EACCES;
  }
  const veto =
    refused(() => source.onRename?.()) ??
    refused(leave) ??
    refused(() => destSlot.parent.onChildRename?.(destSlot.name, source));
  if (veto !== undefined) return veto;
  destSlot.parent.add(destSlot.name, source);
  return undefined;
}

/**
 * A child (file or folder) landing in a folder descriptor without
 * replacing it: CanRename gate, the folder must allow restructure
 * (CanWrite, or be the root), then onRename -> leave -> onChildRename so a
 * veto aborts before anything moves, and finally the tree swap.
 */
export function moveIntoFolder(move: {
  ctx: Ctx;
  source: DescriptorChild;
  name: string;
  dest: DescriptorFolder;
  leave: () => number | void;
  srcParent: DescriptorFolder;
}): number | undefined {
  const { ctx, source, name, dest, leave, srcParent } = move;
  if ((source.flags & DescriptorFlags.CanRename) === 0) return EPERM;
  if (dest !== ctx.root && (dest.flags & DescriptorFlags.CanWrite) === 0) return EACCES;
  const veto =
    refused(() => source.onRename?.()) ??
    refused(leave) ??
    refused(() => dest.onChildRename?.(name, source));
  if (veto !== undefined) return veto;
  dest.add(name, source);
  srcParent.remove(name);
  return undefined;
}

/**
 * Folder source landing in a folder descriptor: refuse self-nesting, then
 * either replace the destination (it opts into overwrite) or move into it.
 */
export function renameFolderOntoFolder(move: {
  ctx: Ctx;
  source: DescriptorFolder;
  srcNorm: string;
  srcName: string;
  dest: DescriptorFolder;
  destNorm: string;
  leave: () => number | void;
  srcParent: DescriptorFolder;
}): number | undefined {
  const { ctx, source, srcNorm, srcName, dest, destNorm, leave, srcParent } = move;
  if (isInside(srcNorm, destNorm)) return EINVAL;
  const wantsReplace =
    dest.onOverwrite !== undefined || (dest.flags & DescriptorFlags.CanOverwrite) !== 0;
  if (wantsReplace) {
    const destSlot = resolveSlot(ctx, destNorm);
    if (destSlot === undefined) return ENOENT;
    return replaceFolder(source, dest, destSlot, leave);
  }
  return moveIntoFolder({
    ctx,
    source,
    name: srcName,
    dest,
    leave,
    srcParent,
  });
}

/**
 * Route one rename to its case: overwrite a file descriptor, land in a
 * folder descriptor (replace or absorb), or reposition into an empty slot.
 * Each case helper performs its own tree mutation on success.
 */
export function renameDispatch(move: {
  ctx: Ctx;
  source: DescriptorChild;
  srcNorm: string;
  srcName: string;
  srcParent: DescriptorFolder;
  destNode: DescriptorChild | undefined;
  destSlot: { parent: DescriptorFolder; name: string };
  destNorm: string;
  leave: () => number | void;
}): number | undefined {
  const { ctx, source, srcNorm, srcName, srcParent, destNode, destSlot, destNorm, leave } = move;
  if (destNode?.kind === "file") return renameOverwriteFile(source, destNode, leave);
  if (destNode?.kind === "folder") {
    return source.kind === "folder"
      ? renameFolderOntoFolder({
          ctx,
          source,
          srcNorm,
          srcName,
          dest: destNode,
          destNorm,
          leave,
          srcParent,
        })
      : moveIntoFolder({
          ctx,
          source,
          name: srcName,
          dest: destNode,
          leave,
          srcParent,
        });
  }
  return renameReposition(ctx, source, srcNorm, destSlot, leave);
}

/**
 * Rename entry: resolve both ends, no-op same-path renames, then hand the
 * case dispatch its move record; a clean dispatch drops the source from
 * its parent (each case helper has already placed the node).
 */
export function renameEntry(
  ctx: Ctx,
  srcNorm: string,
  destNorm: string,
  cb: (err: number | null) => void,
): void {
  const srcFound = resolveParent(ctx, srcNorm);
  if (srcFound === undefined) {
    cb(ENOENT);
    return;
  }
  const destSlot = resolveSlot(ctx, destNorm);
  if (destSlot === undefined) {
    cb(ENOENT);
    return;
  }
  const { parent: srcParent, name: srcName, node } = srcFound;
  // Renaming a node onto itself is a no-op.
  if (srcNorm === destNorm) {
    cb(0);
    return;
  }
  // The source folder is notified before it loses the child.
  const leave = (): number | void => srcParent.onChildRename?.(srcName, node);
  const veto = renameDispatch({
    ctx,
    source: node,
    srcNorm,
    srcName,
    srcParent,
    destNode: resolve(ctx, destNorm),
    destSlot,
    destNorm,
    leave,
  });
  if (veto !== undefined) {
    cb(veto);
    return;
  }
  srcParent.remove(srcName);
  cb(0);
}
