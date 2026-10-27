import { DescriptorFlags, EACCES, EISDIR, FILE_MODE } from "../constants.ts";
import { type DescriptorChild, type DescriptorFile } from "../node.ts";
import { logger } from "../../log.ts";

/**
 * The list descriptor.
 *
 * The file content is the in-memory list rendered one item per line. Writes
 * are interpreted as either an append (add items) or a destructive rewrite
 * (replace the whole list), decided by the open flags at open time. Its mount
 * path is assigned by the registry at registration time (e.g. `/list`).
 */
export class ListDescriptor implements DescriptorFile {
  readonly kind = "file" as const;
  readonly mode = FILE_MODE;
  readonly flags = DescriptorFlags.CanRead | DescriptorFlags.CanWrite;

  #items: string[] = [];

  render(): string {
    return this.#items.length > 0 ? this.#items.join("\n") + "\n" : "";
  }

  get size(): number {
    return Buffer.byteLength(this.render());
  }

  get items(): readonly string[] {
    return this.#items;
  }

  commit(kind: "append" | "replace", text: string): void {
    if (kind === "append") {
      for (const item of splitItems(text)) this.#items.push(item);
      logger.error({ action: "append", items: this.#items });
    } else {
      this.#items = splitItems(text);
      logger.error({ action: "replace", items: this.#items });
    }
  }

  reset(): void {
    this.#items = [];
    logger.error({ action: "truncate", items: this.#items });
  }

  /** Accept rename-overwrite: replace the list contents with the source file's content. */
  onOverwrite(source: DescriptorChild): number {
    if (source.kind !== "file") {
      return EISDIR;
    }
    if ((source.flags & DescriptorFlags.CanRead) === 0 || !source.render) {
      return EACCES;
    }
    this.commit("replace", source.render());
    return 0;
  }
}

/** Split written text into list items, ignoring NUL padding and the trailing newline. */
function splitItems(text: string): string[] {
  const cleaned = text.replace(/\0/g, "");
  const lines = cleaned.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
