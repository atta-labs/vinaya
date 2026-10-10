/**
 * A Developer turn that ends with the head unchanged because a driver tool
 * refused its publication goes straight back to the loop's next decision, naming
 * the refusal — never the full head-change wait. A turn with no refusal keeps it.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import {
  cleanupWorlds,
  developerPublishesViaToolsDeps,
  makeWorld,
  runLoopInProcess,
  type LoopWorld,
  defaultDeveloperTurnOutput
} from '../dev-review-loop-harness.js'
import type { LoopDeps } from '../../../src/lib/dev-review-loop.js'

afterEach(cleanupWorlds)

const POLL_MS = 7
const POLL_ATTEMPTS = 40

/** Round 1 publishes through the tools; every later turn either attempts a publication from the wrong branch or does nothing. */
function redGateDeps(
  world: LoopWorld,
  laterTurn: 'refused' | 'idle'
): { deps: Partial<LoopDeps>; pollSleeps: () => number } {
  const publishing = developerPublishesViaToolsDeps(world, { changedPaths: ['apps/cli/src/lib/x.ts'] })
  let developerTurns = 0
  let pollSleeps = 0
  const deps: Partial<LoopDeps> = {
    ...publishing,
    gatePollMaxAttempts: POLL_ATTEMPTS,
    gatePollIntervalMs: POLL_MS,
    fetchCiConclusion: () => 'red',
    fetchFailingCheckRuns: () => [{ id: 1, name: 'evidence-fresh', conclusion: 'failure' }] as never,
    sleep: async (ms) => {
      if (ms === POLL_MS) pollSleeps += 1
      await new Promise((r) => setTimeout(r, 1))
    },
    dispatchRole: async (role, agent, prompt, dOpts) => {
      if (role !== 'developer') return publishing.dispatchRole!(role, agent, prompt, dOpts)
      developerTurns += 1
      if (developerTurns === 1) return publishing.dispatchRole!(role, agent, prompt, dOpts)
      world.dispatchCountByRole.developer = developerTurns
      if (laterTurn === 'refused') {
        world.worktreeDirty = ['apps/cli/src/lib/y.ts']
        world.worktreeChangedPaths = ['apps/cli/src/lib/y.ts']
        world.worktreeBranchName = 'task/other/1'
        const refused = await world.devToolContext!.publishChanges('Fix(cli): publish from the wrong branch')
        expect(refused.ok).toBe(false)
        // The Developer gives up on the refused change: nothing is left unpublished for the driver to re-ask.
        world.worktreeBranchName = undefined
        world.worktreeDirty = []
        world.worktreeChangedPaths = []
      }
      return {
        exitCode: 0,
        durationMs: 1,
        usage: { input: 1, output: 1 },
        resumeId: 'dev-session-1',
        timedOut: false,
        effectId: `eff-${developerTurns}`,
        turnOutput: defaultDeveloperTurnOutput(prompt)
      }
    }
  }
  return { deps, pollSleeps: () => pollSleeps }
}

describe('devReviewLoop — a refused publication skips the head-change wait', () => {
  it('O1: waits at most one poll interval per turn and names the refusal in the stall', async () => {
    const world = makeWorld({ gate: 'red', worktreeExists: true, surface: { in: ['apps/cli'], out: ['packages'] } })
    const { deps, pollSleeps } = redGateDeps(world, 'refused')
    const result = await runLoopInProcess(world, { task: world.task, agent: 'claude' }, deps)

    expect(result.finalDecision.type).toBe('pause')
    expect((result.finalDecision as { detail: string }).detail).toMatch(
      /publication refused: publication-preconditions/
    )
    const laterTurns = (world.dispatchCountByRole.developer ?? 1) - 1
    expect(pollSleeps()).toBeLessThanOrEqual(laterTurns)
  })

  it('O2: a turn with no refused publication keeps the full head-change wait and its no-push handling', async () => {
    const world = makeWorld({ gate: 'red', worktreeExists: true, surface: { in: ['apps/cli'], out: ['packages'] } })
    const { deps, pollSleeps } = redGateDeps(world, 'idle')
    const result = await runLoopInProcess(world, { task: world.task, agent: 'claude' }, deps)

    expect(result.finalDecision.type).toBe('pause')
    expect((result.finalDecision as { detail: string }).detail).not.toMatch(/publication refused/)
    expect(pollSleeps()).toBeGreaterThanOrEqual(POLL_ATTEMPTS)
  })
})
