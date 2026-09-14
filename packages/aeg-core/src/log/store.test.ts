import { describe, expect, it } from 'vitest'
import { classifyStoredLine, createFixtureStore, KNOWN_SCHEMA_VERSIONS, readPageFrom, recordIdentity } from './store'

/**
 * The storage contract's adversarial fault cases (`task-log-v1` task 2,
 * Issue #562, O1–O3), all provable against the pure fixture backend with no
 * I/O: concurrent append, a retry after a lost acknowledgement collapsing to
 * one record, an overflow that is reported rather than silent, an
 * unknown-version record kept for diagnosis, and redaction applied at both
 * the sink and the transport boundary.
 */

const HOME = '/Users/dev'

/** A valid `schema: 2` header with the given identity fields. */
function metaV2(runId: string, seq: number, eventId: string): Record<string, unknown> {
  return {
    schema: 2,
    ts: '2026-09-14T00:00:00.000Z',
    run_id: runId,
    seq,
    repo: 'atta-labs/vinaya',
    vinaya: '0.24.0',
    doctrine: 'aeg-root@deadbeef',
    host: 'cli',
    machine: 'cafebabe',
    event_id: eventId,
    process_id: 'proc-1',
    actor_id: 'developer',
    lineage: { run: null, attempt: null, parent: null },
    input_versions: { objectives_version: null, brief_hash: null, ruling_ordinal: null, policy_digest: null },
    provenance: 'env_correlated'
  }
}

/** A valid `forge_write` `refused` event carrying `reason` — a free-text field a secret can land in. */
function forgeWrite(meta: Record<string, unknown>, reason: string): Record<string, unknown> {
  return {
    meta,
    subject: { issue: 562, role: 'developer' },
    kind: 'forge_write',
    event: 'refused',
    payload: {},
    op: 'issue.comment',
    target: { issue: 562 },
    reason
  }
}

describe('recordIdentity', () => {
  it('prefers event_id (schema 2), falls back to run_id:seq (schema 1)', () => {
    expect(recordIdentity({ meta: { event_id: 'e-1', run_id: 'r', seq: 3 } })).toBe('e-1')
    expect(recordIdentity({ meta: { run_id: 'r', seq: 3 } })).toBe('r:3')
  })

  it('is null when neither identity is derivable', () => {
    expect(recordIdentity({ meta: {} })).toBeNull()
    expect(recordIdentity('not an object')).toBeNull()
    expect(recordIdentity({ meta: { run_id: 'r' } })).toBeNull()
  })
})

describe('concurrent append (O2)', () => {
  it('two writers interleaving distinct records: every identity lands once, in append order', () => {
    const store = createFixtureStore()
    const a = (seq: number) => JSON.stringify(forgeWrite(metaV2('writerA', seq, `A-${seq}`), 'ok'))
    const b = (seq: number) => JSON.stringify(forgeWrite(metaV2('writerB', seq, `B-${seq}`), 'ok'))

    // Interleaved appends stand in for two processes racing on one store.
    store.append([a(0)])
    store.append([b(0)])
    store.append([a(1)])
    store.append([b(1)])

    const page = store.readPage(null, 100)
    expect(page.diagnostics.ok).toBe(4)
    expect(page.records.map((r) => (r.status === 'ok' ? r.identity : null))).toEqual(['A-0', 'B-0', 'A-1', 'B-1'])
  })

  it('the same record appended by two writers is stored once, the second reported as a duplicate', () => {
    const store = createFixtureStore()
    const line = JSON.stringify(forgeWrite(metaV2('writerA', 0, 'shared-id'), 'ok'))

    const first = store.append([line])
    const second = store.append([line])

    expect(first.appended).toEqual(['shared-id'])
    expect(second.appended).toEqual([])
    expect(second.duplicates).toEqual(['shared-id'])
    expect(store.size()).toBe(1)
  })
})

describe('retry after a lost acknowledgement collapses to one record (O2)', () => {
  it('re-posting an un-acknowledged batch to the forge yields exactly one record per identity', () => {
    const outbox = createFixtureStore()
    const forge = createFixtureStore()
    const line = JSON.stringify(forgeWrite(metaV2('r1', 0, 'evt-1'), 'ok'))
    outbox.append([line])

    // First flush attempt: read the page, post it to the forge, then the
    // process dies BEFORE acknowledging — the acknowledgement is lost.
    const firstPage = outbox.readPage(null, 100)
    forge.append(firstPage.records.map((r) => (r.status === 'ok' ? r.postLine : '')).filter(Boolean))
    // (no outbox.acknowledge(...) here — this is the lost-ack failure)

    // Retry: the record is still in the outbox, so it is read and posted
    // again. Because the forge dedups by identity, it does not double.
    const retryPage = outbox.readPage(null, 100)
    expect(retryPage.diagnostics.ok).toBe(1)
    const retry = forge.append(retryPage.records.map((r) => (r.status === 'ok' ? r.postLine : '')).filter(Boolean))
    expect(retry.appended).toEqual([])
    expect(retry.duplicates).toEqual(['evt-1'])
    expect(forge.size()).toBe(1)

    // Only after the forge confirms does the outbox acknowledge — and only
    // that identity is removed.
    expect(outbox.acknowledge(['evt-1'])).toBe(1)
    expect(outbox.size()).toBe(0)
  })

  it('acknowledge removes only the named identities, leaving the rest', () => {
    const store = createFixtureStore()
    store.append([
      JSON.stringify(forgeWrite(metaV2('r1', 0, 'keep-1'), 'ok')),
      JSON.stringify(forgeWrite(metaV2('r1', 1, 'drop-1'), 'ok')),
      JSON.stringify(forgeWrite(metaV2('r1', 2, 'keep-2'), 'ok'))
    ])

    expect(store.acknowledge(['drop-1'])).toBe(1)
    const page = store.readPage(null, 100)
    expect(page.records.map((r) => (r.status === 'ok' ? r.identity : null))).toEqual(['keep-1', 'keep-2'])
  })
})

describe('overflow is reported, not silent (O2)', () => {
  it('appending past capacity drops the oldest and names it in the overflow diagnostic', () => {
    const store = createFixtureStore({ capacity: 2 })
    const out = store.append([
      JSON.stringify(forgeWrite(metaV2('r1', 0, 'old'), 'ok')),
      JSON.stringify(forgeWrite(metaV2('r1', 1, 'mid'), 'ok')),
      JSON.stringify(forgeWrite(metaV2('r1', 2, 'new'), 'ok'))
    ])

    expect(out.overflow).not.toBeNull()
    expect(out.overflow?.dropped).toBe(1)
    expect(out.overflow?.droppedIdentities).toEqual(['old'])
    expect(store.size()).toBe(2)
    const page = store.readPage(null, 100)
    expect(page.records.map((r) => (r.status === 'ok' ? r.identity : null))).toEqual(['mid', 'new'])
  })

  it('an unbounded store never overflows', () => {
    const store = createFixtureStore()
    const out = store.append(
      Array.from({ length: 50 }, (_, i) => JSON.stringify(forgeWrite(metaV2('r1', i, `e-${i}`), 'ok')))
    )
    expect(out.overflow).toBeNull()
    expect(store.size()).toBe(50)
  })
})

describe('unknown-version records are kept for diagnosis (O3)', () => {
  it('a schema version this build does not know is preserved, not dropped, and reported', () => {
    const future = JSON.stringify({
      meta: { schema: 3, run_id: 'rF', seq: 0, event_id: 'future-1' },
      kind: 'something_new',
      payload: { anything: true }
    })
    const store = createFixtureStore()
    store.append([JSON.stringify(forgeWrite(metaV2('r1', 0, 'known'), 'ok')), future])

    const page = store.readPage(null, 100)
    expect(page.diagnostics.ok).toBe(1)
    expect(page.diagnostics.unknownVersion).toBe(1)
    const unknown = page.records.find((r) => r.status === 'unknown_version')
    expect(unknown).toBeDefined()
    if (unknown?.status === 'unknown_version') {
      expect(unknown.schema).toBe(3)
      expect(unknown.raw).toContain('something_new')
      expect(unknown.identity).toBe('future-1')
    }
  })

  it('KNOWN_SCHEMA_VERSIONS mirrors the discriminated header union', () => {
    expect([...KNOWN_SCHEMA_VERSIONS]).toEqual([1, 2])
  })

  it('a corrupt line (known version, failed validation) is `invalid`, distinct from unknown_version', () => {
    const corrupt = JSON.stringify({ meta: { schema: 1, run_id: 'rC', seq: 0 }, kind: 'forge_write' })
    const rec = classifyStoredLine(corrupt, HOME)
    expect(rec.status).toBe('invalid')

    const notJson = classifyStoredLine('{not json', HOME)
    expect(notJson.status).toBe('invalid')
  })

  it('a schema-2 line with an out-of-range provenance is invalid (provenance is validated)', () => {
    const bad = forgeWrite(metaV2('r1', 0, 'e'), 'ok')
    ;(bad.meta as Record<string, unknown>).provenance = 'totally_made_up'
    const rec = classifyStoredLine(JSON.stringify(bad), HOME)
    expect(rec.status).toBe('invalid')
  })

  it('a valid schema-2 line surfaces its provenance on read', () => {
    const rec = classifyStoredLine(JSON.stringify(forgeWrite(metaV2('r1', 0, 'e'), 'ok')), HOME)
    expect(rec.status).toBe('ok')
    if (rec.status === 'ok') expect(rec.provenance).toBe('env_correlated')
  })
})

describe('redaction at both the sink and the transport boundary (O3)', () => {
  const secret = `ghp_${'A'.repeat(20)}`

  it('a secret in an appended record is redacted in what the store holds (sink boundary)', () => {
    const store = createFixtureStore({ home: HOME })
    store.append([forgeWrite(metaV2('r1', 0, 'e-1'), `gh auth failed for ${secret}`)])

    const page = store.readPage(null, 1)
    const rec = page.records[0]
    expect(rec?.status).toBe('ok')
    if (rec?.status === 'ok') {
      expect(rec.postLine).not.toContain(secret)
      expect(rec.postLine).toContain('<redacted>')
    }
  })

  it('a raw line that reached storage un-redacted is still redacted on read-back (transport boundary)', () => {
    // classifyStoredLine models the transport boundary: even a line that
    // escaped sink redaction (a manual edit, a redact.ts gap since it was
    // written) is redacted again before it is ever posted.
    const unredacted = JSON.stringify(forgeWrite(metaV2('r1', 0, 'e-2'), `token ${secret}`))
    const rec = classifyStoredLine(unredacted, HOME)
    expect(rec.status).toBe('ok')
    if (rec.status === 'ok') {
      expect(rec.postLine).not.toContain(secret)
      expect(rec.postLine).toContain('<redacted>')
    }
  })

  it('an absolute home path is rewritten to ~ on read-back', () => {
    const rec = classifyStoredLine(JSON.stringify(forgeWrite(metaV2('r1', 0, 'e-3'), `${HOME}/secret/file`)), HOME)
    expect(rec.status).toBe('ok')
    if (rec.status === 'ok') expect(rec.postLine).toContain('~/secret/file')
  })
})

describe('readPageFrom paging', () => {
  it('pages through a backing array with a cursor and reports nextCursor', () => {
    const lines = Array.from({ length: 5 }, (_, i) => JSON.stringify(forgeWrite(metaV2('r1', i, `e-${i}`), 'ok')))
    const first = readPageFrom(lines, null, 2, HOME)
    expect(first.records.length).toBe(2)
    expect(first.nextCursor).toBe(2)
    const second = readPageFrom(lines, first.nextCursor, 2, HOME)
    expect(second.records.length).toBe(2)
    expect(second.nextCursor).toBe(4)
    const last = readPageFrom(lines, second.nextCursor, 2, HOME)
    expect(last.records.length).toBe(1)
    expect(last.nextCursor).toBeNull()
  })
})
