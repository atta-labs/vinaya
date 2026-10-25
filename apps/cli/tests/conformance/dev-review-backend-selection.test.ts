// Backend selection and rollback (evaluation program §6.20), the L2 and L3
// evidence of cutover-gate:gate-13 on the Engine backend: with this
// repository's configured runner switched from atta-engine to standalone, a
// new run is pinned to standalone, while each in-flight Engine run — one in
// each of the three pause kinds, one stopped mid-Developer turn, one stopped
// mid-review and one with an uncertain publication — is either continued on
// the Engine to the terminal state it reaches with no switch, or terminated
// and restarted on standalone with no effect duplicated or lost on the
// forge-fake ledger. Each case runs with the Claude stub and the Codex stub.
// The live L6 rehearsal reads a real rehearsal record, and runs only when
// VINAYA_ROLLBACK_REHEARSAL names the rehearsed task.
import { afterAll, describe, expect, it } from 'bun:test'
import { readEffect } from '@attalabs/aeg-core'
import {
  endEngineRunThrough,
  readRollbackRehearsals,
  type RollbackRehearsalRecord,
  terminateAndRestart
} from '../../src/lib/backend-rollback.js'
/** The configuration a run reads its runner from. */
type VinayaConfig = NonNullable<ReturnType<NonNullable<RunTaskDeps['runnerConfig']>>>
import { isDriverPidAlive, readDriverLock, readPauseState } from '../../src/lib/dev-review-loop/pause-resume.js'
import { runtimeDir as runtimeDirForThisRepo } from '../../src/lib/dev-review-loop.js'
import { CrossRunnerRefusedError, runTask, type RunTaskDeps } from '../../src/lib/task-run.js'
import {
  crossRunnerRefusalReason,
  engineRunnerScriptPath,
  readTaskRunner,
  recordTaskRunner
} from '../../src/lib/task-run-engine.js'
import { runnerReadingFor } from '../../src/lib/task-status.js'
import { resumeContinuation } from '../../src/lib/task-tools/resume.js'
import { cleanupWorlds, makeWorld, runLoopInProcess } from '../lib/dev-review-loop-harness.js'
import {
  IN_FLIGHT_KINDS,
  type InFlightEngineRun,
  type InFlightKind,
  PUBLICATION_EFFECT_KEY,
  runInFlightEngineRun
} from './dev-review-engine-loop-adapter.js'
import type { Observation } from './dev-review-current-loop-adapter.js'

afterAll(() => cleanupWorlds())

const AGENTS = ['claude', 'codex'] as const
/** The configured runner before and after the switch. */
const ENGINE_CONFIG = { runner: 'atta-engine' } as VinayaConfig
const STANDALONE_CONFIG = { runner: 'standalone' } as VinayaConfig
/** The in-flight kinds whose first leg holds a pause, as against the two stopped mid-turn. */
const PAUSED: readonly InFlightKind[] = [
  'principal-ruling-pause',
  'automatic-recovery-pause',
  'operator-remediation-pause',
  'uncertain-effect'
]
/** A task the configured runner starts once the switch is made: the new run. */
const NEW_TASK = 9002
/** The publication's own comments: once each across both runs, never duplicated and never lost. */
const PUBLICATION_MARKERS = ['reviewer-verdict', 'security-verdict', 'summary']

function fixtureDeps(task: number, overrides: Partial<RunTaskDeps> = {}): RunTaskDeps {
  return {
    prepareTask: async () => ({ issue: task }) as Awaited<ReturnType<RunTaskDeps['prepareTask']>>,
    prepareIssueTask: async () => ({ issue: task }) as Awaited<ReturnType<RunTaskDeps['prepareIssueTask']>>,
    assembleAndRenderBrief: async () => {
      throw new Error('unexpected render')
    },
    assembleAndRenderBriefForIssue: async () => {
      throw new Error('unexpected render')
    },
    developerBranchFor: () => `task/issue-${task}`,
    findOpenPrForBranch: () => null,
    isDriverAlive: () => false,
    hasPauseState: () => false,
    resolveModelForDispatch: () => undefined,
    devReviewLoop: async () => {
      throw new Error('unexpected standalone loop')
    },
    resolveRepo: async () => null,
    assignIssue: () => {},
    runnerConfig: () => STANDALONE_CONFIG,
    ...overrides
  }
}

/** What the terminal state of a run is judged by: its decision, its durable control phase and its forge effects. */
const terminal = (observation: Observation) => ({
  decision: observation.decision,
  controlPhase: observation.durable.controlPhase,
  effects: observation.effects
})

const baselines = new Map<string, Observation>()
/** The terminal state the in-flight run reaches when it is continued with no switch at all. */
async function baseline(kind: InFlightKind, agent: (typeof AGENTS)[number]): Promise<Observation> {
  const key = `${kind}:${agent}`
  const cached = baselines.get(key)
  if (cached) return cached
  const observed = await runInFlightEngineRun(kind, agent, (run) => run.continueOnEngine())
  baselines.set(key, observed)
  return observed
}

/** Switches the configured runner and shows the switch pins new runs only; the in-flight run keeps the Engine. */
async function switchRunner(run: InFlightEngineRun): Promise<void> {
  expect(readTaskRunner(run.task, run.runtimeDir)).toBe('atta-engine')
  // Before the switch the configured runner starts a new run on the Engine; after it, on standalone.
  let engineStarts = 0
  let standaloneStarts = 0
  const newRun = (config: VinayaConfig) =>
    runTask(
      { issue: NEW_TASK, agent: run.agent },
      fixtureDeps(NEW_TASK, {
        runnerConfig: () => config,
        recordRunner: (issue, runner) => recordTaskRunner(issue, runner, run.runtimeDir),
        devReviewLoop: async () => {
          standaloneStarts += 1
          return { task: NEW_TASK, prNumber: 7, finalDecision: { type: 'publish' } }
        },
        engine: {
          scriptPath: () => '/runner.ts',
          exists: () => true,
          spawn: async () => {
            engineStarts += 1
            return 0
          },
          notice: () => {}
        }
      })
    )
  await newRun(ENGINE_CONFIG)
  expect([engineStarts, standaloneStarts, readTaskRunner(NEW_TASK, run.runtimeDir)]).toEqual([1, 0, 'atta-engine'])
  await newRun(STANDALONE_CONFIG)
  expect([engineStarts, standaloneStarts, readTaskRunner(NEW_TASK, run.runtimeDir)]).toEqual([1, 1, 'standalone'])

  // The run recorded on the Engine keeps routing there: status, resume and cancel read its record, not the config.
  expect(readTaskRunner(run.task, run.runtimeDir)).toBe('atta-engine')
  expect(runnerReadingFor(run.task, run.runtimeDir).runner).toBe('atta-engine')
  const continuation = resumeContinuation(
    { issue: run.task, branch: `task/issue-${run.task}`, pr: run.pr, agent: run.agent },
    readTaskRunner(run.task, run.runtimeDir),
    'vinaya'
  )
  expect(continuation.command).toBe('bun')
  expect(continuation.argv[0]).toBe(engineRunnerScriptPath())
}

/** A start on the standalone runner over the Engine's held pause: refused, typed, with today's text. */
async function refusedOnStandalone(run: InFlightEngineRun): Promise<void> {
  let starts = 0
  const refusal = await runTask(
    { issue: run.task, agent: run.agent },
    fixtureDeps(run.task, {
      hasPauseState: (issue) => readPauseState(run.runtimeDir, issue) !== null,
      crossRunnerRefusalReason: (issue, runner) => crossRunnerRefusalReason(issue, runner, run.runtimeDir),
      devReviewLoop: async () => {
        starts += 1
        return { task: run.task, prNumber: run.pr, finalDecision: { type: 'publish' } }
      }
    })
  ).catch((error: unknown) => error)
  expect(refusal).toBeInstanceOf(CrossRunnerRefusedError)
  const typed = refusal as CrossRunnerRefusedError
  expect(typed.reason).toEqual({
    code: 'recorded_on_another_runner',
    task: run.task,
    recorded: 'atta-engine',
    requested: 'standalone'
  })
  expect(typed.message).toBe(
    `runTask: task ${run.task}'s paused run was recorded on the atta-engine runner, and the standalone runner never continues another runner's run — resume it on atta-engine.`
  )
  expect(starts).toBe(0)
}

describe('cutover-gate:gate-13 — backend selection and rollback on the Engine backend', () => {
  for (const agent of AGENTS) {
    for (const kind of IN_FLIGHT_KINDS) {
      it(`${kind} (${agent}): continued on the Engine after the switch, it reaches its no-switch terminal state`, async () => {
        const expected = await baseline(kind, agent)
        expect(expected.decision).toBe('publish')
        const continued = await runInFlightEngineRun(kind, agent, async (run) => {
          await switchRunner(run)
          if (PAUSED.includes(kind)) await refusedOnStandalone(run)
          await run.continueOnEngine()
        })
        expect(terminal(continued)).toEqual(terminal(expected))
      }, 120_000)

      it(`${kind} (${agent}): terminated and restarted on standalone, from the reconciled state, with no effect duplicated or lost`, async () => {
        let engineLedger: Record<string, unknown>[] = []
        let restartedPosted: string[] = []
        const seen: { atRestart?: { runner: string; liveLock: boolean; openEffects: string[] } } = {}
        let records: RollbackRehearsalRecord[] = []
        await runInFlightEngineRun(kind, agent, async (run) => {
          await switchRunner(run)
          const world = { ...makeWorld({ task: run.task, prNumber: run.pr }), runtimeDir: run.runtimeDir }
          const result = await runTask(
            { issue: run.task, agent, rollback: true },
            fixtureDeps(run.task, {
              recordRunner: (issue, runner) => recordTaskRunner(issue, runner, run.runtimeDir),
              devReviewLoop: async (input) => {
                // The restart begins only once the Engine run has ended and every effect is reconciled.
                const lock = readDriverLock(run.runtimeDir, run.task)
                const publication = readEffect(run.controlStore, run.task, PUBLICATION_EFFECT_KEY)
                seen.atRestart = {
                  runner: readTaskRunner(run.task, run.runtimeDir),
                  liveLock: lock !== null && isDriverPidAlive(lock.pid),
                  openEffects: publication.status === 'ok' ? [publication.value.status] : []
                }
                expect(input).toEqual({ task: run.task, agent })
                return (await runLoopInProcess(world, input)) as Awaited<ReturnType<RunTaskDeps['devReviewLoop']>>
              },
              backendRollback: (issue, wiring) =>
                terminateAndRestart(issue, {
                  runtimeDir: run.runtimeDir,
                  controlStore: run.controlStore,
                  readRunner: (task) => readTaskRunner(task, run.runtimeDir),
                  endEngineRun: endEngineRunThrough(run.cancel, run.runtimeDir, run.controlStore),
                  reconcile: run.reconcile,
                  ...wiring
                })
            })
          )
          expect(result.finalDecision?.type).toBe('publish')
          engineLedger = run.ledger()
          restartedPosted = world.postedComments.map((comment) => comment.marker)
          records = readRollbackRehearsals(run.task, run.runtimeDir)
        })

        expect(seen.atRestart).toEqual({
          runner: 'standalone',
          liveLock: false,
          // The uncertain publication was found absent on the forge: started again, for the restart to complete.
          openEffects: kind === 'uncertain-effect' ? ['started'] : []
        })
        // The rehearsal record: task, recorded runner, action, reconciled identities, the restart's runner and end.
        expect(records).toHaveLength(1)
        const [record] = records as [RollbackRehearsalRecord]
        expect(record).toMatchObject({
          schemaVersion: 1,
          task: 9001,
          recordedRunner: 'atta-engine',
          action: PAUSED.includes(kind) ? 'cancelled' : 'halted',
          restarted: { runner: 'standalone', terminalState: 'publish' },
          refusal: null
        })
        expect(record.reconciledEffects).toEqual(
          kind === 'uncertain-effect'
            ? [
                {
                  key: PUBLICATION_EFFECT_KEY,
                  identity: expect.objectContaining({ operation: 'pr-comment', target: 'pr:123', inputVersion: 1 }),
                  found: 'uncertain',
                  outcome: 'absent'
                }
              ]
            : []
        )
        expect(record.fencedEffectKeys).toEqual(kind === 'uncertain-effect' ? [PUBLICATION_EFFECT_KEY] : [])

        // The ledger across both runs: the round is published exactly once, by the restart; no pause comment repeats.
        const engineMarkers = engineLedger.filter((effect) => effect.kind === 'comment').map((e) => String(e.marker))
        const markers = [...engineMarkers, ...restartedPosted]
        expect(engineLedger.filter((effect) => effect.kind === 'published')).toEqual([])
        for (const marker of PUBLICATION_MARKERS) expect(markers.filter((m) => m === marker)).toHaveLength(1)
        const pauseMarkers = markers.filter((marker) => marker.includes('aeg:loop:paused'))
        expect(new Set(pauseMarkers).size).toBe(pauseMarkers.length)
        expect(restartedPosted.filter((marker) => marker.includes('aeg:loop:paused'))).toEqual([])
        // Nothing the continued run performs is missing: each effect it carries is on the restarted ledger too.
        const expected = await baseline(kind, agent)
        for (const marker of expected.effects.markers) expect(markers).toContain(marker)
      }, 120_000)
    }
  }
})

describe('cutover-gate:gate-13 — the live L6 rehearsal record', () => {
  const rehearsed = process.env.VINAYA_ROLLBACK_REHEARSAL
  it.skipIf(rehearsed === undefined)(
    'keeps the rehearsal record of a live terminate-and-restart, its restarted run on standalone',
    () => {
      const task = Number(rehearsed)
      const records = readRollbackRehearsals(task, runtimeDirForThisRepo())
      console.log(`rollback rehearsal record for task ${task}: ${JSON.stringify(records.at(-1) ?? null)}`)
      expect(records.at(-1)).toMatchObject({
        task,
        recordedRunner: 'atta-engine',
        refusal: null,
        restarted: { runner: 'standalone' }
      })
      expect(readTaskRunner(task, runtimeDirForThisRepo())).toBe('standalone')
    }
  )
})
