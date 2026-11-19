import { createOrdering, type ReadGap } from './order.js'
import type { OtelRecord } from './records.js'
import { applyTrust } from './trust.js'

/** Something a source could not read, with its place. */
export type SourceProblem = Omit<ReadGap, 'kind'> & { kind: Exclude<ReadGap['kind'], 'sequence'> }

/** What one read of a source hands over: records not read before, what could not be read, and where to read on from. */
export type SourceBatch = {
  records: OtelRecord[]
  problems: SourceProblem[]
  /** Opaque. The caller keeps it and passes it to the next `read`, also after a restart. */
  position: string | undefined
}

/**
 * Anything that can hand a reader records: a run's local copy, a query
 * interface, a server of any OpenTelemetry tool. A source reads from a
 * position the caller keeps, hands each record after it once, and changes
 * nothing it reads. A read never throws: what it could not read comes back as
 * a problem.
 */
export interface RecordSource {
  /** Names the source on every record it hands. */
  readonly name: string
  /** Whether another tool wrote what it hands: a foreign source's records are all `reported`. */
  readonly foreign: boolean
  read(position?: string): Promise<SourceBatch>
}

export type ReaderUpdate = {
  /** Records ready now: redacted, deduplicated, each writer's in its own order, writers interleaved by time. */
  records: OtelRecord[]
  gaps: ReadGap[]
  /** The position to keep: pass it as `position` to read on after a restart. */
  position: string | undefined
}

export type ReaderOptions = {
  /** Where to read on from; omitted reads from the start. */
  position?: string
  /** The caller's home directory, shortened to `~` in strings. */
  home?: string
  /** Reads that may leave a record held behind a missing number before the number is reported as a gap. */
  patience?: number
}

export type Reader = {
  /** One read of the source from the reader's position. */
  pull(): Promise<ReaderUpdate>
  /** One read, then everything still held is handed and every missing number reported. */
  readAll(): Promise<ReaderUpdate>
  /** Reads again and again, handing each update that holds a record or a gap, until stopped. */
  follow(options?: { intervalMs?: number; signal?: AbortSignal }): AsyncGenerator<ReaderUpdate, void>
  /** The started events whose span has not arrived. */
  openSpans(): OtelRecord[]
  position(): string | undefined
}

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

/** A reader over one source: trust and redaction on every record, then each writer's order, duplicates, open spans and gaps. */
export function createReader(source: RecordSource, options: ReaderOptions = {}): Reader {
  const ordering = createOrdering(options.patience === undefined ? {} : { patience: options.patience })
  let position = options.position

  function finish(ordered: ReturnType<typeof ordering.push>, problems: ReadGap[]): ReaderUpdate {
    return {
      records: ordered.ready,
      gaps: [...problems, ...ordered.gaps],
      position
    }
  }

  async function pull(): Promise<ReaderUpdate> {
    const batch = await source.read(position)
    position = batch.position
    const trusted = batch.records.map((record) =>
      applyTrust(record, { foreign: source.foreign, ...(options.home === undefined ? {} : { home: options.home }) })
    )
    return finish(ordering.push(trusted), batch.problems)
  }

  return {
    pull,
    async readAll() {
      const update = await pull()
      const rest = ordering.flush()
      return { records: [...update.records, ...rest.ready], gaps: [...update.gaps, ...rest.gaps], position }
    },
    async *follow(followOptions = {}) {
      const interval = followOptions.intervalMs ?? 500
      while (!followOptions.signal?.aborted) {
        const update = await pull()
        if (update.records.length > 0 || update.gaps.length > 0) yield update
        await wait(interval, followOptions.signal)
      }
    },
    openSpans: () => ordering.openSpans(),
    position: () => position
  }
}
