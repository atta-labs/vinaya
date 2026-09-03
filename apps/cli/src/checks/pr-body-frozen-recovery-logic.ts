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
 * "you never posted a marker, post one" — and telling a no-marker PR to
 * "revert to what pr create posted" is exactly the impossible-advice shape
 * #355 exists to prevent (there is nothing to revert TO).
 */

import type { PrBodyFrozenFailReason } from '@attalabs/aeg-core'

export function recoveryPromptFor(reason: PrBodyFrozenFailReason): string {
  switch (reason) {
    case 'mismatch':
      return 'The PR body is frozen at open per aeg-root/roles/developer.md — revert the body to what `pr create` posted (the AEG:EVIDENCE regeneration and one appended AEG:TOKENS row are the only exceptions), and answer review findings with commits and a round comment instead.'
    case 'no-marker-not-grandfathered':
      return 'This PR was opened on or after FROZEN_BODY_SINCE and carries no `aeg:body-hash` marker comment from an allowlisted author — it is not grandfathered. If it was opened via `vinaya pr create`, the marker comment may have been deleted: post `<!-- aeg:body-hash:<hex> -->` again (compute the hex via `authoredRegionHash` from `@attalabs/aeg-core` against the CURRENT body) as a comment under an allowlisted login. If it was opened some other way, there is no fix that restores grandfathering — a marker must exist.'
  }
}
