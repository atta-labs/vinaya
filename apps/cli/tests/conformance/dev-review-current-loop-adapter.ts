import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_REVIEW_POLICY,
  type Objective,
  objectivesOf,
  objectivesVersion,
  renderObjectives
} from '@attalabs/aeg-core'
import {
  cancelDevReviewLoop,
  type LoopDeps,
  type LoopInput,
  type LoopResult,
  taskFromPrBody
} from '../../src/lib/dev-review-loop.js'
import { readDriverLock, readPauseState, writeDriverLock } from '../../src/lib/dev-review-loop/pause-resume.js'
import {
  CLEAN_REVIEWER,
  CLEAN_SECURITY,
  completedTurnOutput,
  controlDir,
  developerPublishesViaToolsDeps,
  type LoopWorld,
  makeInProcessDeps,
  makeWorld,
  outboxLines,
  type RoleOutcome,
  runLoopInProcess,
  withWorldEnv
} from '../lib/dev-review-loop-harness.js'

/**
 * The thin adapter between the normalized behavioral corpus
 * (`tests/fixtures/dev-review-engine-scenarios.json`) and the current
 * standalone developer-review loop.
 *
 * Each driver builds one in-memory world, drives the real `devReviewLoop` (or
 * `cancelDevReviewLoop`) through the injectable `LoopDeps` boundary the
 * in-process harness already exposes, and returns one `Observation`: the
 * decision the controller reached, the durable state it wrote, the effects it
 * performed and the lifecycle events it emitted. A driver never asserts; the
 * exit test compares the observation against the scenario's portable
 * expectation, so a difference is classified there rather than hidden here.
 * Nothing in this file changes production behavior — every override replaces
 * a fake, never a decision.
 */

/** What one scenario run observed, in provider-neutral terms. */
export interface Observation {
  /** `publish`, `pause:<reason>`, `ended:<reason>`, `cancelled`, or `refused` when the entry point threw. */
  decision: string
  /** The thrown message when `decision` is `refused`. */
  refusal: string | null
  durable: {
    pauseReason: string | null
    pauseRound: number | null
    infrastructureRetries: number | null
    controlPhase: string | null
    driverLockHeld: boolean
    /** Durable escalation records the run wrote, one per raised pause. */
    escalations: number
    /** The `decision` of each durable resolution record, sorted. */
    resolutions: string[]
  }
  effects: {
    publishedRounds: number[]
    markers: string[]
    developerDispatches: number
    codeReviewerDispatches: number
    securityDispatches: number
    commits: number
    pushes: number
    prOpens: number
  }
  /** Lifecycle events in emission order: `<event>` for the loop's own family, `<kind>:<event>` for the rest. */
  events: string[]
  /** `round_started` count per round number. */
  roundStartsByRound: Record<string, number>
  /** `journal_finalized` results in emission order. */
  journalResults: string[]
}

type Driver = () => Promise<Observation>

const SHA_NEW_HEAD = 'd'.repeat(40)

const BLOCKER_REVIEWER: RoleOutcome = {
  ...CLEAN_REVIEWER,
  findings: 'BLOCKER|smoke.ts:1|a blocking finding the developer must address',
  report: `${CLEAN_REVIEWER.report}FINDING_IDS: F1\n`
}

const ESCALATE_REVIEWER: RoleOutcome = {
  findings: '',
  report: 'ESCALATE: authority\nSUMMARY: needs a call nobody made.\n',
  objectives: null,
  sessionId: 'rev-session-1'
}

const UNDER_REPORTING_REVIEWER: RoleOutcome = {
  ...CLEAN_REVIEWER,
  objectives: 'O1|MET|done.\n'
}

const REQUIRED_SOURCE = 'https://example.com/required-source'

/** A pid that has already exited: `spawnSync` returns only once the child is gone. */
function deadPid(): number {
  const r = spawnSync('true', [])
  if (typeof r.pid !== 'number') throw new Error('spawnSync did not report a pid')
  return r.pid
}

/**
 * The previous driver process ends. In-process, the next run shares this
 * test's live pid, so a lock the paused run kept would refuse it as "a driver
 * is already running"; the lock's pid is replaced by one that has exited,
 * which is exactly what a new driver process finds after the old one died.
 */
function endDriverProcess(world: LoopWorld): void {
  const lock = readDriverLock(world.runtimeDir, world.task)
  if (lock !== null) writeDriverLock(world.runtimeDir, world.task, { ...lock, pid: deadPid() })
}

function seedRuling(world: LoopWorld): void {
  world.rulings = ['Go ahead.']
  world.rulingOrdinal = 1
  world.rulingAuthor = 'principal'
}

function readLoopStatePhase(world: LoopWorld): string | null {
  const path = join(controlDir(world), 'loop-state.json')
  if (!existsSync(path)) return null
  try {
    return (JSON.parse(readFileSync(path, 'utf8')) as { phase?: string }).phase ?? null
  } catch {
    return null
  }
}

function controlRecords(world: LoopWorld, area: string): Record<string, unknown>[] {
  const dir = join(controlDir(world), area)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .sort()
    .map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')) as Record<string, unknown>)
}

function decisionOf(result: LoopResult): string {
  const d = result.finalDecision as { type: string; reason?: string }
  return d.reason !== undefined ? `${d.type}:${d.reason}` : d.type
}

/** Reads every observable fact of `world` after a run. */
export function observe(world: LoopWorld, decision: string, refusal: string | null = null): Observation {
  const lines = outboxLines(world)
  const events = lines.map((l) =>
    l.kind === 'dev_review_loop' ? String(l.event) : `${String(l.kind)}:${String(l.event)}`
  )
  const roundStartsByRound: Record<string, number> = {}
  for (const l of lines) {
    if (l.kind === 'dev_review_loop' && l.event === 'round_started') {
      const key = String(l.round)
      roundStartsByRound[key] = (roundStartsByRound[key] ?? 0) + 1
    }
  }
  const journalResults = lines
    .filter((l) => l.kind === 'dev_review_loop' && l.event === 'journal_finalized')
    .map((l) => String(l.result))
  const pause = readPauseState(world.runtimeDir, world.task)
  return {
    decision,
    refusal,
    durable: {
      pauseReason: pause?.reason ?? null,
      pauseRound: pause?.round ?? null,
      infrastructureRetries: pause?.infrastructureRetries ?? null,
      controlPhase: readLoopStatePhase(world),
      driverLockHeld: readDriverLock(world.runtimeDir, world.task) !== null,
      escalations: controlRecords(world, 'escalation').length,
      resolutions: controlRecords(world, 'resolution')
        .map((r) => String(r.decision))
        .sort()
    },
    effects: {
      publishedRounds: [...world.publishedRounds],
      markers: world.postedComments.map((c) => c.marker),
      developerDispatches: world.dispatchCountByRole.developer ?? 0,
      codeReviewerDispatches: world.dispatchCountByRole['code-reviewer'] ?? 0,
      securityDispatches: world.dispatchCountByRole.security ?? 0,
      commits: world.commits.length,
      pushes: world.pushes.length,
      prOpens: world.prOpens.length
    },
    events,
    roundStartsByRound,
    journalResults
  }
}

/** Runs the loop once and observes it, turning a thrown entry point into a `refused` decision. */
async function runAndObserve(world: LoopWorld, input?: LoopInput, overrides: Partial<LoopDeps> = {}) {
  try {
    const result = await runLoopInProcess(world, input, overrides)
    return observe(world, decisionOf(result))
  } catch (err) {
    return observe(world, 'refused', err instanceof Error ? err.message : String(err))
  }
}

function cancelInProcess(world: LoopWorld) {
  return withWorldEnv(world, () =>
    cancelDevReviewLoop(
      { cancelPr: world.prNumber, agent: 'claude' },
      {
        fetchPrBody: () => world.prBody,
        taskFromPrBody,
        readPauseState,
        fetchRulings: () => [...world.rulings],
        fetchNewestRulingOrdinal: () => world.rulingOrdinal,
        fetchNewestRulingAuthor: () => world.rulingAuthor,
        runtimeDir: () => world.runtimeDir,
        resolveRepo: async () => null,
        terminateInFlightLaunchesOnShutdown: () => {},
        sleep: (ms) => new Promise((r) => setTimeout(r, ms > 0 ? 1 : 0))
      }
    )
  )
}

async function cancelAndObserve(world: LoopWorld): Promise<Observation> {
  try {
    await cancelInProcess(world)
    return observe(world, 'cancelled')
  } catch (err) {
    return observe(world, 'refused', err instanceof Error ? err.message : String(err))
  }
}

/** A developer dispatch whose handle reports the given delivered documentation, every other role unchanged. */
function withDeliveredDocumentation(
  world: LoopWorld,
  documentation: { sources: string[]; countedReads: string[] }
): Partial<LoopDeps> {
  const base = makeInProcessDeps(world)
  return {
    dispatchRole: async (role, agent, prompt, opts) => {
      const handle = await base.dispatchRole!(role, agent, prompt, opts)
      return role === 'developer' ? { ...handle, documentation } : handle
    }
  }
}

/** A developer dispatch that exits non-zero with no session, as a crashed provider CLI does. */
function developerProviderCrashes(world: LoopWorld): Partial<LoopDeps> {
  const base = makeInProcessDeps(world)
  return {
    dispatchRole: async (role, agent, prompt, opts) => {
      if (role !== 'developer') return base.dispatchRole!(role, agent, prompt, opts)
      world.dispatchCountByRole.developer = (world.dispatchCountByRole.developer ?? 0) + 1
      return { exitCode: 1, durationMs: 1, usage: null, resumeId: null, timedOut: false, failureReason: 'crash' }
    }
  }
}

/** A `publishRound` that throws on its first call and delegates afterwards — a crash after a remote effect began. */
function publishCrashesOnce(world: LoopWorld): Partial<LoopDeps> {
  const base = makeInProcessDeps(world)
  let calls = 0
  return {
    publishRound: (...args: Parameters<NonNullable<LoopDeps['publishRound']>>) => {
      calls += 1
      if (calls === 1) throw new Error('simulated crash after the remote publish began')
      return base.publishRound!(...args)
    }
  }
}

/**
 * A dispatched session carries `VINAYA_LOG_SPOOL_DIR`, which sends every
 * `log()` line to that session's own spool rather than the world's folder:
 * the scenario's lifecycle events would be lost to the observation and
 * written into a real task's record. The in-process harness does not own that
 * key, so each driver runs with it unset and restored afterwards.
 */
function isolatedFromSpool(driver: Driver): Driver {
  return async () => {
    const saved = process.env.VINAYA_LOG_SPOOL_DIR
    delete process.env.VINAYA_LOG_SPOOL_DIR
    try {
      return await driver()
    } finally {
      if (saved !== undefined) process.env.VINAYA_LOG_SPOOL_DIR = saved
    }
  }
}

/**
 * One driver per corpus scenario id. The exit test refuses a scenario with no
 * driver and a driver with no scenario, so this map and the corpus stay one set.
 */
const DRIVERS: Record<string, Driver> = {
  'clean-completion': async () => runAndObserve(makeWorld()),

  'lifecycle-telemetry': async () => runAndObserve(makeWorld()),

  'requested-changes': async () => runAndObserve(makeWorld({ roleOutcomes: { 1: { reviewer: BLOCKER_REVIEWER } } })),

  'mechanical-failure-repeats': async () =>
    runAndObserve(makeWorld({ gate: 'red', failingCheckRuns: [{ id: 1, name: 'Vinaya CI', conclusion: 'failure' }] })),

  'mechanical-failure-recovers': async () => {
    const world = makeWorld({ gate: 'red' })
    const base = makeInProcessDeps(world)
    return runAndObserve(world, undefined, {
      dispatchRole: async (role, agent, prompt, opts) => {
        const handle = await base.dispatchRole!(role, agent, prompt, opts)
        // The developer's second turn fixes CI: the gate reads green on the new head.
        if (role === 'developer' && (world.dispatchCountByRole.developer ?? 0) >= 2) {
          world.gate = 'green'
          world.head = SHA_NEW_HEAD
          world.worktreeHead = SHA_NEW_HEAD
        }
        return handle
      }
    })
  },

  'reviewer-invalidity': async () =>
    runAndObserve(
      makeWorld({
        objectivesText: 'O1. Do the thing.\nO2. Do the other thing.',
        frozenBrief:
          '<!-- aeg:brief:v1 -->\nBrief hash: deadbeef\nDo the thing.\n\n## Objectives\n\nO1. Do the thing.\nO2. Do the other thing.\n\n## Planner rationale\n\nOut of scope for facts.\n',
        roleOutcomes: { 1: { reviewer: UNDER_REPORTING_REVIEWER } }
      })
    ),

  'reviewer-failure': async () =>
    runAndObserve(makeWorld({ roleOutcomes: { 1: { security: { ...CLEAN_SECURITY, writesNothing: true } } } })),

  'review-policy-unreadable': async () =>
    runAndObserve(makeWorld(), undefined, {
      reviewPolicy: () => {
        throw new Error('fake: trust-anchor read failed')
      }
    }),

  'developer-failure': async () =>
    runAndObserve(
      makeWorld({
        roleOutcomes: { 1: { reviewer: BLOCKER_REVIEWER } },
        developerTurnOutput: (round) =>
          round === 2 ? completedTurnOutput({ addressedFindingIds: ['R9-XX-1'] }) : undefined
      })
    ),

  'provider-failure': async () => {
    const world = makeWorld()
    return runAndObserve(world, undefined, developerProviderCrashes(world))
  },

  'required-source-failure': async () => {
    const world = makeWorld({
      developerTurnOutput: () => ({
        ...completedTurnOutput(),
        raw: {
          turnResult: {
            ...(completedTurnOutput().raw as { turnResult: Record<string, unknown> }).turnResult,
            sourceUses: [{ source: REQUIRED_SOURCE, use: 'claimed without a counted read' }]
          }
        }
      })
    })
    return runAndObserve(
      world,
      undefined,
      withDeliveredDocumentation(world, { sources: [REQUIRED_SOURCE], countedReads: [] })
    )
  },

  'context-pressure': async () =>
    runAndObserve(makeWorld({ gate: 'red' }), undefined, {
      reviewPolicy: () => ({ ...DEFAULT_REVIEW_POLICY, maxTaskMinutes: 1e-9 })
    }),

  'bounded-exhaustion': async () =>
    runAndObserve(makeWorld({ roleOutcomes: { 1: { reviewer: BLOCKER_REVIEWER } } }), undefined, {
      reviewPolicy: () => ({ ...DEFAULT_REVIEW_POLICY, maxRounds: 1 })
    }),

  'human-pause': async () => runAndObserve(makeWorld({ roleOutcomes: { 1: { reviewer: ESCALATE_REVIEWER } } })),

  restart: async () => runAndObserve(makeWorld({ developerPushed: true })),

  resume: async () => {
    const world = makeWorld({ roleOutcomes: { 1: { reviewer: ESCALATE_REVIEWER } } })
    await runLoopInProcess(world)
    seedRuling(world)
    world.roleOutcomes[1]!.reviewer = undefined
    return runAndObserve(world, { resumePr: world.prNumber, agent: 'claude' })
  },

  cancellation: async () => {
    const world = makeWorld({ roleOutcomes: { 1: { reviewer: ESCALATE_REVIEWER } } })
    await runLoopInProcess(world)
    seedRuling(world)
    return cancelAndObserve(world)
  },

  'operator-intervention-unauthenticated': async () => {
    const world = makeWorld({ roleOutcomes: { 1: { reviewer: ESCALATE_REVIEWER } } })
    await runLoopInProcess(world)
    return cancelAndObserve(world)
  },

  'stale-objectives': async () => {
    const world = makeWorld()
    return runAndObserve(world, undefined, {
      resolveIssueObjectives: (_task) => {
        if (!world.reviewerDispatchStarted) {
          const parsed = objectivesOf(world.frozenBrief)
          const objectives = parsed.ok ? parsed.objectives : []
          return {
            text: objectives.length > 0 ? renderObjectives(objectives) : '',
            version: objectives.length > 0 ? objectivesVersion(objectives) : null,
            edit: null,
            objectives
          } as never
        }
        // The objectives move while the reviewers run.
        const previous: Objective[] = [{ id: 'O1', text: 'Do the thing.' }]
        const now: Objective[] = [...previous, { id: 'O2', text: 'Also do this.' }]
        return {
          text: renderObjectives(now),
          version: 'midroundversion',
          edit: { previous, now, reason: 'mid-round change' },
          objectives: now
        } as never
      }
    })
  },

  'stale-conflict': async () =>
    runAndObserve(makeWorld({ mergeable: 'CONFLICTING', conflictingFiles: ['apps/cli/src/lib/x.ts'] })),

  'uncertain-effect-crash': async () => {
    const world = makeWorld()
    return runAndObserve(world, undefined, publishCrashesOnce(world))
  },

  'publication-replay': async () => {
    const world = makeWorld()
    const overrides = publishCrashesOnce(world)
    await runLoopInProcess(world, undefined, overrides)
    endDriverProcess(world)
    return runAndObserve(world, undefined, overrides)
  },

  'isolation-refusal': async () => {
    const world = makeWorld({ worktreeExists: true, surface: { in: ['apps/cli'], out: ['packages'] } })
    return runAndObserve(
      world,
      { task: world.task, agent: 'codex' },
      developerPublishesViaToolsDeps(world, { changedPaths: ['packages/aeg-core/src/x.ts'] })
    )
  }
}

export const SCENARIO_DRIVERS: Record<string, Driver> = Object.fromEntries(
  Object.entries(DRIVERS).map(([id, driver]) => [id, isolatedFromSpool(driver)])
)
