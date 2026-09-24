/**
 * In-process conversions, slice 7 (Issue #709, O2): the `--resume` scenarios
 * a prior conversion pass had to leave as REAL PROCESS because
 * `devReviewLoop`'s `resumePr` entry called the bare imported `fetchPrBody`
 * rather than `d.fetchPrBody`. `LoopDeps.fetchPrBody`'s own doc comment now
 * reads "The `--resume` entry reads its PR body through this same
 * dependency, so a resumed run is in the in-process harness's scope too" —
 * `runLoopInProcess(world, { resumePr, agent })` on the SAME world a first
 * `runLoopInProcess(world)` paused now drives the resume genuinely
 * in-process: the harness's fake `fetchPrBody` returns `world.prBody`
 * (default `Closes #<task>`), so `taskFromPrBody` derives the task exactly
 * as the real `gh pr view --json body` read would.
 *
 * See `dev-review-loop-harness.ts` for the shared `LoopWorld`/
 * `runLoopInProcess` machinery this file builds on.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_INFRASTRUCTURE_RETRIES } from '../../../src/lib/dev-review-loop/round-assess.js'
import type { LoopDeps } from '../../../src/lib/dev-review-loop.js'
import {
  cleanupWorlds,
  controlDir as ipControlDir,
  makeInProcessDeps,
  makeWorld,
  outboxLines as ipOutboxLines,
  runLoopInProcess,
  sha,
  taskRunDir as ipTaskRunDir,
  type LoopWorld,
  type RoleOutcome
} from '../dev-review-loop-harness.js'

afterEach(cleanupWorlds)

/** The reviewer outcome for a round-1 `ESCALATE: authority` — no objectives file, matching the fake `claude` binary's own escalate branch in the source subprocess fixture, which never wrote one either. */
const ESCALATE_REVIEWER: RoleOutcome = {
  findings: '',
  report: 'ESCALATE: authority\nSUMMARY: needs a call nobody made.\n',
  objectives: null,
  sessionId: 'rev-session-1'
}

/** A world whose round-1 code-reviewer escalates and security stays clean — the shortest real path into `pause{reason:'escalation'}`, same shape as `dev-review-loop.test.ts`'s `writeFakeClaudePauseThenResumeScenario`. */
function makeEscalationWorld(overrides: Partial<LoopWorld> = {}): LoopWorld {
  return makeWorld({
    roleOutcomes: { 1: { reviewer: ESCALATE_REVIEWER } },
    ...overrides
  })
}

function pauseStatePath(world: LoopWorld): string {
  return join(ipControlDir(world), 'pause-state.json')
}

function controlStoreLoopStatePath(world: LoopWorld): string {
  return join(ipControlDir(world), 'loop-state.json')
}

function readPauseStateFile(world: LoopWorld): Record<string, unknown> {
  return JSON.parse(readFileSync(pauseStatePath(world), 'utf8')) as Record<string, unknown>
}

function writePauseStateFile(world: LoopWorld, record: Record<string, unknown>): void {
  writeFileSync(pauseStatePath(world), JSON.stringify(record), 'utf8')
}

function seedRuling(world: LoopWorld, body = 'Go ahead and fix it.'): void {
  world.rulings = [body]
  world.rulingOrdinal = 1
  world.rulingAuthor = 'daniboomerang'
}

/** A pid that has definitely already exited — `spawnSync` blocks until the child is gone before returning its pid, same idiom as `dev-review-loop.test.ts`'s own `deadPid()`. */
function deadPid(): number {
  const r = spawnSync('true', [])
  if (typeof r.pid !== 'number') throw new Error('spawnSync did not report a pid')
  return r.pid
}

/**
 * An `'infrastructure'` (or `stale_driver`) pause deliberately leaves the
 * driver lock in place — `devReviewLoop`'s own doc comment: "this run is
 * not 'done,' it is a live process that hit a recoverable hiccup." In the
 * real subprocess fixtures the next `--resume` is a genuinely SEPARATE OS
 * process, so the paused process's own (by-then-exited) pid reads as dead
 * and the resume takes the lock over automatically. In-process, the
 * "resumed" call runs on this SAME test process's own (very much alive)
 * pid, so it would otherwise refuse itself as "a driver is already
 * running" — this overwrites the lock's pid with one that has genuinely
 * already exited, standing in for the prior process having ended.
 */
function markDriverLockDead(world: LoopWorld): void {
  const path = join(ipTaskRunDir(world), 'driver.pid.json')
  writeFileSync(path, JSON.stringify({ pid: deadPid(), startedAt: new Date(0).toISOString() }), 'utf8')
}

// --- control-store-v1 task 4 (#554): --resume's own infrastructure-retry
// floor is read from pause-state.json too, never the control store alone ---

describe('devReviewLoop — control-store-v1 task 4 (round 2 review, security HIGH): --resume floors its infrastructure-retry bound against the pause-state file, not the control store alone', () => {
  it('refuses a bare-command resume once the pause-state file alone already reflects the bound, even with the control-store record absent', async () => {
    const world = makeWorld({ gate: 'red' })

    const paused = await runLoopInProcess(world)
    expect(paused.finalDecision).toMatchObject({ type: 'pause', reason: 'infrastructure' })

    // Simulates a `persistLoopState` write that has been silently failing for
    // this task's whole life (an unwritable control-store directory, a
    // hand-cleaned one) while `writePauseState`'s own plain `writeFileSync` —
    // a different write path — kept landing: the control store reads
    // 'absent', but the pause-state file alone already carries a count at
    // the bound.
    const pauseState = readPauseStateFile(world)
    pauseState.infrastructureRetries = MAX_INFRASTRUCTURE_RETRIES
    writePauseStateFile(world, pauseState)
    rmSync(controlStoreLoopStatePath(world), { force: true })

    // Before the fix, `infrastructureRetriesSoFar` came from the
    // control-store read alone: 'absent' read as 0, well under the bound, so
    // this resumed on the bare command exactly like a healthy infrastructure
    // resume, with `bareInfrastructureResume` true and `fetchRulings` never
    // even called. With the fix, the pause-state floor pins
    // `infrastructureRetriesSoFar` at the bound, `bareInfrastructureResume`
    // is false, and the code takes the "fetch rulings for real" branch —
    // the fake `fetchRulings` here stands in for the source fixture's own gh
    // binary, which never wired the `pr view --json comments` call the real
    // `fetchRulings` (`developer-dispatch.ts`) makes and reports failing
    // under its own name; either failure proves the SAME thing this test
    // asserts: the bare-command path was refused.
    await expect(
      runLoopInProcess(
        world,
        { resumePr: world.prNumber, agent: 'claude' },
        {
          fetchRulings: () => {
            throw new Error(`fetchRulings: could not fetch PR #${world.prNumber}'s comments: simulated gh failure`)
          }
        }
      )
    ).rejects.toThrow(/fetchRulings/)
  })
})

describe('devReviewLoop — control-store-v1 task 4 (round 3 review, MAJOR): a resumed process floors its own in-memory infrastructure-retry count against pause-state.json too', () => {
  it('never regresses the persisted count after a further pause, even with the control-store record absent going in', async () => {
    const world = makeWorld({ gate: 'red' })

    const paused = await runLoopInProcess(world)
    expect(paused.finalDecision).toMatchObject({ type: 'pause', reason: 'infrastructure' })

    // Simulates a `persistLoopState` write that has been silently failing
    // since well before this resume: the control-store record is gone
    // entirely, while `pause-state.json` — a different, simpler write path —
    // already carries a real prior count of 3, still comfortably under
    // MAX_INFRASTRUCTURE_RETRIES (5), so the resume GATE check
    // (`infrastructureRetriesSoFar`, already floored against this same file
    // since the security-HIGH fix) grants the bare-command resume cleanly —
    // this test is entirely about what happens to the IN-PROCESS seed once
    // that resumed process actually starts running, not about the gate.
    const pauseState = readPauseStateFile(world)
    pauseState.infrastructureRetries = 3
    writePauseStateFile(world, pauseState)
    rmSync(controlStoreLoopStatePath(world), { force: true })
    markDriverLockDead(world)

    // The SAME always-red CI stalls this resumed process again — one more
    // genuine infrastructure pause, which persists whatever the in-process
    // `infrastructureRetries` variable was seeded at, plus one.
    const resumed = await runLoopInProcess(world, { resumePr: world.prNumber, agent: 'claude' })
    expect(resumed.finalDecision).toMatchObject({ type: 'pause', reason: 'infrastructure' })

    // Before the fix, the in-process seed read the (now-absent) control-store
    // alone: 0, incremented once by this pause, persisted as 1 — silently
    // regressing the true count from 3 down to 1, even though
    // pause-state.json itself already said 3 going in. With the fix, the
    // seed floors against `resumeFrom.infrastructureRetries` (3), so this
    // pause can only ever advance it to 4 or more, never back down.
    const persisted = JSON.parse(readFileSync(controlStoreLoopStatePath(world), 'utf8')) as {
      budgets: { infrastructureRetries: number }
    }
    expect(persisted.budgets.infrastructureRetries).toBeGreaterThanOrEqual(4)

    const newPauseState = readPauseStateFile(world) as { infrastructureRetries: number }
    expect(newPauseState.infrastructureRetries).toBeGreaterThanOrEqual(4)
  })
})

// --- O5 (#595): an infrastructure pause resumes on the bare command -------

describe('devReviewLoop — O5 (#595): an infrastructure pause resumes on the bare command, no Principal ruling needed', () => {
  it('--resume continues past an infrastructure pause with zero ruling comments ever posted', async () => {
    const world = makeWorld({ gate: 'red' })

    const paused = await runLoopInProcess(world)
    expect(paused.finalDecision).toMatchObject({ type: 'pause', reason: 'infrastructure' })

    const pauseState = readPauseStateFile(world)
    expect(pauseState.reason).toBe('infrastructure')

    // Every other pause reason requires a Principal ruling comment before
    // `--resume` will proceed at all — this run posts NONE, ever: no
    // ruling was ever configured on the world, and none of the driver's own
    // posted comments carries a ruling marker either.
    expect(world.rulings).toHaveLength(0)
    for (const c of world.postedComments) expect(c.marker).not.toMatch(/aeg:principal:ruling/)
    markDriverLockDead(world)

    // `--resume` must still continue rather than throw "carries no Principal
    // ruling comment yet" — resolves cleanly to a decision, never a rejection.
    const resumed = await runLoopInProcess(world, { resumePr: world.prNumber, agent: 'claude' })
    // Still stuck on the exact same never-fixed red gate — resumes straight
    // back into the same bounded infrastructure pause, never a crash.
    expect(resumed.finalDecision).toMatchObject({ type: 'pause', reason: 'infrastructure' })
  })
})

// --- escalation pauses, --resume continues after a ruling ------------------

describe('devReviewLoop — escalation pauses, --resume continues after a ruling', () => {
  it('pauses with a marked comment and a non-zero exit, then --resume publishes after a ruling', async () => {
    const world = makeEscalationWorld()

    const paused = await runLoopInProcess(world)
    expect(paused.finalDecision).toMatchObject({ type: 'pause', reason: 'escalation' })

    // One more than a clean round: the driver posts the round marker comment
    // itself before the escalation is even discovered.
    expect(world.postedComments).toHaveLength(2)
    expect(world.postedComments[0]!.marker).toBe('<!-- aeg:developer:round-1 -->')
    const pauseComment = world.postedComments[1]!
    expect(pauseComment.marker).toBe('<!-- aeg:loop:paused:escalation -->')
    expect(pauseComment.body).not.toMatch(/^VERDICT:/m)
    // O1 ([task-log-v1] 9, Issue #631): `assessRound`'s own 'escalation'
    // decision carries no `detail` at all — the driver narrates it from the
    // same verdicts it already dispatched, naming WHICH role escalated.
    expect(pauseComment.body).toContain('reviewer returned ESCALATE this round')

    const pauseState = readPauseStateFile(world)
    expect(pauseState.round).toBe(1)
    expect(pauseState.reason).toBe('escalation')
    expect(pauseState.detail).toContain('reviewer returned ESCALATE this round')

    // Seed a Principal ruling on the PR, and let the round-1 reviewer come
    // back clean on its next (resumed) dispatch — the same "escalated once,
    // clean on retry" scenario the source fixture's fake `claude` binary
    // scripted by invocation count rather than by round.
    seedRuling(world)
    world.roleOutcomes[1]!.reviewer = undefined

    const base = makeInProcessDeps(world)
    const devPrompts: string[] = []
    const dispatchRole: LoopDeps['dispatchRole'] = async (role, agent, prompt, opts) => {
      if (role === 'developer') devPrompts.push(prompt)
      return base.dispatchRole!(role, agent, prompt, opts)
    }

    const resumed = await runLoopInProcess(world, { resumePr: world.prNumber, agent: 'claude' }, { dispatchRole })
    expect(resumed.finalDecision.type).toBe('publish')

    expect(devPrompts).toHaveLength(1)
    const resumePrompt = devPrompts[0]!
    expect(resumePrompt).toMatch(/Principal ruling on this pause/)
    expect(resumePrompt).toMatch(/Go ahead and fix it\./)
    // O11 (task-run-v1 21, #541, round 2 review MAJOR): the ruling-resume
    // prompt names the task/branch/worktree/head context AND the exact
    // command expected — not just "push fixes" in prose.
    expect(resumePrompt).toMatch(new RegExp(`^Resuming task Issue #${world.task}\\.$`, 'm'))
    expect(resumePrompt).toMatch(new RegExp(`^Branch: \`${world.branch}\`$`, 'm'))
    expect(resumePrompt).toMatch(/^Worktree: `.*\.worktrees\//m)
    expect(resumePrompt).toMatch(/^Remote head: [0-9a-f]{40}$/m)
    expect(resumePrompt).toMatch(/`git push`/)

    // Published: the round marker and the original pause comment, then the
    // three publish comments (reviewer verdict, security verdict, summary) —
    // no SECOND round comment, since the resumed round dispatches reviewers
    // on the SAME head (round 1, head unchanged in this fixture) and the
    // driver's own idempotent `developer-round-comment-<round>-<head>` key
    // from before the pause is reused rather than posted again (a REAL,
    // on-disk idempotency check, `postForgeEffectOnce`, genuinely exercised
    // here). The resumed entry ALSO re-attempts the pause comment itself —
    // production's own idempotent `postPauseComment` identity check would
    // make that a no-op once it already landed, but the harness's fake
    // `postPauseComment` (`dev-review-loop-harness.ts`) always records a
    // fresh entry, so this in-process run sees that re-attempt as a genuine
    // extra post. Six total: round marker, pause, the pause re-attempt, then
    // the three publish comments — the source fixture's own count of 6 is
    // reached a different way (it includes the ruling comment itself,
    // seeded directly onto the fake forge's comment list; this harness
    // models a ruling as `world.rulings`, never as a `postedComments` entry).
    expect(world.postedComments).toHaveLength(6)
  })

  // KEPT: the harness's fake `postPauseComment` records directly to
  // `world.postedComments` and never runs the real `EffectExecutor` — no
  // `effect`-kind lines (`attempted`/`observed`/`verified`) are ever emitted
  // for this test to assert on. Converting it would mean re-implementing the
  // real effect-instrumented comment post the harness deliberately bypasses
  // for speed, so it stays on the real subprocess harness.

  it('logs a resumed event, and every event this resumed process emits shares the SAME meta.lineage.run (task-log-v1 task 6, O1/O2/O3: one correlated history)', async () => {
    const world = makeEscalationWorld()

    const paused = await runLoopInProcess(world)
    expect(paused.finalDecision).toMatchObject({ type: 'pause', reason: 'escalation' })

    seedRuling(world)
    world.roleOutcomes[1]!.reviewer = undefined

    const resumed = await runLoopInProcess(world, { resumePr: world.prNumber, agent: 'claude' })
    expect(resumed.finalDecision.type).toBe('publish')

    const lines = ipOutboxLines(world)
    const resumedEvents = lines.filter((l) => l.event === 'resumed')
    expect(resumedEvents).toHaveLength(1)
    expect(resumedEvents[0]).toMatchObject({ kind: 'dev_review_loop', round: 1, by: 'principal' })

    // Every line THIS resumed process itself logged — starting with its own
    // `resumed` event — carries the identical `meta.lineage.run`, the
    // resumed run's own `loopId`: a `dev_review_loop` event from the round
    // loop itself and any `operation`/`effect` event a pause-adjacent write
    // fires in the SAME process are provably part of the same one history,
    // not two independently-correlated streams. (Lines from BEFORE the
    // resume — the original paused run's own `loop_started`..`paused`/
    // `journal_finalized` batch — belong to a DIFFERENT process and are
    // correctly excluded: `resumed` is the first line the code under test
    // logs.)
    const resumedIdx = lines.findIndex((l) => l.event === 'resumed')
    expect(resumedIdx).toBeGreaterThanOrEqual(0)
    const resumedRunLines = lines.slice(resumedIdx)
    const lineageRuns = new Set(resumedRunLines.map((l) => (l.meta as { lineage: { run: string | null } }).lineage.run))
    expect(lineageRuns.size).toBe(1)
    expect([...lineageRuns][0]).not.toBeNull()
  })
})

// --- O8 (task-run-v1 task 15): --resume accepts a moved head after a ruling ---

describe('devReviewLoop — O8 (task-run-v1 task 15): --resume accepts a moved head after a ruling', () => {
  it('never refuses a moved head once a ruling exists — dispatches reviewers directly (no re-dispatched developer) and publishes', async () => {
    const world = makeEscalationWorld()

    const paused = await runLoopInProcess(world)
    expect(paused.finalDecision).toMatchObject({ type: 'pause', reason: 'escalation' })

    // Seed a Principal ruling, THEN simulate the developer pushing a fix out
    // of band, before --resume ever runs — "a ruling followed by a fix
    // push," the exact normal case O8 names. The world's own `head` is the
    // in-process analogue of the source fixture's `ls-remote` answering a
    // new sha once `.fix-pushed-after-pause` exists.
    seedRuling(world)
    world.roleOutcomes[1]!.reviewer = undefined
    world.head = sha('f')
    world.worktreeHead = sha('f')

    const base = makeInProcessDeps(world)
    const devPrompts: string[] = []
    const dispatchRole: LoopDeps['dispatchRole'] = async (role, agent, prompt, opts) => {
      if (role === 'developer') devPrompts.push(prompt)
      return base.dispatchRole!(role, agent, prompt, opts)
    }

    const resumed = await runLoopInProcess(world, { resumePr: world.prNumber, agent: 'claude' }, { dispatchRole })
    expect(resumed.finalDecision.type).toBe('publish')

    // No developer re-dispatch on the resumed run — the ONE developer
    // dispatch this whole scenario ever makes is round 1's original,
    // pre-pause push; a moved head with a ruling goes straight to the
    // gate/reviewer path instead of resuming the developer.
    expect(devPrompts).toHaveLength(0)
    expect(world.dispatchCountByRole.developer).toBe(1)
  })
})
