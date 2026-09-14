import { describe, expect, it } from 'vitest'
import { normalizeOutcome } from '@attalabs/aeg-core'

/**
 * The parent-validated outcome vocabulary (O2), reached from the CLI's own
 * consumer side (`@attalabs/aeg-core`) — the comprehensive unit suite lives
 * co-located at `packages/aeg-core/src/control-store/outcomes.test.ts`; this
 * pins the two properties this task's own §9 test plan names, from the package
 * boundary a launcher/recovery caller actually imports through.
 */
describe('normalizeOutcome — exit zero is never task success', () => {
  it('exit 0 WITHOUT a required artifact is incomplete', () => {
    const out = normalizeOutcome({
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      refused: false,
      infrastructure: false,
      artifactsPresent: false,
      postconditionsMet: false
    })
    expect(out.status).toBe('incomplete')
  })

  it('exit 0 WITH the artifacts present and postconditions met is completed', () => {
    const out = normalizeOutcome({
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      refused: false,
      infrastructure: false,
      artifactsPresent: true,
      postconditionsMet: true
    })
    expect(out.status).toBe('completed')
  })
})
