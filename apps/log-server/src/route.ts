/**
 * The wire contract's path and method grammar (`apps/log-server/specs/server.md`
 * § 5), as a pure function over a URL and a method.
 *
 * Both halves of the server parse the same way: the Worker, to decide which
 * token a request needs before it forwards anything, and `RepoLog`, so an
 * object reached by any other path still refuses it rather than trusting the
 * Worker to have been the only caller. One grammar, one module, no second
 * copy to drift.
 */

/** A repository segment: `[A-Za-z0-9._-]+`, the spec's own § 5 grammar. */
const SEGMENT = /^[A-Za-z0-9._-]+$/

export type Route = {
  kind: 'ingest' | 'read' | 'stats'
  owner: string
  repo: string
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
 * `/v1/repos/<owner>/<repo>/<events|stats>`. A malformed repository segment
 * is `400`, an unknown path `404`, a known path with the wrong method `405`.
 *
 * The live route (`/live`, spec § 5) is not served yet and therefore falls
 * through to `404` — it arrives with the WebSocket hub, and until then the
 * honest answer is that the path does not exist.
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
  return { ok: false, status: 404 }
}
