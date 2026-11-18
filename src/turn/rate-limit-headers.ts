/**
 * Header lookup over a provider error record, whichever carrier shape the
 * error uses: an SDK-shaped `get()` map (`Headers`), or a plain header
 * record — directly on the error or on its `response`.
 */

/** A case-insensitive header lookup over a provider error record. */
export type HeaderGetter = (name: string) => string | undefined;

/** The `get`-method headers carrier (what `Headers` shapes look like). */
function getterFromHeaders(h: unknown): HeaderGetter | undefined {
  if (h === null || typeof h !== "object") return undefined;
  if (typeof (h as { get?: unknown }).get !== "function") return undefined;
  const get = (h as { get: (n: string) => unknown }).get.bind(h);
  return (name) => {
    const v = get(name);
    return typeof v === "string" ? v : v === null || v === undefined ? undefined : String(v);
  };
}

/** Lowercase a plain-object header map (first value wins, strings only). */
function lowerCaseHeaders(h: unknown): Record<string, string> | undefined {
  if (h === null || typeof h !== "object" || Array.isArray(h)) return undefined;
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
    const val = Array.isArray(v) ? v[0] : v;
    if (typeof val === "string") lower[k.toLowerCase()] = val;
    else if (typeof val === "number") lower[k.toLowerCase()] = String(val);
  }
  return Object.keys(lower).length > 0 ? lower : undefined;
}

/** A `HeaderGetter` over an already-lowercased map. */
function fromLowered(lower: Record<string, string> | undefined): HeaderGetter | undefined {
  return lower ? (name) => lower[name.toLowerCase()] : undefined;
}

/**
 * The provider error's headers, whichever carrier shape it uses (see the
 * module docstring). Undefined when none is present.
 */
export function headerGetterFrom(err: unknown): HeaderGetter | undefined {
  if (err === null || typeof err !== "object") return undefined;
  const rec = err as Record<string, unknown>;
  const candidates: unknown[] = [
    rec.headers,
    (rec.response as Record<string, unknown> | undefined)?.headers,
  ];
  for (const h of candidates) {
    const getter = getterFromHeaders(h) ?? fromLowered(lowerCaseHeaders(h));
    if (getter) return getter;
  }
  return undefined;
}
