/**
 * In-process tests for issue-711 F1 (code review, MINOR): two call sites the
 * O1/O2/O3 patch-carry work (`inproc-9.test.ts`) added had no direct test of
 * their own —
 *
 *  - the patch-carry check's `--resume` entry point
 *    (`apps/cli/src/lib/dev-review-loop.ts`, the block right before
 *    `return await runRoundLoop()`, whose own doc comment states it "runs
 *    at round start AND on resume — both paths … have already converged
 *    … so one check covers both entry points"): every existing test drove
 *    it only through a fresh `{ task }` attach.
 *  - the `max_rounds` pause's own `patchCarryNote` append (same file, the
 *    `decision.type === 'pause' && decision.reason === 'max_rounds' &&
 *    patchCarryNote !== null` block): nothing had ever driven a round that
 *    both failed the patch-carry comparison AND hit the round cap.
 *
 * See `dev-review-loop-harness.ts` for the shared `LoopWorld`/
 * `runLoopInProcess` machinery this file builds on, and `inproc-9.test.ts`
 * for the ORIGINAL O1/O2/O3 coverage this file adds two direct call sites
 * to, never duplicating what that file already covers.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'bun:test'
import { briefHash, DEFAULT_REVIEW_POLICY, objectivesOf, objectivesVersion, policyDigest } from '@attalabs/aeg-core'
import { renderCodeReviewComment, renderSecurityComment } from '../../../src/commands/review-post.js'
import { writeHeldVerdict } from '../../../src/lib/dev-review-loop/reviewer-dispatch.js'
import { CONFIDENCE_FILE_NAME } from '../../../src/lib/dev-review-loop.js'
import {
  cleanupWorlds,
  controlDir,
  developerDir,
  makeWorld,
  runLoopInProcess,
  sha,
  taskRunDir,
  type LoopWorld,
  type RoleOutcome
} from '../dev-review-loop-harness.js'

afterEach(cleanupWorlds)

const DEFAULT_POLICY_DIGEST = policyDigest(DEFAULT_REVIEW_POLICY)
const TOKENS = { model: 'claude', tokensIn: '10', tokensOut: '5', cost: '—' }

/** The reviewer outcome for a round-1 `ESCALATE: authority` — the shortest real path into `pause{reason:'escalation'}`, the same shape `inproc-7.test.ts`'s own `makeEscalationWorld` uses. */
const ESCALATE_REVIEWER: RoleOutcome = {
  findings: '',
  report: 'ESCALATE: authority\nSUMMARY: needs a call nobody made.\n',
  objectives: null,
  sessionId: 'rev-session-1'
}

/** Same rendering pipeline `inproc-9.test.ts`'s own `seedCleanHeldRound1` uses (`buildVerdictFromReport` in production), parametrized by round so F1's `max_rounds` test can seed one at round 4. */
function seedCleanHeldRound(world: LoopWorld, round: number, headSha: string): void {
  const parsed = objectivesOf(world.frozenBrief)
  const objectives = parsed.ok ? parsed.objectives : []
  const version = objectives.length > 0 ? objectivesVersion(objectives) : null
  const objectiveResults =
    objectives.length > 0 ? objectives.map((o) => ({ id: o.id, status: 'MET' as const, evidence: 'done.' })) : null
  const common = {
    ...TOKENS,
    taskId: String(world.task),
    headSha,
    baseSha: world.mergeBase,
    objectivesVersion: version,
    objectiveResults,
    rulingOrdinal: world.rulingOrdinal,
    briefHash: briefHash(world.frozenBrief),
    policyDigest: DEFAULT_POLICY_DIGEST
  }
  const reviewerBody = renderCodeReviewComment({
    ...common,
    verdict: 'APPROVE',
    briefConformance: 'yes',
    specConformance: 'yes',
    findings: [],
    scope: 'small',
    scopeEvidence: null,
    tests: 'pass',
    docs: 'n/a',
    sessionId: 'rev-session-1'
  })
  const securityBody = renderSecurityComment({
    ...common,
    verdict: 'PASS',
    findings: [],
    configScan: 'clean',
    secrets: 'none found',
    secretsEvidence: null,
    sessionId: 'sec-session-1'
  })
  writeHeldVerdict(world.runtimeDir, world.task, round, 'reviewer', reviewerBody)
  writeHeldVerdict(world.runtimeDir, world.task, round, 'security', securityBody)
}

function seedRuling(world: LoopWorld, body = 'Go ahead and fix it.'): void {
  world.rulings = [body]
  world.rulingOrdinal = 1
  world.rulingAuthor = 'daniboomerang'
}

/** A pid that has definitely already exited — the same idiom `inproc-7.test.ts`'s own `deadPid`/`markDriverLockDead` use, so a same-process `--resume` call never refuses itself as "a driver is already running." */
function deadPid(): number {
  const r = spawnSync('true', [])
  if (typeof r.pid !== 'number') throw new Error('spawnSync did not report a pid')
  return r.pid
}

function markDriverLockDead(world: LoopWorld): void {
  writeFileSync(
    join(taskRunDir(world), 'driver.pid.json'),
    JSON.stringify({ pid: deadPid(), startedAt: new Date(0).toISOString() }),
    'utf8'
  )
}

describe('devReviewLoop — issue-711 F1: the patch-carry check runs on the --resume entry point too, not only a fresh attach', () => {
  it('a --resume across a patch-identical head move publishes the held clean verdict directly — no reviewer dispatch on the resumed call', async () => {
    const HELD_HEAD = sha('a')
    const NEW_HEAD = sha('c')
    const world = makeWorld({
      developerPushed: true,
      head: HELD_HEAD,
      roleOutcomes: { 1: { reviewer: ESCALATE_REVIEWER } }
    })
    // Seeded BEFORE the first pass runs, so the escalation round — and the
    // clean pair overwritten onto it below — are both judged against the
    // SAME ruling ordinal `--resume` will read: this test is about the
    // patch-carry check's own head comparison, never an incidental
    // ruling-ordinal drift `--resume`'s own required-ruling gate would
    // otherwise introduce.
    seedRuling(world)

    const paused = await runLoopInProcess(world)
    expect(paused.finalDecision).toMatchObject({ type: 'pause', reason: 'escalation' })
    const dispatchesBeforeResume = { ...world.dispatchCountByRole }

    // Overwrite round 1's held pair as a clean APPROVE/PASS pair, captured
    // against the SAME facts (ruling ordinal, brief, objectives, policy)
    // the escalation round actually ran under — only HEAD differs once it
    // moves below, isolating the patch-carry comparison as the one thing
    // this test exercises.
    seedCleanHeldRound(world, 1, HELD_HEAD)
    world.head = NEW_HEAD
    markDriverLockDead(world)

    const resumed = await runLoopInProcess(
      world,
      { resumePr: world.prNumber, agent: 'claude' },
      { patchIdOf: (s: string) => (s === HELD_HEAD || s === NEW_HEAD ? 'same-patch' : null) }
    )

    expect(resumed.finalDecision).toEqual({ type: 'publish' })
    expect(world.publishedRounds).toEqual([1])
    // No fresh round ran on the resumed call — the held clean verdict
    // carried across the patch-identical move instead.
    expect(world.dispatchCountByRole['code-reviewer']).toBe(dispatchesBeforeResume['code-reviewer'])
    expect(world.dispatchCountByRole.security).toBe(dispatchesBeforeResume.security)
  })

  it('a --resume across a genuinely different (non patch-identical) head starts a fresh round instead', async () => {
    const HELD_HEAD = sha('a')
    const NEW_HEAD = sha('c')
    const world = makeWorld({
      developerPushed: true,
      head: HELD_HEAD,
      roleOutcomes: { 1: { reviewer: ESCALATE_REVIEWER } }
    })
    seedRuling(world)

    const paused = await runLoopInProcess(world)
    expect(paused.finalDecision).toMatchObject({ type: 'pause', reason: 'escalation' })

    seedCleanHeldRound(world, 1, HELD_HEAD)
    world.head = NEW_HEAD
    // The fresh round this resume falls through to (still round 1 — the
    // ruling ordinal, not a developer push, is what this "head moved"
    // resume re-derives the round from) comes back clean this time, the
    // same "escalated once, clean on retry" shape `inproc-7.test.ts`'s own
    // hand-driven `--resume` test uses.
    world.roleOutcomes[1]!.reviewer = undefined
    markDriverLockDead(world)

    const resumed = await runLoopInProcess(
      world,
      { resumePr: world.prNumber, agent: 'claude' },
      {
        patchIdOf: (s: string) => `patch-for-${s}`
      }
    )

    expect(resumed.finalDecision).toEqual({ type: 'publish' })
    // A fresh round genuinely ran on the resumed call this time.
    expect(world.dispatchCountByRole['code-reviewer']).toBeGreaterThanOrEqual(1)
    expect(world.dispatchCountByRole.security).toBeGreaterThanOrEqual(1)
  })
})

describe('devReviewLoop — issue-711 F1: a max_rounds pause right after a genuinely failed patch-carry check names the comparison it made', () => {
  it('appends the patch-carry note to the max_rounds detail', async () => {
    const HELD_HEAD = sha('a')
    const NEW_HEAD = sha('c')
    const ROUND = 4 // > DEFAULT_MAX_ROUNDS (3) — the round cap itself
    const world = makeWorld({
      developerPushed: true,
      head: NEW_HEAD,
      roleOutcomes: {
        [ROUND]: {
          reviewer: {
            findings: 'BLOCKER|smoke.ts:1|still there at the round cap',
            // `FINDING_IDS:` cites the one findings.txt line — a report
            // with findings but no matching line is resent once, which
            // would otherwise double this test's own dispatch count for a
            // reason that has nothing to do with the round cap it exists
            // to exercise.
            report:
              'BRIEF_CONFORMANCE: yes\nSPEC_CONFORMANCE: yes\nSCOPE: small\nTESTS: pass\nDOCS: n/a\nFINDING_IDS: F1\n',
            objectives: 'O1|MET|done.\n',
            sessionId: 'rev-session-1'
          }
        }
      }
    })
    // A held clean verdict at the SAME round the control store recovers to
    // below, at the OLD head — the patch-carry check finds it, but the
    // injected `patchIdOf` never matches, so the comparison genuinely
    // fails and this round proceeds fresh, straight into the round cap.
    seedCleanHeldRound(world, ROUND, HELD_HEAD)

    mkdirSync(controlDir(world), { recursive: true })
    writeFileSync(
      join(controlDir(world), 'loop-state.json'),
      JSON.stringify({
        version: 1,
        kind: 'loop_state',
        task: world.task,
        round: ROUND,
        phase: 'dispatch_developer',
        pauseReason: null,
        budgets: { mechanicalRetries: 0, reviewRounds: ROUND, infrastructureRetries: 0 },
        heldResult: null,
        deliveredFindings: null,
        recordedAt: new Date().toISOString()
      }),
      'utf8'
    )
    mkdirSync(developerDir(world, ROUND), { recursive: true })
    writeFileSync(
      join(developerDir(world, ROUND), CONFIDENCE_FILE_NAME),
      'CONFIDENCE: 90 — same code, already reviewed clean once\n'
    )

    const result = await runLoopInProcess(
      world,
      { task: world.task, agent: 'claude' },
      // Every patch id is distinct — never a match, a genuinely different
      // patch, never a proven-equivalent rebase.
      { patchIdOf: (s: string) => `patch-for-${s}` }
    )

    expect(result.finalDecision).toMatchObject({ type: 'pause', reason: 'max_rounds' })
    const detail = (result.finalDecision as { detail?: string }).detail ?? ''
    // `assessRound`'s own detail — untouched, never replaced.
    expect(detail).toContain(`max rounds: ${DEFAULT_REVIEW_POLICY.maxRounds}`)
    // The appended patch-carry note — the exact comparison this driver
    // made and why it did NOT carry the held round forward.
    expect(detail).toContain('held clean verdict from round 4')
    expect(detail).toContain(`does not cover the current head ${NEW_HEAD}`)
    expect(detail).toContain(HELD_HEAD)
    expect(detail).toContain('starting a fresh round')
    // A real, fresh round-4 dispatch DID happen — this is not the "already
    // published" short-circuit.
    expect(world.dispatchCountByRole['code-reviewer']).toBe(1)
  })
})
