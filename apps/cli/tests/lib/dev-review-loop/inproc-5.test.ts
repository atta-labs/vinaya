/**
 * In-process conversion of one slice of `dev-review-loop.test.ts` (the
 * O1–O9 infrastructure-pause/resume/attach fixtures) — see
 * `dev-review-loop-harness.ts` for the shared in-process driver harness.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { newestPrincipalRulingOrdinal } from '@attalabs/aeg-core'
import {
  cleanupWorlds,
  controlDir,
  developerDir,
  developerLeavesWorkDeps,
  developerPublishesViaToolsDeps,
  makeInProcessDeps,
  makeWorld,
  outboxLines,
  roundDir,
  runLoopInProcess,
  type LoopWorld
} from '../dev-review-loop-harness.js'
import type { LoopDeps } from '../../../src/lib/dev-review-loop.js'
import { CONFIDENCE_FILE_NAME } from '../../../src/lib/dev-review-loop.js'
import {
  prBodyPathFor,
  readDeveloperPublicationRecord,
  writeDeveloperPublicationRecord
} from '../../../src/lib/dev-review-loop/developer-publication.js'
import type { DispatchHandle } from '../../../src/lib/dispatch.js'

afterEach(cleanupWorlds)

function escalationRecordPath(world: LoopWorld, round: number, head: string): string {
  return join(controlDir(world), 'escalation', `${world.task}-${round}-${head}.json`)
}

/** The ruling marker a pause comment prints, read back through the SAME parser `task_resume`/`task_cancel` authenticate with — so a marker whose slots disagree with that parser cannot pass. */
function parsedMarkerOrdinal(body: string): number {
  const marker = body.split('\n').find((l) => l.startsWith('<!-- aeg:principal:ruling:')) ?? ''
  return newestPrincipalRulingOrdinal([{ body: marker, author: 'principal-1' }], ['principal-1'])
}

function fakeHandle(resumeId: string | null, effectId: string): DispatchHandle {
  return { exitCode: 0, durationMs: 1, usage: { input: 10, output: 5 }, resumeId, timedOut: false, effectId }
}

/**
 * Wraps the world's own default deps so a test can read the exact prompt
 * text and resume id each developer dispatch received, without changing any
 * of the default push/PR/reviewer behaviour those deps already provide.
 */
function withCapturedDeveloperDispatch(
  world: LoopWorld,
  extra: Partial<LoopDeps> = {}
): { deps: Partial<LoopDeps>; prompts: string[]; resumeIds: Array<string | undefined> } {
  const base = makeInProcessDeps(world)
  const prompts: string[] = []
  const resumeIds: Array<string | undefined> = []
  const dispatchRole: LoopDeps['dispatchRole'] = async (role, agent, prompt, opts) => {
    if (role === 'developer') {
      prompts.push(prompt)
      resumeIds.push(opts.resumeId)
    }
    return base.dispatchRole!(role, agent, prompt, opts)
  }
  return { deps: { ...base, dispatchRole, ...extra }, prompts, resumeIds }
}

/**
 * Full replacement for the developer half of `dispatchRole` — for scenarios
 * where the default world-backed fake's "any developer dispatch pushes"
 * rule does not fit (a developer turn that produces no push at all, or one
 * whose push/PR-open only takes effect from a later call). Reviewer/security
 * dispatch is left on the world's own default behaviour.
 */
function controlledDeveloperDeps(
  world: LoopWorld,
  opts: { pushAfterCall?: number; openPrAfterCall?: number } = {}
): { deps: Partial<LoopDeps>; prompts: string[]; resumeIds: Array<string | undefined> } {
  const base = makeInProcessDeps(world)
  const prompts: string[] = []
  const resumeIds: Array<string | undefined> = []
  let devCalls = 0
  const dispatchRole: LoopDeps['dispatchRole'] = async (role, agent, prompt, dOpts) => {
    if (role !== 'developer') return base.dispatchRole!(role, agent, prompt, dOpts)
    devCalls += 1
    prompts.push(prompt)
    resumeIds.push(dOpts.resumeId)
    if (opts.pushAfterCall !== undefined && devCalls >= opts.pushAfterCall) world.developerPushed = true
    world.dispatchCountByRole.developer = devCalls
    const sessionId = 'dev-session-fresh'
    world.dispatches.push({ role, round: dOpts.round ?? 1, resumeId: sessionId })
    return fakeHandle(sessionId, `eff-dev-${devCalls}`)
  }
  const findOpenPrForBranch: LoopDeps['findOpenPrForBranch'] = (branch) => {
    const eligible = opts.openPrAfterCall !== undefined ? devCalls >= opts.openPrAfterCall : world.developerPushed
    return eligible ? { number: world.prNumber, branch } : null
  }
  return { deps: { ...base, dispatchRole, findOpenPrForBranch }, prompts, resumeIds }
}

// --- O1 (#595): one failing CI check never ends the driver ---

describe('devReviewLoop — O1 (#595): one failing CI check never ends the driver', () => {
  it('yields one developer resume naming the failing check, then a live driver that runs to publish once it is fixed', async () => {
    const world = makeWorld({
      gate: 'red',
      failingCheckRuns: [{ id: 1, name: 'evidence-fresh', conclusion: 'failure' }]
    })
    const { deps, prompts } = withCapturedDeveloperDispatch(world, {
      fetchCiConclusion: () => ((world.dispatchCountByRole.developer ?? 0) >= 2 ? 'green' : 'red'),
      fetchFailingCheckRuns: () =>
        (world.dispatchCountByRole.developer ?? 0) >= 2
          ? []
          : ([{ id: 1, name: 'evidence-fresh', conclusion: 'failure' }] as never),
      // The head-change poll after a gate-red retry needs a REAL change —
      // the fixture's stand-in for "the developer fixed the check and
      // pushed" once its resumed turn actually ran.
      resolveHead: () => ((world.dispatchCountByRole.developer ?? 0) >= 2 ? 'c'.repeat(40) : world.head)
    })
    const result = await runLoopInProcessSafe(world, deps)

    // A live driver that ran to completion — never a crash, never a pause.
    expect(result.finalDecision.type).toBe('publish')

    // Exactly one developer resume for the red gate: round 1's own fresh
    // dispatch is prompts[0], and the ONE gate-red retry that names the
    // failing check is prompts[1] — never a third.
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toMatch(/evidence-fresh/)
    expect(prompts[1]).toMatch(/`git push`/)

    // Never a pause of any kind — this run reaches a clean publish.
    expect(existsSync(join(controlDir(world), 'pause-state.json'))).toBe(false)
  })
})

// --- a stale Premise pin pauses like a red gate, never a driver exit (O4) ---

describe('devReviewLoop — a stale Premise pin pauses like a red gate, never a driver exit (O4)', () => {
  it('produces one developer resume naming the failing premise line, then a decided pause naming that same failure — never an uncaught exit', async () => {
    const world = makeWorld({
      gate: 'green',
      prBody: `**Premise:**\n- pinned.ts contains: OLD_SYMBOL\n\nCloses #${9001}`
    })
    // The premise's own pin target — `reassertPrBodyPremise`'s default file
    // reader resolves paths relative to `process.cwd()`, which
    // `runLoopInProcess` points at `world.repoRoot` for the run. Never
    // contains `OLD_SYMBOL` — the fixture's stand-in for "the head deleted
    // it since the brief was authored."
    writeFileSync(join(world.repoRoot, 'pinned.ts'), 'export const CURRENT_SYMBOL = 1\n')

    const { deps, prompts } = withCapturedDeveloperDispatch(world)
    const result = await runLoopInProcessSafe(world, deps, { gatePollMaxAttempts: 2, gatePollIntervalMs: 5 })

    // A clean, decided pause — never an uncaught crash. The same premise
    // mismatch ended two consecutive attempts, so it is the repeat-failure
    // stop that fires, naming the failure rather than the generic stall.
    expect(result.finalDecision.type).toBe('pause')
    expect((result.finalDecision as { reason: string }).reason).toBe('repeat_failure')
    expect((result.finalDecision as { detail: string }).detail).toMatch(/dispatch-gate premise:/)

    // The developer's SECOND turn (the first resume — round 1's own fresh
    // push-and-open dispatch is prompts[0]) is where the premise failure
    // first reaches it: one resume, naming the exact failing line.
    const premisePrompt = prompts[1] as string
    expect(premisePrompt).toMatch(/CI is red on the last head/)
    expect(premisePrompt).toMatch(/dispatch-gate premise:/)
    expect(premisePrompt).toMatch(/pinned\.ts/)
    expect(premisePrompt).toMatch(/OLD_SYMBOL/)
    expect(premisePrompt).toMatch(/`git push`/)

    const pauseState = JSON.parse(readFileSync(join(controlDir(world), 'pause-state.json'), 'utf8')) as Record<
      string,
      unknown
    >
    expect(pauseState.reason).toBe('repeat_failure')

    const pauseComment = world.postedComments.find((c) => c.marker === '<!-- aeg:loop:paused:repeat_failure -->')
    expect(pauseComment).toBeDefined()
    expect((pauseComment as { body: string }).body).toMatch(/dispatch-gate premise:/)
  })
})

// --- O2 (#543): unpushed-work resume, then no_push, distinct from a genuinely idle stall ---

describe('devReviewLoop — O2 (#543): unpushed real work is resumed once, then no_push — never folded into the generic infrastructure stall', () => {
  it('resumes once with a commit-and-push instruction, records the resume comment, then pauses (no_push) naming the branch and the dirty file', async () => {
    const world = makeWorld({ gate: 'red' })
    const { deps, prompts } = withCapturedDeveloperDispatch(world, {
      readUnpushedWorkDetail: () => ({ dirtyFiles: ['smoke.ts'], aheadCount: 0 })
    })
    const result = await runLoopInProcessSafe(world, deps, { gatePollMaxAttempts: 2, gatePollIntervalMs: 5 })

    expect(result.finalDecision.type).toBe('pause')
    expect((result.finalDecision as { reason: string }).reason).toBe('no_push')

    // Exactly one commit-and-push resume: round 1's own fresh dispatch is
    // `prompts[0]`, the gate-red retry that discovers the dirty worktree is
    // `prompts[1]`, and the ONE commit-and-push resume this triggers is
    // `prompts[2]` — never a fourth (the base fixture proved this through
    // `.dev-prompt-3.txt` existing and `.dev-prompt-4.txt` not). The resume
    // prompt itself names the uncommitted changes and how to push them.
    expect(prompts).toHaveLength(3)
    // O7: a Claude Code Developer now holds its own forge credential, so the
    // resume prompt tells it to commit and push the work itself.
    expect(prompts[2]).toMatch(/left work that is not yet on the remote/)
    expect(prompts[2]).toMatch(/commit and push your changes yourself, on this SAME branch/)

    const pauseState = JSON.parse(readFileSync(join(controlDir(world), 'pause-state.json'), 'utf8')) as Record<
      string,
      unknown
    >
    expect(pauseState.reason).toBe('no_push')
    expect(pauseState.detail).toMatch(new RegExp(`branch ${world.branch.replace(/\//g, '\\/')}`))
    expect(pauseState.detail).toMatch(/smoke\.ts/)

    // The resume itself is recorded, once, as a marked PR comment.
    const resumeComment = world.postedComments.find((c) => c.marker === '<!-- aeg:loop:unpushed-work-resume -->')
    expect(resumeComment).toBeDefined()
    expect((resumeComment as { body: string }).body).toMatch(/unpushed_work_resume/)
    expect((resumeComment as { body: string }).body).toMatch(/smoke\.ts/)

    // The resume must ALSO land in the real `dev_review_loop` journal, not
    // only the marked PR comment above.
    const resumeEvent = outboxLines(world).find((l) => l.event === 'unpushed_work_resume') as
      | Record<string, unknown>
      | undefined
    expect(resumeEvent).toBeDefined()
    expect(resumeEvent?.kind).toBe('dev_review_loop')
    expect(resumeEvent?.branch).toBe(world.branch)
    expect(resumeEvent?.detail as string).toMatch(/smoke\.ts/)
  })

  it('a push that was made and never landed, twice, is the repeat-failure stop — naming the exact failure, not a dirty-file list', async () => {
    // A refused push — by a pre-push hook's own test run, or by the remote —
    // is what commits ahead of the remote with an unmoved head means. The
    // refusal text itself never leaves the developer's session, so the
    // message the loop matches and names is everything it CAN observe of
    // that push: the branch, the head that did not move, and the commits
    // waiting on it. Observed once before the resume and once after, and
    // identical both times, so the repeat stop fires rather than the
    // one-resume `no_push` rule.
    const world = makeWorld({ gate: 'red' })
    const { deps } = withCapturedDeveloperDispatch(world, {
      readUnpushedWorkDetail: () => ({ dirtyFiles: [], aheadCount: 2 })
    })
    const result = await runLoopInProcessSafe(world, deps, { gatePollMaxAttempts: 2, gatePollIntervalMs: 5 })

    expect(result.finalDecision).toMatchObject({ type: 'pause', reason: 'repeat_failure' })
    expect((result.finalDecision as { detail: string }).detail).toBe(
      `push never landed on ${world.branch}: head ${world.head} unchanged; 2 commit(s) ahead of the remote, worktree clean`
    )
    const conditions = outboxLines(world)
      .filter((l) => l.event === 'stop_condition_met')
      .map((l) => l.condition)
    expect(conditions).toContain('repeat_failure')
    const pauseState = JSON.parse(readFileSync(join(controlDir(world), 'pause-state.json'), 'utf8')) as Record<
      string,
      unknown
    >
    expect(pauseState.reason).toBe('repeat_failure')
    expect(pauseState.detail).toMatch(/push never landed/)
  })

  it('a worktree the developer never committed attempted no push, so it stays with the one-resume no_push rule', async () => {
    // The other half of the split: nothing is ahead of the remote, so no
    // push was ever made and there is no push failure to match — this is
    // `no_push`'s own case, unchanged, and no repeat-failure condition is
    // ever logged for it.
    const world = makeWorld({ gate: 'red' })
    const { deps } = withCapturedDeveloperDispatch(world, {
      readUnpushedWorkDetail: () => ({ dirtyFiles: ['smoke.ts'], aheadCount: 0 })
    })
    const result = await runLoopInProcessSafe(world, deps, { gatePollMaxAttempts: 2, gatePollIntervalMs: 5 })

    expect(result.finalDecision).toMatchObject({ type: 'pause', reason: 'no_push' })
    const conditions = outboxLines(world)
      .filter((l) => l.event === 'stop_condition_met')
      .map((l) => l.condition)
    expect(conditions).not.toContain('repeat_failure')
  })
})

describe('devReviewLoop — a resume that finds the branch already pushed and clean proceeds to reviewers (issue-894)', () => {
  it('O1: dirty before the resume, clean and nothing ahead after, remote at the same head — no pause, reviewers run', async () => {
    const world = makeWorld({ gate: 'red' })
    let reads = 0
    const { deps } = withCapturedDeveloperDispatch(world, {
      readUnpushedWorkDetail: () => {
        reads += 1
        return reads === 1 ? { dirtyFiles: ['smoke.ts'], aheadCount: 0 } : { dirtyFiles: [], aheadCount: 0 }
      },
      fetchCiConclusion: () => ((world.dispatchCountByRole.developer ?? 0) >= 3 ? 'green' : 'red'),
      fetchFailingCheckRuns: () => []
    })
    const result = await runLoopInProcessSafe(world, deps, { gatePollMaxAttempts: 2, gatePollIntervalMs: 5 })

    expect(result.finalDecision.type).not.toBe('pause')
    expect(world.reviewerDispatchStarted).toBe(true)
    expect(existsSync(join(controlDir(world), 'pause-state.json'))).toBe(false)
  })

  it('O3: commits still ahead of the remote after the resume pause no_push, and the detail names the count', async () => {
    const world = makeWorld({ gate: 'red' })
    let reads = 0
    const { deps } = withCapturedDeveloperDispatch(world, {
      readUnpushedWorkDetail: () => {
        reads += 1
        return reads === 1 ? { dirtyFiles: ['a.ts'], aheadCount: 0 } : { dirtyFiles: [], aheadCount: 3 }
      }
    })
    const result = await runLoopInProcessSafe(world, deps, { gatePollMaxAttempts: 2, gatePollIntervalMs: 5 })

    expect(result.finalDecision).toMatchObject({ type: 'pause', reason: 'no_push' })
    expect((result.finalDecision as { detail: string }).detail).toBe(
      `branch ${world.branch}; 3 commit(s) ahead of the remote`
    )
    expect(world.reviewerDispatchStarted).toBe(false)
  })

  it('O2/O3: dirty files alone pause no_push without claiming any commits ahead', async () => {
    const world = makeWorld({ gate: 'red' })
    const { deps } = withCapturedDeveloperDispatch(world, {
      readUnpushedWorkDetail: () => ({ dirtyFiles: ['smoke.ts'], aheadCount: 0 })
    })
    const result = await runLoopInProcessSafe(world, deps, { gatePollMaxAttempts: 2, gatePollIntervalMs: 5 })

    expect(result.finalDecision).toMatchObject({ type: 'pause', reason: 'no_push' })
    const detail = (result.finalDecision as { detail: string }).detail
    expect(detail).toBe(`branch ${world.branch}; dirty file(s): smoke.ts`)
    expect(detail).not.toMatch(/ahead of the remote/)
  })
})

// --- O2 (task-files-v1 2, #649): the loop's two OLD worktree-root control-file names get no exemption any more ---

describe("devReviewLoop — O2 (task-files-v1 2, #649): the loop's two OLD worktree-root control-file names get no exemption any more", () => {
  it('a worktree dirty ONLY in the two old names now reads as real unpushed work — no_push, naming both stray files', async () => {
    const world = makeWorld({ gate: 'red' })
    const { deps } = withCapturedDeveloperDispatch(world, {
      readUnpushedWorkDetail: () => ({ dirtyFiles: ['.vinaya-confidence', '.vinaya-round-response'], aheadCount: 0 })
    })
    const result = await runLoopInProcessSafe(world, deps, { gatePollMaxAttempts: 2, gatePollIntervalMs: 5 })

    expect(result.finalDecision.type).toBe('pause')
    expect((result.finalDecision as { reason: string }).reason).toBe('no_push')

    const pauseState = JSON.parse(readFileSync(join(controlDir(world), 'pause-state.json'), 'utf8')) as Record<
      string,
      unknown
    >
    expect(pauseState.reason).toBe('no_push')
    expect(pauseState.detail).toMatch(/\.vinaya-confidence/)
    expect(pauseState.detail).toMatch(/\.vinaya-round-response/)

    expect(world.postedComments.some((c) => c.marker === '<!-- aeg:loop:unpushed-work-resume -->')).toBe(true)
  })

  it('one dirty file alongside the two old control-file names reads as unpushed too — no_push, naming all three', async () => {
    const world = makeWorld({ gate: 'red' })
    const { deps } = withCapturedDeveloperDispatch(world, {
      readUnpushedWorkDetail: () => ({
        dirtyFiles: ['smoke.ts', '.vinaya-confidence', '.vinaya-round-response'],
        aheadCount: 0
      })
    })
    const result = await runLoopInProcessSafe(world, deps, { gatePollMaxAttempts: 2, gatePollIntervalMs: 5 })

    expect(result.finalDecision.type).toBe('pause')
    expect((result.finalDecision as { reason: string }).reason).toBe('no_push')

    const pauseState = JSON.parse(readFileSync(join(controlDir(world), 'pause-state.json'), 'utf8')) as Record<
      string,
      unknown
    >
    expect(pauseState.reason).toBe('no_push')
    expect(pauseState.detail).toMatch(/smoke\.ts/)
    expect(pauseState.detail).toMatch(/\.vinaya-confidence/)
    expect(pauseState.detail).toMatch(/\.vinaya-round-response/)
  })
})

// --- O3 (#543): a reviewer report missing finding ids is resent once, then report_uncitable — never no_progress ---

describe('devReviewLoop — O3 (#543): a reviewer report missing finding ids is resent once, then report_uncitable — never no_progress', () => {
  it("resends once into a fresh work directory, records report_uncitable, and still dispatches the developer on this round's real BLOCKER — never stalls", async () => {
    const world = makeWorld()
    const base = makeInProcessDeps(world)
    let reviewerCalls = 0
    const dispatchRole: LoopDeps['dispatchRole'] = async (role, agent, prompt, opts) => {
      if (role !== 'code-reviewer') return base.dispatchRole!(role, agent, prompt, opts)
      reviewerCalls += 1
      const workDir = opts.extraWritableDirs?.[0]
      if (workDir) {
        mkdirSync(workDir, { recursive: true })
        writeFileSync(join(workDir, 'findings.txt'), 'BLOCKER|smoke.ts:1|deliberate, never cited\n')
        writeFileSync(join(workDir, 'objectives.txt'), 'O1|MET|done.\n')
        writeFileSync(
          join(workDir, 'report.txt'),
          'BRIEF_CONFORMANCE: yes\nSPEC_CONFORMANCE: yes\nSCOPE: small\nTESTS: pass\nDOCS: n/a\n'
        )
      }
      world.dispatchCountByRole['code-reviewer'] = reviewerCalls
      world.dispatches.push({ role, round: opts.round ?? 1, resumeId: `rev-session-${reviewerCalls}` })
      return fakeHandle(`rev-session-${reviewerCalls}`, `eff-rev-${reviewerCalls}`)
    }
    const result = await runLoopInProcessSafe(
      world,
      { ...base, dispatchRole },
      {
        gatePollMaxAttempts: 2,
        gatePollIntervalMs: 5
      }
    )

    // A real, un-cited BLOCKER still drives changes_requested → dispatch the
    // developer — this pauses only because the fixture's developer dispatch
    // never actually changes the head (the world's head is static), the
    // SAME infrastructure/gate-stall bound every other single-round fixture
    // hits, never `no_progress`.
    expect(result.finalDecision.type).toBe('pause')
    expect((result.finalDecision as { reason: string }).reason).not.toBe('no_progress')

    // Exactly two code-reviewer dispatches this round: the original, then
    // the one resend — never a third.
    expect(world.dispatchCountByRole['code-reviewer']).toBe(2)

    const uncitableComment = world.postedComments.find((c) => c.marker === '<!-- aeg:loop:report-uncitable -->')
    expect(uncitableComment).toBeDefined()
    expect((uncitableComment as { body: string }).body).toMatch(/report_uncitable: reviewer/)
  })
})

// --- O4: round-1 entry attaches to an open PR, resuming the recorded session ---

describe('devReviewLoop — round 1 entry attaches to an open PR, resuming the recorded session (O4)', () => {
  it('starts no developer on round 1, then resumes the pre-recorded session (never fresh) when round 2 needs one', async () => {
    const world = makeWorld({
      developerPushed: true,
      roleOutcomes: {
        1: {
          reviewer: {
            findings: 'BLOCKER|smoke.ts:1|deliberate round-1 blocker to force round 2',
            report: 'BRIEF_CONFORMANCE: yes\nSPEC_CONFORMANCE: yes\nSCOPE: small\nTESTS: pass\nDOCS: n/a\n',
            objectives: 'O1|MET|done.\n',
            sessionId: 'rev-session-1'
          }
        }
      }
    })
    const { deps, prompts, resumeIds } = withCapturedDeveloperDispatch(world, {
      readResumeRecord: () => ({
        resumeId: 'seeded-session-42',
        role: 'developer',
        agent: 'claude',
        repo: null,
        task: world.task,
        pr: null,
        round: null,
        effectId: 'seed',
        capturedAt: new Date().toISOString()
      })
    })
    // The resumed round-2 turn is what would realistically leave a
    // confidence answer behind for round 2's own gate — the fixture's fake
    // developer wrote it as part of that same turn; here the dispatch
    // itself writes it, the same real file the driver reads back.
    const innerDispatchRole = deps.dispatchRole!
    deps.dispatchRole = async (role, agent, prompt, opts) => {
      const handle = await innerDispatchRole(role, agent, prompt, opts)
      if (role === 'developer' && (opts.round ?? 1) >= 2) {
        mkdirSync(developerDir(world, opts.round ?? 1), { recursive: true })
        writeFileSync(
          join(developerDir(world, opts.round ?? 1), CONFIDENCE_FILE_NAME),
          'CONFIDENCE: 90 — addressed the round 1 blocker\n'
        )
      }
      return handle
    }
    const result = await runLoopInProcessSafe(world, deps)

    expect(result.finalDecision.type).toBe('publish')

    // Round 1 never dispatched a developer at all — attach skips straight to
    // the gate. The only developer dispatch is round 2's resumed one.
    expect(prompts).toHaveLength(1)
    expect(resumeIds).toEqual(['seeded-session-42'])
  })
})

// --- O4: a remote branch with no open PR resumes once to open it -----------

describe('devReviewLoop — a remote branch with no open PR resumes the recorded session once to open it (O4)', () => {
  it('dispatches the frozen brief fresh when the remote branch is still the commit-free default-branch ref', async () => {
    // O3: the branch sits at the commit-free ref AT the default tip —
    // `branchAtBaseTip`, the exact state the driver's `createTaskWorktree`
    // leaves it in — so `resolveHead` returns `world.base`, never a throw. The
    // dev's fresh turn then pushes real work (`world.head`, off the tip), so the
    // round-1 no-push equality check (`remoteHead === origin/main tip`) does not
    // fire and the loop publishes.
    const world = makeWorld({ branchAtBaseTip: true })
    const { deps, prompts, resumeIds } = withCapturedDeveloperDispatch(world)

    const result = await runLoopInProcessSafe(world, deps)

    expect(result.finalDecision.type).toBe('publish')
    expect(prompts).toHaveLength(1)
    expect(resumeIds).toEqual([undefined])
    expect(prompts[0]).toContain(world.frozenBrief)
    expect(prompts[0]).not.toMatch(/pushed but has no open pull request/)
    // Fresh dispatch, not a resume — the branch was created and seen at the tip,
    // then the pushed head moved it off the tip.
    expect(world.remoteBranchCreations).toEqual([world.branch])
  })

  it('dispatches the frozen brief fresh when the commit-free remote branch is behind the default branch', async () => {
    // O3: the default branch advanced after the driver created the branch, so
    // the commit-free ref (world.base) is now strictly BEHIND origin/main
    // (world's moved main). The round-1 entry's own `gitIsAncestor` still reads
    // it as carrying no task commits → fresh dispatch; the pushed head then
    // moves off the tip so the no-push equality check does not fire.
    const movedMain = 'e'.repeat(40)
    const world = makeWorld({ branchAtBaseTip: true })
    const { deps, prompts, resumeIds } = withCapturedDeveloperDispatch(world, {
      gitRevParseOriginMain: () => movedMain,
      gitIsAncestor: (ancestor, descendant) => ancestor === world.base && descendant === movedMain
    })

    const result = await runLoopInProcessSafe(world, deps)

    expect(result.finalDecision.type).toBe('publish')
    expect(prompts).toHaveLength(1)
    expect(resumeIds).toEqual([undefined])
    expect(prompts[0]).toContain(world.frozenBrief)
    expect(prompts[0]).not.toMatch(/pushed but has no open pull request/)
    expect(world.remoteBranchCreations).toEqual([world.branch])
  })

  it('never starts a fresh developer — resumes the pre-recorded session with the pr-create instruction, then waits for the PR', async () => {
    const world = makeWorld({ developerPushed: true })
    const { deps, prompts, resumeIds } = controlledDeveloperDeps(world, { openPrAfterCall: 1 })
    const result = await runLoopInProcessSafe(world, {
      ...deps,
      readResumeRecord: () => ({
        resumeId: 'seeded-session-7',
        role: 'developer',
        agent: 'claude',
        repo: null,
        task: world.task,
        pr: null,
        round: null,
        effectId: 'seed',
        capturedAt: new Date().toISOString()
      })
    })

    expect(result.finalDecision.type).toBe('publish')

    // Exactly one developer dispatch to open the PR — never a second, fresh one.
    expect(prompts).toHaveLength(1)
    expect(resumeIds).toEqual(['seeded-session-7'])

    // O11 (task-run-v1 21, #541): a resumed prompt's own first line is now
    // this run's task/branch/worktree/head context block, not the
    // instruction itself — that instruction still follows it, further down
    // the same prompt.
    const fullPrompt = prompts[0] as string
    expect(fullPrompt).toMatch(new RegExp(`^Resuming task Issue #${world.task}\\.$`, 'm'))
    expect(fullPrompt).toMatch(new RegExp(`^Branch: \`${world.branch}\`$`, 'm'))
    expect(fullPrompt).toMatch(new RegExp(`^Worktree: \`.*\\.worktrees/${world.branch}\`$`, 'm'))
    expect(fullPrompt).toMatch(/^Remote head: [0-9a-f]{40}$/m)
    // O6: the branch is pushed but has no PR — the Developer writes the body
    // file and the driver opens the PR; the Developer never opens it itself.
    expect(fullPrompt).toMatch(/pushed but has no open pull request/)
  })
})

// --- task-run-v1 3 (#482), O4: attach recovers a held REQUEST-CHANGES round from disk ---

const HELD_JUDGED_HEAD = 'c'.repeat(40)

function heldVerdictText(verdictLine: string): string {
  return `${verdictLine}\n\nJudged head: ${HELD_JUDGED_HEAD}\n\nFound something on the prior head.\n`
}

function setUpAttachRecoversHeldRound(): LoopWorld {
  const world = makeWorld({ developerPushed: true })
  mkdirSync(join(world.repoRoot, '.worktrees', world.branch), { recursive: true })
  return world
}

describe('devReviewLoop — attach recovers a held REQUEST-CHANGES round from disk (O4, task-run-v1 3, #482)', () => {
  it('a moved head dispatches round 2 reviewers directly — never redelivers round 1s held findings to the developer', async () => {
    const world = setUpAttachRecoversHeldRound()
    const { deps, prompts } = withCapturedDeveloperDispatch(world)

    // Round 1's held verdicts, still on disk — never posted — judged
    // against a head no longer the branch's current one (`world.head`).
    mkdirSync(roundDir(world, 1), { recursive: true })
    writeFileSync(join(roundDir(world, 1), 'reviewer.md'), heldVerdictText('VERDICT: REQUEST CHANGES'))
    writeFileSync(join(roundDir(world, 1), 'security.md'), heldVerdictText('VERDICT: FAIL'))

    // The confidence answer for round 2's gate — pre-seeded so this attach
    // never needs to dispatch a developer for it.
    mkdirSync(developerDir(world, 2), { recursive: true })
    writeFileSync(join(developerDir(world, 2), CONFIDENCE_FILE_NAME), 'CONFIDENCE: 90 — fixed round 1s blocker\n')

    const result = await runLoopInProcessSafe(world, deps)
    expect(result.finalDecision.type).toBe('publish')

    // No developer dispatch at all — round 1's held findings were never
    // redelivered, and round 2 never needed to ask for confidence either.
    expect(prompts).toHaveLength(0)

    // Reviewers really did run, at round 2 — the recovered round, not a
    // reset-to-round-1 re-review of the exact same (already-fixed) head.
    expect(existsSync(join(roundDir(world, 2), 'reviewer-work'))).toBe(true)
    expect(existsSync(join(roundDir(world, 2), 'security-work'))).toBe(true)
  })
})

describe('devReviewLoop — a second attach on the same unchanged head reads as no_progress, not another redelivery (O4, task-run-v1 3, #482)', () => {
  it('pauses on no_progress and dispatches nobody — never a third redelivery of round 1s findings', async () => {
    const world = setUpAttachRecoversHeldRound()
    const { deps, prompts } = withCapturedDeveloperDispatch(world)

    // Head UNCHANGED this time — round 1's judged sha matches the world's
    // own current head.
    mkdirSync(roundDir(world, 1), { recursive: true })
    writeFileSync(
      join(roundDir(world, 1), 'reviewer.md'),
      `VERDICT: REQUEST CHANGES\n\nJudged head: ${world.head}\n\nStill there.\n`
    )
    writeFileSync(
      join(roundDir(world, 1), 'security.md'),
      `VERDICT: FAIL\n\nJudged head: ${world.head}\n\nStill there.\n`
    )
    // A prior attach already redelivered round 1's findings once, on this
    // exact head, with no developer push in between.
    writeFileSync(join(roundDir(world, 1), 'attach-redelivered'), new Date().toISOString())

    const result = await runLoopInProcessSafe(world, deps)
    expect(result.finalDecision.type).toBe('pause')
    expect((result.finalDecision as { reason: string }).reason).toBe('no_progress')

    expect(prompts).toHaveLength(0)
    expect(existsSync(join(roundDir(world, 2), 'reviewer-work'))).toBe(false)
    expect(existsSync(join(roundDir(world, 2), 'security-work'))).toBe(false)

    // O3 ([task-log-v1] 9, Issue #631): this pause is decided by an OR of
    // two independent guard inputs — the comment now names which one
    // actually held.
    const pauseComment = world.postedComments[world.postedComments.length - 1] as { body: string }
    expect(pauseComment.body).toContain('local marker file present')
    expect(pauseComment.body).toContain('control-store delivered-findings identity absent')
  })
})

describe('devReviewLoop — the driver composes the round comment from a citation the developer left in its outbox, never posted itself', () => {
  it('reads FINDING_IDS from the round-2 Developer folder, cites them in the round-2 marker comment, and clears the file', async () => {
    const world = setUpAttachRecoversHeldRound()
    const { deps, prompts } = withCapturedDeveloperDispatch(world)

    mkdirSync(roundDir(world, 1), { recursive: true })
    writeFileSync(join(roundDir(world, 1), 'reviewer.md'), heldVerdictText('VERDICT: REQUEST CHANGES'))
    writeFileSync(join(roundDir(world, 1), 'security.md'), heldVerdictText('VERDICT: FAIL'))

    mkdirSync(developerDir(world, 2), { recursive: true })
    writeFileSync(join(developerDir(world, 2), CONFIDENCE_FILE_NAME), 'CONFIDENCE: 90 — fixed round 1s blocker\n')
    writeFileSync(join(developerDir(world, 2), '.vinaya-round-response'), 'FINDING_IDS: F1,F2\n')

    const result = await runLoopInProcessSafe(world, deps)
    expect(result.finalDecision.type).toBe('publish')

    // No developer dispatch at all — the citation came from the outbox
    // file, never from a comment the Developer itself posted.
    expect(prompts).toHaveLength(0)

    // The FIRST posted comment is the driver's own round-2 marker, carrying
    // the citation it read from the outbox file.
    const roundComment = world.postedComments[0] as { marker: string; body: string }
    expect(roundComment.marker).toBe('<!-- aeg:developer:round-2 -->')
    expect(roundComment.body).toMatch(/^FINDING_IDS: F1,F2$/m)

    // Read once, then cleared — a second attach on the same round must
    // never redeliver a stale citation from a prior round.
    expect(existsSync(join(developerDir(world, 2), '.vinaya-round-response'))).toBe(false)
  })
})

/**
 * O9 (task-run-v1 21, `#541`), [task-files-v1] 4 (Issue #651): round 1
 * genuinely concluded `changes_requested` and posted its own developer round
 * marker to the pull request — the durable record the round journal is now
 * rebuilt from, never a log event. There is deliberately no held-verdict
 * `.md` file here (unlike the fixtures above): the ONLY signal this attach
 * has that round 1 ever happened is the forge marker, read here through the
 * `fetchLoopHistory` seam the harness already exposes in place of a real
 * `gh` comment read.
 */
describe("devReviewLoop — O9 (task-run-v1 21, #541) / [task-files-v1] 4 (#651): attach reconstructs round numbering and the journal from the PR's own developer round marker, with no held-verdict file and no log event", () => {
  it('dispatches round 2 directly (never redelivers round 1) and publishes a two-row journal covering both rounds', async () => {
    const world = setUpAttachRecoversHeldRound()
    const { deps, prompts } = withCapturedDeveloperDispatch(world, {
      fetchLoopHistory: () =>
        ({
          rounds: [{ round: 1, countsBySeverity: {}, confidence: null, outcome: 'changes_requested' }],
          totalWallMs: 0,
          totalFilesChanged: 0,
          journalFinalized: null
        }) as never
    })
    const base = makeInProcessDeps(world)
    const publishedRoundNumbers: number[][] = []
    const publishRound: LoopDeps['publishRound'] = (root, input) => {
      publishedRoundNumbers.push(input.journal.rounds.map((r) => r.round))
      return base.publishRound!(root, input)
    }

    mkdirSync(developerDir(world, 2), { recursive: true })
    writeFileSync(join(developerDir(world, 2), CONFIDENCE_FILE_NAME), 'CONFIDENCE: 90 — fixed round 1s blocker\n')

    const result = await runLoopInProcessSafe(world, { ...deps, publishRound })
    expect(result.finalDecision.type).toBe('publish')

    // Round advanced to 2 from the PR's own round-1 developer marker alone —
    // no held-verdict file and no developer dispatch for this attach to
    // read instead.
    expect(existsSync(join(roundDir(world, 2), 'reviewer-work'))).toBe(true)
    expect(existsSync(join(roundDir(world, 2), 'security-work'))).toBe(true)
    expect(prompts).toHaveLength(0)

    // The published journal names both rounds — round 1 reconstructed from
    // its forge marker, round 2 computed live by this run.
    expect(publishedRoundNumbers[0]).toEqual(expect.arrayContaining([1, 2]))
  })
})

// --- task-run-v1 13 (#508): the developer's first turn ends with no push at all, resumed once (O2/O3) ---

describe("devReviewLoop — the developer's first turn ends with no push at all, resumed once (O2, task-run-v1 13, #508)", () => {
  it('resumes once with the push-and-open instructions before ever polling, then publishes once the resumed turn actually pushes', async () => {
    const world = makeWorld()
    const { deps, prompts } = controlledDeveloperDeps(world, { pushAfterCall: 2 })
    const result = await runLoopInProcessSafe(world, deps, { prPollMaxAttempts: 2, prPollIntervalMs: 5 })

    expect(result.finalDecision.type).toBe('publish')

    // Exactly two developer turns: the fresh brief, then ONE resume.
    expect(prompts).toHaveLength(2)

    const resumedPrompt = prompts[1] as string
    // O7: a Claude Code Developer now holds its own forge credential, so the
    // resume asks it to commit, push and open the pull request itself.
    expect(resumedPrompt).toMatch(/left no commit on this branch yet, and no open pull request/)
    expect(resumedPrompt).toMatch(/commit your work, push this branch and open \(or update\) its pull request yourself/)
  })
})

describe('devReviewLoop — the pull-request poll gives up naming what it waited for (O3, task-run-v1 13, #508)', () => {
  it('names branch, local head (unknown), remote head (none), and pull-request absence, after resuming once — a decided pause(infrastructure), never an uncaught crash (O6)', async () => {
    const world = makeWorld()
    const { deps } = controlledDeveloperDeps(world, {})
    const result = await runLoopInProcessSafe(world, deps, { prPollMaxAttempts: 2, prPollIntervalMs: 5 })

    expect(result.finalDecision.type).toBe('pause')
    expect((result.finalDecision as { reason: string }).reason).toBe('infrastructure')

    const pauseState = JSON.parse(readFileSync(join(controlDir(world), 'pause-state.json'), 'utf8')) as Record<
      string,
      unknown
    >
    expect(pauseState.reason).toBe('infrastructure')
    const detail = String(pauseState.detail)
    expect(detail).toMatch(new RegExp(`branch: ${world.branch.replace(/\//g, '\\/')}`))
    expect(detail).toMatch(/local head: \(worktree not found/)
    // O3 (#1046): the driver's `createTaskWorktree` leaves the branch at the
    // default tip (`world.base`), never missing — so the remote head reads as
    // that tip, not "(no head on origin)".
    expect(detail).toMatch(new RegExp(`remote head: ${world.base}`))
    expect(detail).toMatch(/pull request: none open/)

    // The PUBLIC PR comment gets a SEPARATELY sanitized detail — first line
    // only. The full multi-line breakdown above is a local-only fact.
    const pauseComment = world.postedComments.find((c) => c.marker === '<!-- aeg:loop:paused:infrastructure -->')
    expect(pauseComment).toBeDefined()
    const body = (pauseComment as { body: string }).body
    expect(body).toContain('no open PR appeared within the poll budget')
    expect(body).not.toMatch(/local head:/)
    expect(body).not.toMatch(/pull request: none open/)
  })
})

// --- task-run-v1 13 (#508), O9: a refusal/escalation before any push ends the loop at once ---

describe('devReviewLoop — a refusal/escalation posted before any push ends the loop at once (O9, task-run-v1 13, #508)', () => {
  it('never enters the pull-request poll, posts on the Issue (no PR exists yet), and exits non-zero', async () => {
    const world = makeWorld({
      developerStop: 'Entry gate refused: brief is missing tier/scope/stop-conditions.' as never
    })
    const { deps, prompts } = controlledDeveloperDeps(world, {})
    const result = await runLoopInProcessSafe(world, deps)

    expect(result.finalDecision.type).toBe('pause')
    expect((result.finalDecision as { reason: string }).reason).toBe('escalation')

    // Exactly one developer turn — the fresh brief — never a resume: O9
    // short-circuits before O2's own resume-once logic ever runs.
    expect(prompts).toHaveLength(1)

    const pauseFiles = world.postedComments.filter((c) => c.body.includes('aeg:loop:paused:escalation'))
    expect(pauseFiles).toHaveLength(1)
    const body = pauseFiles[0]!.body
    expect(body).toMatch(/^<!-- aeg:loop:paused:escalation -->$/m)
    expect(body).toMatch(/brief is missing tier\/scope\/stop-conditions/)
    // The one continuation this pause has, named in the address form that
    // actually works for it — this is a tranche task, whose Issue carries a
    // `vinaya/tranche:*` label, and `task run --issue <n>` is refused for one.
    // The tranche and ordinal come from the run's own branch.
    const branchParts = /^task\/([^/]+)\/([^/]+)$/.exec(world.branch)
    expect(branchParts).not.toBeNull()
    expect(body).toContain(`vinaya task run ${branchParts?.[1]} ${branchParts?.[2]}`)
    expect(body).not.toContain('<tranche>')
    expect(body).not.toContain('--issue')
    // No shipped command posts a ruling on an Issue, so the marker the
    // Principal must hand-write is named here or nothing can authorize this —
    // and it is asserted by feeding it back through the parser the authority
    // gates use, never as a literal, which is what let the two slots be
    // swapped while CI stayed green.
    expect(parsedMarkerOrdinal(body)).toBe(1)

    const pauseState = JSON.parse(readFileSync(join(controlDir(world), 'pause-state.json'), 'utf8')) as Record<
      string,
      unknown
    >
    expect(pauseState.reason).toBe('escalation')
    expect(pauseState.head).toBe('unknown')
    // No pull request exists, and the record says exactly that: a `-1`
    // sentinel here read as a real pull request to every consumer and reached
    // `gh pr view -1`, which no tool could recover from.
    expect(pauseState.prNumber).toBeNull()

    const recordPath = escalationRecordPath(world, 1, 'unknown')
    expect(existsSync(recordPath)).toBe(true)
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, unknown>
    expect(record.kind).toBe('escalation')
    expect(record.task).toBe(world.task)
    expect(record.round).toBe(1)
    expect(record.reason).toBe('escalation')
  })

  it("records the task ISSUE's own newest ruling ordinal as this pause's freshness baseline", async () => {
    // The gates `task_resume`/`task_cancel` apply to a pause like this compare
    // the Issue's live newest ordinal against the one recorded here. Recording
    // `0` unconditionally — which is what a pull-request-only read produces
    // when there is no pull request — made that comparison vacuous: any ruling
    // already on the Issue, including one an earlier pause already consumed,
    // would clear it. The baseline has to come from where the ruling will be.
    const world = makeWorld({
      developerStop: 'Entry gate refused: brief is missing tier/scope/stop-conditions.' as never
    })
    world.issueRulingOrdinal = 4
    const { deps } = controlledDeveloperDeps(world, {})
    await runLoopInProcessSafe(world, deps)

    const record = JSON.parse(readFileSync(escalationRecordPath(world, 1, 'unknown'), 'utf8')) as Record<
      string,
      unknown
    >
    expect(record.pr).toBeNull()
    expect(record.rulingOrdinal).toBe(4)

    // And the comment tells the Principal which ordinal to beat, since that is
    // now a real number rather than always zero — read back through the gates'
    // own parser, so the marker it prints is one they would accept.
    const pauseBody = world.postedComments.find((c) => c.body.includes('aeg:loop:paused:escalation'))?.body ?? ''
    expect(parsedMarkerOrdinal(pauseBody)).toBeGreaterThan(4)
  })

  it('writes NO escalation record when the Issue ruling baseline cannot be read, so both tools fail closed', async () => {
    // `0` is not a missing value for this field — it is the positive claim
    // "this Issue carries no rulings". A failed read never established that,
    // and recording it anyway reopens the vacuous freshness gate on nothing
    // more than a transient `gh` failure. So the read propagates, the
    // best-effort escalation write swallows it, and no record is written —
    // which is the state `task_resume` refuses as "no durable record" and
    // `task_cancel` refuses as a stale escalation. The pause itself is still
    // fully recorded, and its printed command needs no ruling at all.
    const world = makeWorld({
      developerStop: 'Entry gate refused: brief is missing tier/scope/stop-conditions.' as never
    })
    const { deps } = controlledDeveloperDeps(world, {})
    const result = await runLoopInProcessSafe(world, {
      ...deps,
      fetchNewestIssueRulingOrdinal: () => {
        throw new Error('gh issue view: could not reach the forge')
      }
    })

    expect(result.finalDecision.type).toBe('pause')
    expect(existsSync(escalationRecordPath(world, 1, 'unknown'))).toBe(false)

    // The pause record itself still lands, with no pull request.
    const pauseState = JSON.parse(readFileSync(join(controlDir(world), 'pause-state.json'), 'utf8')) as Record<
      string,
      unknown
    >
    expect(pauseState.reason).toBe('escalation')
    expect(pauseState.prNumber).toBeNull()
  })
})

// --- O3 (#1046): round-1 no-push fires on a branch at the default tip --------

describe('devReviewLoop — O3: round-1 no-push fires on a branch at the default tip, not only a missing one', () => {
  it('a round-1 turn that pushes nothing reaches the no-push outcome, with the branch modeled AT the default tip (never missing)', async () => {
    // The driver's `createTaskWorktree` leaves the branch at `origin/main`'s
    // tip — a commit-free ref, never a missing branch — before round 1. A
    // round-1 turn that pushes nothing leaves it there, so `resolveHead`
    // returns that tip rather than throwing. The no-push detection must still
    // fire, EXACTLY as it does for a missing branch: its equality check
    // (`remoteHead === origin/main tip`) holds, so this reaches the same O9
    // escalation a posted developer stop produces, in one turn, never a
    // resume-then-poll.
    const world = makeWorld({
      developerStop: 'Entry gate refused: brief is missing tier/scope/stop-conditions.' as never
    })
    const inproc = makeInProcessDeps(world)
    const headReads: string[] = []
    const { deps, prompts } = controlledDeveloperDeps(world, {})
    const result = await runLoopInProcessSafe(world, {
      ...deps,
      // Record what the remote head resolves to across the turn — proving the
      // branch is modeled AT the tip (a real `world.base`), never as a missing
      // branch that throws.
      resolveHead: (branch) => {
        const head = inproc.resolveHead!(branch)
        headReads.push(head)
        return head
      }
    })

    // The no-push outcome — the same escalation a missing branch reaches, in
    // exactly one developer turn (never a resume).
    expect(result.finalDecision.type).toBe('pause')
    expect((result.finalDecision as { reason: string }).reason).toBe('escalation')
    expect(prompts).toHaveLength(1)

    // The branch was created AND resolved AT the default tip (`world.base`) —
    // the commit-free ref the driver leaves it at — never a missing branch: the
    // after-turn read returned the tip rather than throwing.
    expect(world.remoteBranchCreations).toEqual([world.branch])
    expect(headReads).toContain(world.base)
  })
})

describe('devReviewLoop — the no-push-stop escalation comment is sanitized too (O9)', () => {
  it('redacts the credential and the different-user path from the developer stop comment before it reaches the public Issue comment', async () => {
    const world = makeWorld({
      developerStop:
        "Could not read '/Users/someone-else/config.json' — token=ghp_abcdefghijklmnopqrstuvwxyz012345 rejected." as never
    })
    const { deps } = controlledDeveloperDeps(world, {})
    const result = await runLoopInProcessSafe(world, deps)

    expect(result.finalDecision.type).toBe('pause')
    expect((result.finalDecision as { reason: string }).reason).toBe('escalation')

    const pauseFiles = world.postedComments.filter((c) => c.body.includes('aeg:loop:paused:escalation'))
    expect(pauseFiles).toHaveLength(1)
    const body = pauseFiles[0]!.body

    // The raw secret and the other user's path never reach the public
    // comment.
    expect(body).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz012345')
    expect(body).not.toContain('someone-else')
    expect(body).toContain('<redacted>')
    expect(body).toContain('~/config.json')
  })
})

// --- task-run-v1 13 (#508), O4/O6: mergeability blocks reviewer dispatch ---

describe('devReviewLoop — a conflicting head is sent back to the developer, never to a reviewer (O4/O6, task-run-v1 13, #508)', () => {
  it('reads mergeability before dispatching reviewers, names the conflicting file, and never starts a reviewer for this head', async () => {
    const world = makeWorld({
      mergeable: 'CONFLICTING',
      conflictingFiles: ['apps/cli/src/lib/dev-review-loop.ts']
    })
    const { deps, prompts } = withCapturedDeveloperDispatch(world)
    const result = await runLoopInProcessSafe(world, deps, { gatePollMaxAttempts: 2, gatePollIntervalMs: 5 })

    // The same unresolved conflict ended both retries, so the repeat-failure
    // stop names it rather than the generic stall bound reporting it.
    expect(result.finalDecision.type).toBe('pause')
    expect((result.finalDecision as { reason: string }).reason).toBe('repeat_failure')
    expect((result.finalDecision as { detail: string }).detail).toMatch(/conflict never resolved/)

    // No reviewer was ever dispatched — the conflict was caught before any
    // reviewer read this head.
    expect(world.dispatchCountByRole['code-reviewer']).toBeUndefined()

    // CI is never waited on for a head that starts this round already
    // CONFLICTING — mergeability is checked before `waitForGreenGate` ever
    // reads the gate.
    expect(outboxLines(world).some((l) => l.event === 'gate_result_read')).toBe(false)

    // The fresh brief, then two conflict-retry dispatches (the bound) —
    // never a reviewer prompt anywhere.
    expect(prompts).toHaveLength(3)

    const conflictPrompt = prompts[1] as string
    expect(conflictPrompt).toMatch(/behind the base in a way that conflicts/)
    expect(conflictPrompt).toMatch(/apps\/cli\/src\/lib\/dev-review-loop\.ts/)

    const pauseComment = world.postedComments.find((c) => c.marker === '<!-- aeg:loop:paused:repeat_failure -->')
    expect(pauseComment).toBeDefined()
    const body = (pauseComment as { body: string }).body
    expect(body).toMatch(/conflict never resolved/)
    expect(body).toMatch(/apps\/cli\/src\/lib\/dev-review-loop\.ts/)
  })
})

// --- shared runner --------------------------------------------------------

/** Thin wrapper so every test above shares one call shape for both the deps override and any extra `LoopDeps` fields (poll bounds, etc.) it needs to merge in. */
function runLoopInProcessSafe(world: LoopWorld, deps: Partial<LoopDeps>, extra: Partial<LoopDeps> = {}) {
  return runLoopInProcess(world, { task: world.task, agent: 'claude' }, { ...deps, ...extra })
}

// ---------------------------------------------------------------------------
// agent-confinement-v1/1 — the driver publishes each Developer turn
// ---------------------------------------------------------------------------

describe('devReviewLoop — the Developer publishes through the driver-run tools, not the driver (O4/O5)', () => {
  it('O4/O5: a turn that publishes through the tools lands the commit, push and PR, and the driver proceeds', async () => {
    const world = makeWorld({ worktreeExists: true })
    const result = await runLoopInProcess(
      world,
      { task: world.task, agent: 'codex' },
      developerPublishesViaToolsDeps(world, {
        header: 'Feat(cli): publish via the driver-run tools',
        changedPaths: ['apps/cli/src/lib/x.ts']
      })
    )
    expect(result.finalDecision.type).toBe('publish')
    // The commit, push and open all happened — but through the gate-backed
    // tools the agent called, not a driver-after-turn publish.
    expect(world.commits).toHaveLength(1)
    expect(world.commits[0]!.header).toBe('Feat(cli): publish via the driver-run tools')
    expect(world.pushes).toHaveLength(1)
    expect(world.prOpens).toHaveLength(1)
  })

  it('O4/O5: the same publish works for a Claude Developer (both agents publish only through the tools)', async () => {
    const world = makeWorld({ worktreeExists: true })
    const result = await runLoopInProcess(
      world,
      { task: world.task, agent: 'claude' },
      developerPublishesViaToolsDeps(world)
    )
    expect(result.finalDecision.type).toBe('publish')
    expect(world.pushes).toHaveLength(1)
    expect(world.prOpens).toHaveLength(1)
  })

  it('O4: a turn that leaves work unpublished is re-asked naming publish_changes, then left to the no_push net — the driver commits nothing', async () => {
    const world = makeWorld({ worktreeExists: true })
    // `developerLeavesWorkDeps` dirties the worktree but never calls a tool —
    // the driver no longer publishes it, so it stays unpublished.
    const result = await runLoopInProcess(world, { task: world.task, agent: 'codex' }, developerLeavesWorkDeps(world))
    expect(world.commits).toHaveLength(0)
    expect(world.pushes).toHaveLength(0)
    expect(world.prOpens).toHaveLength(0)
    expect(world.dispatchCountByRole.developer ?? 0).toBeGreaterThanOrEqual(2)
    const reask = world.dispatches.find(
      (dd) => dd.role === 'developer' && (dd.prompt ?? '').includes('publish_changes')
    )
    expect(reask).toBeDefined()
    expect(result.finalDecision.type).toBe('pause')
  })

  it('O5: a body-only fix publishes through update_pull_request_body and refresh_evidence, touching no commit', async () => {
    const world = makeWorld({ worktreeExists: true })
    // First, a normal turn publishes through the tools and opens the PR.
    await runLoopInProcess(world, { task: world.task, agent: 'codex' }, developerPublishesViaToolsDeps(world))
    expect(world.prOpened).toBe(true)
    const commitsAfterOpen = world.commits.length
    // Now drive the captured gate-backed context the way a body-only turn does:
    // update the body and refresh the Evidence block — no new commit or push.
    const ctx = world.devToolContext!
    const updated = await ctx.updatePullRequestBody('## Decisions\n\nRevised.\n\n## Scope\n\n**Tier:** 1\n')
    expect(updated.ok).toBe(true)
    const refreshed = await ctx.refreshEvidence()
    expect(refreshed.ok).toBe(true)
    expect(world.prBodyUpdates).toHaveLength(1)
    expect(world.evidenceRefreshes).toBe(1)
    expect(world.commits.length).toBe(commitsAfterOpen)
  })

  it('O3/O5: run_checks runs vinaya check --all through the driver-run tool, forge faked and gate real', async () => {
    const world = makeWorld({ worktreeExists: true })
    await runLoopInProcess(world, { task: world.task, agent: 'codex' }, developerPublishesViaToolsDeps(world))
    const ctx = world.devToolContext!
    const checked = await ctx.runChecks()
    expect(checked.ok).toBe(true)
    if (checked.ok) expect(checked.result.passed).toBe(true)
    expect(world.runChecksCalls).toBeGreaterThanOrEqual(1)
  })

  it('O3/O5: a Surface-violating publish_changes is refused by the gate in the driver, committing nothing', async () => {
    const world = makeWorld({ worktreeExists: true, surface: { in: ['apps/cli'], out: ['packages'] } })
    // The agent calls publish_changes with a path outside the task's Surface —
    // the publication-precondition gate runs IN THE DRIVER and refuses before
    // any commit, so nothing lands and no PR opens.
    await runLoopInProcess(
      world,
      { task: world.task, agent: 'codex' },
      developerPublishesViaToolsDeps(world, { changedPaths: ['packages/aeg-core/src/x.ts'] })
    )
    expect(world.commits).toHaveLength(0)
    expect(world.pushes).toHaveLength(0)
    expect(world.prOpens).toHaveLength(0)
  })
})

describe('devReviewLoop — a restart finishes an interrupted publication exactly once (agent-confinement-v1/1, O8)', () => {
  // Each restart seeds the branch as present on the remote with no open PR and a
  // durable publication record left at one of the three boundaries, then enters
  // the loop-start already-pushed path.
  function seedBody(world: LoopWorld): void {
    const bodyPath = prBodyPathFor(world.runtimeDir, world.task, 1)
    mkdirSync(join(bodyPath, '..'), { recursive: true })
    writeFileSync(bodyPath, '## Decisions\n\nNone.\n\n## Scope\n\n**Tier:** 1\n')
  }

  it('restart after the commit (not yet pushed) finishes by pushing and opening — no second commit', async () => {
    const world = makeWorld({ worktreeExists: true, remoteBranchExists: true, head: 'a'.repeat(40) })
    seedBody(world)
    writeDeveloperPublicationRecord(world.runtimeDir, world.task, {
      round: 1,
      preTurnHead: 'a'.repeat(40),
      commitSha: 'c'.repeat(40),
      pushed: false,
      prNumber: null
    })
    const result = await runLoopInProcess(world)
    expect(result.finalDecision.type).toBe('publish')
    expect(world.commits).toHaveLength(0) // the commit was already made before the crash
    expect(world.pushes).toHaveLength(1) // recovery pushes the recorded commit
    expect(world.prOpens).toHaveLength(1) // then opens the PR
    expect(readDeveloperPublicationRecord(world.runtimeDir, world.task)?.prNumber).toBe(world.prNumber)
  })

  it('a first-push restart resolves the recorded commit base and authorizes its protected paths', async () => {
    const commitSha = 'c'.repeat(40)
    const protectedPath = '.github/workflows/recovered.yml'
    const world = makeWorld({
      worktreeExists: true,
      remoteBranchExists: false,
      worktreeHead: commitSha
    })
    seedBody(world)
    writeDeveloperPublicationRecord(world.runtimeDir, world.task, {
      round: 1,
      preTurnHead: world.mergeBase,
      commitSha,
      pushed: false,
      prNumber: null
    })
    const deps = makeInProcessDeps(world)
    let resolveCalls = 0
    deps.resolveHead = () => {
      resolveCalls += 1
      if (resolveCalls === 1) return commitSha
      throw new Error('the remote branch disappeared before recovery push authorization')
    }
    const bases: string[] = []
    const pushedPaths: string[][] = []
    deps.gitWorktreeChangedPaths = (_worktree, base) => {
      bases.push(base)
      return [protectedPath]
    }
    deps.pushTaskBranch = (input) => {
      pushedPaths.push([...input.touchedPaths])
      return { ok: false, hook: true, refusal: `protected path refused: ${input.touchedPaths.join(', ')}` }
    }

    const result = await runLoopInProcess(world, { task: world.task, agent: 'codex' }, deps)

    expect(bases[0]).toBe(world.mergeBase)
    expect(pushedPaths[0]).toEqual([protectedPath])
    expect(result.finalDecision).toMatchObject({ type: 'pause', reason: 'infrastructure' })
  })

  it('restart after the push (not yet opened) finishes by opening only — no second commit or push', async () => {
    const world = makeWorld({ worktreeExists: true, remoteBranchExists: true, head: 'c'.repeat(40) })
    seedBody(world)
    writeDeveloperPublicationRecord(world.runtimeDir, world.task, {
      round: 1,
      preTurnHead: 'a'.repeat(40),
      commitSha: 'c'.repeat(40),
      pushed: true,
      prNumber: null
    })
    const result = await runLoopInProcess(world)
    expect(result.finalDecision.type).toBe('publish')
    expect(world.commits).toHaveLength(0)
    expect(world.pushes).toHaveLength(0)
    expect(world.prOpens).toHaveLength(1)
  })

  it('restart after the PR opened finishes by doing nothing — no second commit, push or open', async () => {
    // The PR is already open, so the loop attaches at start and never reaches
    // the recovery path at all.
    const world = makeWorld({ worktreeExists: true, developerPushed: true, prOpened: true, head: 'c'.repeat(40) })
    writeDeveloperPublicationRecord(world.runtimeDir, world.task, {
      round: 1,
      preTurnHead: 'a'.repeat(40),
      commitSha: 'c'.repeat(40),
      pushed: true,
      prNumber: world.prNumber
    })
    const result = await runLoopInProcess(world)
    expect(result.finalDecision.type).toBe('publish')
    expect(world.commits).toHaveLength(0)
    expect(world.pushes).toHaveLength(0)
    expect(world.prOpens).toHaveLength(0)
  })
})
