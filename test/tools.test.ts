import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bashTool,
  executeToolCall,
  toolDefinitions,
  tools,
  validateAgainstSchema,
} from '../src/tools.js'

describe('tool definitions', () => {
  it('exposes a single bash tool for starters', () => {
    expect(Object.keys(tools)).toEqual(['bash'])
    expect(toolDefinitions).toHaveLength(1)
    expect((toolDefinitions[0] as { function: { name: string } }).function.name).toBe('bash')
  })

  it('requires a single script string', () => {
    const params = bashTool.definition.function.parameters as {
      required: string[]
      properties: Record<string, { type?: unknown }>
    }
    expect(params.required).toEqual(['script'])
    expect(params.properties['script']?.type).toBe('string')
  })
})

describe('schema validation', () => {
  const schema = bashTool.definition.function.parameters as never

  it('accepts a valid call', () => {
    expect(validateAgainstSchema(schema, { script: 'echo hi' })).toBeUndefined()
  })

  it('rejects a missing required field', () => {
    expect(validateAgainstSchema(schema, {})).toMatch(/missing required field "script"/)
  })

  it('rejects extra fields', () => {
    expect(validateAgainstSchema(schema, { script: 'echo', cwd: '/tmp' })).toMatch(
      /unexpected field "cwd"/,
    )
  })

  it('rejects an invalid field type', () => {
    expect(validateAgainstSchema(schema, { script: 42 })).toMatch(/expected string/)
  })
})

describe('executeToolCall', () => {
  it('runs bash and returns stdout/exitCode', async () => {
    const result = await executeToolCall('bash', JSON.stringify({ script: 'echo hello' }))
    expect(result?.error).toBeUndefined()
    expect(result?.['stdout']).toBe('hello\n')
    expect(result?.['exitCode']).toBe(0)
    expect(typeof result?.['runtimeMs']).toBe('number')
  })

  it('reports the exit code of a failing script', async () => {
    const result = await executeToolCall('bash', JSON.stringify({ script: 'exit 7' }))
    expect(result?.['exitCode']).toBe(7)
    expect(result?.error).toBeUndefined()
  })

  it('aborts on schema violation with error and null output fields', async () => {
    const result = await executeToolCall('bash', JSON.stringify({}))
    expect(result?.['error']).toMatch(/missing required field "script"/)
    expect(result?.['stdout']).toBeNull()
    expect(result?.['stderr']).toBeNull()
    expect(result?.['exitCode']).toBeNull()
  })

  it('aborts on extra fields', async () => {
    const result = await executeToolCall(
      'bash',
      JSON.stringify({ script: 'echo', shell: true }),
    )
    expect(result?.['error']).toMatch(/unexpected field "shell"/)
    expect(result?.['stdout']).toBeNull()
  })

  it('sets error on invalid JSON arguments', async () => {
    const result = await executeToolCall('bash', '{not json')
    expect(result?.['error']).toMatch(/invalid JSON arguments/)
    expect(result?.['exitCode']).toBeNull()
  })

  it('returns undefined for unknown tools', async () => {
    expect(await executeToolCall('nope', '{}')).toBeUndefined()
  })
})

describe('host environment hiding', () => {
  it('does not expose host secrets to tool children', async () => {
    process.env['OPENAI_API_KEY'] = 'sk-super-secret'
    process.env['GH_TOKEN'] = 'ghp_super-secret'
    try {
      const result = await executeToolCall(
        'bash',
        JSON.stringify({ script: 'env | sort' }),
      )
      expect(result?.error).toBeUndefined()
      const envOut = String(result?.['stdout'])
      // secrets gone
      expect(envOut).not.toContain('OPENAI_API_KEY')
      expect(envOut).not.toContain('GH_TOKEN')
      expect(envOut).not.toContain('sk-super-secret')
      // essentials kept
      expect(envOut).toMatch(/^HOME=/m)
      expect(envOut).toMatch(/^PATH=/m)
      // host env beyond the minimal allowlist is not passed through
      expect(envOut).not.toContain('GEMINI_TOKEN')
      expect(envOut).not.toContain('OPENROUTER_TOKEN')
      expect(envOut).not.toContain('NODE_VERSION')
    } finally {
      delete process.env['OPENAI_API_KEY']
      delete process.env['GH_TOKEN']
    }
  })

  it('preserves agent-set variables even when their names look secret-ish', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'harness-state-'))
    const prev = process.env['HARNESS_STATE_DIR']
    process.env['HARNESS_STATE_DIR'] = stateDir
    try {
      const setResult = await executeToolCall(
        'bash',
        JSON.stringify({ script: 'export MY_API_TOKEN=abc123' }),
      )
      expect(setResult?.error).toBeUndefined()

      const getResult = await executeToolCall(
        'bash',
        JSON.stringify({ script: 'printf "%s" "$MY_API_TOKEN"' }),
      )
      expect(getResult?.error).toBeUndefined()
      expect(getResult?.['stdout']).toBe('abc123')
    } finally {
      if (prev === undefined) delete process.env['HARNESS_STATE_DIR']
      else process.env['HARNESS_STATE_DIR'] = prev
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})

describe('bash shell state persistence', () => {
  it('persists cwd, exported variables, and functions across calls', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'harness-state-'))
    const prev = process.env['HARNESS_STATE_DIR']
    process.env['HARNESS_STATE_DIR'] = stateDir
    try {
      const r1 = await executeToolCall(
        'bash',
        JSON.stringify({
          script: "cd /tmp && export FOO=bar && myfn() { echo fn-ok; }",
        }),
      )
      expect(r1?.error).toBeUndefined()
      expect(r1?.['exitCode']).toBe(0)

      const r2 = await executeToolCall(
        'bash',
        JSON.stringify({ script: 'printf "%s|%s|" "$PWD" "$FOO"; myfn' }),
      )
      expect(r2?.error).toBeUndefined()
      expect(r2?.['stdout']).toBe('/tmp|bar|fn-ok\n')
    } finally {
      if (prev === undefined) delete process.env['HARNESS_STATE_DIR']
      else process.env['HARNESS_STATE_DIR'] = prev
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})