/**
 * The impure half of round-journal reconstruction — gathering the facts the
 * pure rebuild needs (`journal-reconstruction.ts`, `@attalabs/aeg-core`) from
 * the forge's own principal-authored markers on the pull request, plus the
 * review gate's verdict on its current state:
 *
 *   - the round numbers every developer round marker
 *     (`<!-- aeg:developer:round-<n> -->`, `parseDeveloperRoundMarker`) carries,
 *   - whether a ready-for-merge summary comment
 *     (`isPublishedSummaryComment`) has actually been posted, and where,
 *   - whether the review gate passes against the pull request's CURRENT head,
 *     objectives version, newest ruling, frozen brief and policy
 *     (`reviewGatePassesForCurrentState`, the shared assembly the `review-gate`
 *     check itself uses — called in-process, never by shelling out to `vinaya
 *     check`). A posted summary alone is sticky: it records no head, so it kept
 *     reading "concluded" through a red gate, a newer ruling and a superseded
 *     brief. Conclusion now needs both facts, and the gate is the evaluation
 *     already bound to every one of them.
 *
 * It reads NO log event, NO flushed `dev_review_loop` log comment, and NO
 * telemetry outbox. The Vinaya Log is telemetry and "is never the authority
 * for … recovery" (Log tech spec, §1) — a rebuild that replayed the loop's own
 * flushed log events broke the moment those events stopped going to the
 * tracker, which is the whole reason this reads the principal-authored markers
 * instead. The control store's own
 * authoritative round is recovered separately by the driver
 * (`recoverLoopState`), so this file's one job is reading the forge and asking
 * the gate.
 *
 * Same trust boundary every other forge read in this directory already
 * applies (a security-review finding): only principal-authored comments are
 * trusted, so a non-principal PR commenter cannot forge a round marker or a
 * summary-shaped comment to inject fabricated rounds or a false "already
 * published" into the rebuilt journal. Reuses the large-buffer comment read
 * (`sh`'s own `MAX_GH_OUTPUT_BYTES`) — a task's comment history can exceed the
 * default 1 MiB buffer.
 */

import {
  isPrincipal,
  isPublishedSummaryComment,
  parseDeveloperRoundMarker,
  reconstructRounds,
  type ReconstructedJournal
} from '@attalabs/aeg-core'
import { markerComments, principalAllowlist, type MarkerComment } from './developer-dispatch.js'
import { sh } from './gate-reading.js'
import { reviewGatePassesForCurrentState } from '../review-gate-input.js'

/** An empty journal — no PR to read, or a `gh` read that failed: reconstruction is a display/recovery aid, never a dispatch gate, so it degrades to "no history" rather than throwing. */
const EMPTY_JOURNAL: ReconstructedJournal = {
  rounds: [],
  totalWallMs: 0,
  totalFilesChanged: 0,
  summaryUrl: null,
  journalFinalized: null
}

/**
 * The pure rebuild: the two forge facts extracted from a pull request's
 * comments, principal-authored only. A non-principal commenter's round marker
 * or summary-shaped comment is ignored (the same trust boundary every other
 * forge read in this directory applies), so it can neither inject a
 * fabricated round nor forge a false "already published." Exported for
 * unit testing without a `gh` call.
 */
export function loopHistoryFromComments(
  comments: readonly MarkerComment[],
  allowlist: readonly string[],
  reviewGatePasses: () => boolean
): ReconstructedJournal {
  const roundMarkers: number[] = []
  let summaryPublished = false
  let summaryUrl: string | null = null
  for (const comment of comments) {
    if (!isPrincipal(comment.author, allowlist as string[])) continue
    const round = parseDeveloperRoundMarker(comment.body)
    if (round !== null) roundMarkers.push(round)
    if (isPublishedSummaryComment(comment.body)) {
      summaryPublished = true
      summaryUrl = comment.url ?? summaryUrl
    }
  }
  // Evaluated ONLY when a summary is actually on the forge: with no summary
  // the review is not concluded whatever the gate says, and the gate costs
  // several forge and remote reads. Lazy here rather than at the caller so
  // this one function stays the whole "did this review conclude?" decision.
  return reconstructRounds({
    roundMarkers,
    summaryPublished,
    summaryUrl,
    reviewGatePasses: summaryPublished ? reviewGatePasses() : false
  })
}

/**
 * The task's own complete round journal, rebuilt from the pull request's
 * principal-authored forge markers. Called on every entry (attach to an
 * existing PR, and the `--resume` replay-check) so a task with no PR, or one
 * whose comment read fails, pays at most one `gh pr view` and gets back the
 * empty journal — a harmless no-op, since reconstruction is idempotent and
 * never destructive.
 *
 * `prNumber === null` (a `--resume` whose PR could not be resolved) reads
 * nothing and returns the empty journal: the control store's own round
 * recovery (`recoverLoopState`) still covers this run regardless.
 *
 * The gate evaluation is passed as a thunk and runs only when a summary is
 * actually on the forge — a task with no summary is not concluded whatever the
 * gate would say, and this function is called on every entry, so the ordinary
 * attach pays for no gate read at all. An evaluation that cannot be made reads
 * as "not concluded" (`reviewGatePassesForCurrentState`), never as a crash: a
 * failed forge read must not stop a recovery aid.
 */
export function fetchLoopHistory(prNumber: number | null): ReconstructedJournal {
  if (prNumber === null) return EMPTY_JOURNAL
  let out: string
  try {
    out = sh('gh', ['pr', 'view', String(prNumber), '--json', 'comments'])
  } catch {
    // No PR, or `gh` unreachable — reconstruction degrades to the empty
    // journal, never a hard failure: a task journal is a display/recovery
    // aid, not a dispatch gate. The control store still recovers the round.
    return EMPTY_JOURNAL
  }
  return loopHistoryFromComments(markerComments(out), principalAllowlist(), () =>
    reviewGatePassesForCurrentState(prNumber)
  )
}
