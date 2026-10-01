import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CustomEventDeclarations } from '@attalabs/aeg-core/log'
import { emitCustomEvent } from '../../src/lib/log-custom.js'
import { createLogSink } from '../../src/lib/log-sink.js'
import { type LogEmitDeps, logEmitCommand } from '../../src/commands/log-emit.js'

// The command is proved against injected seams — never a real destination —
// the same shape `log-selftest.test.ts` uses: `emit`/`drain`/`resolveDestinationKind`
// are decisions, not network or filesystem calls, so every exit code is
// reproducible on Linux CI with no server and no config. The one exception is
// the O3 describe block below, which drives a REAL (but fully isolated, local
// `createLogSink` instance) to prove the written header, not a stub.

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

describe('vinaya log emit — a process outside Vinaya (O3)', () => {
  /** A real sink writing to a fresh folder, with ONLY VINAYA_WORK_REF/VINAYA_FLOW
   * set — no VINAYA_ROLE, no VINAYA_TASK — the exact environment O3 names. */
  function externalProcessSink(): { dir: string; sink: ReturnType<typeof createLogSink> } {
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-log-emit-o3-'))
    const sink = createLogSink({
      resolveLogDestination: () => ({ kind: 'folder', folder: join(dir, 'outbox') }),
      home: () => dir,
      hostname: () => 'external-host',
      cwd: () => dir,
      now: () => new Date('2026-10-01T00:00:00.000Z'),
      env: () => ({ VINAYA_WORK_REF: 'JIRA-4821', VINAYA_FLOW: 'acme-release-flow' }),
      resolveRepo: () => Promise.resolve(null),
      resolveBranchIssue: () => Promise.resolve(null),
      vinayaVersion: () => '0.36.0',
      stderr: () => {}
    })
    return { dir, sink }
  }

  function writtenLines(dir: string): Array<Record<string, unknown>> {
    const folder = join(dir, 'outbox', 'unresolved')
    if (!existsSync(folder)) return []
    return readdirSync(folder).flatMap((file) =>
      readFileSync(join(folder, file), 'utf8')
        .trim()
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    )
  }

  it("the recorded event's header carries the work reference and flow id from the environment alone", async () => {
    const { dir, sink } = externalProcessSink()
    const { deps: d } = deps({
      emit: (name, fields) => emitCustomEvent(name, fields, { declarations: () => declarations, emit: sink.log }),
      drain: () => sink.drain()
    })
    const code = await logEmitCommand(['acme.review_started', '--json', JSON.stringify(valid)], d)
    expect(code).toBe(0)

    const lines = writtenLines(dir)
    expect(lines).toHaveLength(1)
    const line = lines[0] as {
      meta: { work: { ref: string | null }; flow: { id: string | null }; schema: number }
      subject: { role: string; issue: number | null }
    }
    expect(line.meta.schema).toBe(3)
    expect(line.meta.work.ref).toBe('JIRA-4821')
    expect(line.meta.flow.id).toBe('acme-release-flow')
    // No Vinaya role or task was set — the header says so honestly.
    expect(line.subject.role).toBe('unattributed')
    expect(line.subject.issue).toBeNull()
  })
})
