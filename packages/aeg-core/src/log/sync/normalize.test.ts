import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { classifyStoredLine } from '../store'
import { isLowTrustVersion, normalizeStoredLine } from './normalize'
import type { DatasetRow, QuarantineRecord } from './row'

/**
 * The normaliser (`apps/cli/specs/log-sync.md`): every stored line of a
 * known schema becomes exactly one row carrying its header and subject
 * columns, with a field its schema never had marked unknown rather than
 * defaulted; every unknown-version or invalid line becomes exactly one
 * quarantine record and no row.
 */

const core = {
  ts: '2026-09-20T10:00:00.000Z',
  run_id: 'run-a',
  seq: 4,
  repo: 'atta-labs/vinaya',
  vinaya: '0.35.0',
  doctrine: 'aeg-root@deadbeef',
  host: 'loop',
  machine: 'cafebabe'
}

const v2Fields = {
  event_id: 'evt-1',
  process_id: 'proc-1',
  actor_id: 'developer',
  lineage: { run: 'loop-1', attempt: 1, parent: null },
  input_versions: { objectives_version: null, brief_hash: null, ruling_ordinal: null, policy_digest: null },
  provenance: 'parent_attributed'
}

const v3Fields = {
  work: { ref: '921', repo: 'atta-labs/vinaya', change: null, revision: null },
  flow: { id: 'vinaya', version: '1' },
  runtime: null,
  source: null
}

function operation(meta: Record<string, unknown>, subject: Record<string, unknown> = {}): string {
  return JSON.stringify({
    meta,
    subject: { issue: 921, role: 'developer', ...subject },
    kind: 'operation',
    event: 'completed',
    duration_ms: 1200,
    payload: {},
    operation: 'check',
    target: null,
    result: 'ok',
    error_class: null
  })
}

function customLine(): string {
  return JSON.stringify({
    meta: { schema: 3, ...core, ...v2Fields, ...v3Fields },
    subject: { issue: null, role: 'unattributed' },
    kind: 'custom',
    event: 'recorded',
    payload: {},
    name: 'deploy.finished',
    fields: { region: 'eu', ok: true }
  })
}

function rowOf(raw: string): DatasetRow {
  const result = normalizeStoredLine(raw)
  if (result.type !== 'row') throw new Error(`expected a row, got quarantine: ${result.record.reason}`)
  return result.row
}

function quarantineOf(raw: string): QuarantineRecord {
  const result = normalizeStoredLine(raw)
  if (result.type !== 'quarantine') throw new Error('expected a quarantine record, got a row')
  return result.record
}

describe('a schema 3 line (O1)', () => {
  const raw = operation(
    { schema: 3, ...core, ...v2Fields, ...v3Fields },
    { pr: 940, round: 2, sha: 'a'.repeat(40), objectives_version: 'ov-1' }
  )
  const row = rowOf(raw)

  it('carries identity, schema, kind, event, time, run, work reference and actor', () => {
    expect(row.identity).toBe('evt-1')
    expect(row.schema).toBe(3)
    expect(row.kind).toBe('operation')
    expect(row.event).toBe('completed')
    expect(row.time).toBe('2026-09-20T10:00:00.000Z')
    expect(row.runId).toBe('run-a')
    expect(row.seq).toBe(4)
    expect(row.workRef).toBe('921')
    expect(row.actor).toBe('developer')
  })

  it('carries every header and subject column', () => {
    expect(row.cliVersion).toBe('0.35.0')
    expect(row.doctrine).toBe('aeg-root@deadbeef')
    expect(row.flowId).toBe('vinaya')
    expect(row.flowVersion).toBe('1')
    expect(row.host).toBe('loop')
    expect(row.repo).toBe('atta-labs/vinaya')
    expect(row.provenance).toBe('parent_attributed')
    expect(row.issue).toBe(921)
    expect(row.pr).toBe(940)
    expect(row.round).toBe(2)
    expect(row.commit).toBe('a'.repeat(40))
    expect(row.role).toBe('developer')
    expect(row.objectivesVersion).toBe('ov-1')
  })

  it('keeps the family body as the payload and the whole header beside the columns', () => {
    expect(row.payload).toEqual({
      duration_ms: 1200,
      payload: {},
      operation: 'check',
      target: null,
      result: 'ok',
      error_class: null
    })
    expect(row.header.meta.lineage).toEqual({ run: 'loop-1', attempt: 1, parent: null })
    expect(row.header.subject.pr).toBe(940)
  })

  it('hashes the line as the read boundary serialises it after redaction', () => {
    const classified = classifyStoredLine(raw, '')
    if (classified.status !== 'ok') throw new Error('fixture must validate')
    expect(row.contentHash).toBe(createHash('sha256').update(classified.postLine).digest('hex'))
  })

  it('marks nothing unknown, and a subject field the line omits reads null', () => {
    expect(row.unknown).toEqual({})
    const bare = rowOf(operation({ schema: 3, ...core, ...v2Fields, ...v3Fields }))
    expect([bare.pr, bare.round, bare.commit, bare.objectivesVersion]).toEqual([null, null, null, null])
    expect(bare.unknown).toEqual({})
  })

  it('a header value the caller left null stays null and is not marked unknown', () => {
    const r = rowOf(operation({ schema: 3, ...core, ...v2Fields, ...v3Fields, work: { ...v3Fields.work, ref: null } }))
    expect(r.workRef).toBeNull()
    expect(r.unknown.workRef).toBeUndefined()
  })
})

describe('a schema 2 line (O1)', () => {
  const row = rowOf(operation({ schema: 2, ...core, ...v2Fields }))

  it('reads the work reference and flow as unknown, never as a default', () => {
    expect(row.workRef).toBeNull()
    expect(row.flowId).toBeNull()
    expect(row.flowVersion).toBeNull()
    expect(Object.keys(row.unknown).sort()).toEqual(['flowId', 'flowVersion', 'workRef'])
    expect(row.unknown.workRef).toContain('schema 2')
  })

  it('keeps the actor and provenance it does have', () => {
    expect(row.actor).toBe('developer')
    expect(row.provenance).toBe('parent_attributed')
    expect(row.identity).toBe('evt-1')
  })
})

describe('a schema 1 line (O1)', () => {
  const row = rowOf(operation({ schema: 1, ...core }))

  it('takes its identity from the run and sequence pair', () => {
    expect(row.identity).toBe('run-a:4')
  })

  it('reads every field schema 1 never had as unknown', () => {
    expect(row.actor).toBeNull()
    expect(row.workRef).toBeNull()
    expect(row.provenance).toBeNull()
    expect(Object.keys(row.unknown).sort()).toEqual([
      'actor',
      'flowId',
      'flowVersion',
      'provenance',
      'trust',
      'workRef'
    ])
    expect(row.trust).toBeNull()
  })
})

describe('trust (O3)', () => {
  it('a row from a CLI below 0.33.0 is low-trust whatever its header declares', () => {
    const row = rowOf(operation({ schema: 2, ...core, ...v2Fields, vinaya: '0.32.9' }))
    expect(row.trust).toBe('low')
    expect(row.provenance).toBe('parent_attributed')
  })

  it('a row naming no readable CLI version is low-trust', () => {
    expect(rowOf(operation({ schema: 3, ...core, ...v2Fields, ...v3Fields, vinaya: '' })).trust).toBe('low')
    expect(rowOf(operation({ schema: 3, ...core, ...v2Fields, ...v3Fields, vinaya: 'unknown' })).trust).toBe('low')
  })

  it('a schema 1 row from an old CLI is low-trust, not unknown', () => {
    const row = rowOf(operation({ schema: 1, ...core, vinaya: '0.24.0' }))
    expect(row.trust).toBe('low')
    expect(row.unknown.trust).toBeUndefined()
  })

  it('every other row carries the provenance its header declares', () => {
    for (const provenance of ['parent_attributed', 'env_correlated', 'self_reported', 'unavailable']) {
      const row = rowOf(operation({ schema: 3, ...core, ...v2Fields, ...v3Fields, provenance }))
      expect(row.trust).toBe(provenance)
    }
  })

  it('compares versions numerically, and a pre-release of 0.33.0 is below it', () => {
    expect(isLowTrustVersion('0.33.0')).toBe(false)
    expect(isLowTrustVersion('0.100.0')).toBe(false)
    expect(isLowTrustVersion('1.0.0')).toBe(false)
    expect(isLowTrustVersion('v0.34.1')).toBe(false)
    expect(isLowTrustVersion('0.9.99')).toBe(true)
    expect(isLowTrustVersion('0.33.0-rc.1')).toBe(true)
    expect(isLowTrustVersion('0.33')).toBe(true)
  })
})

describe('a family the normaliser was never taught (O1)', () => {
  it('a consumer-declared custom event is one row, its body kept as JSON', () => {
    const row = rowOf(customLine())
    expect(row.kind).toBe('custom')
    expect(row.event).toBe('recorded')
    expect(row.payload).toEqual({ payload: {}, name: 'deploy.finished', fields: { region: 'eu', ok: true } })
  })
})

describe('origin is provenance, never identity', () => {
  it('the same line from two sources has one identity and one content hash', () => {
    const raw = operation({ schema: 3, ...core, ...v2Fields, ...v3Fields })
    const a = normalizeStoredLine(raw, { source: 'folder:/logs', position: 'a.ndjson:3' })
    const b = normalizeStoredLine(raw, { source: 'server:https://logs', position: '991' })
    if (a.type !== 'row' || b.type !== 'row') throw new Error('fixture must validate')
    expect(a.row.identity).toBe(b.row.identity)
    expect(a.row.contentHash).toBe(b.row.contentHash)
    expect(a.row.origin).toEqual({ source: 'folder:/logs', position: 'a.ndjson:3' })
    expect(b.row.origin).toEqual({ source: 'server:https://logs', position: '991' })
  })
})

describe('quarantine (O2)', () => {
  it('an unknown schema version becomes one quarantine record holding its reason and raw text', () => {
    const raw = operation({ schema: 99, ...core, ...v2Fields, event_id: 'future-1' })
    const record = quarantineOf(raw)
    expect(record.status).toBe('unknown_version')
    expect(record.schema).toBe(99)
    expect(record.identity).toBe('future-1')
    expect(record.raw).toBe(raw)
    expect(record.reason).toContain('99')
    expect(record.contentHash).toBe(createHash('sha256').update(raw).digest('hex'))
  })

  it('a known version that fails validation becomes one quarantine record', () => {
    const raw = operation({ schema: 2, ...core, ...v2Fields, provenance: 'trusted-by-me' })
    const record = quarantineOf(raw)
    expect(record.status).toBe('invalid')
    expect(record.identity).toBe('evt-1')
    expect(record.raw).toBe(raw)
    expect(record.reason.length).toBeGreaterThan(0)
  })

  it('a schema 1 or 2 header on a custom event is invalid, not a row', () => {
    const raw = JSON.stringify({ ...JSON.parse(customLine()), meta: { schema: 2, ...core, ...v2Fields } })
    expect(quarantineOf(raw).status).toBe('invalid')
  })

  it('text that is not JSON becomes one quarantine record with no identity', () => {
    const record = quarantineOf('{"meta": torn')
    expect(record.status).toBe('invalid')
    expect(record.identity).toBeNull()
    expect(record.schema).toBeNull()
    expect(record.reason).toBe('not valid JSON')
  })

  it('redacts a secret in the raw text it keeps', () => {
    const token = `ghp_${'a'.repeat(36)}`
    const raw = operation({ schema: 99, ...core, ...v2Fields, event_id: 'future-2', actor_id: token })
    const record = quarantineOf(raw)
    expect(record.raw).not.toContain(token)
    expect(record.raw).toContain('<redacted>')
    expect(record.contentHash).toBe(createHash('sha256').update(record.raw).digest('hex'))
  })

  it('a schema 3 work object without a ref is invalid, not a row with an unknown work reference', () => {
    const { ref: _ref, ...workWithoutRef } = v3Fields.work
    const raw = operation({ schema: 3, ...core, ...v2Fields, ...v3Fields, work: workWithoutRef })
    expect(quarantineOf(raw).status).toBe('invalid')
  })

  it('carries its origin', () => {
    const result = normalizeStoredLine('nope', { source: 'folder:/logs', position: 'x.ndjson:1' })
    expect(result.type === 'quarantine' && result.record.origin).toEqual({
      source: 'folder:/logs',
      position: 'x.ndjson:1'
    })
  })
})

describe('a gate summary line', () => {
  const raw = JSON.stringify({
    meta: { schema: 3, ...core, ...v2Fields, ...v3Fields },
    subject: { issue: 921, role: 'developer', sha: 'b'.repeat(40) },
    kind: 'gate',
    event: 'summary',
    duration_ms: 41000,
    payload: {},
    ran: 28,
    passed: 26,
    failed: 2,
    skipped: 2,
    failed_checks: ['typecheck', 'doc-coverage']
  })

  it('becomes one row carrying the commit, with the counts and failing names in the payload', () => {
    const row = rowOf(raw)
    expect(row.kind).toBe('gate')
    expect(row.event).toBe('summary')
    expect(row.commit).toBe('b'.repeat(40))
    expect(row.payload).toMatchObject({ ran: 28, passed: 26, failed: 2, skipped: 2, duration_ms: 41000 })
    expect((row.payload as { failed_checks: string[] }).failed_checks).toEqual(['typecheck', 'doc-coverage'])
  })
})

describe('a final effect line', () => {
  it('becomes one row whose payload carries the outcome of the write', () => {
    const raw = JSON.stringify({
      meta: { schema: 3, ...core, ...v2Fields, ...v3Fields },
      subject: { issue: 921, role: 'developer' },
      kind: 'effect',
      event: 'verified',
      payload: {},
      effect_id: 'k1',
      target: { kind: 'pr-comment', ref: 'pr:1' },
      outcome: 'failure'
    })
    const row = rowOf(raw)
    expect(row.kind).toBe('effect')
    expect(row.event).toBe('verified')
    expect(row.payload).toMatchObject({ effect_id: 'k1', outcome: 'failure' })
  })
})
