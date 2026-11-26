import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { storedEvents } from '@harness/kernel/gates/checks/runner/local-copy-probe.js'
import type { CustomEventDeclarations } from '@harness/kernel/log/custom'
import { emitCustomEvent } from '@harness/kernel/log/client/log-custom.js'
import { createLocalCopySender } from '@harness/kernel/log/local-copy-writer.js'
import { createRunRecorder } from '@harness/kernel/log/run-recorder.js'
import { connect } from '@attalabs/vinaya-log-sdk'
import { type LogEmitDeps, logEmitCommand } from './log-emit.js'

// The command is proved against injected seams — never a real destination —
// `emit`/`drain`/`resolveDestinationKind` are decisions, not network or
// filesystem calls, so every exit code is reproducible on Linux CI with no
// server and no config. The one exception is the O3 describe block below,
// which drives a real run recorder over a fresh local copy to prove what is
// written and what is sent, not a stub.

const declarations: CustomEventDeclarations = {
  'acme.review_started': { fields: { phase: ['design', 'build', 'ship'] } }
}
const valid = { phase: 'design' }

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function deps(overrides: Partial<LogEmitDeps> = {}): { deps: LogEmitDeps; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  const base: LogEmitDeps = {
    emit: (name, fields) =>
      emitCustomEvent(name, fields, { declarations: () => declarations, handle: () => undefined }),
    repository: async () => undefined,
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

  it('drains the run recorder before printing, so the write is guaranteed to have landed', async () => {
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
    expect(err.join('')).toContain('vinaya-log emit')
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

describe('vinaya log emit — written through the Log SDK and sent (O3, O4)', () => {
  /** A real run recorder over a fresh local copy, with the team's declarations in force and a sender that records what it is asked. */
  function recorderOverFreshCopy() {
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-log-emit-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const folder = join(dir, 'logs')
    const sent: string[] = []
    // The real sender over the real `sendLocalCopy`, with the address decided and only the network stubbed.
    const sender = createLocalCopySender({
      warn: () => {},
      address: () => ({ kind: 'address', url: 'http://collector.test' }),
      fetch: async (url) => {
        sent.push(url)
        return new Response('{}', { status: 200 })
      }
    })
    const recorder = createRunRecorder({
      runId: () => 'emit-test-run',
      workRef: () => undefined,
      repository: () => undefined,
      place: (repository) => ({ folder, repository }),
      processIdentity: () => undefined,
      sender: () => sender,
      home: () => dir,
      cwd: () => join(dir, 'repo'),
      onError: () => {},
      connect: (options) => connect({ ...options, destination: { folder, events: declarations } })
    })
    const stored = () => storedEvents(join(folder, 'atta-labs-vinaya'))
    const real = (): LogEmitDeps => ({
      ...deps().deps,
      emit: (name, fields, repository) =>
        emitCustomEvent(name, fields, {
          declarations: () => declarations,
          handle: (scope) => recorder.handle('emit-test-run', scope.repository, scope.workRef),
          ...(repository === undefined ? {} : { repository }),
          workRef: 'JIRA-4821'
        }),
      repository: async () => 'atta-labs/vinaya',
      drain: () => recorder.drain()
    })
    return { sent, stored, real }
  }

  it('a declared event is one record named for the declaration, and the run is drained to the sender', async () => {
    const { sent, stored, real } = recorderOverFreshCopy()
    const out: string[] = []
    const code = await logEmitCommand(['acme.review_started', '--json', JSON.stringify(valid)], {
      ...real(),
      stdout: (t) => out.push(t)
    })
    expect(code).toBe(0)
    expect(out.join('')).toContain('recorded acme.review_started')
    expect(stored().map((e) => e.name)).toEqual(['acme.review_started'])
    expect(sent.some((url) => url === 'http://collector.test/v1/logs')).toBe(true)
  })

  it('a refused event is one command.completed refused, exits 1, and sends nothing', async () => {
    const { sent, stored, real } = recorderOverFreshCopy()
    const err: string[] = []
    const code = await logEmitCommand(['acme.other', '--json', '{}'], { ...real(), stderr: (t) => err.push(t) })
    expect(code).toBe(1)
    expect(err.join('')).toContain('undeclared')
    expect(stored().map((e) => e.name)).toEqual(['vinaya.command.completed'])
    expect(stored()[0]?.attributes).toMatchObject({ 'vinaya.result': 'refused', 'error.type': 'undeclared' })
    expect(sent).toHaveLength(0)
  })
})
