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
 * Caught at review on this PR: the guard itself named the failure honestly,
 * but the two prompt dispatchers still routed it to the ordinary advice —
 * D1 by switching on the check code alone (a self-dependency and an unmet
 * dependency are both `D1`), dispatch-readiness by having no arm for the new
 * prefix and falling through to the generic default.
 */
describe('recovery prompts route an INTERNAL self-dependency to escalation, never to a workaround', () => {
  const SELF_DEP_D1 =
    'INTERNAL: parsed a self-dependency (depends-on 1) — this is a parser bug in parseRationaleDeps, not a real dependency. Please report it upstream.'
  const SELF_DEP_GATE =
    'dispatch-gate INTERNAL: parsed a self-dependency for task 1 (#1037) — this is a parser bug in parseRationaleDeps, not a real dependency. Please report it upstream. Re-run once the rationale is corrected or the fix ships.'

  it('coherence D1: never tells the agent to close an uncloseable dependency', () => {
    const p = coherencePrompt('D1', SELF_DEP_D1)
    expect(p).toContain('INTERNAL')
    expect(p.toLowerCase()).toContain('report it upstream')
    expect(p).not.toContain('Close the dependency first')
  })

  it('coherence D1: an ordinary unmet dependency keeps its original advice', () => {
    const p = coherencePrompt('D1', 'Task has open PR but depends-on #100 (issue #100) is not closed')
    expect(p).toContain('Close the dependency first')
    expect(p).not.toContain('INTERNAL')
  })

  it('coherence: the INTERNAL branch wins for any check code carrying it', () => {
    expect(coherencePrompt('A1', 'INTERNAL: something impossible').toLowerCase()).toContain('report it upstream')
  })

  it('coherence: omitting detail preserves the pre-change code-only behavior', () => {
    expect(coherencePrompt('D1')).toContain('Close the dependency first')
  })

  it('dispatch-readiness: the INTERNAL prefix gets its own prompt, not the generic fallback', () => {
    const p = dispatchPrompt(SELF_DEP_GATE)
    expect(p).toContain('INTERNAL')
    expect(p.toLowerCase()).toContain('report it upstream')
    expect(p).not.toContain('Resolve the named dispatch blocker')
  })

  it('dispatch-readiness: the INTERNAL prompt forbids the exact workaround this PR exists to stop', () => {
    const p = dispatchPrompt(SELF_DEP_GATE)
    expect(p).toContain('do NOT skip the hook')
  })

  it('dispatch-readiness: an ordinary unmerged edge keeps its original advice', () => {
    const p = dispatchPrompt('dispatch-gate depends-on: task 1 depends on 5 (#266), whose PR is not merged yet.')
    expect(p).toContain('not merged yet')
    expect(p).not.toContain('INTERNAL')
  })

  it('dispatch-readiness: an unresolvable edge keeps its own distinct advice', () => {
    const p = dispatchPrompt('dispatch-gate depends-on: task 1 depends on "x 2", which is UNRESOLVABLE — …')
    expect(p).toContain('could not be resolved')
    expect(p).not.toContain('INTERNAL')
  })
})
