/**
 * O9 (`#541`): the impure half of round-journal
 * reconstruction — gathering every `dev_review_loop` log line this task has
 * ever emitted, from the two places it can live: the task Issue's own
 * comments (`log-flush.ts` always flushes this driver's own `log()` calls
 * to the ISSUE, `flushOutbox({issue: task})`, never the PR — see
 * `defaultFlushOutbox`), and whatever is still unflushed in the local
 * outbox on this machine (a crash between a round concluding and its flush).
 * `journal-reconstruction.ts` (`@attalabs/aeg-core`) does the actual
 * replay; this file only fetches and parses.
 *
 * Same trust boundary every other forge read in this directory already
 * applies (security review, PR #445): only principal-authored comments are
 * trusted, so a non-principal Issue commenter cannot forge a
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
import { markerComments, principalAllowlist } from './developer-dispatch.js'
import { sh } from './gate-reading.js'
import { outboxPathFor } from '../log-sink.js'

/** Every `dev_review_loop` event already flushed to task Issue `task`'s comments — principal-authored only. */
function fetchFlushedLoopEvents(task: number): DevReviewLoopEvent[] {
  let out: string
  try {
    out = sh('gh', ['issue', 'view', String(task), '--json', 'comments'])
  } catch {
    // No Issue, or `gh` unreachable — reconstruction degrades to whatever
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
 * all pays for one `gh issue view` and gets back `{rounds: [], ...}`, a
 * harmless no-op — reconstruction is idempotent, never destructive.
 */
export function fetchLoopHistory(
  root: string,
  repo: { owner: string; repo: string } | null,
  task: number
): ReconstructedJournal {
  const flushed = fetchFlushedLoopEvents(task)
  const unflushed = fetchUnflushedLoopEvents(root, repo, task)
  return reconstructRounds([...flushed, ...unflushed])
}
