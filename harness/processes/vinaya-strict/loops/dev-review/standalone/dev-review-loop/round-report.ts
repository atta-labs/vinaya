/**
 * `dev-review-loop`'s per-round report: the round's statistics, the confidence it narrates and the Developer's
 * round comment. Moved out of
 * `harness/processes/vinaya-strict/loops/dev-review/standalone/dev-review-loop.ts` verbatim, over the run's
 * `LoopRunContext`; the bodies are unchanged.
 */

import type { Confidence, RoundStats } from '../../../../tools/dev-review-policy/types'
import type { PauseBoundRuling } from '../../../../tools/task-contract/review-input-manifest'
import { developerRoundMarker, parseShortstat, renderDeveloperRoundComment } from './round-assess.js'
import {
  addressedFindingIdsFromRecords,
  confidenceFromRecords,
  readTurnResultRecords,
  reportedChecksFromRecords
} from './turn-result.js'
import { postForgeEffectOnce } from './publication.js'
import { withRateLimitWait } from './rate-limit-waits.js'
import type { LoopRunContext } from './run-context.js'

export function computeStats(c: LoopRunContext, head: string, roundStartMs: number): RoundStats {
  const { d } = c

  const baseHead = d.gitRevParseOriginMain()
  d.gitFetch(head)
  const { filesChanged, insertions, deletions } = parseShortstat(d.gitDiffShortstat(baseHead, head))
  return { baseHead, head, filesChanged, insertions, deletions, wallMs: d.now() - roundStartMs }
}

/**
 * O2/O4: this round's confidence, from its newest ACCEPTED turn result —
 * `completed` carries one; anything else, or no accepted result at all, is
 * `'absent'`, never made up. Read, never cleared: attempt records are
 * immutable, and each dispatch of the round settles a newer one.
 */
export function roundConfidence(c: LoopRunContext, roundNum: number): Confidence {
  const { root, task } = c

  return confidenceFromRecords(readTurnResultRecords(root, task, roundNum))
}

/** O2: the round marker comment the driver now posts in the Developer's place (`renderDeveloperRoundComment`) — idempotent per round+head, the same `postForgeEffectOnce` discipline every other driver-posted comment in this file already uses. */
export async function postDeveloperRoundComment(
  c: LoopRunContext,
  roundNum: number,
  head: string,
  frozenPauseBoundRuling: PauseBoundRuling | null
): Promise<void> {
  const { d, root, task } = c

  const records = readTurnResultRecords(root, task, roundNum)
  await withRateLimitWait(c, () =>
    postForgeEffectOnce(root, task, `developer-round-comment-${roundNum}-${head}`, () =>
      d.postMarkedComment(
        'pr',
        String(c.prNumber),
        developerRoundMarker(roundNum),
        renderDeveloperRoundComment(
          head,
          addressedFindingIdsFromRecords(records),
          reportedChecksFromRecords(records),
          frozenPauseBoundRuling
        )
      )
    )
  )
}
