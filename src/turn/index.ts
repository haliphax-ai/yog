/**
 * Turn domain barrel — the single public door for the turn engine.
 *
 * The engine lives in `./engine.ts`; this barrel re-exports its public
 * surface (plus the companion seams the abort endpoint and tests consume)
 * so existing imports (`../turn.ts`, now `../turn/index.ts`) keep working.
 */
export { TurnEngine } from "./engine.ts";
export type { TurnOptions } from "./engine-types.ts";
export { activeToolCallFor, clearActiveToolCall } from "./active-tool-calls.ts";
export {
  assistantToolCallMessage,
  toolStubMessage,
  unansweredToolCallIds,
  type AssistantToolCall,
} from "./messages.ts";
export {
  DEFAULT_RATE_LIMIT_POLICY,
  isRateLimitError,
  rateLimitDelayMs,
  rateLimitHints,
  resolveRateLimitPolicy,
  type RateLimitPolicy,
} from "./rate-limit.ts";
export { parseRateLimitResetMs } from "./rate-limit-parse.ts";
export {
  TURN_EVENT_VERSION,
  type TurnEvent,
  type TurnEventDataMap,
  type TurnEventType,
  type TurnSink,
  type TurnUsage,
  StdoutSink,
  RecordingSink,
} from "./sink.ts";
