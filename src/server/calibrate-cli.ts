/**
 * CLI wiring for `yog calibrate <sessionId>`:
 * resolve config paths, open the sessions store, extract cold-round
 * samples, fit, gate, and write `profiles/<slug>.json`. Lives in the
 * server domain because it composes the store + config like the daemon
 * does; the pure fit lives in src/calibrate.ts (pinned by tests).
 */
import { resolveConfig } from "../config.ts";
import { overlaySlug } from "../toolkit/index.ts";
import {
  calibrateFromSamples,
  extractCalibrationSamples,
  type CalibrateOutcome,
} from "../calibrate.ts";
import { SessionStore, openSessionsDb } from "./store/sessions.ts";
import { logger } from "../log.ts";
import { join } from "node:path";

/** Run the calibrate subcommand. Returns process exit code. */
export async function runCalibrate(args: readonly string[]): Promise<number> {
  const usage = "usage: yog calibrate <sessionId> [--config <path>]";
  const positional: string[] = [];
  let configPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--config") configPath = args[++i];
    else if (arg.startsWith("--config=")) configPath = arg.slice("--config=".length);
    else if (arg.startsWith("--")) {
      logger.error(`unknown option "${arg}"\n${usage}`);
      return 2;
    } else positional.push(arg);
  }
  const sessionId = positional[0];
  if (sessionId === undefined || positional.length !== 1) {
    logger.error(usage);
    return 2;
  }
  const config = await resolveConfig({ ...(configPath !== undefined ? { configPath } : {}) });
  const model = config.model;
  const db = await openSessionsDb(join(config.stateRoot, "sessions.db"));
  const store = new SessionStore(db);
  let outcome: CalibrateOutcome;
  try {
    const [rows, events] = await Promise.all([
      store.getTranscript(sessionId),
      store.listEvents(sessionId),
    ]);
    const samples = extractCalibrationSamples(rows, events);
    const { mkdir, writeFile } = await import("../host.ts");
    const profilesDir = join(config.stateRoot, "profiles");
    outcome = await calibrateFromSamples(model, samples, {
      slugFor: overlaySlug,
      writeOverlay: async (slug, json) => {
        await mkdir(profilesDir, { recursive: true });
        const path = join(profilesDir, `${slug}.json`);
        await writeFile(path, json);
        return path;
      },
    });
  } finally {
    await db.destroy();
  }
  if (outcome.written) {
    logger.info(
      `[calibrate] ${sessionId} (${model}): profile ${outcome.path} — ` +
        `rate ${(1 / outcome.fit.rate).toFixed(2)} c/t (tokenx defaultCharsPerToken), ` +
        `MAPE ${(outcome.fit.mape * 100).toFixed(1)}%, ${outcome.fit.samples} cold samples, ` +
        `intercept ~${outcome.fit.interceptTokens} tok`,
    );
    return 0;
  }
  logger.warn(
    `[calibrate] ${sessionId} (${model}): refused — ${outcome.reason} ` +
      `(${outcome.qualified}/${outcome.needed} cold samples). Run more cold rounds ` +
      `(new sessions/turns, cache-cold) or lower --min-samples.`,
  );
  return 1;
}
