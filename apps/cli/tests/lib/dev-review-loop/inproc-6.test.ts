/**
 * In-process conversions of a slice of `dev-review-loop.test.ts`'s
 * subprocess-driven scenarios: the base-moves-past-this-driver (stale
 * driver) pause, mid-round invalidations (an objectives edit, a ruling, a
 * frozen-brief supersede landing between reviewer dispatch and assessment),
 * a clean head falling into conflict with the base while reviewers worked,
 * and an UNKNOWN mergeable answer being polled rather than trusted as a
 * final read. Driven through `runLoopInProcess`, never a spawned CLI
 * subprocess — see `dev-review-loop-harness.ts`'s own doc comment for why.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { objectivesOf, objectivesVersion, renderObjectives, type Objective } from '@attalabs/aeg-core'
import {
  cleanupWorlds,
  makeInProcessDeps,
  makeWorld,
  roundDir as ipRoundDir,
  runLoopInProcess,
  sha
} from '../dev-review-loop-harness.js'

afterEach(cleanupWorlds)

// --- O8: a base that moves past this driver's own code -----------------------

describe('devReviewLoop — a base that moves past this driver’s own code pauses stale_driver (O8, task-run-v1 13, #508)', () => {
  it('names both shas and pauses before this round’s own gate/reviewer logic ever runs', async () => {
    const world = makeWorld()
    const result = await runLoopInProcess(world, undefined, {
      // The base is unchanged until the developer's own first push lands,
      // then reads as moved on every later call — never pulled back, since
      // this fixture's `pullDefaultBranch` below always refuses.
      gitRevParseOriginMain: () => (world.developerPushed ? sha('c') : world.base),
      gitCommitsTouchingDriverPaths: () => ['dddddddddd Fix(cli): something touching the driver'],
      pullDefaultBranch: () => ({ ok: false, reason: 'no pull handler configured for this fixture' })
    })

    expect(result.finalDecision.type).toBe('pause')
    expect(result.finalDecision).toMatchObject({ reason: 'stale_driver' })
    const detail = (result.finalDecision as { detail?: string }).detail ?? ''
    expect(detail).toMatch(new RegExp(`base moved from ${world.base} to ${sha('c')}`))
    expect(detail).toMatch(/touching this driver's own code/)

    // Never reached round-1's own gate/reviewer logic — the developer's
    // fresh push is the only dispatch this run ever made.
    expect(world.dispatchCountByRole.developer).toBe(1)
    expect(world.dispatchCountByRole['code-reviewer']).toBeUndefined()
    expect(world.dispatchCountByRole.security).toBeUndefined()

    // The pause is the ONLY comment posted — no round marker precedes it,
    // since dispatch_reviewers (which posts that marker) never ran.
    expect(world.postedComments).toHaveLength(1)
    expect(world.postedComments[0]!.marker).toBe('<!-- aeg:loop:paused:stale_driver -->')
    expect(world.postedComments[0]!.body).toMatch(new RegExp(`base moved from ${world.base} to ${sha('c')}`))
  })
})

describe('devReviewLoop — a base that moves past this driver’s own code WHILE reviewers were working pauses stale_driver before publish (O8, task-run-v1 13, #508)', () => {
  it('catches staleness at the dispatch_reviewers → publish transition, not only at round entry', async () => {
    const world = makeWorld()
    const result = await runLoopInProcess(world, undefined, {
      // The base only moves once a reviewer/security dispatch has actually
      // begun — a clean round entry, unlike the sibling fixture above, where
      // the base is still exactly where it started.
      gitRevParseOriginMain: () => (world.reviewerDispatchStarted ? sha('e') : world.base),
      gitCommitsTouchingDriverPaths: () => ['ffffffffff Fix(cli): something touching the driver'],
      pullDefaultBranch: () => ({ ok: false, reason: 'no pull handler configured for this fixture' })
    })

    expect(result.finalDecision.type).toBe('pause')
    expect(result.finalDecision).toMatchObject({ reason: 'stale_driver' })
    const detail = (result.finalDecision as { detail?: string }).detail ?? ''
    expect(detail).toMatch(new RegExp(`base moved from ${world.base} to ${sha('e')}`))

    // Both reviewers genuinely ran (clean) — but the round never reached
    // publish: no verdict comment, no publish summary, nothing published.
    expect(world.dispatchCountByRole['code-reviewer']).toBe(1)
    expect(world.dispatchCountByRole.security).toBe(1)
    expect(world.publishedRounds).toHaveLength(0)

    // The round marker (posted before either reviewer dispatches) is
    // comment 1; the pause is comment 2.
    expect(world.postedComments).toHaveLength(2)
    expect(world.postedComments[1]!.marker).toBe('<!-- aeg:loop:paused:stale_driver -->')
  })
})

// --- O5: a clean head falls into conflict while reviewers worked -------------

describe('devReviewLoop — a clean head falls into conflict while reviewers worked (O5, task-run-v1 13, #508)', () => {
  it('discards the held verdicts, never publishes, and resumes the developer to resolve', async () => {
    const world = makeWorld()
    const base = makeInProcessDeps(world)
    const devPrompts: string[] = []
    let mergeableCalls = 0

    const result = await runLoopInProcess(world, undefined, {
      ...base,
      dispatchRole: async (role, agent, prompt, opts) => {
        if (role === 'developer') devPrompts.push(prompt)
        return base.dispatchRole!(role, agent, prompt, opts)
      },
      // Clean (MERGEABLE) for round entry and for the dispatch_reviewers
      // check; conflicting by the time publish re-checks it — the head fell
      // into conflict with the base while both reviewers were working.
      fetchMergeableState: (_pr) => {
        mergeableCalls += 1
        return mergeableCalls >= 3 ? 'CONFLICTING' : 'MERGEABLE'
      }
    })

    expect(result.finalDecision.type).toBe('pause')
    expect(result.finalDecision).toMatchObject({ reason: 'infrastructure' })
    const detail = (result.finalDecision as { detail?: string }).detail ?? ''
    expect(detail).toMatch(/conflict never resolved/)
    expect(world.publishedRounds).toHaveLength(0)

    // Both reviewers genuinely ran (mergeability was clean when THEY were
    // dispatched) — but their held verdicts must not survive the conflict
    // discovered right before publish.
    expect(existsSync(join(ipRoundDir(world, 1), 'reviewer.md'))).toBe(false)
    expect(existsSync(join(ipRoundDir(world, 1), 'security.md'))).toBe(false)

    // The SECOND developer dispatch is the conflict-retry resume — named
    // task/branch/worktree/head context and the exact commands expected.
    expect(devPrompts.length).toBeGreaterThanOrEqual(2)
    const conflictPrompt = devPrompts[1]!
    expect(conflictPrompt).toMatch(/behind the base in a way that conflicts/)
    expect(conflictPrompt).toMatch(new RegExp(`^Resuming task Issue #${world.task}\\.$`, 'm'))
    expect(conflictPrompt).toMatch(new RegExp(`^Branch: \`${world.branch}\`$`, 'm'))
    expect(conflictPrompt).toMatch(/^Worktree: `.*\.worktrees\//m)
    expect(conflictPrompt).toMatch(/^Remote head: [0-9a-f]{40}$/m)
    expect(conflictPrompt).toMatch(/`git merge origin\/main`/)
    expect(conflictPrompt).toMatch(/`git push`/)
  })
})

// --- O7: UNKNOWN is polled, never read as clean or conflicting ---------------

describe('devReviewLoop — an UNKNOWN mergeable answer is polled, never read as clean or conflicting (O7, task-run-v1 13, #508)', () => {
  it('keeps polling through UNKNOWN and publishes once it resolves MERGEABLE', async () => {
    const world = makeWorld()
    let reads = 0

    const result = await runLoopInProcess(world, undefined, {
      fetchMergeableState: (_pr) => {
        reads += 1
        return reads < 3 ? 'UNKNOWN' : 'MERGEABLE'
      },
      gatePollMaxAttempts: 5,
      gatePollIntervalMs: 1
    })

    expect(result.finalDecision.type).toBe('publish')

    // Genuinely polled more than once before resolving — never treated the
    // first (UNKNOWN) read as a final answer.
    expect(reads).toBeGreaterThanOrEqual(3)
  })
})

// --- O3: a mismatch lands between reviewer dispatch and assessment ----------

describe('devReviewLoop — an objectives edit lands between reviewer dispatch and assessment (O3)', () => {
  it('discards the round instead of holding or publishing, and pauses naming both versions and the superseding command', async () => {
    const world = makeWorld()
    const result = await runLoopInProcess(world, undefined, {
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

    expect(result.finalDecision.type).toBe('pause')
    expect(result.finalDecision).toMatchObject({ reason: 'objectives_changed' })
    const detail = (result.finalDecision as { detail?: string }).detail ?? ''
    expect(detail).toMatch(/objectives moved from .+ to midroundversion/)
    expect(detail).toMatch(/vinaya issue objectives edit 9001 --add "Also do this\." --reason "mid-round change"/)

    // Two posted comments — the round marker (posted before the mismatch is
    // even detected) and the pause — never a reviewer or security verdict:
    // nothing was ever held for round 1 to publish.
    expect(world.postedComments).toHaveLength(2)
    expect(world.postedComments[1]!.marker).toBe('<!-- aeg:loop:paused:objectives_changed -->')
    expect(world.postedComments[1]!.body).not.toMatch(/^VERDICT:/m)

    expect(existsSync(join(ipRoundDir(world, 1), 'reviewer.md'))).toBe(false)
    expect(existsSync(join(ipRoundDir(world, 1), 'security.md'))).toBe(false)
  })
})

describe('devReviewLoop — a ruling lands between reviewer dispatch and assessment (review-validity-v1 task 3, #477, O3)', () => {
  it('discards the round instead of holding or publishing, and pauses naming the ruling', async () => {
    const world = makeWorld()
    const result = await runLoopInProcess(world, undefined, {
      // 0 (unchanged) until reviewer dispatch has begun, then 1 — a new
      // ruling landed between dispatch and this round's own re-assessment.
      fetchNewestRulingOrdinal: (_pr) => (world.reviewerDispatchStarted ? 1 : 0)
    })

    expect(result.finalDecision.type).toBe('pause')
    expect(result.finalDecision).toMatchObject({ reason: 'ruling_posted' })
    const detail = (result.finalDecision as { detail?: string }).detail ?? ''
    expect(detail).toMatch(/ruling ordinal moved from 0 to 1/)
    expect(detail).toMatch(new RegExp(`ruling ${world.prNumber}-1`))

    expect(world.postedComments).toHaveLength(2)
    expect(world.postedComments[1]!.marker).toBe('<!-- aeg:loop:paused:ruling_posted -->')
    expect(world.postedComments[1]!.body).not.toMatch(/^VERDICT:/m)

    expect(existsSync(join(ipRoundDir(world, 1), 'reviewer.md'))).toBe(false)
    expect(existsSync(join(ipRoundDir(world, 1), 'security.md'))).toBe(false)
  })
})

describe('devReviewLoop — a frozen-brief supersede lands between reviewer dispatch and assessment (review-validity-v1 task 4, #478, O1/O2)', () => {
  const SUPERSEDED_BRIEF =
    '<!-- aeg:brief:v2 -->\nBrief hash: supersededhash\nSupersedes: earlier — clarified scope mid-round.\nDo the thing, revised.\n\n## Objectives\n\nO1. Do the thing.\n\n## Planner rationale\n\nOut of scope for facts.\n'

  it('discards the round instead of holding or publishing, and pauses naming both brief hashes', async () => {
    const world = makeWorld()
    const result = await runLoopInProcess(world, undefined, {
      // Unchanged until reviewer dispatch has begun, then the superseding
      // version — same `## Objectives` section on purpose, so only the
      // brief-hash binding (never the objectives-version one) actually fires.
      fetchFrozenBrief: (_task) => (world.reviewerDispatchStarted ? SUPERSEDED_BRIEF : world.frozenBrief)
    })

    expect(result.finalDecision.type).toBe('pause')
    expect(result.finalDecision).toMatchObject({ reason: 'brief_superseded' })
    const detail = (result.finalDecision as { detail?: string }).detail ?? ''
    expect(detail).toMatch(/brief hash moved from [0-9a-f]+ to [0-9a-f]+/)

    expect(world.postedComments).toHaveLength(2)
    expect(world.postedComments[1]!.marker).toBe('<!-- aeg:loop:paused:brief_superseded -->')
    expect(world.postedComments[1]!.body).not.toMatch(/^VERDICT:/m)

    expect(existsSync(join(ipRoundDir(world, 1), 'reviewer.md'))).toBe(false)
    expect(existsSync(join(ipRoundDir(world, 1), 'security.md'))).toBe(false)
  })
})
