/**
 * In-process tests for issue-711 (O1/O2/O3): a verdict judges a patch, so
 * the loop carries a held or already-published clean verdict across a head
 * move that leaves the pull request's own patch unchanged, and starts a
 * fresh round when it doesn't. See `dev-review-loop-harness.ts` for what
 * the harness does and does not fake. `world.postedComments` bodies are
 * always empty on the fake `publishRound` (a driver-side re-fetch/re-verify
 * concern the harness deliberately leaves real-process-only — see its own
 * doc comment); these tests assert on `publishedRounds`/`dispatchCountByRole`
 * instead, the signals the fake genuinely carries.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import {
  briefHash,
  DEFAULT_REVIEW_POLICY,
  objectivesOf,
  objectivesVersion,
  policyDigest,
  type Objective
} from '@attalabs/aeg-core'
import { renderCodeReviewComment, renderSecurityComment } from '../../../src/commands/review-post.js'
import { writeHeldVerdict } from '../../../src/lib/dev-review-loop/reviewer-dispatch.js'
import type { LoopDeps } from '../../../src/lib/dev-review-loop.js'
import { CONFIDENCE_FILE_NAME } from '../../../src/lib/dev-review-loop.js'
import {
  cleanupWorlds,
  controlDir,
  developerDir,
  makeWorld,
  runLoopInProcess,
  sha,
  type LoopWorld
} from '../dev-review-loop-harness.js'

afterEach(cleanupWorlds)

const DEFAULT_POLICY_DIGEST = policyDigest(DEFAULT_REVIEW_POLICY)
const TOKENS = { model: 'claude', tokensIn: '10', tokensOut: '5', cost: '—' }

/**
 * Seeds round 1's held reviewer+security pair on disk, both APPROVE/PASS,
 * judged at `headSha` — every other field (objectives version, brief hash,
 * ruling ordinal, policy digest, base) computed from `world`'s own default
 * facts via the SAME pure functions the driver itself resolves them
 * through, so the loop's own field-complete manifest comparison agrees on
 * every field except head. Rendered by the SAME `renderCodeReviewComment`/
 * `renderSecurityComment` `buildVerdictFromReport` calls in production
 * (`dev-review-loop.test.ts`'s own O2 acceptance test uses the identical
 * pattern for the merge gate side of this fact).
 */
function seedCleanHeldRound1(world: LoopWorld, headSha: string): void {
  const parsed = objectivesOf(world.frozenBrief)
  const objectives: Objective[] = parsed.ok ? parsed.objectives : []
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
  writeHeldVerdict(world.runtimeDir, world.task, 1, 'reviewer', reviewerBody)
  writeHeldVerdict(world.runtimeDir, world.task, 1, 'security', securityBody)
}

describe('devReviewLoop — issue-711 O1: a held-but-unpublished clean verdict carries a patch-identical head move', () => {
  it('publishes the held round directly — no reviewer dispatch, no fresh round', async () => {
    const HELD_HEAD = sha('a')
    const NEW_HEAD = sha('c')
    const world = makeWorld({ developerPushed: true, head: NEW_HEAD })
    seedCleanHeldRound1(world, HELD_HEAD)

    const result = await runLoopInProcess(
      world,
      { task: world.task, agent: 'claude' },
      { patchIdOf: (s: string) => (s === HELD_HEAD || s === NEW_HEAD ? 'same-patch' : null) }
    )

    expect(result.finalDecision).toEqual({ type: 'publish' })
    expect(world.publishedRounds).toEqual([1])
    // No reviewer/security dispatch at all — the round never re-ran.
    expect(world.dispatchCountByRole['code-reviewer']).toBeUndefined()
    expect(world.dispatchCountByRole.security).toBeUndefined()
  })

  it('a genuinely different (non patch-identical) head starts a fresh round instead (O2)', async () => {
    const HELD_HEAD = sha('a')
    const NEW_HEAD = sha('c')
    const world = makeWorld({ developerPushed: true, head: NEW_HEAD })
    seedCleanHeldRound1(world, HELD_HEAD)

    const result = await runLoopInProcess(
      world,
      { task: world.task, agent: 'claude' },
      // Every patch id is distinct — never a match, exactly like a real
      // `git patch-id --stable` would report for two genuinely different
      // diffs.
      { patchIdOf: (s: string) => `patch-for-${s}` }
    )

    expect(result.finalDecision).toEqual({ type: 'publish' })
    // A fresh round DID run — round 1 is superseded, never reused.
    expect(world.dispatchCountByRole['code-reviewer']).toBe(1)
    expect(world.dispatchCountByRole.security).toBe(1)
    expect(world.publishedRounds).toEqual([1])
  })

  it('an unresolvable patch id on either side (git could not answer) never counts as a match — falls through to a fresh round', async () => {
    const HELD_HEAD = sha('a')
    const NEW_HEAD = sha('c')
    const world = makeWorld({ developerPushed: true, head: NEW_HEAD })
    seedCleanHeldRound1(world, HELD_HEAD)

    const result = await runLoopInProcess(
      world,
      { task: world.task, agent: 'claude' },
      // `null` is "cannot answer" — never treated as "they match."
      { patchIdOf: () => null }
    )

    expect(result.finalDecision).toEqual({ type: 'publish' })
    expect(world.dispatchCountByRole['code-reviewer']).toBe(1)
    expect(world.dispatchCountByRole.security).toBe(1)
  })
})

describe('devReviewLoop — issue-711 O1: an already-published clean verdict is treated as current across a patch-identical move', () => {
  it('returns publish with no new forge write at all — the round summary would otherwise mis-render from this process’s own empty history', async () => {
    const HELD_HEAD = sha('a')
    const NEW_HEAD = sha('c')
    const world = makeWorld({ developerPushed: true, head: NEW_HEAD })
    seedCleanHeldRound1(world, HELD_HEAD)

    const fetchLoopHistory: LoopDeps['fetchLoopHistory'] = () => ({
      rounds: [],
      totalWallMs: 0,
      totalFilesChanged: 0,
      summaryUrl: 'https://forge.example/pr/1#issuecomment-1',
      journalFinalized: { result: 'merged_ready' }
    })

    const result = await runLoopInProcess(
      world,
      { task: world.task, agent: 'claude' },
      {
        patchIdOf: (s: string) => (s === HELD_HEAD || s === NEW_HEAD ? 'same-patch' : null),
        fetchLoopHistory
      }
    )

    expect(result.finalDecision).toEqual({ type: 'publish' })
    expect(world.dispatchCountByRole['code-reviewer']).toBeUndefined()
    expect(world.dispatchCountByRole.security).toBeUndefined()
    // Already on the forge — this run posts nothing new.
    expect(world.postedComments).toEqual([])
    expect(world.publishedRounds).toEqual([])
  })
})

describe('devReviewLoop — issue-711 O2: a just-posted verdict still binds by exact head identity, never a patch tolerance', () => {
  it('round 1 clean at HEAD publishes under HEAD exactly — patchIdOf is never even consulted for the ordinary same-round publish', async () => {
    const HEAD = sha('d')
    const world = makeWorld({ head: HEAD })
    let patchIdOfCalled = false

    const result = await runLoopInProcess(
      world,
      { task: world.task, agent: 'claude' },
      {
        patchIdOf: () => {
          patchIdOfCalled = true
          return null
        }
      }
    )

    expect(result.finalDecision).toEqual({ type: 'publish' })
    expect(world.publishedRounds).toEqual([1])
    // The ordinary round-1 dispatch → verdicts → publish path never reaches
    // for patch tolerance at all — nothing is being carried across a move.
    expect(patchIdOfCalled).toBe(false)
  })
})

describe('devReviewLoop — issue-711 O1: an older held round never carries past a newer one already established', () => {
  it('a held round 1 pair is ignored once other recovery has already advanced past it', async () => {
    const HELD_HEAD = sha('a')
    const NEW_HEAD = sha('c')
    const world = makeWorld({ developerPushed: true, head: NEW_HEAD })
    seedCleanHeldRound1(world, HELD_HEAD)

    // Round 2 already dispatched/held per the control store — the same
    // signal `recoverLoopState` reads to advance `round` past 1 before this
    // task's own patch-carry check ever runs.
    mkdirSync(controlDir(world), { recursive: true })
    writeFileSync(
      join(controlDir(world), 'loop-state.json'),
      JSON.stringify({
        version: 1,
        kind: 'loop_state',
        task: world.task,
        round: 2,
        phase: 'dispatch_developer',
        pauseReason: null,
        budgets: { mechanicalRetries: 0, reviewRounds: 2, infrastructureRetries: 0 },
        heldResult: null,
        deliveredFindings: null,
        recordedAt: new Date().toISOString()
      }),
      'utf8'
    )
    // Round ≥ 2's own gate check reads a confidence file the developer
    // would normally write; an attach never dispatches the developer at
    // all, so it's pre-seeded here — the identical setup the O9
    // crash-recovery fixture (`dev-review-loop.test.ts`) uses for its own
    // round-2 reattach.
    mkdirSync(developerDir(world, 2), { recursive: true })
    writeFileSync(
      join(developerDir(world, 2), CONFIDENCE_FILE_NAME),
      'CONFIDENCE: 90 — same code, already reviewed clean once\n'
    )

    const result = await runLoopInProcess(
      world,
      { task: world.task, agent: 'claude' },
      { patchIdOf: (s: string) => (s === HELD_HEAD || s === NEW_HEAD ? 'same-patch' : null) }
    )

    expect(result.finalDecision).toEqual({ type: 'publish' })
    // A fresh round ran (round 2, per the recovered control-store round) —
    // the stale round-1 held pair was never carried forward past it.
    expect(world.dispatchCountByRole['code-reviewer']).toBe(1)
    expect(world.dispatchCountByRole.security).toBe(1)
  })
})
