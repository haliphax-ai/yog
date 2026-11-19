/**
 * Ops barrel — the internal FUSE-op modules, composed by `registry.ts`.
 *
 * These modules stay internal to the VFS domain (depcruise
 * `domain-entry-only:vfs`): the registry consumes them through this barrel
 * so `index.ts` remains the domain's only public door and the op set
 * (io/dirs/rename) can evolve without touching importers.
 */
export * from "./types.ts";
export * from "./rename.ts";
export {
  listingFor,
  mkdirGate,
  mkdirEntry,
  rmdirEntry,
  rmdirGate,
  statFor,
  unlinkEntry,
  unlinkGate,
} from "./dirs.ts";
export {
  bufferWrite,
  commitOpen,
  createEntry,
  openEntry,
  openHandle,
  openModeFor,
  readBytes,
  truncateEntry,
  truncateGate,
} from "./io.ts";
