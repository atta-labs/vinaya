/**
 * Pure decision logic for the `token-collection-wired` check (task 5,
 * `vinaya-token-determinism-v1`, #272). No `fs`, no `process.env` of its
 * own — the caller (`check-token-collection-wired.ts`) supplies the
 * already-computed `MeteringCapability`, task 1's `resolveMeteringCapability`
 * probe run against real `fs`/`process.env` deps. That probe IS the whole
 * predicate over whether a transcript is resolvable; this module only
 * decides which of its outcomes counts as a commit-blocking wiring failure.
 *
 * The split hinges on `MeteringIncapableReason`, not a second I/O pass:
 *   - `capable: true` — the adapter already read a real transcript. PASS.
 *   - `capable: false, reason: 'no-transcript-resolved'` — no pointer file
 *     and no explicit transcript path: nothing was ever wired to try. This
 *     is the sanctioned operator-metered case
 *     (`aeg-root/roles/developer.md`'s token-report obligation) — a host
 *     that genuinely cannot meter itself must never be failed for it. PASS.
 *   - `capable: false, reason: 'transcript-unreadable' | 'transcript-empty'`
 *     — something WAS wired (a pointer resolved to a transcript path) but
 *     reading it failed or yielded nothing. That is the measured failure
 *     this check exists to catch at commit time rather than at a 735-PR
 *     survey a month later (Issue #272's Origin): a doctrine path that
 *     stopped resolving. FAIL, naming the wiring `capability.detail`
 *     already describes — never the agent.
 */
import type { MeteringCapability } from '@attalabs/aeg-core'
import { CHECK_SCHEMA_VERSION, type CheckError } from './contract'

export type TokenCollectionWiringResult = { pass: true } | { pass: false; error: CheckError }

/** The one `MeteringIncapableReason` that means "nothing was ever wired" —
 * every other reason means something resolved partway and then broke. */
const SANCTIONED_INCAPABLE_REASON = 'no-transcript-resolved'

export function evaluateTokenCollectionWiring(
  checkName: string,
  capability: MeteringCapability
): TokenCollectionWiringResult {
  if (capability.capable) return { pass: true }
  if (capability.reason === SANCTIONED_INCAPABLE_REASON) return { pass: true }

  return {
    pass: false,
    error: {
      schema: CHECK_SCHEMA_VERSION,
      check: checkName,
      severity: 'error',
      message:
        'token-collection-wired: the token-report collection adapter resolved a wiring point ' +
        `(${capability.reason}) but could not reach it — ${capability.detail}`,
      agent_recovery_prompt:
        'Fix the token-collection wiring named above (the resolved transcript path), then re-run ' +
        '`vinaya check token-collection-wired`. This is a wiring defect, not a missing capability — ' +
        'do not report tokens as `—` for it.'
    }
  }
}
