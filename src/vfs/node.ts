/**
 * The descriptor node model: `DescriptorNode` (shared surface), the leaf
 * `DescriptorFile` interface, the `DescriptorFolder` class, and the
 * `DescriptorChild` union. The mount path is NOT part of a node — it is
 * assigned by the registry/parent at registration time.
 */
import { DescriptorFlags, type DescriptorKind, DIR_MODE, type WriteMode } from "./constants.ts";

/**
 * The parent node type: every feature shared by all descriptors lives here so
 * it flows to both files and folders.
 */
export interface DescriptorNode {
  readonly kind: DescriptorKind;
  /** POSIX mode bits (include S_IFREG / S_IFDIR). */
  readonly mode: number;
  /** Capability bit flags. */
  readonly flags: DescriptorFlags;
  /** Current size in bytes (0 when unspecified). */
  readonly size?: number;
  /**
   * Optional housekeeping hook invoked when this node is renamed within the
   * mount. Return a negative errno to refuse the rename.
   */
  onRename?(): number | void;
  /**
   * Optional housekeeping hook invoked when this node's content is read.
   * Return a negative errno to refuse the read.
   */
  onRead?(): number | void;
  /**
   * Optional housekeeping hook invoked before content is committed (append or
   * replace). Return a negative errno to refuse the write.
   */
  onWrite?(kind: Exclude<WriteMode, "read">, text: string): number | void;
  /**
   * Optional housekeeping hook invoked before the node is truncated to empty.
   * Return a negative errno to refuse the truncation.
   */
  onTruncate?(): number | void;
  /**
   * Optional housekeeping hook invoked before this node is removed from its
   * parent. Return a negative errno to refuse the deletion.
   */
  onDelete?(): number | void;
  /**
   * Optional housekeeping hook invoked when this node is the target of a
   * rename-overwrite (a source node is renamed onto it). Files typically adopt
   * the source content; folders are replaced by the source folder. Return
   * 0/undefined to accept, or a negative errno to refuse.
   */
  onOverwrite?(source: DescriptorChild): number | void;
}

/**
 * A leaf descriptor: a virtual file. Implementations decide what the file
 * contains and how writes are applied; methods may be omitted when the
 * corresponding capability flag is not set.
 */
export interface DescriptorFile extends DescriptorNode {
  readonly kind: "file";
  /** Content served for reads (required when CanRead). */
  render?(): string;
  /**
   * Apply a committed mutation (required when CanWrite). `kind` is 'append'
   * for O_APPEND opens and 'replace' for destructive writes; `text` is the
   * fully buffered bytes.
   */
  commit?(kind: Exclude<WriteMode, "read">, text: string): void;
  /** Reset to empty content (required when CanWrite). */
  reset?(): void;
}

/**
 * A directory descriptor: dynamically manages its own children. Children are
 * files or folders; `DescriptorFolder` provides the storage + CRUD API, and
 * subclasses may override `children`/`get` for fully dynamic behavior.
 */
export class DescriptorFolder implements DescriptorNode {
  readonly kind = "folder" as const;
  readonly mode: number;
  readonly flags: DescriptorFlags;

  /** Generic node hooks — inherited from DescriptorNode, declared here so the class type carries them. */
  onRename?(): number | void;
  onRead?(): number | void;
  onWrite?(kind: Exclude<WriteMode, "read">, text: string): number | void;
  onTruncate?(): number | void;
  onDelete?(): number | void;
  onOverwrite?(source: DescriptorChild): number | void;

  /**
   * Optional housekeeping hook invoked when a child of this folder is renamed
   * (within or out of this folder). Return a negative errno to refuse.
   */
  onChildRename?(name: string, child: DescriptorChild): number | void;

  /**
   * Optional housekeeping hook invoked when a child is created in this folder.
   * Return a negative errno to refuse the creation.
   */
  onChildCreate?(name: string, child: DescriptorChild): number | void;

  /**
   * Optional housekeeping hook invoked when a child of this folder is deleted.
   * Return a negative errno to refuse the deletion.
   */
  onChildDelete?(name: string, child: DescriptorChild): number | void;

  #children = new Map<string, DescriptorChild>();

  constructor(opts: { mode?: number; flags?: DescriptorFlags } = {}) {
    this.mode = opts.mode ?? DIR_MODE;
    this.flags = opts.flags ?? DescriptorFlags.CanRead;
  }

  get size(): number {
    return 4096;
  }

  /** Snapshot of current children, keyed by name. */
  children(): ReadonlyMap<string, DescriptorChild> {
    return this.#children;
  }

  has(name: string): boolean {
    return this.#children.has(name);
  }

  get(name: string): DescriptorChild | undefined {
    return this.#children.get(name);
  }

  /** Add or replace a child node. */
  add(name: string, node: DescriptorChild): void {
    this.#children.set(name, node);
  }

  /** Remove a child; returns whether it was present. */
  remove(name: string): boolean {
    return this.#children.delete(name);
  }
}

/** Any concrete node: a file or a folder. */
export type DescriptorChild = DescriptorFile | DescriptorFolder;
