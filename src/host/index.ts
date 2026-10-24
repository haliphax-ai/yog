/**
 * Host proxy — the single sanctioned gateway through which descriptors and
 * tools reach the host filesystem.
 *
 * Nothing under `src/tools/` or `src/fs/` may import `node:fs` /
 * `node:fs/promises` directly (enforced by dependency-cruiser); they are
 * expected to use this module instead. Centralizing host FS access here is
 * what makes it possible to add policy uniformly later — access logging,
 * path allow-listing, size caps, sandboxing — without touching every
 * descriptor or tool.
 *
 * The surface is intentionally bounded to what harness code has needed so
 * far; extend it here (not by importing node:fs in a descriptor/tool).
 */
import * as fsp from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";

/** Copy a file, failing if the destination exists (mirrors `cp -n`). */
export function copyFile(src: string, dest: string, flags = 0): Promise<void> {
  return fsp.copyFile(src, dest, flags);
}

/** Move/rename a path (file or directory) on the host. */
export function rename(oldPath: string, newPath: string): Promise<void> {
  return fsp.rename(oldPath, newPath);
}

/** Remove a file or (recursively) a directory tree. */
export function rm(path: string, opts: { recursive?: boolean; force?: boolean } = {}): Promise<void> {
  return fsp.rm(path, opts);
}

/** Create a directory (parents included by default). */
export function mkdir(path: string, opts: { recursive?: boolean; mode?: number } = {}): Promise<string | undefined> {
  return fsp.mkdir(path, opts);
}

/** Read a directory, returning entry names (no "." / ".."). */
export function readdir(path: string): Promise<string[]> {
  return fsp.readdir(path);
}

/** Stat a path (throws ENOENT when it does not exist). */
export function stat(path: string): Promise<import("node:fs").Stats> {
  return fsp.stat(path);
}

/** Whether a path exists (does not throw). */
export async function exists(path: string): Promise<boolean> {
  try {
    await fsp.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Read a text file. */
export function readFile(path: string, encoding: BufferEncoding = "utf8"): Promise<string> {
  return fsp.readFile(path, encoding);
}

/** Write a text file (replaces existing content). */
export function writeFile(path: string, data: string): Promise<void> {
  return fsp.writeFile(path, data, "utf8");
}

/** Append text to a file (creates it when missing). */
export function appendFile(path: string, data: string): Promise<void> {
  return fsp.appendFile(path, data, "utf8");
}

/** Change a file's mode bits (e.g. `0o600`). */
export function chmod(path: string, mode: number): Promise<void> {
  return fsp.chmod(path, mode);
}

/** Re-export fs constants so callers need not import node:fs for flags. */
export { fsConstants };

/**
 * Spawn a subprocess. This is the only sanctioned way descriptors and tools
 * may launch child processes; direct `node:child_process` imports elsewhere
 * are blocked by dependency-cruiser. It is a faithful passthrough to
 * `child_process.spawn`, so process plumbing (stdio, env, cwd, detached, …)
 * works exactly as with node's API.
 */
export function spawn(
  command: string,
  args?: readonly string[],
  options?: SpawnOptions,
): ChildProcess {
  // Never pass `undefined` as the positional args argument — no overload
  // accepts (command, undefined, options). Branch so each call matches a
  // two- or three-argument overload explicitly.
  if (args !== undefined) {
    return options === undefined
      ? nodeSpawn(command, [...args])
      : nodeSpawn(command, [...args], options);
  }
  return options === undefined ? nodeSpawn(command) : nodeSpawn(command, options);
}
