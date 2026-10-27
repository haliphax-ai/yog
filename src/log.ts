import { pino } from "pino";

/** Server/shared structured logger — JSON to stdout. */
export const logger = pino();

/** Client structured logger — JSON to stderr so stdout stays clean for assistant text. */
export const clientLogger = pino({}, process.stderr);
