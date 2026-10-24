/**
 * Dependency-cruiser rules for yog.
 *
 * Enforced architecture (layers, top → bottom):
 *
 *   src/index.ts      CLI entry — composition root; may import anything under src/
 *   src/register.ts   wiring manifest — composes tools + fs domains only
 *   src/turn.ts       orchestration — knows the ToolRegistry, never the VFS/entry
 *   src/mount.ts      pure FUSE bridge — no internal dependencies
 *   src/host/         host proxy — the ONLY module allowed to touch node:fs
 *   src/fs/**         leaf domain: descriptors (may use host for out-of-VFS action)
 *   src/tools/**      leaf domain: harness tools (may use host for out-of-VFS action)
 *   test/**           may import any src/**, never the reverse
 *
 * Key invariant: descriptors and tools reach the host filesystem only through
 * src/host/ — direct node:fs imports anywhere in src/ other than host are a
 * rule violation.
 */
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
      from: { path: "^src/fs/" },
      to: { path: "^src/(tools/|turn\\.ts|mount\\.ts|index\\.ts|register\\.ts)" },
    },

    // The tool domain never reaches up into the VFS/orchestration/entry.
    {
      name: "tools-not-above",
      severity: "error",
      from: { path: "^src/tools/" },
      to: { path: "^src/(fs/|turn\\.ts|mount\\.ts|index\\.ts|register\\.ts)" },
    },

    // The turn engine receives registries injected; it never fetches them.
    {
      name: "turn-not-manifest",
      severity: "error",
      from: { path: "^src/turn\\.ts$" },
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
      to: { path: "^src/(index\\.ts|turn\\.ts|mount\\.ts)$" },
    },

    // The host proxy is a leaf: it must not import any internal src module.
    {
      name: "host-leaf",
      severity: "error",
      from: { path: "^src/host/" },
      to: { path: "^src/" },
    },

    // Host filesystem access happens ONLY through src/host/. This is the rule
    // that keeps descriptors/tools honest: no direct node:fs anywhere in
    // src/ except the proxy itself.
    {
      name: "fs-only-via-host",
      severity: "error",
      from: { path: "^src/(?!host/)" },
      to: { path: "^(node:)?fs(/promises)?$" },
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
