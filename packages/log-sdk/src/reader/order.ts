import { EARLIER_WRITER_PREFIX } from '../contract/catalogue.js'
import { identityOf, type OtelRecord, spanKeyOf } from './records.js'

/** Something a reader could not hand, reported with its place. */
export type ReadGap = {
  kind: 'sequence' | 'file_missing' | 'unreadable_line' | 'unrecognised_document' | 'source_unavailable'
  writerId: string | null
  place: string
  detail: string
}

export type Ordered = { ready: OtelRecord[]; gaps: ReadGap[]; duplicates: number }

type Writer = {
  /** Whether the SDK stamped this writer's records with sequence numbers to follow. */
  sequenced: boolean
  next: number | null
  held: OtelRecord[]
  /** The number of pushes that left a record held behind a missing number. */
  age: number
}

function isSequenced(record: OtelRecord): record is OtelRecord & { writerId: string; seq: number } {
  // A run recorded in the earlier format shares one writer identifier across
  // its processes, each counting from zero, so its numbers prove nothing.
  return record.writerId !== null && !record.writerId.startsWith(EARLIER_WRITER_PREFIX) && record.seq !== null
}

function nanos(record: OtelRecord): bigint {
  return BigInt(record.time)
}

function range(from: number, to: number): string {
  return from === to ? `${from}` : `${from}–${to}`
}

/**
 * The reader's ordering over one run's records.
 *
 * - Each writer's records leave in the writer's sequence order; the records of
 *   different writers are interleaved by time, best effort while following.
 * - A record whose identity was already taken is dropped as a duplicate.
 * - A started event is an open span until its span has been handed.
 * - A record that arrives ahead of a missing number is held. When the number
 *   still has not come after `patience` pushes (or when the run is flushed),
 *   the missing numbers are reported as a gap with their place and the held
 *   records leave. A writer whose records carry no usable numbers is handed
 *   in arrival order and never claims a gap.
 */
export function createOrdering(
  options: { patience?: number; fromStart?: boolean; remember?: number; maxHeld?: number } = {}
) {
  const patience = Math.max(1, options.patience ?? 2)
  const fromStart = options.fromStart ?? false
  // Bounds on what a long follow keeps: the oldest identities are forgotten first.
  const remember = Math.max(1, options.remember ?? 200_000)
  const maxHeld = Math.max(1, options.maxHeld ?? 10_000)
  const seen = new Set<string>()
  const forget = (set: Set<string>) => {
    while (set.size > remember) {
      const oldest = set.values().next()
      if (oldest.done) break
      set.delete(oldest.value)
    }
  }
  const writers = new Map<string, Writer>()
  const open = new Map<string, OtelRecord>()
  const closed = new Set<string>()

  function writerOf(key: string, sequenced: boolean): Writer {
    let writer = writers.get(key)
    if (writer === undefined) {
      // A run read from its start expects each writer's first number to be 0.
      writer = { sequenced, next: fromStart ? 0 : null, held: [], age: 0 }
      writers.set(key, writer)
    }
    return writer
  }

  function release(writer: Writer): OtelRecord[] {
    const out: OtelRecord[] = []
    writer.held.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    if (writer.next === null && writer.held.length > 0) writer.next = writer.held[0]?.seq ?? 0
    while (writer.held.length > 0 && writer.next !== null) {
      const head = writer.held[0] as OtelRecord
      const seq = head.seq as number
      if (seq < writer.next) {
        // Late, but never seen: handed rather than lost.
        out.push(head)
        writer.held.shift()
      } else if (seq === writer.next) {
        while ((writer.held[0]?.seq ?? -1) === seq) out.push(writer.held.shift() as OtelRecord)
        writer.next = seq + 1
      } else break
    }
    return out
  }

  function skipMissing(key: string, writer: Writer, gaps: ReadGap[]): OtelRecord[] {
    const first = writer.held[0]?.seq
    if (first === undefined || first === null || writer.next === null || first <= writer.next) return []
    gaps.push({
      kind: 'sequence',
      writerId: key,
      place: `writer ${key} sequence ${range(writer.next, first - 1)}`,
      detail: `sequence ${range(writer.next, first - 1)} of writer ${key} never arrived`
    })
    writer.next = first
    writer.age = 0
    return release(writer)
  }

  function merge(queues: Map<string, OtelRecord[]>): OtelRecord[] {
    const out: OtelRecord[] = []
    const heads = new Map<string, number>()
    for (;;) {
      let best: string | null = null
      let bestTime = 0n
      for (const [key, queue] of queues) {
        const index = heads.get(key) ?? 0
        const head = queue[index]
        if (head === undefined) continue
        const time = nanos(head)
        if (best === null || time < bestTime) {
          best = key
          bestTime = time
        }
      }
      if (best === null) return out
      const index = heads.get(best) ?? 0
      out.push((queues.get(best) as OtelRecord[])[index] as OtelRecord)
      heads.set(best, index + 1)
    }
  }

  function track(records: OtelRecord[]): void {
    for (const record of records) {
      const key = spanKeyOf(record)
      if (record.kind === 'span') {
        open.delete(key)
        closed.add(key)
        forget(closed)
      } else if (record.kind === 'started' && !closed.has(key)) {
        open.set(key, record)
      }
    }
  }

  function settle(incoming: OtelRecord[], force: boolean): Ordered {
    const gaps: ReadGap[] = []
    const queues = new Map<string, OtelRecord[]>()
    let duplicates = 0
    const queue = (key: string, record: OtelRecord) => {
      const list = queues.get(key)
      if (list) list.push(record)
      else queues.set(key, [record])
    }
    for (const record of incoming) {
      const identity = identityOf(record)
      if (seen.has(identity)) {
        duplicates += 1
        continue
      }
      seen.add(identity)
      forget(seen)
      if (isSequenced(record)) writerOf(record.writerId, true).held.push(record)
      else queue(`${record.writerId ?? `source:${record.source}`}`, record)
    }
    for (const [key, writer] of writers) {
      if (!writer.sequenced) continue
      for (const record of release(writer)) queue(key, record)
      if (writer.held.length > 0) {
        writer.age += 1
        while (writer.held.length > 0 && (force || writer.age >= patience || writer.held.length > maxHeld)) {
          for (const record of skipMissing(key, writer, gaps)) queue(key, record)
        }
      } else writer.age = 0
    }
    const ready = merge(queues)
    track(ready)
    return { ready, gaps, duplicates }
  }

  return {
    /** Takes the records a source just read; returns those now ready, in order. */
    push: (records: OtelRecord[]): Ordered => settle(records, false),
    /** Ends the run's reading: every held record leaves and every missing number is reported. */
    flush: (): Ordered => settle([], true),
    /** The started events whose span has not arrived. */
    openSpans: (): OtelRecord[] => [...open.values()]
  }
}
