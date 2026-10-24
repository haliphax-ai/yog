import { spawn } from 'node:child_process'
import type {
  ChatCompletionFunctionTool,
  ChatCompletionTool,
} from 'openai/resources/chat/completions/completions.mjs'

/**
 * Result envelope for every tool. `error` is set instead of running the tool
 * when the call fails schema validation, and carries the exception message
 * when the tool itself throws.
 */
export interface ToolResult {
  error?: string
  [key: string]: unknown
}

export interface BashResult extends ToolResult {
  stdout: string | null
  stderr: string | null
  runtimeMs: number | null
  exitCode: number | null
}

export interface ToolSpec {
  definition: ChatCompletionFunctionTool
  /** Validate the raw (JSON-parsed) arguments; return an error string to abort. */
  validate(args: unknown): string | undefined
  /** Response shape used when the call is aborted (validation error / exception). */
  failure(error: string): ToolResult
  run(args: Record<string, unknown>): Promise<ToolResult>
}

type SchemaNode = {
  type?: string | string[]
  properties?: Record<string, SchemaNode>
  required?: string[]
  items?: SchemaNode
  additionalProperties?: boolean | SchemaNode
  enum?: unknown[]
  [key: string]: unknown
}

/**
 * Validate `args` against a JSON schema (subset: object/string/number/integer/
 * boolean/array/enum). Returns a human-readable message covering missing,
 * extra, and invalid fields, or undefined when the arguments are valid.
 */
export function validateAgainstSchema(
  schema: SchemaNode,
  args: unknown,
  path = '',
): string | undefined {
  if (typeof schema !== 'object' || schema === null) return undefined
  const types =
    schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type]

  if (schema.enum !== undefined && !schema.enum.includes(args)) {
    return `${path || 'arguments'}: value ${JSON.stringify(args)} is not one of ${JSON.stringify(schema.enum)}`
  }

  if (types.length > 0 && !types.some((t) => matchesType(t, args))) {
    return `${path || 'arguments'}: expected ${types.join(' | ')}, got ${describe(args)}`
  }

  if (matchesType('object', args) && schema.properties !== undefined) {
    const obj = args as Record<string, unknown>
    const known = Object.keys(schema.properties)
    const errors: string[] = []

    for (const key of schema.required ?? []) {
      if (!(key in obj)) errors.push(`missing required field "${key}"`)
    }
    for (const key of Object.keys(obj)) {
      if (!known.includes(key)) errors.push(`unexpected field "${key}"`)
    }
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (key in obj) {
        const err = validateAgainstSchema(sub, obj[key], path ? `${path}.${key}` : key)
        if (err) errors.push(err)
      }
    }

    if (errors.length > 0) return errors.join('; ')
  }

  if (matchesType('array', args) && schema.items !== undefined) {
    const arr = args as unknown[]
    for (let i = 0; i < arr.length; i++) {
      const err = validateAgainstSchema(schema.items, arr[i], `${path}[${i}]`)
      if (err) return err
    }
  }

  return undefined
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    case 'array':
      return Array.isArray(value)
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    default:
      return true
  }
}

function describe(value: unknown): string {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  return typeof value
}

/**
 * Wrapper that gives each bash tool call a persistent shell home:
 *
 *  - restore the previous call's cwd and exported vars/functions
 *  - source the agent's rc (BASH_ENV, falling back to ~/.bashrc) so every
 *    call starts from the full-fledged home environment
 *  - run the requested script as `bash -c "$1"` (argv, no string surgery)
 *  - persist cwd + `export -p` + `declare -f` atomically for the next call
 *
 * The script arrives as $1; the wrapper's own restore/capture never interfere
 * with the script's stdout/stderr/exit code.
 */
const WRAPPER = `set +e

HARNESS_STATE_DIR="\${HARNESS_STATE_DIR:-.harness}"
HARNESS_RC="\${HARNESS_RC:-\${BASH_ENV:-}}"
if [ -z "$HARNESS_RC" ] && [ -f "$HOME/.bashrc" ]; then
  HARNESS_RC="$HOME/.bashrc"
fi

__h_capture() {
  mkdir -p "$HARNESS_STATE_DIR"
  pwd -P > "$HARNESS_STATE_DIR/cwd.tmp" 2>/dev/null && mv -f "$HARNESS_STATE_DIR/cwd.tmp" "$HARNESS_STATE_DIR/cwd" 2>/dev/null
  {
    # No filtering here: the spawn env was already minimal, so this snapshot
    # contains only what the agent itself set — killing anything with a
    # "token"-looking name would destroy agent-owned state for no benefit.
    export -p
    declare -f
  } > "$HARNESS_STATE_DIR/env.tmp" 2>/dev/null && mv -f "$HARNESS_STATE_DIR/env.tmp" "$HARNESS_STATE_DIR/env" 2>/dev/null
}

__h_finish() {
  local __h_rc=$?
  __h_capture
  trap - EXIT
  exit "$__h_rc"
}

trap __h_finish EXIT

if [ -f "$HARNESS_STATE_DIR/env" ]; then
  # shellcheck disable=SC1090
  source "$HARNESS_STATE_DIR/env" >/dev/null 2>&1 || true
fi

if [ -f "$HARNESS_STATE_DIR/cwd" ]; then
  __h_cwd=$(cat "$HARNESS_STATE_DIR/cwd" 2>/dev/null)
  if [ -n "$__h_cwd" ] && [ -d "$__h_cwd" ]; then
    cd -- "$__h_cwd" 2>/dev/null
  fi
fi

if [ -n "$HARNESS_RC" ] && [ -f "$HARNESS_RC" ]; then
  # shellcheck disable=SC1090
  source "$HARNESS_RC" >/dev/null || true
fi

# The script runs in THIS shell, so its cd/export/functions mutate the very
# state we capture on EXIT — a child bash would throw all of it away.
eval "$1"
`

/**
 * The bash tool is spawned with a near-empty environment — just the plumbing
 * the shell needs to boot (HOME, a fixed PATH, TERM, TZ) and our own
 * HARNESS_* / BASH_ENV pointers. Everything else the model sees comes from the
 * agent's home rc (BASH_ENV, falling back to ~/.bashrc), which the operator
 * controls. Host env — including credentials — never reaches the tool, and
 * the persisted shell-state snapshot therefore only ever reflects what the
 * agent itself set. No name/value pattern matching is needed; there is
 * nothing to hide because nothing was passed.
 */
function buildToolEnv(): Record<string, string> {
  const out: Record<string, string> = {
    HOME: process.env['HOME'] ?? '/root',
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    TERM: process.env['TERM'] ?? 'dumb',
    TZ: process.env['TZ'] ?? 'UTC',
  }
  // Plumbing, not data: the shell-home pointer and our own state-dir/rc overrides.
  for (const key of ['BASH_ENV', 'HARNESS_STATE_DIR', 'HARNESS_RC']) {
    const value = process.env[key]
    if (value) out[key] = value
  }
  return out
}

export const bashTool: ToolSpec = {
  definition: {
    type: 'function',
    function: {
      name: 'bash',
      description:
        'Run a bash script in a persistent shell environment. ' +
        'cwd, exported variables, and shell functions persist between calls; ' +
        'the agent rc (BASH_ENV or ~/.bashrc) is sourced as the baseline. ' +
        'stdout/stderr/exitCode map to the shell process; they are null (with ' +
        '`error` set) if the call failed validation or threw.',
      parameters: {
        type: 'object',
        properties: {
          script: {
            type: 'string',
            description: 'A bash script to execute.',
          },
        },
        required: ['script'],
        additionalProperties: false,
      },
    },
  },

  validate(args: unknown): string | undefined {
    return validateAgainstSchema(this.definition.function.parameters as SchemaNode, args)
  },

  failure(error: string): BashResult {
    return { stdout: null, stderr: null, runtimeMs: null, exitCode: null, error }
  },

  async run(args): Promise<BashResult> {
    const script = String(args['script'])

    const start = performance.now()
    const outcome = await execBash(script)
    const runtimeMs = Math.round(performance.now() - start)
    if (outcome.spawnError !== undefined) {
      return { stdout: null, stderr: null, runtimeMs, exitCode: null, error: outcome.spawnError }
    }
    return {
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      runtimeMs,
      exitCode: outcome.exitCode,
    }
  },
}

interface ExecOutcome {
  stdout: string
  stderr: string
  exitCode: number | null
  spawnError?: string
}

function execBash(script: string): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('bash', ['-c', WRAPPER, 'harness', script], {
        cwd: process.cwd(),
        env: buildToolEnv(),
      })
    } catch (err) {
      resolve({
        stdout: '',
        stderr: '',
        exitCode: null,
        spawnError: err instanceof Error ? err.message : String(err),
      })
      return
    }

    const out: Buffer[] = []
    const errOut: Buffer[] = []
    child.stdout?.on('data', (d: Buffer) => out.push(d))
    child.stderr?.on('data', (d: Buffer) => errOut.push(d))

    let settled = false
    const settle = (outcome: ExecOutcome) => {
      if (!settled) {
        settled = true
        resolve(outcome)
      }
    }

    child.on('error', (err) => {
      settle({ stdout: '', stderr: '', exitCode: null, spawnError: err.message })
    })

    child.on('close', (code) => {
      settle({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(errOut).toString('utf8'),
        exitCode: code,
      })
    })
  })
}

/** Tool registry keyed by tool name. */
export const tools: Record<string, ToolSpec> = {
  bash: bashTool,
}

export const toolDefinitions: ChatCompletionTool[] = Object.values(tools).map((t) => t.definition)

/**
 * Execute one tool call: validate arguments, abort with `error` set when the
 * schema rejects them, and convert thrown exceptions into `error` on the
 * response. Returns undefined when the tool name is unknown.
 */
export async function executeToolCall(
  name: string,
  rawArgs: string | null,
): Promise<ToolResult | undefined> {
  const tool = tools[name]
  if (!tool) return undefined

  let parsed: unknown
  try {
    parsed = rawArgs === null || rawArgs.trim() === '' ? {} : JSON.parse(rawArgs)
  } catch (err) {
    return tool.failure(`invalid JSON arguments: ${(err as Error).message}`)
  }

  const validationError = tool.validate(parsed)
  if (validationError) {
    return tool.failure(validationError)
  }

  try {
    return await tool.run(parsed as Record<string, unknown>)
  } catch (err) {
    return tool.failure(err instanceof Error ? err.message : String(err))
  }
}