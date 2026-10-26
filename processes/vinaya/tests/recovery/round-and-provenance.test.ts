import { afterAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  type ControlStoreDeps,
  DEFAULT_REVIEW_POLICY,
  defaultControlStoreDeps,
  type EffectRecord,
  initialLoopState,
  readEffects,
  readExecutionRoundMirror,
  writeExecutionRoundMirror
} from '@attalabs/aeg-core'
import { createRunControl, type RunControl, type SpawnedProcessLike } from '@atta/executor-agent-spawn'
import { authenticateWorkerInvocation, requestEffect, scopeTarget } from '../../../../apps/cli/src/lib/broker'
import { loopHistoryFromComments } from '../../../../apps/cli/src/lib/dev-review-loop/journal-history'
import { clearDriverLock } from '../../../../apps/cli/src/lib/dev-review-loop/pause-resume'
import { controlStoreRootFor } from '../../../../apps/cli/src/lib/dev-review-loop/reviewer-dispatch'
import type { DispatchTeeRecoveryDeps } from '../../../../apps/cli/src/lib/dispatch'
import {
  encodeExecutionRound,
  readAgentProvenance,
  readEffectiveResumedState,
  readExecutionRound
} from '../../../../harness/dev-process/engine-runtime/checkpoint-round'
import type { ActionRegistry, ProcessAction } from '../../../../harness/dev-process/engine-runtime/run-process'
import { SqliteCheckpointer } from '../../../../harness/dev-process/engine-runtime/sqlite-checkpointer'
import { loadProcess } from '../../../../harness/dev-process/loader/load-process'
import { V2_ACTION_BINDINGS } from '../../loops/dev-review/v2/v2-actions'
import { checkpointPath, runDirectory, runEngine } from '../../bin/run-engine'
import { restoreExecutionRound, runIdentityOfTask, type RecoveryDeps } from '../../bin/run-lifecycle'
import {
  ACTION_BINDINGS,
  classifyGateResult,
  createActions,
  dispatchReviewers,
  type TaskInput
} from '../../executing/actions'
import { recordedHandoff } from '../handoff-fakes'
import { ENGINE_RUNNERS, type RecoveryRunner } from './runners'

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
const TASK = 7
const BRANCH = 'task/issue-7'
const DECISIONS: Record<number, 'revise' | 'publish'> = { 1: 'revise', 2: 'revise', 3: 'publish' }

// A stub login keeps the real role launcher from copying an operator's Codex credential into a test run.
const scratch: string[] = []
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

interface Interrupt {
  round: number
  at: InterruptPoint
}

/** What every leg of one run shares: the remote, the review-dispatch markers, and what each step did per round. */
interface World {
  runtimeDir: string
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
}

function createWorld(): World {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'round-recovery-'))
  scratch.push(runtimeDir)
  return {
    runtimeDir,
    store: defaultControlStoreDeps(() => controlStoreRootFor(runtimeDir)),
    head: null,
    commits: 0,
    reviewedSinceCommit: true,
    remote: new Set(),
    remoteWrites: [],
    refusals: [],
    markers: [],
    handoffs: [],
    published: []
  }
}

/** A child that reports `lines` and closes, or one that never closes until it is killed. */
function stubAgent(lines: string[], hang = false): SpawnedProcessLike {
  const closeListeners: Array<(code: number | null) => void> = []
  let stdout: ((chunk: string) => void) | undefined
  return {
    stdin: {
      write: () => {},
      end: () => {
        if (hang) return
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
      setTimeout(() => {
        for (const listener of closeListeners) listener(null)
      }, 0)
    }
  } as SpawnedProcessLike
}

/** The role a Claude launch is for: it names its role's generated settings. */
const roleOfLaunch = (args: string[]): string => (args[args.indexOf('--settings') + 1] ?? '').split('/').at(-2) ?? ''

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
    readLaunch: () => ({ status: 'absent' }) as never,
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
async function leg(runner: RecoveryRunner, world: World, interrupt?: Interrupt) {
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
      createTaskWorktree: () => {}
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
  const result = await runEngine({
    args: { task: TASK, agent: 'claude', dryRun: false },
    process: loaded,
    repoRoot: REPO_ROOT,
    runtimeDir: world.runtimeDir,
    loopId: 'round-recovery',
    taskInput: task,
    handoffDeps: recordedHandoff().deps,
    actions,
    sink: { log: () => {}, drain: async () => {} },
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
    spawnFn: (_command, args) => {
      const role = roleOfLaunch(args)
      if (role === 'developer') return stubAgent(['{"type":"result"}'], developerTurn())
      world.reviewedSinceCommit = true
      return stubAgent(['{"type":"result"}'])
    }
  })
  return { result, stopped, round: () => round, lines }
}

const threadOf = (generation = 1) => runIdentityOfTask(TASK, generation).threadId
const checkpointFile = (world: World) => checkpointPath(runDirectory(world.runtimeDir, TASK))

/** What every resumed run must show: it published round 3 once, each round ended once, nothing refused or repeated. */
async function expectCleanRun(world: World): Promise<void> {
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

describe.each(ENGINE_RUNNERS)('%s', (runner) => {
  test('an uninterrupted run publishes round 3 with every round ended once', async () => {
    const world = createWorld()
    const run = await leg(runner, world)
    expect(run.result.exitCode).toBe(0)
    await expectCleanRun(world)
  })

  const points: Interrupt[] = [
    { round: 2, at: 'developer-turn-before-handoff' },
    { round: 2, at: 'after-handoff' },
    { round: 2, at: 'push-before-acknowledgement' },
    { round: 3, at: 'after-round-marker' }
  ]
  for (const interrupt of points)
    test(`a driver restart ${interrupt.at} in round ${interrupt.round} resumes with no replayed input version`, async () => {
      const world = createWorld()
      const first = await leg(runner, world, interrupt)
      expect(first.stopped).toBe(true)
      expect(first.result.exitCode).toBe(2)
      const second = await leg(runner, world)
      expect(second.result.exitCode).toBe(0)
      await expectCleanRun(world)
    })

  test('a crash between each pair of persistence writes leaves no double increment and no repeated effect', async () => {
    // Checkpoint commit, then mirror write: the mirror cannot be written, so the run stops before its next step.
    const blocked = createWorld()
    const mirrorDir = join(controlStoreRootFor(blocked.runtimeDir), String(TASK), 'control')
    mkdirSync(mirrorDir, { recursive: true })
    writeFileSync(join(mirrorDir, 'execution-round'), 'not a folder')
    const failed = await leg(runner, blocked)
    expect(failed.result.exitCode).not.toBe(0)
    // Round 1 recorded at prepare-run could not be mirrored: nothing past it was dispatched.
    expect(blocked.remoteWrites).toEqual([])
    rmSync(join(mirrorDir, 'execution-round'))
    // The failed driver's lock names a process that, restarted for real, would be dead.
    clearDriverLock(blocked.runtimeDir, TASK)
    expect((await leg(runner, blocked)).result.exitCode).toBe(0)
    await expectCleanRun(blocked)

    // Mirror write, then effect record: the driver dies after the round moved and was mirrored, before the next push.
    const beforeEffect = createWorld()
    expect((await leg(runner, beforeEffect, { round: 2, at: 'developer-turn-before-push' })).stopped).toBe(true)
    const mirrored = readExecutionRoundMirror(beforeEffect.store, TASK, threadOf())
    expect(mirrored.status === 'ok' && mirrored.value.round).toBe(2)
    expect((await leg(runner, beforeEffect)).result.exitCode).toBe(0)
    await expectCleanRun(beforeEffect)

    // Effect record, then its acknowledgement: covered by the push interruption above; here the mirror is also
    // stale (ahead of the checkpoint), and the checkpoint wins.
    const stale = createWorld()
    expect((await leg(runner, stale, { round: 2, at: 'push-before-acknowledgement' })).stopped).toBe(true)
    const recorded = readExecutionRoundMirror(stale.store, TASK, threadOf())
    if (recorded.status !== 'ok') throw new Error('no mirror after the first leg')
    writeExecutionRoundMirror(stale.store, TASK, { ...recorded.value, round: 1, checkpointId: 'stale' })
    expect((await leg(runner, stale)).result.exitCode).toBe(0)
    await expectCleanRun(stale)
  })

  test('a crash after pending writes and before the next full checkpoint resumes at the right round', async () => {
    const world = createWorld()
    expect((await leg(runner, world, { round: 2, at: 'after-handoff' })).stopped).toBe(true)
    // The round-ending step's writes are stored under the checkpoint before it; drop every full checkpoint saved
    // after that, as a driver killed before its next (non-blocking) save would have left the file.
    const db = new Database(checkpointFile(world))
    const handoffCheckpoint = db
      .query<{ checkpoint_id: string }, [string]>(
        `SELECT checkpoint_id FROM writes WHERE thread_id = ? AND channel = 'results'
         ORDER BY checkpoint_id DESC LIMIT 1`
      )
      .get(threadOf())
    if (handoffCheckpoint === null) throw new Error('no stored step writes')
    db.query('DELETE FROM checkpoints WHERE thread_id = ? AND checkpoint_id > ?').run(
      threadOf(),
      handoffCheckpoint.checkpoint_id
    )
    db.close()
    const state = await readEffectiveResumedState(checkpointFile(world), threadOf())
    expect(readExecutionRound(state)?.round).toBe(3)
    expect((await leg(runner, world)).result.exitCode).toBe(0)
    await expectCleanRun(world)
  })

  test('the agent the run started with is recorded in its checkpoint provenance and read back', async () => {
    const world = createWorld()
    await leg(runner, world, { round: 1, at: 'after-handoff' })
    expect(readAgentProvenance(checkpointFile(world), threadOf())?.agent).toBe('claude')
  })

  test('a checkpoint written before the agent was recorded reads agent null', async () => {
    const world = createWorld()
    await leg(runner, world, { round: 1, at: 'after-handoff' })
    const db = new Database(checkpointFile(world))
    db.query('UPDATE checkpoints SET agent = NULL').run()
    db.close()
    expect(readAgentProvenance(checkpointFile(world), threadOf())?.agent).toBeNull()
  })

  // The refusal of these resumes is the Engine dispatch path's, built on `readAgentProvenance` above.
  test.todo('a resume with a different agent is refused and changes nothing')
  test.todo('a checkpoint with no recorded agent is refused with a fresh-start instruction')
})

describe('restoring the execution round before dispatch', () => {
  const mechanical = (round: number) => ({
    nodeId: 'build-revision-handoff',
    kind: 'mechanical' as const,
    action: 'vinaya.build-revision-handoff',
    command: 'in-process',
    exitCode: 0,
    stdout: '',
    stderr: encodeExecutionRound({ round, advancedBy: 'build-revision-handoff' }),
    durationMs: 0
  })
  const resumed = (round: number) => ({
    checkpointId: 'cp-2',
    results: { 'build-revision-handoff': mechanical(round) }
  })
  const effect = (inputVersion: number, status: EffectRecord['status']) => ({
    status: 'ok' as const,
    value: {
      version: 1 as const,
      kind: 'effect' as const,
      task: TASK,
      key: `branch-push-${inputVersion}`,
      operation: 'branch-push',
      target: 't',
      inputVersion,
      payloadDigest: 'd',
      status,
      recordedAt: 'now'
    }
  })
  const mirror = (round: number, checkpointId = 'cp-2') => ({
    status: 'ok' as const,
    value: {
      version: 1 as const,
      kind: 'execution_round' as const,
      task: TASK,
      repository: 'o/r',
      threadId: 'thread',
      checkpointId,
      round,
      recordedAt: 'now'
    }
  })

  test('the checkpoint round wins over a disagreeing mirror, which is rewritten', () => {
    const restore = restoreExecutionRound({
      threadId: 'thread',
      resumed: resumed(3),
      mirror: mirror(5),
      effects: []
    })
    expect(restore).toMatchObject({ kind: 'restored', round: 3, rewriteMirror: true })
    if (restore.kind === 'restored') expect(restore.note).toContain('checkpoint holds round 3')
  })

  test('an agreeing mirror at the same checkpoint is left as it is', () => {
    expect(
      restoreExecutionRound({ threadId: 'thread', resumed: resumed(3), mirror: mirror(3), effects: [] })
    ).toMatchObject({ kind: 'restored', rewriteMirror: false, note: null })
  })

  test('an effect issued at a later input version refuses the resume', () => {
    const restore = restoreExecutionRound({
      threadId: 'thread',
      resumed: resumed(2),
      mirror: { status: 'absent' },
      effects: [effect(3, 'verified')]
    })
    expect(restore.kind).toBe('refused')
  })

  test('an unacknowledged effect is handed back with the input version it was issued with', () => {
    const restore = restoreExecutionRound({
      threadId: 'thread',
      resumed: resumed(3),
      mirror: { status: 'absent' },
      effects: [effect(2, 'started'), effect(3, 'verified'), { status: 'corrupt', reason: 'torn' }]
    })
    expect(restore.kind === 'restored' && restore.interrupted).toEqual([
      { key: 'branch-push-2', operation: 'branch-push', inputVersion: 2 }
    ])
  })

  test('a thread with no recorded round is left to the start-of-run rules', () => {
    expect(
      restoreExecutionRound({
        threadId: 'thread',
        resumed: { checkpointId: 'c', results: {} },
        mirror: { status: 'absent' },
        effects: []
      })
    ).toEqual({ kind: 'unrecorded' })
    expect(
      restoreExecutionRound({ threadId: 'thread', resumed: null, mirror: { status: 'absent' }, effects: [] })
    ).toEqual({ kind: 'unrecorded' })
  })

  test('a fresh saver records the agent it is given', () => {
    const dir = mkdtempSync(join(tmpdir(), 'round-recovery-saver-'))
    scratch.push(dir)
    const saver = new SqliteCheckpointer({ path: join(dir, 'c.sqlite'), revision: 'r', agent: 'codex' })
    expect(saver.latestAgent('none')).toBeUndefined()
    saver.close()
  })
})
