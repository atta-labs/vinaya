import { describe, expect, it } from 'bun:test'
import { recoveryPromptFor as coherencePrompt } from '../../src/checks/bin/check-coherence'
import { recoveryPromptFor as dispatchPrompt } from '../../src/checks/bin/check-dispatch-readiness'

/**
 * Both required checks build an `agent_recovery_prompt` telling the reading
 * agent what to do about a failure. A self-dependency is unsatisfiable by
 * construction, so every "resolve it / wait for it / close it" instruction is
 * nonsense for that failure — and a nonsense-but-authoritative instruction is
 * precisely what drove two Developer agents to commit with `--no-verify`.
 *
 * Both `recoveryPromptFor`s now switch on a closed class/code value (Issue
 * #355), never on parsing the failure's human message text: `checkD1`
 * distinguishes `dispatched-on-unmet-deps` from `d1-self-dependency` at the
 * point it pushes the failure, and `checkDispatchReadiness` tags
 * `internal-self-dependency` apart from `depends-on-not-merged` the same
 * way — so the prompt dispatchers below take the class/code value directly,
 * never a message string to re-parse.
 */
describe('recovery prompts route an INTERNAL/self-dependency class to escalation, never to a workaround', () => {
  it('coherence: d1-self-dependency gets the parser-bug prompt, never "close the dependency"', () => {
    const p = coherencePrompt('d1-self-dependency')
    expect(p.toLowerCase()).toContain('report it upstream')
    expect(p).not.toContain('Close the dependency first')
  })

  it('coherence: dispatched-on-unmet-deps keeps its original close-the-dependency advice', () => {
    const p = coherencePrompt('dispatched-on-unmet-deps')
    expect(p).toContain('Close the dependency first')
    expect(p).not.toContain('INTERNAL')
  })

  it('dispatch-readiness: internal-self-dependency gets its own prompt naming the parser bug, not the generic fallback', () => {
    const p = dispatchPrompt('internal-self-dependency')
    expect(p.toLowerCase()).toContain('report it upstream')
    expect(p).not.toContain('Resolve the named dispatch blocker')
  })

  it('dispatch-readiness: the internal-self-dependency prompt forbids the exact workaround this PR exists to stop', () => {
    const p = dispatchPrompt('internal-self-dependency')
    expect(p).toContain('do NOT skip the hook')
  })

  it('dispatch-readiness: depends-on-not-merged keeps its original advice', () => {
    const p = dispatchPrompt('depends-on-not-merged')
    expect(p).toContain('not merged yet')
    expect(p).not.toContain('INTERNAL')
  })

  it('dispatch-readiness: depends-on-unresolvable keeps its own distinct advice', () => {
    const p = dispatchPrompt('depends-on-unresolvable')
    expect(p).toContain('could not be resolved')
    expect(p).not.toContain('INTERNAL')
  })
})
