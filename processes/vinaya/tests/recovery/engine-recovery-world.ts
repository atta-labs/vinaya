import { afterAll, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  type ControlStoreDeps,
  DEFAULT_REVIEW_POLICY,
  defaultControlStoreDeps,
  initialLoopState,
  readEffects,
  readExecutionRoundMirror
} from '@attalabs/aeg-core'
import { createRunControl, type RunControl, type SpawnedProcessLike } from '@atta/executor-agent-spawn'
import { authenticateWorkerInvocation, requestEffect, scopeTarget } from '../../../../apps/cli/src/lib/broker'
import { loopHistoryFromComments } from '../../../../apps/cli/src/lib/dev-review-loop/journal-history'
import { controlStoreRootFor } from '../../../../apps/cli/src/lib/dev-review-loop/reviewer-dispatch'
import type { DispatchTeeRecoveryDeps, ParsedLaunch } from '../../../../apps/cli/src/lib/dispatch'
import {
  readEffectiveResumedState,
  readExecutionRound
} from '../../../../harness/dev-process/engine-runtime/checkpoint-round'
import type { ActionRegistry, ProcessAction } from '../../../../harness/dev-process/engine-runtime/run-process'
import { loadProcess } from '../../../../harness/dev-process/loader/load-process'
import { V2_ACTION_BINDINGS } from '../../loops/dev-review/v2/v2-actions'
import { checkpointPath, runDirectory, runEngine } from '../../bin/run-engine'
import { runIdentityOfTask, type RecoveryDeps } from '../../bin/run-lifecycle'
import {
  ACTION_BINDINGS,
  classifyGateResult,
  createActions,
  dispatchReviewers,
  type TaskInput
} from '../../executing/actions'
import { recordedHandoff } from '../handoff-fakes'
import type { RecoveryRunner } from './runners'

// The execution round as checkpoint authority, and the agent in checkpoint provenance.
//
// Each leg below is one driver process: a fresh task input whose in-memory round starts at 1, the real runner, the
// real prepare-run and round-ending steps, and a Developer whose push goes through the real broker at the round the
// driver presents. A leg is stopped at an interruption point, and the next leg (a restarted driver) continues the same
// world. The run is scripted to revise in rounds 1 and 2 and publish in round 3, so a round restored wrong shows as a
// refused push, a repeated push, an extra round or a publication of the wrong round.

const PROCESS_ROOT = resolve(import.meta.dir, '../..')
const PROCESSES: Record<RecoveryRunner, ReturnType<typeof loadProcess> | null> = {
  standalone: null,
  'engine-v1': loadProcess(PROCESS_ROOT),
  'engine-v2': loadProcess(PROCESS_ROOT, { flow: 'v2' })
}
const REPO_ROOT = resolve(import.meta.dir, '../../../..')
export const TASK = 7
const BRANCH = 'task/issue-7'
const DECISIONS: Record<number, 'revise' | 'publish'> = { 1: 'revise', 2: 'revise', 3: 'publish' }

// A stub login keeps the real role launcher from copying an operator's Codex credential into a test run.
export const scratch: string[] = []
const stubHome = mkdtempSync(join(tmpdir(), 'round-recovery-codex-home-'))
scratch.push(stubHome)
writeFileSync(join(stubHome, 'auth.json'), '{}\n')
process.env.CODEX_HOME = stubHome
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

/** Where a leg stops: the driver dies there, and the next leg is the restarted driver. */
type InterruptPoint =
  /** The Developer's turn pushed and was acknowledged; the driver dies before the turn ends and the handoff runs. */
  | 'developer-turn-before-handoff'
  /** The round-ending step completed and recorded the next round; the driver dies before the next step. */
  | 'after-handoff'
  /** The Developer's push reached the remote; the driver dies before the push's acknowledgement is recorded. */
  | 'push-before-acknowledgement'
  /** The round's review-dispatch marker is posted; the driver dies before the reviewers launch. */
  | 'after-round-marker'
  /** The Developer's turn starts; the driver dies before it pushes anything. */
  | 'developer-turn-before-push'

export interface Interrupt {
  round: number
  at: InterruptPoint
}

/** What every leg of one run shares: the remote, the review-dispatch markers, and what each step did per round. */
export interface World {
  runtimeDir: string
  priorLaunch?: ParsedLaunch
  launches: Array<{ role: string; args: string[] }>
  store: ControlStoreDeps
  /** The commits the Developer made, each a sha; a turn re-run before any review pushes the same head again. */
  head: string | null
  commits: number
  reviewedSinceCommit: boolean
  remote: Set<string>
  /** Every write that reached the remote, by sha: a repeated effect shows as a sha written twice. */
  remoteWrites: string[]
  /** Every push refusal or failure the Developer met. */
  refusals: string[]
  /** The rounds a review-dispatch marker was posted for, as the forge journal holds them. */
  markers: number[]
  /** Each round-ending step's run, by the round it ran in. */
  handoffs: number[]
  published: number[]
  /** The agent every launch runs under. */
  agent: 'claude' | 'codex'
  /** What each role's launch prints before it closes; a role not named prints a bare result line. */
  agentOutput: Partial<Record<string, string[]>>
  /** Each launch's tokens as the runner recorded them on the task input, by role, in launch order. */
  recordedUsage: Array<{ role: string; usage: { input: number; output: number } | null }>
}

export function createWorld(
  options: { agent?: 'claude' | 'codex'; agentOutput?: Partial<Record<string, string[]>> } = {}
): World {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'round-recovery-'))
  scratch.push(runtimeDir)
  return {
    runtimeDir,
    launches: [],
    store: defaultControlStoreDeps(() => controlStoreRootFor(runtimeDir)),
    head: null,
    commits: 0,
    reviewedSinceCommit: true,
    remote: new Set(),
    remoteWrites: [],
    refusals: [],
    markers: [],
    handoffs: [],
    published: [],
    agent: options.agent ?? 'claude',
    agentOutput: options.agentOutput ?? {},
    recordedUsage: []
  }
}

/** A child that reports `lines` and closes, or one that never closes until it is killed. */
function stubAgent(lines: string[], hang = false): SpawnedProcessLike {
  const closeListeners: Array<(code: number | null) => void> = []
  const stdout: Array<(chunk: string) => void> = []
  return {
    stdin: {
      write: () => {},
      end: () => {
        if (hang) return
        setTimeout(() => {
          for (const line of lines) for (const listener of stdout) listener(`${line}\n`)
          for (const listener of closeListeners) listener(0)
        }, 0)
      }
    },
    stdout: { on: (_event, listener) => void stdout.push(listener as (chunk: string) => void) },
    stderr: { on: () => {} },
    on: ((event: string, listener: (code: number | null) => void) => {
      if (event === 'close') closeListeners.push(listener)
    }) as SpawnedProcessLike['on'],
    kill: () => {
      setTimeout(() => {
        for (const listener of closeListeners) listener(null)
      }, 0)
    }
  } as SpawnedProcessLike
}

/** The role a Claude launch is for: it names its role's generated settings. */
const roleOfLaunch = (args: string[], env?: Readonly<Record<string, string | undefined>>): string =>
  (env?.CODEX_HOME ?? (args[args.indexOf('--settings') + 1] ?? '').split('/').slice(0, -1).join('/'))
    .split('/')
    .at(-1) ?? ''

/** A Developer authenticated as the broker authenticates one: against the launch record its controller wrote. */
const RUN_ID = 'round-recovery-run'
const LAUNCH_DEPS: DispatchTeeRecoveryDeps = {
  env: {},
  listLaunchRecordPaths: () => ['launch-0.json'],
  readFile: () => JSON.stringify({ runId: RUN_ID, role: 'developer', agent: 'claude', task: TASK })
} as DispatchTeeRecoveryDeps
const developer = authenticateWorkerInvocation(
  { VINAYA_ROLE: 'developer', VINAYA_TASK: String(TASK), VINAYA_RUN_ID: RUN_ID },
  LAUNCH_DEPS,
  () => {}
)

/** The forge journal: one review-dispatch marker per round the reviewers were dispatched in. */
function recovery(world: World, loopState: () => TaskInput['loopState']): RecoveryDeps {
  return {
    prNumber: () => 31,
    fetchLoopHistory: () =>
      loopHistoryFromComments(
        world.markers.map((round) => ({ body: `<!-- aeg:developer:round-${round} -->\nHead: h${round}`, author: 'p' })),
        ['p'],
        () => 'unknown'
      ),
    loopState,
    readLaunch: () => world.priorLaunch ?? { status: 'absent' },
    launchDeps: {
      isPidAlive: () => false,
      hostname: () => hostname(),
      getProcessSnapshot: () => null,
      terminateChild: () => {}
    },
    heldVerdict: () => null,
    currentManifest: () => null
  }
}

/** One driver process over `world`, stopped at `interrupt` when given. */
export async function leg(runner: RecoveryRunner, world: World, interrupt?: Interrupt) {
  const loaded = PROCESSES[runner]
  if (loaded === null) throw new Error(`${runner} has no Engine process`)
  const control: RunControl = createRunControl()
  let stopped = false
  // Inside an agent launch the halt lands once the launch is under way, as a kill of a running driver would.
  const stopHere = (round: number, at: InterruptPoint, inLaunch = false): boolean => {
    if (stopped || interrupt === undefined || interrupt.round !== round || interrupt.at !== at) return false
    stopped = true
    if (inLaunch) setTimeout(() => control.halt('the driver died'), 0)
    else control.halt('the driver died')
    return true
  }
  // The driver's own in-memory round, as the live task input keeps it: it starts at 1 in every process.
  let round = 1
  const task = {
    runtimeDir: world.runtimeDir,
    issueNumber: TASK,
    branch: BRANCH,
    worktreePath: join(world.runtimeDir, 'worktree'),
    loopState: initialLoopState({ loopId: 'l', task: TASK, reviewers: [], models: {}, maxRounds: 5 } as never),
    reviewPolicy: () => DEFAULT_REVIEW_POLICY,
    reviewRound: () => round,
    recordUsage: (role: string, usage: { input: number; output: number } | null) => {
      world.recordedUsage.push({ role, usage })
    },
    seedRound: (next: number) => {
      round = Math.max(round, next)
    },
    verdicts: () => {
      round += 1
      return []
    },
    bound: {
      cleanupAllReviewerIsolationArtifacts: () => {},
      localGateControl: () => ({ control: 'local-gate', active: true, detail: '', remedy: '' }),
      checkTaskDispatchReadiness: () => ({ ready: true, output: 'ready' }),
      createTaskWorktree: () => {},
      // The real probe runs the vendor's sandbox only on Linux, so an unfaked one passes elsewhere and pauses here.
      probeAgentSandbox: async () => ({ ok: true })
    }
  } as unknown as TaskInput
  const real = createActions(task)
  const names = [...Object.keys(ACTION_BINDINGS), ...Object.keys(V2_ACTION_BINDINGS)]
  const scripted: Record<string, ProcessAction> = {
    'vinaya.prepare-run': real['vinaya.prepare-run'] as ProcessAction,
    'vinaya.classify-gate-result': classifyGateResult,
    'vinaya.dispatch-reviewers': () => {
      if (!world.markers.includes(round)) world.markers.push(round)
      stopHere(round, 'after-round-marker')
      return dispatchReviewers()
    },
    'vinaya.assess-round': () => {
      const decision = DECISIONS[round] ?? 'publish'
      return { exitCode: decision === 'revise' ? 1 : 0, stdout: JSON.stringify({ decision: { type: decision } }) }
    },
    'vinaya.build-revision-handoff': async (context) => {
      const ending = round
      world.handoffs.push(ending)
      const result = await (real['vinaya.build-revision-handoff'] as ProcessAction)(context)
      stopHere(ending, 'after-handoff')
      return result
    },
    'harness.publish': () => {
      world.published.push(round)
      return { exitCode: 0 }
    }
  }
  const actions: ActionRegistry = Object.fromEntries(
    names.map((name) => [name, scripted[name] ?? (() => ({ exitCode: 0 }))])
  )
  /** The Developer's turn: a new commit unless its head is not yet reviewed, then a push of the head at the round. */
  const developerTurn = (): boolean => {
    if (stopHere(round, 'developer-turn-before-push', true)) return true
    if (world.reviewedSinceCommit || world.head === null) {
      world.commits += 1
      world.head = `sha-${world.commits}`
      world.reviewedSinceCommit = false
    }
    const sha = world.head
    let died = false
    try {
      requestEffect(
        world.store,
        developer,
        {
          operation: 'branch-push',
          target: scopeTarget(TASK, `refs/heads/${BRANCH}`),
          inputVersion: round,
          key: `branch-push-${sha}`,
          payload: sha,
          poster: () => {
            world.remoteWrites.push(sha)
            world.remote.add(sha)
            if (stopHere(round, 'push-before-acknowledgement', true)) {
              died = true
              throw new Error('the driver died before the push was acknowledged')
            }
            return sha
          },
          reconcile: () => (world.remote.has(sha) ? { outcome: 'confirmed', url: sha } : { outcome: 'absent' })
        },
        () => {}
      )
    } catch (error) {
      if (!died) world.refusals.push(error instanceof Error ? error.message : String(error))
    }
    return died || stopHere(round, 'developer-turn-before-handoff', true)
  }
  const lines: string[] = []
  const events: Array<Record<string, unknown>> = []
  const result = await runEngine({
    args: { task: TASK, agent: world.agent, dryRun: false },
    process: loaded,
    repoRoot: REPO_ROOT,
    runtimeDir: world.runtimeDir,
    loopId: 'round-recovery',
    taskInput: task,
    handoffDeps: recordedHandoff().deps,
    actions,
    sink: {
      log: (event) => {
        events.push(event as unknown as Record<string, unknown>)
      },
      drain: async () => {}
    },
    startHost: async () => ({ close: async () => {} }),
    devToolsContext: {} as never,
    control,
    out: (line) => void lines.push(line),
    revision: 'rev-a',
    heldPullRequestConflicts: async () => false,
    lifecycle: {
      killGraceMs: 200,
      handleSignals: false,
      recovery: recovery(world, () => task.loopState),
      executionRound: { store: world.store, repository: 'owner/repo' }
    },
    spawnFn: (_command, args, spawnOptions) => {
      const role = roleOfLaunch(args, spawnOptions?.env)
      world.launches.push({ role, args: [...args] })
      const output = world.agentOutput[role] ?? ['{"type":"result"}']
      if (role === 'developer') return stubAgent(output, developerTurn())
      world.reviewedSinceCommit = true
      return stubAgent(output)
    }
  })
  return { result, stopped, round: () => round, lines, events }
}

export const threadOf = (generation = 1) => runIdentityOfTask(TASK, generation).threadId
export const checkpointFile = (world: World) => checkpointPath(runDirectory(world.runtimeDir, TASK))

/** What every resumed run must show: it published round 3 once, each round ended once, nothing refused or repeated. */
export async function expectCleanRun(world: World): Promise<void> {
  expect(world.refusals).toEqual([])
  expect(world.published).toEqual([3])
  expect(world.handoffs).toEqual([1, 2, 3])
  // Each head reached the remote once: an interrupted push was reconciled, never posted again.
  expect(world.remoteWrites).toEqual([...new Set(world.remoteWrites)])
  const state = await readEffectiveResumedState(checkpointFile(world), threadOf())
  expect(readExecutionRound(state)?.round).toBe(3)
  const mirror = readExecutionRoundMirror(world.store, TASK, threadOf())
  expect(mirror.status === 'ok' && mirror.value.round).toBe(3)
  // Every effect the run recorded is acknowledged.
  const effects = readEffects(world.store, TASK).flatMap((effect) => (effect.status === 'ok' ? [effect.value] : []))
  expect(effects.filter((effect) => effect.status !== 'verified')).toEqual([])
}
