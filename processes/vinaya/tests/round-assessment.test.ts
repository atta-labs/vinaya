import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assessRound, initialLoopState, type VerdictObservation } from '@attalabs/aeg-core'
import { createActions, type TaskInput } from '../executing/actions'

type Action = (context: never) => Promise<{ exitCode: number; stdout?: string }> | { exitCode: number; stdout?: string }

// A worktree whose `origin/main` sits one commit behind HEAD, so the gate observation can read a diff.
function worktree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'round-wt-'))
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q')
  writeFileSync(join(dir, 'a.txt'), 'a\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  writeFileSync(join(dir, 'b.txt'), 'b\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'change')
  return dir
}

const approving: VerdictObservation[] = [
  { role: 'reviewer', verdict: 'APPROVE', objectives: [], findings: [] },
  { role: 'security', verdict: 'PASS', objectives: [], findings: [] }
]

const loopState = () =>
  initialLoopState({
    loopId: 'loop-1',
    task: 9,
    reviewers: ['reviewer', 'security'],
    models: {},
    maxRounds: 5,
    maxTaskMinutes: 0
  })

describe('assess-round', () => {
  test('a verdicts observation with no pending round records the gate first and does not throw', async () => {
    const task = {
      worktreePath: worktree(),
      loopState: loopState(),
      observe: () => ({ kind: 'verdicts', round: 1, verdicts: approving })
    } as unknown as TaskInput
    const assess = createActions(task)['vinaya.assess-round'] as unknown as Action
    const develop = {
      kind: 'agent-spawn',
      nodeId: 'develop',
      exitCode: 0,
      events: [{ turnResult: { confidence: 0.9, confidenceExplanation: 'tested' } }]
    }
    const gate = {
      kind: 'mechanical',
      nodeId: 'run-mechanical-gates',
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 1234
    }
    const result = await assess({ results: { develop, 'run-mechanical-gates': gate } } as never)
    const { decision, events } = JSON.parse(result.stdout ?? '') as {
      decision: { type: string }
      events: Array<{ event: string }>
    }
    expect(decision.type).toBe('publish')
    expect(result.exitCode).toBe(0)
    const names = events.map((e) => e.event)
    // The injected gate is recorded before the verdicts: removing the injection drops gate_result_read.
    expect(names.indexOf('gate_result_read')).toBeGreaterThanOrEqual(0)
    expect(names.indexOf('gate_result_read')).toBeLessThan(names.indexOf('verdicts_read'))
  })

  test('a red or missing gate result is a wiring fault, never read as green', async () => {
    const make = () =>
      createActions({
        worktreePath: worktree(),
        loopState: loopState(),
        observe: () => ({ kind: 'verdicts', round: 1, verdicts: approving })
      } as unknown as TaskInput)['vinaya.assess-round'] as unknown as Action
    const red = {
      kind: 'mechanical',
      nodeId: 'run-mechanical-gates',
      exitCode: 1,
      stdout: '',
      stderr: '',
      durationMs: 1
    }
    await expect(async () => make()({ results: { 'run-mechanical-gates': red } } as never)).toThrow('red gate')
    await expect(async () => make()({ results: {} } as never)).toThrow('no recorded result')
  })
})

test('control: assessRound alone cannot take verdicts before a gate', () => {
  let outcome = 'returned'
  try {
    const decision = assessRound(loopState(), { kind: 'verdicts', round: 1, verdicts: approving }).decision
    outcome = decision.type
  } catch {
    outcome = 'threw'
  }
  expect(outcome).not.toBe('publish')
})

describe('build-revision-handoff', () => {
  const setup = () => {
    let round = 1
    const task = {
      reviewRound: () => round,
      verdicts: () => {
        round += 1
        return approving
      }
    } as unknown as TaskInput
    return { handoff: createActions(task)['vinaya.build-revision-handoff'] as unknown as Action, round: () => round }
  }
  const assessed = (type: string) => ({
    'assess-round': { kind: 'mechanical', exitCode: 0, stdout: JSON.stringify({ decision: { type } }) }
  })

  test('a publish decision leaves the round unchanged, so the held verdicts for that round are found', async () => {
    const { handoff, round } = setup()
    const result = await handoff({ results: assessed('publish') } as never)
    expect(result.stdout ?? '').toBe('')
    expect(round()).toBe(1)
  })

  test('an unreadable assess-round output fails loudly instead of revising', async () => {
    const { handoff, round } = setup()
    const broken = { 'assess-round': { kind: 'mechanical', exitCode: 1, stdout: 'not json' } }
    await expect(async () => handoff({ results: broken } as never)).toThrow('could not read the assess-round decision')
    const typeless = { 'assess-round': { kind: 'mechanical', exitCode: 1, stdout: '{}' } }
    await expect(async () => handoff({ results: typeless } as never)).toThrow('no decision type')
    expect(round()).toBe(1)
  })

  test('a revise decision reads the verdicts and starts the next round', async () => {
    const { handoff, round } = setup()
    await handoff({ results: assessed('revise') } as never)
    expect(round()).toBe(2)
  })
})

describe('agentOutput', () => {
  test('a Codex step and a Claude step give the actions the same turn result', async () => {
    const { agentOutput } = await import('../executing/actions')
    const turn = { turnResult: { schemaVersion: 1, status: 'completed', summary: 's' } }
    const claude = { develop: { kind: 'agent-spawn', nodeId: 'develop', exitCode: 0, events: [turn] } }
    const codex = {
      develop: {
        kind: 'agent-spawn',
        nodeId: 'develop',
        exitCode: 0,
        events: [
          { type: 'thread.started', thread_id: 't' },
          { type: 'item.completed', item: { id: 'i', type: 'agent_message', text: JSON.stringify(turn) } },
          { type: 'turn.completed', usage: {} }
        ]
      }
    }
    expect(agentOutput(codex as never, 'develop')).toEqual(turn)
    expect(agentOutput(claude as never, 'develop')).toEqual(turn)
  })
})
