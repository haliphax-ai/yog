import type { TurnUsage } from "../../turn/sink.ts";

/** Turn columns that may carry usage counters. */
const USAGE_KEYS = ["prompt_tokens", "completion_tokens", "total_tokens"] as const;

/** Terminal event types whose payloads may embed a usage record. */
const USAGE_EVENT_TYPES = new Set(["turn.finished", "turn.aborted", "error"]);

/** `true` when `value` is a plain (non-null, non-array) object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Event payloads are stored double-encoded (addEvent receives the JSON
 * string of the event data and stringifies it again), so the parsed row
 * payload may itself be a JSON string — unwrap it. Unparseable or
 * non-object payloads yield an empty record.
 */
function unwrapEventPayload(payload: unknown): Record<string, unknown> {
  let obj: unknown = payload;
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj);
    } catch {
      return {};
    }
  }
  return isPlainObject(obj) ? obj : {};
}

/**
 * Pluck the finite numeric usage counters from a raw record, or `undefined`
 * when it carries none. Non-finite and non-numeric values are dropped so
 * partial records (and junk columns) still yield the counters they do have.
 */
function normalizeUsageRecord(record: unknown): TurnUsage | undefined {
  if (!isPlainObject(record)) return undefined;
  const usage: TurnUsage = {};
  let has = false;
  for (const key of USAGE_KEYS) {
    const n = record[key];
    if (typeof n === "number" && Number.isFinite(n)) {
      usage[key] = n;
      has = true;
    }
  }
  return has ? usage : undefined;
}

/**
 * Usage embedded in the stored terminal event payloads, keyed by turn id.
 *
 * Fallback source for per-turn metrics (pre-usage-column volumes and the
 * model-provider fallback path, which never settles turn rows). Only the
 * terminal event types are consulted; turns whose payloads carry no usage
 * record get no entry.
 */
export function eventUsageMap(
  events: ReadonlyArray<{ turn_id: number; type: string; payload: unknown }>,
): Map<number, TurnUsage> {
  const byTurn = new Map<number, TurnUsage>();
  for (const ev of events) {
    if (!USAGE_EVENT_TYPES.has(ev.type)) continue;
    const usage = normalizeUsageRecord(unwrapEventPayload(ev.payload).usage);
    if (usage !== undefined) byTurn.set(ev.turn_id, usage);
  }
  return byTurn;
}

/**
 * Per-turn metrics for one turn row: the persisted usage when known —
 * falling back to the stored terminal event usage for turns completed
 * before usage columns existed (recovery replay) — plus the settled
 * duration when the turn finished. Best-effort: turns with neither usage
 * nor duration are omitted, so old volumes simply show no per-turn metrics.
 */
export function turnUsageEntry(
  row: Record<string, unknown>,
  fallbackUsage: Map<number, TurnUsage>,
): { turnId: number; usage?: TurnUsage; durationMs?: number } | undefined {
  const entry: { turnId: number; usage?: TurnUsage; durationMs?: number } = {
    turnId: Number(row.id),
  };
  const usage = normalizeUsageRecord(row) ?? fallbackUsage.get(entry.turnId);
  if (usage !== undefined) entry.usage = usage;
  if (typeof row.duration_ms === "number") entry.durationMs = row.duration_ms;
  if (entry.usage === undefined && entry.durationMs === undefined) return undefined;
  return entry;
}
