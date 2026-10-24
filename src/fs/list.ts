import { type DescriptorFile, FILE_MODE } from "./index.ts";

/**
 * The list descriptor.
 *
 * The file content is the in-memory list rendered one item per line. Writes
 * are interpreted as either an append (add items) or a destructive rewrite
 * (replace the whole list), decided by the open flags at open time. Its mount
 * path is assigned by the registry at registration time (e.g. `/list`).
 */
export class ListDescriptor implements DescriptorFile {
  readonly mode = FILE_MODE;

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
      console.error({ action: "append", items: this.#items });
    } else {
      this.#items = splitItems(text);
      console.error({ action: "replace", items: this.#items });
    }
  }

  reset(): void {
    this.#items = [];
    console.error({ action: "truncate", items: this.#items });
  }
}

/** Split written text into list items, ignoring NUL padding and the trailing newline. */
function splitItems(text: string): string[] {
  const cleaned = text.replace(/\0/g, "");
  const lines = cleaned.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
