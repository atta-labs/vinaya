/**
 * In-process conversions, slice 8 (Issue #709, O2): a slice of the
 * `resolveEscalation`/`--resume`/`--cancel` replay-refusal suite —
 * `LoopDeps.fetchPrBody`'s own doc comment now reads "The `--resume` entry
 * reads its PR body through this same dependency, so a resumed run is in the
 * in-process harness's scope too," so a `--resume` run drives genuinely
 * in-process through `runLoopInProcess(world, { resumePr, agent })` on the
 * SAME world a first `runLoopInProcess(world)` paused. See
 * `dev-review-loop-harness.ts` for the shared `LoopWorld`/`runLoopInProcess`
 * machinery this file builds on, and `dev-review-loop/inproc-3.test.ts`'s own
 * file-header note for the ONE real src-level boundary this file also runs
 * into: `cancelDevReviewLoop`'s own final `log(cancelEvent)` call reaches the
 * MODULE-LEVEL default log sink (`log-sink.ts`'s `defaultSink`, never an
 * injectable dependency), which memoizes its destination on its first-ever
 * real write for the WHOLE `bun:test` process — not per file. `inproc-3`
 * already spends this file-run's one safe successful-cancel-reaching-`log()`
 * slot; `log-sink.ts` exports no reset for that cache (confirmed: `grep -rn
 * "resetLogSink\|contextCache\s*=\s*undefined" apps/cli/src apps/cli/tests`
 * finds nothing), so the two source tests that need their OWN successful
 * cancel to reach that line stay KEPT here too — see the KEPT block below.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIDENCE_FILE_NAME } from '../../../src/lib/dev-review-loop.js'
import { escalationIdFor } from '../../../src/lib/dev-review-loop/pause-resume.js'
import type { LoopDeps } from '../../../src/lib/dev-review-loop.js'
import type { ReconstructedJournal } from '@attalabs/aeg-core'
import {
  cleanupWorlds,
  controlDir as ipControlDir,
  developerDir,
  makeInProcessDeps,
  makeWorld,
  runLoopInProcess,
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

/** A world whose round-1 code-reviewer escalates and security stays clean — the shortest real path into `pause{reason:'escalation'}`, same shape as `dev-review-loop.test.ts`'s `writeFakeClaudePauseThenResumeScenario`/`setUpPauseResume`. */
function makeEscalationWorld(overrides: Partial<LoopWorld> = {}): LoopWorld {
  return makeWorld({
    roleOutcomes: { 1: { reviewer: ESCALATE_REVIEWER } },
    ...overrides
  })
}

function seedRuling(world: LoopWorld, body = 'Go ahead.'): void {
  world.rulings = [body]
  world.rulingOrdinal = 1
  world.rulingAuthor = 'daniboomerang'
}

function escalationRecordPath(world: LoopWorld, round: number, head: string): string {
  return join(ipControlDir(world), 'escalation', `${world.task}-${round}-${head}.json`)
}

function resolutionRecordPath(world: LoopWorld, round: number, head: string): string {
  return join(ipControlDir(world), 'resolution', `${world.task}-${round}-${head}.json`)
}

function driverLockPath(world: LoopWorld): string {
  return join(ipTaskRunDir(world), 'driver.pid.json')
}

const EMPTY_HISTORY: ReconstructedJournal = {
  rounds: [],
  totalWallMs: 0,
  totalFilesChanged: 0,
  summaryUrl: null,
  reviewGate: 'unknown',
  journalFinalized: null
}

const SUMMARY_URL = 'https://forge.example/pr/1#issuecomment-99'

/**
 * The world's own `fetchLoopHistory` fake (`makeInProcessDeps`) is a static
 * stub that always answers "not concluded" — the harness models neither the
 * `gh`-read fact a genuine publish leaves on the forge (a principal-authored
 * ready-for-merge SUMMARY comment) nor the review gate's verdict on the pull
 * request's current state. `devReviewLoop`'s `--resume` replay-recovery
 * branch asks whether the task is CONCLUDED, which is both facts together
 * (`isConcludedJournal`), so a test whose SECOND `--resume` must see the
 * round as genuinely finished overrides it here, keyed off
 * `world.publishedRounds` — the one true "did this world actually publish?"
 * signal every fake `publishRound` already records to.
 *
 * `gateStillPasses` is the second fact, the one this task added: `false`
 * models the real shape the fix exists for — a summary posted for an older
 * head, with a red gate, a newer ruling or a superseded brief since, which
 * must REOPEN rather than refuse.
 */
function fetchLoopHistoryReflectingPublish(world: LoopWorld, gateStillPasses = true): LoopDeps['fetchLoopHistory'] {
  return (_pr) =>
    world.publishedRounds.length > 0
      ? {
          ...EMPTY_HISTORY,
          rounds: world.publishedRounds.map((round) => ({
            round,
            countsBySeverity: {},
            confidence: null,
            outcome: 'changes_requested' as const
          })),
          summaryUrl: SUMMARY_URL,
          reviewGate: gateStillPasses ? ('pass' as const) : ('fail' as const),
          journalFinalized: gateStillPasses ? ({ result: 'merged_ready' } as const) : null
        }
      : EMPTY_HISTORY
}

// --- O2: resolution consumed once, replay refused ---------------------------

describe('devReviewLoop — resolution consumed once, replay refused (O2)', () => {
  it('a second --resume against the SAME already-resolved pause is refused, never re-dispatching', async () => {
    const world = makeEscalationWorld()

    const paused = await runLoopInProcess(world)
    expect(paused.finalDecision).toMatchObject({ type: 'pause', reason: 'escalation' })

    seedRuling(world)
    // The reviewer that escalated the first time comes back clean on its
    // next (resumed) dispatch — the same "escalated once, clean on retry"
    // scenario the source fixture's fake `claude` binary scripted by
    // invocation count rather than by round.
    world.roleOutcomes[1]!.reviewer = undefined

    const overrides: Partial<LoopDeps> = { fetchLoopHistory: fetchLoopHistoryReflectingPublish(world) }

    const resumed = await runLoopInProcess(world, { resumePr: world.prNumber, agent: 'claude' }, overrides)
    expect(resumed.finalDecision.type).toBe('publish')

    const resolutionPath = resolutionRecordPath(world, 1, world.head)
    expect(existsSync(resolutionPath)).toBe(true)
    const resolution = JSON.parse(readFileSync(resolutionPath, 'utf8')) as Record<string, unknown>
    expect(resolution.decision).toBe('resume')

    const dispatchCountsBeforeReplay = { ...world.dispatchCountByRole }

    // Replay: the SAME PR, the SAME pause instance already consumed above —
    // refused rather than silently re-dispatching a second time. The refusal
    // now names the real reason — this review IS concluded, its summary
    // posted and the gate passing on the current state — rather than the
    // storage layer's own consumed-resolution wording (O2).
    await expect(runLoopInProcess(world, { resumePr: world.prNumber, agent: 'claude' }, overrides)).rejects.toThrow(
      new RegExp(`loop already concluded at round 1 \\(summary posted ${SUMMARY_URL}\\)`)
    )

    // Never re-dispatched: the refusal is thrown before the round loop ever
    // re-enters, so no role's dispatch count moved.
    expect(world.dispatchCountByRole).toEqual(dispatchCountsBeforeReplay)
  })
})

// --- O1 (#674): a resume continues from the PR's current state once its own
// newest escalation is already resolved and no driver is running ------------

describe("devReviewLoop — O1 (#674): a resume continues from the pull request's current state once its newest escalation is already resolved and no driver is running", () => {
  it('a resumed round that collides back onto the SAME already-consumed escalation still continues on the next --resume, instead of exiting with a replay refusal', async () => {
    const world = makeEscalationWorld()

    const paused = await runLoopInProcess(world)
    expect(paused.finalDecision).toMatchObject({ type: 'pause', reason: 'escalation' })

    seedRuling(world)

    // First --resume: consumes the escalation's resolution and dispatches
    // reviewers fresh on the ruling — the SAME reviewer escalates again,
    // with the identical reason/detail (the ruling never touched the
    // underlying disagreement, and `world.roleOutcomes[1]` is left
    // unchanged), on the SAME round and head. `sameEscalationInstance`
    // (`control-store/local.ts`) reads this as a rerun of the identical
    // pause instance, so it lands back on the exact escalation id
    // `--resume` already consumed — this world's own `pause-state.json`
    // never advances past it, the same shape a genuine crash right after
    // the resolve would leave behind.
    const firstResume = await runLoopInProcess(world, { resumePr: world.prNumber, agent: 'claude' })
    expect(firstResume.finalDecision).toMatchObject({ type: 'pause', reason: 'escalation' })

    const resolutionPath = resolutionRecordPath(world, 1, world.head)
    expect(existsSync(resolutionPath)).toBe(true)

    const pauseStatePath = join(ipControlDir(world), 'pause-state.json')
    const heldAfterFirstResume = JSON.parse(readFileSync(pauseStatePath, 'utf8')) as Record<string, unknown>
    expect(heldAfterFirstResume.escalationId).toBe(escalationIdFor(world.task, 1, world.head))

    // Second --resume: no driver owns the task any more (the first resume's
    // own call already returned, clearing its lock), and this world's own
    // journal history never shows a `merged_ready` conclusion (still the
    // default `fetchLoopHistory` fake — nothing has published yet) — so this
    // continues from the pull request's current state, dispatching reviewers
    // fresh a third time, where the fake reviewer finally comes back clean
    // (`world.roleOutcomes[1]!.reviewer` cleared just below), and the loop
    // publishes. The pre-existing replay refusal never fires.
    world.roleOutcomes[1]!.reviewer = undefined

    const secondResume = await runLoopInProcess(world, { resumePr: world.prNumber, agent: 'claude' })
    expect(secondResume.finalDecision.type).toBe('publish')
  })

  it('the SAME already-resolved escalation is still refused while a driver genuinely still owns the task (Traps to avoid: the storage guarantee is never weakened)', async () => {
    const world = makeEscalationWorld()

    const paused = await runLoopInProcess(world)
    expect(paused.finalDecision).toMatchObject({ type: 'pause', reason: 'escalation' })

    seedRuling(world)

    const firstResume = await runLoopInProcess(world, { resumePr: world.prNumber, agent: 'claude' })
    expect(firstResume.finalDecision).toMatchObject({ type: 'pause', reason: 'escalation' })

    // Simulate a driver that still owns the task at the moment of the next
    // --resume — a live pid (this test process's own) on the task's driver
    // lock, exactly as the real subprocess fixture's own
    // `writeDriverLockFixture` does.
    writeFileSync(driverLockPath(world), JSON.stringify({ pid: process.pid, startedAt: new Date(0).toISOString() }))

    await expect(runLoopInProcess(world, { resumePr: world.prNumber, agent: 'claude' })).rejects.toThrow(
      /already has a consumed resolution|replay refused/
    )
  })
})

// --- O1/O2/O3: a posted summary is not a latch — the gate on the current
// state decides, and a reopened pull request keeps its round history -------

describe('devReviewLoop — a pull request counts as concluded only while the review gate passes on its current state', () => {
  it('a summary posted for an older head, with the gate no longer passing, RESUMES instead of refusing as a replay (O1)', async () => {
    const world = makeEscalationWorld()

    const paused = await runLoopInProcess(world)
    expect(paused.finalDecision).toMatchObject({ type: 'pause', reason: 'escalation' })

    seedRuling(world)
    world.roleOutcomes[1]!.reviewer = undefined

    // The first --resume consumes the escalation's resolution and publishes:
    // a real summary comment lands on the forge for round 1's head.
    const resumed = await runLoopInProcess(
      world,
      { resumePr: world.prNumber, agent: 'claude' },
      { fetchLoopHistory: fetchLoopHistoryReflectingPublish(world) }
    )
    expect(resumed.finalDecision.type).toBe('publish')
    expect(world.publishedRounds).toEqual([1])

    // The state this task exists for: that same summary is still on the
    // forge, but the review gate no longer passes against the pull request's
    // current state (a red gate, a Principal ruling posted after the summary,
    // a superseded brief, or a moved head — the gate evaluates all of them).
    // The escalation's resolution is still consumed, so before this fix every
    // `--resume` exited with a replay refusal and the task could not be
    // continued at all.
    // Round 2's own confidence answer — an attach at round 2 gates on
    // developer confidence before dispatching reviewers, and this world's fake
    // developer writes no file of its own.
    mkdirSync(developerDir(world, 2), { recursive: true })
    writeFileSync(join(developerDir(world, 2), CONFIDENCE_FILE_NAME), 'CONFIDENCE: 90 — the ruling is addressed\n')

    const publishedJournalRounds: number[][] = []
    const reopened = await runLoopInProcess(
      world,
      { resumePr: world.prNumber, agent: 'claude' },
      {
        fetchLoopHistory: fetchLoopHistoryReflectingPublish(world, false),
        // Records what the real `publishRound` would render into the summary
        // table, which the harness's own fake does not keep.
        publishRound: ((_root: string, input: { round: number; journal: { rounds: { round: number }[] } }) => {
          publishedJournalRounds.push(input.journal.rounds.map((r) => r.round))
          world.publishedRounds.push(input.round)
        }) as unknown as LoopDeps['publishRound']
      }
    )

    // It attached and ran a real round rather than exiting.
    expect(reopened.finalDecision).toEqual({ type: 'publish' })
    // O3: numbered after the last round marker on the forge, never back at 1.
    expect(world.publishedRounds).toEqual([1, 2])
    // O3: the published summary table carries every prior round, not only the
    // one this process computed.
    expect(publishedJournalRounds).toEqual([[1, 2]])
  })

  it('a truly concluded review — summary posted, gate still passing — is refused with a message that says so, not the consumed-resolution text (O2)', async () => {
    const world = makeEscalationWorld()

    const paused = await runLoopInProcess(world)
    expect(paused.finalDecision).toMatchObject({ type: 'pause', reason: 'escalation' })

    seedRuling(world)
    world.roleOutcomes[1]!.reviewer = undefined

    const overrides: Partial<LoopDeps> = { fetchLoopHistory: fetchLoopHistoryReflectingPublish(world) }
    const resumed = await runLoopInProcess(world, { resumePr: world.prNumber, agent: 'claude' }, overrides)
    expect(resumed.finalDecision.type).toBe('publish')

    const dispatchCountsBeforeReplay = { ...world.dispatchCountByRole }

    let refusal: unknown
    try {
      await runLoopInProcess(world, { resumePr: world.prNumber, agent: 'claude' }, overrides)
    } catch (err) {
      refusal = err
    }
    expect((refusal as Error | undefined)?.message).toBe(
      `devReviewLoop --resume: loop already concluded at round 1 (summary posted ${SUMMARY_URL})`
    )
    // The storage layer's own wording is exactly what this replaces.
    expect((refusal as Error).message).not.toMatch(/already has a consumed resolution|replay refused/)
    // Still refused before the round loop: no role was dispatched again.
    expect(world.dispatchCountByRole).toEqual(dispatchCountsBeforeReplay)
  })

  it("a live driver on a NOT-concluded task is still refused in the storage layer's own words — the single-consumption guarantee is never weakened (Traps to avoid)", async () => {
    const world = makeEscalationWorld()

    const paused = await runLoopInProcess(world)
    expect(paused.finalDecision).toMatchObject({ type: 'pause', reason: 'escalation' })

    seedRuling(world)

    const firstResume = await runLoopInProcess(world, { resumePr: world.prNumber, agent: 'claude' })
    expect(firstResume.finalDecision).toMatchObject({ type: 'pause', reason: 'escalation' })

    // A driver that still owns the task at the moment of the next --resume —
    // nothing has published, so the concluded predicate is false here and the
    // ONLY thing refusing is the live-driver branch.
    writeFileSync(driverLockPath(world), JSON.stringify({ pid: process.pid, startedAt: new Date(0).toISOString() }))

    await expect(runLoopInProcess(world, { resumePr: world.prNumber, agent: 'claude' })).rejects.toThrow(
      /already has a consumed resolution|replay refused/
    )
  })
})

// KEPT (real process): "cancels a paused run once — durable, and a second
// cancel is refused as a replay" — `cancelDevReviewLoop`'s own final,
// non-injectable `log(cancelEvent)` call (see this file's own header note)
// reaches the module-level default log sink, and `inproc-3.test.ts` (run in
// the same `bun:test` process as this file: "run ALL in-process files
// together" is this task's own verification step) already spends this
// process's one safe successful-cancel slot on its "logs a cancelled event"
// test. A second successful in-process cancel in this same process writes
// under a DIFFERENT (this file's own) `world.runtimeDir`, but the sink's
// `context()` resolved and cached the FIRST cancel's destination for the
// process's lifetime — so this cancel's own `waitForOwnLoopLine` poll would
// spin out its full 5s best-effort bound against a directory that was never
// written to (and, by the time this runs, already `rmSync`ed by
// `inproc-3.test.ts`'s own `afterEach`). Confirmed no reset export exists in
// `log-sink.ts` (`grep -rn "resetLogSink\|contextCache\s*=\s*undefined"
// apps/cli/src apps/cli/tests` finds nothing) and no src file may be edited
// to add one. Stays on `dev-review-loop.test.ts`'s real subprocess harness.

// --- resolveEscalation's WrongTargetResolutionError/StaleEscalationError ---

describe('devReviewLoop — resolveEscalation’s WrongTargetResolutionError/StaleEscalationError, above the storage level (code review, round 2, MINOR)', () => {
  it('refuses a --resume whose escalation record was never written (StaleEscalationError)', async () => {
    const world = makeEscalationWorld()

    const paused = await runLoopInProcess(world)
    expect(paused.finalDecision).toMatchObject({ type: 'pause', reason: 'escalation' })

    seedRuling(world)

    const recordPath = escalationRecordPath(world, 1, world.head)
    expect(existsSync(recordPath)).toBe(true)
    rmSync(recordPath)

    let thrown: unknown
    try {
      await runLoopInProcess(world, { resumePr: world.prNumber, agent: 'claude' })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toMatch(/is stale/)
    expect((thrown as Error).message).toMatch(/no escalation record was ever written/)
  })
})

// --- O1 (`[task-operator-v1]`/Issue #662): the pause comment post itself
// retries with backoff --------------------------------------------------

describe('devReviewLoop — O1 (`[task-operator-v1]`/Issue #662): the pause comment post itself retries with backoff, and this function itself never crashes the driver', () => {
  it('the next --resume posts the missing comment first, once, and continues — never a second copy once it lands', async () => {
    const world = makeEscalationWorld()
    const base = makeInProcessDeps(world)

    // The in-process analogue of a `gh` that never succeeds, then a healthy
    // one: `postPauseComment` (`PauseCommentPostResult`, `pause-resume.ts`)
    // itself already carries the "never crashes the driver" contract this
    // scenario needs — its real implementation's own retry-with-backoff
    // (`postWithRetry`) lives entirely inside the real forge-write call the
    // harness deliberately bypasses (`dev-review-loop-harness.ts`'s own doc
    // comment), so this fake stands in for "every attempt this round
    // exhausted" on its first call (`posted: false`, no comment recorded),
    // then genuinely posts — through the SAME world-backed pipeline every
    // other test's pause comment goes through — on every call after.
    let pauseAttempt = 0
    const flakyPostPauseComment: LoopDeps['postPauseComment'] = (...args) => {
      pauseAttempt += 1
      if (pauseAttempt === 1) return { posted: false, attempts: 3 }
      return base.postPauseComment!(...args)
    }

    const paused = await runLoopInProcess(world, undefined, { postPauseComment: flakyPostPauseComment })
    expect(paused.finalDecision).toMatchObject({ type: 'pause', reason: 'escalation' })

    // The pause comment never landed — only the round marker comment is
    // recorded.
    expect(world.postedComments).toHaveLength(1)

    // Seed a Principal ruling — --resume's own authentication needs one —
    // and let the round-1 reviewer come back clean on its resumed dispatch.
    seedRuling(world)
    world.roleOutcomes[1]!.reviewer = undefined

    const resumed = await runLoopInProcess(
      world,
      { resumePr: world.prNumber, agent: 'claude' },
      {
        postPauseComment: flakyPostPauseComment
      }
    )
    expect(resumed.finalDecision.type).toBe('publish')

    // The missing pause comment was posted first, exactly once — never
    // duplicated on a later idempotent re-check within the same run.
    const pausedComments = world.postedComments.filter((c) => c.marker === '<!-- aeg:loop:paused:escalation -->')
    expect(pausedComments).toHaveLength(1)
  })
})
