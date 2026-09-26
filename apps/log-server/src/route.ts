/**
 * The wire contract's path and method grammar (`apps/log-server/specs/server.md`
 * § 5), as a pure function over a URL and a method.
 *
 * Both halves of the server parse the same way: the Worker, to decide which
 * token a request needs before it forwards anything, and `RepoLog`, so an
 * object reached by any other path still refuses it rather than trusting the
 * Worker to have been the only caller. One grammar, one module, no second
 * copy to drift.
 *
 * The live route's subprotocol grammar lives here for the same reason: the
 * Worker reads the token out of it, the object answers with the feed's
 * protocol name alone, and neither side carries its own copy of the strings.
 */

/** A repository segment: `[A-Za-z0-9._-]+`, the spec's own § 5 grammar. */
const SEGMENT = /^[A-Za-z0-9._-]+$/

export type Route = {
  kind: 'ingest' | 'read' | 'stats' | 'live'
  owner: string
  repo: string
}

/**
 * The live feed's protocol name. A browser cannot set an `authorization`
 * header on a WebSocket, so a viewer asks for this protocol and carries the
 * read token as a second one; the server answers with this name alone and
 * never echoes the token (spec § 5, "Live").
 */
export const LIVE_SUBPROTOCOL = 'vinaya-log.v1'

/** The prefix of the subprotocol entry that carries the read token: `bearer.<READ_TOKEN>`. */
const LIVE_TOKEN_PREFIX = 'bearer.'

/** The entries of a `sec-websocket-protocol` header, in the order the client asked for them. */
function subprotocols(header: string | null): string[] {
  if (header === null) return []
  return header
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/** Whether a live request asked for the feed's own protocol, which is the one the server answers with. */
export function asksForLiveSubprotocol(header: string | null): boolean {
  return subprotocols(header).includes(LIVE_SUBPROTOCOL)
}

/**
 * The read token a live request presents, or `null` when it carries no
 * `bearer.<token>` entry. An entry with the prefix and nothing after it is no
 * token at all, so it reads as absent rather than as the empty string.
 */
export function liveSubprotocolToken(header: string | null): string | null {
  for (const entry of subprotocols(header)) {
    if (!entry.startsWith(LIVE_TOKEN_PREFIX)) continue
    const token = entry.slice(LIVE_TOKEN_PREFIX.length)
    if (token.length > 0) return token
  }
  return null
}

export type RouteResult = { ok: true; route: Route } | { ok: false; status: 400 | 404 | 405 }

/**
 * The Durable Object's name for a repository: `<owner>/<repo>`, lower-cased,
 * so `Atta-Labs/Vinaya` and `atta-labs/vinaya` are one log and never two.
 */
export function repoName(route: Pick<Route, 'owner' | 'repo'>): string {
  return `${route.owner}/${route.repo}`.toLowerCase()
}

/**
 * `/v1/repos/<owner>/<repo>/<events|stats|live>`. A malformed repository
 * segment is `400`, an unknown path `404`, a known path with the wrong method
 * `405`.
 */
export function parseRoute(url: URL, method: string): RouteResult {
  const segments = url.pathname.split('/').filter((s) => s.length > 0)
  if (segments.length !== 5 || segments[0] !== 'v1' || segments[1] !== 'repos') {
    return { ok: false, status: 404 }
  }
  const owner = segments[2] as string
  const repo = segments[3] as string
  if (!SEGMENT.test(owner) || !SEGMENT.test(repo)) return { ok: false, status: 400 }

  const tail = segments[4]
  if (tail === 'events') {
    if (method === 'POST') return { ok: true, route: { kind: 'ingest', owner, repo } }
    if (method === 'GET') return { ok: true, route: { kind: 'read', owner, repo } }
    return { ok: false, status: 405 }
  }
  if (tail === 'stats') {
    if (method === 'GET') return { ok: true, route: { kind: 'stats', owner, repo } }
    return { ok: false, status: 405 }
  }
  if (tail === 'live') {
    if (method === 'GET') return { ok: true, route: { kind: 'live', owner, repo } }
    return { ok: false, status: 405 }
  }
  return { ok: false, status: 404 }
}
