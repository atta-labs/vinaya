/**
 * The cache contract's behaviours, written once (`apps/cli/specs/log-sync.md`).
 * Every `LogCache` backend's own test runs each case against a fresh
 * instance of that backend:
 *
 *     for (const c of cacheContractCases) it(c.name, () => c.run(createMyCache()))
 *
 * A case throws on the first broken expectation. No test framework is
 * imported here, so a backend in any package can run the same list.
 */

import type { LogCache } from './contracts'
import { unknownBecause, known } from './measured'
import { normalizeStoredLine } from './normalize'
import type { NormalizedLine, RowOrigin } from './row'

export type CacheContractCase = {
  name: string
  run(cache: LogCache): void
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`cache contract: ${message}`)
}

function same(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  check(a === e, `${message} — expected ${e}, got ${a}`)
}

/** A valid schema 3 `operation` line with the given identity, time and result. */
function line(eventId: string, ts: string, result = 'ok', origin: RowOrigin | null = null): NormalizedLine {
  const raw = JSON.stringify({
    meta: {
      schema: 3,
      ts,
      run_id: 'contract-run',
      seq: 0,
      repo: 'owner/repo',
      vinaya: '0.36.0',
      doctrine: 'aeg-root@contract',
      host: 'cli',
      machine: 'contract-machine',
      event_id: eventId,
      process_id: 'contract-process',
      actor_id: null,
      lineage: { run: null, attempt: null, parent: null },
      input_versions: { objectives_version: null, brief_hash: null, ruling_ordinal: null, policy_digest: null },
      provenance: 'unavailable',
      work: { ref: null, repo: null, change: null, revision: null },
      flow: { id: 'vinaya', version: null },
      runtime: null,
      source: null
    },
    subject: { issue: null, role: 'unattributed' },
    kind: 'operation',
    event: 'completed',
    payload: {},
    operation: 'contract',
    target: null,
    result,
    error_class: null
  })
  const normalized = normalizeStoredLine(raw, origin)
  check(normalized.type === 'row', 'fixture line must normalise into a row')
  return normalized
}

function quarantined(raw: string, origin: RowOrigin | null = null): NormalizedLine {
  const normalized = normalizeStoredLine(raw, origin)
  check(normalized.type === 'quarantine', 'fixture line must normalise into a quarantine record')
  return normalized
}

const T1 = '2026-09-20T10:00:00.000Z'
const T2 = '2026-09-20T11:00:00.000Z'

export const cacheContractCases: readonly CacheContractCase[] = [
  {
    name: 'storing one identity twice leaves one row',
    run(cache) {
      same(
        cache.put(line('e-1', T1, 'ok', { source: 'a', position: '1' })),
        { type: 'row', result: 'inserted' },
        'first put'
      )
      same(
        cache.put(line('e-1', T1, 'ok', { source: 'b', position: '9' })),
        { type: 'row', result: 'duplicate' },
        'second put'
      )
      const rows = cache.dataset().rows()
      same(
        rows.map((r) => r.identity),
        ['e-1'],
        'rows'
      )
      same(rows[0]?.origin, { source: 'a', position: '1' }, 'the first origin is kept')
      same(cache.edits(), [], 'no edit for identical content')
    }
  },
  {
    name: 'storing one identity with different content keeps the first row and records one edit',
    run(cache) {
      const first = line('e-1', T1, 'ok')
      const edited = line('e-1', T1, 'error', { source: 'b', position: '2' })
      cache.put(first)
      same(cache.put(edited), { type: 'row', result: 'edited' }, 'edited put')
      same(cache.put(edited), { type: 'row', result: 'edited' }, 'repeated edited put')
      const rows = cache.dataset().rows()
      same(rows.length, 1, 'row count')
      check(first.type === 'row' && edited.type === 'row', 'fixtures are rows')
      if (first.type !== 'row' || edited.type !== 'row') return
      same(rows[0]?.contentHash, first.row.contentHash, 'the kept row is the first')
      same(
        cache.edits(),
        [
          {
            identity: 'e-1',
            keptHash: first.row.contentHash,
            editedHash: edited.row.contentHash,
            origin: { source: 'b', position: '2' }
          }
        ],
        'edits'
      )
    }
  },
  {
    name: 'rows read back ordered by time, then identity',
    run(cache) {
      cache.put(line('e-3', T2))
      cache.put(line('e-2', T1))
      cache.put(line('e-1', T2))
      same(
        cache
          .dataset()
          .rows()
          .map((r) => r.identity),
        ['e-2', 'e-1', 'e-3'],
        'order'
      )
    }
  },
  {
    name: 'a row reads back exactly as stored',
    run(cache) {
      const stored = line('e-1', T1, 'ok', { source: 'a', position: '7' })
      cache.put(stored)
      check(stored.type === 'row', 'fixture is a row')
      if (stored.type !== 'row') return
      same(cache.dataset().rows()[0], stored.row, 'row')
    }
  },
  {
    name: 'a source cursor reads back as written, per source',
    run(cache) {
      same(cache.cursor('folder:/logs'), null, 'no cursor yet')
      cache.setCursor('folder:/logs', 'a.ndjson:10')
      cache.setCursor('server:https://logs', '42')
      cache.setCursor('folder:/logs', 'b.ndjson:3')
      same(cache.cursor('folder:/logs'), 'b.ndjson:3', 'folder cursor')
      same(cache.cursor('server:https://logs'), '42', 'server cursor')
    }
  },
  {
    name: 'a gap reads back as written, and recording it twice keeps one',
    run(cache) {
      const counted = {
        source: 'folder:/logs',
        from: 'a.ndjson:1',
        to: 'a.ndjson:90',
        reason: 'rotated away',
        lost: known(90)
      }
      const uncounted = {
        source: 'server:https://logs',
        from: null,
        to: '100',
        reason: 'past retention',
        lost: unknownBecause<number>('the server does not count expired events')
      }
      cache.recordGap(counted)
      cache.recordGap(uncounted)
      cache.recordGap(counted)
      same(cache.dataset().gaps(), [counted, uncounted], 'gaps')
    }
  },
  {
    name: 'a quarantine record reads back as written, once, and adds no row',
    run(cache) {
      const unknownVersion = quarantined(
        JSON.stringify({ meta: { schema: 99, event_id: 'future-1', run_id: 'r', seq: 0 } }),
        { source: 'a', position: '3' }
      )
      const torn = quarantined('{"meta": torn')
      same(cache.put(unknownVersion), { type: 'quarantine', result: 'inserted' }, 'first quarantine put')
      same(cache.put(torn), { type: 'quarantine', result: 'inserted' }, 'second quarantine put')
      same(cache.put(unknownVersion), { type: 'quarantine', result: 'duplicate' }, 'repeated quarantine put')
      check(unknownVersion.type === 'quarantine' && torn.type === 'quarantine', 'fixtures are quarantine records')
      if (unknownVersion.type !== 'quarantine' || torn.type !== 'quarantine') return
      same(cache.dataset().quarantined(), [unknownVersion.record, torn.record], 'quarantine')
      same(cache.dataset().rows(), [], 'no rows')
    }
  }
]
