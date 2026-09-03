import { describe, expect, it } from 'bun:test'
import type { PrBodyFrozenFailReason } from '@attalabs/aeg-core'
import { recoveryPromptFor } from '../../src/checks/pr-body-frozen-recovery-logic'

/**
 * Issue #355: a check's failure vocabulary must be bound to its recovery
 * advice, never one generic prompt reused across incompatible causes. Every
 * `PrBodyFrozenFailReason` the producer (`checkPrBodyFrozen`,
 * `packages/aeg-core/src/pr-body-frozen.ts`) can emit must resolve to a
 * distinct, non-empty `agent_recovery_prompt` here — the consumer
 * (`recoveryPromptFor`, `../../src/checks/pr-body-frozen-recovery-logic.ts`).
 *
 * The literal reason list below is hand-kept, mirroring `registry-env.test.ts`'s
 * own documented limitation (source-text pattern matching, not a type-level
 * derivation): a THIRD reason added to `PrBodyFrozenFailReason` without a
 * matching entry here would be a silent gap this test cannot see on its own.
 * `recoveryPromptFor`'s own `switch` with no `default` arm is the type-level
 * backstop — `tsc` refuses to compile if a reason is left unhandled there,
 * which this repo's own `bun run typecheck` gate already enforces on every
 * push. This test is the semantic half typecheck cannot reach: that each
 * arm's ADVICE is real and different, not merely present.
 */
const REASONS: readonly PrBodyFrozenFailReason[] = ['mismatch', 'no-marker-not-grandfathered']

describe('pr-body-frozen — recovery-prompt coverage (#355)', () => {
  it('every fail reason has a non-empty recovery prompt', () => {
    for (const reason of REASONS) {
      const prompt = recoveryPromptFor(reason)
      expect(prompt.length).toBeGreaterThan(0)
    }
  })

  it('no two fail reasons share the same recovery prompt', () => {
    const prompts = REASONS.map((r) => recoveryPromptFor(r))
    expect(new Set(prompts).size).toBe(prompts.length)
  })

  it('a recovery prompt is never a restatement of the reason it names — it is a corrective instruction', () => {
    // Guards against a lazy arm like `return reason` or `return \`Fix: ${reason}\``,
    // which would satisfy "non-empty" and "distinct" while giving an agent
    // nothing actionable — the exact failure shape contract.ts's own
    // `agent_recovery_prompt` doc comment warns against.
    for (const reason of REASONS) {
      const prompt = recoveryPromptFor(reason)
      expect(prompt).not.toBe(reason)
      expect(prompt.length).toBeGreaterThan(reason.length + 20)
    }
  })

  it('the mismatch prompt tells the agent to revert, not to escalate to the Principal', () => {
    const prompt = recoveryPromptFor('mismatch')
    expect(prompt).toContain('revert')
    expect(prompt).not.toContain('Principal')
  })

  it('the no-marker prompt tells the agent to stop and escalate to the Principal — never to recompute and repost a marker itself', () => {
    // The open-time hash is unrecoverable once the original marker is gone;
    // an agent computing a fresh hash from the CURRENT body and posting it
    // would validate the body against itself, silently laundering an
    // undetectable edit into a clean `pass`. This is the exact instruction
    // #4 of the review round that added this reason forbids.
    const prompt = recoveryPromptFor('no-marker-not-grandfathered')
    expect(prompt).toContain('Principal')
    expect(prompt).not.toContain('revert the body')
    expect(prompt.toLowerCase()).not.toContain('post `<!--')
  })
})
