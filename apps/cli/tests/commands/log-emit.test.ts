import { describe, expect, it } from 'bun:test'
import type { CustomEventDeclarations } from '@attalabs/aeg-core/log'
import { emitCustomEvent } from '../../src/lib/log-custom.js'
import { type LogEmitDeps, logEmitCommand } from '../../src/commands/log-emit.js'

// The command is proved against injected seams — never a real destination —
// the same shape `log-selftest.test.ts` uses: `emit`/`drain`/`resolveDestinationKind`
// are decisions, not network or filesystem calls, so every exit code is
// reproducible on Linux CI with no server and no config.

const declarations: CustomEventDeclarations = {
  'acme.review_started': { fields: { phase: ['design', 'build', 'ship'] } }
}
const valid = { phase: 'design' }

function deps(overrides: Partial<LogEmitDeps> = {}): { deps: LogEmitDeps; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  const base: LogEmitDeps = {
    emit: (name, fields) => emitCustomEvent(name, fields, { declarations: () => declarations }),
    resolveDestinationKind: async () => 'folder',
    drain: async () => {},
    readStdin: async () => '',
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t)
  }
  return { deps: { ...base, ...overrides }, out, err }
}

describe('vinaya log emit — a declared event records (O1)', () => {
  it('exits 0, prints the event name and the destination kind, via --json', async () => {
    const { deps: d, out } = deps({ resolveDestinationKind: async () => 'server' })
    const code = await logEmitCommand(['acme.review_started', '--json', JSON.stringify(valid)], d)
    expect(code).toBe(0)
    expect(out.join('')).toContain('acme.review_started')
    expect(out.join('')).toContain('server')
  })

  it('exits 0 and reads the field values from standard input when --json is absent', async () => {
    const { deps: d, out } = deps({ readStdin: async () => JSON.stringify(valid) })
    const code = await logEmitCommand(['acme.review_started'], d)
    expect(code).toBe(0)
    expect(out.join('')).toContain('acme.review_started')
    expect(out.join('')).toContain('folder')
  })

  it('never prints a field value on success', async () => {
    const { deps: d, out } = deps()
    await logEmitCommand(['acme.review_started', '--json', JSON.stringify(valid)], d)
    expect(out.join('')).not.toContain('design')
  })

  it('drains the sink before printing, so the write is guaranteed to have landed', async () => {
    let drained = false
    const { deps: d } = deps({
      drain: async () => {
        drained = true
      }
    })
    await logEmitCommand(['acme.review_started', '--json', JSON.stringify(valid)], d)
    expect(drained).toBe(true)
  })
})

describe('vinaya log emit — a refused event (O2)', () => {
  const cases: Array<[string, string, Record<string, unknown>, string, string[]]> = [
    ['undeclared name', 'acme.other', valid, 'undeclared', []],
    ['missing field', 'acme.review_started', {}, 'missing_field', ['phase']],
    [
      'extra field',
      'acme.review_started',
      { ...valid, secret_zone: 'eu-secret-value' },
      'extra_field',
      ['secret_zone']
    ],
    ['wrong type', 'acme.review_started', { phase: 'not-a-listed-word' }, 'wrong_type', ['phase']]
  ]

  for (const [label, name, fields, reason, fieldNames] of cases) {
    it(`${label}: exits 1, prints the reason class and the field names, never a value`, async () => {
      const { deps: d, out, err } = deps()
      const code = await logEmitCommand([name, '--json', JSON.stringify(fields)], d)
      expect(code).toBe(1)
      expect(err.join('')).toContain(reason)
      for (const f of fieldNames) expect(err.join('')).toContain(f)
      expect(out.join('')).toBe('')
      expect(err.join('')).not.toContain('eu-secret-value')
    })
  }

  it('does not resolve the destination or drain on a refusal', async () => {
    let resolved = false
    let drained = false
    const { deps: d } = deps({
      resolveDestinationKind: async () => {
        resolved = true
        return 'folder'
      },
      drain: async () => {
        drained = true
      }
    })
    const code = await logEmitCommand(['acme.other', '--json', '{}'], d)
    expect(code).toBe(1)
    expect(resolved).toBe(false)
    expect(drained).toBe(false)
  })
})

describe('vinaya log emit — a usage error (O2)', () => {
  it('exits 2 with no event name', async () => {
    const { deps: d, err } = deps()
    const code = await logEmitCommand([], d)
    expect(code).toBe(2)
    expect(err.join('')).toContain('Usage')
  })

  it('exits 2 on JSON that cannot be read', async () => {
    const { deps: d, err } = deps()
    const code = await logEmitCommand(['acme.review_started', '--json', '{not json'], d)
    expect(code).toBe(2)
    expect(err.join('')).toContain('JSON')
  })

  it('exits 2 on JSON that is an array, not an object', async () => {
    const { deps: d } = deps()
    const code = await logEmitCommand(['acme.review_started', '--json', '[1,2,3]'], d)
    expect(code).toBe(2)
  })

  it('exits 2 on JSON that is a bare string', async () => {
    const { deps: d } = deps()
    const code = await logEmitCommand(['acme.review_started', '--json', '"hello"'], d)
    expect(code).toBe(2)
  })

  it('exits 2 on JSON null', async () => {
    const { deps: d } = deps()
    const code = await logEmitCommand(['acme.review_started', '--json', 'null'], d)
    expect(code).toBe(2)
  })

  it('exits 2 when --json is given with no following value', async () => {
    const { deps: d } = deps()
    const code = await logEmitCommand(['acme.review_started', '--json'], d)
    expect(code).toBe(2)
  })

  it('never calls emit on a usage error', async () => {
    let called = false
    const { deps: d } = deps({
      emit: () => {
        called = true
        return { ok: true, name: 'acme.review_started' }
      }
    })
    await logEmitCommand(['acme.review_started', '--json', 'not json'], d)
    expect(called).toBe(false)
  })
})
