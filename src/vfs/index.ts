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
 *
 * This is the barrel module; the pieces live in:
 *   - `./constants.ts` — errno/mode/owner constants, DescriptorFlags, WriteMode
 *   - `./node.ts`      — DescriptorNode/DescriptorFile/DescriptorFolder/DescriptorChild
 *   - `./registry.ts`  — DescriptorRegistry (the FUSE ops adapter)
 */
export * from "./constants.ts";
export * from "./node.ts";
export * from "./registry.ts";
