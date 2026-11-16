#!/usr/bin/env node
/**
 * pre-commit code-smell gate.
 *
 * Runs `qlty smells --no-snippets --quiet` (diffed against the configured
 * upstream) and captures its stdout. A non-blank report means qlty found
 * smells in the changed files: the report is re-printed and the commit is
 * rejected (exit 1). A blank report passes (exit 0). qlty's own exit code
 * is deliberately not propagated — a smell report is the failure condition,
 * not a nonzero exit from the scanner.
 *
 * `qlty` must be on the PATH (no absolute paths to operator-specific
 * installs); a missing binary or a spawn failure exits 1 with the error on
 * stderr so a silent pass is never possible.
 */
import { spawn } from "node:child_process";

// Optional argv: `qlty-smells.mts --all` smoke-tests the whole codebase
// instead of the changed files (the repo carries pre-existing smells); it
// is never wired into pre-commit itself. Without it, qlty picks its own
// default upstream.
const all = process.argv.includes("--all");
const args = ["smells", "--no-snippets", "--quiet"];
if (all) args.push("--all");

const child = spawn("qlty", args, { stdio: ["ignore", "pipe", "inherit"] });

let report = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk: string) => {
  report += chunk;
});

child.on("error", (err) => {
  console.error(`qlty-smells: could not run qlty: ${err.message}`);
  process.exit(1);
});

child.on("close", (code) => {
  if (code !== 0) {
    console.error(`qlty-smells: qlty exited ${code} before reporting`);
    process.exit(1);
  }
  if (report.trim() !== "") {
    process.stdout.write(report);
    console.error(`qlty-smells: ${report.trim().split("\n").length} smell lines in changed files`);
    process.exit(1);
  }
  process.exit(0);
});
