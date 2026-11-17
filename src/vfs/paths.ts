/**
 * Path resolution over the descriptor tree, shared by the registry and the
 * per-op FUSE modules.
 */
import { DescriptorFolder, type DescriptorChild } from "./node.ts";

/** Normalize a mount path to a canonical leading-slash form. */
export function normalizePath(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return p.replace(/\/+$/, "") || "/";
}

/**
 * The node at `path`, or undefined: the walk requires every intermediate
 * segment to be an existing folder.
 */
export function resolve(
  ctx: { root: DescriptorFolder },
  path: string,
): DescriptorChild | undefined {
  let node: DescriptorChild | undefined = ctx.root;
  for (const segment of normalizePath(path).split("/").filter(Boolean)) {
    if (node === undefined || node.kind !== "folder") return undefined;
    node = node.get(segment);
  }
  return node;
}

/**
 * The parent folder + final segment of `path` (the child may not exist).
 */
export function resolveSlot(
  ctx: { root: DescriptorFolder },
  path: string,
): { parent: DescriptorFolder; name: string } | undefined {
  const segments = normalizePath(path).split("/").filter(Boolean);
  if (segments.length === 0) return undefined;
  let parent: DescriptorFolder = ctx.root;
  for (let i = 0; i < segments.length - 1; i++) {
    const intermediate = parent.get(segments[i] as string);
    if (intermediate === undefined || intermediate.kind !== "folder") return undefined;
    parent = intermediate;
  }
  return { parent, name: segments[segments.length - 1] as string };
}

/**
 * The parent folder + segment + child at `path` (the child must exist).
 */
export function resolveParent(
  ctx: { root: DescriptorFolder },
  path: string,
): { parent: DescriptorFolder; name: string; node: DescriptorChild } | undefined {
  const slot = resolveSlot(ctx, path);
  if (slot === undefined) return undefined;
  const node = slot.parent.get(slot.name);
  if (node === undefined) return undefined;
  return { parent: slot.parent, name: slot.name, node };
}
