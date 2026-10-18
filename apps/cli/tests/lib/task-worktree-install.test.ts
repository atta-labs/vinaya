/**
 * The review-loop driver installs the task worktree's own dependencies once
 * per driver process, before the Developer's first prompt. The loop is driven
 * through the shared in-process harness; the real implementation is called
 * only on a directory with no `bun.lock`, where it must do nothing.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import {
  cleanupWorlds,
  defaultDeveloperTurnOutput,
  developerPublishesViaToolsDeps,
  makeInProcessDeps,
  makeWorld,
  runLoopInProcess,
  type LoopWorld
} from './dev-review-loop-harness.js'
import { defaultInstallWorktreeDependencies, worktreeInstallEnv, type LoopDeps } from '../../src/lib/dev-review-loop.js'

afterEach(cleanupWorlds)

function worktreePath(world: LoopWorld): string {
  return join(world.repoRoot, '.worktrees', world.branch)
}

/** The default Developer deps, also recording the prompts the Developer receives. */
function recordingDeps(world: LoopWorld): { deps: Partial<LoopDeps>; prompts: string[] } {
  const base = makeInProcessDeps(world)
  const prompts: string[] = []
  const dispatchRole: LoopDeps['dispatchRole'] = async (role, agent, prompt, opts) => {
    if (role === 'developer') {
      prompts.push(prompt)
      world.dispatchCountByRole.developer = prompts.length
      world.dispatches.push({ role, round: opts.round ?? 1, resumeId: 'dev-session-1' })
      return {
        exitCode: 0,
        durationMs: 1,
        usage: { input: 10, output: 5 },
        resumeId: 'dev-session-1',
        timedOut: false,
        effectId: `eff-dev-${prompts.length}`,
        turnOutput: defaultDeveloperTurnOutput(prompt)
      }
    }
    return base.dispatchRole!(role, agent, prompt, opts)
  }
  return { deps: { ...base, dispatchRole }, prompts }
}

describe('installing the task worktree dependencies before the Developer starts', () => {
  it('a fresh start installs once, on the worktree, before the first Developer prompt', async () => {
    const world = makeWorld({ worktreeExists: true })
    const { deps, prompts } = recordingDeps(world)
    await runLoopInProcess(world, { task: world.task, agent: 'claude' }, deps)

    expect(prompts.length).toBeGreaterThan(0)
    expect(world.dependencyInstalls).toEqual([{ worktreePath: worktreePath(world), promptsSoFar: 0 }])
  })

  it('a start onto a worktree created from the pushed branch installs once before the first prompt', async () => {
    const world = makeWorld({ developerPushed: true, worktreeFromRemoteCreatesDir: true })
    expect(existsSync(worktreePath(world))).toBe(false)
    const { deps } = recordingDeps(world)
    await runLoopInProcess(
      world,
      { task: world.task, agent: 'claude' },
      {
        ...deps,
        findOpenPrForBranch: (branch) =>
          world.dispatchCountByRole.developer ? { number: world.prNumber, branch } : null
      }
    )

    expect(world.worktreesFromRemote).toHaveLength(1)
    expect(world.dependencyInstalls).toEqual([{ worktreePath: worktreePath(world), promptsSoFar: 0 }])
  })

  it('a run of several rounds installs exactly once', async () => {
    const world = makeWorld({
      worktreeExists: true,
      roleOutcomes: {
        1: {
          reviewer: {
            findings: 'BLOCKER|apps/cli/src/lib/x.ts:1|fix the behavior',
            report: 'BRIEF_CONFORMANCE: yes\nSPEC_CONFORMANCE: yes\nSCOPE: small\nTESTS: pass\nDOCS: n/a\n',
            objectives: 'O1|MET|done.\n',
            sessionId: 'rev-session-1'
          }
        }
      }
    })
    const publishing = developerPublishesViaToolsDeps(world, { header: 'Fix(cli): address blocking review' })
    await runLoopInProcess(world, { task: world.task, agent: 'claude' }, publishing)

    expect(world.dispatches.some((d) => d.role === 'developer' && d.round === 2)).toBe(true)
    expect(world.dependencyInstalls).toHaveLength(1)
  })

  it('a failing install pauses as infrastructure with the output in the detail and no Developer prompt', async () => {
    const world = makeWorld({ worktreeExists: true, dependencyInstallFailure: 'error: lockfile had changes' })
    const { deps, prompts } = recordingDeps(world)
    const result = await runLoopInProcess(world, { task: world.task, agent: 'claude' }, deps)

    expect(result.finalDecision.type).toBe('pause')
    const decision = result.finalDecision as { reason: string; detail: string }
    expect(decision.reason).toBe('infrastructure')
    expect(decision.detail).toContain('error: lockfile had changes')
    expect(decision.detail).toContain(worktreePath(world))
    expect(prompts).toHaveLength(0)
  })

  it('the real implementation leaves a worktree with no bun.lock alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'worktree-install-'))
    try {
      mkdirSync(join(dir, 'src'))
      expect(() => defaultInstallWorktreeDependencies(dir)).not.toThrow()
      expect(readdirSync(dir)).toEqual(['src'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the install environment carries only allowlisted keys, never a driver secret', () => {
    const env = worktreeInstallEnv({
      PATH: '/usr/bin',
      HOME: '/home/x',
      GH_TOKEN: 'secret',
      ANTHROPIC_API_KEY: 'secret'
    })
    expect(env.PATH).toBe('/usr/bin')
    expect(Object.keys(env)).not.toContain('GH_TOKEN')
    expect(Object.keys(env)).not.toContain('ANTHROPIC_API_KEY')
  })
})
