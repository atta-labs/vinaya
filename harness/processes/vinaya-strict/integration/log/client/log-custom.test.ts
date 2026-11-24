import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { storedEvents, type StoredEvent } from '../../../../../kernel/gates/checks/runner/local-copy-probe.js'
import type { CustomEventDeclarations } from '../../../../../kernel/log/custom'
import { connect, type LogHandle } from '../../../../../../packages/log-sdk/src/index.js'
import { resolveLogsSetting, VinayaConfigSchema } from '../../config/compose.js'
import { emitCustomEvent } from '../../../../../kernel/log/client/log-custom.js'
import { isolatedLocalCopy } from './local-copy-fixture.js'

const declarations: CustomEventDeclarations = {
  'acme.deploy': { fields: { env: ['prod', 'staging'], count: 'number', note: 'text', ok: 'boolean' } }
}
const valid = { env: 'prod', count: 2, note: 'shipped', ok: true }

const REPOSITORY = 'atta-labs/vinaya'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

/** A real Log SDK handle writing a local copy in a fresh folder, with the team's declarations in force. */
function realHandle(): { handle: LogHandle; stored: () => Promise<StoredEvent[]> } {
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-log-custom-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const handle = connect({
    runId: 'custom-test-run',
    repository: REPOSITORY,
    repoRoot: join(dir, 'repo'),
    runtimeDir: dir,
    destination: { folder: join(dir, 'logs'), events: declarations },
    onError: () => {}
  })
  return {
    handle,
    stored: async () => {
      await handle.shutdown()
      return storedEvents(join(dir, 'logs', 'atta-labs-vinaya'))
    }
  }
}

describe('logs.events — the declaration in vinaya.config.json (O1, O2)', () => {
  it('loads a config declaring events under logs, with no destination set', () => {
    const parsed = VinayaConfigSchema.safeParse({ logs: { events: declarations } })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect((parsed.data.logs || undefined)?.events).toEqual(declarations)
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

describe('emitCustomEvent — a declared event (O1, O4)', () => {
  it('writes exactly one record: the event named for the declaration, carrying the declared fields', async () => {
    const { handle, stored } = realHandle()
    expect(emitCustomEvent('acme.deploy', valid, { declarations: () => declarations, handle: () => handle })).toEqual({
      ok: true,
      name: 'acme.deploy'
    })
    const events = await stored()
    expect(events).toHaveLength(1)
    expect(events[0]?.name).toBe('acme.deploy')
    expect(JSON.stringify(events[0]?.attributes)).toContain('shipped')
  })

  it('writes no earlier-format file for the event', async () => {
    const copy = isolatedLocalCopy()
    try {
      emitCustomEvent('acme.deploy', valid, { declarations: () => declarations, handle: () => undefined })
      expect(copy.earlierFormatFiles()).toEqual([])
    } finally {
      copy.restore()
    }
  })

  it('writes nothing while recording is off, and still answers ok', () => {
    expect(
      emitCustomEvent('acme.deploy', valid, { declarations: () => declarations, handle: () => undefined })
    ).toEqual({ ok: true, name: 'acme.deploy' })
  })
})

describe('emitCustomEvent — a refused event (O2, O4)', () => {
  const cases: Array<[string, string, Record<string, unknown>, string, string[]]> = [
    ['undeclared', 'acme.other', valid, 'undeclared', []],
    ['missing', 'acme.deploy', { env: 'prod', count: 2, ok: true }, 'missing_field', ['note']],
    ['extra', 'acme.deploy', { ...valid, zone: 'eu-secret-zone' }, 'extra_field', ['zone']],
    ['wrong type', 'acme.deploy', { ...valid, count: 'two-secret-count' }, 'wrong_type', ['count']]
  ]

  for (const [label, name, fields, reason, fieldNames] of cases) {
    it(`${label}: no custom record; one command.completed refused with the reason as its error kind; the caller gets the refusal`, async () => {
      const { handle, stored } = realHandle()
      const result = emitCustomEvent(name, fields, { declarations: () => declarations, handle: () => handle })
      expect(result).toEqual({ ok: false, reason: reason as never, fieldNames })
      const events = await stored()
      expect(events.map((e) => e.name)).toEqual(['vinaya.command.completed'])
      expect(events[0]?.attributes).toMatchObject({
        'vinaya.outside.action': 'log.emit',
        'vinaya.outside.target': name,
        'vinaya.result': 'refused',
        'error.type': reason
      })
      expect(JSON.stringify(events)).not.toContain('eu-secret-zone')
      expect(JSON.stringify(events)).not.toContain('two-secret-count')
    })
  }

  it('the refusal carries no field value or field name', async () => {
    const { handle, stored } = realHandle()
    const secretish = 'hunter2-value-never-logged'
    const result = emitCustomEvent(
      'acme.deploy',
      { ...valid, note: 42, extra_note: secretish },
      { declarations: () => declarations, handle: () => handle }
    )
    expect(result).toMatchObject({ ok: false, reason: 'extra_field', fieldNames: ['extra_note'] })
    const raw = JSON.stringify(await stored())
    expect(raw).not.toContain(secretish)
    expect(raw).not.toContain('extra_note')
    expect(raw).not.toContain('shipped')
  })

  it('an undeclared name not shaped like one is not recorded as the target', async () => {
    const { handle, stored } = realHandle()
    emitCustomEvent('ghp_notaname', {}, { declarations: () => declarations, handle: () => handle })
    const events = await stored()
    expect(events).toHaveLength(1)
    expect(events[0]?.attributes['vinaya.outside.target']).toBeUndefined()
    expect(events[0]?.attributes['error.type']).toBe('undeclared')
  })

  it('with no logs.events declared, every name is undeclared and no custom record is written', async () => {
    const { handle, stored } = realHandle()
    expect(emitCustomEvent('acme.deploy', valid, { declarations: () => ({}), handle: () => handle })).toMatchObject({
      ok: false,
      reason: 'undeclared'
    })
    expect((await stored()).map((e) => e.name)).toEqual(['vinaya.command.completed'])
  })

  it('writes no earlier-format file for a refusal', async () => {
    const copy = isolatedLocalCopy()
    try {
      emitCustomEvent('acme.other', valid, { declarations: () => declarations, handle: () => undefined })
      expect(copy.earlierFormatFiles()).toEqual([])
    } finally {
      copy.restore()
    }
  })
})

describe('emitCustomEvent — redaction (O6)', () => {
  it('a secret-shaped value in a custom field is redacted, exactly as in every other record', async () => {
    const { handle, stored } = realHandle()
    const token = `ghp_${'a'.repeat(36)}`
    emitCustomEvent(
      'acme.deploy',
      { ...valid, note: `token ${token}` },
      { declarations: () => declarations, handle: () => handle }
    )
    const events = await stored()
    expect(events).toHaveLength(1)
    expect(JSON.stringify(events)).not.toContain(token)
  })
})
