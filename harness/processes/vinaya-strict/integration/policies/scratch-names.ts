/**
 * Vinaya's scratch-name policy: a reviewer's own scratch copy of the candidate
 * (`reviewerScratchDir`'s name family, every attempt) is exempt from its
 * after-turn check — the code reviewer's under the `reviewer-` prefix, the
 * security reviewer's under `security-`. Never the shared `candidate`, never
 * the sibling's copy (`isReviewerScratchName` matches one prefix only); a
 * Developer has no scratch copy at all.
 */

import type { ScratchNamePolicy } from '../../../../kernel/isolation/worker-boundary.js'
import { isReviewerScratchName } from '../../loops/dev-review/standalone/dev-review-loop/reviewer-isolation.js'

export const VINAYA_SCRATCH_NAMES: ScratchNamePolicy = {
  isExemptScratchName: (name, role) => {
    if (role === 'developer') return false
    return isReviewerScratchName(name, role === 'code-reviewer' ? 'reviewer' : 'security')
  }
}
