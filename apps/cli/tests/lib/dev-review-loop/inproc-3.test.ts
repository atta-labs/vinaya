/**
 * In-process conversions, slice 3 (Issue #709, O2): escalation pause, an
 * escalation record's durability, `--cancel`'s refusal paths and its
 * logged completion event, and a genuine round-2 developer resume —
 * driven through `devReviewLoop()`/`cancelDevReviewLoop()` directly rather
 * than a spawned CLI process. See `dev-review-loop-harness.ts` for the
 * shared `LoopWorld`/`runLoopInProcess` machinery this file builds on.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cancelDevReviewLoop, taskFromPrBody, type LoopDeps } from '../../../src/lib/dev-review-loop.js'
import { CONFIDENCE_FILE_NAME } from '../../../src/lib/dev-review-loop/round-assess.js'
import { readPauseState } from '../../../src/lib/dev-review-loop/pause-resume.js'
import {
  cleanupWorlds,
  controlDir as ipControlDir,
  developerDir as ipDeveloperDir,
  makeInProcessDeps,
  makeWorld,
  outboxLines as ipOutboxLines,
  roundDir as ipRoundDir,
  runLoopInProcess,
  type LoopWorld,
  type RoleOutcome,
  withWorldEnv
} from '../dev-review-loop-harness.js'

afterEach(cleanupWorlds)

/** The reviewer outcome for a round-1 `ESCALATE: authority` — no objectives file, matching the fake `claude` binary's own escalate branch, which never wrote one either. */
const ESCALATE_REVIEWER: RoleOutcome = {
  findings: '',
  report: 'ESCALATE: authority\nSUMMARY: needs a call nobody made.\n',
  objectives: null,
  sessionId: 'rev-session-1'
}

/** A world whose round-1 code-reviewer escalates and security stays clean — the shortest real path into `pause{reason:'escalation'}`. */
function makeEscalationWorld(overrides: Partial<LoopWorld> = {}): LoopWorld {
  return makeWorld({
    roleOutcomes: { 1: { reviewer: ESCALATE_REVIEWER } },
    ...overrides
  })
}

function escalationRecordPath(world: LoopWorld, round: number, head: string): string {
  return join(ipControlDir(world), 'escalation', `${world.task}-${round}-${head}.json`)
}

/** `cancelDevReviewLoop` in-process against `world` — every dep wired to the same world fields `makeInProcessDeps` uses for `devReviewLoop`, so a cancel sees exactly the ruling/PR-body state a resume would. */
function cancelInProcess(world: LoopWorld, agent: 'claude' | 'codex' | 'gemini' = 'claude') {
  return withWorldEnv(world, () =>
    cancelDevReviewLoop(
      { cancelPr: world.prNumber, agent },
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

function seedRuling(world: LoopWorld, body = 'Go ahead.'): void {
  world.rulings = [body]
  world.rulingOrdinal = 1
  world.rulingAuthor = 'daniboomerang'
}

// --- --cancel (O3): the ONE successful-cancel test in this file (see the
// file-header note on why only one may reach `log(cancelled)`) -----------

describe('devReviewLoop — --cancel (O3)', () => {
  it('logs a cancelled event, correlated to the task (task-log-v1 task 6, O2)', async () => {
    const world = makeEscalationWorld()

    const paused = await runLoopInProcess(world)
    expect(paused.finalDecision.type).toBe('pause')

    seedRuling(world)

    const cancelled = await cancelInProcess(world)
    expect(cancelled.task).toBe(world.task)

    const cancelledEvents = ipOutboxLines(world).filter((l) => l.event === 'cancelled')
    expect(cancelledEvents).toHaveLength(1)
    const cancelledEvent = cancelledEvents[0] as { kind: string; round: number; by: string; subject: { issue: number } }
    expect(cancelledEvent).toMatchObject({ kind: 'dev_review_loop', round: 1, by: 'principal' })
    expect(cancelledEvent.subject.issue).toBe(world.task)
  })

  it('refuses to cancel with no Principal ruling authenticating it', async () => {
    const world = makeEscalationWorld()

    const paused = await runLoopInProcess(world)
    expect(paused.finalDecision.type).toBe('pause')

    // Never reaches `resolveEscalation`/`log()` — refused on the ruling
    // check alone, so this is safe to run any number of times in this file.
    await expect(cancelInProcess(world)).rejects.toThrow(/no Principal ruling comment yet/)
  })
})

// KEPT (real process): "cancels a paused run once — durable, and a second
// cancel is refused as a replay" needs a trailing real `--resume` attempt;
// "a replayed cancel is refused WITHOUT bumping the task epoch" and
// "--cancel refuses a mismatched --agent" each need their OWN successful
// cancel to complete, which the file-header's log-sink-caching hazard makes
// unsafe once this file already has one (above). See the dispatch report.

describe('devReviewLoop — resolveEscalation’s WrongTargetResolutionError/StaleEscalationError, above the storage level (code review, round 2, MINOR)', () => {
  // KEPT (real process): "refuses a --resume whose escalation record was
  // never written (StaleEscalationError)" needs a real `--resume` call.

  it('refuses a --cancel whose escalation record names a different PR (WrongTargetResolutionError)', async () => {
    const world = makeEscalationWorld()

    const paused = await runLoopInProcess(world)
    expect(paused.finalDecision.type).toBe('pause')

    seedRuling(world)

    const recordPath = escalationRecordPath(world, 1, world.head)
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, unknown>
    record.pr = 999
    writeFileSync(recordPath, JSON.stringify(record))

    // Thrown by `resolveEscalation` itself, before `cancelDevReviewLoop`
    // ever reaches its own final `log()` call — safe here regardless of
    // cancel ordering.
    await expect(cancelInProcess(world)).rejects.toThrow(/names PR 999, not PR \d+/)
  })
})

// --- control-store-v1 task 6, #556: escalation record persisted at pause ---

describe('devReviewLoop — escalation record persisted at pause (O1)', () => {
  it('writes a durable escalation record carrying run identity, reason, and attempted recovery, with no chat history needed to read it back', async () => {
    const world = makeEscalationWorld()

    const paused = await runLoopInProcess(world)
    expect(paused.finalDecision.type).toBe('pause')

    const recordPath = escalationRecordPath(world, 1, world.head)
    expect(existsSync(recordPath)).toBe(true)
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, unknown>
    expect(record.kind).toBe('escalation')
    expect(record.task).toBe(world.task)
    expect(record.round).toBe(1)
    expect(record.head).toBe(world.head)
    expect(record.branch).toBe(world.branch)
    expect(record.pr).toBe(world.prNumber)
    expect(record.reason).toBe('escalation')
    expect(typeof record.runId).toBe('string')
    expect((record.runId as string).length).toBeGreaterThan(0)
    expect(typeof record.pid).toBe('number')
    expect(typeof record.host).toBe('string')
    expect(record.recipient).toBe('principal')
    expect(typeof record.attemptedRecovery).toBe('string')
    expect((record.attemptedRecovery as string).length).toBeGreaterThan(0)
  })
})

// KEPT (real process): "resolution consumed once, replay refused (O2)" and
// "O1 (#674): a resume continues from the pull request's current state..."
// (both its) each need one or more real `--resume` calls. "O8 (task-run-v1
// task 15): --resume accepts a moved head after a ruling" likewise. See the
// dispatch report.

// --- round 2: a genuine resume, not just a clean round 1 -------------------
// (This is the developer session's own `-r <id>` VENDOR resume — an internal
// dispatchRole detail of a SINGLE `devReviewLoop({ task, agent })` call,
// never the `--resume <pr>` CLI/entry-point path above. It converts cleanly.)

describe('devReviewLoop — round 1 blocked, round 2 genuinely resumes', () => {
  it('resumes the SAME developer session with -r, carrying round 1 review context, then publishes', async () => {
    const world = makeWorld({
      roleOutcomes: {
        1: {
          reviewer: {
            findings: 'BLOCKER|smoke.ts:1|deliberate round-1 blocker to force a real round 2',
            report: 'BRIEF_CONFORMANCE: yes\nSPEC_CONFORMANCE: yes\nSCOPE: small\nTESTS: pass\nDOCS: n/a\n',
            objectives: 'O1|MET|done.\n',
            sessionId: 'rev-session-1'
          }
        }
        // round 2 uses the harness's own clean default for both roles.
      }
    })

    const base = makeInProcessDeps(world)
    const developerPrompts: string[] = []
    const developerResumeIds: Array<string | null | undefined> = []
    const overrides: Partial<LoopDeps> = {
      dispatchRole: async (role, agent, prompt, opts) => {
        if (role === 'developer') {
          developerPrompts.push(prompt)
          developerResumeIds.push(opts.resumeId)
          const round = opts.round ?? 1
          if (round >= 2) {
            // The fake `claude` binary's own round>=2 branch wrote a
            // confidence line — the round-response/re-ask cycle
            // `assessRound` requires past round 1 to ever reach `publish`
            // rather than a `confidence` pause.
            mkdirSync(ipDeveloperDir(world, round), { recursive: true })
            writeFileSync(
              join(ipDeveloperDir(world, round), CONFIDENCE_FILE_NAME),
              'CONFIDENCE: 90 — addressed the round 1 blocker\n'
            )
          }
        }
        return (base.dispatchRole as NonNullable<LoopDeps['dispatchRole']>)(role, agent, prompt, opts)
      }
    }

    const result = await runLoopInProcess(world, { task: world.task, agent: 'claude' }, overrides)
    expect(result.finalDecision.type).toBe('publish')

    // Round 1 never carried a resumeId (fresh dispatch); round 2 did — the
    // SAME developer session, resumed, never a silent fresh-session
    // fallback.
    expect(developerPrompts).toHaveLength(2)
    expect(developerResumeIds[0]).toBeUndefined()
    expect(developerResumeIds[1]).toBe('dev-session-1')

    // The clearest proof: round 2's own prompt actually contains round 1's
    // review content — not a resume in name only.
    const round2Prompt = developerPrompts[1] as string
    expect(round2Prompt).toMatch(/BLOCKER/)
    expect(round2Prompt).toMatch(/deliberate round-1 blocker/)
    // O11 (task-run-v1 21, #541, round 2 review MAJOR): the round-findings
    // resume prompt names the task/branch/worktree/head context AND the
    // exact command expected — not just "push fixes" in prose.
    expect(round2Prompt).toMatch(new RegExp(`^Resuming task Issue #${world.task}\\.$`, 'm'))
    expect(round2Prompt).toMatch(new RegExp(`^Branch: \`${world.branch}\`$`, 'm'))
    expect(round2Prompt).toMatch(/^Worktree: `.*\.worktrees\//m)
    expect(round2Prompt).toMatch(/^Remote head: [0-9a-f]{40}$/m)
    expect(round2Prompt).toMatch(/`git push`/)

    const round1Verdict = readFileSync(join(ipRoundDir(world, 1), 'reviewer.md'), 'utf8')
    expect(round1Verdict).toMatch(/^VERDICT: REQUEST CHANGES$/m)
    const round2Verdict = readFileSync(join(ipRoundDir(world, 2), 'reviewer.md'), 'utf8')
    expect(round2Verdict).toMatch(/^VERDICT: APPROVE$/m)

    // The round's real BLOCKER survives into the durable `verdicts_read`
    // event's own `findings` array — not just the rendered comment —
    // carrying its real, uncapped severity, the scale it's read against,
    // and that it counted as blocking under this repo's default policy.
    const round1VerdictsRead = ipOutboxLines(world).find(
      (l) => l.kind === 'dev_review_loop' && l.event === 'verdicts_read' && (l as { round: number }).round === 1
    ) as { findings: Array<Record<string, unknown>> } | undefined
    expect(round1VerdictsRead?.findings).toEqual([
      { id: 'F1', severity: 'BLOCKER', severity_scale: 'code-review', policy_treatment: 'blocking' }
    ])

    const lines = ipOutboxLines(world)
    const loopEvents = lines.filter((l) => l.kind === 'dev_review_loop').map((l) => l.event)
    expect(loopEvents).toEqual([
      'loop_started',
      'round_started',
      'gate_result_read',
      'verdicts_read',
      'findings_compared',
      'round_ended',
      'round_started',
      'gate_result_read',
      'verdicts_read',
      'findings_compared',
      'stop_condition_met',
      'round_ended',
      'journal_finalized'
    ])
    const rounds = lines.filter((l) => l.event === 'round_started').map((l) => (l as Record<string, unknown>).round)
    expect(rounds).toEqual([1, 2])
  })
})

// --- an escalation pause still logs its completion event (regression, PR #459 MAJOR) ---

describe('devReviewLoop — a paused loop for reason escalation still logs its completion event', () => {
  it('pauses on escalation, and journal_finalized is not dropped', async () => {
    const world = makeEscalationWorld()
    const result = await runLoopInProcess(world)
    expect(result.finalDecision).toMatchObject({ type: 'pause', reason: 'escalation' })

    // The driver posts a round marker comment before the findings are even
    // compared — the pause comment is the LAST one posted, not necessarily
    // the first.
    expect(world.postedComments.length).toBeGreaterThan(0)
    const pauseComment = world.postedComments[world.postedComments.length - 1]
    expect(pauseComment?.body).toMatch(/^<!-- aeg:loop:paused:escalation -->$/m)
    // The escalation pause carries no `detail` from `assessRound`; the
    // driver narrates it from the round's own verdicts, naming which role
    // escalated.
    expect(pauseComment?.body).toContain('reviewer returned ESCALATE this round')

    // The regression: this event was once captured into
    // `pendingCompletionEvents` by the `dispatch_reviewers` branch's
    // unconditional filter, and only the `publish` branch ever flushed it —
    // so a `pause` never logged it. Fixed: `routeCompletionEvents` only
    // defers for a `publish` decision.
    const journalFinalized = ipOutboxLines(world).find((l) => l.event === 'journal_finalized') as
      | Record<string, unknown>
      | undefined
    expect(journalFinalized).toBeDefined()
    expect(journalFinalized?.result).toBe('stopped')
  })
})
