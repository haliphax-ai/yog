/**
 * Constants shared by the descriptor layer: errno values, mode/owner bits,
 * capability flags, and the open-mode classification. Pure data with no
 * imports, so any module can pull these without dragging in the registry.
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
export const ENOTEMPTY = -39;

/**
 * Mount root mode. 0755: the kernel does not pre-empt mutations, so the
 * descriptor registry is the sole guard for every mutating op (create,
 * unlink, rename, …) — behavior emerges from registered descriptors.
 */
export const DIR_MODE = 0o40755;
/** Base mode for regular-file descriptors (owner read/write, world read). */
export const FILE_MODE = 0o100644;

/**
 * The agent user the descriptors are served as. The daemon learns the agent's
 * uid/gid at spawn; when it runs unprivileged (e.g. the agent user itself)
 * this falls back to the current process ids. Descriptors may declare their
 * own uid/gid; the registry defaults to these.
 */
export const AGENT_UID = Number(process.env["YOG_AGENT_UID"] ?? process.getuid?.() ?? 0);
export const AGENT_GID = Number(process.env["YOG_AGENT_GID"] ?? process.getgid?.() ?? 0);

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
