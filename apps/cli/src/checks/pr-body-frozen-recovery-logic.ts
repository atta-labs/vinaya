/**
 * The `pr-body-frozen` shim's failure-to-advice mapping, pulled out of
 * `bin/check-pr-body-frozen.ts` (a `#!/usr/bin/env bun` entrypoint that
 * calls `main()` unconditionally, so a test importing it for this function
 * alone would also run and `process.exit` it) so
 * `pr-body-frozen-recovery-prompt-coverage.test.ts` can exercise it directly.
 *
 * #355's lesson, applied here: a check's failure vocabulary must be bound to
 * its recovery advice, never one generic prompt reused across incompatible
 * causes. `mismatch` and `no-marker-not-grandfathered` are opposite
 * situations — one says "you edited the body, revert it", the other says
 * "the open-time hash cannot be reconstructed, stop and escalate".
 *
 * `no-marker-not-grandfathered` never tells the agent to recompute and
 * repost a marker. Once the ORIGINAL marker comment is gone — deleted, or
 * never posted — the true open-time hash is unrecoverable: recomputing NOW
 * would hash whatever the body currently is, which is exactly the fact
 * under question, not a proof of anything. Telling an agent to "post a
 * fresh marker" would let it silently launder an undetectable edit into a
 * clean `pass` on its own say-so. This is a Principal adjudication, never
 * an agent self-fix.
 */

import type { PrBodyFrozenFailReason } from '@attalabs/aeg-core'

export function recoveryPromptFor(reason: PrBodyFrozenFailReason): string {
  switch (reason) {
    case 'mismatch':
      return 'The PR body is frozen at open per aeg-root/roles/developer.md — revert the body to what `pr create` posted (the AEG:EVIDENCE regeneration and one appended AEG:TOKENS row are the only exceptions), and answer review findings with commits and a round comment instead.'
    case 'no-marker-not-grandfathered':
      return 'The open-time hash is unrecoverable; the Principal adjudicates before merge. Do not recompute `authoredRegionHash` against the current body and post it as a fresh marker — that would validate the body against itself, not against what was actually posted at open. Stop, and surface this PR to the Principal for a manual decision.'
  }
}
