/**
 * issue #812, O3 — a driver that takes a task over records its current loop
 * phase BEFORE it dispatches anything, so an earlier run's pause never reads
 * as the live run's current phase.
 *
 * The bug (observed three times on 2026-09-27): the loop writes its
 * `loop_state`/`pause-state.json` records only when its phase CHANGES, so a
 * run that paused left `loop_state` reading `phase: 'pause'`. A driver that
 * later took the task over — after a `--resume`, or a fresh start over a
 * killed run — wrote nothing of its own until its OWN first transition, which
 * on a fresh developing turn can be an hour away. For that whole window
 * `vinaya task status`/`task_status`, which read `loop_state.phase` for the
 * "phase" column (`readLoopPhase`, `task-status.ts`), reported the live,
 * coding run as `paused`.
 *
 * These tests drive the SAME in-process harness `inproc-*.test.ts` build on
 * (`dev-review-loop-harness.ts`): a real on-disk control folder under a temp
 * `runtimeDir`, everything network/`gh`/`git` faked. The status reading is
 * captured at the FIRST developer dispatch of the new run — the exact instant
 * the "hour of developing" begins — through the SAME pure readers the status
 * table computes its `state`/`phase` cells from (`deriveLoopState`/
 * `readLoopPhase`/`phaseIsCurrentFor`), never a second copy of that logic.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LoopDeps } from '../../../src/lib/dev-review-loop.js'
import { deriveLoopState, phaseIsCurrentFor, readLoopPhase, type TaskLoopState } from '../../../src/lib/task-status.js'
import {
  cleanupWorlds,
  controlDir as ipControlDir,
  makeInProcessDeps,
  makeWorld,
  runLoopInProcess,
  type LoopWorld,
  type RoleOutcome
} from '../dev-review-loop-harness.js'

afterEach(cleanupWorlds)

/** A round-1 code-reviewer that escalates — the shortest real path into `pause{reason:'escalation'}`, same shape `inproc-7.test.ts` uses. */
const ESCALATE_REVIEWER: RoleOutcome = {
  findings: '',
  report: 'ESCALATE: authority\nSUMMARY: needs a call nobody made.\n',
  objectives: null,
  sessionId: 'rev-session-1'
}

type StatusRead = {
  state: TaskLoopState
  recordedPhase: string | null
  shownPhase: string | null
  phaseIsCurrent: boolean | null
}

/**
 * What `vinaya task status`'s own `state`/`phase` cells would read for this
 * world's task right now — the production readers, over the world's real
 * runtime dir. `repo: null`/`loopsRoot: root` matches every `deriveLoopState`
 * call in `task-status.test.ts`: no role-log lookup, no forge.
 */
function statusRead(world: LoopWorld): StatusRead {
  const root = world.runtimeDir
  const state = deriveLoopState(root, world.task, { repo: null, loopsRoot: root })
  const phase = readLoopPhase(root, world.task)
  return {
    state,
    recordedPhase: phase?.recordedPhase ?? null,
    shownPhase: phase?.phase ?? null,
    phaseIsCurrent: phase === null ? null : phaseIsCurrentFor(state, phase.recordedPhase)
  }
}

/**
 * A `dispatchRole` fake that captures the status reading the first time the
 * developer is dispatched, then delegates to the world-backed real fake. The
 * capture point is deliberate: `dispatchDeveloper` never persists loop state
 * before calling `dispatchRole`, so a capture here reads whatever the TAKEOVER
 * wrote (or, without the fix, still the earlier run's `pause`).
 */
function capturingDispatchRole(world: LoopWorld, sink: { read: StatusRead | null }): LoopDeps['dispatchRole'] {
  const base = makeInProcessDeps(world)
  return async (role, agent, prompt, opts) => {
    if (role === 'developer' && sink.read === null) sink.read = statusRead(world)
    return base.dispatchRole!(role, agent, prompt, opts)
  }
}

describe("devReviewLoop — a takeover records its phase at once, so an earlier run's pause never reads as current (issue #812)", () => {
  it('a --resume over an earlier run’s pause + loop_state reads the new run’s phase, never paused, from the first read after the start', async () => {
    const world = makeWorld({ roleOutcomes: { 1: { reviewer: ESCALATE_REVIEWER } } })

    // An earlier run pauses (escalation) — leaving pause-state.json AND a
    // loop_state record whose phase is 'pause', the exact stale pair the bug
    // reads.
    const paused = await runLoopInProcess(world)
    expect(paused.finalDecision).toMatchObject({ type: 'pause', reason: 'escalation' })

    // Precondition — with no driver alive, BOTH the state and the phase read
    // as paused off those stale records. This is the true reading for a
    // stopped run, and the one the bug wrongly kept showing under a LIVE
    // takeover.
    const stale = statusRead(world)
    expect(stale.state.kind).toBe('paused')
    expect(stale.recordedPhase).toBe('pause')
    expect(stale.shownPhase).toBe('paused')

    // A Principal rules and the round-1 reviewer comes back clean on its
    // resumed dispatch — the ordinary "escalated once, ruled, resumes" path.
    world.rulings = ['Go ahead and fix it.']
    world.rulingOrdinal = 1
    world.rulingAuthor = 'daniboomerang'
    world.roleOutcomes[1]!.reviewer = undefined

    const sink: { read: StatusRead | null } = { read: null }
    const resumed = await runLoopInProcess(
      world,
      { resumePr: world.prNumber, agent: 'claude' },
      {
        dispatchRole: capturingDispatchRole(world, sink)
      }
    )
    expect(resumed.finalDecision.type).toBe('publish')

    // The first read after the new driver started (captured at the developer
    // dispatch — the start of the developing turn):
    expect(sink.read).not.toBeNull()
    const read = sink.read as StatusRead
    // O2 — while this driver's lock is alive the state reads running, never
    // paused, over the older (retained) pause record.
    expect(read.state.kind).toBe('running')
    // O1 — the takeover recorded its phase before dispatching anything, so the
    // phase column reads the new run's phase (developing), never the earlier
    // run's pause.
    expect(read.recordedPhase).toBe('dispatch_developer')
    expect(read.shownPhase).toBe('developing')
    expect(read.shownPhase).not.toBe('paused')
    // A running driver IS in its phase — shown as current, and current means
    // developing here, never a live 'paused'.
    expect(read.phaseIsCurrent).toBe(true)
  })

  it('a fresh start over a killed run’s pause + loop_state reads the new run’s phase, never paused, from the first read after the start', async () => {
    const world = makeWorld()

    // A killed run left both records behind — a loop_state whose phase is
    // 'pause' and a pause-state.json — but no live driver and no pushed
    // branch, exactly the "new adopter, fresh start over a killed run" shape
    // the third observed case took. Seeded as raw JSON (the same
    // seed-without-acquiring-ownership shape `task-status.test.ts` uses), never
    // through a real prior run.
    const control = ipControlDir(world)
    mkdirSync(control, { recursive: true })
    writeFileSync(
      join(control, 'loop-state.json'),
      JSON.stringify({
        version: 1,
        kind: 'loop_state',
        task: world.task,
        round: 1,
        phase: 'pause',
        pauseReason: 'escalation',
        budgets: { mechanicalRetries: 0, reviewRounds: 1, infrastructureRetries: 0 },
        heldResult: null,
        deliveredFindings: null,
        recordedAt: '2026-09-27T00:00:00.000Z'
      }),
      'utf8'
    )
    writeFileSync(
      join(control, 'pause-state.json'),
      JSON.stringify({
        task: world.task,
        round: 1,
        head: 'unknown',
        branch: world.branch,
        prNumber: null,
        reason: 'escalation',
        pausedAt: '2026-09-27T00:00:00.000Z',
        agent: 'claude'
      }),
      'utf8'
    )

    // Precondition — the seeded records alone read as paused, phase 'pause'.
    const stale = statusRead(world)
    expect(stale.state.kind).toBe('paused')
    expect(stale.recordedPhase).toBe('pause')

    const sink: { read: StatusRead | null } = { read: null }
    const finished = await runLoopInProcess(
      world,
      { task: world.task, agent: 'claude' },
      {
        dispatchRole: capturingDispatchRole(world, sink)
      }
    )
    expect(finished.finalDecision.type).toBe('publish')

    expect(sink.read).not.toBeNull()
    const read = sink.read as StatusRead
    expect(read.state.kind).toBe('running')
    // The takeover superseded the killed run's stale 'pause' phase before the
    // fresh round-1 developer was ever dispatched.
    expect(read.recordedPhase).toBe('dispatch_developer')
    expect(read.shownPhase).toBe('developing')
    expect(read.shownPhase).not.toBe('paused')
    expect(read.phaseIsCurrent).toBe(true)
  })
})
