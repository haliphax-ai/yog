import { describe, expect, it } from 'vitest'
import {
  bashTool,
  executeToolCall,
  toolDefinitions,
  tools,
  validateAgainstSchema,
} from '../src/tools.ts'

describe('tool definitions', () => {
  it('exposes a single bash tool for starters', () => {
    expect(Object.keys(tools)).toEqual(['bash'])
    expect(toolDefinitions).toHaveLength(1)
    expect((toolDefinitions[0] as { function: { name: string } }).function.name).toBe('bash')
  })

  it('requires command and args with the right types', () => {
    const params = bashTool.definition.function.parameters as {
      required: string[]
      properties: Record<string, { type?: unknown; items?: { type?: unknown } }>
    }
    expect(params.required).toEqual(['command', 'args'])
    expect(params.properties['command']?.type).toBe('string')
    expect(params.properties['args']?.type).toBe('array')
    expect(params.properties['args']?.items?.type).toEqual(['string', 'number'])
  })
})

describe('schema validation', () => {
  const schema = bashTool.definition.function.parameters as never

  it('accepts a valid call', () => {
    expect(
      validateAgainstSchema(schema, { command: 'echo', args: ['hi', 1] }),
    ).toBeUndefined()
  })

  it('rejects a missing required field', () => {
    expect(validateAgainstSchema(schema, { command: 'echo' })).toMatch(
      /missing required field "args"/,
    )
  })

  it('rejects extra fields', () => {
    expect(
      validateAgainstSchema(schema, { command: 'echo', args: [], cwd: '/tmp' }),
    ).toMatch(/unexpected field "cwd"/)
  })

  it('rejects an invalid field type', () => {
    expect(validateAgainstSchema(schema, { command: 42, args: [] })).toMatch(
      /expected string/,
    )
  })

  it('rejects invalid array element types', () => {
    expect(
      validateAgainstSchema(schema, { command: 'echo', args: ['a', true] }),
    ).toMatch(/args\[1\]: expected string \| number/)
  })
})

describe('executeToolCall', () => {
  it('runs bash and returns stdout/exitCode', async () => {
    const result = await executeToolCall(
      'bash',
      JSON.stringify({ command: 'echo', args: ['hello'] }),
    )
    expect(result?.error).toBeUndefined()
    expect(result?.['stdout']).toBe('hello\n')
    expect(result?.['exitCode']).toBe(0)
    expect(typeof result?.['runtimeMs']).toBe('number')
  })

  it('reports the exit code of a failing command', async () => {
    const result = await executeToolCall('bash', JSON.stringify({ command: 'false', args: [] }))
    expect(result?.['exitCode']).toBe(1)
    expect(result?.error).toBeUndefined()
  })

  it('aborts on schema violation with error and null output fields', async () => {
    const result = await executeToolCall('bash', JSON.stringify({ command: 'echo' }))
    expect(result?.['error']).toMatch(/missing required field "args"/)
    expect(result?.['stdout']).toBeNull()
    expect(result?.['stderr']).toBeNull()
    expect(result?.['exitCode']).toBeNull()
  })

  it('aborts on extra fields', async () => {
    const result = await executeToolCall(
      'bash',
      JSON.stringify({ command: 'echo', args: [], shell: true }),
    )
    expect(result?.['error']).toMatch(/unexpected field "shell"/)
    expect(result?.['stdout']).toBeNull()
  })

  it('sets error on invalid JSON arguments', async () => {
    const result = await executeToolCall('bash', '{not json')
    expect(result?.['error']).toMatch(/invalid JSON arguments/)
    expect(result?.['exitCode']).toBeNull()
  })

  it('sets error with null output fields when the command cannot spawn', async () => {
    // null byte in argv makes spawn throw synchronously
    const result = await executeToolCall('bash', JSON.stringify({ command: 'ec\0ho', args: [] }))
    expect(result?.['error']).toBeTruthy()
    expect(result?.['stdout']).toBeNull()
    expect(result?.['exitCode']).toBeNull()
  })

  it('returns undefined for unknown tools', async () => {
    expect(await executeToolCall('nope', '{}')).toBeUndefined()
  })
})