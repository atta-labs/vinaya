/**
 * The server source (`apps/cli/specs/log-sync.md`): the effects-layer
 * adapter that reads a log server over its wire contract
 * (`apps/log-server/specs/server.md` § 5) — paging the read route by
 * position, stating what the server retains from the stats route, and
 * reading a bounded look-back before a cursor with that same route. The
 * `LogSource` contract itself (`@attalabs/aeg-core`) is pure policy and
 * stays untouched; this file is the one place that calls `fetch` for it.
 * `fetch`, the destination's events URL and the raw `logs.readHeaders`
 * (with `${VAR}` references intact) all arrive as constructor arguments —
 * nothing here reads config or resolves a destination itself — so a fake
 * `fetch` (no network) proves every behaviour below. Credential handling
 * only ever sees `logs.readHeaders`: there is no code path here that could
 * reach the ingest credential, which the server refuses on a read route
 * (§ 5).
 */

import {
  type LogSource,
  type Measured,
  type SourceCursor,
  type SourceGap,
  type SourceLine,
  type SourcePage,
  known,
  unknownBecause
} from '@attalabs/aeg-core'
import { resolveLogsHeaderValues } from './config.js'

/** The server's own page bound (`apps/log-server/specs/server.md` § 5: `limit`'s default and maximum). */
export const SERVER_SOURCE_PAGE_MAX = 1000

/** Each request's own timeout — the same bound `vinaya log selftest` uses. */
export const SERVER_SOURCE_TIMEOUT_MS = 10_000

/** The narrow slice of `fetch` this source needs — a fake implementing it proves every behaviour with no network. */
export type ServerSourceFetch = (input: string, init?: RequestInit) => Promise<Response>

/** The read/stats/rejected routes share the ingest path with only the tail swapped: `.../events` → `.../<tail>`. Shared here (moved from `log-selftest.ts`, issue-924) so the derivation lives once. */
function swapEventsTail(eventsUrl: string, tail: string): string {
  return eventsUrl.replace(/\/events(\?|$)/, `/${tail}$1`)
}

/** `.../events` → `.../stats` (`apps/log-server/specs/server.md` § 5). */
export function statsUrlFrom(eventsUrl: string): string {
  return swapEventsTail(eventsUrl, 'stats')
}

/**
 * What stopped a request, named so the engine can resume from the same
 * cursor (O5): `readPage`/`lookback` never advance past a failed page, so a
 * retry starts exactly where this one stopped.
 */
export class ServerSourceError extends Error {
  readonly kind: 'credential' | 'unreachable' | 'timeout' | 'server-error'
  constructor(kind: ServerSourceError['kind'], message: string) {
    super(message)
    this.kind = kind
    this.name = 'ServerSourceError'
  }
}

export type ServerSourceDeps = {
  fetchImpl: ServerSourceFetch
  /** The ingest route's own URL; every other route is derived from it (§ 5). */
  eventsUrl: string
  /** Raw `logs.readHeaders` — `${VAR}` references intact, exactly as configured. Never the ingest credential. */
  readHeaders: Record<string, string> | undefined
  env: NodeJS.ProcessEnv
}

export type RetentionStatement = {
  /** The server's own `last_seq` (stats route). */
  head: Measured<number>
  /** The server's own stored event count (stats route). */
  storedCount: Measured<number>
  /** `known(n)` for a `storedCount < head` gap of `n` rows; `known(0)` when nothing is missing; unknown when either figure above is. */
  gap: Measured<number>
}

export interface ServerLogSource extends LogSource {
  readPage(cursor: SourceCursor | null, limit: number): Promise<SourcePage>
  /** The `span` positions immediately before `cursor`, read with the same route as `readPage` by computing its start position (O3). */
  lookback(cursor: SourceCursor | null, span: number): Promise<SourcePage>
  /** What the server retains — its head and stored count, so a sync engine can tell a gap from a deletion (O2). */
  retention(): Promise<RetentionStatement>
  /** Every row this instance has read so far across `readPage` and `lookback` — the run's own read cost against the server's daily allowance (O3, `apps/log-server/specs/server.md` § 2). */
  rowsRead(): number
}

/** `response.body` must be drained before it is discarded, or the connection is never released. */
async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {})
}

export function createServerLogSource(deps: ServerSourceDeps): ServerLogSource {
  let totalRowsRead = 0

  /** The one place that calls `fetch`. Never throws on a non-2xx status — a caller decides what its own route's status means — only on a timeout or an unreachable server. */
  async function get(url: string): Promise<Response> {
    try {
      return await deps.fetchImpl(url, {
        method: 'GET',
        headers: { ...(resolveLogsHeaderValues(deps.readHeaders, deps.env) ?? {}) },
        signal: AbortSignal.timeout(SERVER_SOURCE_TIMEOUT_MS)
      })
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new ServerSourceError(
          'timeout',
          `the log server timed out after ${SERVER_SOURCE_TIMEOUT_MS}ms reading ${url}.`
        )
      }
      const detail = err instanceof Error ? err.message : String(err)
      throw new ServerSourceError('unreachable', `the log server could not be reached reading ${url}: ${detail}`)
    }
  }

  async function readFrom(after: number, limit: number): Promise<SourcePage> {
    const boundedLimit = Math.max(1, Math.min(limit, SERVER_SOURCE_PAGE_MAX))
    const url = new URL(deps.eventsUrl)
    url.searchParams.set('after', String(after))
    url.searchParams.set('limit', String(boundedLimit))
    const response = await get(url.toString())
    if (response.status === 401) {
      await discard(response)
      throw new ServerSourceError('credential', 'the read credential was refused by the log server.')
    }
    if (!response.ok) {
      await discard(response)
      throw new ServerSourceError(
        'server-error',
        `the log server returned ${response.status} reading ${url.toString()}.`
      )
    }
    const nextHeader = response.headers.get('vinaya-log-next-after')
    const text = await response.text()
    const lines: SourceLine[] = text
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const parsed = JSON.parse(line) as { seq: number; event: unknown }
        return { raw: JSON.stringify(parsed.event), position: String(parsed.seq) }
      })
    totalRowsRead += lines.length
    const next: SourceCursor = nextHeader !== null ? nextHeader : String(after)
    const gaps: SourceGap[] = []
    return { lines, next, gaps }
  }

  return {
    id: `server:${deps.eventsUrl}`,

    async readPage(cursor, limit) {
      const after = cursor !== null ? Number(cursor) : 0
      return readFrom(after, limit)
    },

    async lookback(cursor, span) {
      const cursorPos = cursor !== null ? Number(cursor) : 0
      const start = Math.max(0, cursorPos - span)
      return readFrom(start, Math.min(span, SERVER_SOURCE_PAGE_MAX))
    },

    async retention() {
      let response: Response
      try {
        response = await get(statsUrlFrom(deps.eventsUrl))
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        return { head: unknownBecause(reason), storedCount: unknownBecause(reason), gap: unknownBecause(reason) }
      }
      if (response.status === 401) {
        await discard(response)
        const reason = 'the read credential was refused by the log server.'
        return { head: unknownBecause(reason), storedCount: unknownBecause(reason), gap: unknownBecause(reason) }
      }
      if (!response.ok) {
        await discard(response)
        const reason = `the log server returned ${response.status} reading its stats route.`
        return { head: unknownBecause(reason), storedCount: unknownBecause(reason), gap: unknownBecause(reason) }
      }
      const body = (await response.json()) as { last_seq?: unknown; events?: unknown }
      const head =
        typeof body.last_seq === 'number'
          ? known(body.last_seq)
          : unknownBecause('the stats route did not report last_seq.')
      const storedCount =
        typeof body.events === 'number' ? known(body.events) : unknownBecause('the stats route did not report events.')
      const gap =
        head.known && storedCount.known
          ? storedCount.value < head.value
            ? known(head.value - storedCount.value)
            : known(0)
          : unknownBecause('the stats route did not report a usable head and stored count.')
      return { head, storedCount, gap }
    },

    rowsRead() {
      return totalRowsRead
    }
  }
}
