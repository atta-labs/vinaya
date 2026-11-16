import { EventEmitter } from 'node:events'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { type WebSocket, WebSocketServer } from 'ws'
import { LIVE_HELLO, LIVE_ROUTE } from './live-protocol.ts'
import { type RepositoryView, repositoryViews, type StudioRepository } from './repositories.ts'
import { BOOTSTRAP_ROUTE, createSessionGuard, type SessionDecision } from './session.ts'

/**
 * Studio's one local application server. It owns the HTTP listener, answers WebSocket upgrades on the application
 * route itself, and hands everything else to Next through Next's public custom-server API. This file runs under Node as
 * shipped, so it imports no Bun API. Importing it starts nothing: a listener exists only after `listen()`.
 */

export { LIVE_HELLO, LIVE_ROUTE }

/** The minimal live task-list endpoint of this tranche. It carries no repository data. */
export const TASK_LIST_ROUTE = '/api/mission-control/tasks'

/** The repositories this launch observes and the state of each one's Log source. It carries no credential. */
export const REPOSITORIES_ROUTE = '/api/mission-control/repositories'

/** How long `close()` waits for connections to end before it destroys them. */
export const CLOSE_GRACE_MS = 3_000

type NextApp = {
  prepare(): Promise<void>
  getRequestHandler(): (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
  close?: () => Promise<void>
}

export type NextFactory = (options: {
  dev: boolean
  dir: string
  hostname: string
  port: number
  httpServer: Server
}) => NextApp | Promise<NextApp>

export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
export type SocketHandler = (socket: WebSocket, req: IncomingMessage) => void

export type StudioComposition = {
  /** Registers an application HTTP route, matched on the exact path. */
  route(path: string, handler: RouteHandler): void
  /** Registers an application WebSocket route, matched on the exact path. */
  socket(path: string, handler: SocketHandler): void
  /** The host's clock. */
  clock: () => number
  /** The repositories the launcher selected, each with its resolved Log source. Server-side only. */
  repositories: readonly StudioRepository[]
}

export type StudioHostOptions = {
  /** The Next project folder: the app's source in a checkout, the packaged app folder when installed. */
  dir: string
  hostname: string
  port: number
  dev: boolean
  /** The one-time session. Absent only for a programmatic host, which then answers loopback requests without one. */
  session?: { secret: string; ttlMs?: number }
  /** The repositories the launcher selected, already resolved. */
  repositories?: readonly StudioRepository[]
  /** Programmatic only: the clock subsequent tasks read. */
  clock?: () => number
  /** Programmatic only: where subsequent tasks register their routes. */
  compose?: (composition: StudioComposition) => void
  /** Programmatic only: replaces Next, for a test. */
  next?: NextFactory
}

export type StudioHost = {
  server: Server
  /** Starts Next, then the listener; resolves with the port actually bound. */
  listen(): Promise<number>
  /** Ends every connection and the listener within `CLOSE_GRACE_MS`. */
  close(): Promise<void>
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

function hostnameOf(value: string): string {
  return value.startsWith('[') ? value.slice(0, value.indexOf(']') + 1) : (value.split(':')[0]?.toLowerCase() ?? '')
}

/**
 * True when a request is addressed to this loopback server and, when a browser names an Origin, comes from a page
 * served by it. A page on another site, or a rebinding name that resolves to loopback, is refused before any
 * application handler runs.
 */
export function isLocalRequest(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (!host || !LOOPBACK_HOSTS.has(hostnameOf(host))) return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function pathOf(req: IncomingMessage): string {
  const raw = req.url ?? '/'
  const q = raw.indexOf('?')
  return q === -1 ? raw : raw.slice(0, q)
}

// Held in a constant so a bundler (the test selector's, the host bundle's) does not follow Next's server internals;
// the packed bundle traces `next` explicitly instead.
const NEXT_SPECIFIER = 'next'

async function loadNext(): Promise<NextFactory> {
  const mod = (await import(NEXT_SPECIFIER)) as { default: NextFactory }
  return mod.default
}

export function createStudioHost(options: StudioHostOptions): StudioHost {
  const routes = new Map<string, RouteHandler>()
  const sockets = new Map<string, SocketHandler>()
  const clock = options.clock ?? Date.now
  const repositories = options.repositories ?? []
  let boundPort = options.port
  const guard = options.session
    ? createSessionGuard({
        secret: options.session.secret,
        ttlMs: options.session.ttlMs,
        clock,
        expectedHost: () =>
          `${options.hostname.includes(':') ? `[${options.hostname}]` : options.hostname}:${boundPort}`
      })
    : null
  const wss = new WebSocketServer({ noServer: true })
  // Next attaches its own upgrade listener (development hot reload) to whatever `httpServer` it is given. It is given
  // this private emitter, never the real listener, so Next can never answer an application upgrade; the host forwards
  // only the upgrades that are not its own.
  const nextUpgrades = new EventEmitter() as Server
  let handle: ((req: IncomingMessage, res: ServerResponse) => Promise<void> | void) | null = null
  let app: NextApp | null = null

  const composition: StudioComposition = {
    route: (path, handler) => void routes.set(path, handler),
    socket: (path, handler) => void sockets.set(path, handler),
    clock,
    repositories
  }
  composition.socket(LIVE_ROUTE, (socket) => socket.send(LIVE_HELLO))
  composition.route(TASK_LIST_ROUTE, (_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ tasks: [] }))
  })
  composition.route(REPOSITORIES_ROUTE, (_req, res) => {
    const views: RepositoryView[] = repositoryViews(repositories)
    res.setHeader('content-type', 'application/json')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify({ repositories: views }))
  })
  options.compose?.(composition)

  function refuseRequest(res: ServerResponse, decision: Extract<SessionDecision, { ok: false }>): void {
    res.statusCode = decision.status
    res.setHeader('cache-control', 'no-store')
    res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.end('Open Studio with `vinaya studio`.\n')
  }

  const server = createServer((req, res) => {
    if (guard) {
      if (pathOf(req) === BOOTSTRAP_ROUTE) {
        guard.exchange(req, res)
        return
      }
      const decision = guard.authorizeHttp(req)
      if (!decision.ok) {
        refuseRequest(res, decision)
        return
      }
    }
    const route = routes.get(pathOf(req))
    if (!guard && route && !isLocalRequest(req)) {
      res.statusCode = 403
      res.end()
      return
    }
    const run = route ? route(req, res) : handle?.(req, res)
    Promise.resolve(run).catch(() => {
      if (!res.headersSent) res.statusCode = 500
      res.end()
    })
  })

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (guard) {
      // Every upgrade, the application's and Next's hot reload alike, needs the session and the exact local Origin.
      const decision = guard.authorizeUpgrade(req)
      if (!decision.ok) {
        socket.end(`HTTP/1.1 ${decision.status} Refused\r\nConnection: close\r\n\r\n`)
        return
      }
    }
    const handler = sockets.get(pathOf(req))
    if (handler) {
      if (!guard && !isLocalRequest(req)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => handler(ws, req))
      return
    }
    if (nextUpgrades.listenerCount('upgrade') > 0) {
      nextUpgrades.emit('upgrade', req, socket, head)
      return
    }
    socket.destroy()
  })

  return {
    server,
    async listen() {
      const factory = options.next ?? (await loadNext())
      app = await factory({
        dev: options.dev,
        dir: options.dir,
        hostname: options.hostname,
        port: options.port,
        httpServer: nextUpgrades
      })
      await app.prepare()
      handle = app.getRequestHandler()
      return await new Promise<number>((resolve, reject) => {
        server.once('error', reject)
        server.listen(options.port, options.hostname, () => {
          server.off('error', reject)
          const address = server.address()
          boundPort = typeof address === 'object' && address ? address.port : options.port
          guard?.arm()
          resolve(boundPort)
        })
      })
    },
    async close() {
      guard?.invalidate()
      for (const client of wss.clients) client.close(1001)
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      const timer = setTimeout(() => {
        for (const client of wss.clients) client.terminate()
        server.closeAllConnections()
      }, CLOSE_GRACE_MS)
      try {
        await closed
        await app?.close?.()
      } finally {
        clearTimeout(timer)
        wss.close()
      }
    }
  }
}
