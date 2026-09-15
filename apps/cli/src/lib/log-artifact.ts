/**
 * CI task evidence outlives job logs without exposing publication
 * credentials. Two functions, one for
 * each side of the trust boundary the generated workflows enforce
 * (`artifacts.ts`'s `checksWorkflow`/`taskLogCollectorWorkflow`):
 *
 * - `exportTaskLogArtifact` runs inside the task-path `pull_request` job,
 *   which holds no forge-write credential (`checksWorkflow`'s
 *   `permissions:` block). It only ever copies this run's own local
 *   outbox to a destination file for `actions/upload-artifact` to pick up —
 *   never posts anything, never reads a credential.
 * - `collectTaskLogArtifact` runs inside the collector, a `workflow_run`
 *   job on the default branch with its OWN write credential
 *   (`taskLogCollectorWorkflow`). It validates the downloaded artifact
 *   through `@attalabs/aeg-core`'s pure `validateTaskLogArtifact` — schema,
 *   size, redaction, and a repo-provenance cross-check — before writing
 *   only the accepted lines into the SAME outbox `flushOutbox` (the
 *   existing typed storage contract's GitHub adapter) reads from, then
 *   calls that one existing publication path unmodified. Reuse, not a
 *   second publisher — the pattern being flush's own chunking,
 *   marker-based dedup, and truncation.
 *
 * Every rejected line is a named gap (`ArtifactGap`), never a silent drop
 * — partial failure and cancellation preserve available evidence with
 * explicit gaps.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ArtifactGap } from '@attalabs/aeg-core'
import { validateTaskLogArtifact } from '@attalabs/aeg-core'
import { GLOBAL_VINAYA_HOME } from './config.js'
import { flushOutbox, issueFromPr, outboxPathForIssue, type LogFlushOutcome, type LogFlushTarget } from './log-flush.js'

function outboxRootDir(): string {
  return join(GLOBAL_VINAYA_HOME, 'outbox')
}

/**
 * Orders `none.ndjson` (repo-level events, no issue) before every numbered
 * issue bucket, then issue buckets ascending — `readdirSync` order is an OS
 * implementation detail, not a contract, so without this the concatenated
 * artifact's line order (and this function's own output) would vary by
 * filesystem.
 */
function outboxFileSortKey(fileName: string): [number, number] {
  const base = fileName.slice(0, -'.ndjson'.length)
  if (base === 'none') return [0, 0]
  const issue = Number(base)
  return [1, Number.isFinite(issue) ? issue : Number.POSITIVE_INFINITY]
}

/**
 * Every `*.ndjson` outbox file under `<GLOBAL_VINAYA_HOME>/outbox/`,
 * bounded to two directory levels deep (`<repo-dir>/<issue-or-none>.ndjson`
 * — the exact shape `log-sink.ts`'s `outboxPathFor` writes). The task-path
 * job never knows in advance which Issue bucket (if any) its own check run
 * wrote events under — most gate events log with no `VINAYA_TASK` set, so
 * they land in the repo's `none.ndjson` bucket — so this exports every
 * outbox this run's process could have written to, never guesses one path.
 */
function listOutboxFiles(): string[] {
  const root = outboxRootDir()
  if (!existsSync(root)) return []
  const files: string[] = []
  for (const repoDir of readdirSync(root).sort()) {
    const repoPath = join(root, repoDir)
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(repoPath)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    const entries = readdirSync(repoPath)
      .filter((entry) => entry.endsWith('.ndjson'))
      .sort((a, b) => {
        const [ak, an] = outboxFileSortKey(a)
        const [bk, bn] = outboxFileSortKey(b)
        return ak - bk || an - bn
      })
    for (const entry of entries) {
      files.push(join(repoPath, entry))
    }
  }
  return files
}

export type ExportOutcome = {
  written: boolean
  bytes: number
  lineCount: number
  sourceFiles: string[]
}

/**
 * Concatenates every outbox file this process (or an earlier one sharing
 * `GLOBAL_VINAYA_HOME` on the same runner) has written into one bounded
 * file at `destPath`, for the task-path workflow's `actions/upload-artifact`
 * step to pick up. Writes nothing (`written: false`) when there is no
 * outbox content at all — a legitimate "no gate events this run" outcome,
 * never a gap on its own; a gap is a REJECTED record, not an absent one.
 * Deliberately does not read credentials, does not call the forge, and does
 * not delete or truncate the source outbox files — this function runs in a
 * job with no write credential to begin with (O2), and truncation remains
 * `flushOutbox`'s own job, on the collector side, once a line is actually
 * published.
 */
export function exportTaskLogArtifact(destPath: string): ExportOutcome {
  const sourceFiles = listOutboxFiles()
  const lines: string[] = []
  for (const file of sourceFiles) {
    let content: string
    try {
      content = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const line of content.split('\n')) {
      if (line.length > 0) lines.push(line)
    }
  }
  if (lines.length === 0) return { written: false, bytes: 0, lineCount: 0, sourceFiles }

  const body = `${lines.join('\n')}\n`
  mkdirSync(join(destPath, '..'), { recursive: true })
  writeFileSync(destPath, body, { encoding: 'utf8' })
  return { written: true, bytes: Buffer.byteLength(body, 'utf8'), lineCount: lines.length, sourceFiles }
}

export type CollectOutcome = {
  /** `false` when the artifact file itself could not be read (missing/unreadable) — nothing to validate, nothing published. */
  attempted: boolean
  /** `null` when every line was rejected (or the artifact was oversized) — nothing left to publish. */
  publish: LogFlushOutcome | null
  gaps: ArtifactGap[]
  rejectedForSize: boolean
}

/**
 * The collector's whole body (O1/O2/O3). Reads the downloaded artifact
 * (already scoped to a specific, API-verified run — see this module's own
 * doc comment), validates it, writes only the accepted lines into the
 * target PR's own outbox (`outboxPathForIssue`, resolved the same way
 * `flushOutbox` itself resolves it — one implementation, not two), and
 * calls the existing `flushOutbox` unmodified. `skipRemotelyAccepted: true`
 * is what makes a retried collector run (the same completed CI run
 * re-triggering this workflow, or a re-run of the collector itself)
 * dedupe against markers `flushOutbox` already posted (O3) — the same
 * idempotent-retry path `vinaya log flush` itself already uses.
 */
export async function collectTaskLogArtifact(
  artifactPath: string,
  target: LogFlushTarget,
  expectedRepo: string
): Promise<CollectOutcome> {
  let raw: string
  try {
    raw = readFileSync(artifactPath, 'utf8')
  } catch {
    return { attempted: false, publish: null, gaps: [], rejectedForSize: false }
  }

  const validation = validateTaskLogArtifact(raw, GLOBAL_VINAYA_HOME, { repo: expectedRepo })
  if (validation.acceptedLines.length === 0) {
    return { attempted: true, publish: null, gaps: validation.gaps, rejectedForSize: validation.rejectedForSize }
  }

  const issueNumber = 'pr' in target ? issueFromPr(String(target.pr)) : target.issue
  const outboxPath = await outboxPathForIssue(issueNumber)
  mkdirSync(join(outboxPath, '..'), { recursive: true, mode: 0o700 })
  const toAppend = `${validation.acceptedLines.join('\n')}\n`
  writeFileSync(outboxPath, toAppend, { encoding: 'utf8', flag: 'a' })

  const publish = await flushOutbox(target, { skipRemotelyAccepted: true })
  return { attempted: true, publish, gaps: validation.gaps, rejectedForSize: validation.rejectedForSize }
}
