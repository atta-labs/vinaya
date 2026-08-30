/**
 * Pure decision logic for the `token-collection-wired` check (task 5,
 * #272). No `fs`, no `process.env` of its own — the caller
 * (`check-token-collection-wired.ts`) supplies the already-computed
 * `MeteringCapability`, task 1's `resolveMeteringCapability` probe run
 * against real `fs`/`process.env` deps.
 *
 * The pass/fail fact itself — `capable: true` passes; `no-transcript-
 * resolved` (nothing was ever wired to try) is the sanctioned operator-
 * metered case and passes; every other incapable reason
 * (`transcript-unreadable`/`transcript-empty` — something WAS wired but
 * reaching it failed) fails — lives in `@attalabs/aeg-core`'s
 * `isTokenCollectionWiringBroken`, shared verbatim with this repo's own
 * self-hosting `packages/aeg-core/bin/check-token-collection-wired.ts` gate
 * (the `isNewDiskStateFile` precedent: one predicate, two thin shims). This
 * module's only job is wrapping that one boolean into this check's
 * `CheckError` contract, naming the wiring `capability.detail` already
 * describes — never the agent.
 */
import { isTokenCollectionWiringBroken, type MeteringCapability } from '@attalabs/aeg-core'
import { CHECK_SCHEMA_VERSION, type CheckError } from './contract'

export type TokenCollectionWiringResult = { pass: true } | { pass: false; error: CheckError }

export function evaluateTokenCollectionWiring(
  checkName: string,
  capability: MeteringCapability
): TokenCollectionWiringResult {
  if (!isTokenCollectionWiringBroken(capability)) return { pass: true }
  if (capability.capable) return { pass: true }

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
