/**
 * Dependency-cruiser rules for yog.
 *
 * Enforced architecture (layers, top → bottom):
 *
 *   src/index.ts      CLI entry — composition root; may import anything under src/
 *   src/register.ts   wiring manifest — composes tools + fs domains only
 *   src/turn.ts       orchestration — knows the ToolRegistry, never the VFS/entry
 *   src/turn/sink.ts  transport-agnostic TurnEvent envelope + sink impls
 *   src/mount.ts      pure FUSE bridge — no internal dependencies
 *   src/host.ts      host proxy — the ONLY module allowed to touch node:fs
 *                     and node:child_process
 *   src/vfs/**        leaf domain: descriptors (may use host for out-of-VFS action)
 *   src/toolkit/**    leaf domain: harness tools (may use host for out-of-VFS action)
 *   src/worker/**     worker process + JSONL client (infra; uses host only)
 *   src/state/**      agentfs-backed home/state (the only agentfs-SDK importer)
 *
 * Encapsulation invariant: no module reaches into another domain's internals.
 * Every domain exposes a single public door — its `index.ts` barrel — and
 * modules outside a domain may only import that barrel (enforced by the
 * generated `domain-entry-only:*` rule family, see DOMAINS below).
 *
 *   test/**           may import any src/**, never the reverse
 *
 * Key invariant: descriptors and tools reach the host (filesystem AND
 * subprocess spawning) only through src/host.ts — direct node:fs /
 * node:child_process imports anywhere in src/ other than host are rule
 * violations.
 */
// Domains that each expose a single public door (`index.ts`). A module
// outside a domain may only import its barrel — never its internals.
// dependency-cruiser cannot compare the importer's directory with the target's
// in one generic regex (no backreferences), so the entry-only rule family is
// generated per domain from this list; adding a new domain here extends the
// same guarantee to it automatically.
const DOMAINS = ["vfs", "toolkit", "worker", "state", "server"];

module.exports = {
  options: {
    exclude: { path: "(node_modules|\\.git|dist|coverage|sys|sys-test|.harness|\\.serena)" },
  },
  forbidden: [
    // Cycles are the classic architecture rot; forbid them outright.
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },

    // The CLI entry is the composition root: nothing below may import it.
    {
      name: "entry-is-root",
      severity: "error",
      from: { path: "^src/" },
      to: { path: "^src/index\\.ts$" },
    },

    // The descriptor domain never reaches up into tools/orchestration/entry.
    {
      name: "fs-not-above",
      severity: "error",
      from: { path: "^src/vfs/" },
      to: { path: "^src/(toolkit/|turn/|turn\\.ts|mount\\.ts|index\\.ts|register\\.ts)" },
    },

    // The tool domain never reaches up into the VFS/orchestration/entry.
    {
      name: "tools-not-above",
      severity: "error",
      from: { path: "^src/toolkit/" },
      to: { path: "^src/(vfs/|turn/|turn\\.ts|mount\\.ts|index\\.ts|register\\.ts)" },
    },

    // The turn engine receives registries injected; it never fetches them.
    {
      name: "turn-not-manifest",
      severity: "error",
      from: { path: "^src/turn(\\.ts|/)" },
      to: { path: "^src/(index\\.ts|register\\.ts)$" },
    },

    // The FUSE bridge stays a leaf adapter.
    {
      name: "mount-pure-bridge",
      severity: "error",
      from: { path: "^src/mount\\.ts$" },
      to: { path: "^src/" },
    },

    // The wiring manifest composes domains; it never reaches up.
    {
      name: "register-composes-domains",
      severity: "error",
      from: { path: "^src/register\\.ts$" },
      to: { path: "^src/(index\\.ts|turn\\.ts|mount\\.ts|turn/.+)$" },
    },

    // The host proxy is a leaf: it must not import any internal src module.
    {
      name: "host-leaf",
      severity: "error",
      from: { path: "^src/host\\.ts$" },
      to: { path: "^src/" },
    },

    // Host filesystem access happens ONLY through src/host.ts. This is the
    // rule that keeps descriptors/tools honest: no direct node:fs anywhere
    // in src/ except the proxy itself.
    {
      name: "fs-only-via-host",
      severity: "error",
      from: { path: "^src/(?!host\\.ts$)" },
      to: { path: "^(node:)?fs(/promises)?$" },
    },

    // Subprocess spawning likewise happens ONLY through src/host.ts (the
    // spawn passthrough), so process execution is governable in one place.
    {
      name: "subprocess-only-via-host",
      severity: "error",
      from: { path: "^src/(?!host\\.ts$)" },
      to: { path: "^(node:)?child_process$" },
    },

    // Only the state layer may import the agentfs SDK.
    {
      name: "agentfs-only-in-state",
      severity: "error",
      from: { path: "^src/(?!state/)" },
      to: { path: "^agentfs-sdk$" },
    },

    // Database drivers are owned by their data-access module: all operations on
    // sessions.db live in src/server/store/ (knex + better-sqlite3 driver), all
    // operations on the agentfs db in src/state/ (agentfs SDK — pre-existing
    // agentfs-only-in-state rule). No other module imports a database driver.
    {
      name: "db-drivers-only-in-store",
      severity: "error",
      from: { path: "^src/(?!server/store/|state/)" },
      to: { path: "^(knex|better-sqlite3|agentfs-sdk)$" },
    },

    // The state layer is a leaf below tools/vfs — it never reaches up.
    {
      name: "state-leaf",
      severity: "error",
      from: { path: "^src/state/" },
      to: { path: "^src/(vfs/|toolkit/|turn/|turn\\.ts|index\\.ts|register\\.ts|mount\\.ts)" },
    },

    // The worker layer is infra below the tool domain — it may only touch host.
    {
      name: "worker-leaf",
      severity: "error",
      from: { path: "^src/worker/" },
      to: { path: "^src/(vfs/|toolkit/|state/|turn/|turn\\.ts|index\\.ts|register\\.ts|mount\\.ts)" },
    },

    // Domain encapsulation: no module reaches into another domain's internals.
    // Anything outside a domain may only import its barrel (`index.ts`).
    ...DOMAINS.map((domain) => ({
      name: `domain-entry-only:${domain}`,
      severity: "error",
      from: { path: `^src/(?!${domain}/)` },
      to: { path: `^src/${domain}/(?!index\\.ts$)` },
    })),

    // The logging module is the ONLY place that may touch pino; everything
    // else goes through src/log.ts. Keeps the stream/level policy central.
    {
      name: "pino-only-in-log",
      severity: "error",
      from: { path: "^src/(?!log\\.ts$)" },
      to: { path: "^pino$" },
    },

    // src/log.ts is a leaf: it must not import any internal src module.
    {
      name: "log-leaf",
      severity: "error",
      from: { path: "^src/log\\.ts$" },
      to: { path: "^src/" },
    },

    // Production code never imports tests.
    {
      name: "no-prod-import-test",
      severity: "error",
      from: { path: "^src/" },
      to: { path: "^test/" },
    },

    // Nothing should drift into unowned dead code (skip ambient .d.ts).
    {
      name: "no-orphans",
      severity: "warn",
      from: { orphan: true, pathNot: "\\.d\\.ts$" },
      to: {},
    },
  ],
};
