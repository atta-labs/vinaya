/**
 * A stall is named only by what fails on the current head: after the loop
 * reruns failed checks, an unchanged Developer turn is judged against the
 * head's CI as it reads now, never the conclusion read before the rerun.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import {
  blockedTurnOutput,
  cleanupWorlds,
  completedTurnOutput,
  makeWorld,
  runLoopInProcess,
  type LoopWorld
} from '../dev-review-loop-harness.js'
import type { LoopDeps } from '../../../src/lib/dev-review-loop.js'

afterEach(cleanupWorlds)

const FAILING = { id: 7001, name: 'test (shard 1)', conclusion: 'failure' }

/** A pull request whose head is red on one check; the Developer's first turn in the round reports `tooling_unavailable`, every later one ends with no push. */
function redHeadWorld(): LoopWorld {
  const world = makeWorld({ worktreeExists: true, developerPushed: true, prOpened: true })
  world.gate = 'red'
  world.failingCheckRuns = [{ ...FAILING }]
  world.developerTurnOutput = (_round, _prompt, dispatch) =>
    dispatch === 1 ? blockedTurnOutput('tooling_unavailable', 'cannot rerun CI from my sandbox') : completedTurnOutput()
  return world
}

/** The forge's rerun, whose outcome `afterRerun` writes into the world. */
function rerunDeps(world: LoopWorld, afterRerun: () => void): { deps: Partial<LoopDeps>; reruns: number[] } {
  const reruns: number[] = []
  return {
    reruns,
    deps: {
      fetchFailedCheckWorkflowRunIds: () => (world.gate === 'red' && world.failingCheckRuns.length > 0 ? [4242] : []),
      rerunFailedWorkflowJobs: (runId) => {
        reruns.push(runId)
        afterRerun()
      }
    }
  }
}

describe('devReviewLoop — a stall never names a check that has since passed', () => {
  for (const agent of ['claude', 'codex'] as const) {
    it(`${agent}: a tooling report whose rerun passes, then a turn with no push, reaches the reviewers without another Developer turn`, async () => {
      const world = redHeadWorld()
      const { deps, reruns } = rerunDeps(world, () => {
        world.gate = 'green'
        world.failingCheckRuns = []
      })
      const result = await runLoopInProcess(world, { task: world.task, agent }, deps)
      expect(reruns).toEqual([4242])
      // The tooling turn and its one re-dispatch — no third Developer turn.
      expect(world.dispatchCountByRole.developer).toBe(2)
      expect(world.dispatches.filter((dispatch) => dispatch.role === 'code-reviewer')).toHaveLength(1)
      expect(world.dispatches.filter((dispatch) => dispatch.role === 'security')).toHaveLength(1)
      expect(result.finalDecision.type).toBe('publish')
    })
  }

  it('a stall assessed after a rerun that cleared every failing check names no check-run and never pauses repeat_failure', async () => {
    const world = redHeadWorld()
    // The head stays red, but no check-run on it is failing any more.
    const { deps, reruns } = rerunDeps(world, () => {
      world.failingCheckRuns = []
    })
    const result = await runLoopInProcess(world, { task: world.task, agent: 'codex' }, deps)
    expect(reruns).toEqual([4242])
    expect(result.finalDecision.type).toBe('pause')
    const decision = result.finalDecision as { reason: string; detail?: string }
    expect(decision.reason).not.toBe('repeat_failure')
    expect(decision.detail ?? '').not.toContain(FAILING.name)
    expect(decision.detail ?? '').toContain('no named failure for this head')
  })

  it('a check still red after the rerun is still named, and pauses on the second identical attempt', async () => {
    const world = redHeadWorld()
    const { deps, reruns } = rerunDeps(world, () => {})
    const result = await runLoopInProcess(world, { task: world.task, agent: 'codex' }, deps)
    expect(reruns).toEqual([4242])
    expect(result.finalDecision).toMatchObject({ type: 'pause', reason: 'repeat_failure' })
    expect((result.finalDecision as { detail?: string }).detail ?? '').toContain(
      `failing check-run(s): ${FAILING.name} (run ${FAILING.id})`
    )
  })
})
