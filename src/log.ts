import { pino } from "pino";

/** Server/shared structured logger — JSON to stdout. */
export const logger = pino();

/** Client structured logger — JSON to stderr so stdout stays clean for assistant text. */
export const clientLogger = pino({}, process.stderr);

/**
 * Client logger bound to an explicit writable stream (default: stderr).
 * Factory so the client can log into an injected stream (e.g. tests).
 */
export function createClientLogger(stream: NodeJS.WritableStream) {
  return pino({}, stream);
}
