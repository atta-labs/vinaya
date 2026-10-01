/**
 * An in-memory `LogCache` (`apps/cli/specs/log-sync.md`): no I/O, no clock,
 * so every later reader can be tested against it, and the shared contract
 * cases (`cache-contract.ts`) fix what a durable backend must match.
 */

import type { Dataset, LogCache, RowEdit, SourceCursor, SourceGap } from './contracts'
import type { DatasetRow, QuarantineRecord } from './row'

function gapKey(gap: SourceGap): string {
  return JSON.stringify([gap.source, gap.from, gap.to, gap.reason])
}

export function createMemoryCache(): LogCache {
  const rows = new Map<string, DatasetRow>()
  const quarantine = new Map<string, QuarantineRecord>()
  const cursors = new Map<string, SourceCursor>()
  const gaps = new Map<string, SourceGap>()
  const edits = new Map<string, RowEdit>()

  const dataset: Dataset = {
    rows() {
      return [...rows.values()].sort((a, b) =>
        a.time === b.time ? (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0) : a.time < b.time ? -1 : 1
      )
    },
    gaps() {
      return [...gaps.values()]
    },
    quarantined() {
      return [...quarantine.values()]
    }
  }

  return {
    put(line) {
      if (line.type === 'quarantine') {
        const key = line.record.contentHash
        if (quarantine.has(key)) return { type: 'quarantine', result: 'duplicate' }
        quarantine.set(key, line.record)
        return { type: 'quarantine', result: 'inserted' }
      }
      const incoming = line.row
      const kept = rows.get(incoming.identity)
      if (kept === undefined) {
        rows.set(incoming.identity, incoming)
        return { type: 'row', result: 'inserted' }
      }
      if (kept.contentHash === incoming.contentHash) return { type: 'row', result: 'duplicate' }
      const editKey = JSON.stringify([incoming.identity, incoming.contentHash])
      if (!edits.has(editKey)) {
        edits.set(editKey, {
          identity: incoming.identity,
          keptHash: kept.contentHash,
          editedHash: incoming.contentHash,
          origin: incoming.origin
        })
      }
      return { type: 'row', result: 'edited' }
    },
    cursor(source) {
      return cursors.get(source) ?? null
    },
    setCursor(source, cursor) {
      cursors.set(source, cursor)
    },
    recordGap(gap) {
      const key = gapKey(gap)
      if (!gaps.has(key)) gaps.set(key, gap)
    },
    edits() {
      return [...edits.values()]
    },
    dataset() {
      return dataset
    }
  }
}
