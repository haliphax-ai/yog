import { type DescriptorFile } from "../node.ts";

/**
 * The CLI shim descriptor.
 *
 * Renders a Node.js script that acts as a thin HTTP client to the daemon's
 * `/v1/agent-cli` endpoint. The script is placed at `/yog/bin/yog` in the
 * FUSE mount and is executable. It forwards the command and its arguments
 * faithfully and returns the exact output from the daemon response.
 */
export class CliShimDescriptor implements DescriptorFile {
  readonly kind = "file" as const;
  readonly mode = 0o100755; // executable
  readonly flags = 0; // no read/write capabilities via FUSE

  render(): string {
    return [
      "#!/usr/bin/env node",
      "/**",
      " * yog CLI shim - forwards commands to the daemon via HTTP.",
      " * Usage: yog <command> [args...]",
      " */",
      'const { request } = require("node:http");',
      "",
      "const [command, ...args] = process.argv.slice(2);",
      "",
      'if (!command) {',
      '  process.stderr.write("usage: yog <command> [args...]\\n");',
      "  process.exit(1);",
      "}",
      "",
      "const body = JSON.stringify({ command, args });",
      "const options = {",
      '  hostname: "127.0.0.1",',
      "  port: 8111,",
      '  path: "/v1/agent-cli",',
      '  method: "POST",',
      "  headers: {",
      '    "Content-Type": "application/json",',
      '    "Content-Length": Buffer.byteLength(body),',
      "  },",
      "};",
      "",
      "const req = request(options, (res) => {",
      '  let data = "";',
      '  res.on("data", (chunk) => {',
      "    data += chunk;",
      "  });",
      '  res.on("end", () => {',
      "    process.stdout.write(data);",
      "    process.exit(res.statusCode ?? 200);",
      "  });",
      "});",
      "",
      'req.on("error", (err) => {',
      '  process.stderr.write(`error: ${err.message}\\n`);',
      "  process.exit(1);",
      "});",
      "",
      "req.write(body);",
      "req.end();",
      "",
    ].join("\n");
  }
}
