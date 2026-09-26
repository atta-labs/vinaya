/**
 * The log server's only public entry point (`apps/log-server/specs/server.md`
 * § 1). It checks the bearer token for the route, validates the repository
 * segments in the path, and forwards the request — unread — to that
 * repository's Durable Object.
 *
 * It never reads or buffers a body. A Worker on the free plan gets 10 ms of
 * CPU per request and the Durable Object gets 30 seconds, so parsing anything
 * here would spend the scarce budget doing work the object is sized for;
 * handing the request stream straight to the stub costs none of it.
 *
 * A token is never logged and never echoed in a response.
 */

import { parseRoute, repoName } from './route'
import { RepoLog, type Env } from './repo-log'

export { RepoLog }

function refuse(status: 400 | 401 | 404 | 405 | 500, error: string): Response {
  return Response.json({ error }, { status })
}

/**
 * Constant-time token comparison. Both values are hashed first and the
 * fixed-width digests are compared byte by byte, so neither the length of the
 * presented token nor the position of its first wrong byte is observable in
 * the time taken.
 */
async function tokenMatches(presented: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(presented), sha256(expected)])
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] as number) ^ (b[i] as number)
  return diff === 0
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
}

/** The bearer value of an `authorization` header, or `null` when there is no well-formed one. */
function bearerToken(header: string | null): string | null {
  if (header === null) return null
  const match = /^Bearer (.+)$/i.exec(header.trim())
  return match === null ? null : (match[1] as string)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const parsed = parseRoute(url, request.method)
    if (!parsed.ok) {
      const error =
        parsed.status === 400
          ? 'owner and repo must match [A-Za-z0-9._-]+'
          : parsed.status === 405
            ? 'method not allowed on this route'
            : 'no such route'
      return refuse(parsed.status, error)
    }

    // Write-only on ingest, read-only everywhere else: presenting one token on
    // the other's route is refused exactly like presenting none (spec § 5).
    const expected = parsed.route.kind === 'ingest' ? env.INGEST_TOKEN : env.READ_TOKEN
    if (typeof expected !== 'string' || expected.length === 0) {
      // An unset secret must never authorize anything — an empty expected
      // token would otherwise match an empty presented one.
      return refuse(500, 'server is missing its token configuration')
    }

    const presented = bearerToken(request.headers.get('authorization'))
    if (presented === null || !(await tokenMatches(presented, expected))) {
      return refuse(401, 'missing or wrong token for this route')
    }

    const name = repoName(parsed.route)
    const stub = env.REPO_LOG.get(env.REPO_LOG.idFromName(name))
    return await stub.fetch(request)
  }
} satisfies ExportedHandler<Env>
