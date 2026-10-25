import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type EscalationRecord,
  recordedBeyondSurfacePaths,
  renderBeyondSurfaceBlock,
  type ResolutionRecord
} from '@attalabs/aeg-core'
import { createRunControl } from '@atta/executor-agent-spawn'
import {
  isHostRepairPause,
  PAUSE_REASON_PROFILE,
  readDriverLock,
  readPauseState,
  ReplayedResolutionError
} from '../../../apps/cli/src/lib/dev-review-loop/pause-resume'
import {
  isUsageLimitPauseDetail,
  MAX_AUTOMATIC_RATE_LIMIT_RESUMES,
  usageLimitResetFromDetail,
  usageLimitWaitMs
} from '../../../apps/cli/src/lib/dev-review-loop/round-assess'
import { loopLogPathFor } from '../../../apps/cli/src/lib/loop-log'
import {
  BRANCH,
  fakeDeps,
  makeWorld,
  OUTSIDE,
  OWN
} from '../../../apps/cli/tests/lib/task-tools/live-developer-context-world'
import { checkpointPath, engineLiveDevToolsContext, runDirectory } from '../bin/run-engine'
import { liveResumeDeps, type ResumeDeps, type RulingWatch } from '../bin/run-lifecycle'
import {
  blocked,
  createWorld,
  EFFECT_PHASES,
  type ForgeLedger,
  git,
  HELD_AT,
  LEG_ENDED,
  PUBLICATION_EFFECTS,
  readLedger,
  replay,
  type Scenario,
  TASK,
  type Vendor,
  type World
} from './replay-world'
import { keepLogLocal, SCENARIO_ENV_KEYS } from './round-fakes'

// The run-control and governed-effects rows of the evaluation program's fault-and-attack matrix, each proved on
// the Engine runner under the stub Claude Code vendor and the stub Codex vendor. A scenario injects its row's
// fault into the real runner — the replay world's recorded vendor streams, its fake forge and its ledger — and
// asserts the row's declared outcome; a scenario that fails names its row. The controller-death scenarios start
// the runner as a process of its own and kill it with a real signal at each boundary.

const ROWS = {
  controllerDeath: 'fault-attack:03-controller-process-death',
  usageLimit: 'fault-attack:07-provider-rate-or-usage-limit',
  versionIncompatible: 'fault-attack:08-version-incompatibility-on-resume',
  checkpointCorrupt: 'fault-attack:09-checkpoint-corruption',
  cancellationRace: 'fault-attack:10-cancellation-races',
  forgeLatency: 'fault-attack:12-forge-latency',
  duplicateDelivery: 'fault-attack:13-duplicate-delivery',
  lostAcknowledgement: 'fault-attack:14-remote-success-local-acknowledgement-lost',
  beyondSurface: 'fault-attack:19-forged-or-stale-beyond-surface-record'
} as const

const VENDORS: readonly Vendor[] = ['claude', 'codex']
const REPLAY_WORLD = join(import.meta.dir, 'replay-world.ts')
const LIFECYCLE_RUNNER = join(import.meta.dir, 'fixtures/run-lifecycle-runner.ts')

/** Runs `body` as the proof of `row`: a failed expectation fails naming the row. */
async function holds(row: string, body: () => Promise<void> | void): Promise<void> {
  try {
    await body()
  } catch (error) {
    throw new Error(`${row} does not hold: ${error instanceof Error ? error.message : String(error)}`)
  }
}

let codexHome: string | undefined
const savedEnv: Record<string, string | undefined> = {}
beforeAll(() => {
  // The operator's Codex login the runner copies into each Codex role's generated home.
  codexHome = process.env.CODEX_HOME
  const home = mkdtempSync(join(tmpdir(), 'fault-codex-home-'))
  writeFileSync(join(home, 'auth.json'), '{"tokens":"replay"}')
  process.env.CODEX_HOME = home
  for (const key of SCENARIO_ENV_KEYS) savedEnv[key] = process.env[key]
  keepLogLocal()
})
afterAll(() => {
  if (codexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = codexHome
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

// --- what the scenarios read -----------------------------------------------------------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
// Generous: a runner process starts slowly when the whole suite runs in parallel.
async function until(done: () => boolean, ms = 60_000): Promise<void> {
  for (let waited = 0; !done() && waited < ms; waited += 25) await sleep(25)
  if (!done()) throw new Error('timed out waiting')
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const groupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}

/** The publication comments the forge holds, by effect key. */
const commentKeys = (ledger: ForgeLedger): string[] => ledger.comments.map((comment) => comment.key)
/** Each of round `round`'s publication comments, exactly once. */
const eachCommentOnce = (round = 1): string[] => PUBLICATION_EFFECTS.map((effect) => `${round}-${effect}`)
const driverLog = (world: World): string => {
  const path = loopLogPathFor(null, TASK, world.runtimeDir)
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}
const checkpointFile = (world: World): string => checkpointPath(runDirectory(world.runtimeDir, TASK))
/**
 * The lifecycle of a later runner on the same world in this process: the lock an infrastructure pause keeps names
 * this process, which a later runner — another process in production — reads as no longer alive.
 */
const nextRunner = { isPidAlive: () => false, handleSignals: false }

/** A green leg halted at the gate step, so its checkpoint holds the Developer's turn and nothing after the gates. */
async function haltedAtGates(vendor: Vendor, extra: Partial<Scenario> = {}) {
  const control = createRunControl()
  const run = await replay({
    vendor,
    control,
    boundary: (name) => {
      if (name === 'node:run-mechanical-gates') control.halt('stop')
    },
    ...extra
  })
  expect(run.result.exitCode).toBe(2)
  return run
}

/** Rewrites every checkpoint row's recorded versions, as a checkpoint another runtime wrote would carry them. */
function recordVersions(world: World, formatVersion: number | null, runtimeVersion: string | null): void {
  const db = new Database(checkpointFile(world))
  db.query('UPDATE checkpoints SET format_version = ?, runtime_version = ?').run(formatVersion, runtimeVersion)
  db.close()
}

const checkpointRows = (world: World): Array<{ checkpoint_id: string; runtime_version: string | null }> => {
  const db = new Database(checkpointFile(world), { readonly: true })
  try {
    return db
      .query<{ checkpoint_id: string; runtime_version: string | null }, []>(
        'SELECT checkpoint_id, runtime_version FROM checkpoints ORDER BY checkpoint_id'
      )
      .all()
  } finally {
    db.close()
  }
}

/** A watch on fake forge reads: it records each claim and each sleep, and a scenario decides what each poll finds. */
function fakeWatch(onSleep: (ms: number, state: WatchState) => void = () => {}) {
  const state: WatchState = { claims: [], sleeps: [], rulingReads: 0, ordinal: 0, resolution: null, claimFails: null }
  const deps: ResumeDeps = {
    ...liveResumeDeps,
    crossRunnerRefusal: () => null,
    readEscalationRecord: () => ({ rulingOrdinal: 0 }) as EscalationRecord,
    readResolution: () => state.resolution,
    resolveEscalation: (_task, escalationId, _pr, decision, by, from) => {
      state.claims.push({ decision, by, from })
      if (state.claimFails) throw state.claimFails(escalationId)
      return { escalation: {} as EscalationRecord, resolution: { decision } as ResolutionRecord, epoch: 1 }
    },
    fetchNewestRulingOrdinal: () => {
      state.rulingReads += 1
      return state.ordinal
    },
    fetchNewestIssueRulingOrdinal: () => {
      state.rulingReads += 1
      return state.ordinal
    },
    fetchNewestRulingAuthor: () => (state.ordinal > 0 ? 'principal' : null),
    fetchNewestIssueRulingAuthor: () => (state.ordinal > 0 ? 'principal' : null)
  }
  const watch: RulingWatch = {
    deps,
    pollMs: 7,
    sleep: async (ms) => {
      state.sleeps.push(ms)
      onSleep(ms, state)
      // A watch that never ends on what its scenario arranged is cancelled rather than left spinning, so the
      // scenario fails on its outcome instead of hanging.
      if (state.sleeps.length >= WATCH_POLL_LIMIT) state.resolution = { decision: 'cancel' } as ResolutionRecord
      await sleep(0)
    }
  }
  return { watch, state }
}
const WATCH_POLL_LIMIT = 50
interface WatchState {
  claims: Array<{ decision: string; by: string; from: string }>
  sleeps: number[]
  rulingReads: number
  ordinal: number
  resolution: ResolutionRecord | null
  claimFails: ((escalationId: string) => Error) | null
}

// --- 03: controller process death, a real runner killed by signal --------------------------

interface LegExit {
  pid: number
  code: number | null
  signal: NodeJS.Signals | null
  output: string
  held: boolean
}

/** Runs one leg of `world` as a runner process of its own; with `holdAt`, kills it with SIGKILL once it is held there. */
async function legProcess(vendor: Vendor, world: World, holdAt?: string): Promise<LegExit> {
  const child = spawn(process.execPath, [REPLAY_WORLD, JSON.stringify({ vendor, world, holdAt })], {
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group, so what is left of it after the kill can be read.
    detached: true,
    env: { ...process.env }
  })
  let output = ''
  let held = false
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) =>
    child.on('close', (code, signal) => done({ code, signal }))
  )
  const reachedHold = new Promise<void>((done) => {
    child.stdout.on('data', (chunk) => {
      output += String(chunk)
      if (holdAt !== undefined && !held && output.includes(`${HELD_AT}${holdAt}\n`)) {
        held = true
        done()
      }
    })
  })
  child.stderr.on('data', (chunk) => {
    output += String(chunk)
  })
  if (holdAt !== undefined) {
    await Promise.race([reachedHold, exited])
    if (held) process.kill(child.pid as number, 'SIGKILL')
  }
  const { code, signal } = await exited
  return { pid: child.pid as number, code, signal, output, held }
}

/** Runs `items` through `run`, at most `width` at a time. */
async function inParallel<T, R>(items: readonly T[], width: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      while (next < items.length) {
        const at = next++
        results[at] = await run(items[at] as T)
      }
    })
  )
  return results
}

/** The steps a green round enters, in order, read off one green replay. */
async function greenSteps(vendor: Vendor): Promise<string[]> {
  const run = await replay({ vendor })
  expect(run.trace.outcome).toBe('completed')
  return [...new Set(run.ledger.nodeEvents.filter((e) => e.type === 'node:start').map((e) => e.nodeId))]
}

/**
 * Kills a runner at `boundary` and starts the next one on the same world. The restarted runner must finish the run
 * from the dead one's last checkpoint: every step of the green round completes exactly once across both, no step the
 * dead runner completed starts again, every agent launches once, every publication comment exists exactly once, and
 * nothing of the dead runner's process group is left.
 */
async function killAndRestart(vendor: Vendor, boundary: string, steps: readonly string[]): Promise<string[]> {
  const world = createWorld()
  const killed = await legProcess(vendor, world, boundary)
  const problems: string[] = []
  const fail = (what: string) => problems.push(`${boundary}: ${what}`)
  if (!killed.held) {
    fail(`the runner never reached the boundary (exit ${killed.code}): ${killed.output.slice(-400)}`)
    return problems
  }
  if (killed.signal !== 'SIGKILL') fail(`the runner ended by ${killed.signal ?? `exit ${killed.code}`}, not SIGKILL`)
  if (groupAlive(killed.pid)) fail('a process of the killed runner outlived it')
  const launchedBeforeKill = readLedger(world.runtimeDir).launches
  const restarted = await legProcess(vendor, world)
  const ended = restarted.output.split('\n').find((line) => line.startsWith(LEG_ENDED))
  if (ended !== `${LEG_ENDED}${JSON.stringify({ outcome: 'completed', exitCode: 0 })}`)
    fail(`the restarted runner did not complete the run: ${ended ?? restarted.output.slice(-400)}`)
  const ledger = readLedger(world.runtimeDir)
  const completedBy = (pid: number) =>
    ledger.nodeEvents.filter((e) => e.type === 'node:complete' && e.pid === pid).map((e) => e.nodeId)
  const startedAgain = ledger.nodeEvents
    .filter((e) => e.type === 'node:start' && e.pid === restarted.pid)
    .map((e) => e.nodeId)
    .filter((node) => completedBy(killed.pid).includes(node))
  if (startedAgain.length > 0) fail(`completed steps ran again after the restart: ${startedAgain.join(', ')}`)
  const completions = ledger.nodeEvents.filter((e) => e.type === 'node:complete').map((e) => e.nodeId)
  const repeated = steps.filter((step) => completions.filter((node) => node === step).length !== 1)
  if (repeated.length > 0) fail(`steps not completed exactly once across both runners: ${repeated.join(', ')}`)
  // An agent whose step completed is never launched again; one still running when its runner died is launched once
  // more, as the step it belongs to runs again.
  for (const step of ['develop', 'code-review', 'security-review'] as const) {
    const completedFirst = completedBy(killed.pid).includes(step)
    const allowed = completedFirst ? launchedBeforeKill[step] : launchedBeforeKill[step] === 0 ? 1 : 2
    if (ledger.launches[step] !== allowed)
      fail(`${step} launched ${ledger.launches[step]} times (${launchedBeforeKill[step]} before the kill)`)
  }
  const comments = commentKeys(ledger)
  if (JSON.stringify([...comments].sort()) !== JSON.stringify([...eachCommentOnce()].sort()))
    fail(`publication comments ${JSON.stringify(comments)}`)
  if (completedBy(killed.pid).length > 0 && !driverLog(world).includes('resuming the run from its checkpoint'))
    fail('the restarted runner did not resume from the checkpoint')
  return problems
}

/** A stand-in for a vendor CLI: it records its argv, starts a child of its own, and waits. */
function agentScript(dir: string): string {
  const path = join(dir, 'agent.sh')
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      'record="$1"; shift',
      'printf "%s\\n" "$@" > "$record"',
      'sleep 300 &',
      'echo $! > "$record.child"',
      'echo $$ > "$record.agent"',
      'wait',
      ''
    ].join('\n'),
    { mode: 0o755 }
  )
  return path
}
const pidIn = (file: string): number | null =>
  existsSync(file) && readFileSync(file, 'utf8').trim() !== '' ? Number(readFileSync(file, 'utf8').trim()) : null

/** Starts the lifecycle runner over real shell agents; resolves its exit once it is ended. */
function lifecycleRunner(vendor: Vendor, runtimeDir: string, script: string, record: string) {
  const runner = spawn(process.execPath, [LIFECYCLE_RUNNER, vendor, runtimeDir, script, record], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  runner.stdout.on('data', (chunk) => (output += String(chunk)))
  runner.stderr.on('data', (chunk) => (output += String(chunk)))
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) =>
    runner.on('close', (code, signal) => done({ code, signal }))
  )
  return { runner, exited, output: () => output }
}

for (const vendor of VENDORS)
  describe(`run control on the Engine runner, stub ${vendor} vendor`, () => {
    test(`${ROWS.controllerDeath} — a runner killed by SIGKILL at each checkpoint boundary restarts from its last checkpoint, repeating no completed step`, async () => {
      await holds(ROWS.controllerDeath, async () => {
        const steps = await greenSteps(vendor)
        expect(steps.length).toBeGreaterThanOrEqual(20)
        const problems = (await inParallel(steps, 4, (step) => killAndRestart(vendor, `node:${step}`, steps))).flat()
        console.log(`${ROWS.controllerDeath} (${vendor}): ${steps.length} checkpoint boundaries killed and restarted`)
        expect(problems).toEqual([])
      })
    }, 300_000)

    test(`${ROWS.controllerDeath} — a runner killed by SIGKILL at each publication effect boundary restarts and leaves each comment exactly once`, async () => {
      await holds(ROWS.controllerDeath, async () => {
        const steps = await greenSteps(vendor)
        const boundaries = PUBLICATION_EFFECTS.flatMap((effect) =>
          EFFECT_PHASES.map((phase) => `effect:1-${effect}:${phase}`)
        )
        const problems = (await inParallel(boundaries, 4, (b) => killAndRestart(vendor, b, steps))).flat()
        console.log(`${ROWS.controllerDeath} (${vendor}): ${boundaries.length} effect boundaries killed and restarted`)
        expect(problems).toEqual([])
      })
    }, 300_000)

    test(`${ROWS.controllerDeath} — the agents a runner killed mid-launch left running are ended when the next runner starts`, async () => {
      await holds(ROWS.controllerDeath, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'fault-orphan-'))
        const runtimeDir = join(dir, 'runtime')
        const script = agentScript(dir)
        const first = lifecycleRunner(vendor, runtimeDir, script, join(dir, 'first'))
        const leftovers: number[] = []
        try {
          await until(() => pidIn(join(dir, 'first.child')) !== null && pidIn(join(dir, 'first.agent')) !== null)
          const agentPid = pidIn(join(dir, 'first.agent')) as number
          const childPid = pidIn(join(dir, 'first.child')) as number
          leftovers.push(agentPid, childPid)
          first.runner.kill('SIGKILL')
          expect((await first.exited).signal).toBe('SIGKILL')
          // A dead runner reaps nothing: its agent and what the agent started are still running.
          expect(alive(agentPid) && alive(childPid)).toBe(true)
          const second = lifecycleRunner(vendor, runtimeDir, script, join(dir, 'second'))
          try {
            await until(() => !alive(agentPid) && !alive(childPid))
            // The restarted runner resumes the step the dead one was in, with an agent of its own.
            await until(() => pidIn(join(dir, 'second.agent')) !== null)
            leftovers.push(pidIn(join(dir, 'second.agent')) as number, pidIn(join(dir, 'second.child')) ?? 0)
            expect(readFileSync(loopLogPathFor(null, 7, runtimeDir), 'utf8')).toContain(
              'a runner that died left running'
            )
          } finally {
            second.runner.kill('SIGTERM')
            await second.exited
          }
        } finally {
          first.runner.kill('SIGKILL')
          for (const pid of leftovers)
            try {
              if (pid > 0) process.kill(pid, 'SIGKILL')
            } catch {}
        }
      })
    }, 200_000)

    // --- 07: provider rate or usage limit -------------------------------------------------

    test(`${ROWS.usageLimit} — a usage limit with a reset pauses for the reset, then resumes with no ruling`, async () => {
      await holds(ROWS.usageLimit, async () => {
        const details: string[] = []
        let world: World | undefined
        const { watch, state } = fakeWatch(() => {
          const held = world ? readPauseState(world.runtimeDir, TASK) : null
          if (held?.detail) details.push(held.detail)
        })
        world = createWorld()
        const now = Date.now()
        const run = await replay({
          vendor,
          world,
          launch: (step, attempt) => (step === 'develop' && attempt === 1 ? usageLimited(vendor, now) : undefined),
          lifecycle: { watch: { ...watch, now: () => now }, now: () => new Date(now), handleSignals: false }
        })
        expect(run.trace.outcome).toBe('completed')
        expect(run.handoff.calls.filter((call) => call.startsWith('pause-state:'))).toEqual([
          'pause-state:infrastructure'
        ])
        expect(details).toHaveLength(1)
        expect(isUsageLimitPauseDetail(details[0])).toBe(true)
        // One bounded wait, to the reset the vendor named, and no ruling read or asked for.
        expect(state.sleeps).toEqual([usageLimitWaitMs(usageLimitResetFromDetail(details[0]), now) as number])
        expect(state.sleeps[0]).toBeGreaterThan(0)
        expect(state.rulingReads).toBe(0)
        expect(state.claims).toEqual([
          { decision: 'resume', by: 'driver-self', from: expect.stringMatching(/-usage-limit-reset$/) }
        ])
        // The Developer's turn ran again after the reset, and the round was published once.
        expect(run.ledger.launches.develop).toBe(2)
        expect(commentKeys(run.ledger).sort()).toEqual(eachCommentOnce().sort())
      })
    }, 60_000)

    test(`${ROWS.usageLimit} — the automatic resumes are bounded: past them the pause waits for a person`, async () => {
      await holds(ROWS.usageLimit, async () => {
        const { watch, state } = fakeWatch((ms, s) => {
          // The first poll for a ruling: the pause is cancelled, which ends the watch.
          if (ms === 7) s.resolution = { decision: 'cancel' } as ResolutionRecord
        })
        const now = Date.now()
        const run = await replay({
          vendor,
          launch: (step) => (step === 'develop' ? usageLimited(vendor, now) : undefined),
          lifecycle: { watch: { ...watch, now: () => now }, now: () => new Date(now), handleSignals: false }
        })
        expect(state.claims).toHaveLength(MAX_AUTOMATIC_RATE_LIMIT_RESUMES)
        expect(state.claims.every((claim) => claim.by === 'driver-self')).toBe(true)
        expect(run.ledger.launches.develop).toBe(MAX_AUTOMATIC_RATE_LIMIT_RESUMES + 1)
        expect(state.sleeps.slice(MAX_AUTOMATIC_RATE_LIMIT_RESUMES)).toEqual([7])
        expect(run.trace.outcome).toBe('cancelled')
        expect(run.ledger.comments).toEqual([])
      })
    }, 60_000)

    // --- 08: version incompatibility on resume ---------------------------------------------

    for (const [label, formatVersion, runtimeVersion, code] of [
      [
        'an Engine runtime outside the running one’s range',
        1,
        '@atta/engine@9.0.0 @atta/executor-agent-spawn@9.0.0',
        'runtime_version_incompatible'
      ],
      ['another checkpoint format', 2, null, 'checkpoint_format_incompatible'],
      ['neither version', null, null, 'checkpoint_version_unrecorded']
    ] as const)
      test(`${ROWS.versionIncompatible} — a checkpoint recording ${label} is refused with a typed reason and runs no step`, async () => {
        await holds(ROWS.versionIncompatible, async () => {
          const first = await haltedAtGates(vendor)
          recordVersions(first.world, formatVersion, runtimeVersion)
          const rows = checkpointRows(first.world)
          const eventsBefore = readLedger(first.world.runtimeDir).nodeEvents.length
          const logBefore = driverLog(first.world).length
          const { watch, state } = fakeWatch()
          const second = await replay({ vendor, world: first.world, lifecycle: { watch, handleSignals: false } })
          expect(second.trace.outcome).toBe('paused')
          // The host-repair pause, its detail leading with the typed code that names the cause.
          expect(second.trace.pauseReason).toBe('sandbox_refused')
          expect(readPauseState(first.world.runtimeDir, TASK)?.detail?.startsWith(`${code}: `)).toBe(true)
          expect(driverLog(first.world).slice(logBefore)).toContain(`the checkpoint is refused (${code})`)
          expect(second.handoff.calls).toEqual([
            'escalation:sandbox_refused',
            'pause-state:sandbox_refused',
            'comment:pr:sandbox_refused'
          ])
          // No step ran, no agent launched, the checkpoint is untouched and the run was not started over.
          expect(readLedger(first.world.runtimeDir).nodeEvents).toHaveLength(eventsBefore)
          expect(second.spawns).toEqual([])
          expect(checkpointRows(first.world)).toEqual(rows)
          expect(driverLog(first.world).slice(logBefore)).not.toContain('starting fresh')
          // The refusal is repaired outside the run: no watch is entered for it.
          expect(state.sleeps).toEqual([])
        })
      }, 60_000)

    test(`${ROWS.versionIncompatible} — a checkpoint made on an earlier code revision is resumed, not refused`, async () => {
      await holds(ROWS.versionIncompatible, async () => {
        const first = await haltedAtGates(vendor)
        // The checkout the runner runs from moves on; the checkpoint's own versions are the running ones.
        git(first.world.root, 'commit', '-q', '--allow-empty', '-m', 'the code moved')
        const second = await replay({ vendor, world: first.world })
        expect(second.trace.outcome).toBe('completed')
        expect(driverLog(first.world)).toContain('the checkpoint was made at revision')
        expect(second.spawns.map((s) => s.step)).toEqual(['code-review', 'security-review'])
      })
    }, 60_000)

    // --- 09: checkpoint corruption -----------------------------------------------------

    for (const [label, corrupt] of [
      [
        'a file that is not a checkpoint file',
        (world: World) => {
          for (const suffix of ['-wal', '-shm']) rmSync(`${checkpointFile(world)}${suffix}`, { force: true })
          writeFileSync(checkpointFile(world), 'not a checkpoint file\n'.repeat(400))
        }
      ],
      [
        'a checkpoint row whose state cannot be read',
        (world: World) => {
          const db = new Database(checkpointFile(world))
          db.query("UPDATE checkpoints SET checkpoint = X'00FF00FF', metadata = X'00FF00FF'").run()
          db.close()
        }
      ]
    ] as const)
      test(`${ROWS.checkpointCorrupt} — ${label} is refused with a typed reason, as an Operator-remediation pause`, async () => {
        await holds(ROWS.checkpointCorrupt, async () => {
          const first = await haltedAtGates(vendor)
          corrupt(first.world)
          const bytes = readFileSync(checkpointFile(first.world))
          const eventsBefore = readLedger(first.world.runtimeDir).nodeEvents.length
          const { watch, state } = fakeWatch()
          const second = await replay({ vendor, world: first.world, lifecycle: { watch, handleSignals: false } })
          expect(second.trace.outcome).toBe('paused')
          expect(second.trace.pauseReason).toBe('sandbox_refused')
          const held = readPauseState(first.world.runtimeDir, TASK)
          expect(held?.reason).toBe('sandbox_refused')
          expect(held?.detail?.startsWith('checkpoint_corrupt: ')).toBe(true)
          // An Operator-remediation pause: addressed to the Operator, never retried as infrastructure or watched.
          expect(isHostRepairPause('sandbox_refused')).toBe(true)
          expect(PAUSE_REASON_PROFILE.sandbox_refused.requestedAuthority).toBe('operator')
          expect(held?.infrastructureRetries ?? 0).toBe(0)
          expect(state.sleeps).toEqual([])
          expect(readLedger(first.world.runtimeDir).nodeEvents).toHaveLength(eventsBefore)
          expect(second.spawns).toEqual([])
          expect(readFileSync(checkpointFile(first.world)).equals(bytes)).toBe(true)

          // The Operator sets the checkpoint aside; the ordinary start then continues the task on its open pull request.
          renameSync(checkpointFile(first.world), `${checkpointFile(first.world)}.refused`)
          for (const suffix of ['-wal', '-shm']) rmSync(`${checkpointFile(first.world)}${suffix}`, { force: true })
          const third = await replay({ vendor, world: first.world })
          expect(third.trace.outcome).toBe('completed')
          expect(commentKeys(third.ledger).sort()).toEqual(eachCommentOnce().sort())
        })
      }, 60_000)

    // --- 10: cancellation races --------------------------------------------------------

    test(`${ROWS.cancellationRace} — a cancel and a newer ruling that arrive together end the run once, cancelled, with no resume`, async () => {
      await holds(ROWS.cancellationRace, async () => {
        const { watch, state } = fakeWatch((ms, s) => {
          if (ms !== 7) return
          s.resolution = { decision: 'cancel' } as ResolutionRecord
          s.ordinal = 1
        })
        const run = await replay({
          vendor,
          codeReview: { 1: blocked(vendor) },
          lifecycle: { watch, handleSignals: false }
        })
        expect(run.trace.outcome).toBe('cancelled')
        expect(state.claims).toEqual([])
        expect(run.spawns.map((s) => s.step)).toEqual(['develop', 'code-review', 'security-review'])
        expect(run.events.filter((e) => e.event === 'driver_exited')).toHaveLength(1)
        expect(readDriverLock(run.runtimeDir, TASK)).toBeNull()
        expect(run.ledger.comments).toEqual([])
      })
    }, 60_000)

    test(`${ROWS.cancellationRace} — a ruling whose resolution another process claimed first as a cancel resumes nothing`, async () => {
      await holds(ROWS.cancellationRace, async () => {
        const { watch, state } = fakeWatch((ms, s) => {
          if (ms !== 7) return
          s.ordinal = 1
          s.claimFails = (escalationId) =>
            new ReplayedResolutionError(TASK, escalationId, { decision: 'cancel' } as ResolutionRecord)
        })
        const run = await replay({
          vendor,
          codeReview: { 1: blocked(vendor) },
          lifecycle: { watch, handleSignals: false }
        })
        expect(state.claims).toHaveLength(1)
        expect(run.spawns.map((s) => s.step)).toEqual(['develop', 'code-review', 'security-review'])
        expect(driverLog(run.world)).toContain('another process claimed the resolution')
        expect(run.events.filter((e) => e.event === 'driver_exited')).toHaveLength(1)
        expect(run.ledger.comments).toEqual([])
      })
    }, 60_000)

    test(`${ROWS.cancellationRace} — a second SIGTERM racing the first ends the runner once and leaves no agent process`, async () => {
      await holds(ROWS.cancellationRace, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'fault-cancel-'))
        const runtimeDir = join(dir, 'runtime')
        const started = lifecycleRunner(vendor, runtimeDir, agentScript(dir), join(dir, 'argv'))
        const leftovers: number[] = []
        try {
          await until(() => pidIn(join(dir, 'argv.child')) !== null && pidIn(join(dir, 'argv.agent')) !== null)
          const agentPid = pidIn(join(dir, 'argv.agent')) as number
          const childPid = pidIn(join(dir, 'argv.child')) as number
          leftovers.push(agentPid, childPid)
          started.runner.kill('SIGTERM')
          started.runner.kill('SIGTERM')
          const exit = await started.exited
          expect(exit.code).toBe(143)
          await until(() => !alive(agentPid) && !alive(childPid), 15_000)
          const exits = readFileSync(loopLogPathFor(null, 7, runtimeDir), 'utf8')
            .split('\n')
            .filter((line) => line.includes('driver exited ('))
          expect(exits.length).toBeLessThanOrEqual(1)
        } finally {
          started.runner.kill('SIGKILL')
          for (const pid of leftovers)
            try {
              process.kill(pid, 'SIGKILL')
            } catch {}
        }
      })
    }, 120_000)
  })

/** The stdout records a vendor's CLI prints when the subscription's usage limit ends its turn, resetting 30 minutes after `now`. */
function usageLimited(vendor: Vendor, now: number): { records: Record<string, unknown>[]; exitCode: number } {
  const reset = new Date(now + 30 * 60_000)
  if (vendor === 'claude')
    return {
      records: [
        { type: 'system', session_id: 's-limited' },
        {
          type: 'rate_limit_event',
          session_id: 's-limited',
          rate_limit_info: {
            status: 'rejected',
            isUsingOverage: false,
            resetsAt: Math.floor(reset.getTime() / 1000),
            rateLimitType: 'five_hour'
          }
        },
        { type: 'result', session_id: 's-limited', is_error: true, result: 'Claude AI usage limit reached.' }
      ],
      exitCode: 1
    }
  const hours = reset.getHours()
  const clock = `${hours % 12 === 0 ? 12 : hours % 12}:${String(reset.getMinutes()).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`
  const message = `You've hit your usage limit. Upgrade to Pro, or try again at ${clock}.`
  return {
    records: [
      { type: 'thread.started', thread_id: 't-limited' },
      { type: 'error', message },
      { type: 'turn.failed', error: { message } }
    ],
    exitCode: 1
  }
}

// --- governed effects ---------------------------------------------------------------

for (const vendor of VENDORS)
  describe(`governed effects on the Engine runner, stub ${vendor} vendor`, () => {
    test(`${ROWS.forgeLatency} — a slow forge is waited on within the poll budget, and every publication comment lands once`, async () => {
      await holds(ROWS.forgeLatency, async () => {
        let mergeableReads = 0
        let ciReads = 0
        let polls = 0
        const run = await replay({
          vendor,
          forgeLatencyMs: 150,
          forge: {
            fetchMergeableState: () => (++mergeableReads <= 2 ? 'UNKNOWN' : 'MERGEABLE'),
            fetchCiConclusion: () => (++ciReads <= 2 ? 'pending' : 'green')
          },
          gatePoll: {
            gatePollMaxAttempts: 4,
            gatePollIntervalMs: 0,
            sleep: async () => {
              polls += 1
            }
          }
        })
        expect(run.trace.outcome).toBe('completed')
        expect(mergeableReads).toBeGreaterThan(2)
        expect(ciReads).toBeGreaterThan(2)
        // Every wait is a poll within the budget: no read outlived it.
        expect(polls).toBeLessThanOrEqual(mergeableReads + ciReads)
        expect(commentKeys(run.ledger).sort()).toEqual(eachCommentOnce().sort())
        expect(run.ledger.published).toHaveLength(1)
      })
    }, 60_000)

    test(`${ROWS.forgeLatency} — a forge whose mergeability never settles is waited on only within the bound, and nothing is published`, async () => {
      await holds(ROWS.forgeLatency, async () => {
        let polls = 0
        let reads = 0
        const run = await replay({
          vendor,
          forge: {
            fetchMergeableState: () => {
              reads += 1
              return 'UNKNOWN'
            }
          },
          gatePoll: {
            gatePollMaxAttempts: 3,
            gatePollIntervalMs: 0,
            sleep: async () => {
              polls += 1
            }
          }
        })
        // A head the forge never calls mergeable goes back to the Developer until the round budget is spent: the run
        // ends exhausted, as a durable pause for a person, never hanging on the forge.
        expect(run.trace.outcome).toBe('exhausted')
        expect(run.handoff.calls).toContain('pause-state:max_rounds')
        // Each mergeability step reads the forge at most its budget's times, and waits at most once per read.
        const mergeabilitySteps = run.ledger.nodeEvents.filter(
          (e) => e.type === 'node:start' && /^check(-publish)?-mergeability$/.test(e.nodeId)
        ).length
        expect(mergeabilitySteps).toBeGreaterThan(0)
        expect(reads).toBeLessThanOrEqual(3 * mergeabilitySteps)
        expect(polls).toBeLessThanOrEqual(reads)
        expect(run.ledger.comments).toEqual([])
      })
    }, 60_000)

    test(`${ROWS.duplicateDelivery} — a publication step delivered twice posts each comment once`, async () => {
      await holds(ROWS.duplicateDelivery, async () => {
        const run = await replay({
          vendor,
          wrapAction: (name, action) =>
            name === 'harness.publish'
              ? async (context) => {
                  await action(context)
                  return action(context)
                }
              : action
        })
        expect(run.trace.outcome).toBe('completed')
        expect(run.ledger.published).toHaveLength(2)
        expect(commentKeys(run.ledger).sort()).toEqual(eachCommentOnce().sort())
      })
    }, 60_000)

    test(`${ROWS.lostAcknowledgement} — a comment the forge accepted whose reply was lost is reconciled by its identity, never posted again`, async () => {
      await holds(ROWS.lostAcknowledgement, async () => {
        const first = await replay({
          vendor,
          forgeReply: (comment, attempt) =>
            comment.key === '1-reviewer-verdict' && attempt === 1 ? 'lost-reply' : 'ok'
        })
        expect(first.trace.outcome).toBe('paused')
        expect(commentKeys(first.ledger)).toEqual(['1-reviewer-verdict'])
        const second = await replay({ vendor, world: first.world, lifecycle: nextRunner })
        expect(second.trace.outcome).toBe('completed')
        expect(commentKeys(second.ledger).sort()).toEqual(eachCommentOnce().sort())
        expect(second.spawns).toEqual([])
      })
    }, 60_000)

    test(`${ROWS.lostAcknowledgement} — a lost reply the forge cannot be read back for stays uncertain and is refused, never replayed`, async () => {
      await holds(ROWS.lostAcknowledgement, async () => {
        const first = await replay({
          vendor,
          forgeReply: (comment, attempt) =>
            comment.key === '1-reviewer-verdict' && attempt === 1 ? 'lost-reply' : 'ok'
        })
        expect(first.trace.outcome).toBe('paused')
        for (const readable of [false, true]) {
          const again = await replay({
            vendor,
            world: first.world,
            forgeReadable: () => readable,
            lifecycle: nextRunner
          })
          expect(again.trace.outcome).toBe('paused')
          expect(again.trace.error ?? readPauseState(first.world.runtimeDir, TASK)?.detail ?? '').toContain(
            'outcome is uncertain'
          )
          expect(commentKeys(again.ledger)).toEqual(['1-reviewer-verdict'])
        }
      })
    }, 60_000)

    test(`${ROWS.beyondSurface} — a forged, stale or Developer-written beyond-Surface record is replaced by the rebuilt one on every write`, async () => {
      await holds(ROWS.beyondSurface, async () => {
        const world = makeWorld({ changed: [OWN, OUTSIDE] })
        const live = engineLiveDevToolsContext({
          branch: BRANCH,
          worktreePath: '/worktree',
          task: 8,
          runtimeDir: mkdtempSync(join(tmpdir(), 'fault-beyond-')),
          agent: vendor,
          repo: null,
          round: () => 1,
          deps: fakeDeps(world),
          recordLaunch: () => 'run-1',
          completeLaunch: () => {}
        })
        const forged = (paths: string[]) =>
          `## Scope\n\nScope.\n\n${renderBeyondSurfaceBlock(paths.map((path) => ({ path, reason: 'in', glob: null })))}\n`
        await live.beginTurn()
        expect(await live.context.publishChanges('Fix(cli): Change the own file')).toMatchObject({ ok: true })
        // A Developer-written record that names a path the branch never changed, and leaves out the one it did.
        await live.context.openPullRequest('[t] 8 — Title', forged(['docs/forged.md']))
        expect(recordedBeyondSurfacePaths(world.prBody)).toEqual([OUTSIDE])
        // A forged record written over the body: rebuilt on the write.
        await live.context.updatePullRequestBody(forged(['docs/forged.md', 'docs/also-forged.md']))
        expect(recordedBeyondSurfacePaths(world.prBody)).toEqual([OUTSIDE])
        // The branch lands a push that leaves nothing beyond the Surface: the record from before it is stale and is
        // rebuilt empty, though no body write asked for it.
        world.changed = [OWN]
        world.dirty = [OWN]
        await live.beginTurn()
        expect(await live.context.publishChanges('Fix(cli): Drop the outside change')).toMatchObject({ ok: true })
        expect(recordedBeyondSurfacePaths(world.prBody)).toEqual([])
        expect(world.prBody).toContain('<!-- AEG:BEYOND-SURFACE:START -->\n<!-- AEG:BEYOND-SURFACE:END -->')
        await live.context.updatePullRequestBody(forged([OUTSIDE]))
        expect(recordedBeyondSurfacePaths(world.prBody)).toEqual([])
      })
    })
  })
