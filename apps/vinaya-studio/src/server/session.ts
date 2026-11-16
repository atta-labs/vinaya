import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * Studio's one-time local session. Each launch holds one bootstrap secret, handed to the server over its startup
 * channel and to the browser inside the address the launcher opens. The bootstrap route, the only unauthenticated
 * entry, consumes the secret once and answers with an HttpOnly same-site cookie and a redirect, so the secret never
 * stays in the browser address and no page, script or CMS request ever sees it. Every other request, and every
 * application WebSocket upgrade, must carry that cookie, be addressed to the exact local Host, and, when a browser
 * names an Origin, come from this server's own origin. Nothing is stored beyond memory: closing Studio ends the
 * session. This file runs under Node as shipped, so it imports no Bun API.
 */

export const BOOTSTRAP_ROUTE = '/__studio/bootstrap'
export const BOOTSTRAP_PARAM = 'token'

/** How long a launch's bootstrap secret stays exchangeable, counted from `arm()`. */
export const BOOTSTRAP_TTL_MS = 10 * 60_000

const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/
const SAFE_METHODS = new Set(['GET', 'HEAD'])

/** A fresh launch secret: 256 random bits, base64url. */
export function createLaunchSecret(): string {
  return randomBytes(32).toString('base64url')
}

export function isWellFormedSecret(value: unknown): value is string {
  return typeof value === 'string' && SECRET_PATTERN.test(value)
}

/** The address the launcher opens for one launch: the bootstrap route carrying the secret. */
export function bootstrapUrl(origin: string, secret: string): string {
  return `${origin}${BOOTSTRAP_ROUTE}?${BOOTSTRAP_PARAM}=${secret}`
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b))
}

export type SessionRefusal = { ok: false; status: 400 | 401 | 403 | 405; reason: string }
export type SessionDecision = { ok: true } | SessionRefusal

export type SessionGuardOptions = {
  secret: string
  /** The exact `host:port` this server answers on; read per request because the port is known only after `listen()`. */
  expectedHost: () => string
  clock?: () => number
  ttlMs?: number
}

export type SessionGuard = {
  /** Starts the bootstrap secret's lifetime; called once the server is listening. */
  arm(): void
  /** Answers a request to `BOOTSTRAP_ROUTE`, consuming the secret at most once. */
  exchange(req: IncomingMessage, res: ServerResponse): void
  /** Decides a normal HTTP request. */
  authorizeHttp(req: IncomingMessage): SessionDecision
  /** Decides an application WebSocket upgrade, which also needs the exact expected Origin. */
  authorizeUpgrade(req: IncomingMessage): SessionDecision
  /** Ends the session: the cookie and any unused secret stop working. */
  invalidate(): void
}

function refuse(status: SessionRefusal['status'], reason: string): SessionRefusal {
  return { ok: false, status, reason }
}

/** Refusals and the redirect are never cached and never leak the address through a Referer. */
function privateHeaders(res: ServerResponse): void {
  res.setHeader('cache-control', 'no-store')
  res.setHeader('referrer-policy', 'no-referrer')
}

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return null
}

export function createSessionGuard(options: SessionGuardOptions): SessionGuard {
  const clock = options.clock ?? Date.now
  const ttlMs = options.ttlMs ?? BOOTSTRAP_TTL_MS
  let secret: string | null = options.secret
  let expiresAt: number | null = null
  let sessionId: string | null = null

  // The cookie name carries the port: browsers share cookies across ports of one host, so two Studios on one machine
  // must not overwrite each other's session.
  const cookieName = () => `vinaya_studio_session_${options.expectedHost().split(':').pop()}`

  function hostAndOrigin(req: IncomingMessage): SessionDecision {
    const expected = options.expectedHost()
    if (req.headers.host !== expected) return refuse(403, 'the Host is not this Studio')
    const origin = req.headers.origin
    if (origin !== undefined && origin !== `http://${expected}`) return refuse(403, 'the Origin is not this Studio')
    if (req.headers['sec-fetch-site'] === 'cross-site') return refuse(403, 'the request is cross-site')
    return { ok: true }
  }

  function hasSession(req: IncomingMessage): boolean {
    const presented = cookieValue(req.headers.cookie, cookieName())
    return sessionId !== null && presented !== null && sameSecret(presented, sessionId)
  }

  return {
    arm() {
      expiresAt = clock() + ttlMs
    },

    exchange(req, res) {
      privateHeaders(res)
      const deny = (decision: SessionRefusal) => {
        res.statusCode = decision.status
        res.setHeader('content-type', 'text/plain; charset=utf-8')
        res.end('Studio could not open this link. Run `vinaya studio` again.\n')
      }
      if (req.method !== 'GET') return deny(refuse(405, 'the bootstrap exchange is a GET'))
      const local = hostAndOrigin(req)
      if (!local.ok) return deny(local)
      const presented = new URL(req.url ?? '/', 'http://studio.invalid').searchParams.get(BOOTSTRAP_PARAM)
      if (!isWellFormedSecret(presented)) return deny(refuse(400, 'the bootstrap link is malformed'))
      // A wrong secret never consumes the real one: a stranger who cannot guess it cannot burn the launch either.
      if (secret === null || !sameSecret(presented, secret)) return deny(refuse(403, 'the bootstrap link is not valid'))
      if (expiresAt === null || clock() > expiresAt) {
        secret = null
        return deny(refuse(403, 'the bootstrap link has expired'))
      }
      secret = null
      sessionId = randomBytes(32).toString('base64url')
      res.statusCode = 303
      res.setHeader('set-cookie', `${cookieName()}=${sessionId}; HttpOnly; SameSite=Strict; Path=/`)
      res.setHeader('location', '/')
      res.end()
    },

    authorizeHttp(req) {
      const local = hostAndOrigin(req)
      if (!local.ok) return local
      // A page or script may read with no Origin (navigation, same-origin assets); anything that changes state must
      // prove it comes from this server's own page.
      if (!SAFE_METHODS.has(req.method ?? 'GET') && req.headers.origin === undefined) {
        return refuse(403, 'a state-changing request names no Origin')
      }
      return hasSession(req) ? { ok: true } : refuse(401, 'no valid Studio session')
    },

    authorizeUpgrade(req) {
      const local = hostAndOrigin(req)
      if (!local.ok) return local
      if (req.headers.origin === undefined) return refuse(403, 'an upgrade names no Origin')
      return hasSession(req) ? { ok: true } : refuse(401, 'no valid Studio session')
    },

    invalidate() {
      secret = null
      sessionId = null
    }
  }
}
