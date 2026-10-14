/**
 * The comparison between a log server's event-schema digest and this CLI's —
 * one wording for `vinaya log selftest`, which fails on a difference, and
 * `vinaya doctor`, which warns on it (`apps/cli/specs/log.md` § Is the server
 * behind the validator).
 *
 * The server reports the digest of the validator it bundled as `schema_digest`
 * on its stats route (`apps/log-server/specs/server.md` § 5); this CLI's own
 * is `logEventSchemaDigest()` from the same log package, so the two are the
 * same function over two builds of the schema, never a hand-bumped constant.
 */

import { logEventSchemaDigest } from '@attalabs/aeg-core/log'

/** How a log server running an older (or newer) event schema is brought level with this CLI's (`apps/log-server/specs/server.md` § 6). */
export const LOG_SERVER_REDEPLOY_COMMAND = 'bunx wrangler deploy (from apps/log-server)'

/** This CLI's own event-schema digest. */
export function localSchemaDigest(): string {
  return logEventSchemaDigest()
}

/** The stats route's `schema_digest`, or `null` when the response carries no non-empty string there. */
export function schemaDigestFromStats(body: unknown): string | null {
  const digest = (body as { schema_digest?: unknown } | null)?.schema_digest
  return typeof digest === 'string' && digest.length > 0 ? digest : null
}

/**
 * Why a server's reported digest is not this CLI's, or `null` when they match.
 * `reported` is `null` when the stats response carries none — what a server
 * deployed before the field existed answers, and just as far behind.
 */
export function schemaDigestMismatch(where: string, reported: string | null, local: string): string | null {
  if (reported === local) return null
  const said = reported === null ? 'reports no event-schema digest' : `reports event-schema digest ${reported}`
  return (
    `the log server ${where} ${said}, and this CLI's is ${local} — the server validates events with a different ` +
    `schema, so lines this CLI sends can be rejected. Redeploy it: ${LOG_SERVER_REDEPLOY_COMMAND}.`
  )
}
