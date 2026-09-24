/**
 * In-process conversions, slice 2 (Issue #709, O2): the review-input
 * manifest's merge-base binding and the reviewer-isolation (candidate/
 * scratch) mechanism, both driven through `devReviewLoop()` directly rather
 * than a spawned CLI process. See `dev-review-loop-harness.ts` for the
 * shared `LoopWorld`/`runLoopInProcess` machinery this file builds on.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DispatchHandle } from '../../../src/lib/dispatch.js'
import {
  CLEAN_REVIEWER,
  CLEAN_SECURITY,
  cleanupWorlds,
  makeWorld,
  roundDir as ipRoundDir,
  runLoopInProcess,
  sha
} from '../dev-review-loop-harness.js'

afterEach(cleanupWorlds)

describe('devReviewLoop — O4 (issue-657): the review-input manifest binds a merge base, never the raw default-branch tip', () => {
  it('a clean branch: the merge base equals the default branch tip, and the round still completes normally', async () => {
    const world = makeWorld({ base: sha('b'), mergeBase: sha('b') })
    const result = await runLoopInProcess(world)
    expect(result.finalDecision.type).toBe('publish')
  })

  it('a branch behind a moved default branch: the round still completes normally off the resolved merge base, never erroring on the mismatch between it and the tip', async () => {
    // `mergeBase` is a real ancestor OLDER than the default branch's own tip
    // (`base`) — the same "branched before the default branch moved on"
    // shape the subprocess fixture's `writeFakeGitMergeBaseBehindTip`
    // simulated with a scripted `git merge-base` answer.
    const world = makeWorld({ base: sha('b'), mergeBase: sha('d') })
    const result = await runLoopInProcess(world)
    expect(result.finalDecision.type).toBe('publish')
  })

  it('a non-ancestor / unresolvable merge base: the round pauses as infrastructure rather than binding a base that was never proven an ancestor of the head', async () => {
    const world = makeWorld()
    const result = await runLoopInProcess(
      world,
      { task: world.task, agent: 'claude' },
      {
        gitMergeBase: async () => {
          throw new Error('git merge-base: no common ancestor')
        }
      }
    )
    expect(result.finalDecision).toMatchObject({ type: 'pause', reason: 'infrastructure' })
  })
})

// issue-657, O4 wiring: `dev-review-loop.ts`'s own source-string assertions
// (round-1 dispatch reads `d.gitMergeBase`, the publish-time fallback
// rebuild resolves it the same way, `gitMergeBase` is a real Deps field
// defaulting to `resolveMergeBase`) are pure — no process, no world — and
// stay in the main file untouched.

function handle(resumeId: string | null, effectId: string): DispatchHandle {
  return { exitCode: 0, durationMs: 1, usage: { input: 8, output: 4 }, resumeId, timedOut: false, effectId }
}

/**
 * A `dispatchRole` override that behaves exactly like the harness's own
 * default fake for the developer role, but — for the two reviewer roles —
 * also records where it was dispatched from (`opts.cwd`, the isolated
 * scratch copy `dispatchReviewer` builds) and what it could read there,
 * mirroring the subprocess fixture's `writeFakeClaudeCapturingReviewerCwd`
 * (which wrote `cwd.txt`/`candidate-marker-seen.txt` via a real spawned
 * shell's own `$PWD`). `opts.cwd` is undefined whenever no candidate/scratch
 * copy was built this round (no local worktree yet, or a diverged one) —
 * the real driver then omits `cwd` from the dispatch entirely, so the
 * absence itself is the fact under test in that scenario.
 */
function dispatchRoleCapturingReviewerCwd(world: ReturnType<typeof makeWorld>) {
  let seq = 0
  return async (
    role: string,
    _agent: string,
    _prompt: string,
    opts: { round?: number; extraWritableDirs?: string[]; cwd?: string }
  ): Promise<DispatchHandle> => {
    const round = opts.round ?? 1
    world.dispatchCountByRole[role] = (world.dispatchCountByRole[role] ?? 0) + 1
    if (role === 'developer') {
      world.developerPushed = true
      world.dispatches.push({ role, round, resumeId: 'dev-session-1' })
      return handle('dev-session-1', `eff-dev-${++seq}`)
    }
    const workDir = opts.extraWritableDirs?.[0]
    const reviewRole = role === 'code-reviewer' ? 'reviewer' : 'security'
    const outcome = reviewRole === 'reviewer' ? CLEAN_REVIEWER : CLEAN_SECURITY
    if (workDir) {
      mkdirSync(workDir, { recursive: true })
      writeFileSync(join(workDir, 'findings.txt'), outcome.findings)
      writeFileSync(join(workDir, 'report.txt'), outcome.report)
      writeFileSync(join(workDir, 'objectives.txt'), outcome.objectives ?? '')
      if (opts.cwd) {
        writeFileSync(join(workDir, 'cwd.txt'), `${opts.cwd}\n`)
        try {
          const marker = readFileSync(join(opts.cwd, 'candidate-marker.txt'), 'utf8')
          writeFileSync(join(workDir, 'candidate-marker-seen.txt'), marker)
        } catch {
          // Same fallback the fixture's `cat ... || true` produced: the
          // target file still exists, just empty.
          writeFileSync(join(workDir, 'candidate-marker-seen.txt'), '')
        }
      } else {
        writeFileSync(join(workDir, 'cwd.txt'), '(no cwd override)\n')
        writeFileSync(join(workDir, 'candidate-marker-seen.txt'), '')
      }
    }
    world.dispatches.push({ role, round, resumeId: outcome.sessionId })
    return handle(outcome.sessionId, `eff-${reviewRole}-${++seq}`)
  }
}

describe('devReviewLoop — reviewers inspect one immutable candidate with isolated scratch space (#561)', () => {
  it('both reviewers this round dispatch against the SAME candidate content, from separate scratch directories, cleaned up once the round publishes (O1/O2/O3)', async () => {
    const world = makeWorld()
    // Seeds the developer's own local worktree — `buildVerifiedReviewerCandidate`
    // reads it from `<repoRoot>/.worktrees/<branch>` (`worktreePathForBranch()`),
    // the same convention a real developer's pushed worktree already
    // satisfies by the time reviewers dispatch.
    const worktreeDir = join(world.repoRoot, '.worktrees', world.branch)
    mkdirSync(worktreeDir, { recursive: true })
    writeFileSync(join(worktreeDir, 'candidate-marker.txt'), 'candidate content for round 1\n')

    const result = await runLoopInProcess(
      world,
      { task: world.task, agent: 'claude' },
      { dispatchRole: dispatchRoleCapturingReviewerCwd(world) as never }
    )
    expect(result.finalDecision.type).toBe('publish')

    const reviewerCwd = readFileSync(join(ipRoundDir(world, 1), 'reviewer-work', 'cwd.txt'), 'utf8').trim()
    const securityCwd = readFileSync(join(ipRoundDir(world, 1), 'security-work', 'cwd.txt'), 'utf8').trim()

    // O1/O2: distinct scratch directories, never the shared candidate
    // itself and never each other's.
    expect(reviewerCwd).not.toBe(securityCwd)
    expect(reviewerCwd).toMatch(new RegExp(`${ipRoundDir(world, 1)}/reviewer-scratch$`))
    expect(securityCwd).toMatch(new RegExp(`${ipRoundDir(world, 1)}/security-scratch$`))

    // O1: both reviewers read the identical candidate content.
    expect(readFileSync(join(ipRoundDir(world, 1), 'reviewer-work', 'candidate-marker-seen.txt'), 'utf8')).toBe(
      'candidate content for round 1\n'
    )
    expect(readFileSync(join(ipRoundDir(world, 1), 'security-work', 'candidate-marker-seen.txt'), 'utf8')).toBe(
      'candidate content for round 1\n'
    )

    // O3: the round's candidate and both scratch copies are gone once the
    // round published — nothing left over for a human, or the next round,
    // to find.
    expect(existsSync(join(ipRoundDir(world, 1), 'candidate'))).toBe(false)
    expect(existsSync(reviewerCwd)).toBe(false)
    expect(existsSync(securityCwd)).toBe(false)
  })

  it('restart cleanliness: a candidate/scratch directory left by a crashed prior run is gone before this run dispatches anything (O3)', async () => {
    const world = makeWorld()
    const staleCandidate = join(ipRoundDir(world, 9), 'candidate')
    mkdirSync(staleCandidate, { recursive: true })
    writeFileSync(join(staleCandidate, 'leftover.txt'), 'from a crashed prior run')
    const staleScratch = join(ipRoundDir(world, 9), 'reviewer-scratch')
    mkdirSync(staleScratch, { recursive: true })

    const result = await runLoopInProcess(world)
    expect(result.finalDecision.type).toBe('publish')
    expect(existsSync(staleCandidate)).toBe(false)
    expect(existsSync(staleScratch)).toBe(false)
  })

  it("a local worktree whose own head has diverged from the round's resolved candidate sha is never copied — no candidate, no scratch cwd (round 2 review, MAJOR)", async () => {
    // `worktreeHead` (faked `readWorktreeHead`'s answer) differs from `head`
    // (the round's resolved candidate sha) — the exact "pushed, then moved
    // on locally" case the subprocess fixture's `writeFakeGitWorktreeHeadDiverged`
    // simulated by scripting `git -C <dir> rev-parse HEAD` to answer a
    // different sha than the pushed one.
    const world = makeWorld({ worktreeHead: sha('c') })
    const worktreeDir = join(world.repoRoot, '.worktrees', world.branch)
    mkdirSync(worktreeDir, { recursive: true })
    writeFileSync(join(worktreeDir, 'candidate-marker.txt'), 'stale local content\n')

    const result = await runLoopInProcess(
      world,
      { task: world.task, agent: 'claude' },
      { dispatchRole: dispatchRoleCapturingReviewerCwd(world) as never }
    )
    expect(result.finalDecision.type).toBe('publish')

    // No candidate was ever built from the diverged worktree.
    expect(existsSync(join(ipRoundDir(world, 1), 'candidate'))).toBe(false)
    expect(existsSync(join(ipRoundDir(world, 1), 'reviewer-scratch'))).toBe(false)
    expect(existsSync(join(ipRoundDir(world, 1), 'security-scratch'))).toBe(false)
    // Reviewers dispatched with no `cwd` override at all — never handed the
    // stale worktree's own content as a substitute.
    const reviewerCwd = readFileSync(join(ipRoundDir(world, 1), 'reviewer-work', 'cwd.txt'), 'utf8').trim()
    expect(reviewerCwd).not.toMatch(new RegExp(`${ipRoundDir(world, 1)}/reviewer-scratch$`))
    // The fake dispatcher's own "read the marker, or fall back to empty"
    // still creates its target file even when the read fails — so the
    // assertion is an EMPTY file, never a missing one.
    expect(readFileSync(join(ipRoundDir(world, 1), 'reviewer-work', 'candidate-marker-seen.txt'), 'utf8')).toBe('')
  })
})
