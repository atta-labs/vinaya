/**
 * CI task evidence outlives job logs without exposing publication
 * credentials. A task-path CI job
 * (no write credential — see `apps/cli/src/lib/artifacts.ts`'s
 * `checksWorkflow`) exports its local outbox as a bounded artifact; a
 * trusted collector, running on the default branch with its own
 * credential, downloads it and must validate it before ever publishing it
 * through `vinaya log flush`'s existing forge write. This module is that
 * validation: pure, no filesystem, no network, no process
 * (`apps/cli/specs/surface.md` "The rule") — an artifact this build cannot
 * vouch for is a policy decision, not an I/O concern.
 *
 * Provenance has two layers, deliberately split. WHICH run an artifact came
 * from is a GitHub Actions API guarantee the collector workflow itself
 * enforces structurally (`actions/download-artifact@v4` scoped to a
 * specific, API-verified `run-id` — the same binding
 * `vinayaSetupSteps(..., 'shared-build')` already relies on) and is never
 * re-derived here from the artifact's own bytes, which a producer could
 * always lie in. What THIS module checks is content-level: does each
 * record's own declared `meta.repo` match the repo the collector expects,
 * and does the whole payload validate as real Vinaya Log events. A line
 * that fails either check is a gap, not a silent drop (O2's "partial
 * failure ... preserve[s] available evidence with explicit gaps").
 *
 * Schema and redaction validation is not reimplemented here — every line is
 * classified through `classifyStoredLine` (`./store`), the SAME read-back
 * gate `vinaya log flush` already re-validates a local outbox line through,
 * so a malformed, corrupt, or under-redacted line is refused by the one
 * existing implementation of that fact, never a second copy of it.
 */

import { classifyStoredLine } from './store'

/** Whole-artifact reject above this size — refuses to even split it into lines. A cap, not a truncation: a producer's export step already bounds its own outbox (`OUTBOX_MAX_BYTES` in `apps/cli/src/lib/log-sink.ts`); an artifact this large did not come from an honest single run's outbox. */
export const TASK_LOG_ARTIFACT_MAX_BYTES = 8 * 1024 * 1024

/** What the collector expects this artifact's content to declare about itself. `repo` is `"<owner>/<repo>"`, read from the collector's own trusted GitHub Actions context — never from the artifact. */
export type ArtifactExpectedProvenance = {
  repo: string
}

/** One rejected or unattributable line — named and kept, never silently dropped (O2). `seq` is `null` when the line could not be parsed far enough to expose one. */
export type ArtifactGap = {
  seq: number | null
  reason: string
}

export type ArtifactValidationResult = {
  /** Re-redacted, re-serialized lines ready to append to an outbox and flush — never the artifact's raw bytes verbatim. */
  acceptedLines: string[]
  gaps: ArtifactGap[]
  /** `true` when the whole artifact was refused for exceeding `TASK_LOG_ARTIFACT_MAX_BYTES` before any line was parsed — `acceptedLines` and `gaps` both reflect that single whole-artifact gap in this case. */
  rejectedForSize: boolean
}

function metaRepoOf(event: { meta: { repo: string | null } }): string | null {
  return event.meta.repo
}

/**
 * Validates one downloaded artifact's raw text content — the collector's
 * "schema, size and redaction" half of O1. Never executes, imports, or
 * evaluates anything from `raw`: every byte is read only as UTF-8 text,
 * split on `\n`, and passed to `JSON.parse` + `classifyStoredLine`'s zod
 * validation, the same treatment `vinaya log flush` already gives a local
 * outbox line. A malicious artifact's contents (a spoofed `run_id`, a
 * script-shaped string, an oversized payload, a `provenance` claim outside
 * the schema's own enum) can therefore never do more than fail one of these
 * checks and become a gap (O2's "malicious artifact contents cannot
 * execute").
 */
export function validateTaskLogArtifact(
  raw: string,
  home: string,
  expected: ArtifactExpectedProvenance
): ArtifactValidationResult {
  const byteLength = Buffer.byteLength(raw, 'utf8')
  if (byteLength > TASK_LOG_ARTIFACT_MAX_BYTES) {
    return {
      acceptedLines: [],
      gaps: [
        {
          seq: null,
          reason: `artifact is ${byteLength} bytes, exceeding the ${TASK_LOG_ARTIFACT_MAX_BYTES}-byte cap — refusing to parse an oversized payload`
        }
      ],
      rejectedForSize: true
    }
  }

  const lines = raw.split('\n').filter((l) => l.length > 0)
  const acceptedLines: string[] = []
  const gaps: ArtifactGap[] = []

  for (const line of lines) {
    const record = classifyStoredLine(line, home)
    if (record.status === 'invalid') {
      gaps.push({ seq: null, reason: `invalid record: ${record.reason}` })
      continue
    }
    if (record.status === 'unknown_version') {
      gaps.push({ seq: null, reason: `unknown schema version ${record.schema ?? 'unreadable'}: ${record.reason}` })
      continue
    }
    const declaredRepo = metaRepoOf(record.event)
    if (declaredRepo !== null && declaredRepo !== expected.repo) {
      gaps.push({
        seq: record.seq,
        reason: `record declares repo "${declaredRepo}", expected "${expected.repo}" — provenance mismatch`
      })
      continue
    }
    acceptedLines.push(record.postLine)
  }

  return { acceptedLines, gaps, rejectedForSize: false }
}
