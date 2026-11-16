import {
  CLIENT_MESSAGE_MAX_BYTES,
  KEEPALIVE_MS,
  PROTOCOL_VERSION,
  parseClientMessage,
  type ServerMessage
} from '../lib/mission-control-protocol.ts'
import type { PictureService, PictureServiceEvent, RepositorySnapshot, Timers } from './picture-service.ts'
import { coverageView, repositoryView, statusView, taskView } from './projection.ts'
import type { StudioRepository } from './repositories.ts'

/**
 * The application WebSocket of Mission Control. It subscribes once to the shared picture service and fans each event
 * out to every connected page, so a second browser never starts a second Log follower. Authentication is the host's:
 * an upgrade reaches this handler only after the session, Host and Origin checks. This file runs under Node as
 * shipped, so it imports no Bun API.
 *
 * Per connection the rules are:
 *  - The first frame is a whole snapshot. Every snapshot starts a new generation; task and status frames carry the
 *    generation of the snapshot they follow, so a page can reject a frame from before its newest snapshot.
 *  - A changed task is sent whole, never as a patch.
 *  - A keep-alive frame every twenty seconds is transport liveness only; it carries no task and never moves silence.
 *  - A page that does not drain its socket is bounded: past the soft limit its frames are dropped and it is sent a
 *    fresh snapshot once it drains; past the hard limit it is closed and reconnects.
 *  - The page may send `resync` and nothing else; any other frame, or an oversized one, closes the connection.
 */

/** Bytes a connection may hold unsent before its frames are dropped for a later snapshot. */
export const SOFT_BUFFER_BYTES = 1024 * 1024
/** Bytes a connection may hold unsent before it is closed. */
export const HARD_BUFFER_BYTES = 4 * 1024 * 1024

const CLOSE_PROTOCOL = 1008
const CLOSE_TOO_BIG = 1009
const CLOSE_TRY_LATER = 1013
const CLOSE_GOING_AWAY = 1001
const OPEN = 1

/** The part of a `ws` WebSocket this endpoint uses, so tests drive it without a network. */
export type LiveSocket = {
  readonly readyState: number
  readonly bufferedAmount: number
  send(data: string): void
  close(code?: number, reason?: string): void
  on(event: 'message', listener: (data: unknown) => void): unknown
  on(event: 'close' | 'error', listener: () => void): unknown
}

export type LiveSocketOptions = {
  service: Pick<PictureService, 'snapshots' | 'subscribe'>
  /** The selected repositories, in launch order; each is named on the wire by its position, never its path. */
  repositories: readonly Pick<StudioRepository, 'root'>[]
  timers?: Timers
  keepAliveMs?: number
  softBufferBytes?: number
  hardBufferBytes?: number
}

export type LiveSocketEndpoint = {
  handler(socket: LiveSocket): void
  /** Ends every connection and the keep-alives, and leaves the service. Idempotent. */
  close(): void
  readonly connections: number
}

const realTimers: Timers = {
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>)
}

type Client = { socket: LiveSocket; generation: number; stale: boolean; keepAlive: unknown }

function frameText(data: unknown): string | null {
  if (typeof data === 'string') return data
  if (data instanceof Uint8Array) return Buffer.from(data).toString('utf8')
  if (Array.isArray(data) && data.every((d) => d instanceof Uint8Array)) return Buffer.concat(data).toString('utf8')
  return null
}

export function createLiveSocket(options: LiveSocketOptions): LiveSocketEndpoint {
  const timers = options.timers ?? realTimers
  const keepAliveMs = options.keepAliveMs ?? KEEPALIVE_MS
  const soft = options.softBufferBytes ?? SOFT_BUFFER_BYTES
  const hard = options.hardBufferBytes ?? HARD_BUFFER_BYTES
  const ids = new Map(options.repositories.map((r, i) => [r.root, `r${i + 1}`]))
  const clients = new Set<Client>()
  let closed = false

  const idOf = (snapshot: RepositorySnapshot): string | null => ids.get(snapshot.repository) ?? null

  function drop(client: Client, code: number, reason: string): void {
    if (!clients.delete(client)) return
    timers.clearInterval(client.keepAlive)
    try {
      client.socket.close(code, reason)
    } catch {
      // a socket that cannot close is already gone
    }
  }

  /** True when the frame may go out now; false when the connection is behind (and has been marked or closed). */
  function writable(client: Client): boolean {
    if (client.socket.readyState !== OPEN) return false
    const buffered = client.socket.bufferedAmount
    if (buffered > hard) {
      drop(client, CLOSE_TRY_LATER, 'too slow')
      return false
    }
    if (buffered > soft) {
      client.stale = true
      return false
    }
    return true
  }

  function write(client: Client, message: ServerMessage): void {
    try {
      client.socket.send(JSON.stringify(message))
    } catch {
      drop(client, CLOSE_TRY_LATER, 'send failed')
    }
  }

  function sendSnapshot(client: Client): void {
    client.generation += 1
    client.stale = false
    const repositories = options.service.snapshots().flatMap((s) => {
      const id = idOf(s)
      return id === null ? [] : [repositoryView(id, s)]
    })
    write(client, { v: PROTOCOL_VERSION, type: 'snapshot', generation: client.generation, repositories })
  }

  /** A stale connection that has drained gets a whole fresh snapshot instead of the frame it missed. */
  function deliver(client: Client, build: () => ServerMessage | null): void {
    if (!writable(client)) return
    if (client.stale) {
      sendSnapshot(client)
      return
    }
    const message = build()
    if (message) write(client, message)
  }

  const leave = options.service.subscribe((event: PictureServiceEvent) => {
    const id = idOf(event.snapshot)
    if (id === null) return
    for (const client of [...clients]) {
      if (event.type === 'snapshot') {
        if (writable(client)) sendSnapshot(client)
      } else if (event.type === 'status') {
        deliver(client, () => ({
          v: PROTOCOL_VERSION,
          type: 'status',
          generation: client.generation,
          repository: id,
          status: statusView(event.snapshot),
          coverage: coverageView(event.snapshot)
        }))
      } else {
        if (!writable(client)) continue
        // A client that fell behind gets one whole snapshot instead of the frames it missed.
        if (client.stale) {
          sendSnapshot(client)
          continue
        }
        for (const number of event.tasks) {
          const task = event.snapshot.picture.tasks.find((t) => t.task === number)
          if (!task || !writable(client)) continue
          write(client, {
            v: PROTOCOL_VERSION,
            type: 'task',
            generation: client.generation,
            repository: id,
            task: taskView(task)
          })
        }
        // The event's snapshot also carries the repository's connection and coverage as of these tasks.
        deliver(client, () => ({
          v: PROTOCOL_VERSION,
          type: 'status',
          generation: client.generation,
          repository: id,
          status: statusView(event.snapshot),
          coverage: coverageView(event.snapshot)
        }))
      }
    }
  })

  return {
    get connections() {
      return clients.size
    },
    handler(socket) {
      if (closed) {
        socket.close(CLOSE_GOING_AWAY, 'closing')
        return
      }
      const client: Client = { socket, generation: 0, stale: false, keepAlive: null }
      clients.add(client)
      client.keepAlive = timers.setInterval(() => {
        if (!writable(client)) return
        if (client.stale) return sendSnapshot(client)
        write(client, { v: PROTOCOL_VERSION, type: 'keepalive' })
      }, keepAliveMs)
      socket.on('message', (data) => {
        const textual = frameText(data)
        if (textual === null || textual.length > CLIENT_MESSAGE_MAX_BYTES) {
          return drop(client, CLOSE_TOO_BIG, 'message too large')
        }
        // The one thing a page may ask for is a fresh snapshot. Nothing it sends can run anything.
        if (parseClientMessage(textual) === null) return drop(client, CLOSE_PROTOCOL, 'unknown message')
        if (writable(client)) sendSnapshot(client)
      })
      socket.on('close', () => {
        if (clients.delete(client)) timers.clearInterval(client.keepAlive)
      })
      socket.on('error', () => drop(client, CLOSE_PROTOCOL, 'socket error'))
      sendSnapshot(client)
    },
    close() {
      if (closed) return
      closed = true
      leave()
      for (const client of [...clients]) drop(client, CLOSE_GOING_AWAY, 'closing')
    }
  }
}
