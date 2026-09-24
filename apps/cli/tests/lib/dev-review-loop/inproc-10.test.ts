/**
 * In-process tests for issue-711 O4: a pause never ends the driver.
 * `runDriverLoop` (`dev-review-loop.ts`) is the watching driver `task run`
 * composes instead of calling `devReviewLoop` directly — see its own
 * module doc comment for the full design. These tests drive it through
 * `runDriverLoopInProcess` (`dev-review-loop-harness.ts`), which threads
 * `world.prState` and fast, near-zero poll/backoff intervals so a real
 * driver-watch cycle runs in test time, never a real wall-clock wait.
 *
 * Code review round 1 (BLOCKER/MEDIUM): the watching driver must hold the
 * one-driver-per-task lock for its whole life, never clearing it between a
 * pause and the resumed round — the first test below asserts the lock is
 * present, naming this process, on every single poll tick, and that a
 * genuinely different (but alive) pid on that lock is refused the whole
 * time. `readDriverLock`/`isDriverPidAlive`/`writeDriverLock` are real
 * production primitives, not `LoopDeps` fields — never faked — so a
 * "different pid" is stood in for with `process.ppid` (this test runner's
 * own parent, alive for the test's whole life), the one place this suite
 * touches the lock file directly.
 */

import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'bun:test'
import { escalationIdFor, type LoopDeps, resolveEscalation } from '../../../src/lib/dev-review-loop.js'
import { readDriverLock, readPauseState, writeDriverLock } from '../../../src/lib/dev-review-loop/pause-resume.js'
import {
  cleanupWorlds,
  makeInProcessDeps,
  makeWorld,
  runDriverLoopInProcess,
  runLoopInProcess,
  type LoopWorld,
  type RoleOutcome
} from '../dev-review-loop-harness.js'

afterEach(cleanupWorlds)

/** The reviewer outcome for a round-1 `ESCALATE: authority` — the shortest real path into `pause{reason:'escalation'}`, the same shape `inproc-7.test.ts`'s own `makeEscalationWorld` uses. */
const ESCALATE_REVIEWER: RoleOutcome = {
  findings: '',
  report: 'ESCALATE: authority\nSUMMARY: needs a call nobody made.\n',
  objectives: null,
  sessionId: 'rev-session-1'
}

function makeEscalationWorld(overrides: Partial<LoopWorld> = {}): LoopWorld {
  return makeWorld({ roleOutcomes: { 1: { reviewer: ESCALATE_REVIEWER } }, ...overrides })
}

describe('runDriverLoop — issue-711 O4: a pause never ends the driver; it watches the pull request and continues once a newer ruling appears', () => {
  it('drives ONE call through a pause, a ruling posted while it waits, and on to publish — no resume command, and the driver lock never lapses', async () => {
    const world = makeEscalationWorld()
    let sleepCalls = 0
    const lockNamedThisProcessOnEveryTick: boolean[] = []

    const result = await runDriverLoopInProcess(
      world,
      { task: world.task, agent: 'claude' },
      {},
      {
        sleep: async (ms) => {
          sleepCalls += 1
          // Code review round 1 (BLOCKER): the lock this driver's own round
          // 1 wrote must still be here, still naming THIS process, on every
          // single poll tick — the exact invariant a clear-then-resume gap
          // would break.
          const lock = readDriverLock(world.runtimeDir, world.task)
          lockNamedThisProcessOnEveryTick.push(lock !== null && lock.pid === process.pid)

          if (sleepCalls === 1) {
            // Code review round 1 (BLOCKER): a genuinely SEPARATE driver
            // process for the SAME task, arriving while this one still
            // watches, is refused — simulated by naming a provably alive,
            // genuinely different pid (`process.ppid`) on the lock file,
            // then calling `devReviewLoop` fresh exactly as a second
            // `task run`/`dev-review-loop --task` would. This driver's own
            // real lock (pid + token) is captured first so it can be
            // restored exactly — code review round 2 (MAJOR/security LOW)
            // is precisely about that token mattering, so this test must
            // never lose it either.
            const ownLock = readDriverLock(world.runtimeDir, world.task)
            writeDriverLock(world.runtimeDir, world.task, { pid: process.ppid, startedAt: new Date(0).toISOString() })
            await expect(runLoopInProcess(world, { task: world.task, agent: 'claude' })).rejects.toThrow(
              new RegExp(`a driver is already running \\(pid ${process.ppid}`)
            )
            // Restores this driver's own lock — the state it actually
            // still owns, token included — before letting the watch
            // continue.
            if (ownLock) writeDriverLock(world.runtimeDir, world.task, ownLock)

            // Simulate a Principal posting a ruling ON THE PR while this
            // driver is watching it — never a resume command run against
            // it. Round 1's reviewer also comes back clean on the retry,
            // the same "escalated once, clean on retry" shape
            // `inproc-7.test.ts`'s own hand-driven `--resume` test uses.
            world.rulings = ['Go ahead and fix it.']
            world.rulingOrdinal = 1
            world.rulingAuthor = 'daniboomerang'
            world.roleOutcomes[1]!.reviewer = undefined
          }
          await new Promise((r) => setTimeout(r, ms > 0 ? 1 : 0))
        }
      }
    )

    expect(result.finalDecision).toEqual({ type: 'publish' })
    expect(world.publishedRounds).toEqual([1])
    // The watcher itself made at least one poll wait before the ruling was
    // ready to act on — proof this ran through the watch loop, never a
    // direct `devReviewLoop({resumePr})` call this test made by hand.
    expect(sleepCalls).toBeGreaterThanOrEqual(1)
    expect(lockNamedThisProcessOnEveryTick.length).toBeGreaterThanOrEqual(1)
    expect(lockNamedThisProcessOnEveryTick.every(Boolean)).toBe(true)
    // Published — the task is done, and `devReviewLoop`'s own ordinary
    // publish-path `finally` cleared the lock exactly as it always has.
    expect(readDriverLock(world.runtimeDir, world.task)).toBeNull()
  })

  it('ends the driver once the pull request is merged while it watches — never a pause, never a resume attempt', async () => {
    const world = makeEscalationWorld()

    const result = await runDriverLoopInProcess(
      world,
      { task: world.task, agent: 'claude' },
      {},
      {
        sleep: async (ms) => {
          // The pull request merges (a human admin-merged it, or another
          // process did) while this driver is still watching its own
          // escalation pause — no ruling is ever posted.
          world.prState = 'MERGED'
          await new Promise((r) => setTimeout(r, ms > 0 ? 1 : 0))
        }
      }
    )

    expect(result.finalDecision).toEqual({ type: 'ended', reason: 'merged' })
    // Round 1 stayed paused — no resumed dispatch ever ran.
    expect(world.dispatchCountByRole['code-reviewer']).toBe(1)
    expect(world.publishedRounds).toEqual([])
    // Code review round 1 (BLOCKER): the driver's own lock — held through
    // the whole watch — is released the ONE place `devReviewLoop`'s own
    // `finally` never ran for: `runDriverLoop` clears it itself once the
    // watch loop decides the task is genuinely over.
    expect(readDriverLock(world.runtimeDir, world.task)).toBeNull()
  })

  it('ends the driver once the pull request is closed while it watches', async () => {
    const world = makeEscalationWorld()

    const result = await runDriverLoopInProcess(
      world,
      { task: world.task, agent: 'claude' },
      {},
      {
        sleep: async (ms) => {
          world.prState = 'CLOSED'
          await new Promise((r) => setTimeout(r, ms > 0 ? 1 : 0))
        }
      }
    )

    expect(result.finalDecision).toEqual({ type: 'ended', reason: 'closed' })
    expect(readDriverLock(world.runtimeDir, world.task)).toBeNull()
  })

  it('ends the driver on --cancel’s own resolution, consumed while it watches — the same single-consumption escalation record `cancelDevReviewLoop` writes', async () => {
    const world = makeEscalationWorld()

    const result = await runDriverLoopInProcess(
      world,
      { task: world.task, agent: 'claude' },
      {},
      {
        sleep: async (ms) => {
          // Stand in for a separate `vinaya dev-review-loop --cancel <pr>`
          // process: it authenticates against a posted ruling (out of this
          // test's own scope — `cancelDevReviewLoop` covers that
          // separately) and consumes THIS pause's own escalation via the
          // SAME `resolveEscalation` call, decision `'cancel'`.
          const held = readPauseState(world.runtimeDir, world.task)
          if (held) {
            const escalationId = held.escalationId ?? escalationIdFor(world.task, held.round, held.head)
            resolveEscalation(
              world.task,
              escalationId,
              world.prNumber,
              'cancel',
              'daniboomerang',
              `${world.prNumber}-1`
            )
          }
          await new Promise((r) => setTimeout(r, ms > 0 ? 1 : 0))
        }
      }
    )

    expect(result.finalDecision).toEqual({ type: 'ended', reason: 'cancelled' })
    expect(world.publishedRounds).toEqual([])
    // Code review round 1 (BLOCKER): `--cancel` still ends the watcher AND
    // its lock is still released — the SAME `runDriverLoop`-owned release
    // every other `'ended'` exit gets, never left dangling because this one
    // reason resolved through a different code path (`resolveEscalation`
    // directly, above) than the watch loop's own merged/closed reads.
    expect(readDriverLock(world.runtimeDir, world.task)).toBeNull()
  })

  it('an infrastructure pause retries on its own after a bounded backoff, with no ruling ever posted', async () => {
    // Round 1's mechanical gate stays red long enough to hit the bounded
    // `MAX_GATE_STALLED_TURNS` stall — the same driver-decided
    // `pause{reason:'infrastructure'}` `inproc-2.test.ts` already covers on
    // its own; this test's own subject is that the WATCHING driver retries
    // it, unattended, rather than requiring a hand `--resume`.
    const world = makeWorld({ gate: 'red' })
    let backoffWaited = false

    const result = await runDriverLoopInProcess(
      world,
      { task: world.task, agent: 'claude' },
      {},
      {
        infrastructureBackoffMs: 5,
        sleep: async (ms) => {
          if (ms === 5) {
            // The one bounded backoff wait this pause reason takes before
            // its own bare-resume retry — the gate turns green during it,
            // so the retry that follows actually succeeds.
            backoffWaited = true
            world.gate = 'green'
          }
          await new Promise((r) => setTimeout(r, 1))
        }
      }
    )

    expect(backoffWaited).toBe(true)
    expect(result.finalDecision).toEqual({ type: 'publish' })
    // Never a Principal ruling — this reason's own bare-resume allowance
    // (the SAME one a hand `--resume` already gets for it) is what let this
    // driver continue on its own.
    expect(world.rulings).toHaveLength(0)
  })

  it('never watches the pre-first-push escalation — no pull request exists yet, so it ends exactly as before this task', async () => {
    // The developer never reaches the remote at all — `afterDeveloperTurnBeforePrPoll`
    // throws `DeveloperStopSignal` before any branch/PR exists, the ONE
    // pause `prNumber <= 0` names (this file's own module doc, and
    // `dev-review-loop.ts`'s `runDriverLoop` doc comment). The default
    // world-backed `dispatchRole` fake always marks a developer dispatch as
    // pushed, so the developer half is replaced here with one that never
    // does — matching "no branch ever reached the remote" for real.
    const world = makeWorld({ developerStop: 'ESCALATE: no brief section names this repo at all.' as never })
    const base = makeInProcessDeps(world)
    const dispatchRole: LoopDeps['dispatchRole'] = async (role, agent, prompt, opts) => {
      if (role === 'developer') {
        return { exitCode: 0, durationMs: 1, usage: null, resumeId: null, timedOut: false, effectId: 'eff-dev-1' }
      }
      return base.dispatchRole!(role, agent, prompt, opts)
    }

    const result = await runDriverLoopInProcess(world, { task: world.task, agent: 'claude' }, { dispatchRole }, {})

    expect(result.finalDecision).toMatchObject({ type: 'pause', reason: 'escalation' })
    expect(result.prNumber).toBe(0)
    // Never entered the watch loop — no additional poll/backoff wait beyond
    // whatever this pre-PR path itself needed (none).
    expect(world.dispatchCountByRole['code-reviewer']).toBeUndefined()
  })
})

describe('devReviewLoop — issue-711 F3 (code review round 2, MAJOR/security LOW): lock ownership is bound to a per-acquisition token, never the pid alone', () => {
  it("a lock naming this process's own pid but a DIFFERENT token is never treated as self re-entry — refused, not silently inherited", async () => {
    // Stands in for the exact scenario F3 names: the OS reissuing a
    // crashed driver's pid to a fresh, unrelated invocation for the SAME
    // task. That fresh invocation's own pid is, by definition, alive to
    // itself (`process.kill(<own pid>, 0)` always succeeds) — so once the
    // token no longer matches, the only safe reading left is "some driver
    // — this one or a genuinely different one — already holds this lock,"
    // and this run refuses rather than silently taking over a lock it has
    // no real continuity with.
    const world = makeWorld()
    writeDriverLock(world.runtimeDir, world.task, {
      pid: process.pid,
      startedAt: new Date(0).toISOString(),
      token: 'a-different-crashed-runs-token'
    })

    await expect(runDriverLoopInProcess(world, { task: world.task, agent: 'claude' })).rejects.toThrow(
      new RegExp(`a driver is already running \\(pid ${process.pid}`)
    )
  })

  it('a lock naming a genuinely DEAD pid is still taken over via the normal path — fresh startedAt, takeover noted — regardless of its own token', async () => {
    const world = makeWorld()
    const dead = spawnSync('true', [])
    if (typeof dead.pid !== 'number') throw new Error('spawnSync did not report a pid')
    writeDriverLock(world.runtimeDir, world.task, {
      pid: dead.pid,
      startedAt: new Date(0).toISOString(),
      token: 'a-token-that-does-not-matter-once-the-pid-is-dead'
    })

    const result = await runDriverLoopInProcess(world, { task: world.task, agent: 'claude' })

    expect(result.finalDecision).toEqual({ type: 'publish' })
    // A fresh lock, under a fresh token this run generated itself — never
    // the dead lock's own stale identity.
    const lock = readDriverLock(world.runtimeDir, world.task)
    expect(lock).toBeNull() // published — cleared, same as any ordinary clean run.
  })

  it("the driver's own genuine re-entry — same pid AND its own token — is never refused nor re-raced", async () => {
    // The narrow, direct proof at the entry gate's own boundary (the first
    // test in this file already proves the full end-to-end watch cycle
    // observes this on every poll tick): a SECOND `devReviewLoop` call
    // carrying the SAME token an already-held lock names proceeds exactly
    // as if no lock existed at all — no refusal, no takeover diagnostic,
    // no re-acquire.
    const world = makeWorld()
    writeDriverLock(world.runtimeDir, world.task, {
      pid: process.pid,
      startedAt: new Date(0).toISOString(),
      token: 'this-drivers-own-token'
    })

    const result = await runLoopInProcess(world, {
      task: world.task,
      agent: 'claude',
      retainDriverLock: 'this-drivers-own-token'
    })

    expect(result.finalDecision).toEqual({ type: 'publish' })
  })
})
