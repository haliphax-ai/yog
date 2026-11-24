/**
 * Wake-turn prompt builder (yog#91): one shared prompt per wake turn, one
 * block per finished-unclaimed job. Per-job truncation reuses the toolkit's
 * `fairTruncate` against the tool-output budget, so a huge detached build
 * log cannot nuke the context at delivery time (the retained result was
 * already capped at detach; this is the prompt-side guard).
 */
import { fairTruncate } from "../../toolkit/index.ts";
import type { BackgroundJob } from "./types.ts";

/** Serialize any JSON-ish value compactly (never throws — circulars degrade). */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return String(value);
  }
}

/** The truncated `{stdout, stderr}` pair for one job (serialized budget). */
function truncatePair(job: BackgroundJob, budget: number): { stdout: string; stderr: string } {
  const out = typeof job.result?.stdout === "string" ? job.result.stdout : "";
  const err = typeof job.result?.stderr === "string" ? job.result.stderr : "";
  const [stdout, stderr] = fairTruncate(out, err, budget);
  return { stdout, stderr };
}

/** One job's delivery block (the per-job half of the shared prompt). */
export function jobBlock(job: BackgroundJob, budget: number): string {
  const elapsed = ((job.endedAt ?? 0) - job.startedAt).toString();
  const lines: string[] = [
    `job ${job.id}`,
    `session: ${job.sessionId}`,
    `tool: ${job.tool}`,
    `args: ${safeJson(job.argsJson)}`,
    `elapsed: ${elapsed}ms`,
  ];
  if (job.state === "terminated") {
    lines.push(`termination: ${job.termReason ?? "terminated"}`);
  }
  if (job.pid !== undefined) lines.push(`pid: ${job.pid}`);
  if (job.state === "finished") {
    const { stdout, stderr } = truncatePair(job, budget);
    lines.push(`exitCode: ${String(job.result?.exitCode ?? "null")}`);
    if (stdout !== "") lines.push(`stdout: ${stdout}`);
    if (stderr !== "") lines.push(`stderr: ${stderr}`);
    const rest = { ...job.result };
    delete (rest as Record<string, unknown>).stdout;
    delete (rest as Record<string, unknown>).stderr;
    delete (rest as Record<string, unknown>).error;
    const extra = safeJson(rest);
    if (extra !== "{}") lines.push(`result: ${extra}`);
  }
  if (typeof job.result?.error === "string") lines.push(`error: ${job.result.error}`);
  return lines.join("\n");
}

/**
 * The shared wake prompt: one header, one block per job. Returns undefined
 * when there is nothing to deliver (never arm a wake for an empty batch).
 */
export function buildWakePrompt(
  jobs: readonly BackgroundJob[],
  budget: number,
): string | undefined {
  if (jobs.length === 0) return undefined;
  const header = `[background jobs] ${jobs.length} finished: results are attached below. Use them to continue your work; do not re-run the tools.`;
  return [header, ...jobs.map((job) => jobBlock(job, budget))].join("\n\n");
}
