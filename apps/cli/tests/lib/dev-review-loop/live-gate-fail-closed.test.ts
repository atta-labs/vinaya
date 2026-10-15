/**
 * The live check fails closed: when the round's read of the frozen brief
 * fails, the `[live]` lines the task owes are unknown, so the task never
 * concludes on it — the round ends as an infrastructure failure, retried
 * through the existing infrastructure-retry path, with nothing run and no
 * `AEG:LIVE` record claiming anything.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { readLiveRecord } from '@attalabs/aeg-core'
import type { LoopDeps } from '../../../src/lib/dev-review-loop.js'
import {
  cleanupWorlds,
  controlDir,
  type LoopWorld,
  makeInProcessDeps,
  makeWorld,
  runDriverLoopInProcess,
  runLoopInProcess
} from '../dev-review-loop-harness.js'

afterEach(cleanupWorlds)

const LIVE = 'VINAYA_LIVE_CONFORMANCE=1 bun test apps/cli/tests/sandbox-conformance/claude-live.test.ts'

/** A frozen brief whose §9 carries a command line and, when given, `[live]` items. */
function briefWith(live: string[]): string {
  return [
    '<!-- aeg:brief:v1 -->\nBrief hash: deadbeef\nDo the thing.\n\n## Objectives\n\nO1. Do the thing.\n',
    '## 9. Test Plan',
    '',
    '```',
    'bun test apps/cli/tests/lib/dev-review-loop/live-gate-fail-closed.test.ts → 0 fail',
    '```',
    ...(live.length > 0 ? ['', ...live.map((cmd) => `- **[live]** \`${cmd}\``)] : []),
    ''
  ].join('\n')
}

function reviewerDispatches(world: LoopWorld): number {
  return world.dispatches.filter((d) => d.role === 'code-reviewer' || d.role === 'security').length
}

function infrastructureRetries(world: LoopWorld): number {
  return (
    JSON.parse(readFileSync(join(controlDir(world), 'loop-state.json'), 'utf8')) as {
      budgets: { infrastructureRetries: number }
    }
  ).budgets.infrastructureRetries
}

/**
 * Deps whose frozen-brief read fails `failures` times once both of a round's
 * reviewers have finished — the read the round makes right before the live
 * check — and whose live runner records every line it runs and passes it.
 */
function failingBriefReadDeps(world: LoopWorld, failures: number): { deps: Partial<LoopDeps>; ran: string[] } {
  const base = makeInProcessDeps(world)
  const ran: string[] = []
  let reviewersFinished = 0
  let left = failures
  const deps: Partial<LoopDeps> = {
    dispatchRole: async (role, agent, prompt, opts) => {
      const outcome = await base.dispatchRole!(role, agent, prompt, opts)
      if (role === 'code-reviewer' || role === 'security') reviewersFinished += 1
      return outcome
    },
    fetchFrozenBrief: (_issue) => {
      if (left > 0 && reviewersFinished > 0 && reviewersFinished % 2 === 0) {
        left -= 1
        throw new Error('HTTP 502: Bad Gateway (https://api.github.com/graphql)')
      }
      return world.frozenBrief
    },
    runLiveCommand: async (command) => {
      ran.push(command)
      return { exitCode: 0, timedOut: false, output: ' 3 pass\n 0 fail\n' }
    },
    liveVendorSignedIn: () => true,
    liveRunTimeoutMs: 1_000,
    prepareLiveCheckout: async (_root, head) => ({ cwd: `/live-checkout/${head}`, dispose: () => {} })
  }
  return { deps, ran }
}

describe('the live check fails closed', () => {
  it('a brief read that fails once both reviewers approved leaves the task unconcluded: an infrastructure pause, nothing run, no record', async () => {
    const world = makeWorld({ frozenBrief: briefWith([LIVE]) })
    const { deps, ran } = failingBriefReadDeps(world, Number.POSITIVE_INFINITY)

    const result = await runLoopInProcess(world, undefined, deps)

    expect(reviewerDispatches(world)).toBe(2)
    expect(result.finalDecision).toMatchObject({ type: 'pause', reason: 'infrastructure' })
    expect(ran).toEqual([])
    expect(world.publishedRounds).toEqual([])
    expect(world.prBodyUpdates.some((b) => b.includes('AEG:LIVE'))).toBe(false)
    expect(readLiveRecord(world.prBody)).toEqual([])
    expect(infrastructureRetries(world)).toBe(1)
  })

  it('the infrastructure pause is retried, and the retry runs the line on the approved head before the task concludes', async () => {
    const world = makeWorld({ frozenBrief: briefWith([LIVE]) })
    const { deps, ran } = failingBriefReadDeps(world, 1)

    const result = await runDriverLoopInProcess(world, undefined, deps)

    expect(result.finalDecision.type).toBe('publish')
    expect(reviewerDispatches(world)).toBeGreaterThan(2)
    expect(ran).toEqual([LIVE])
    expect(readLiveRecord(world.prBody)).toEqual([
      expect.objectContaining({ command: LIVE, outcome: 'passed', head: world.head, ticked: true })
    ])
  })

  it('a brief with no `[live]` line still concludes exactly as before', async () => {
    const world = makeWorld({ frozenBrief: briefWith([]) })
    const { deps, ran } = failingBriefReadDeps(world, 0)

    const result = await runLoopInProcess(world, undefined, deps)

    expect(result.finalDecision.type).toBe('publish')
    expect(ran).toEqual([])
    expect(world.prBody).not.toContain('AEG:LIVE')
  })
})
