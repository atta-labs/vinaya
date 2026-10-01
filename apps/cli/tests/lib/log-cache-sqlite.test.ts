import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cacheContractCases,
  normalizeStoredLine,
  type DatasetRow,
  type NormalizedLine,
  type RowOrigin
} from '@attalabs/aeg-core'
import { CACHE_FILE_NAME, createSqliteCache } from '../../src/lib/log-cache-sqlite.js'

// The durable SQLite backend against the shared contract and this backend's
// own durability guarantees (`apps/cli/specs/log-sync.md`). Every case opens
// its own temporary directory — a real file, never a fake — so what passes
// here is what a real `vinaya` process would see.

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'vinaya-log-cache-sqlite-'))
}

function dbPathOf(dir: string): string {
  return join(dir, CACHE_FILE_NAME)
}

const T1 = '2026-09-20T10:00:00.000Z'
const T2 = '2026-09-20T11:00:00.000Z'

/** A valid schema 3 `operation` line, with every column O4 indexes free to vary. */
function operationLine(opts: {
  eventId: string
  ts?: string
  runId?: string
  kind?: string
  event?: string
  workRef?: string | null
  origin?: RowOrigin | null
  result?: string
}): NormalizedLine {
  const raw = JSON.stringify({
    meta: {
      schema: 3,
      ts: opts.ts ?? T1,
      run_id: opts.runId ?? 'contract-run',
      seq: 0,
      repo: 'owner/repo',
      vinaya: '0.36.0',
      doctrine: 'aeg-root@contract',
      host: 'cli',
      machine: 'contract-machine',
      event_id: opts.eventId,
      process_id: 'contract-process',
      actor_id: null,
      lineage: { run: null, attempt: null, parent: null },
      input_versions: { objectives_version: null, brief_hash: null, ruling_ordinal: null, policy_digest: null },
      provenance: 'unavailable',
      work: { ref: opts.workRef ?? null, repo: null, change: null, revision: null },
      flow: { id: 'vinaya', version: null },
      runtime: null,
      source: null
    },
    subject: { issue: null, role: 'unattributed' },
    kind: opts.kind ?? 'operation',
    event: opts.event ?? 'completed',
    payload: {},
    operation: 'contract',
    // `target` doubles as this fixture's distinguishing payload content —
    // the family's own `payload` must be `{}` (`envelopeTail`'s shared,
    // strict, empty object), so everything else in the event becomes the
    // row's `payload` once `meta`/`subject`/`kind`/`event` are stripped.
    target: opts.eventId,
    result: opts.result ?? 'ok',
    error_class: null
  })
  const normalized = normalizeStoredLine(raw, opts.origin ?? null)
  if (normalized.type !== 'row') throw new Error('fixture line must normalise into a row')
  return normalized
}

describe('log-cache-sqlite — the shared cache contract (O1)', () => {
  it('the contract has cases', () => {
    expect(cacheContractCases.length).toBeGreaterThan(0)
  })

  for (const contractCase of cacheContractCases) {
    it(contractCase.name, () => {
      const cache = createSqliteCache(tmpDir())
      try {
        contractCase.run(cache)
      } finally {
        cache.close()
      }
    })
  }
})

describe('log-cache-sqlite — the dataset answers from indexed columns and parsed payloads (O4)', () => {
  it('rows round-trip with their payload parsed, not a JSON string', () => {
    const cache = createSqliteCache(tmpDir())
    try {
      const line = operationLine({ eventId: 'e-1', origin: { source: 'a', position: '1' } })
      cache.put(line)
      const stored = cache.dataset().rows()[0] as DatasetRow
      expect(stored.payload).toEqual({
        operation: 'contract',
        target: 'e-1',
        result: 'ok',
        error_class: null,
        payload: {}
      })
      expect(typeof stored.payload).toBe('object')
      expect(stored.origin).toEqual({ source: 'a', position: '1' })
    } finally {
      cache.close()
    }
  })

  it('rows with distinct run, work reference and time all round-trip correctly, and sort by time then identity', () => {
    const cache = createSqliteCache(tmpDir())
    try {
      cache.put(operationLine({ eventId: 'e-1', runId: 'run-a', workRef: '101', ts: T2 }))
      cache.put(operationLine({ eventId: 'e-2', runId: 'run-b', workRef: '202', ts: T1 }))
      const rows = cache.dataset().rows()
      // Ordered by time, then identity (the `Dataset` contract) — `e-2`
      // (T1) sorts before `e-1` (T2) although it was stored second.
      expect(rows.map((r) => r.identity)).toEqual(['e-2', 'e-1'])
      expect(rows[0]?.kind).toBe('operation')
      expect(rows[0]?.event).toBe('completed')
      expect(rows[0]?.runId).toBe('run-b')
      expect(rows[0]?.workRef).toBe('202')
      expect(rows[1]?.runId).toBe('run-a')
      expect(rows[1]?.workRef).toBe('101')
    } finally {
      cache.close()
    }
  })

  it('the rows table carries an index on kind+event, run, work reference and time', () => {
    const dir = tmpDir()
    const cache = createSqliteCache(dir)
    cache.put(operationLine({ eventId: 'e-1' }))
    cache.setCursor('src', 'c1')
    cache.close()

    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
    const db = new DatabaseSync(dbPathOf(dir))
    try {
      const indexes = (db.prepare("PRAGMA index_list('rows')").all() as Array<{ name: string }>).map((i) => i.name)
      const coveredColumns = new Set<string>()
      for (const name of indexes) {
        for (const col of db.prepare(`PRAGMA index_info('${name}')`).all() as Array<{ name: string }>) {
          coveredColumns.add(col.name)
        }
      }
      expect(coveredColumns.has('kind')).toBe(true)
      expect(coveredColumns.has('event')).toBe(true)
      expect(coveredColumns.has('runId')).toBe(true)
      expect(coveredColumns.has('workRef')).toBe(true)
      expect(coveredColumns.has('time')).toBe(true)
    } finally {
      db.close()
    }
  })
})
