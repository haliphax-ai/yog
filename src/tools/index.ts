import type {
  ChatCompletionFunctionTool,
  ChatCompletionTool,
} from 'openai/resources/chat/completions/completions.mjs'

/**
 * Shared plumbing for harness tools.
 *
 * A harness tool is a model-facing function: it declares an OpenAI function
 * definition, validates its JSON arguments, and runs. The `ToolRegistry`
 * holds the active tools and executes calls by name, so adding a tool is just
 * implementing `ToolSpec` and registering it.
 */

/**
 * Result envelope for every tool. `error` is set instead of running the tool
 * when the call fails schema validation, and carries the exception message
 * when the tool itself throws.
 */
export interface ToolResult {
  error?: string
  [key: string]: unknown
}

export interface ToolSpec<
  TArgs extends Record<string, unknown> = Record<string, unknown>,
  TResult extends ToolResult = ToolResult,
> {
  definition: ChatCompletionFunctionTool
  /** Validate the raw (JSON-parsed) arguments; return an error string to abort. */
  validate(args: unknown): string | undefined
  /** Response shape used when the call is aborted (validation error / exception). */
  failure(error: string): TResult
  run(args: TArgs): Promise<TResult>
}

export type SchemaNode = {
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
 * Registry of harness tools keyed by tool name. New tools are added by
 * implementing `ToolSpec` and calling `registry.add(tool)`.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolSpec>()

  constructor(tools: ToolSpec[] = []) {
    for (const tool of tools) this.add(tool)
  }

  add(tool: ToolSpec): void {
    this.tools.set(tool.definition.function.name, tool)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  get definitions(): ChatCompletionTool[] {
    return [...this.tools.values()].map((t) => t.definition)
  }

  /**
   * Execute one tool call: validate arguments, abort with `error` set when the
   * schema rejects them, and convert thrown exceptions into `error` on the
   * response. Returns undefined when the tool name is unknown.
   */
  async execute(name: string, rawArgs: string | null): Promise<ToolResult | undefined> {
    const tool = this.tools.get(name)
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
}