import {
  createServerLogSource,
  type RetentionStatement,
  SERVER_SOURCE_PAGE_MAX
} from '../../../../harness/kernel/log/client/log-sync-server-source.ts'
import type { LogSource, SourceCursor, SourceGap, SourceLine } from '../../../../harness/kernel/log/sync/contracts.ts'
import { normalizeStoredLine } from '../../../../harness/kernel/log/sync/normalize.ts'
import type { NormalizedLine } from '../../../../harness/kernel/log/sync/row.ts'
import {
  type Picture,
  emptyPicture
} from '../../../../harness/processes/vinaya-strict/tools/mission-control/picture.ts'
import { reduce, tick } from '../../../../harness/processes/vinaya-strict/tools/mission-control/reading.ts'
import type { LogSourceSpec, StudioRepository } from './repositories.ts'

/**
 * The repository-picture service: one per Studio launch, one shared task picture per selected repository. It combines a
 * repository's Log source, its follower and the pure Mission Control reading, and nothing else — no HTTP, no React, no
 * browser transport — so another launcher can reuse it. Every effect (clock, timers, sources, followers) is a
 * constructor argument; production callers pass nothing and get the real ones.
 *
 * Rules the code below keeps (the spec holds the product statement):
 *  - A server source opens on its recent stretch, counted back from the head the source itself states, and follows from
 *    exactly the last position read. A folder source opens on everything its live files hold.
 *  - Source cursors are opaque. The reading's own `position` is a separate per-repository counter that only grows.
 *  - Historical lines keep their recorded time; only lines received live (first connection, state `live`) take the
 *    local receipt time. An unreadable recorded time is unknown freshness, read as time 0 — never a new heartbeat.
 *  - Only the one thirty-second timer moves silence (`tick`); an event never does.
 *  - A feed entry keeps the identity of the source event (the normalised row's), never the per-service sequence, the
 *    receipt time or a socket generation; a wait's start is the receipt time of the event that opened it.
 *  - Anything the service cannot know is declared as a coverage limit, never a claim of a complete or live picture.
 */

/** The silence clock: one timer, every thirty seconds. */
export const TICK_INTERVAL_MS = 30_000
/** Events a server opening reads back from the stated head. */
export const DEFAULT_STRETCH = 5_000
/** Narrated feed entries kept per task; older narration is dropped, state signals and round facts never are. */
export const FEED_CAP = 200

export type Budgets = {
  /** Distinct event identities remembered for de-duplication. Never aged out. */
  identities: number
  tasks: number
  roundsPerTask: number
  /** Raw bytes read while opening one repository. */
  bootstrapBytes: number
}

export const DEFAULT_BUDGETS: Budgets = {
  identities: 100_000,
  tasks: 10_000,
  roundsPerTask: 1_000,
  bootstrapBytes: 64 * 1024 * 1024
}

/**
 * The follower contract of `harness/kernel/log/client/log-follow.ts`, restated structurally. The kernel module is
 * loaded only at run time (see `createRealSource`): importing it, even for a type, would bring the whole Log writer
 * into this app's type program.
 */
export type FollowState = 'connecting' | 'live' | 'catching-up' | 'waiting-to-reconnect' | 'stopped'
export type FollowStateChange = { state: FollowState; reason?: string; waitMs?: number }
export type FollowSink = {
  line(line: SourceLine): void
  state?(change: FollowStateChange): void
  gap?(gap: SourceGap): void
}
export type FollowHandle = {
  cursor(): SourceCursor | null
  stop(): Promise<void>
  readonly done: Promise<void>
}
export interface LogFollower {
  readonly id: string
  follow(from: SourceCursor | null, sink: FollowSink): FollowHandle
}

export type SourceHandle = {
  source: LogSource & { retention?: () => Promise<RetentionStatement> }
  follower: LogFollower
}
export type SourceFactory = (spec: LogSourceSpec, repository: StudioRepository) => SourceHandle | Promise<SourceHandle>

export type Timers = {
  setInterval: (handler: () => void, ms: number) => unknown
  clearInterval: (handle: unknown) => void
}

export type PictureServiceOptions = {
  /** The repositories the launcher selected, each with its resolved source. */
  repositories: readonly StudioRepository[]
  clock?: () => number
  timers?: Timers
  createSource?: SourceFactory
  /** Events read back from the stated head when a server source opens. */
  stretch?: number
  /** Lines asked of the source per page. */
  pageSize?: number
  budgets?: Partial<Budgets>
  tickMs?: number
}

export type Connection = 'opening' | 'catching-up' | 'live' | 'reconnecting' | 'stopped' | 'unavailable'

export type CoverageLimitKind =
  | 'opening-limited'
  | 'retention-gap'
  | 'retention-unknown'
  | 'rotation-unknown'
  | 'source-gap'
  | 'source-limited'
  | 'chronology-limited'
  | 'unreadable-records'
  | 'capacity-limited'

export type CoverageLimit = { kind: CoverageLimitKind; detail: string }

export type RepositoryStatus = {
  /** `live` only while the follower is live and nothing below is exhausted; otherwise the picture is not claimed to be current. */
  live: boolean
  connection: Connection
  reason: string | null
}

export type RepositoryCoverage = {
  /** Where a server opening started reading (the source's own position, as text); `null` for a folder or before opening. */
  startPosition: string | null
  /** No declared limit. A picture with limits is partial, whatever its connection. */
  complete: boolean
  limits: CoverageLimit[]
}

export type RepositoryDiagnostics = {
  applied: number
  duplicates: number
  unreadable: number
  heldBack: number
  identities: number
  bootstrapBytes: number
  sequence: number
  lastAppliedPosition: string | null
}

export type RepositorySnapshot = {
  repository: string
  remote: string | null
  sourceKind: 'folder' | 'server' | null
  status: RepositoryStatus
  coverage: RepositoryCoverage
  picture: Picture
  /** Tasks whose start record was never read: whatever their recorded events show, the rest is unknown. */
  partialTasks: number[]
  /** Tasks that received a record older than their newest applied one: held back, last reliable standing kept. */
  chronologyLimitedTasks: number[]
  diagnostics: RepositoryDiagnostics
}

export type PictureServiceEvent =
  | { type: 'snapshot'; repository: string; snapshot: RepositorySnapshot }
  | { type: 'changed'; repository: string; tasks: number[]; snapshot: RepositorySnapshot }
  | { type: 'status'; repository: string; snapshot: RepositorySnapshot }

export type PictureService = {
  /** Opens every repository's source and starts the one clock. Resolves when every opening has settled. Idempotent. */
  start(): Promise<void>
  snapshot(repository: string): RepositorySnapshot | null
  snapshots(): RepositorySnapshot[]
  subscribe(listener: (event: PictureServiceEvent) => void): () => void
  /** Stops the clock, every follower (timers, watchers, sockets) and every listener. Idempotent. */
  close(): Promise<void>
}

// ---------------------------------------------------------------------------
// Default dependencies

const realTimers: Timers = {
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>)
}

/**
 * The follower and the folder source are files of the host's own runtime: the CLI builds each for Node beside the host
 * (in the packed bundle and in a checkout's host output) and they are loaded by a path resolved from this running
 * module. The specifier is a variable, so neither the type program nor `next build` follows it.
 */
export const LOG_FOLLOW_FILENAME = 'log-follow.mjs'
export const FOLDER_SOURCE_FILENAME = 'log-sync-folder-source.mjs'

type KernelFollow = {
  createFolderLogFollower(deps: { folderRoot: string; repo: StudioRepository['remote'] }): LogFollower
  createServerLogFollower(deps: Record<string, unknown>): LogFollower
}

/** A source factory that loads the two runtime files from `runtimeDir` (a folder URL). A file that cannot be loaded rejects. */
export function createRealSourceFrom(runtimeDir: string | URL): SourceFactory {
  const load = (filename: string): Promise<unknown> => {
    const specifier = new URL(filename, runtimeDir).href
    return import(specifier)
  }
  return async (spec, repository) => {
    const follow = (await load(LOG_FOLLOW_FILENAME)) as KernelFollow
    if (spec.kind === 'folder') {
      const folder = (await load(FOLDER_SOURCE_FILENAME)) as {
        createFolderLogSource(deps: { folderRoot: string; repo: StudioRepository['remote'] }): LogSource
      }
      const deps = { folderRoot: spec.folderRoot, repo: repository.remote }
      return { source: folder.createFolderLogSource(deps), follower: follow.createFolderLogFollower(deps) }
    }
    const deps = {
      eventsUrl: spec.url,
      readHeaders: spec.readHeaders,
      env: process.env,
      fetchImpl: (input: string, init?: RequestInit) => fetch(input, init),
      WebSocketImpl: globalThis.WebSocket
    }
    return { source: createServerLogSource(deps), follower: follow.createServerLogFollower(deps) }
  }
}

/** The real source and follower of one repository's spec, loaded from the folder this module runs in. */
export const createRealSource: SourceFactory = (spec, repository) =>
  createRealSourceFrom(new URL('./', import.meta.url))(spec, repository)

// ---------------------------------------------------------------------------
// Reading a stored line

function validTime(text: string): number | null {
  const ms = Date.parse(text)
  return Number.isFinite(ms) ? ms : null
}

function whole(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

/** The task a row names itself: its Issue, else the task a loop record names. Loop membership is the picture's to resolve. */
function namedTask(line: NormalizedLine): number | null {
  if (line.type !== 'row') return null
  return line.row.issue ?? whole(line.row.payload.task)
}

function isLoopStart(line: NormalizedLine): boolean {
  return line.type === 'row' && line.row.kind === 'dev_review_loop' && line.row.event === 'loop_started'
}

function recordedTime(line: NormalizedLine): number | null {
  return line.type === 'row' ? validTime(line.row.time) : null
}

function normalize(source: string, line: SourceLine): NormalizedLine | null {
  try {
    return normalizeStoredLine(line.raw, { source, position: line.position })
  } catch {
    return null
  }
}

/** The folder source's position is `<stream>:<live|rotated>:<byte>`; the stream is the machine's own file. */
function streamOf(position: string): string {
  return position.split(':')[0] ?? position
}

type Phase = 'bootstrap' | 'follow'

type RepoState = {
  repository: StudioRepository
  kind: 'folder' | 'server' | null
  handle: SourceHandle | null
  follow: FollowHandle | null
  picture: Picture
  sequence: number
  seen: Set<string>
  bytes: number
  connection: Connection
  reason: string | null
  limits: Map<string, CoverageLimit>
  startPosition: string | null
  startSeen: Set<number>
  tasksSeen: Set<number>
  lastChrono: Map<number, number>
  chronologyLimited: Set<number>
  exhausted: string | null
  followerLive: boolean
  everLive: boolean
  reconnected: boolean
  applied: number
  duplicates: number
  unreadable: number
  heldBack: number
  lastApplied: string | null
}

export function createPictureService(options: PictureServiceOptions): PictureService {
  const clock = options.clock ?? Date.now
  const timers = options.timers ?? realTimers
  const createSource = options.createSource ?? createRealSource
  const stretch = Math.max(0, options.stretch ?? DEFAULT_STRETCH)
  const pageSize = Math.max(1, Math.min(options.pageSize ?? SERVER_SOURCE_PAGE_MAX, SERVER_SOURCE_PAGE_MAX))
  const budgets: Budgets = { ...DEFAULT_BUDGETS, ...options.budgets }
  const tickMs = options.tickMs ?? TICK_INTERVAL_MS

  const repos = new Map<string, RepoState>()
  for (const repository of options.repositories) {
    repos.set(repository.root, {
      repository,
      kind: repository.source.ok ? repository.source.spec.kind : null,
      handle: null,
      follow: null,
      picture: emptyPicture(),
      sequence: 0,
      seen: new Set(),
      bytes: 0,
      connection: 'opening',
      reason: null,
      limits: new Map(),
      startPosition: null,
      startSeen: new Set(),
      tasksSeen: new Set(),
      lastChrono: new Map(),
      chronologyLimited: new Set(),
      exhausted: null,
      followerLive: false,
      everLive: false,
      reconnected: false,
      applied: 0,
      duplicates: 0,
      unreadable: 0,
      heldBack: 0,
      lastApplied: null
    })
  }

  const listeners = new Set<(event: PictureServiceEvent) => void>()
  let closed = false
  let started: Promise<void> | null = null
  let timer: unknown = null

  // -------------------------------------------------------------------------
  // Snapshots and notifications

  function snapshotOf(repo: RepoState): RepositorySnapshot {
    const limits = [...repo.limits.values()]
    if (repo.chronologyLimited.size > 0) {
      limits.push({
        kind: 'chronology-limited',
        detail: `records older than the newest applied one were held back for task(s) ${[...repo.chronologyLimited].sort((a, b) => a - b).join(', ')}.`
      })
    }
    const live = repo.connection === 'live' && repo.exhausted === null
    return {
      repository: repo.repository.root,
      remote: repo.repository.remote ? `${repo.repository.remote.owner}/${repo.repository.remote.repo}` : null,
      sourceKind: repo.kind,
      status: { live, connection: repo.connection, reason: repo.reason },
      coverage: { startPosition: repo.startPosition, complete: limits.length === 0, limits },
      picture: repo.picture,
      partialTasks: repo.picture.tasks
        .map((t) => t.task)
        .filter((t) => !repo.startSeen.has(t))
        .sort((a, b) => a - b),
      chronologyLimitedTasks: [...repo.chronologyLimited].sort((a, b) => a - b),
      diagnostics: {
        applied: repo.applied,
        duplicates: repo.duplicates,
        unreadable: repo.unreadable,
        heldBack: repo.heldBack,
        identities: repo.seen.size,
        bootstrapBytes: repo.bytes,
        sequence: repo.sequence,
        lastAppliedPosition: repo.lastApplied
      }
    }
  }

  function emit(event: PictureServiceEvent): void {
    if (closed) return
    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch {
        // one failing listener never stops the others or the reading
      }
    }
  }

  const emitStatus = (repo: RepoState): void =>
    emit({ type: 'status', repository: repo.repository.root, snapshot: snapshotOf(repo) })

  function setConnection(repo: RepoState, connection: Connection, reason: string | null = null): void {
    repo.connection = connection
    repo.reason = reason
    emitStatus(repo)
  }

  // -------------------------------------------------------------------------
  // Applying one line

  function exhaust(repo: RepoState, what: string): void {
    if (repo.exhausted !== null) return
    repo.exhausted = what
    repo.limits.set('capacity-limited', {
      kind: 'capacity-limited',
      detail: `${what} budget exhausted: the source stopped advancing at ${repo.lastApplied ?? 'its start'}; the picture so far is kept and is not live or complete.`
    })
    const follow = repo.follow
    repo.follow = null
    repo.connection = 'stopped'
    repo.reason = `${what} budget exhausted.`
    void follow?.stop()
    emitStatus(repo)
  }

  function receivedAtFor(repo: RepoState, line: NormalizedLine, phase: Phase): number {
    const recorded = recordedTime(line)
    if (phase === 'bootstrap') return recorded ?? 0
    if (repo.followerLive && !repo.reconnected) return clock()
    // A backlog, or anything after a reconnect: never newer than its recorded time, never newer than now.
    return recorded === null ? 0 : Math.min(recorded, clock())
  }

  /** Reads one normalised line into the repository's picture. Returns the task it changed, if any. */
  function ingest(repo: RepoState, position: string, line: NormalizedLine, phase: Phase): number | null {
    if (repo.exhausted !== null) return null
    if (line.type === 'quarantine') {
      repo.unreadable += 1
      repo.limits.set('unreadable-records', {
        kind: 'unreadable-records',
        detail: `${repo.unreadable} stored line(s) could not be read and were skipped, never guessed.`
      })
    }
    const key = line.type === 'row' ? line.row.identity : `quarantine:${line.record.contentHash}`
    if (repo.seen.has(key)) {
      repo.duplicates += 1
      return null
    }
    if (repo.seen.size >= budgets.identities) {
      exhaust(repo, 'event identity')
      return null
    }

    const task = namedTask(line)
    const recorded = recordedTime(line)
    // A folder record older than the newest one applied for its task never overwrites the standing.
    if (repo.kind === 'folder' && phase === 'follow' && task !== null && recorded !== null) {
      const newest = repo.lastChrono.get(task)
      if (newest !== undefined && recorded < newest) {
        repo.seen.add(key)
        repo.heldBack += 1
        repo.chronologyLimited.add(task)
        return task
      }
    }

    const before = repo.picture
    const sequence = repo.sequence + 1
    const read = reduce(before, { position: sequence, receivedAt: receivedAtFor(repo, line, phase), line })
    let after = read
    const id = task ?? (line.type === 'row' ? resolveLoopTask(read, line) : null)
    if (id !== null) {
      const changed = after.tasks.find((t) => t.task === id)
      if (changed) {
        if (changed.rounds.length > budgets.roundsPerTask) {
          exhaust(repo, 'rounds per task')
          return null
        }
        if (changed.feed.length > FEED_CAP) {
          const trimmed = { ...changed, feed: changed.feed.slice(-FEED_CAP) }
          after = { ...after, tasks: after.tasks.map((t) => (t.task === id ? trimmed : t)) }
        }
      }
    }
    if (after.tasks.length > budgets.tasks) {
      exhaust(repo, 'task')
      return null
    }

    repo.picture = after
    repo.sequence = sequence
    repo.seen.add(key)
    repo.applied += 1
    repo.lastApplied = position
    if (id !== null) {
      repo.tasksSeen.add(id)
      if (isLoopStart(line)) repo.startSeen.add(id)
      if (recorded !== null) repo.lastChrono.set(id, Math.max(repo.lastChrono.get(id) ?? recorded, recorded))
    }
    return id
  }

  function resolveLoopTask(picture: Picture, line: NormalizedLine): number | null {
    if (line.type !== 'row') return null
    const loopId = line.row.payload.loop_id
    return typeof loopId === 'string' ? (picture.loops[loopId] ?? null) : null
  }

  // -------------------------------------------------------------------------
  // Opening

  function reasonOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
  }

  function unavailable(repo: RepoState, reason: string): void {
    setConnection(repo, 'unavailable', reason)
  }

  function present(repo: RepoState): void {
    repo.picture = tick(repo.picture, clock()).picture
    emit({ type: 'snapshot', repository: repo.repository.root, snapshot: snapshotOf(repo) })
  }

  function startFollow(repo: RepoState, from: SourceCursor | null): void {
    const handle = repo.handle
    if (handle === null || closed || repo.exhausted !== null) return
    repo.followerLive = false
    const follow = handle.follower.follow(from, {
      line(line) {
        if (closed || repo.exhausted !== null) return
        const normalized = normalize(handle.source.id, line)
        if (normalized === null) return
        const changed = ingest(repo, line.position, normalized, 'follow')
        if (changed !== null && !closed) {
          emit({
            type: 'changed',
            repository: repo.repository.root,
            tasks: [changed],
            snapshot: snapshotOf(repo)
          })
        }
      },
      state(change) {
        onFollowState(repo, change)
      },
      gap(gap) {
        repo.limits.set(`source-gap:${gap.from ?? ''}`, {
          kind: 'source-gap',
          detail: `${gap.reason} (from ${gap.from ?? 'an unknown position'}).`
        })
        emitStatus(repo)
      }
    })
    repo.follow = follow
    void follow.done.then(() => {
      if (repo.follow === follow && !closed && repo.exhausted === null) {
        repo.follow = null
        setConnection(repo, 'unavailable', repo.reason ?? 'the follow ended.')
      }
    })
  }

  function onFollowState(repo: RepoState, change: FollowStateChange): void {
    if (closed || repo.exhausted !== null) return
    switch (change.state) {
      case 'live':
        repo.followerLive = true
        repo.everLive = true
        setConnection(repo, 'live')
        return
      case 'catching-up':
        repo.followerLive = false
        if (repo.everLive) repo.reconnected = true
        setConnection(repo, 'catching-up')
        return
      case 'connecting':
        repo.followerLive = false
        if (repo.everLive) repo.reconnected = true
        setConnection(repo, repo.everLive ? 'reconnecting' : 'catching-up')
        return
      case 'waiting-to-reconnect':
        repo.followerLive = false
        repo.reconnected = true
        setConnection(repo, 'reconnecting', change.reason ?? 'the source dropped.')
        return
      case 'stopped':
        repo.followerLive = false
        setConnection(repo, 'unavailable', change.reason ?? 'the follow stopped.')
        return
    }
  }

  async function openServer(repo: RepoState): Promise<void> {
    const handle = repo.handle as SourceHandle
    if (!handle.source.retention) return unavailable(repo, 'the source cannot state what it retains.')
    const retention = await handle.source.retention()
    if (closed) return
    if (!retention.head.known) return unavailable(repo, retention.head.reason)
    const head = retention.head.value
    const start = Math.max(0, head - stretch)
    repo.startPosition = String(start)
    if (start > 0) {
      repo.limits.set('opening-limited', {
        kind: 'opening-limited',
        detail: `opened on the ${stretch} newest events, from position ${start} of ${head}; earlier start records and rounds are unknown.`
      })
    }
    if (retention.gap.known && retention.gap.value > 0) {
      repo.limits.set('retention-gap', {
        kind: 'retention-gap',
        detail: `the server retains ${retention.gap.value} fewer events than its head states.`
      })
    } else if (!retention.gap.known) {
      repo.limits.set('retention-unknown', { kind: 'retention-unknown', detail: retention.gap.reason })
    }

    let cursor: SourceCursor = String(start)
    try {
      for (;;) {
        const page = await handle.source.readPage(cursor, pageSize)
        if (closed) return
        if (page.lines.length === 0 || page.next === null) break
        for (const line of page.lines) {
          const normalized = normalize(handle.source.id, line)
          if (normalized === null) continue
          repo.bytes += Buffer.byteLength(line.raw)
          if (repo.bytes > budgets.bootstrapBytes) {
            exhaust(repo, 'bootstrap data')
            break
          }
          ingest(repo, line.position, normalized, 'bootstrap')
          if (repo.exhausted !== null) break
          cursor = line.position
        }
        if (repo.exhausted !== null) break
      }
    } catch (err) {
      return unavailable(repo, reasonOf(err))
    }
    if (repo.exhausted !== null) {
      present(repo)
      return
    }
    repo.connection = 'catching-up'
    present(repo)
    startFollow(repo, cursor)
  }

  type Entry = { stream: string; line: SourceLine; normalized: NormalizedLine; time: number | null; effective: number }

  async function openFolder(repo: RepoState): Promise<void> {
    const handle = repo.handle as SourceHandle
    repo.limits.set('rotation-unknown', {
      kind: 'rotation-unknown',
      detail:
        'a fresh read covers the folder’s live files; rotated slots are not read, so an early record of a task may be missing.'
    })
    const buffered: SourceLine[] = []
    let cursor: SourceCursor | null = null
    let overflow = false
    try {
      for (;;) {
        const page = await handle.source.readPage(cursor, pageSize)
        if (closed) return
        for (const gap of page.gaps) {
          repo.limits.set(`source-gap:${gap.from ?? ''}`, {
            kind: 'source-gap',
            detail: `${gap.reason} (from ${gap.from ?? 'an unknown position'}).`
          })
        }
        for (const line of page.lines) {
          repo.bytes += Buffer.byteLength(line.raw)
          if (repo.bytes > budgets.bootstrapBytes) {
            overflow = true
            break
          }
          buffered.push(line)
        }
        if (overflow) break
        if (page.next !== null) cursor = page.next
        if (page.lines.length === 0) break
      }
    } catch (err) {
      return unavailable(repo, reasonOf(err))
    }

    // Order the opening set: every stream keeps its own order; only the heads of different streams are compared.
    const streams = new Map<string, Entry[]>()
    let missing = false
    let contradictory = false
    for (const line of buffered) {
      const normalized = normalize(handle.source.id, line)
      if (normalized === null) continue
      const stream = streamOf(line.position)
      const queue = streams.get(stream) ?? []
      const time = recordedTime(normalized)
      const previous = queue.at(-1)?.effective ?? Number.NEGATIVE_INFINITY
      if (time === null) missing = true
      else if (time < previous) contradictory = true
      queue.push({ stream, line, normalized, time, effective: time === null ? previous : Math.max(previous, time) })
      streams.set(stream, queue)
    }
    if (missing || contradictory) {
      repo.limits.set('source-limited', {
        kind: 'source-limited',
        detail: `${missing ? 'a record has no readable time' : 'a stream’s recorded times run backwards'}: the order across machines is not authoritative.`
      })
    }
    const heads = new Map<string, number>()
    const names = [...streams.keys()].sort()
    for (const name of names) heads.set(name, 0)
    let ambiguous = false
    for (;;) {
      let best: Entry | null = null
      let tied = false
      for (const name of names) {
        const queue = streams.get(name) as Entry[]
        const entry = queue[heads.get(name) as number]
        if (!entry) continue
        if (best === null) {
          best = entry
          continue
        }
        const byTime = entry.effective - best.effective
        const byStart = Number(!isLoopStart(entry.normalized)) - Number(!isLoopStart(best.normalized))
        if (byTime < 0 || (byTime === 0 && byStart < 0)) {
          best = entry
          tied = false
        } else if (byTime === 0 && byStart === 0) {
          const a = namedTask(entry.normalized)
          if (a !== null && a === namedTask(best.normalized)) tied = true
        }
      }
      if (best === null) break
      if (tied) ambiguous = true
      heads.set(best.stream, (heads.get(best.stream) as number) + 1)
      ingest(repo, best.line.position, best.normalized, 'bootstrap')
      if (repo.exhausted !== null) break
    }
    if (ambiguous) {
      repo.limits.set('source-limited', {
        kind: 'source-limited',
        detail: 'two machines recorded the same task at the same instant: their order is not authoritative.'
      })
    }
    if (overflow) exhaust(repo, 'bootstrap data')
    if (repo.exhausted === null) repo.connection = 'catching-up'
    present(repo)
    if (repo.exhausted !== null) return
    startFollow(repo, cursor)
  }

  async function open(repo: RepoState): Promise<void> {
    const source = repo.repository.source
    if (!source.ok) return unavailable(repo, source.message)
    try {
      repo.handle = await createSource(source.spec, repo.repository)
      if (closed) return
      if (source.spec.kind === 'server') await openServer(repo)
      else await openFolder(repo)
    } catch (err) {
      if (!closed) unavailable(repo, reasonOf(err))
    }
  }

  // -------------------------------------------------------------------------
  // The one clock

  function onTick(): void {
    if (closed) return
    const now = clock()
    for (const repo of repos.values()) {
      const result = tick(repo.picture, now)
      repo.picture = result.picture
      if (result.changed.length > 0) {
        emit({
          type: 'changed',
          repository: repo.repository.root,
          tasks: result.changed,
          snapshot: snapshotOf(repo)
        })
      }
    }
  }

  return {
    start() {
      if (closed) return Promise.resolve()
      if (started === null) {
        timer = timers.setInterval(onTick, tickMs)
        started = Promise.all([...repos.values()].map(open)).then(() => undefined)
      }
      return started
    },
    snapshot(repository) {
      const repo = repos.get(repository)
      return repo ? snapshotOf(repo) : null
    },
    snapshots() {
      return [...repos.values()].map(snapshotOf)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async close() {
      if (closed) return
      closed = true
      if (timer !== null) timers.clearInterval(timer)
      timer = null
      listeners.clear()
      const stops: Promise<void>[] = []
      for (const repo of repos.values()) {
        const follow = repo.follow
        repo.follow = null
        if (follow) stops.push(follow.stop())
      }
      await Promise.all(stops)
    }
  }
}
