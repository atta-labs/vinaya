import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

/**
 * Fault-driven scenario fixtures (task-log-v1 7, Issue #567, O2). Each
 * scenario is the ordered sequence of raw events a real producer boundary
 * (`apps/cli/specs/log.md`) would append to one task's outbox for that
 * exit — built from the same field shapes those producers actually emit,
 * never a synthetic shape this schema would refuse in production. Every
 * scenario is proved two ways: every line the store holds re-validates
 * (`page.diagnostics.ok` covers the whole batch, none `invalid` or
 * `unknown_version`), and the exact kind/event sequence a reader would need
 * to reconstruct what happened is present, in order. `packages/aeg-core/src/log/`
 * is the pure policy layer (no filesystem, no network, no process —
 * `apps/cli/specs/surface.md` "The rule") — these fixtures run against
 * `createFixtureStore()` alone, so "unavailable telemetry" is not a special
 * code path to simulate: nothing here ever calls a publish/flush function,
 * proving capture never depended on one being reachable, configured, or
 * even defined.
 */

let seqCounter = 0
function nextSeq(): number {
  seqCounter += 1
  return seqCounter
}

/** A fresh `schema: 2` header for one scenario's run, auto-incrementing `seq`/`event_id`. */
function scenarioMeta(runId: string): Record<string, unknown> {
  const seq = nextSeq()
  return metaV2(runId, seq, `${runId}-${seq}`)
}

const SUBJECT = { issue: 567, role: 'developer' as const }

function dispatchEvent(
  runId: string,
  event: 'dispatched' | 'outcome_received' | 'dispatch_failed',
  extra: Record<string, unknown>
): Record<string, unknown> {
  return {
    meta: scenarioMeta(runId),
    subject: SUBJECT,
    kind: 'dispatch',
    payload: {},
    target_role: 'developer',
    model: 'sonnet',
    effect_id: 'effect-1',
    event,
    ...extra
  }
}

function roleAttemptEvent(
  runId: string,
  outcome: string,
  usage: { input: number; output: number } | null = null
): Record<string, unknown> {
  return {
    meta: scenarioMeta(runId),
    subject: SUBJECT,
    kind: 'role_attempt',
    payload: {},
    event: 'attempted',
    actor: 'claude',
    attempt: 1,
    effect_id: 'effect-1',
    model: 'sonnet',
    outcome,
    usage
  }
}

function usageEvent(
  runId: string,
  units: { input: number | null; output: number | null; cache: number | null },
  unknownReason: string | null = null
): Record<string, unknown> {
  return {
    meta: scenarioMeta(runId),
    subject: SUBJECT,
    kind: 'usage',
    payload: {},
    event: 'observed',
    model: 'sonnet',
    source: 'claude',
    semantics: 'cumulative',
    units,
    unknown_reason: unknownReason
  }
}

function loopEvent(
  runId: string,
  loopId: string,
  event: string,
  extra: Record<string, unknown>
): Record<string, unknown> {
  return {
    meta: scenarioMeta(runId),
    subject: SUBJECT,
    kind: 'dev_review_loop',
    payload: {},
    loop_id: loopId,
    event,
    ...extra
  }
}

function gateEvent(runId: string, outcome: string, reason?: string): Record<string, unknown> {
  return {
    meta: scenarioMeta(runId),
    subject: { issue: 567, role: 'unattributed' as const },
    kind: 'gate',
    payload: {},
    check: 'typecheck',
    check_version: '1',
    policy_version: null,
    input_fingerprint: 'sha256:abc123',
    event: 'checked',
    outcome,
    ...(reason !== undefined ? { reason } : {})
  }
}

function effectEvent(
  runId: string,
  event: 'attempted' | 'observed' | 'verified',
  outcome?: string
): Record<string, unknown> {
  return {
    meta: scenarioMeta(runId),
    subject: SUBJECT,
    kind: 'effect',
    payload: {},
    effect_id: 'effect-pause-comment',
    target: { kind: 'pr_comment', ref: 'pr-42' },
    event,
    ...(outcome !== undefined ? { outcome } : {})
  }
}

/** Appends `events` to a fresh store and returns the fully-read-back page — the assertion surface every scenario below shares. */
function runScenario(events: Record<string, unknown>[]) {
  const store = createFixtureStore()
  store.append(events)
  const page = store.readPage(null, events.length)
  return { store, page }
}

/** The `kind.event` sequence a page actually stored, in order — what a reader reconstructing the scenario from raw events would see. */
function storedSequence(page: ReturnType<typeof runScenario>['page']): string[] {
  return page.records.map((r) => {
    if (r.status !== 'ok') return `NOT_OK:${r.status}`
    const e = r.event as { kind: string; event: string }
    return `${e.kind}.${e.event}`
  })
}

describe('fault-driven scenario fixtures (O2, task-log-v1 7, Issue #567)', () => {
  it('success — a clean dispatch round-trips as dispatched → role_attempt.completed → usage.observed → outcome_received', () => {
    const runId = 'scenario-success'
    const events = [
      dispatchEvent(runId, 'dispatched', { prompt_hash: 'sha256:prompt' }),
      roleAttemptEvent(runId, 'completed', { input: 1000, output: 200 }),
      usageEvent(runId, { input: 1000, output: 200, cache: 0 }),
      dispatchEvent(runId, 'outcome_received', { outcome: { type: 'completed' }, usage: { input: 1000, output: 200 } })
    ]
    const { page } = runScenario(events)
    expect(page.diagnostics.ok).toBe(events.length)
    expect(page.diagnostics.invalid).toBe(0)
    expect(storedSequence(page)).toEqual([
      'dispatch.dispatched',
      'role_attempt.attempted',
      'usage.observed',
      'dispatch.outcome_received'
    ])
  })

  it('rejection — a capability refusal round-trips as dispatched → role_attempt.capability_refused → dispatch_failed', () => {
    const runId = 'scenario-rejection'
    const events = [
      dispatchEvent(runId, 'dispatched', { prompt_hash: 'sha256:prompt' }),
      roleAttemptEvent(runId, 'capability_refused', null),
      dispatchEvent(runId, 'dispatch_failed', { reason: 'refused', usage: null })
    ]
    const { page } = runScenario(events)
    expect(page.diagnostics.ok).toBe(events.length)
    expect(storedSequence(page)).toEqual(['dispatch.dispatched', 'role_attempt.attempted', 'dispatch.dispatch_failed'])
    const failed = page.records[2]
    expect(failed?.status === 'ok' && (failed.event as { reason?: string }).reason).toBe('refused')
  })

  it('infrastructure failure — a missing reviewer artifact becomes a role_attempt.infrastructure_failed and a driver-decided pause', () => {
    const runId = 'scenario-infra-failure'
    const loopId = 'loop-infra'
    const events = [
      roleAttemptEvent(runId, 'infrastructure_failed', null),
      loopEvent(runId, loopId, 'stop_condition_met', { round: 2, condition: 'principal_stop' }),
      loopEvent(runId, loopId, 'paused', { round: 2, reason: 'principal_item' }),
      loopEvent(runId, loopId, 'round_ended', {
        round: 2,
        base_head: 'sha1',
        head: 'sha2',
        files_changed: 0,
        insertions: 0,
        deletions: 0,
        wall_ms: 5000,
        outcome: 'escalated'
      }),
      loopEvent(runId, loopId, 'journal_finalized', {
        rounds: 2,
        total_wall_ms: 60000,
        time_to_green_ms: null,
        files_changed_total: 3,
        final_head: 'sha2',
        result: 'stopped'
      })
    ]
    const { page } = runScenario(events)
    expect(page.diagnostics.ok).toBe(events.length)
    expect(storedSequence(page)).toEqual([
      'role_attempt.attempted',
      'dev_review_loop.stop_condition_met',
      'dev_review_loop.paused',
      'dev_review_loop.round_ended',
      'dev_review_loop.journal_finalized'
    ])
  })

  it('retry — an idempotent effect write that fails once, retries, and succeeds is stored as attempted/observed(failure)/attempted/observed(success)/verified', () => {
    const runId = 'scenario-retry'
    const events = [
      effectEvent(runId, 'attempted'),
      effectEvent(runId, 'observed', 'failure'),
      effectEvent(runId, 'attempted'),
      effectEvent(runId, 'observed', 'success'),
      effectEvent(runId, 'verified', 'success')
    ]
    const { page } = runScenario(events)
    expect(page.diagnostics.ok).toBe(events.length)
    expect(storedSequence(page)).toEqual([
      'effect.attempted',
      'effect.observed',
      'effect.attempted',
      'effect.observed',
      'effect.verified'
    ])
    // Every line shares the same effect_id — the evidence identity a reader
    // joins the retry's two attempts on (apps/cli/specs/log.md § "effect").
    const effectIds = page.records.map((r) => (r.status === 'ok' ? (r.event as { effect_id: string }).effect_id : null))
    expect(new Set(effectIds).size).toBe(1)
  })

  it('pause — a confidence collapse stores stop_condition_met(confidence) → paused → round_ended → journal_finalized(stopped)', () => {
    const runId = 'scenario-pause'
    const loopId = 'loop-pause'
    const events = [
      loopEvent(runId, loopId, 'stop_condition_met', { round: 2, condition: 'confidence' }),
      loopEvent(runId, loopId, 'paused', { round: 2, reason: 'principal_item' }),
      loopEvent(runId, loopId, 'round_ended', {
        round: 2,
        base_head: 'sha1',
        head: 'sha1',
        files_changed: 0,
        insertions: 0,
        deletions: 0,
        wall_ms: 1200,
        outcome: 'changes_requested'
      }),
      loopEvent(runId, loopId, 'journal_finalized', {
        rounds: 2,
        total_wall_ms: 30000,
        time_to_green_ms: null,
        files_changed_total: 5,
        final_head: 'sha1',
        result: 'stopped'
      })
    ]
    const { page } = runScenario(events)
    expect(page.diagnostics.ok).toBe(events.length)
    const condition = page.records[0]
    expect(condition?.status === 'ok' && (condition.event as { condition: string }).condition).toBe('confidence')
  })

  it('stale input — a finding that reappeared after being reported resolved stores findings_compared(recurring) → stop_condition_met(reappearance) → paused', () => {
    const runId = 'scenario-stale-input'
    const loopId = 'loop-stale'
    const events = [
      loopEvent(runId, loopId, 'findings_compared', { round: 3, open: [], resolved: [], new: [], recurring: ['F1'] }),
      loopEvent(runId, loopId, 'stop_condition_met', { round: 3, condition: 'reappearance' }),
      loopEvent(runId, loopId, 'paused', { round: 3, reason: 'principal_item' })
    ]
    const { page } = runScenario(events)
    expect(page.diagnostics.ok).toBe(events.length)
    const compared = page.records[0]
    expect(compared?.status === 'ok' && (compared.event as { recurring: string[] }).recurring).toEqual(['F1'])
    const stopped = page.records[1]
    expect(stopped?.status === 'ok' && (stopped.event as { condition: string }).condition).toBe('reappearance')
  })

  it('cancellation — an escalation pause later resolved by --cancel stores paused, then a separate-process cancelled(by: principal)', () => {
    const runId = 'scenario-cancel'
    const pauseLoopId = 'loop-cancel-pause'
    const cancelLoopId = 'loop-cancel-resolve'
    const events = [
      loopEvent(runId, pauseLoopId, 'paused', { round: 2, reason: 'escalation' }),
      // A --cancel is its own process — a fresh loop_id, no round history of
      // its own (apps/cli/specs/loop.md § "Escalation, resolution, and --cancel").
      loopEvent(runId, cancelLoopId, 'cancelled', { round: 2, by: 'principal' })
    ]
    const { page } = runScenario(events)
    expect(page.diagnostics.ok).toBe(events.length)
    const cancelled = page.records[1]
    expect(cancelled?.status === 'ok' && (cancelled.event as { by: string }).by).toBe('principal')
    expect(storedSequence(page)).toEqual(['dev_review_loop.paused', 'dev_review_loop.cancelled'])
  })

  it('recovery — a bare --resume past a recoverable infrastructure hiccup stores resumed(by: driver), never fabricating a principal ruling that was never read', () => {
    const runId = 'scenario-recovery'
    const loopId = 'loop-recovery'
    const events = [loopEvent(runId, loopId, 'resumed', { round: 2, by: 'driver' })]
    const { page } = runScenario(events)
    expect(page.diagnostics.ok).toBe(1)
    const resumed = page.records[0]
    expect(resumed?.status === 'ok' && (resumed.event as { by: string }).by).toBe('driver')
  })

  it('unavailable telemetry — the success scenario is fully captured with no publish/flush call ever made', () => {
    // No function in this test file, nor in ./store.ts itself, calls a
    // publish/flush/forge-write mechanism — capture and validation happen
    // entirely inside the fixture store. This is the structural proof, not
    // a simulation: `flushOutbox`/`vinaya.config.json`'s `logPublish`
    // (apps/cli/specs/log.md § "The flush") are a SEPARATE, later, optional
    // step this file never reaches, and every event below is still stored,
    // valid, and complete without it.
    const storeSource = readFileSync(join(import.meta.dir, 'store.ts'), 'utf8')
    expect(storeSource).not.toContain('logPublish')
    expect(storeSource).not.toContain('flushOutbox')
    expect(storeSource).not.toMatch(/\bfetch\(/)

    const runId = 'scenario-telemetry-unavailable'
    const events = [
      dispatchEvent(runId, 'dispatched', { prompt_hash: 'sha256:prompt' }),
      roleAttemptEvent(runId, 'completed', { input: 500, output: 100 }),
      usageEvent(runId, { input: 500, output: 100, cache: 0 }),
      dispatchEvent(runId, 'outcome_received', { outcome: { type: 'completed' }, usage: { input: 500, output: 100 } })
    ]
    const { page, store } = runScenario(events)
    expect(page.diagnostics.ok).toBe(events.length)
    expect(page.diagnostics.invalid).toBe(0)
    expect(page.diagnostics.unknownVersion).toBe(0)
    expect(store.size()).toBe(events.length)
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
