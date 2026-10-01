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
import { CACHE_FILE_NAME, CURRENT_SCHEMA_VERSION, createSqliteCache } from '../../src/lib/log-cache-sqlite.js'

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

describe('log-cache-sqlite — schema version (O2)', () => {
  it('refuses a database written by a newer schema version, naming the file and both versions', () => {
    const dir = tmpDir()
    const cache = createSqliteCache(dir)
    cache.close()

    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
    const raw = new DatabaseSync(dbPathOf(dir))
    raw.exec('PRAGMA user_version = 999')
    raw.close()

    let thrown: unknown
    try {
      createSqliteCache(dir)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Error)
    expect(String(thrown)).toContain('999')
    expect(String(thrown)).toContain(String(CURRENT_SCHEMA_VERSION))
    expect(String(thrown)).toContain(dbPathOf(dir))
  })

  it('migrates an older database forward in one transaction without losing a row, cursor, gap, quarantine record or edit', () => {
    const dir = tmpDir()
    const cache = createSqliteCache(dir)
    const first = operationLine({ eventId: 'e-1', origin: { source: 'a', position: '1' } })
    cache.put(first)
    // A different `result` gives a genuinely different content hash for the
    // same identity — a real edit, the same way cache-contract.ts's own
    // fixture produces one.
    const edited = operationLine({ eventId: 'e-1', origin: { source: 'b', position: '2' }, result: 'error' })
    cache.put(edited)
    cache.recordGap({
      source: 'folder:/logs',
      from: 'a:1',
      to: 'a:9',
      reason: 'rotated away',
      lost: { known: true, value: 8 }
    })
    cache.put(normalizeStoredLine('{"meta": torn', null))
    cache.setCursor('folder:/logs', 'a.ndjson:10')
    cache.close()

    // Simulate an older on-disk database: the real schema is already in
    // place (this build never shipped a structurally different one), so
    // relabeling its own `user_version` back to 0 and reopening exercises
    // the exact migration function a real version bump would use — proving
    // it preserves data, not merely that it exists.
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
    const raw = new DatabaseSync(dbPathOf(dir))
    raw.exec('PRAGMA user_version = 0')
    raw.close()

    const reopened = createSqliteCache(dir)
    try {
      const rows = reopened.dataset().rows()
      expect(rows.map((r) => r.identity)).toEqual(['e-1'])
      expect(reopened.edits()).toHaveLength(1)
      expect(reopened.dataset().gaps()).toHaveLength(1)
      expect(reopened.dataset().quarantined()).toHaveLength(1)
      expect(reopened.cursor('folder:/logs')).toBe('a.ndjson:10')

      const probe = new DatabaseSync(dbPathOf(dir))
      try {
        expect((probe.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
          CURRENT_SCHEMA_VERSION
        )
      } finally {
        probe.close()
      }
    } finally {
      reopened.close()
    }
  })
})

describe('log-cache-sqlite — one transaction per page (O3)', () => {
  it('a page not yet advanced past its cursor is invisible to a fresh open — the same state a killed process would leave', () => {
    const dir = tmpDir()
    const writer = createSqliteCache(dir)
    writer.put(operationLine({ eventId: 'e-1' }))
    writer.recordGap({ source: 's', from: '1', to: '2', reason: 'rotated', lost: { known: false, reason: 'unknown' } })
    // No setCursor() yet — the page is still open. A fresh connection to the
    // same file, opened now, stands in for a process that resumes after a
    // kill: it must see none of this page's work.
    const beforeCommit = createSqliteCache(dir)
    try {
      expect(beforeCommit.dataset().rows()).toEqual([])
      expect(beforeCommit.dataset().gaps()).toEqual([])
      expect(beforeCommit.cursor('s')).toBeNull()
    } finally {
      beforeCommit.close()
    }

    // The writer now completes its page — the commit point.
    writer.setCursor('s', 'cursor-1')
    writer.close()

    const afterCommit = createSqliteCache(dir)
    try {
      expect(
        afterCommit
          .dataset()
          .rows()
          .map((r) => r.identity)
      ).toEqual(['e-1'])
      expect(afterCommit.dataset().gaps()).toHaveLength(1)
      expect(afterCommit.cursor('s')).toBe('cursor-1')
    } finally {
      afterCommit.close()
    }
  })

  it('closing a cache with a page still open commits it rather than discarding it', () => {
    const dir = tmpDir()
    const writer = createSqliteCache(dir)
    writer.put(operationLine({ eventId: 'e-1' }))
    // Never called setCursor — close() must still flush this page (a
    // quarantine-only run advances no cursor at all, and that work is not
    // lost on a graceful shutdown).
    writer.close()

    const reopened = createSqliteCache(dir)
    try {
      expect(
        reopened
          .dataset()
          .rows()
          .map((r) => r.identity)
      ).toEqual(['e-1'])
    } finally {
      reopened.close()
    }
  })
})
