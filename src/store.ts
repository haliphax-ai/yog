/**
 * In-memory list backing the virtual `sys/tool` file.
 *
 * The file content is the list rendered one item per line. Writes are
 * interpreted as either an append (add items) or a destructive rewrite
 * (replace the whole list), decided by the open flags at open time.
 */
export class ListStore {
  #items: string[] = []

  /** Render the list: one item per line, trailing newline when non-empty. */
  render(): string {
    return this.#items.length > 0 ? this.#items.join('\n') + '\n' : ''
  }

  get size(): number {
    return Buffer.byteLength(this.render())
  }

  get items(): readonly string[] {
    return this.#items
  }

  /** Append-mode commit: add each written line as a new item. */
  append(text: string): void {
    for (const item of splitItems(text)) this.#items.push(item)
  }

  /** Destructive commit: the written text becomes the entire list. */
  replace(text: string): void {
    this.#items = splitItems(text)
  }
}

/** Split written text into list items, ignoring NUL padding and the trailing newline. */
function splitItems(text: string): string[] {
  const cleaned = text.replace(/\0/g, '')
  const lines = cleaned.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}