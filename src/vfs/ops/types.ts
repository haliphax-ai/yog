/**
 * Shared plumbing for the per-op FUSE modules: the state contract the ops
 * receive from the registry, the buffered-write record, and the positional
 * wires fuse-native fixes for READ/WRITE (the op set is an interface we do
 * not control — the kernel adapter fixes the argument order — so the ops
 * accept them as rest tuples and destructure the named pieces; `path` stays
 * elided — resolution goes through fds, not paths).
 */
import type { FuseOps } from "fuse-native";
import { type WriteMode } from "../constants.ts";
import { DescriptorFolder, type DescriptorFile } from "../node.ts";

export type { WriteMode };

/** A write-buffered open file handle. */
export interface OpenFile {
  file: DescriptorFile;
  mode: WriteMode;
  truncPending: boolean;
  chunks: Buffer[];
  /** How many chunks have already been committed (flush/release). */
  committedChunks: number;
}

/**
 * The state an op module may touch. Everything else (hooks, tree mutation)
 * stays behind descriptor/node methods so the ops never reach into registry
 * internals beyond this contract.
 */
export interface Ctx {
  root: DescriptorFolder;
  open: Map<number, OpenFile>;
  allocFd(): number;
  markTruncate(): void;
  takeTruncate(): boolean;
}

/**
 * fuse-native's positional READ/WRITE wires.
 */
export type ReadWire = Parameters<NonNullable<FuseOps["read"]>>;
export type WriteWire = Parameters<NonNullable<FuseOps["write"]>>;
