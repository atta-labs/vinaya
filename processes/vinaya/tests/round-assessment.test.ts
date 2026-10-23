import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { assessRound, initialLoopState, type LoopState, type VerdictObservation } from '@attalabs/aeg-core'
import { createRunControl, type SpawnedProcessLike } from '@atta/executor-agent-spawn'
import { SqliteCheckpointer } from '../../../harness/dev-process/engine-runtime/sqlite-checkpointer'
import {
  resumeProcessRun,
  startProcessRun,
  type ActionRegistry
} from '../../../harness/dev-process/engine-runtime/run-process'
import { loadProcess } from '../../../harness/dev-process/loader/load-process'
import {
  carriedLoopState,
  classifyGateResult,
  createActions,
  createRoleLaunchers,
  decisions,
  dispatchReviewers,
  decodeLoopState,
  encodeLoopState,
  type TaskInput
} from '../executing/actions'

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

// --- the carried state survives a halt and a resume on a new saver ----------

const roundOf = (state: LoopState): number => Math.max(state.rounds.length, state.pending?.round ?? 0)

const changesRequested: VerdictObservation[] = [
  {
    role: 'reviewer',
    verdict: 'REQUEST CHANGES',
    objectives: [],
    findings: [{ id: 'F1', severity: 'major', state: 'open' }]
  },
  { role: 'security', verdict: 'PASS', objectives: [], findings: [] }
]

function stubAgent(vendor: 'claude-code' | 'codex'): SpawnedProcessLike {
  const closeListeners: Array<(code: number | null) => void> = []
  let stdout: ((chunk: string) => void) | undefined
  const lines =
    vendor === 'codex'
      ? ['{"type":"thread.started","thread_id":"thread-1"}', '{"type":"turn.completed"}']
      : ['{"type":"result","session_id":"session-1"}']
  return {
    stdin: {
      write: () => {},
      end: () => {
        setTimeout(() => {
          for (const line of lines) stdout?.(`${line}\n`)
          for (const listener of closeListeners) listener(0)
        }, 0)
      }
    },
    stdout: { on: (_event, listener) => (stdout = listener as (chunk: string) => void) },
    stderr: { on: () => {} },
    on: ((event: string, listener: (code: number | null) => void) => {
      if (event === 'close') closeListeners.push(listener)
    }) as SpawnedProcessLike['on'],
    kill: () => {
      for (const listener of closeListeners) listener(null)
    }
  } as SpawnedProcessLike
}

// One assessed round: the gate observation first, then the verdicts, as the standalone loop records it.
function assessedRound(state: LoopState, round: number, verdicts: VerdictObservation[]): LoopState {
  const stats = { baseHead: 'a', head: 'b', filesChanged: 1, insertions: 1, deletions: 0, wallMs: 1 }
  const gated = assessRound(state, { kind: 'gate', round, green: true, confidence: 'absent', stats }).state
  return assessRound(gated, { kind: 'verdicts', round, verdicts }).state
}

describe('the round assessment across a resume', () => {
  test('the loop state round-trips through JSON, its maps included', () => {
    const state = assessedRound(loopState(), 1, changesRequested)
    state.lastIds.set('reviewer:F1', 'open')
    expect(decodeLoopState(encodeLoopState(state))).toEqual(state)
  })

  test('the previous assessment result supplies the state; a lower recorded round never replaces the initial one', () => {
    const initial = loopState()
    expect(carriedLoopState({}, initial)).toBe(initial)
    const advanced = assessedRound(initial, 1, changesRequested)
    const result = (state: LoopState) =>
      ({
        'assess-round': { kind: 'mechanical', stdout: JSON.stringify({ state: JSON.parse(encodeLoopState(state)) }) }
      }) as never
    expect(carriedLoopState(result(advanced), initial)).toEqual(advanced)
    expect(carriedLoopState(result(initial), advanced)).toBe(advanced)
    expect(() => carriedLoopState({ 'assess-round': { kind: 'mechanical', stdout: '{}' } } as never, initial)).toThrow(
      'no readable loop state'
    )
  })

  for (const vendor of ['claude-code', 'codex'] as const) {
    test(`a halted run resumed on a new saver carries the round and the pending round forward (${vendor})`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'round-resume-'))
      const file = join(root, 'run', 'checkpoints.sqlite')
      const control = createRunControl()
      const verdictsByRound = [changesRequested, approving]
      let observed = 0
      const task = {
        worktreePath: worktree(),
        loopState: loopState(),
        reviewRound: () => observed,
        verdicts: () => verdictsByRound[observed - 1] ?? approving,
        observe: () => {
          observed += 1
          return { kind: 'verdicts', round: observed, verdicts: verdictsByRound[observed - 1] ?? approving }
        }
      } as unknown as TaskInput
      const carriedBefore: LoopState[] = []
      const recorded: LoopState[] = []
      let classified = 0
      // Each leg builds its actions anew, as a second runner process would: nothing carries over in memory.
      const actionsForLeg = (): ActionRegistry => {
        const real = createActions(task)
        return {
          ...Object.fromEntries(
            [
              'vinaya.prepare-run',
              'vinaya.reconcile-external-state',
              'vinaya.prepare-sources',
              'vinaya.choose-start',
              'vinaya.validate-developer-output',
              'vinaya.validate-reviewer-outputs',
              'harness.publish'
            ].map((name) => [name, () => ({ exitCode: 0 })])
          ),
          'harness.run-gates': () => ({ exitCode: 0 }),
          'vinaya.classify-gate-result': (context) => {
            classified += 1
            // The halt lands in the second round, after the first assessment recorded its state.
            if (classified === 2) control.halt('stop in the second round')
            return classifyGateResult(context)
          },
          'vinaya.dispatch-reviewers': () => dispatchReviewers(),
          'vinaya.assess-round': async (context) => {
            carriedBefore.push(carriedLoopState(context.results, task.loopState))
            const result = await real['vinaya.assess-round']!(context)
            recorded.push(
              decodeLoopState(JSON.stringify((JSON.parse(result.stdout ?? '') as { state: unknown }).state))
            )
            return result
          },
          'vinaya.build-revision-handoff': real['vinaya.build-revision-handoff']!
        }
      }
      const process = loadProcess(resolve(import.meta.dir, '..'))
      const roles = createRoleLaunchers({ vendor, generatedRoot: join(root, 'generated') })
      const base = {
        process,
        question: 'Task 9',
        bindings: { actions: actionsForLeg(), decisions, roles },
        workingDirectoryRoot: resolve(import.meta.dir, '../../..'),
        continueSessions: ['develop'],
        spawnFn: () => stubAgent(vendor)
      }

      const first = new SqliteCheckpointer({ path: file, revision: 'rev-a' })
      const paused = await startProcessRun({ ...base, checkpointer: first, control })
      first.close()
      expect(paused.reason).toBe('paused')
      expect(recorded).toHaveLength(1)
      const before = recorded[0]!

      const second = new SqliteCheckpointer({ path: file, revision: 'rev-b' })
      const resumed = await resumeProcessRun(
        { ...base, bindings: { actions: actionsForLeg(), decisions, roles }, checkpointer: second },
        paused.identity
      )
      second.close()
      expect(resumed.reason).toBe('completed')
      expect(recorded).toHaveLength(2)
      // The second assessment started from the state the first recorded, not from the task's initial state.
      expect(carriedBefore[1]!.rounds).toEqual(before.rounds)
      expect(carriedBefore[1]!.pending).toEqual(before.pending)
      expect(roundOf(carriedBefore[1]!)).toBe(roundOf(before))
      expect(roundOf(carriedBefore[1]!)).toBeGreaterThan(roundOf(carriedBefore[0]!))
      expect(roundOf(recorded[1]!)).toBeGreaterThanOrEqual(roundOf(before))
    })
  }
})
