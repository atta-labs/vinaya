import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'

/**
 * Issue #355, O3: the exhaustiveness switch in `check-dispatch-readiness.ts`
 * / `check-coherence.ts` guarantees every MEMBER of `DispatchBlockerClass` /
 * `CoherenceFailureCode` has a recovery arm — that is a property of the
 * TYPE. It says nothing about whether a producer that reuses an EXISTING
 * class/code for a genuinely new failure shape (rather than adding a new
 * member) is wrong to do so — the type checker cannot see that a `push`/
 * `failures.push` call site's tag disagrees with its own message text,
 * because both are just strings to it. This test closes that other half by
 * reading the producers' and consumers' SOURCE TEXT directly (the same
 * technique `registry-env.test.ts`'s `readCode()` helper uses) and asserting
 * every literal class/code a producer actually writes has a matching `case`
 * arm in its consumer's switch — failing loudly on an unmatched one instead
 * of the consumer silently falling through.
 *
 * Known limitation, same shape and same stated limit as
 * `registry-env.test.ts`'s own source-scanning tests: this sees only a
 * `push('literal', …)` / `code: 'literal'` call site written with a literal
 * string in that exact position. A class or code assembled through string
 * interpolation or a variable at that call site (`push(someVar, …)`) is
 * invisible to this regex-based scan, exactly as `readCode()` there can only
 * see a literal `'gh'`/`"gh"` invocation, never one built by concatenation.
 * Every call site in `dispatch-gate.ts`/`coherence-checks.ts` today is a
 * literal (Traps to avoid: never widen the union with a catch-all member,
 * which would also remove the incentive to keep it that way) — this test
 * would need updating, not silently passing, the day one stops being.
 */

// tests/checks -> tests -> cli -> apps -> repo root (core-parity.test.ts's own path scheme).
const REPO_ROOT = join(import.meta.dir, '../../../..')

const DISPATCH_GATE = join(REPO_ROOT, 'packages/aeg-core/src/dispatch-gate.ts')
const CHECK_DISPATCH_READINESS = join(REPO_ROOT, 'apps/cli/src/checks/bin/check-dispatch-readiness.ts')
const COHERENCE_CHECKS = join(REPO_ROOT, 'packages/aeg-core/src/coherence-checks.ts')
const VERIFY_COHERENCE = join(REPO_ROOT, 'packages/aeg-core/bin/verify-coherence.ts')
const CHECK_COHERENCE = join(REPO_ROOT, 'apps/cli/src/checks/bin/check-coherence.ts')

for (const target of [DISPATCH_GATE, CHECK_DISPATCH_READINESS, COHERENCE_CHECKS, VERIFY_COHERENCE, CHECK_COHERENCE]) {
  if (!existsSync(target)) throw new Error(`recovery-prompt-coupling: target does not exist: ${target}`)
}

function readSrc(path: string): string {
  return readFileSync(path, 'utf8')
}

/** Every literal first argument of a `push('<class>', …)` call — dispatch-gate.ts's own emission helper. */
function literalPushedClasses(src: string): string[] {
  return [...src.matchAll(/\bpush\(\s*'([a-z-]+)'/g)].map((m) => m[1] as string)
}

/** Every literal `code: '<code>'` field in a `failures.push({ … })` call — coherence-checks.ts's / verify-coherence.ts's convention. */
function literalFailureCodes(src: string): string[] {
  return [...src.matchAll(/\bcode:\s*'([a-z0-9-]+)'/g)].map((m) => m[1] as string)
}

/** Every `case '<value>':` literal in a switch statement's source text. */
function switchCaseValues(src: string): Set<string> {
  return new Set([...src.matchAll(/\bcase\s+'([a-z0-9-]+)':/g)].map((m) => m[1] as string))
}

describe('dispatch-gate blocker classes couple to check-dispatch-readiness recovery arms', () => {
  const emittedClasses = literalPushedClasses(readSrc(DISPATCH_GATE))
  const handledClasses = switchCaseValues(readSrc(CHECK_DISPATCH_READINESS))

  it('the scan is not vacuous — dispatch-gate.ts emits at least one blocker class', () => {
    expect(emittedClasses.length).toBeGreaterThan(0)
  })

  it('every literal blocker class dispatch-gate.ts emits has a matching `case` arm in check-dispatch-readiness.ts', () => {
    const unmatched = [...new Set(emittedClasses)].filter((c) => !handledClasses.has(c))
    expect(unmatched).toEqual([])
  })
})

describe('coherence failure codes couple to check-coherence recovery arms', () => {
  const emittedCodes = [
    ...literalFailureCodes(readSrc(COHERENCE_CHECKS)),
    ...literalFailureCodes(readSrc(VERIFY_COHERENCE))
  ]
  const handledCodes = switchCaseValues(readSrc(CHECK_COHERENCE))

  it('the scan is not vacuous — coherence-checks.ts/verify-coherence.ts emit at least one failure code', () => {
    expect(emittedCodes.length).toBeGreaterThan(0)
  })

  it('every literal failure code a producer emits has a matching `case` arm in check-coherence.ts', () => {
    const unmatched = [...new Set(emittedCodes)].filter((c) => !handledCodes.has(c))
    expect(unmatched).toEqual([])
  })

  it('the two D1 codes are both present and both distinctly handled (the live #350-class defect)', () => {
    expect(emittedCodes).toContain('d1-self-dependency')
    expect(emittedCodes).toContain('dispatched-on-unmet-deps')
    expect(handledCodes.has('d1-self-dependency')).toBe(true)
    expect(handledCodes.has('dispatched-on-unmet-deps')).toBe(true)
  })
})
