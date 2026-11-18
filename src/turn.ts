/**
 * Turn engine module door.
 *
 * The engine lives in `turn/engine.ts`; this module re-exports its public
 * surface (plus the companion seams the abort endpoint and tests consume)
 * so existing imports (`../turn.ts`) keep working.
 */

export { TurnEngine } from "./turn/engine.ts";
export type { TurnOptions } from "./turn/engine-types.ts";
export { activeToolCallFor, clearActiveToolCall } from "./turn/active-tool-calls.ts";
export {
  assistantToolCallMessage,
  toolStubMessage,
  unansweredToolCallIds,
  type AssistantToolCall,
} from "./turn/messages.ts";
export {
  DEFAULT_RATE_LIMIT_POLICY,
  isRateLimitError,
  rateLimitDelayMs,
  rateLimitHints,
  resolveRateLimitPolicy,
  type RateLimitPolicy,
} from "./turn/rate-limit.ts";
export { parseRateLimitResetMs } from "./turn/rate-limit-parse.ts";
