/**
 * Followers (`harness/kernel/log/log-sync.md`, "Following a Log live"): a
 * long-running reader that hands a caller each stored line of one
 * repository's Log as it arrives, from a position the caller gives, with no
 * gap and no repeat. Two implementations share one interface, so a caller
 * treats a log server and a log folder alike:
 *
 *  - the server follower opens the server's live route
 *    (`apps/log-server/specs/server.md` § 5), pages with the server source's
 *    own read paging when the server answers with a resync, and reconnects
 *    with growing waits after a drop — always from the last position it
 *    handed over, dropping anything at or below it;
 *  - the folder follower watches the repository's folder and, on every
 *    change, reads on with the folder source from its own cursor, so every
 *    appended line comes with the position the folder source already gives.
 *
 * Every effect arrives as a constructor argument — the WebSocket
 * constructor, `fetch`, the file watch, the wait between reconnects — and
 * nothing here reads configuration, so a fake proves every behaviour with no
 * network and no real clock. A line is handed over as the source hands it
 * (`SourceLine`): turning it into a fact is the reader's job, not this one's.
 */

import { watch as watchFolder } from 'node:fs'
import type { LogSource, SourceCursor, SourceGap, SourceLine } from '../sync/contracts'
import { type FolderSourceDeps, createFolderLogSource, repoDirFor } from './log-sync-folder-source.js'
import {
  SERVER_SOURCE_PAGE_MAX,
  ServerSourceError,
  type ServerSourceFetch,
  createServerLogSource,
  credentialMissing,
  credentialVarNames,
  liveUrlFrom
} from './log-sync-server-source.js'
import { resolveLogsHeaderValues } from '../../config/schema/config-schema.js'

// ── The one interface ───────────────────────────────────────────────────────

/** Every state a follower moves through, each reported to its caller as it is entered. */
export type FollowState = 'connecting' | 'live' | 'catching-up' | 'waiting-to-reconnect' | 'stopped'

/** One state change: the state entered, and — for a wait or a stop — why, and for a wait how long. */
export type FollowStateChange = { state: FollowState; reason?: string; waitMs?: number }

/** What a follower hands its caller. `line` is called once per stored line, in position order. */
export type FollowSink = {
  line(line: SourceLine): void
  /** Every state change, in order. */
  state?(change: FollowStateChange): void
  /** A stretch the source reports it can no longer read (a folder stream rotated away before it was read). */
  gap?(gap: SourceGap): void
}

/** A running follow. */
export type FollowHandle = {
  /** The cursor to resume from — after every line handed over so far; the source's own cursor shape. */
  cursor(): SourceCursor | null
  /** Ends the follow: no line is handed over after this resolves, and `stopped` is the last state reported. */
  stop(): Promise<void>
  /** Resolves once the follow has ended — by `stop`, or by a failure no retry can fix (a refused read credential). */
  readonly done: Promise<void>
}

/** One repository's Log, followed live. `id` is the same id the matching source carries. */
export interface LogFollower {
  readonly id: string
  /** Starts following after `from` — the matching source's own cursor; `null` is the beginning. */
  follow(from: SourceCursor | null, sink: FollowSink): FollowHandle
}

/** Waits `ms`, resolving early once `signal` aborts. Injected, so a test never waits on the real clock. */
export type FollowWait = (ms: number, signal: AbortSignal) => Promise<void>

/** The growing waits between reconnect attempts: `initialMs`, doubling per failed attempt, capped at `maxMs`. */
export type ReconnectBackoff = { initialMs: number; maxMs: number }

export const DEFAULT_RECONNECT_BACKOFF: ReconnectBackoff = { initialMs: 1_000, maxMs: 60_000 }

/** The wait before attempt `attempt` (1-based): `initialMs · 2^(attempt-1)`, capped at `maxMs`. */
export function reconnectWaitMs(backoff: ReconnectBackoff, attempt: number): number {
  const exponent = Math.max(0, attempt - 1)
  return Math.min(backoff.maxMs, backoff.initialMs * 2 ** Math.min(exponent, 30))
}

/** The real-clock wait, used only when no wait is injected. */
export const realClockWait: FollowWait = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done)
  })

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ── The server follower ─────────────────────────────────────────────────────

/** The live route's subprotocol (`apps/log-server/specs/server.md` § 5). */
export const LIVE_PROTOCOL = 'vinaya-log.v1'

/** The close code the server resyncs a viewer with: page first, then reconnect (§ 5). */
export const RESYNC_CLOSE_CODE = 1013

/**
 * A handler property declared through a method, so its parameter is checked
 * bivariantly: the standard WebSocket's own `MessageEvent` and `CloseEvent`
 * handlers then fit the narrow event shapes below.
 */
type Handler<E> = { bivariant(event: E): void }['bivariant']

/** The narrow slice of a standard WebSocket the follower uses — a fake implementing it proves every behaviour with no network. */
export interface LiveSocket {
  onopen: Handler<never> | null
  onmessage: Handler<{ data: unknown }> | null
  onclose: Handler<{ code: number; reason: string }> | null
  onerror: Handler<never> | null
  close(code?: number, reason?: string): void
}

/** The standard WebSocket constructor's shape: `new WebSocket(url, protocols)`. */
export type LiveSocketConstructor = new (url: string, protocols: string[]) => LiveSocket

export type ServerFollowerDeps = {
  /** The destination's events URL; the live route and the read route are derived from it (§ 5). */
  eventsUrl: string
  /** Raw `logs.readHeaders` — `${VAR}` references intact. The only credential the follower ever holds. */
  readHeaders: Record<string, string> | undefined
  env: NodeJS.ProcessEnv
  WebSocketImpl: LiveSocketConstructor
  fetchImpl: ServerSourceFetch
  wait?: FollowWait
  backoff?: ReconnectBackoff
}

/** The read token from the resolved read headers' `authorization: Bearer <token>`, or `null` when they carry none. */
function bearerTokenOf(headers: Record<string, string> | undefined): string | null {
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() !== 'authorization') continue
    const match = /^Bearer\s+(\S+)\s*$/i.exec(value)
    if (match) return match[1] as string
  }
  return null
}

/** How one live connection ended. */
type SocketOutcome = { kind: 'resync' } | { kind: 'dropped'; reason: string; opened: boolean } | { kind: 'stopped' }

export function createServerLogFollower(deps: ServerFollowerDeps): LogFollower {
  const wait = deps.wait ?? realClockWait
  const backoff = deps.backoff ?? DEFAULT_RECONNECT_BACKOFF
  const source = createServerLogSource({
    fetchImpl: deps.fetchImpl,
    eventsUrl: deps.eventsUrl,
    readHeaders: deps.readHeaders,
    env: deps.env
  })

  function follow(from: SourceCursor | null, sink: FollowSink): FollowHandle {
    // The last position handed to the caller. Everything at or below it has
    // been delivered, so anything at or below it arriving again is dropped.
    let last = from !== null && /^\d+$/.test(from) ? Number(from) : 0
    let stopping = false
    const stopSignal = new AbortController()
    let currentSocket: LiveSocket | null = null
    let endSocket: ((outcome: SocketOutcome) => void) | null = null

    const report = (change: FollowStateChange): void => sink.state?.(change)

    /** Hands one line over unless it is at or below `last` or the follow is stopping. */
    function deliver(position: number, raw: string): void {
      if (stopping || !(position > last)) return
      last = position
      sink.line({ raw, position: String(position) })
    }

    /** One live connection from `last`, until the server resyncs it, it drops, or the follow stops. */
    function runSocket(): Promise<SocketOutcome> {
      return new Promise<SocketOutcome>((resolve) => {
        let settled = false
        let opened = false
        let resyncAsked = false
        const settle = (outcome: SocketOutcome): void => {
          if (settled) return
          settled = true
          endSocket = null
          currentSocket = null
          resolve(outcome)
        }
        endSocket = settle

        const token = bearerTokenOf(resolveLogsHeaderValues(deps.readHeaders, deps.env))
        const url = new URL(liveUrlFrom(deps.eventsUrl))
        url.searchParams.set('after', String(last))
        const protocols = token !== null ? [LIVE_PROTOCOL, `bearer.${token}`] : [LIVE_PROTOCOL]

        let socket: LiveSocket
        try {
          socket = new deps.WebSocketImpl(url.toString(), protocols)
        } catch (err) {
          settle({ kind: 'dropped', reason: reasonOf(err), opened })
          return
        }
        currentSocket = socket

        socket.onopen = () => {
          if (settled) return
          opened = true
          report({ state: 'live' })
        }
        socket.onmessage = (event) => {
          if (settled || typeof event.data !== 'string') return
          let message: { type?: unknown; seq?: unknown; event?: unknown }
          try {
            message = JSON.parse(event.data) as typeof message
          } catch {
            return // not a line of the feed; nothing to position it by
          }
          if (message.type === 'resync') {
            resyncAsked = true
            return
          }
          if (typeof message.seq === 'number' && Number.isInteger(message.seq)) {
            deliver(message.seq, JSON.stringify(message.event))
          }
        }
        socket.onerror = () => {
          // A failed connection is always followed by a close, which settles it.
        }
        socket.onclose = (event) => {
          if (stopping) settle({ kind: 'stopped' })
          else if (resyncAsked || event.code === RESYNC_CLOSE_CODE) settle({ kind: 'resync' })
          else
            settle({
              kind: 'dropped',
              reason: `the live connection closed (code ${event.code}${event.reason ? `: ${event.reason}` : ''}).`,
              opened
            })
        }
      })
    }

    /** Pages forward from `last` with the read route until a page comes back empty — caught up. */
    async function catchUp(): Promise<void> {
      for (;;) {
        if (stopping) return
        const page = await source.readPage(String(last), SERVER_SOURCE_PAGE_MAX)
        for (const line of page.lines) deliver(Number(line.position), line.raw)
        if (page.next === null || page.lines.length === 0) return
      }
    }

    async function run(): Promise<void> {
      let attempt = 0
      let endReason: string | undefined
      while (!stopping) {
        if (credentialMissing(deps.readHeaders, deps.env)) {
          const vars = credentialVarNames(deps.readHeaders)
          endReason = `the read credential is not set — set ${vars.join(', ')} to the server's read token (the value is never printed).`
          break
        }
        report({ state: 'connecting' })
        const outcome = await runSocket()
        if (outcome.kind === 'stopped' || stopping) break

        let failure: string | null = null
        if (outcome.kind === 'resync') {
          report({ state: 'catching-up' })
          try {
            await catchUp()
            attempt = 0
            continue // reopen live from the last position, no wait
          } catch (err) {
            if (err instanceof ServerSourceError && err.kind === 'credential') {
              endReason = err.message
              break
            }
            failure = reasonOf(err)
          }
        } else {
          if (outcome.opened) attempt = 0
          failure = outcome.reason
        }
        if (stopping) break

        attempt += 1
        const waitMs = reconnectWaitMs(backoff, attempt)
        report({ state: 'waiting-to-reconnect', reason: failure, waitMs })
        await wait(waitMs, stopSignal.signal)
      }
      stopping = true
      report(endReason !== undefined ? { state: 'stopped', reason: endReason } : { state: 'stopped' })
    }

    const done = run()

    return {
      cursor: () => String(last),
      async stop() {
        if (!stopping) {
          stopping = true
          stopSignal.abort()
          const socket = currentSocket
          const end = endSocket
          if (socket !== null) {
            try {
              socket.close(1000, 'the follower stopped')
            } catch {
              // closing a socket that never opened can throw; the follow ends either way
            }
          }
          end?.({ kind: 'stopped' })
        }
        await done
      },
      done
    }
  }

  return { id: source.id, follow }
}

// ── The folder follower ─────────────────────────────────────────────────────

/** A running watch on one folder. */
export type FolderWatchHandle = { close(): void }

/** Watches `dir`, calling `onChange` on any change inside it and `onError` once if the watch fails. Throws when `dir` cannot be watched. */
export type FolderWatch = (dir: string, onChange: () => void, onError: (err: unknown) => void) => FolderWatchHandle

/** The real file watch, used only when none is injected. */
export const nodeFolderWatch: FolderWatch = (dir, onChange, onError) => {
  const watcher = watchFolder(dir, () => onChange())
  watcher.on('error', onError)
  return { close: () => watcher.close() }
}

export type FolderFollowerDeps = FolderSourceDeps & {
  watch?: FolderWatch
  /** Opens the reader of the folder's lines; the folder source unless injected. */
  openSource?: (deps: FolderSourceDeps) => LogSource
  wait?: FollowWait
  backoff?: ReconnectBackoff
}

/** The page size each read on the folder asks for. */
const FOLDER_PAGE_LIMIT = 1000

export function createFolderLogFollower(deps: FolderFollowerDeps): LogFollower {
  const watch = deps.watch ?? nodeFolderWatch
  const wait = deps.wait ?? realClockWait
  const backoff = deps.backoff ?? DEFAULT_RECONNECT_BACKOFF
  const sourceDeps: FolderSourceDeps = { folderRoot: deps.folderRoot, repo: deps.repo }
  const source = (deps.openSource ?? createFolderLogSource)(sourceDeps)
  const dir = repoDirFor(sourceDeps)

  function follow(from: SourceCursor | null, sink: FollowSink): FollowHandle {
    let cursor = from
    let stopping = false
    const stopSignal = new AbortController()
    let watcher: FolderWatchHandle | null = null
    /** Wakes the run loop: a change was seen, the watch failed, or the follow is stopping. */
    let wake: (() => void) | null = null
    let changed = false
    let watchFailure: string | null = null

    const report = (change: FollowStateChange): void => sink.state?.(change)
    const poke = (): void => {
      const w = wake
      wake = null
      w?.()
    }

    /** Reads on from `cursor` until a page brings nothing new; every line read is handed over before the cursor moves past it. */
    async function drain(): Promise<void> {
      for (;;) {
        if (stopping) return
        const page = await source.readPage(cursor, FOLDER_PAGE_LIMIT)
        if (stopping) return
        for (const gap of page.gaps) sink.gap?.(gap)
        for (const line of page.lines) sink.line(line)
        if (page.next !== null) cursor = page.next
        if (page.lines.length === 0) return
      }
    }

    function closeWatch(): void {
      try {
        watcher?.close()
      } catch {
        // already closed
      }
      watcher = null
    }

    async function run(): Promise<void> {
      let attempt = 0
      while (!stopping) {
        report({ state: 'connecting' })
        watchFailure = null
        try {
          watcher = watch(
            dir,
            () => {
              changed = true
              poke()
            },
            (err) => {
              watchFailure = `the folder watch failed: ${reasonOf(err)}`
              poke()
            }
          )
        } catch (err) {
          watchFailure = `the folder ${dir} could not be watched: ${reasonOf(err)}`
        }

        if (watchFailure === null) {
          // The watch is armed before the first read, so a line appended
          // during the catch-up still raises a change and is read after it.
          report({ state: 'catching-up' })
          try {
            changed = false
            await drain()
            if (!stopping) report({ state: 'live' })
            attempt = 0
            while (!stopping && watchFailure === null) {
              if (!changed) {
                await new Promise<void>((resolve) => {
                  wake = resolve
                })
              }
              if (stopping || watchFailure !== null) break
              changed = false
              await drain()
            }
          } catch (err) {
            watchFailure = `the folder could not be read: ${reasonOf(err)}`
          }
        }
        closeWatch()
        if (stopping) break

        attempt += 1
        const waitMs = reconnectWaitMs(backoff, attempt)
        report({ state: 'waiting-to-reconnect', reason: watchFailure ?? 'the folder watch ended.', waitMs })
        await wait(waitMs, stopSignal.signal)
      }
      closeWatch()
      report({ state: 'stopped' })
    }

    const done = run()

    return {
      cursor: () => cursor,
      async stop() {
        if (!stopping) {
          stopping = true
          stopSignal.abort()
          poke()
        }
        await done
      },
      done
    }
  }

  return { id: source.id, follow }
}
