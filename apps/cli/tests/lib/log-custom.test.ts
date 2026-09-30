import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type CustomEventDeclarations, LogEventSchema } from '@attalabs/aeg-core/log'
import { resolveLogsSetting, VinayaConfigSchema } from '../../src/lib/config.js'
import { emitCustomEvent } from '../../src/lib/log-custom.js'
import { createLogSink, type LogEventInput } from '../../src/lib/log-sink.js'

const declarations: CustomEventDeclarations = {
  'acme.deploy': { fields: { env: ['prod', 'staging'], count: 'number', note: 'text', ok: 'boolean' } }
}
const valid = { env: 'prod', count: 2, note: 'shipped', ok: true }

/** A real sink writing to a fresh folder — the same `log()` every other event goes through. */
function realSink(): { dir: string; sink: ReturnType<typeof createLogSink> } {
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-log-custom-'))
  const sink = createLogSink({
    resolveLogDestination: () => ({ kind: 'folder', folder: join(dir, 'outbox') }),
    home: () => dir,
    hostname: () => 'test-host',
    cwd: () => dir,
    now: () => new Date('2026-10-01T00:00:00.000Z'),
    env: () => ({ VINAYA_ROLE: 'developer', VINAYA_TASK: '890' }),
    resolveRepo: () => Promise.resolve({ owner: 'atta-labs', repo: 'vinaya' }),
    resolveBranchIssue: () => Promise.resolve(null),
    vinayaVersion: () => '0.36.0',
    stderr: () => {}
  })
  return { dir, sink }
}

function writtenLines(dir: string): Array<Record<string, unknown>> {
  const folder = join(dir, 'outbox', 'atta-labs-vinaya')
  if (!existsSync(folder)) return []
  return readdirSync(folder).flatMap((file) =>
    readFileSync(join(folder, file), 'utf8')
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
  )
}

function capture(): { events: LogEventInput[]; emit: (e: LogEventInput) => void } {
  const events: LogEventInput[] = []
  return { events, emit: (e) => events.push(e) }
}

describe('logs.events — the declaration in vinaya.config.json (O1, O2)', () => {
  it('loads a config declaring events under logs, with no destination set', () => {
    const parsed = VinayaConfigSchema.safeParse({ logs: { events: declarations } })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.logs?.events).toEqual(declarations)
  })

  it('an events-only logs setting declares no destination — the default folder still applies', () => {
    const config = VinayaConfigSchema.parse({ logs: { events: declarations } })
    expect(resolveLogsSetting(config)).toBeNull()
  })

  it('refuses a declaration that breaks a rule, with a message naming the entry', () => {
    const parsed = VinayaConfigSchema.safeParse({ logs: { events: { 'acme.deploy': { fields: { Env: 'text' } } } } })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      const text = parsed.error.issues.map((i) => i.message).join(' ')
      expect(text).toContain('"acme.deploy"')
      expect(text).toContain('field "Env"')
    }
  })

  it('refuses a name in the reserved vinaya. namespace', () => {
    const parsed = VinayaConfigSchema.safeParse({ logs: { events: { 'vinaya.gate': { fields: {} } } } })
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(parsed.error.issues.map((i) => i.message).join(' ')).toContain('"vinaya.gate"')
  })

  it('refuses a name that is not namespaced', () => {
    expect(VinayaConfigSchema.safeParse({ logs: { events: { deploy: { fields: {} } } } }).success).toBe(false)
  })
})

describe('emitCustomEvent — a declared event (O4)', () => {
  it('emits exactly one custom event carrying the name and the values', () => {
    const { events, emit } = capture()
    expect(emitCustomEvent('acme.deploy', valid, { declarations: () => declarations, emit })).toEqual({
      ok: true,
      name: 'acme.deploy'
    })
    expect(events).toEqual([{ kind: 'custom', event: 'recorded', name: 'acme.deploy', fields: valid, payload: {} }])
  })

  it('writes one valid custom line under a schema 3 header through the log sink', async () => {
    const { dir, sink } = realSink()
    emitCustomEvent('acme.deploy', valid, { declarations: () => declarations, emit: sink.log })
    await sink.drain()
    const lines = writtenLines(dir)
    expect(lines).toHaveLength(1)
    const line = lines[0] as Record<string, unknown>
    expect(LogEventSchema.safeParse(line).success).toBe(true)
    expect(line.kind).toBe('custom')
    expect(line.name).toBe('acme.deploy')
    expect(line.fields).toEqual(valid)
    expect((line.meta as { schema: number }).schema).toBe(3)
  })
})

describe('emitCustomEvent — a refused event (O5)', () => {
  const cases: Array<[string, string, Record<string, unknown>, string, string[]]> = [
    ['undeclared', 'acme.other', valid, 'undeclared', []],
    ['missing', 'acme.deploy', { env: 'prod', count: 2, ok: true }, 'missing_field', ['note']],
    ['extra', 'acme.deploy', { ...valid, zone: 'eu-secret-zone' }, 'extra_field', ['zone']],
    ['wrong type', 'acme.deploy', { ...valid, count: 'two-secret-count' }, 'wrong_type', ['count']]
  ]

  for (const [label, name, fields, reason, fieldNames] of cases) {
    it(`${label}: no custom event; one log.emit refusal naming the reason and the fields; the caller gets the refusal`, () => {
      const { events, emit } = capture()
      const result = emitCustomEvent(name, fields, { declarations: () => declarations, emit })
      expect(result).toEqual({ ok: false, reason: reason as never, fieldNames })
      expect(events).toEqual([
        {
          kind: 'operation',
          event: 'completed',
          operation: 'log.emit',
          target: name,
          result: 'refused',
          error_class: reason,
          field_names: fieldNames,
          payload: {}
        }
      ])
    })
  }

  it('the refusal line written through the sink carries no field value', async () => {
    const { dir, sink } = realSink()
    const secretish = 'hunter2-value-never-logged'
    const result = emitCustomEvent(
      'acme.deploy',
      { ...valid, note: 42, extra_note: secretish },
      { declarations: () => declarations, emit: sink.log }
    )
    expect(result).toMatchObject({ ok: false, reason: 'extra_field' })
    await sink.drain()
    const lines = writtenLines(dir)
    expect(lines).toHaveLength(1)
    expect(lines.filter((l) => l.kind === 'custom')).toHaveLength(0)
    expect(lines[0]).toMatchObject({
      kind: 'operation',
      operation: 'log.emit',
      result: 'refused',
      error_class: 'extra_field',
      field_names: ['extra_note']
    })
    const raw = JSON.stringify(lines)
    expect(raw).not.toContain(secretish)
    expect(raw).not.toContain('shipped')
  })

  it('an undeclared name not shaped like one is not recorded as the target', () => {
    const { events, emit } = capture()
    emitCustomEvent('ghp_notaname', {}, { declarations: () => declarations, emit })
    expect(events[0]).toMatchObject({ target: null, error_class: 'undeclared' })
  })

  it('with no logs.events declared, every name is undeclared', () => {
    const { events, emit } = capture()
    expect(emitCustomEvent('acme.deploy', valid, { declarations: () => ({}), emit })).toMatchObject({
      ok: false,
      reason: 'undeclared'
    })
    expect(events.filter((e) => e.kind === 'custom')).toHaveLength(0)
  })
})

describe('emitCustomEvent — redaction (O6)', () => {
  it('a secret-shaped value in a custom field is redacted, exactly as in every other event', async () => {
    const { dir, sink } = realSink()
    const token = `ghp_${'a'.repeat(36)}`
    emitCustomEvent(
      'acme.deploy',
      { ...valid, note: `token ${token}` },
      { declarations: () => declarations, emit: sink.log }
    )
    await sink.drain()
    const lines = writtenLines(dir)
    expect(lines).toHaveLength(1)
    expect((lines[0] as { fields: { note: string } }).fields.note).toBe('token <redacted>')
    expect(JSON.stringify(lines)).not.toContain(token)
  })
})
