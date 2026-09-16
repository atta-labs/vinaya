/**
 * O9: the impure half of round-journal
 * reconstruction — gathering every `dev_review_loop` log line this task has
 * ever emitted, from the two places it can live: wherever the round-end
 * flush actually posted it (O1: the task's own
 * Issue is no longer that place by default — `resolveRoundEndFlushTarget`,
 * `../config.js`, resolves the SAME `vinaya.config.json` `logPublish`
 * destination `defaultFlushOutbox` posts to, so this read and that write can
 * never disagree about where "already flushed" means), and whatever is
 * still unflushed in the local outbox on this machine (a crash between a
 * round concluding and its flush). `journal-reconstruction.ts`
 * (`@attalabs/aeg-core`) does the actual replay; this file only fetches and
 * parses.
 *
 * Same trust boundary every other forge read in this directory already
 * applies (a security-review finding): only principal-authored comments are
 * trusted, so a non-principal Issue/PR commenter cannot forge a
 * `<!-- aeg:log: -->`-shaped comment to inject fabricated rounds into the
 * published journal.
 */

import { readFileSync } from 'node:fs'
import {
  extractLoopEventsFromCommentBody,
  isPrincipal,
  parseLoopEventLines,
  reconstructRounds,
  type DevReviewLoopEvent,
  type ReconstructedJournal
} from '@attalabs/aeg-core'
import { loadConfig, resolveRoundEndFlushTarget, type LogPublishTarget } from '../config.js'
import { markerComments, principalAllowlist } from './developer-dispatch.js'
import { sh } from './gate-reading.js'
import { outboxPathFor } from '../log-sink.js'

/**
 * Every `dev_review_loop` event already flushed to `target`'s comments —
 * principal-authored only. `target === null` (no `logPublish` configured,
 * or configured back onto `task`'s own Issue and refused) means nothing was
 * ever posted anywhere for this feature — skips the forge read entirely
 * rather than reading the task's own Issue on the offchance an OLDER build
 * once flushed there: a stale read is worse than an honest empty one, and
 * the unflushed local outbox below still covers this machine's own recent
 * history regardless.
 */
function fetchFlushedLoopEvents(target: LogPublishTarget | null): DevReviewLoopEvent[] {
  // A webhook target has no comment history to read back (unlike GitHub's
  // issue/pr, there is nothing to `gh ... view --json comments` against) —
  // treated the same as unconfigured: the local outbox below still covers
  // this machine's own recent history regardless.
  if (target === null || 'webhookUrl' in target) return []
  let out: string
  try {
    out =
      'pr' in target
        ? sh('gh', ['pr', 'view', String(target.pr), '--json', 'comments'])
        : sh('gh', ['issue', 'view', String(target.issue), '--json', 'comments'])
  } catch {
    // No Issue/PR, or `gh` unreachable — reconstruction degrades to whatever
    // the local outbox alone can offer, never a hard failure: a task
    // journal is a display concern, not a dispatch gate.
    return []
  }
  const allowlist = principalAllowlist()
  const events: DevReviewLoopEvent[] = []
  for (const comment of markerComments(out)) {
    if (!isPrincipal(comment.author, allowlist)) continue
    events.push(...extractLoopEventsFromCommentBody(comment.body))
  }
  return events
}

/** Whatever this task's own outbox still holds unflushed, on THIS machine — a crash between a round concluding and its flush. Best-effort: a missing or unreadable file yields no extra events, never a throw. */
function fetchUnflushedLoopEvents(
  root: string,
  repo: { owner: string; repo: string } | null,
  task: number
): DevReviewLoopEvent[] {
  const path = outboxPathFor({ outboxRoot: () => root }, repo, task)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  return parseLoopEventLines(raw.split('\n')).filter((e) => e.kind === 'dev_review_loop')
}

/**
 * The task's own complete round journal, replayed from every source this
 * driver can reach — the forge's already-flushed record and this machine's
 * still-unflushed one, combined. Called on every entry (fresh round 1,
 * attach to an existing PR, and `--resume`) so a task with no history at
 * all pays for at most one `gh issue/pr view` (none at all when `logPublish`
 * is unconfigured) and gets back `{rounds: [], ...}`, a harmless no-op —
 * reconstruction is idempotent, never destructive.
 */
export function fetchLoopHistory(
  root: string,
  repo: { owner: string; repo: string } | null,
  task: number
): ReconstructedJournal {
  const target = resolveRoundEndFlushTarget(loadConfig(), task)
  const flushed = fetchFlushedLoopEvents(target)
  const unflushed = fetchUnflushedLoopEvents(root, repo, task)
  return reconstructRounds([...flushed, ...unflushed])
}
