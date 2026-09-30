// `vinaya log selftest` — the one command that proves log delivery works end
// to end (O1/O2). It resolves the destination exactly as an UNATTENDED
// review-loop run does in this repository (the same trust-anchor read and
// credential lookup, forced unattended so a human at a terminal proves the
// launch path's own resolution — `resolveUnattendedLogDestination`), sends one
// marked test event to the configured server, reads it back by its own
// `event_id` through the server's cursor read, and prints `PASS` (exit 0) or
// `FAIL` with the ONE reason that stopped it (exit 1). It never prints a
// credential value.
//
// The test event is marked `kind: 'operation'`, `operation:
// 'log.selftest'` so a reader — a log page, an event count — can exclude it
// from real telemetry; the read-back matches the event's own `event_id`, a
// nonce this command mints and threads through `buildHeader` so the stored
// line carries it verbatim.

import { randomUUID } from 'node:crypto'
import { hostname as osHostname, homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildHeader, LogEventSchema, redact } from '@attalabs/aeg-core'
import { loadConfig, resolveLogsHeaderValues, type VinayaConfig } from '../lib/config.js'
import {
  logsCredentialMissing,
  type ResolvedLogDestination,
  describeFolderFallback,
  resolveUnattendedLogDestination,
  resolveUnattendedServerSetting
} from '../lib/log-sink.js'
import { packageRoot } from '../lib/package-root.js'

/** The fixed marker every self-test event carries, so a reader can exclude it from real telemetry (Traps). */
export const LOG_SELFTEST_OPERATION = 'log.selftest'

/** The most read pages to walk before giving up on finding the event — a bound, not a limit a healthy server ever reaches: the event is stored before the read begins and is the next line after the pre-send head. */
export const LOG_SELFTEST_MAX_PAGES = 20

/** The longest the self-test waits on any one exchange — it is a diagnostic, not a hot path, but must never hang on a dead endpoint. */
export const SELFTEST_HTTP_TIMEOUT_MS = 10_000

/** One HTTP exchange's outcome, reduced to what the self-test's reasons need: an accepted `2xx`, a non-`2xx` status, or a transport failure (the destination said nothing). */
export type SelftestHttp =
  | { kind: 'accepted'; status: number }
  | { kind: 'status'; status: number }
  | { kind: 'network'; detail: string }

/** A read page: its HTTP outcome, plus (on `2xx`) the parsed event lines and the cursor for the next page. */
export type SelftestReadPage = SelftestHttp & { nextAfter?: number; events?: unknown[] }

export type LogSelftestDeps = {
  /** The destination an unattended run resolves — `resolveUnattendedLogDestination`. */
  resolveDestination: () => Promise<ResolvedLogDestination>
  /** The RAW effective server setting (un-substituted headers) — `resolveUnattendedServerSetting`, for the credential-present check. */
  resolveServerSetting: () => Promise<{ url: string; headers?: Record<string, string> } | null>
  /** The working tree's RAW `logs.readHeaders` (the read credential, `${VAR}` un-substituted), or `undefined` when none is configured. */
  readReadHeaders: () => Record<string, string> | undefined
  /** Substitutes `${VAR}` references in a header map — `resolveLogsHeaderValues`. */
  resolveHeaders: (headers: Record<string, string> | undefined) => Record<string, string> | undefined
  /** The last stored `seq` before the send, so the read-back pages forward from there. */
  readLastSeq: (
    url: string,
    headers: Record<string, string> | undefined
  ) => Promise<SelftestHttp & { lastSeq?: number }>
  /** POSTs the one marked ndjson line to the ingest route. */
  post: (url: string, headers: Record<string, string> | undefined, body: string) => Promise<SelftestHttp>
  /** Reads one page of events after `after` from the read route. */
  read: (url: string, headers: Record<string, string> | undefined, after: number) => Promise<SelftestReadPage>
  /** Builds the marked test event's serialized (redacted) ndjson line, carrying `eventId` as its own `meta.event_id`. */
  buildLine: (eventId: string) => string
  env: NodeJS.ProcessEnv
  newNonce: () => string
  maxPages: number
  stdout: (text: string) => void
  stderr: (text: string) => void
}

/** The variable names a `${VAR}` header map references, deduplicated — what "set X" names to fix, never a value. */
function credentialVars(headers: Record<string, string> | undefined): string[] {
  const names = new Set<string>()
  for (const value of Object.values(headers ?? {})) {
    for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) names.add(match[1] as string)
  }
  return [...names]
}

function readVinayaVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot(import.meta.url), 'package.json'), 'utf8')) as {
      version?: string
    }
    return pkg.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * The real marked-event line: a schema-valid `operation`/`completed` event
 * carrying `eventId` as its own `meta.event_id`, redacted the same way every
 * other logged line is before it leaves this process. Built with the SAME
 * `buildHeader` the sink uses, so the stored line is indistinguishable in
 * shape from a real event save for its marker.
 */
export function buildSelftestLine(eventId: string, repo: string | null, now: Date, runId: string): string {
  const header = buildHeader({
    now,
    runId,
    seq: 0,
    repo,
    vinaya: readVinayaVersion(),
    doctrine: 'unknown',
    host: 'cli',
    hostname: osHostname(),
    env: {},
    eventId,
    processId: randomUUID()
  })
  const event = {
    ...header,
    kind: 'operation' as const,
    event: 'completed' as const,
    payload: {},
    operation: LOG_SELFTEST_OPERATION,
    target: null,
    result: 'ok' as const,
    error_class: null
  }
  const parsed = LogEventSchema.safeParse(event)
  // A self-test that cannot even build a valid event is a bug in this command,
  // not a delivery failure — surface it as one rather than posting garbage.
  if (!parsed.success)
    throw new Error(
      `log selftest could not build a valid test event: ${parsed.error.issues[0]?.message ?? 'schema violation'}`
    )
  return `${JSON.stringify(redact(parsed.data, homedir()))}\n`
}

/** The stats/read/live routes share the ingest path with only the tail swapped: `.../events` → `.../stats`. */
function statsUrlFrom(eventsUrl: string): string {
  return eventsUrl.replace(/\/events(\?|$)/, '/stats$1')
}

export function realLogSelftestDeps(): LogSelftestDeps {
  const config: VinayaConfig | null = loadConfig()
  return {
    resolveDestination: () => resolveUnattendedLogDestination(),
    resolveServerSetting: () => resolveUnattendedServerSetting(),
    readReadHeaders: () => config?.logs?.readHeaders,
    resolveHeaders: (headers) => resolveLogsHeaderValues(headers, process.env),
    readLastSeq: async (url, headers) => {
      try {
        const response = await fetch(statsUrlFrom(url), {
          method: 'GET',
          headers: { ...(headers ?? {}) },
          signal: AbortSignal.timeout(SELFTEST_HTTP_TIMEOUT_MS)
        })
        if (response.status < 200 || response.status >= 300) {
          await response.body?.cancel().catch(() => {})
          return { kind: 'status', status: response.status }
        }
        const body = (await response.json()) as { last_seq?: unknown }
        const lastSeq = typeof body.last_seq === 'number' ? body.last_seq : 0
        return { kind: 'accepted', status: response.status, lastSeq }
      } catch (err) {
        return { kind: 'network', detail: firstLine(err) }
      }
    },
    post: async (url, headers, body) => {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { ...(headers ?? {}), 'content-type': 'application/x-ndjson' },
          body,
          signal: AbortSignal.timeout(SELFTEST_HTTP_TIMEOUT_MS)
        })
        await response.body?.cancel().catch(() => {})
        return response.status >= 200 && response.status < 300
          ? { kind: 'accepted', status: response.status }
          : { kind: 'status', status: response.status }
      } catch (err) {
        return { kind: 'network', detail: firstLine(err) }
      }
    },
    read: async (url, headers, after) => {
      try {
        const readUrl = new URL(url)
        readUrl.searchParams.set('after', String(after))
        const response = await fetch(readUrl.toString(), {
          method: 'GET',
          headers: { ...(headers ?? {}) },
          signal: AbortSignal.timeout(SELFTEST_HTTP_TIMEOUT_MS)
        })
        if (response.status < 200 || response.status >= 300) {
          await response.body?.cancel().catch(() => {})
          return { kind: 'status', status: response.status }
        }
        const nextAfterHeader = response.headers.get('vinaya-log-next-after')
        const nextAfter = nextAfterHeader === null ? after : Number(nextAfterHeader)
        const text = await response.text()
        const events = text
          .split('\n')
          .filter((line) => line.length > 0)
          .map((line) => {
            try {
              return JSON.parse(line) as unknown
            } catch {
              return null
            }
          })
          .filter((e): e is unknown => e !== null)
        return {
          kind: 'accepted',
          status: response.status,
          nextAfter: Number.isFinite(nextAfter) ? nextAfter : after,
          events
        }
      } catch (err) {
        return { kind: 'network', detail: firstLine(err) }
      }
    },
    buildLine: (eventId) => buildSelftestLine(eventId, null, new Date(), randomUUID()),
    env: process.env,
    newNonce: () => randomUUID(),
    maxPages: LOG_SELFTEST_MAX_PAGES,
    stdout: (text) => {
      process.stdout.write(text)
    },
    stderr: (text) => {
      process.stderr.write(text)
    }
  }
}

function firstLine(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.split('\n')[0]?.trim() || 'no detail'
}

/**
 * Whether a read-back page holds an event whose `meta.event_id` is `eventId` —
 * the test event's own id, the way the Traps require it be found. The stored
 * shape wraps each event as `{ seq, status, event }` (the server's read
 * envelope), so the id is read from `.event.meta.event_id`.
 */
function pageHasEvent(events: unknown[] | undefined, eventId: string): boolean {
  for (const row of events ?? []) {
    const event = (row as { event?: { meta?: { event_id?: unknown } } }).event
    if (event?.meta?.event_id === eventId) return true
  }
  return false
}

/** `PASS`/`FAIL` result — separated from printing so a test asserts the reason directly. */
export type SelftestResult = { pass: true } | { pass: false; reason: string }

/**
 * The end-to-end round-trip, as a pure-ish decision over the injected seams.
 * Every early return is one of O1's named reasons; the only `PASS` is a
 * genuine read-back of the sent event by its own id.
 */
export async function runLogSelftest(deps: LogSelftestDeps): Promise<SelftestResult> {
  const destination = await deps.resolveDestination()

  if (destination.kind === 'none') {
    return { pass: false, reason: destination.reason }
  }
  if (destination.kind === 'folder') {
    if (destination.fallbackReason) {
      return { pass: false, reason: describeFolderFallback(destination.fallbackReason) }
    }
    return {
      pass: false,
      reason:
        'no log server is configured — events go to the local folder. Set `logs.url` in vinaya.config.json (and its default-branch copy for an unattended run) to a server destination to prove delivery.'
    }
  }

  // A server IS the destination. Confirm this machine actually holds the
  // ingest credential before sending — a missing one would otherwise reach
  // the network only to come back `401`, and the honest reason is that the
  // credential is absent here, named by the variable to set.
  const rawServer = await deps.resolveServerSetting()
  if (rawServer && logsCredentialMissing(rawServer.headers, deps.env)) {
    const vars = credentialVars(rawServer.headers)
    return {
      pass: false,
      reason: `the log server ${destination.url} is configured, but this host holds no ingest credential — set ${vars.join(', ')} to the value the server accepts (the value is never printed).`
    }
  }

  // The read credential is separate from the ingest one (the server refuses an
  // ingest token on a read route), so a read-back needs `logs.readHeaders`.
  const rawRead = deps.readReadHeaders()
  if (rawRead === undefined) {
    return {
      pass: false,
      reason:
        "no read credential is configured — set `logs.readHeaders` in vinaya.config.json to the server's read token (referenced by variable name rather than written out), so the self-test can read its own event back."
    }
  }
  if (logsCredentialMissing(rawRead, deps.env)) {
    const vars = credentialVars(rawRead)
    return {
      pass: false,
      reason: `the read credential is configured, but this host holds no value for it — set ${vars.join(', ')} to the server's read token (the value is never printed).`
    }
  }
  const readHeaders = deps.resolveHeaders(rawRead)

  // Where to page from: the head before the send, so the read-back walks
  // forward from just before our own event rather than the whole history.
  const before = await deps.readLastSeq(destination.url, readHeaders)
  if (before.kind === 'status') {
    return {
      pass: false,
      reason: `the log server ${destination.url} refused the read credential on its stats route (HTTP ${before.status}).`
    }
  }
  if (before.kind === 'network') {
    return { pass: false, reason: `the log server ${destination.url} could not be reached (${before.detail}).` }
  }
  const baseline = before.lastSeq ?? 0

  const nonce = deps.newNonce()
  const line = deps.buildLine(nonce)
  const sent = await deps.post(destination.url, destination.headers, line)
  if (sent.kind === 'status') {
    return { pass: false, reason: `the log server ${destination.url} refused the test event (HTTP ${sent.status}).` }
  }
  if (sent.kind === 'network') {
    return { pass: false, reason: `the log server ${destination.url} could not be reached (${sent.detail}).` }
  }

  // Read it back by its own id, paging with `after=` until found or a bounded
  // number of pages. A page that returns no new cursor (caught up) with the
  // event still unseen is a genuine "not found on read-back".
  let after = baseline
  for (let page = 0; page < deps.maxPages; page++) {
    const result = await deps.read(destination.url, readHeaders, after)
    if (result.kind === 'status') {
      return {
        pass: false,
        reason: `the log server ${destination.url} refused the read credential on its read route (HTTP ${result.status}).`
      }
    }
    if (result.kind === 'network') {
      return { pass: false, reason: `the log server ${destination.url} could not be reached (${result.detail}).` }
    }
    if (pageHasEvent(result.events, nonce)) return { pass: true }
    const next = result.nextAfter ?? after
    if (next === after) break // caught up — no more pages, and the event was not among them
    after = next
  }
  return {
    pass: false,
    reason: `the test event was delivered to ${destination.url} but could not be read back by its id within ${deps.maxPages} page(s) — the server accepted it but a read of it did not return it.`
  }
}

/**
 * `vinaya log selftest` — prints `PASS` (exit 0) or `FAIL: <reason>` (exit 1),
 * never a credential value (O2). The returned number is the process exit code.
 */
export async function logSelftestCommand(
  _args: string[],
  deps: LogSelftestDeps = realLogSelftestDeps()
): Promise<number> {
  let result: SelftestResult
  try {
    result = await runLogSelftest(deps)
  } catch (err) {
    deps.stderr(`FAIL: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
  if (result.pass) {
    deps.stdout('PASS: log delivery works — one test event was sent to the server and read back by its id.\n')
    return 0
  }
  deps.stderr(`FAIL: ${result.reason}\n`)
  return 1
}

import type { SurfaceExemption } from '../lib/surface-exemption'

// `log selftest` deliberately composes several lib helpers rather than routing
// through one chokepoint, the same shape `log send` carries: it resolves the
// destination the sink's own unattended way (`resolveUnattendedLogDestination`
// / `resolveUnattendedServerSetting`), checks the credential
// (`logsCredentialMissing`), renders a fallback reason
// (`describeFolderFallback`), and reads the read credential from config
// (`loadConfig`/`resolveLogsHeaderValues`). There is no single lib function
// that both resolves the destination AND round-trips one event through it, and
// inventing a façade to satisfy the one-call rule would only hide the wiring a
// reader needs to see. The retirement target is a future `log-delivery.ts`
// that owns "prove and deliver for this repo" behind one call.
export const SURFACE_EXEMPTIONS: Record<string, SurfaceExemption> = {
  'log selftest': { date: '2026-09-29', callsToday: 7, retiresVia: 'logDeliveryChokepoint' }
}
