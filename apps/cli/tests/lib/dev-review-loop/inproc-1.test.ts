/**
 * In-process conversions of dev-review-loop.test.ts's real-process fixtures
 * covering lines 909-2117: the crash-mid-publish suite (a `publishRound`
 * that throws partway through posting its verdicts) and the two SETUP-phase
 * forge/git read failures that must become a decided pause rather than an
 * uncaught crash. Each test drives `devReviewLoop()` directly through
 * `runLoopInProcess`, never a spawned subprocess.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  cleanupWorlds,
  makeInProcessDeps,
  makeWorld,
  outboxLines as ipOutboxLines,
  runLoopInProcess,
  taskRunDir as ipTaskRunDir
} from '../dev-review-loop-harness.js'
import { readDriverLock, readPauseState } from '../../../src/lib/dev-review-loop/pause-resume.js'

afterEach(cleanupWorlds)

/**
 * Throws immediately — the in-process analogue of `gh pr comment` crashing
 * on the SECOND publish post. The developer's own round-marker comment
 * (`postDeveloperRoundComment`, posted at round-1 entry, ahead of the gate/
 * reviewer dispatch) is the FIRST post the real `gh` fixture ever answered
 * successfully; `publishRound`'s own first post attempt (the reviewer
 * verdict) is the second call overall, and that is the one that crashes —
 * so `publishRound` itself never records a successful post here.
 */
function publishRoundCrashesOnFirstPost(): void {
  throw new Error('simulated crash on the second publish post')
}

/**
 * The persistent-failure flavor: the same crashing `publishRound` above,
 * plus a `postPauseComment` that also fails — the in-process analogue of a
 * `gh` that never recovers, so the driver's own best-effort pause-comment
 * post afterward fails too (`setUpCrashMidPublish`'s own fake `gh`, never
 * the "then healthy" one O6's own test uses).
 */
function persistentGhFailureDeps() {
  return {
    publishRound: publishRoundCrashesOnFirstPost,
    postPauseComment: (): never => {
      throw new Error('fake gh: simulated crash on the second publish post')
    }
  }
}

describe('devReviewLoop — a crash mid-publish never logs merged_ready (regression, PR #459 MAJOR)', () => {
  it('posts the reviewer verdict, crashes on the security verdict, and the outbox never claims merged_ready', async () => {
    const world = makeWorld()
    const result = await runLoopInProcess(world, undefined, persistentGhFailureDeps())
    expect(result.finalDecision.type).toBe('pause')

    // Exactly one post landed — the crash hit the second, before the third
    // (the summary) was ever attempted; the driver's own best-effort
    // pause-comment post afterward fails too (persistent `gh` failure).
    expect(world.postedComments).toHaveLength(1)

    // The regression: `journal_finalized`/`merged_ready` must never be
    // logged for a run whose `publishRound` never actually returned.
    const journalFinalizedLines = ipOutboxLines(world).filter((l) => l.event === 'journal_finalized')
    expect(journalFinalizedLines.some((l) => l.result === 'merged_ready')).toBe(false)
  })

  it("[task-files-v1] 5, O3: an uncaught throw mid-round never posts telemetry to the task's own Issue — there is no final flush left to do it, configured `logPublish` or not", async () => {
    const world = makeWorld()
    // A `logPublish` target configured here would have been exactly what
    // the old round-end/final flush read — proving it is never even
    // consulted any more, on the identical uncaught-throw exit path the
    // removed crash-recovery fix used to guarantee a flush for.
    writeFileSync(join(world.repoRoot, 'vinaya.config.json'), JSON.stringify({ logPublish: { issue: world.task + 1 } }))
    const result = await runLoopInProcess(world, undefined, persistentGhFailureDeps())
    expect(result.finalDecision.type).toBe('pause')

    expect(world.postedComments.some((c) => c.kind === 'issue')).toBe(false)

    // The events themselves still landed — live, in the local default
    // destination — even though nothing ever shipped them anywhere else.
    const journalFinalizedLines = ipOutboxLines(world).filter((l) => l.event === 'journal_finalized')
    expect(journalFinalizedLines.length).toBeGreaterThan(0)
  })

  // `#548` v3, O2: this exact scenario — a genuinely uncaught throw mid-round,
  // never a decided `pause`/`publish` from the loop's OWN logic — is the
  // fixture the brief asks for. The role log is the one trace left inside
  // this task's Surface (the forge journal event needs an out-of-surface
  // `packages/aeg-core` schema change and belongs to a different task, per
  // the Principal's ruling).
  it('O2 (#548 v3): an uncaught error mid-loop leaves a driver_exited trace in the role log', async () => {
    const world = makeWorld()
    const result = await runLoopInProcess(world, undefined, persistentGhFailureDeps())
    expect(result.finalDecision.type).toBe('pause')

    const roleLog = readFileSync(join(ipTaskRunDir(world), 'output', 'driver.log'), 'utf8')
    expect(roleLog).toMatch(/^\[dev-review-loop\] driver_exited: reason=error last_decision=\S+$/m)
  })

  // O6: the SAME uncaught-error scenario, now proven to be a clean, decided
  // pause — never a raw crash the process merely survives by accident. The
  // driver lock is deliberately left in place (never cleared) for this
  // reason: `task status` reads a live lock as `running` before it ever
  // consults the pause-state file, so a cleared lock here would make the
  // process's own death indistinguishable from a genuine, settled pause.
  it('O6: the SAME crash is a decided pause(infrastructure) — the lock stays in place, a real pause-state and PR comment exist, nothing is thrown', async () => {
    const world = makeWorld()
    const result = await runLoopInProcess(world, undefined, { publishRound: publishRoundCrashesOnFirstPost })
    expect(result.finalDecision.type).toBe('pause')
    expect((result.finalDecision as { reason?: string }).reason).toBe('infrastructure')

    // The lock is NEVER cleared for this reason — still on disk, still
    // naming a real pid, proving this run's own `finally` deliberately
    // skipped `clearDriverLock` rather than the process merely not having
    // reached it yet.
    const lock = readDriverLock(world.runtimeDir, world.task)
    expect(typeof lock?.pid).toBe('number')

    const pauseState = readPauseState(world.runtimeDir, world.task)
    expect(pauseState?.reason).toBe('infrastructure')

    // The driver's own best-effort pause comment, posted moments later on
    // the world's own (always-healthy) `postPauseComment` fake, lands
    // normally — the real marked pipeline (`pauseMarker` → `renderPauseComment`
    // → `markedCommentBody`), asserted on its exact marker line.
    expect(world.postedComments.some((c) => /^<!-- aeg:loop:paused:infrastructure -->$/m.test(c.body))).toBe(true)
  })
})

describe('runLoopInProcess — the run never inherits the outer CI runner’s or dispatched session’s env', () => {
  // A CI runner sets `GITHUB_ACTIONS`, which moves the log destination off the
  // local file `outboxLines` reads; a dispatched session sets `VINAYA_ROLE`.
  // Either leaking into the in-process loop made the same test pass on a
  // laptop and time out in CI.
  it('clears GITHUB_ACTIONS and VINAYA_ROLE for the run, restores both after, and the run still lands its log lines', async () => {
    const saved = { GITHUB_ACTIONS: process.env.GITHUB_ACTIONS, VINAYA_ROLE: process.env.VINAYA_ROLE }
    process.env.GITHUB_ACTIONS = 'true'
    process.env.VINAYA_ROLE = 'developer'
    try {
      const world = makeWorld()
      const seen: Array<{ ci: string | undefined; role: string | undefined }> = []
      const worldDispatch = makeInProcessDeps(world).dispatchRole!
      const result = await runLoopInProcess(world, undefined, {
        dispatchRole: (...args) => {
          seen.push({ ci: process.env.GITHUB_ACTIONS, role: process.env.VINAYA_ROLE })
          return worldDispatch(...args)
        }
      })
      expect(result.finalDecision.type).toBe('publish')
      expect(seen.length).toBeGreaterThan(0)
      expect(seen.every((s) => s.ci === undefined && s.role === undefined)).toBe(true)
      expect(ipOutboxLines(world).length).toBeGreaterThan(0)

      expect(process.env.GITHUB_ACTIONS).toBe('true')
      expect(process.env.VINAYA_ROLE).toBe('developer')
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})

describe('devReviewLoop — the loop’s exit sites (O6)', () => {
  it("a forge-read failure in round 1's own fresh-dispatch entry (fetchFrozenBrief, before runRoundLoop even starts) is a decided pause too — never an uncaught crash, and no developer is ever dispatched", async () => {
    const world = makeWorld()
    const result = await runLoopInProcess(world, undefined, {
      fetchFrozenBrief: () => {
        throw new Error(
          `fetchFrozenBrief: Issue #${world.task} carries no principal-authored, frozen \`aeg:brief:v<k>\` comment — \`vinaya task brief\` must post the brief before this loop can start.`
        )
      }
    })
    expect(result.finalDecision.type).toBe('pause')
    expect((result.finalDecision as { reason?: string }).reason).toBe('infrastructure')
    expect(world.dispatchCountByRole.developer ?? 0).toBe(0)

    const pauseState = readPauseState(world.runtimeDir, world.task)
    expect(pauseState?.reason).toBe('infrastructure')
    expect(String((pauseState as { detail?: unknown })?.detail)).toMatch(/carries no principal-authored, frozen/)

    // O6: the lock is deliberately left in place for this reason — the same
    // "process stays alive" discipline every other infrastructure pause gets.
    const lock = readDriverLock(world.runtimeDir, world.task)
    expect(typeof lock?.pid).toBe('number')
  })

  // A `git` failure on `rev-parse origin/main` is the driver's own SETUP,
  // run before round 1's fresh-dispatch entry even starts — it must reach
  // the same widened `try` any other setup-phase failure does, never
  // propagate straight out of `devReviewLoop` uncaught with no pause/lock
  // left behind.
  it("a git read failure in the driver's own SETUP (git rev-parse origin/main, before round 1's fresh-dispatch entry) is a decided pause — never an uncaught crash, and no developer is ever dispatched", async () => {
    const world = makeWorld()
    const result = await runLoopInProcess(world, undefined, {
      gitRevParseOriginMain: () => {
        throw new Error(
          "git rev-parse origin/main: fatal: ambiguous argument 'origin/main': unknown revision or path not in the working tree."
        )
      }
    })
    expect(result.finalDecision.type).toBe('pause')
    expect((result.finalDecision as { reason?: string }).reason).toBe('infrastructure')
    expect(world.dispatchCountByRole.developer ?? 0).toBe(0)

    const pauseState = readPauseState(world.runtimeDir, world.task)
    expect(pauseState?.reason).toBe('infrastructure')

    // O6: the lock stays in place — the process is alive, holding it,
    // exactly as it does for every other infrastructure pause.
    const lock = readDriverLock(world.runtimeDir, world.task)
    expect(typeof lock?.pid).toBe('number')
  })
})
