import {
  PROTOCOL_VERSION,
  parseServerMessage,
  RECONNECT_DELAYS_MS,
  RECONNECT_MAX_ATTEMPTS,
  SILENCE_LIMIT_MS,
  type CoverageView,
  type RepositoryView,
  type StatusView,
  type TaskView
} from './mission-control-protocol.ts'

/**
 * The browser's subscription to Mission Control, independent of React. It owns one WebSocket at a time and holds the
 * picture the server last sent: a whole snapshot replaces everything, a task frame replaces one whole task. State
 * rules stay on the server; nothing here derives a task's state.
 *
 * Rules the code keeps:
 *  - A frame is read only from the current socket. A socket replaced by a reconnect, or closed by disposal, is ignored
 *    for good, including its late callbacks.
 *  - A frame of the wrong version or an unknown type closes the socket (and so reconnects); it is never half-applied.
 *  - A task or status frame whose generation is not the newest snapshot's is ignored.
 *  - A dropped socket keeps the last picture and its last-update time and reads as `reconnecting`. A reconnect needs no
 *    credential beyond the session cookie the browser already holds; nothing here knows the launch token.
 *  - Silence is judged by the transport: no frame, keep-alive included, for `SILENCE_LIMIT_MS` drops the socket. A
 *    keep-alive proves the socket only; it never counts as a task sign of life.
 *  - `dispose()` clears the socket's listeners and every timer.
 */

export type ConnectionPhase = 'connecting' | 'open' | 'reconnecting' | 'failed' | 'disposed'

export type RepositoryState = {
  id: string
  remote: string | null
  status: StatusView
  coverage: CoverageView
  tasks: Record<number, TaskView>
}

export type MissionControlState = {
  phase: ConnectionPhase
  /** Generation of the snapshot the repositories below came from; 0 before the first. */
  generation: number
  repositories: Record<string, RepositoryState>
  /** When the last snapshot or task or status frame was applied; kept across a drop. `null` before the first. */
  lastUpdateAt: number | null
  /** Failed connection attempts since the last snapshot. */
  attempts: number
}

/** The part of a browser WebSocket the subscription uses. */
export type ConnectionSocket = {
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
  send(data: string): void
  close(code?: number): void
}

export type ConnectionTimers = {
  setTimeout: (handler: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

export type MissionControlConnectionOptions = {
  /** Opens a new socket to the application route. Called once per attempt; carries no token. */
  createSocket: () => ConnectionSocket
  timers?: ConnectionTimers
  clock?: () => number
  delays?: readonly number[]
  maxAttempts?: number
  silenceMs?: number
}

export type MissionControlConnection = {
  getState(): MissionControlState
  subscribe(listener: () => void): () => void
  /** Starts connecting. Idempotent. */
  connect(): void
  /** Asks the server for a fresh snapshot over the open socket. */
  resync(): void
  /** After `failed`, starts again from the first attempt. */
  retry(): void
  dispose(): void
}

const realTimers: ConnectionTimers = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

export function createMissionControlConnection(options: MissionControlConnectionOptions): MissionControlConnection {
  const timers = options.timers ?? realTimers
  const clock = options.clock ?? Date.now
  const delays = options.delays ?? RECONNECT_DELAYS_MS
  const maxAttempts = options.maxAttempts ?? RECONNECT_MAX_ATTEMPTS
  const silenceMs = options.silenceMs ?? SILENCE_LIMIT_MS

  let state: MissionControlState = {
    phase: 'connecting',
    generation: 0,
    repositories: {},
    lastUpdateAt: null,
    attempts: 0
  }
  const listeners = new Set<() => void>()
  let socket: ConnectionSocket | null = null
  let started = false
  let retryTimer: unknown = null
  let silenceTimer: unknown = null

  function set(next: Partial<MissionControlState>): void {
    state = { ...state, ...next }
    for (const listener of [...listeners]) listener()
  }

  function clearTimers(): void {
    if (retryTimer !== null) timers.clearTimeout(retryTimer)
    if (silenceTimer !== null) timers.clearTimeout(silenceTimer)
    retryTimer = null
    silenceTimer = null
  }

  function release(target: ConnectionSocket | null): void {
    if (!target) return
    target.onopen = target.onmessage = target.onclose = target.onerror = null
    try {
      target.close(1000)
    } catch {
      // already closed
    }
  }

  function armSilence(current: ConnectionSocket): void {
    if (silenceTimer !== null) timers.clearTimeout(silenceTimer)
    silenceTimer = timers.setTimeout(() => {
      if (socket === current) lost(current)
    }, silenceMs)
  }

  /** The current socket ended: keep the picture, schedule one reconnect, or give up after the bound. */
  function lost(current: ConnectionSocket): void {
    if (socket !== current) return
    release(current)
    socket = null
    clearTimers()
    const attempts = state.attempts + 1
    if (attempts > maxAttempts) {
      set({ phase: 'failed', attempts })
      return
    }
    set({ phase: 'reconnecting', attempts })
    const delay = delays[Math.min(attempts - 1, delays.length - 1)] ?? 30_000
    retryTimer = timers.setTimeout(() => {
      retryTimer = null
      open()
    }, delay)
  }

  function apply(current: ConnectionSocket, data: unknown) {
    const message = typeof data === 'string' ? parseServerMessage(data) : null
    if (message === null) return lost(current)
    armSilence(current)
    switch (message.type) {
      case 'keepalive':
        return
      case 'snapshot': {
        const repositories: Record<string, RepositoryState> = {}
        for (const r of message.repositories) repositories[r.id] = fromView(r)
        return set({
          phase: 'open',
          generation: message.generation,
          repositories,
          lastUpdateAt: clock(),
          attempts: 0
        })
      }
      case 'task': {
        const repo = state.repositories[message.repository]
        if (message.generation !== state.generation || !repo) return
        return set({
          repositories: {
            ...state.repositories,
            [repo.id]: { ...repo, tasks: { ...repo.tasks, [message.task.task]: message.task } }
          },
          lastUpdateAt: clock()
        })
      }
      case 'status': {
        const repo = state.repositories[message.repository]
        if (message.generation !== state.generation || !repo) return
        return set({
          repositories: {
            ...state.repositories,
            [repo.id]: { ...repo, status: message.status, coverage: message.coverage }
          },
          lastUpdateAt: clock()
        })
      }
    }
  }

  function open(): void {
    if (state.phase === 'disposed') return
    const current = options.createSocket()
    socket = current
    if (state.phase !== 'reconnecting') set({ phase: 'connecting' })
    armSilence(current)
    current.onopen = () => {
      if (socket === current) armSilence(current)
    }
    current.onmessage = (event) => {
      if (socket === current) apply(current, event.data)
    }
    current.onclose = () => lost(current)
    current.onerror = () => lost(current)
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    connect() {
      if (started || state.phase === 'disposed') return
      started = true
      open()
    },
    resync() {
      if (!socket || state.phase !== 'open') return
      socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'resync' }))
    },
    retry() {
      if (state.phase !== 'failed') return
      state = { ...state, attempts: 0 }
      open()
    },
    dispose() {
      if (state.phase === 'disposed') return
      clearTimers()
      release(socket)
      socket = null
      state = { ...state, phase: 'disposed' }
      for (const listener of [...listeners]) listener()
      listeners.clear()
    }
  }
}

function fromView(view: RepositoryView): RepositoryState {
  const tasks: Record<number, TaskView> = {}
  for (const task of view.tasks) tasks[task.task] = task
  return { id: view.id, remote: view.remote, status: view.status, coverage: view.coverage, tasks }
}
