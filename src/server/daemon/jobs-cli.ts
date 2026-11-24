/**
 * The `jobs` command for the agent-CLI registry (the `/bin/yog` shim's
 * `/v1/agent-cli` endpoint).
 *
 * The registry lives in the server domain; the command's behavior comes
 * from the background-jobs domain's read surfaces (`allJobs`, `job`). The
 * agent-CLI has no session context (same as `yog skills`), so the list is
 * daemon-wide; detail goes to one job's row, result included.
 */
import type { BackgroundJob, JobManager } from "../jobs/index.ts";
import { registerCommand, type CliCommand } from "../cli.ts";

/** The state stamp on a list/detail row (state + why, terminated only). */
function stateCell(job: BackgroundJob): string {
  if (job.state === "terminated") {
    return `terminated(${job.termReason ?? "terminated"})`;
  }
  return job.state;
}

/** The wall-clock seconds a job has been alive (start → settle or now). */
function seconds(job: BackgroundJob, now: () => number): string {
  const end = job.state === "running" ? now() : (job.endedAt ?? job.startedAt);
  return `${Math.max(0, Math.round((end - job.startedAt) / 1000))}s`;
}

/** One `jobs` list row: id, session, tool, state, runtime, pid. */
function listRow(job: BackgroundJob, now: () => number): string {
  return [
    job.id,
    job.sessionId,
    job.tool,
    stateCell(job),
    seconds(job, now),
    job.pid !== undefined ? String(job.pid) : "-",
  ].join(" ");
}

/**
 * The command the agent-CLI registry serves for the background-jobs
 * subsystem. `now` is injectable for tests (defaults to the wall clock).
 */
export function jobsCliCommand(
  manager: Pick<JobManager, "allJobs" | "job">,
  now: () => number = Date.now,
): CliCommand {
  return {
    name: "jobs",
    description: "List background jobs, or show one job's detail (list|[id])",
    usage: "jobs [jobId]",
    async execute(args) {
      const [id] = args;
      if (id === undefined || id === "list") {
        const rows = manager.allJobs().map((job) => listRow(job, now));
        return rows.length > 0 ? `${rows.join("\n")}\n` : "(none)\n";
      }
      const job = manager.job(id);
      if (job === undefined) return `unknown job: ${id}\n`;
      return `${jobBlock(job, now)}\n`;
    },
  };
}

/** One job's detail block (the row fields plus the settled result). */
function jobBlock(job: BackgroundJob, now: () => number): string {
  const lines: string[] = [
    `job ${job.id}`,
    `session: ${job.sessionId}`,
    `tool: ${job.tool}`,
    `args: ${job.argsJson ?? "(none)"}`,
    `state: ${stateCell(job)}`,
    `${seconds(job, now)}`,
  ];
  if (job.pid !== undefined) lines.push(`pid: ${job.pid}`);
  if (job.state !== "running" && job.result !== undefined) {
    try {
      lines.push(`result: ${JSON.stringify(job.result)}`);
    } catch {
      lines.push("result: (unserializable)");
    }
  }
  return lines.join("\n");
}

/** Register the `jobs` command with the agent-CLI registry. */
export function registerJobsCliCommand(
  manager: Pick<JobManager, "allJobs" | "job">,
  now: () => number = Date.now,
): void {
  registerCommand(jobsCliCommand(manager, now));
}
