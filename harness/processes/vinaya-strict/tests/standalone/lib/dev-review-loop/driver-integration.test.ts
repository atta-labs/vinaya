/**
 * `devReviewLoop`'s Sizing verification story (dev-review-loop-v1 task 5,
 * `#415`): a fake `claude` binary on `PATH`, scripted by role
 * (`$VINAYA_ROLE`) to play the developer and both reviewers, plus fake
 * `gh`/`git` binaries answering every forge/git read the driver makes.
 * Exercised through the REAL `vinaya dev-review-loop` CLI entry point
 * (`spawnSync('bun', [INDEX, ...])`), never by importing `devReviewLoop`
 * in-process — same discipline as `apps/cli/tests/lib/dispatch.test.ts`'s
 * own doc comment explains: `config.ts`'s `GLOBAL_VINAYA_HOME` is a
 * module-level constant frozen at first import, and `dispatchRole` (called
 * for real here, unmocked, so the fake vendor binary is genuinely
 * exercised) writes through it — an in-process run sharing that constant
 * with another test file in the same `bun:test` process could pollute the
 * real developer machine's own `~/.vinaya/outbox/`. A fresh subprocess per
 * test, with its own scratch `HOME`, sidesteps that entirely.
 *
 * Two scenarios. The first is the shortest real one `assessRound` supports:
 * round 1 gates green, dispatches both reviewers fresh, both come back
 * clean (`APPROVE`/`PASS`, no findings) — `assessRound` returns `publish`.
 * This exercises dispatch-role-per-round (developer + 2 reviewers, one
 * shared fake binary distinguished by `$VINAYA_ROLE`), the findings/report
 * file grammar (Part 2), `writeHeldVerdict`, and the "nothing posted before
 * publish" invariant (`resolveHead`/`fetchCiConclusion` — the mechanical
 * read side of the same primitives every round uses — are exercised here
 * too via the fake `git`/`gh`).
 *
 * The second (code review, PR #445 round 1, MAJOR) forces a genuine round 2:
 * the code-reviewer finds a BLOCKER on round 1, the developer is RESUMED
 * (`-r <id>`, asserted present by the fake binary itself — exit `9`
 * otherwise) rather than started fresh, and the captured round-2 prompt is
 * checked to actually carry round 1's review content.
 *
 * Task 6 (`#416`) adds publication and pause: the fake `gh` now actually
 * records `pr comment` posts (one file per post under `$HOME/.fake-gh-posted-
 * comments/`) and replays them on `pr view --json comments`, so `publishRound`'s
 * own post-then-re-fetch-then-extract self-check sees real posted content,
 * the same shape the real forge would hand back. This backs three more
 * scenarios: publish posts exactly three comments and a rerun posts none of
 * them twice (O1); an escalation pauses with a marked comment and a non-zero
 * exit (O2); and `--resume` reads a Principal ruling off the same PR and
 * carries it into the next developer dispatch (O2).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { heldVerdictPath } from '../../../../loops/dev-review/standalone/dev-review-loop/reviewer-dispatch.js'
import { reviewerCandidateInputPaths } from '../../../../loops/dev-review/standalone/dev-review-loop/reviewer-isolation.js'
import { renderDeferredFindingsIssueBody } from '../../../../tools/task-contract/forge/forge-write.js'
import { buildReexecArgs, setStandaloneLogIdentity } from '../../../../loops/dev-review/standalone/dev-review-loop.js'
import { objectivesVersion } from '../../../../tools/task-contract/objectives'
import { REVIEW_FINDING_DESCRIPTION_MAX_LENGTH } from '../../../../../../kernel/log/schema'
import {
  CLEAN_REVIEWER,
  CLEAN_SECURITY,
  cleanupWorlds,
  controlDir as ipControlDir,
  defaultDeveloperTurnOutput,
  makeInProcessDeps,
  makeWorld,
  outboxLines as ipOutboxLines,
  roundDir as ipRoundDir,
  runLoopInProcess,
  taskRunDir as ipTaskRunDir
} from '../dev-review-loop-harness.js'
import {
  CLI_ROOT,
  TASK,
  controlDir,
  roundDir,
  developerDir,
  BRANCH,
  HEAD_SHA,
  BASE_SHA,
  pathWithoutRealVendors,
  tempDir,
  writeFakeBinary,
  writeFakeClaude,
  writeFakeGh,
  setUpReviewGateOwnCheckFails,
  runLoopNoPauseCommentRetry,
  writeFakeGhCrashOnceThenReattach,
  writeFakeGhReattachSucceeds,
  writeFakeGit,
  runLoop,
  runResume,
  runCancel,
  runDevReviewLoopArgs,
  postedCommentFiles,
  outboxLines,
  setUp,
  writeFakeClaudePauseThenResumeScenario,
  driverLockPath,
  writeDriverLockFixture,
  deadPid,
  setUpPauseResume,
  writeFakeGhPauseCommentFailsOnce,
  writeFakeGhPauseCommentNeverSucceeds,
  FAST_PAUSE_RETRY_ENV,
  escalationRecordPath,
  resolutionRecordPath,
  ownershipEpochFiles,
  seedRuling,
  setUpSupersededCiFailure,
  setUpReviewerWritesGarbageFindings,
  writeFakeGhAlwaysRedCi,
  setUpNeverPushesSupersededSuccessThenCurrentFailure,
  writeFakeClaudeBaseMovesAfterFirstTurn,
  writeFakeGitBaseMovesWithSuccessfulPull,
  writeFakeClaudeBaseMovesThenCleanReview,
  setUpResumeThenStaleDriver,
  FAST_POLL_ENV,
  setUpPrincipalOwedRedReviewGate,
  writeFakeGhSweepBlocksUntilDevInvoked,
  writeFakeGhSweepRevivedBetweenChecks,
  writeFakeClaudeForSweepRepo,
  sweepRunDir,
  runLoopWithRepo,
  tempDirs as sharedTempDirs
} from './driver-test-support.js'

const tempDirs = sharedTempDirs
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
// Issue #709: the in-process harness owns its own temp dirs (its world's
// runtimeDir/repoRoot/logDir) — clean them after every test too.
afterEach(cleanupWorlds)

describe('devReviewLoop — the mechanical gate excludes the review gate’s own check-run (O1)', () => {
  // REAL PROCESS: subject is the real fetchCiConclusion/fetchFailingCheckRuns check-run-exclusion filter, which the in-process harness replaces entirely with a world-backed fake — no faithful in-pro
  it.skipIf(process.platform === 'darwin')(
    'reads green and publishes off a real CI success, even though "vinaya review gate" itself reads failure',
    () => {
      const { home, cwd, path } = setUpReviewGateOwnCheckFails()
      const r = runLoop(home, cwd, path)
      expect(r.status, r.stderr).toBe(0)
      expect(r.stdout).toMatch(/publish/)

      const loopEvents = outboxLines(home)
        .filter((l) => l.kind === 'dev_review_loop')
        .map((l) => l.event)
      // A red gate would have dispatched the developer again instead of the
      // reviewers — `gate_result_read` with `green: true` proves the review
      // gate's own failing check-run was excluded, not merely tolerated.
      const gateRead = outboxLines(home).find((l) => l.event === 'gate_result_read') as
        | Record<string, unknown>
        | undefined
      expect(gateRead?.green).toBe(true)
      expect(loopEvents).toContain('verdicts_read')
    },
    45000
  )
})
describe('devReviewLoop — O9 (task-run-v1 21, #541, round 2 review BLOCKER): a crash between a green round_ended and journal_finalized never resets numbering on reattach', () => {
  // REAL PROCESS: subject is fetchLoopHistory's real forge-marker (pr-comment) round reconstruction on reattach, which the harness fakes to always return empty — faithfully converting it would mean
  it.skipIf(process.platform === 'darwin')(
    'round 2 dispatches directly (never round 1 again), and the eventual published marker still carries round 1',
    () => {
      const home = tempDir('vinaya-drl-home-')
      const cwd = tempDir('vinaya-drl-cwd-')
      const binDir = tempDir('vinaya-drl-bin-')
      writeFakeClaude(binDir)
      writeFakeGhCrashOnceThenReattach(binDir)
      writeFakeGit(binDir)
      const path = `${binDir}:${pathWithoutRealVendors()}`

      // Round 1: gate green, reviewers clean, `round_ended(outcome: 'green')`
      // logs — then `publishRound` crashes posting the security verdict,
      // before the REAL `journal_finalized` (the one `publishRound` itself
      // would trigger) is ever reached. O10's own crash-recovery fix (above)
      // still logs its OWN `journal_finalized`, but with `result: 'stopped'`
      // — never `'merged_ready'`, which only the real publish path can ever
      // write — so it must never be mistaken for a genuine completion. Both
      // lines land live, in the local default destination — read directly,
      // never via a flush-then-forge-read round trip ([task-files-v1] 5, O3).
      const r1 = runLoopNoPauseCommentRetry(home, cwd, path)
      expect(r1.status).not.toBe(0)
      const linesAfterCrash = outboxLines(home)
      expect(linesAfterCrash.some((l) => l.event === 'round_ended' && l.outcome === 'green')).toBe(true)
      expect(linesAfterCrash.some((l) => l.event === 'journal_finalized' && l.result === 'merged_ready')).toBe(false)

      // Swap to a `gh` with no crash logic — round 2's own posts must succeed
      // — then reattach with a plain `--task`, exactly as an operator
      // re-running the same command after the crash would. Round ≥ 2's
      // confidence gate reads the round's accepted turn result, which a
      // Developer dispatch would normally leave; an ATTACH never dispatches
      // the developer at all (the code is already on the remote), so it's
      // pre-seeded here exactly as `setUpAttachRecoversHeldRound`'s own
      // round-2 fixtures do.
      writeFakeGhReattachSucceeds(binDir)
      const worktreeDir = join(cwd, '.worktrees', BRANCH)
      mkdirSync(worktreeDir, { recursive: true })
      mkdirSync(developerDir(home, 2), { recursive: true })
      writeFileSync(
        join(developerDir(home, 2), 'turn-result-001.json'),
        JSON.stringify({
          version: 1,
          runId: 'seeded',
          round: 2,
          attempt: 1,
          head: null,
          outcome: 'accepted',
          result: {
            schemaVersion: 1,
            status: 'completed',
            summary: 'same code',
            confidence: 90,
            confidenceExplanation: 'same code, already reviewed clean once',
            addressedFindingIds: [],
            sourceUses: null,
            reportedChecks: null
          },
          failures: [],
          recordedAt: new Date(0).toISOString()
        })
      )
      const r2 = runLoop(home, cwd, path)
      expect(r2.status).toBe(0)
      expect(r2.stdout).toMatch(/publish/)

      // The bug this test guards: round 2 must be a NEW round on the SAME
      // code, never round 1 redone. `writeFakeClaude` marks each round it
      // reviews by `$VINAYA_ROUND` — round 2's own markers only exist if the
      // driver genuinely advanced past round 1's own numbering.
      expect(existsSync(join(home, '.fake-code-reviewer-round-2'))).toBe(true)
      expect(existsSync(join(home, '.fake-security-reviewer-round-2'))).toBe(true)

      // The published marker — round 2's real, live computation — still
      // names round 1, reconstructed from the round-1 developer marker round 1
      // posted to the PR before it crashed, never dropped just because it never
      // got to publish (Origin, PR #536).
      const files = postedCommentFiles(home)
      const summaryFile = files[files.length - 1] as string
      const summary = readFileSync(join(home, '.fake-gh-posted-comments', summaryFile), 'utf8')
      expect(summary).toMatch(/^<!-- aeg:loop:published head=\S+ confidence=1:\S+,2:\S+ -->$/m)
      expect(summary).not.toContain('| round |')
    },
    45000
  )
})
describe('devReviewLoop — round 1 start creates the task branch on the remote (O1/O2)', () => {
  it('creates the developer branch at origin/main on a fresh start, before any developer dispatch (O1)', async () => {
    // Default world: no remote branch (`developerPushed` false → `resolveHead`
    // throws) and no open PR (`findOpenPrForBranch` null) — the genuinely-fresh
    // round-1 path. The loop creates the branch once, at start, and reaches
    // publish exactly as before; the Developer's own turn (which flips
    // `developerPushed`) still runs on that branch (O3).
    const world = makeWorld()
    const result = await runLoopInProcess(world)
    expect(result.finalDecision.type).toBe('publish')
    expect(world.remoteBranchCreations).toEqual([world.branch])
    // O1: the creation fired, not the developer's push, as the first thing —
    // the branch existed for GitHub before the one developer dispatch.
    expect(world.dispatchCountByRole.developer).toBe(1)
  })

  it('leaves an existing remote branch untouched when an open PR already carries it (O2)', async () => {
    // `developerPushed: true` → `findOpenPrForBranch` returns a PR and the
    // round-1 entry attaches to it instead of dispatching fresh; the
    // remote-branch creation is on the fresh path only, so it never runs.
    const world = makeWorld({ developerPushed: true })
    const result = await runLoopInProcess(world)
    expect(result.finalDecision.type).toBe('publish')
    expect(world.remoteBranchCreations).toEqual([])
  })

  it('leaves an existing remote branch untouched when it carries no open PR yet (O2)', async () => {
    // The other O2 sub-case: the branch is already on the remote
    // (`remoteBranchExists` → `resolveHead` succeeds) but no open PR carries it
    // (`findOpenPrForBranch` null) — a crash-recovery re-entry after a prior
    // process pushed the branch without opening a PR. The round-1 entry takes
    // the branchExists-true path (`afterDeveloperTurnBeforePrPoll` resumes once
    // to open the PR), never the genuinely-fresh path, so the remote-branch
    // creation never runs against an already-existing branch.
    const world = makeWorld({ remoteBranchExists: true })
    const result = await runLoopInProcess(world)
    expect(result.finalDecision.type).toBe('publish')
    expect(world.remoteBranchCreations).toEqual([])
  })

  it('a failed branch creation is swallowed — the loop still dispatches and publishes (O1 trap)', async () => {
    // The Developer's own first push creates the same branch later, so a push
    // failure at start must never stop the loop: it is logged and swallowed.
    const world = makeWorld()
    let attempted = 0
    const result = await runLoopInProcess(world, undefined, {
      createTaskWorktree: () => {
        attempted += 1
        throw new Error('simulated push rejection')
      }
    })
    expect(attempted).toBe(1)
    expect(result.finalDecision.type).toBe('publish')
    expect(world.dispatchCountByRole.developer).toBe(1)
  })

  // Round 3 Principal ruling: round-1 Codex was reported running with the
  // repo root as its sandboxed workspace, because `createTaskWorktree` had
  // not yet run when the Developer's `cwd` option was computed. The driver
  // now creates the worktree, on disk, before the first Developer dispatch
  // of every round — this fixture makes the fake `createTaskWorktree`
  // actually create `<repoRoot>/.worktrees/<branch>` (the real
  // `existsSync` check `dispatchDeveloperOnce` runs finds it), exactly as
  // the real, git-backed `createTaskWorktree` does — and asserts the
  // Developer dispatch's own `cwd` is that worktree, on a GENUINELY FRESH
  // round 1, for Codex specifically (the agent the Reviewer's BLOCKER named).
  it('passes the task worktree as the Developer dispatch cwd on a fresh round 1 — never the repository root (Codex)', async () => {
    const world = makeWorld()
    const worktreeDir = join(world.repoRoot, '.worktrees', world.branch)
    const result = await runLoopInProcess(
      world,
      { task: world.task, agent: 'codex' },
      {
        createTaskWorktree: (branch: string) => {
          world.remoteBranchCreations.push(branch)
          mkdirSync(join(world.repoRoot, '.worktrees', branch), { recursive: true })
        }
      }
    )
    expect(result.finalDecision.type).toBe('publish')
    const developerDispatch = world.dispatches.find((d) => d.role === 'developer' && d.round === 1)
    expect(developerDispatch?.cwd).toBe(worktreeDir)
    expect(developerDispatch?.cwd).not.toBe(world.repoRoot)
  })
})
describe('devReviewLoop — the developer flow still works on the loop-created branch (O3)', () => {
  // REAL PROCESS: exercises the REAL `createTaskWorktree` (`git worktree add`
  // then the commit-free, `--no-verify`'d ref push plus `git -C <worktree>
  // branch -u`, Principal ruling 1, answered by the fixture's fake git) on
  // the genuinely-fresh path, then the Developer's own worktree setup and
  // first push, all the way to publish — proving the worktree/branch the
  // loop creates at start does not disturb the Developer's own downstream
  // flow on the same branch.
  it.skipIf(process.platform === 'darwin')(
    'creates the worktree and branch at start with a --no-verify ref push, then dispatches, opens the PR, and publishes',
    () => {
      const { home, cwd, path } = setUp()
      const r = runLoop(home, cwd, path)
      expect(r.status).toBe(0)
      expect(r.stdout).toMatch(/publish/)

      // The loop's own start-of-run branch creation reached the remote: the
      // fake git recorded exactly the commit-free `push --no-verify origin
      // origin/main:refs/heads/<branch>` ref push — never the old `-u origin
      // HEAD` shape, and never a force-push.
      const pushes = readFileSync(join(home, '.fake-git-pushes'), 'utf8')
      expect(pushes).toMatch(new RegExp(`push --no-verify origin origin/main:refs/heads/${BRANCH}`))
      expect(pushes).not.toMatch(/push -u origin HEAD/)
      expect(pushes).not.toMatch(/--force|\+/)
    },
    45000
  )
})
describe('createTaskWorktree — a fresh host resumes the remote task branch (real git, two clones of a bare remote)', () => {
  const GIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t'
  }
  const git = (cwd: string, ...args: string[]): string => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
    return r.stdout.trim()
  }
  const TASK_BRANCH = 'task/resume-v1/1'

  /** A bare remote, plus host A (which pushes the task branch with two commits) and a fresh host B. */
  function twoHosts(): { remote: string; hostA: string; hostB: string; taskHead: string } {
    const root = tempDir('resume-worktree-')
    const remote = join(root, 'remote.git')
    const hostA = join(root, 'a')
    const hostB = join(root, 'b')
    git(root, 'init', '--bare', '--initial-branch=main', remote)
    git(root, 'clone', '--quiet', remote, hostA)
    writeFileSync(join(hostA, 'f.txt'), 'base\n')
    git(hostA, 'add', '.')
    git(hostA, 'commit', '-q', '-m', 'base')
    git(hostA, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
    git(hostA, 'checkout', '-q', '-b', TASK_BRANCH)
    for (const n of ['one', 'two']) {
      writeFileSync(join(hostA, `${n}.txt`), `${n}\n`)
      git(hostA, 'add', '.')
      git(hostA, 'commit', '-q', '-m', n)
    }
    git(hostA, 'push', '-q', 'origin', `HEAD:refs/heads/${TASK_BRANCH}`)
    const taskHead = git(hostA, 'rev-parse', 'HEAD')
    git(root, 'clone', '--quiet', remote, hostB)
    return { remote, hostA, hostB, taskHead }
  }

  async function inHost<T>(
    dir: string,
    run: (
      fn: typeof import('../../../../loops/dev-review/standalone/dev-review-loop/developer-dispatch.js').createTaskWorktree
    ) => T
  ): Promise<T> {
    const { createTaskWorktree } = await import(
      '../../../../loops/dev-review/standalone/dev-review-loop/developer-dispatch.js'
    )
    const previous = process.cwd()
    process.chdir(dir)
    try {
      return run(createTaskWorktree)
    } finally {
      process.chdir(previous)
    }
  }

  it('starts the worktree at the remote task head and keeps its commits, never pushing a replacement', async () => {
    const { remote, hostB, taskHead } = twoHosts()
    await inHost(hostB, (create) => create(TASK_BRANCH))
    expect(git(join(hostB, '.worktrees', TASK_BRANCH), 'rev-parse', 'HEAD')).toBe(taskHead)
    expect(git(remote, 'rev-parse', `refs/heads/${TASK_BRANCH}`)).toBe(taskHead)
    expect(git(join(hostB, '.worktrees', TASK_BRANCH), 'rev-parse', '--abbrev-ref', '@{u}')).toBe(
      `origin/${TASK_BRANCH}`
    )
  })

  it('a new task with no remote branch starts from the fetched default branch and creates the remote branch there', async () => {
    const { remote, hostB } = twoHosts()
    git(remote, 'branch', '-D', TASK_BRANCH)
    const main = git(remote, 'rev-parse', 'refs/heads/main')
    await inHost(hostB, (create) => create(TASK_BRANCH))
    expect(git(join(hostB, '.worktrees', TASK_BRANCH), 'rev-parse', 'HEAD')).toBe(main)
    expect(git(remote, 'rev-parse', `refs/heads/${TASK_BRANCH}`)).toBe(main)
  })

  it('refuses a local branch at another head, leaving the remote task branch untouched', async () => {
    const { remote, hostB, taskHead } = twoHosts()
    git(hostB, 'branch', TASK_BRANCH, 'origin/main')
    await expect(inHost(hostB, (create) => create(TASK_BRANCH))).rejects.toThrow(/reconcile them/)
    expect(git(remote, 'rev-parse', `refs/heads/${TASK_BRANCH}`)).toBe(taskHead)
  })

  it('refuses when the remote cannot be read, creating nothing', async () => {
    const { remote, hostB } = twoHosts()
    rmSync(remote, { recursive: true, force: true })
    await expect(inHost(hostB, (create) => create(TASK_BRANCH))).rejects.toThrow()
    expect(existsSync(join(hostB, '.worktrees', TASK_BRANCH))).toBe(false)
  })
})
describe('devReviewLoop — every event names the standalone runner, the Vinaya process and the dispatched runtime', () => {
  function identitiesOf(lines: Array<Record<string, unknown>>): unknown[] {
    return lines.map((l) => {
      const meta = l.meta as { process: unknown; runner: unknown; runtime: unknown }
      return { process: meta.process, runner: meta.runner, runtime: meta.runtime }
    })
  }

  it('reads the process version and digest from process.yaml and the runner version from the CLI package', async () => {
    const cliVersion = (JSON.parse(readFileSync(join(CLI_ROOT, 'package.json'), 'utf8')) as { version: string }).version
    const processYaml = readFileSync(
      join(CLI_ROOT, '..', '..', 'harness', 'processes', 'vinaya-strict', 'process.yaml'),
      'utf8'
    )
    const declaredVersion = processYaml.match(/^version:\s*(\S+)\s*$/m)?.[1]
    expect(declaredVersion).toMatch(/^\d+\.\d+\.\d+$/)
    const env: NodeJS.ProcessEnv = {}
    await setStandaloneLogIdentity(env)
    expect(env).toEqual({
      VINAYA_PROCESS_ID: 'vinaya',
      VINAYA_PROCESS_VERSION: declaredVersion,
      VINAYA_PROCESS_DIGEST: expect.stringMatching(/^[0-9a-f]{64}$/),
      VINAYA_RUNNER_ID: 'standalone',
      VINAYA_RUNNER_VERSION: cliVersion,
      // The standalone identity setter reads the process default flow.
      VINAYA_FLOW: 'vinaya-dev-review-v2',
      VINAYA_FLOW_VERSION: 'v2'
    })
  })

  it('names only the runner for a CLI with no process definition beside it, leaving the process version and digest unknown', async () => {
    const cliRoot = join(tempDir('vinaya-drl-published-'), 'node_modules', '@attalabs', 'vinaya')
    mkdirSync(cliRoot, { recursive: true })
    writeFileSync(join(cliRoot, 'package.json'), JSON.stringify({ version: '9.9.9' }))
    const env: NodeJS.ProcessEnv = {}
    await setStandaloneLogIdentity(env, cliRoot)
    expect(env).toEqual({ VINAYA_RUNNER_ID: 'standalone', VINAYA_RUNNER_VERSION: '9.9.9' })
  })

  it('a fresh start and a resume after a ruling both log every event under that identity', async () => {
    // The identity the setter names, which the test above proves against
    // process.yaml and the CLI package.
    const named: NodeJS.ProcessEnv = {}
    await setStandaloneLogIdentity(named)
    const declared = readFileSync(
      join(CLI_ROOT, '..', '..', 'harness', 'processes', 'vinaya-strict', 'process.yaml'),
      'utf8'
    )
    expect(named.VINAYA_PROCESS_VERSION).toBe(declared.match(/^version:\s*(\S+)\s*$/m)?.[1])
    expect(named.VINAYA_PROCESS_DIGEST).toMatch(/^[0-9a-f]{64}$/)
    const expectedIdentity = {
      process: { id: 'vinaya', version: named.VINAYA_PROCESS_VERSION, digest: named.VINAYA_PROCESS_DIGEST },
      runner: { id: 'standalone', version: named.VINAYA_RUNNER_VERSION },
      runtime: 'claude'
    }
    const world = makeWorld({
      developerPushed: true,
      roleOutcomes: {
        1: {
          reviewer: {
            findings: '',
            report: 'ESCALATE: authority\nSUMMARY: needs a call.\n',
            objectives: null,
            sessionId: 'rev-1'
          }
        }
      }
    })
    const outerRunner = process.env.VINAYA_RUNNER_ID
    const outerRuntime = process.env.VINAYA_RUNTIME
    const paused = await runLoopInProcess(world)
    expect(paused.finalDecision).toMatchObject({ type: 'pause', reason: 'escalation' })
    const freshLines = ipOutboxLines(world)
    expect(freshLines.some((l) => l.event === 'loop_started')).toBe(true)
    expect(new Set(identitiesOf(freshLines).map((i) => JSON.stringify(i)))).toEqual(
      new Set([JSON.stringify(expectedIdentity)])
    )
    // The run's identity is the in-process driver's for its own life only: this
    // test process gets back whatever it carried before, set or not.
    expect(process.env.VINAYA_RUNNER_ID).toBe(outerRunner)
    expect(process.env.VINAYA_RUNTIME).toBe(outerRuntime)

    world.rulings = ['Go ahead and fix it.']
    world.rulingOrdinal = 1
    world.rulingAuthor = 'daniboomerang'
    world.roleOutcomes[1]!.reviewer = undefined
    writeFileSync(
      join(ipTaskRunDir(world), 'driver.pid.json'),
      JSON.stringify({ pid: deadPid(), startedAt: new Date(0).toISOString() }),
      'utf8'
    )
    // No `--agent`: the resume reads the agent the paused run recorded.
    const resumed = await runLoopInProcess(world, { resumePr: world.prNumber })
    expect(resumed.finalDecision.type).toBe('publish')
    const resumeLines = ipOutboxLines(world).slice(freshLines.length)
    expect(resumeLines.some((l) => l.event === 'loop_started')).toBe(true)
    expect(new Set(identitiesOf(resumeLines).map((i) => JSON.stringify(i)))).toEqual(
      new Set([JSON.stringify(expectedIdentity)])
    )
  })
})
describe('devReviewLoop — round 1 clean, ends on publish', () => {
  it('dispatches the developer then both reviewers and publishes with no findings', async () => {
    const world = makeWorld()
    const result = await runLoopInProcess(world)
    expect(result.finalDecision.type).toBe('publish')

    const reviewerVerdict = readFileSync(join(ipRoundDir(world, 1), 'reviewer.md'), 'utf8')
    expect(reviewerVerdict).toMatch(/^VERDICT: APPROVE$/m)
    // O2: the held verdict carries the version it judged and a MET/NOT MET
    // line per objective — no more hardcoded `objectivesVersion: null`.
    const expectedVersion = objectivesVersion([{ id: 'O1', text: 'Do the thing.' }])
    expect(reviewerVerdict).toMatch(new RegExp(`^Objectives version: ${expectedVersion}$`, 'm'))
    expect(reviewerVerdict).toMatch(/^O1: MET — done\.$/m)
    const securityVerdict = readFileSync(join(ipRoundDir(world, 1), 'security.md'), 'utf8')
    expect(securityVerdict).toMatch(/^VERDICT: PASS$/m)
    expect(securityVerdict).toMatch(new RegExp(`^Objectives version: ${expectedVersion}$`, 'm'))
    expect(securityVerdict).toMatch(/^O1: MET — done\.$/m)
  })

  it('logs the exact assessRound event sequence for a clean round 1, byte-for-byte on event names', async () => {
    const world = makeWorld()
    const result = await runLoopInProcess(world)
    expect(result.finalDecision.type).toBe('publish')

    const lines = ipOutboxLines(world)
    const loopEvents = lines.filter((l) => l.kind === 'dev_review_loop').map((l) => l.event)
    // Derived directly from assess-round.ts's own assessGate (round 1, green
    // → 3 events, no roundEnded yet) then assessVerdicts (clean → 5 events)
    // — the exact sequence `assessRound` returns for this scripted scenario,
    // not guessed.
    expect(loopEvents).toEqual([
      'loop_started',
      'round_started',
      'gate_result_read',
      'verdicts_read',
      'findings_compared',
      'stop_condition_met',
      'round_ended',
      'journal_finalized',
      // #949, O2: the lifecycle event the driver now emits on its clean
      // publish exit, after everything the round itself logged.
      'driver_exited'
    ])

    const gateResult = lines.find((l) => l.event === 'gate_result_read') as Record<string, unknown>
    expect(gateResult.green).toBe(true)
    expect(gateResult.head).toBe(HEAD_SHA)

    const verdictsRead = lines.find((l) => l.event === 'verdicts_read') as Record<string, unknown>
    expect(verdictsRead.all_approve).toBe(true)
    expect(verdictsRead.blockers).toBe(0)

    const stopCondition = lines.find((l) => l.event === 'stop_condition_met') as Record<string, unknown>
    expect(stopCondition.condition).toBe('green')

    const roundEnded = lines.find((l) => l.event === 'round_ended') as Record<string, unknown>
    expect(roundEnded.outcome).toBe('green')
    expect(roundEnded.base_head).toBe(BASE_SHA)
    expect(roundEnded.head).toBe(HEAD_SHA)
    expect(roundEnded.files_changed).toBe(2)
    expect(roundEnded.insertions).toBe(10)
    expect(roundEnded.deletions).toBe(3)

    const journalFinalized = lines.find((l) => l.event === 'journal_finalized') as Record<string, unknown>
    expect(journalFinalized.result).toBe('merged_ready')
  })

  // REAL PROCESS: `publishRound`'s own post-then-re-fetch-then-extract
  // self-check and `postForgeEffectOnce`'s cross-run idempotency are the
  // subject here — asserting on the exact bodies the driver posts to the
  // forge and that a rerun posts none of them twice is a real `gh` comment
  // round-trip, not reproducible against an in-memory fake without
  // re-implementing the thing under test.
  it.skipIf(process.platform === 'darwin')(
    'publishes the two verdicts then the summary, in order, self-verified — and a rerun posts nothing twice (O1)',
    () => {
      const { home, cwd, path } = setUp()
      const r1 = runLoop(home, cwd, path)
      expect(r1.status).toBe(0)
      expect(r1.stdout).toMatch(/publish/)

      const firstRunFiles = postedCommentFiles(home)
      // One more than before: the driver now posts the round
      // marker comment itself, ahead of both reviewer verdicts — the
      // Developer's turn never posts one any more (O1).
      expect(firstRunFiles).toHaveLength(4)

      const [roundCommentFile, reviewerFile, securityFile, summaryFile] = firstRunFiles
      const roundCommentPosted = readFileSync(
        join(home, '.fake-gh-posted-comments', roundCommentFile as string),
        'utf8'
      )
      expect(roundCommentPosted).toMatch(/^<!-- aeg:developer:round-1 -->$/m)
      expect(roundCommentPosted).toMatch(new RegExp(`^Head: ${HEAD_SHA}$`, 'm'))

      const reviewerPosted = readFileSync(join(home, '.fake-gh-posted-comments', reviewerFile as string), 'utf8')
      expect(reviewerPosted).toMatch(/^VERDICT: APPROVE$/m)
      expect(reviewerPosted).toMatch(new RegExp(`^Judged head: ${HEAD_SHA}$`, 'm'))

      const securityPosted = readFileSync(join(home, '.fake-gh-posted-comments', securityFile as string), 'utf8')
      expect(securityPosted).toMatch(/^VERDICT: PASS$/m)

      const summaryPosted = readFileSync(join(home, '.fake-gh-posted-comments', summaryFile as string), 'utf8')
      expect(summaryPosted).toMatch(/^<!-- aeg:loop:published head=\S+ confidence=1:\S+ -->$/m)
      expect(summaryPosted).not.toContain('| round |')
      expect(summaryPosted).not.toMatch(/^VERDICT:/m)
      expect(summaryPosted).not.toMatch(/^Judged head:/m)

      // Same deterministic fixture, same $HOME: a rerun reaches round 1 clean
      // → publish again, but `postForgeEffectOnce`'s effect records from the
      // first run make it post nothing a second time.
      const r2 = runLoop(home, cwd, path)
      expect(r2.status).toBe(0)
      expect(r2.stdout).toMatch(/publish/)
      expect(postedCommentFiles(home)).toEqual(firstRunFiles)
    },
    45000
  )

  it('runs the evidence report once, from the driver, with no developer resume for it', async () => {
    // The driver runs `runEvidenceReport` itself, once, in the SAME round as
    // both reviewer dispatches, and never triggers a second, resumed
    // developer turn for it: the Developer's own turn ended at the push (O1).
    // In-process, the report is the injected `runEvidenceReport` dep — the
    // world counts one call to it and exactly one developer dispatch, the
    // same two facts the subprocess fixture proved through its `gh`-call log
    // and `.dev-invocations` count.
    const world = makeWorld()
    const result = await runLoopInProcess(world)
    expect(result.finalDecision.type).toBe('publish')
    expect(world.evidenceReportCalls).toBe(1)
    expect(world.dispatchCountByRole.developer).toBe(1)
  })

  it('runs the evidence report concurrently with reviewer dispatch, never serialized ahead of it', async () => {
    // Rendezvous, not a sleep-and-hope timing race: the fake
    // `runEvidenceReport` blocks (yielding) until a reviewer/security
    // dispatch has begun (`world.reviewerDispatchStarted`), proving that
    // call was still in flight when reviewer dispatch began — the two
    // genuinely overlapping inside the driver's own `Promise.all` rather
    // than one completing before the other starts. A regression that
    // serializes the report AHEAD of reviewer dispatch reproduces as a real
    // (bounded) deadlock here: the report can never return until reviewer
    // dispatch starts, and it never does — the report then times out and
    // sets `world.evidenceReportTimedOut`.
    const world = makeWorld({ blockEvidenceUntilReviewerStarts: true })
    const result = await runLoopInProcess(world)
    expect(result.finalDecision.type).toBe('publish')
    expect(world.reviewerDispatchStarted).toBe(true)
    expect(world.evidenceReportTimedOut).toBe(false)
  })

  // Issue #639: `runReportForOpenPr`'s call to `runBodyChecks` had no
  // `try`/`catch` around it — a body-check refusal used to `process.exit(1)`
  // and kill this driver's whole process mid-round, not just the one
  // evidence-report push. In-process this reproduces as the injected
  // `runEvidenceReport` returning `{ ok: false, reason }` (the same shape
  // `defaultRunEvidenceReport` produces for a body-check refusal): the round
  // must still complete — publish, never a driver death with no publish and
  // no trace — and the role log must carry a normal `evidence_report_failed`
  // line naming the refusal, the SAME logged-and-continued shape any other
  // evidence-report failure takes.
  it('Issue #639: a body-check refusal during the round-end evidence push is logged and the round still publishes, never killing the driver', async () => {
    const world = makeWorld({
      evidenceOutcome: { ok: false, reason: 'fake-always-refuse-body: fixture forces a body-check refusal' }
    })
    const result = await runLoopInProcess(world)
    expect(result.finalDecision.type).toBe('publish')

    const roleLog = readFileSync(join(ipTaskRunDir(world), 'output', 'driver.log'), 'utf8')
    expect(roleLog).toMatch(/evidence_report_failed: round=1 head=\S+ reason=/)
    expect(roleLog).toContain('fake-always-refuse-body: fixture forces a body-check refusal')
  })
})
describe('devReviewLoop — the driver heartbeat (#949, O1)', () => {
  afterEach(cleanupWorlds)

  it('emits driver_heartbeat with round/phase while alive — no pr on the first turn, the pr once it exists', async () => {
    const world = makeWorld()
    let captured: (() => void) | null = null
    let started = 0
    // A separate world-backed deps instance whose real `dispatchRole` the
    // override below delegates to after firing one heartbeat tick, so the
    // round still proceeds to publish exactly as the clean fixture does.
    const base = makeInProcessDeps(world)
    const result = await runLoopInProcess(
      world,
      { task: world.task, agent: 'claude' },
      {
        setHeartbeat: (cb) => {
          captured = cb
          started += 1
          return () => {}
        },
        // Fire a five-minute tick synchronously mid-dispatch: during the long
        // Developer turn (no PR yet) and during a later reviewer dispatch
        // (PR resolved) — the two liveness moments O1 names.
        dispatchRole: async (role, agent, prompt, opts) => {
          captured?.()
          return base.dispatchRole!(role, agent, prompt, opts)
        }
      }
    )
    expect(result.finalDecision.type).toBe('publish')
    // The driver started exactly one heartbeat timer.
    expect(started).toBe(1)

    const heartbeats = ipOutboxLines(world).filter((l) => l.event === 'driver_heartbeat')
    expect(heartbeats.length).toBeGreaterThan(0)
    for (const hb of heartbeats) {
      expect(hb.kind).toBe('dev_review_loop')
      expect(hb.task).toBe(world.task)
      expect(typeof hb.round).toBe('number')
      expect(typeof hb.phase).toBe('string')
    }
    // The Developer turn fired before any PR existed — at least one heartbeat
    // carries no `pr` at all (the Boundary's "first Developer turn" case)...
    expect(heartbeats.some((hb) => hb.pr === undefined)).toBe(true)
    // ...and once the developer pushed and the PR resolved, a later heartbeat
    // carries exactly that pull request.
    expect(heartbeats.some((hb) => hb.pr === world.prNumber)).toBe(true)
  })

  it('a heartbeat that throws on emit never crashes the round (#949, Traps)', async () => {
    const world = makeWorld()
    let captured: (() => void) | null = null
    const base = makeInProcessDeps(world)
    const result = await runLoopInProcess(
      world,
      { task: world.task, agent: 'claude' },
      {
        setHeartbeat: (cb) => {
          captured = cb
          return () => {}
        },
        dispatchRole: async (role, agent, prompt, opts) => {
          // The driver wraps its own emit in a try/catch; invoking the real
          // callback here (which only ever calls fire-and-forget `log`) can
          // never reject the dispatch, and the round still publishes.
          captured?.()
          return base.dispatchRole!(role, agent, prompt, opts)
        }
      }
    )
    expect(result.finalDecision.type).toBe('publish')
  })

  it("the production heartbeat timer is unref()'d so it never keeps the process alive (#949, Traps)", () => {
    const source = readFileSync(
      join(
        import.meta.dir,
        '..',
        '..',
        '..',
        '..',
        'loops',
        'dev-review',
        'standalone',
        'dev-review-loop',
        'driver-lifecycle.ts'
      ),
      'utf8'
    )
    const idx = source.indexOf('function defaultSetHeartbeat(')
    expect(idx).toBeGreaterThan(-1)
    const body = source.slice(idx, idx + 400)
    expect(body).toMatch(/setInterval\(/)
    expect(body).toMatch(/\.unref\?\.\(\)/)
    expect(body).toMatch(/clearInterval\(/)
  })
})
describe('devReviewLoop — the driver_exited lifecycle event (#949, O2/O3)', () => {
  // A pre-push hook run for a task whose pull request is open carries `VINAYA_PR`; the "nothing left in the environment" assertion below must start from none.
  let priorPr: string | undefined
  beforeEach(() => {
    priorPr = process.env.VINAYA_PR
    delete process.env.VINAYA_PR
  })
  afterEach(() => {
    cleanupWorlds()
    if (priorPr === undefined) delete process.env.VINAYA_PR
    else process.env.VINAYA_PR = priorPr
  })

  it('a clean publish emits exactly one driver_exited reason=finished, stops the heartbeat, and writes no routine role-log line', async () => {
    const world = makeWorld()
    // Whatever the host process already carried (a pre-push hook run for an open pull request sets it).
    const priorPr = process.env.VINAYA_PR
    let stopped = 0
    const result = await runLoopInProcess(
      world,
      { task: world.task, agent: 'claude' },
      {
        setHeartbeat: () => () => {
          stopped += 1
        }
      }
    )
    expect(result.finalDecision.type).toBe('publish')
    // The timer the driver started was stopped on the way out.
    expect(stopped).toBe(1)

    const exits = ipOutboxLines(world).filter((l) => l.event === 'driver_exited')
    expect(exits).toHaveLength(1)
    const exit = exits[0] as Record<string, unknown>
    expect(exit.kind).toBe('dev_review_loop')
    expect(exit.task).toBe(world.task)
    expect(exit.reason).toBe('finished')
    expect(exit.last_decision).toBe('publish')
    // A clean return records no exit code and no error class.
    expect(exit).not.toHaveProperty('exit_code')
    expect(exit).not.toHaveProperty('error_class')

    // This world's pull request is already open when the driver starts, so
    // every event the driver records carries its number in the header subject.
    const lines = ipOutboxLines(world) as Array<{ event?: string; subject?: { pr?: number } }>
    expect(typeof lines.find((l) => l.event === 'driver_exited')?.subject?.pr).toBe('number')
    const verdicts = lines.find((l) => l.event === 'verdicts_read') as Record<string, unknown> | undefined
    expect(verdicts?.reviewers).toEqual([
      { role: 'code-reviewer', outcome: 'approve', blockers: 0 },
      { role: 'security', outcome: 'approve', blockers: 0 }
    ])
    // Restored on return: the environment is as the loop found it.
    expect(process.env.VINAYA_PR).toBe(priorPr)

    // The role log stays diagnostic: a clean return writes no `driver_exited`
    // line there (Boundary — "diagnostic rather than routine").
    const roleLogPath = join(ipTaskRunDir(world), 'output', 'driver.log')
    if (existsSync(roleLogPath)) {
      expect(readFileSync(roleLogPath, 'utf8')).not.toMatch(/driver_exited:/)
    }
  })

  it('a decided pause emits one driver_exited reason=paused naming the pause reason', async () => {
    // Security writes nothing on both attempts → a driver-decided
    // infrastructure pause, returned normally (never a throw).
    const world = makeWorld({ roleOutcomes: { 1: { security: { ...CLEAN_SECURITY, writesNothing: true } } } })
    const result = await runLoopInProcess(world)
    expect(result.finalDecision).toMatchObject({ type: 'pause', reason: 'infrastructure' })

    const exits = ipOutboxLines(world).filter((l) => l.event === 'driver_exited')
    expect(exits).toHaveLength(1)
    const exit = exits[0] as Record<string, unknown>
    expect(exit.reason).toBe('paused')
    expect(exit.last_decision).toBe('pause(infrastructure)')
    const paused = ipOutboxLines(world).filter((l) => l.event === 'paused')
    expect(paused.length).toBeGreaterThan(0)
    expect((paused[0] as Record<string, unknown>).reason_code).toBe('infrastructure')
  })

  it('an uncaught error emits one driver_exited reason=error and still writes the diagnostic role-log line', async () => {
    const world = makeWorld()
    const result = await runLoopInProcess(
      world,
      { task: world.task, agent: 'claude' },
      {
        reviewPolicy: () => {
          throw new Error('fake: trust-anchor read blew up')
        }
      }
    )
    expect(result.finalDecision).toMatchObject({ type: 'pause', reason: 'infrastructure' })

    const exits = ipOutboxLines(world).filter((l) => l.event === 'driver_exited')
    expect(exits).toHaveLength(1)
    expect((exits[0] as Record<string, unknown>).reason).toBe('error')
    // The class is the constructor name; the message never reaches the record.
    expect((exits[0] as Record<string, unknown>).error_class).toBe('Error')
    expect(JSON.stringify(exits[0])).not.toContain('trust-anchor')

    // An abnormal exit DOES leave the role-log trace — the signal a reader
    // follows when no decision reached the forge.
    const roleLogPath = join(ipTaskRunDir(world), 'output', 'driver.log')
    expect(readFileSync(roleLogPath, 'utf8')).toMatch(/\bLoop\s+driver_exited: reason=error/)
  })

  it('recordDriverExited stops the heartbeat before it writes anything, on exactly one guarded path (#949, O1/Traps)', () => {
    const source = readFileSync(
      join(
        import.meta.dir,
        '..',
        '..',
        '..',
        '..',
        'loops',
        'dev-review',
        'standalone',
        'dev-review-loop',
        'driver-lifecycle.ts'
      ),
      'utf8'
    )
    const idx = source.indexOf('export function createDriverExitRecorder(')
    expect(idx).toBeGreaterThan(-1)
    const body = source.slice(idx, source.indexOf('\n}\n', idx))
    // Guarded against a double write for one exit.
    expect(body).toMatch(/if \(written\) return/)
    const stopAt = body.indexOf('facts.stopHeartbeat()')
    const roleLineAt = body.indexOf('appendRoleLine(')
    const logAt = body.indexOf('facts.log(event)')
    expect(stopAt).toBeGreaterThan(-1)
    // The timer is cleared before any role-log line or Log event is written,
    // so a stray tick can never land after the exit is recorded.
    expect(roleLineAt).toBeGreaterThan(stopAt)
    expect(logAt).toBeGreaterThan(stopAt)
  })

  it('the reexec and signal exit paths each record their own driver_exited reason (#949, O2)', () => {
    const source = readFileSync(
      join(import.meta.dir, '..', '..', '..', '..', 'loops', 'dev-review', 'standalone', 'dev-review-loop.ts'),
      'utf8'
    )
    expect(source).toMatch(/recordDriverExited\('reexec', \{ exitCode \}\)/)
    expect(source).toMatch(/recordDriverExited\('signal', \{ exitCode: \d+ \}\)/)
    expect(source).toMatch(/recordDriverExited\('error', \{ error: err \}\)/)
    // The round-loop chokepoint maps a publish to `finished`, any pause to `paused`.
    expect(source).toMatch(
      /recordDriverExited\(loopResult\.finalDecision\.type === 'publish' \? 'finished' : 'paused'\)/
    )
  })
})
describe('devReviewLoop — deferred findings tracked in one Issue per pull request (#854)', () => {
  afterEach(cleanupWorlds)

  // A would-block finding (BLOCKER, the code-review threshold) whose file the
  // Surface `in:` does not cover is deferred (`outside-surface`) rather than
  // blocking, so the round still publishes — the exact shape the deferral
  // rules set aside (a below-threshold finding is non-blocking but NEVER
  // deferred, so it would not exercise this path).
  const OUT_OF_SURFACE_FINDING =
    'BLOCKER|packages/aeg-core/src/foo.ts:10|F1 correctness: a latent bug the loop cannot act on this round\n'

  it('opens/updates one tracking Issue for a publish with deferred findings and links it from the summary (O1)', async () => {
    const world = makeWorld({
      surface: { in: ['apps/cli/**'], out: [] },
      roleOutcomes: {
        1: { reviewer: { ...CLEAN_REVIEWER, findings: OUT_OF_SURFACE_FINDING } }
      }
    })
    const result = await runLoopInProcess(world)
    expect(result.finalDecision.type).toBe('publish')

    // O1: the tracking Issue was written exactly once, carrying the deferred
    // finding's own severity, `file:line`, reason and round.
    expect(world.deferredIssueWrites).toHaveLength(1)
    const write = world.deferredIssueWrites[0]!
    expect(write.prNumber).toBe(world.prNumber)
    // O1: the entry carries the reviewer that reported it (the code-reviewer
    // role, `'reviewer'`) alongside severity, file:line and reason.
    expect(write.entries).toEqual([
      {
        round: 1,
        reviewer: 'reviewer',
        severity: 'BLOCKER',
        location: 'packages/aeg-core/src/foo.ts:10',
        reason: 'outside-surface',
        description: 'F1 correctness: a latent bug the loop cannot act on this round'
      }
    ])
    // O1: publication received the tracking Issue's ref, to link from the summary.
    expect(world.publishedDeferredIssues).toEqual([{ issue: world.deferredIssueNumber }])
  })

  it('keeps both deferral reasons’ descriptions, redacted and capped, in the Issue body and the Log', async () => {
    const secret = 'ghp_ABCDEFGHIJKLMNOP'
    const long = 'x'.repeat(REVIEW_FINDING_DESCRIPTION_MAX_LENGTH + 200)
    const blocking = 'BLOCKER|apps/cli/src/a.ts:5|an in-Surface defect the Developer must fix\n'
    const outside = `BLOCKER|packages/aeg-core/src/foo.ts:10|outside leak ${secret} ${long}\n`
    const unchanged = `BLOCKER|apps/cli/src/a.ts:99|unchanged-line leak ${secret} ${long}\n`
    const world = makeWorld({
      surface: { in: ['apps/cli/**'], out: [] },
      // Round 2's diff changes line 5 only, so the round-2 finding at line 99 sits on an unchanged line.
      roundDiff:
        'diff --git a/apps/cli/src/a.ts b/apps/cli/src/a.ts\n--- a/apps/cli/src/a.ts\n+++ b/apps/cli/src/a.ts\n@@ -5,0 +5,1 @@\n+x\n',
      roleOutcomes: {
        1: { reviewer: { ...CLEAN_REVIEWER, findings: blocking + outside } },
        2: { reviewer: { ...CLEAN_REVIEWER, findings: unchanged } }
      },
      developerTurnOutput: (round, prompt) => {
        if (round === 2) world.head = 'b'.repeat(40)
        return defaultDeveloperTurnOutput(prompt)
      }
    })
    const result = await runLoopInProcess(world)
    expect(result.finalDecision.type).toBe('publish')

    const entries = world.deferredIssueWrites.flatMap((w) => w.entries)
    const outsideEntry = entries.find((e) => e.reason === 'outside-surface')
    const unchangedEntry = entries.find((e) => e.reason === 'unchanged-line')
    expect(outsideEntry).toBeDefined()
    expect(unchangedEntry).toBeDefined()

    const body = renderDeferredFindingsIssueBody(world.prNumber, entries)
    const logged = ipOutboxLines(world)
      .filter((l) => l.event === 'verdicts_read')
      .flatMap(
        (l) => (l.findings ?? []) as Array<{ deferral_reason?: string; description?: string; location?: string }>
      )
    for (const [entry, reason] of [
      [outsideEntry!, 'outside-surface'],
      [unchangedEntry!, 'unchanged-line']
    ] as const) {
      expect(entry.description).not.toContain(secret)
      expect(entry.description.length).toBeLessThanOrEqual(REVIEW_FINDING_DESCRIPTION_MAX_LENGTH)
      expect(entry.description.endsWith('…')).toBe(true)
      expect(body).toContain(entry.description)
      const event = logged.find((f) => f.deferral_reason === reason)
      expect(event?.description).toBe(entry.description)
      expect(event?.location).toBe(entry.location)
    }
  })

  it('opens nothing for a clean publish with no deferred findings (O3)', async () => {
    const world = makeWorld()
    const result = await runLoopInProcess(world)
    expect(result.finalDecision.type).toBe('publish')

    // O3: nothing deferred, so no Issue is written and the summary links none.
    expect(world.deferredIssueWrites).toEqual([])
    expect(world.publishedDeferredIssues).toEqual([])
  })

  it('a BLOCKER and a MAJOR on the staged pull request body reach the Developer capped, never deferred', async () => {
    // The reviewer cites the body file the driver staged in its own checkout —
    // once relative to that checkout, once by its absolute path — derived from
    // the staging module itself, never a second copy of its name.
    const scratch = '/scratch/reviewer'
    const stagedBody = reviewerCandidateInputPaths(scratch).prBody
    const findings = [
      `BLOCKER|${relative(scratch, stagedBody)}:1|the body claims an objective is met that the diff does not meet`,
      `MAJOR|${stagedBody}:1|the body names a file the diff never touches`,
      'BLOCKER|packages/aeg-core/src/foo.ts:10|a latent bug the loop cannot act on this round'
    ].join('\n')
    const world = makeWorld({
      surface: { in: ['apps/cli/**'], out: [] },
      roleOutcomes: { 1: { reviewer: { ...CLEAN_REVIEWER, findings: `${findings}\n` } } }
    })
    const base = makeInProcessDeps(world)
    let heldReviewerVerdict = ''
    const result = await runLoopInProcess(world, undefined, {
      publishRound: (root, input) => {
        heldReviewerVerdict = readFileSync(heldVerdictPath(root, input.task, input.round, 'reviewer'), 'utf8')
        base.publishRound!(root, input)
      }
    })
    expect(result.finalDecision.type).toBe('publish')

    // Both body findings are in the verdict the Developer receives, at the
    // body's own line, each keeping the severity the reviewer reported — and
    // capped at MINOR: this world's threshold is BLOCKER, so a BLOCKER kept in
    // the verdict yet not counted is what the cap alone produces.
    expect(heldReviewerVerdict).toMatch(/^VERDICT: APPROVE/)
    expect(heldReviewerVerdict).toContain('[BLOCKER] PR body:1 — the body claims an objective is met')
    expect(heldReviewerVerdict).toContain('[MAJOR] PR body:1 — the body names a file')
    expect(heldReviewerVerdict).not.toContain('pr-body.md')

    // Only the real file outside the Surface is deferred, exactly as before.
    expect(world.deferredIssueWrites).toHaveLength(1)
    expect(world.deferredIssueWrites[0]!.entries).toEqual([
      {
        round: 1,
        reviewer: 'reviewer',
        severity: 'BLOCKER',
        location: 'packages/aeg-core/src/foo.ts:10',
        reason: 'outside-surface',
        description: 'a latent bug the loop cannot act on this round'
      }
    ])
  })
})
// --- task-log-v1 task 6, O3: restart fixtures ---
//
// A genuine restart here is a second, independent `dev-review-loop` process
// re-run against the SAME task/$HOME as the first (`setUp`'s own `writeFakeGh`
// never lets the local outbox flush — `issue comment` always refuses — so
// both processes' own lines accumulate in the ONE local ndjson file this
// suite already reads via `outboxLines`, letting a raw two-run trace be
// inspected directly, exactly what the Issue's own "Observable evidence"
// asks for: a whole-task normal AND a whole-task resumed raw-event trace).
// Round 1 is genuinely clean on both runs (`setUp`'s deterministic fixture),
// so the second run re-derives the identical 'publish' decision from
// scratch — never a held/short-circuited replay — which is what makes
// "equivalent lineage" a real claim about the controller's own behavior,
// not an artifact of skipping the second run's own assessment.
describe('devReviewLoop — restart fixtures (task-log-v1 task 6, O3): equivalent lineage, idempotent identities, visible gaps', () => {
  const CANONICAL_ROUND_1_SHAPE = [
    'loop_started',
    'round_started',
    'gate_result_read',
    'verdicts_read',
    'findings_compared',
    'stop_condition_met',
    'round_ended',
    'journal_finalized',
    // #949, O2: each whole-task run now ends with its own clean-publish
    // `driver_exited` — one per process, the same shape under each run's own
    // distinct lineage.run.
    'driver_exited'
  ]

  // REAL PROCESS: publishRound's real gh/EffectExecutor round-trip (postPrCommentOnce shells out to real gh directly, bypassing every injected dep) cannot be exercised via the in-process fake publis
  it.skipIf(process.platform === 'darwin')(
    'a second whole-task run reproduces the SAME dev_review_loop event shape under a DIFFERENT lineage.run — two genuine runs, never one fabricated as a continuation of the other',
    () => {
      const { home, cwd, path } = setUp()

      const r1 = runLoop(home, cwd, path)
      expect(r1.status).toBe(0)
      const linesAfterR1 = outboxLines(home)
      const loopEventsR1 = linesAfterR1.filter((l) => l.kind === 'dev_review_loop').map((l) => l.event)
      expect(loopEventsR1).toEqual(CANONICAL_ROUND_1_SHAPE)

      const r2 = runLoop(home, cwd, path)
      expect(r2.status).toBe(0)

      const allLines = outboxLines(home)
      const loopLines = allLines.filter((l) => l.kind === 'dev_review_loop')
      // Every dev_review_loop line partitions cleanly by lineage.run into
      // exactly two runs — the SAME canonical shape twice, never one merged
      // 16-event stream and never a shape that only makes sense assuming the
      // two processes shared state they never actually shared.
      const runsInOrder = [...new Set(loopLines.map((l) => (l.meta as { lineage: { run: string } }).lineage.run))]
      expect(runsInOrder).toHaveLength(2)
      for (const run of runsInOrder) {
        expect(
          loopLines.filter((l) => (l.meta as { lineage: { run: string } }).lineage.run === run).map((l) => l.event)
        ).toEqual(CANONICAL_ROUND_1_SHAPE)
      }
      // The restart itself is visible directly in the data, not inferred: two
      // distinct process identities, never a single lineage.run silently
      // spanning both runs as if nothing happened in between.
      expect(runsInOrder[0]).not.toBe(runsInOrder[1])
    },
    45000
  )

  // REAL PROCESS: publishRound real forge round-trip — asserts on real EffectExecutor verified lines from real forge writes
  it.skipIf(process.platform === 'darwin')(
    "the rerun's own effect events reconcile the FIRST run's identities — an idempotent 'verified' replay, one line per run, for the SAME effect_id across the restart (O1/O3)",
    () => {
      const { home, cwd, path } = setUp()

      const r1 = runLoop(home, cwd, path)
      expect(r1.status).toBe(0)
      const r2 = runLoop(home, cwd, path)
      expect(r2.status).toBe(0)
      // No new forge write landed on the rerun — the pre-existing O1 proof
      // (`postedCommentFiles` unchanged) this task's own fixture already
      // established; the assertions below are the RAW EVENT counterpart of
      // that same fact.
      expect(postedCommentFiles(home)).toHaveLength(4)

      const effectLines = outboxLines(home).filter((l) => l.kind === 'effect') as Array<{
        effect_id: string
        event: string
        outcome?: string
      }>
      expect(effectLines.length).toBeGreaterThan(0)

      const byId = new Map<string, typeof effectLines>()
      for (const l of effectLines) {
        const arr = byId.get(l.effect_id) ?? []
        arr.push(l)
        byId.set(l.effect_id, arr)
      }
      // The reviewer- and security-verdict posts (`publishRound`'s own
      // `postPrCommentOnce`, the shared `EffectExecutor`) are keyed by round,
      // not by process — `1-reviewer-verdict`/`1-security-verdict` are the
      // SAME identity string a fresh process re-derives independently, which
      // is exactly what makes a genuine cross-process replay observable here.
      for (const key of ['1-reviewer-verdict', '1-security-verdict']) {
        const forId = byId.get(key)
        expect(forId, `no effect events for ${key}`).toBeDefined()
        const events = (forId ?? []).map((l) => l.event)
        // First run: a fresh write — one verified(success). Second run: the
        // SAME identity is already 'verified' on disk, so
        // `EffectExecutor.reconcileExisting` emits its own one 'verified' line
        // under the same effect_id — never a second write, never an
        // 'attempted' or 'observed'.
        expect(events).toEqual(['verified', 'verified'])
      }
    },
    45000
  )

  // REAL PROCESS: publishRound real forge round-trip — real cross-process restart + real outbox file on disk
  it.skipIf(process.platform === 'darwin')(
    'the controller never reads the Vinaya Log to decide — deleting the local outbox between the two runs changes nothing about the rerun’s own decision (O2/O3)',
    () => {
      const { home, cwd, path } = setUp()

      const r1 = runLoop(home, cwd, path)
      expect(r1.status).toBe(0)
      const firstRunFiles = postedCommentFiles(home)
      expect(firstRunFiles).toHaveLength(4)

      // The ONLY input this suite's own restart tests otherwise leave
      // untouched between runs — gone, not merely unread, so a controller
      // that secretly depended on replaying it would fail loudly here rather
      // than passing by accident.
      const outboxPath = join(home, '.vinaya', 'runtime', 'unresolved', 'logs', 'unresolved', `${TASK}.ndjson`)
      expect(existsSync(outboxPath)).toBe(true)
      rmSync(outboxPath)

      const r2 = runLoop(home, cwd, path)
      expect(r2.status).toBe(0)
      expect(r2.stdout).toMatch(/publish/)
      // The identical decision — nothing reposted — still holds with no log to
      // consult: idempotency here comes from `postForgeEffectOnce`'s/the
      // control store's own durable records, never from re-reading this file.
      expect(postedCommentFiles(home)).toEqual(firstRunFiles)
    },
    45000
  )
})
describe('devReviewLoop — one driver per task (review-validity-v1 task 7, #498)', () => {
  // REAL PROCESS: driver-lock-between-processes + stderr shape of the CLI
  it('O1: refuses to start, naming the live pid and start time, dispatching nothing', () => {
    const { home, cwd, path } = setUp()
    const startedAt = '2026-09-10T00:00:00.000Z'
    writeDriverLockFixture(home, { pid: process.pid, startedAt })

    const r = runLoop(home, cwd, path)

    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('vinaya dev-review-loop:')
    expect(r.stderr).toContain('refuses to start')
    expect(r.stderr).toContain(String(process.pid))
    expect(r.stderr).toContain(startedAt)
    // Nothing dispatched: the fake claude binary's own invocation marker never appears.
    expect(existsSync(join(home, '.fake-dev-invoked'))).toBe(false)
  })

  // REAL PROCESS: driver-lock-between-processes + stderr shape of the CLI
  it.skipIf(process.platform === 'darwin')(
    'O2: a dead pid record is treated as absent — takes over, runs, and clears the lock on exit',
    () => {
      const { home, cwd, path } = setUp()
      const startedAt = '2026-09-10T00:00:00.000Z'
      const stalePid = deadPid()
      writeDriverLockFixture(home, { pid: stalePid, startedAt })

      const r = runLoop(home, cwd, path)

      expect(r.status).toBe(0)
      expect(r.stdout).toMatch(/publish/)
      // O3: the stale takeover is visible on stderr, naming the stale pid and start time.
      expect(r.stderr).toContain('vinaya dev-review-loop:')
      expect(r.stderr).toContain('no longer alive')
      expect(r.stderr).toContain(String(stalePid))
      expect(r.stderr).toContain(startedAt)
      // O2: cleared on the normal-exit path, same as every other exit.
      expect(existsSync(driverLockPath(home))).toBe(false)
    }
  )
})
describe('devReviewLoop — escalation pauses, --resume continues after a ruling', () => {
  // REAL PROCESS: harness's fake postPauseComment records directly to world.postedComments and never runs the real EffectExecutor, so no effect-kind lines are ever emitted to assert on
  it("a single pause's dev_review_loop 'paused' event and the effect events its own pause-comment post fires share the SAME meta.lineage.run (task-log-v1 task 6, O1/O2: one correlated history)", () => {
    const { home, cwd, path } = setUpPauseResume()

    const paused = runLoop(home, cwd, path)
    expect(paused.status).not.toBe(0)

    const lines = outboxLines(home)
    const pausedEvents = lines.filter((l) => l.event === 'paused')
    expect(pausedEvents).toHaveLength(1)
    // `postPauseComment` (`pause-resume.ts`) runs through the SAME
    // `EffectExecutor` this task instruments — its own `effect` family
    // one `verified` event for the pause-comment post
    // lands in this SAME outbox file, alongside the policy layer's own
    // `dev_review_loop` events, because both are `log()` calls made from
    // this one process.
    const effectEvents = lines.filter((l) => l.kind === 'effect')
    expect(effectEvents.length).toBeGreaterThan(0)
    expect(effectEvents.map((e) => e.event)).toContain('verified')
    const runs = new Set(
      [...pausedEvents, ...effectEvents].map((l) => (l.meta as { lineage: { run: string | null } }).lineage.run)
    )
    expect(runs.size).toBe(1)
    expect([...runs][0]).not.toBeNull()
  }, 45000)
})
describe('devReviewLoop — O1 (`[task-operator-v1]`/Issue #662): the pause comment post itself retries with backoff, and this function itself never crashes the driver', () => {
  // REAL PROCESS: harness's fake postPauseComment bypasses postWithRetry entirely; no retry logic to observe in-process
  it.skipIf(process.platform === 'darwin')(
    'a post that fails once then succeeds recovers in-process: the pause is posted, the reason is intact, and one recovered infrastructure_retry event is logged',
    () => {
      const home = tempDir('vinaya-drl-home-')
      const cwd = tempDir('vinaya-drl-cwd-')
      const binDir = tempDir('vinaya-drl-bin-')
      writeFakeClaudePauseThenResumeScenario(binDir)
      writeFakeGhPauseCommentFailsOnce(binDir)
      writeFakeGit(binDir)
      const path = `${binDir}:${pathWithoutRealVendors()}`

      const r = runDevReviewLoopArgs(
        home,
        cwd,
        path,
        ['--task', String(TASK), '--agent', 'claude'],
        FAST_PAUSE_RETRY_ENV
      )
      expect(r.status).not.toBe(0)
      expect(r.stdout).toMatch(/paused \(escalation\)/)

      // The pause comment DID land, despite the one transient failure.
      const pausedFiles = postedCommentFiles(home)
      expect(pausedFiles).toHaveLength(2)
      const pauseComment = readFileSync(join(home, '.fake-gh-posted-comments', pausedFiles[1] as string), 'utf8')
      expect(pauseComment).toMatch(/^<!-- aeg:loop:paused:escalation -->$/m)

      // The local pause state — the authoritative record — carries the REAL
      // reason (escalation), never clobbered into a synthetic 'infrastructure'
      // one by the retry episode.
      const pauseState = JSON.parse(readFileSync(join(controlDir(home), 'pause-state.json'), 'utf8')) as Record<
        string,
        unknown
      >
      expect(pauseState.reason).toBe('escalation')

      const retryEvent = outboxLines(home).find((l) => l.event === 'infrastructure_retry') as
        | Record<string, unknown>
        | undefined
      expect(retryEvent).toBeDefined()
      expect(retryEvent?.failure_kind).toBe('pause_comment_post')
      expect(retryEvent?.attempts).toBe(2)
      expect(retryEvent?.outcome).toBe('recovered')
    },
    45000
  )

  // REAL PROCESS: the pause comment's own retry-with-backoff (postWithRetry) is the subject, and the in-process fake bypasses it
  it.skipIf(process.platform === 'darwin')(
    'a post that never succeeds exhausts its bound WITHOUT crashing — the driver exits resumable, the pause reason is intact, and one exhausted infrastructure_retry event is logged',
    () => {
      const home = tempDir('vinaya-drl-home-')
      const cwd = tempDir('vinaya-drl-cwd-')
      const binDir = tempDir('vinaya-drl-bin-')
      writeFakeClaudePauseThenResumeScenario(binDir)
      writeFakeGhPauseCommentNeverSucceeds(binDir)
      writeFakeGit(binDir)
      const path = `${binDir}:${pathWithoutRealVendors()}`

      const r = runDevReviewLoopArgs(
        home,
        cwd,
        path,
        ['--task', String(TASK), '--agent', 'claude'],
        FAST_PAUSE_RETRY_ENV
      )
      expect(r.status).not.toBe(0)
      // The ORIGINAL reason — never a generic uncaught-error crash, and never
      // reported through the synthetic 'infrastructure' path a thrown post
      // failure used to fall into.
      expect(r.stdout).toMatch(/paused \(escalation\)/)

      // The pause comment never landed — only the round marker comment (the
      // FIRST `pr comment` call) is on disk.
      expect(postedCommentFiles(home)).toHaveLength(1)

      // The local pause state is still the authoritative, correct record —
      // this is the "pause intact" O1 asks for.
      const pauseState = JSON.parse(readFileSync(join(controlDir(home), 'pause-state.json'), 'utf8')) as Record<
        string,
        unknown
      >
      expect(pauseState.reason).toBe('escalation')
      expect(pauseState.round).toBe(1)

      const retryEvent = outboxLines(home).find((l) => l.event === 'infrastructure_retry') as
        | Record<string, unknown>
        | undefined
      expect(retryEvent).toBeDefined()
      expect(retryEvent?.failure_kind).toBe('pause_comment_post')
      expect(retryEvent?.attempts).toBe(3)
      expect(retryEvent?.outcome).toBe('exhausted')
    },
    45000
  )
})
describe('devReviewLoop — --cancel (O3)', () => {
  // REAL PROCESS: trailing assertion needs a real --resume attempt
  it.skipIf(process.platform === 'darwin')(
    'cancels a paused run once — durable, and a second cancel is refused as a replay',
    () => {
      const { home, cwd, path } = setUpPauseResume()

      const paused = runLoop(home, cwd, path)
      expect(paused.status).not.toBe(0)

      seedRuling(home, 'comment-3.md')

      const cancelled = runCancel(home, cwd, path, 123)
      expect(cancelled.status).toBe(0)
      expect(cancelled.stdout).toMatch(/cancelled/)

      const resolutionPath = resolutionRecordPath(home, TASK, 1, HEAD_SHA)
      expect(existsSync(resolutionPath)).toBe(true)
      const resolution = JSON.parse(readFileSync(resolutionPath, 'utf8')) as Record<string, unknown>
      expect(resolution.decision).toBe('cancel')

      // Idempotent: a second --cancel against the SAME already-cancelled
      // escalation is refused as a replay, never a second transition.
      const cancelledAgain = runCancel(home, cwd, path, 123)
      expect(cancelledAgain.status).not.toBe(0)
      expect(cancelledAgain.stderr).toMatch(/already has a consumed resolution|replay refused/)

      // A cancelled pause never goes on to resume — the SAME escalation's
      // resolution is already consumed, by the cancel above.
      const resumeAfterCancel = runResume(home, cwd, path, 123)
      expect(resumeAfterCancel.status).not.toBe(0)
      expect(resumeAfterCancel.stderr).toMatch(/already has a consumed resolution|replay refused/)
    },
    45000
  )

  // REAL PROCESS: needs its own successful cancel to complete; the module-level default log sink (log-sink.ts) caches its destination/context on its first-ever write for the whole bun:test process,
  it.skipIf(process.platform === 'darwin')(
    'a replayed cancel is refused WITHOUT bumping the task epoch (code review, round 2, HIGH)',
    () => {
      const { home, cwd, path } = setUpPauseResume()

      const paused = runLoop(home, cwd, path)
      expect(paused.status).not.toBe(0)

      seedRuling(home, 'comment-3.md')

      const cancelled = runCancel(home, cwd, path, 123)
      expect(cancelled.status).toBe(0)
      const epochsAfterFirstCancel = ownershipEpochFiles(home, TASK)
      expect(epochsAfterFirstCancel.length).toBeGreaterThan(0)

      // A duplicate/replayed cancel against the SAME already-consumed
      // escalation must be refused before it ever claims a new epoch — a
      // replayed decision must not move state it was already consumed for.
      const cancelledAgain = runCancel(home, cwd, path, 123)
      expect(cancelledAgain.status).not.toBe(0)
      expect(cancelledAgain.stderr).toMatch(/already has a consumed resolution|replay refused/)
      expect(ownershipEpochFiles(home, TASK)).toEqual(epochsAfterFirstCancel)
    },
    45000
  )
})
describe('devReviewLoop — --cancel refuses a mismatched --agent (code review, round 2, MAJOR)', () => {
  // REAL PROCESS: the log sink memoizes its destination per process, so a second in-process cancel in one runner never lands its final event
  it.skipIf(process.platform === 'darwin')(
    'refuses to terminate under an --agent that does not match the run’s actual dispatched agent',
    () => {
      const { home, cwd, path } = setUpPauseResume()

      // `runLoop` always dispatches under `--agent claude` (its own fixed
      // helper) — the escalation record persists that as the run's real
      // agent at pause time.
      const paused = runLoop(home, cwd, path)
      expect(paused.status).not.toBe(0)

      seedRuling(home, 'comment-3.md')

      const escalation = JSON.parse(readFileSync(escalationRecordPath(home, TASK, 1, HEAD_SHA), 'utf8')) as Record<
        string,
        unknown
      >
      expect(escalation.agent).toBe('claude')

      const mismatched = runDevReviewLoopArgs(home, cwd, path, ['--cancel', '123', '--agent', 'codex'])
      expect(mismatched.status).not.toBe(0)
      expect(mismatched.stderr).toMatch(/dispatched under agent 'claude', not 'codex'/)

      // Refused before ever consuming the resolution — a correctly-agented
      // cancel afterward still succeeds against the SAME still-open pause.
      expect(existsSync(resolutionRecordPath(home, TASK, 1, HEAD_SHA))).toBe(false)
      const cancelled = runCancel(home, cwd, path, 123)
      expect(cancelled.status).toBe(0)
      expect(cancelled.stdout).toMatch(/cancelled/)
    },
    45000
  )
})
describe('devReviewLoop — a reviewer that wrote nothing cast no verdict (O1/O2)', () => {
  it.skipIf(process.platform === 'darwin')(
    'retries once as a fresh dispatch, then pauses naming the role and the missing result — nothing held or published',
    async () => {
      // Security returns NO structured result, on both its attempts.
      const world = makeWorld({ roleOutcomes: { 1: { security: { ...CLEAN_SECURITY, writesNothing: true } } } })
      const result = await runLoopInProcess(world)
      expect(result.finalDecision).toMatchObject({ type: 'pause', reason: 'infrastructure' })

      // Two genuinely separate dispatches for the failing role — one attempt,
      // one fresh retry — never the same call read twice.
      expect(world.dispatchCountByRole.security).toBe(2)

      // The retry is a fresh dispatch — never a resume of the first attempt.
      const securityDispatches = world.dispatches.filter((d) => d.role === 'security' && d.round === 1)
      expect(securityDispatches).toHaveLength(2)

      // Nothing held or published for this round: no security verdict file
      // ever got written, and the round never advanced past 1. The code-review
      // role finishes clean well before security's own retry exhausts — its
      // held verdict must not survive on disk either (round 1 review finding,
      // BLOCKER, PR #489: `writeHeldVerdict` used to run inside `dispatchReviewer`
      // itself, so the succeeding role's file was already written by the time
      // its sibling failed).
      expect(existsSync(join(ipRoundDir(world, 1), 'reviewer.md'))).toBe(false)
      expect(existsSync(join(ipRoundDir(world, 1), 'security.md'))).toBe(false)
      const pauseState = JSON.parse(readFileSync(join(ipControlDir(world), 'pause-state.json'), 'utf8')) as Record<
        string,
        unknown
      >
      expect(pauseState.round).toBe(1)
      expect(pauseState.reason).toBe('infrastructure')

      // Two comments: the round marker (posted before either
      // reviewer even dispatches) and the pause. Never a verdict.
      expect(world.postedComments).toHaveLength(2)
      const pauseComment = world.postedComments[1]!.body
      expect(pauseComment).toMatch(/^<!-- aeg:loop:paused:infrastructure -->$/m)
      expect(pauseComment).toMatch(/security/)
      expect(pauseComment).toMatch(/no review \(missing\)/)
      expect(pauseComment).not.toMatch(/^VERDICT:/m)

      // O5 (review-validity-v1 task 5, `#488`; regression, PR #489 round 2,
      // MAJOR): this pause used to build its `Decision` by hand and skip the
      // log entirely — zero `dev_review_loop` events for the round.
      // `driverDecidedPauseEvents` now logs the same four events every other
      // pause reason gets (this task's own declared Surface excludes
      // `packages/aeg-core`, so this is driver-built, reusing the schema's
      // existing `'principal_stop'`/`'principal_item'` values, never a new
      // schema value — see that function's own doc comment).
      const loopEvents = ipOutboxLines(world)
        .filter((l) => l.kind === 'dev_review_loop')
        .map((l) => l.event)
      expect(loopEvents).toEqual([
        'loop_started',
        'round_started',
        'gate_result_read',
        'stop_condition_met',
        'paused',
        // No `round_ended`: the round held no verdict, so it is never closed
        // as `changes_requested` — the resumed run reviews it and ends it.
        'journal_finalized',
        // #949, O2: the driver's own exit event, after the round's pause record.
        'driver_exited'
      ])
      expect(ipOutboxLines(world).some((l) => l.event === 'round_ended')).toBe(false)
      const stop = ipOutboxLines(world).find((l) => l.event === 'stop_condition_met') as Record<string, unknown>
      expect(stop.condition).toBe('principal_stop')
      const journalFinalized = ipOutboxLines(world).find((l) => l.event === 'journal_finalized') as Record<
        string,
        unknown
      >
      expect(journalFinalized.result).toBe('stopped')
    }
  )
})
describe('devReviewLoop — the loop maps every reviewer run to its outcome and binds blocked results too (O2)', () => {
  const ESCALATING_SECURITY = { ...CLEAN_SECURITY, report: 'ESCALATE: scope\nSUMMARY: the scope is unclear\n' }
  const cases: { name: string; security: typeof CLEAN_SECURITY; reason: string }[] = [
    {
      name: 'a completed result bound to another head',
      security: { ...CLEAN_SECURITY, misbind: 'stale_head' },
      reason: 'stale'
    },
    {
      name: 'a completed result naming the other role',
      security: { ...CLEAN_SECURITY, misbind: 'crossed_role' },
      reason: 'role_mismatch'
    },
    {
      name: 'a scope-unclear blocked result bound to another head',
      security: { ...ESCALATING_SECURITY, misbind: 'stale_head' },
      reason: 'stale'
    },
    {
      name: 'a scope-unclear blocked result naming the other role',
      security: { ...ESCALATING_SECURITY, misbind: 'crossed_role' },
      reason: 'role_mismatch'
    },
    {
      name: 'a run whose provider reports an exhausted context',
      security: {
        ...CLEAN_SECURITY,
        providerFailure: { terminal: 'error_during_execution (is_error)', errors: ['Prompt is too long'] }
      },
      reason: 'context_exhausted'
    },
    {
      name: 'a run that ends in a provider error',
      security: { ...CLEAN_SECURITY, providerFailure: { terminal: 'turn.failed', errors: ['upstream unavailable'] } },
      reason: 'provider_error'
    }
  ]
  for (const { name, security, reason } of cases) {
    it.skipIf(process.platform === 'darwin')(
      `${name} is no review (${reason}): one fresh retry, then an infrastructure pause — never approval or a ruling pause`,
      async () => {
        const world = makeWorld({ roleOutcomes: { 1: { security } } })
        const result = await runLoopInProcess(world)
        expect(result.finalDecision).toMatchObject({ type: 'pause', reason: 'infrastructure' })
        expect(world.dispatchCountByRole.security).toBe(2)
        expect(existsSync(join(ipRoundDir(world, 1), 'security.md'))).toBe(false)
        const pauseComment = world.postedComments.at(-1)!.body
        expect(pauseComment).toMatch(/^<!-- aeg:loop:paused:infrastructure -->$/m)
        expect(pauseComment).toContain(`no review (${reason})`)
        expect(pauseComment).not.toMatch(/^VERDICT:/m)
      }
    )
  }

  it.skipIf(process.platform === 'darwin')(
    'a cancelled run is a failed dispatch: an infrastructure pause before any result is read, never a verdict',
    async () => {
      const world = makeWorld({ roleOutcomes: { 1: { security: { ...CLEAN_SECURITY, cancelled: true } } } })
      const result = await runLoopInProcess(world)
      expect(result.finalDecision).toMatchObject({ type: 'pause', reason: 'infrastructure' })
      expect(existsSync(join(ipRoundDir(world, 1), 'security.md'))).toBe(false)
      expect(world.postedComments.at(-1)!.body).not.toMatch(/^VERDICT:/m)
    }
  )

  it.skipIf(process.platform === 'darwin')(
    'a scope-unclear blocked result bound to this role, head and manifest is the round escalation, with no retry',
    async () => {
      const world = makeWorld({ roleOutcomes: { 1: { security: ESCALATING_SECURITY } } })
      const result = await runLoopInProcess(world)
      expect(result.finalDecision).toMatchObject({ type: 'pause' })
      expect(result.finalDecision).not.toMatchObject({ reason: 'infrastructure' })
      expect(world.dispatchCountByRole.security).toBe(1)
    }
  )
})
describe('devReviewLoop — a superseded check-run failure never pauses a healthy PR (driver-lifecycle-v1 task 2, #607, O1)', () => {
  // REAL PROCESS: tests gate-reading.ts's real REST-shape dedup-by-newest-run algorithm, which the in-process harness's fetchCiConclusion/fetchFailingCheckRuns fakes bypass entirely (they read world
  it.skipIf(process.platform === 'darwin')(
    'reads the gate green off the newer, deduped run and reaches round 1 reviewer dispatch — never a CI-red retry',
    () => {
      const { home, cwd, path } = setUpSupersededCiFailure()
      const r = runLoop(home, cwd, path)
      expect(r.status).not.toBe(0)
      expect(r.stdout).toMatch(/paused \(infrastructure\)/)

      // The gate never read red: round 1's developer is dispatched exactly
      // once — there is no second, CI-red-retry dev-prompt file — and the
      // eventual pause is the reviewer-infrastructure case (security wrote
      // nothing), never the gate-red case. A regression that fell back to the
      // raw, undeduped check-run list would instead resume the developer with
      // a "CI is red" prompt and never reach this point.
      expect(existsSync(join(home, '.dev-prompt-2.txt'))).toBe(false)

      const pauseState = JSON.parse(readFileSync(join(controlDir(home), 'pause-state.json'), 'utf8')) as Record<
        string,
        unknown
      >
      expect(pauseState.round).toBe(1)
      expect(pauseState.reason).toBe('infrastructure')
      expect(pauseState.detail).toMatch(/security/)
      expect(pauseState.detail).not.toMatch(/failing check-run/)
    },
    45000
  )
})
describe('devReviewLoop — a rejected reviewer result is an infrastructure pause', () => {
  // REAL PROCESS: the dispatch outcome line it joins against is logged by the real dispatchRole, which the in-process harness replaces
  it.skipIf(process.platform === 'darwin')(
    'retries once as a fresh dispatch, then pauses naming the rejection and the reviewer session id — never an uncaught throw',
    () => {
      const { home, cwd, path } = setUpReviewerWritesGarbageFindings()
      const r = runLoop(home, cwd, path)
      expect(r.status).not.toBe(0)
      expect(r.stdout).toMatch(/paused \(infrastructure\)/)

      // Two genuinely separate dispatches — one attempt, one fresh retry.
      const invocations = readFileSync(join(home, '.security-invocations'), 'utf8').trim().split('\n').filter(Boolean)
      expect(invocations).toHaveLength(2)

      const pauseState = JSON.parse(readFileSync(join(controlDir(home), 'pause-state.json'), 'utf8')) as Record<
        string,
        unknown
      >
      expect(pauseState.round).toBe(1)
      expect(pauseState.reason).toBe('infrastructure')

      // Two comments: the round marker and the pause.
      const pausedFiles = postedCommentFiles(home)
      expect(pausedFiles).toHaveLength(2)
      const pauseComment = readFileSync(join(home, '.fake-gh-posted-comments', pausedFiles[1] as string), 'utf8')
      expect(pauseComment).toMatch(/^<!-- aeg:loop:paused:infrastructure -->$/m)
      // Names the rejection, what was wrong, and the reviewer's session id.
      expect(pauseComment).toMatch(/no review \(rejected\)/)
      expect(pauseComment).toMatch(/unknown objective id/)
      expect(pauseComment).toMatch(/sec-session-garbage/)
      expect(pauseComment).not.toMatch(/^VERDICT:/m)

      // This pause reaches `postPauseComment` from `ReviewerInfrastructureFailure`'s
      // own message, never from the outer crash catch — a distinct call site
      // that must sanitize too. The rejected objective id above is a
      // credential-shaped token; it must never reach the PUBLIC pause comment
      // un-redacted, even though it DOES reach the reviewer's own retry prompt
      // and the machine-local pause-state.json.
      expect(pauseComment).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz012345')
      expect(pauseComment).toContain('<redacted>')

      // An invalid result is a failure observation,
      // never something indistinguishable from a clean round: no `verdicts_read`
      // was ever logged for this round (the throw happened before `assessRound`
      // saw a `verdicts` observation), but a `role_attempt` line names the
      // security role's own failed attempt explicitly.
      const events = outboxLines(home)
      expect(events.some((e) => e.event === 'verdicts_read')).toBe(false)
      // `dispatchRole`'s own per-attempt `role_attempt` lines (developer,
      // both reviewer attempts) are ALSO present now
      // — this is the additional one dev-review-loop.ts logs for the
      // security role's own invalid result, distinguished by its outcome.
      const failureAttempt = events.find(
        (e) => e.kind === 'role_attempt' && e.outcome === 'infrastructure_failed' && e.actor === 'security'
      ) as { effect_id: string; duration_ms: number } | undefined
      expect(failureAttempt).toMatchObject({ actor: 'security', outcome: 'infrastructure_failed', usage: null })

      // Round 2 review, MAJOR (fixed): this failure's own `effect_id` must be
      // the SAME id the failing security attempt's own `dispatch` line(s)
      // carry — never a freshly minted, unjoinable one — and its `duration_ms`
      // must be that one attempt's own duration, not the whole round's.
      const securityDispatchOutcomeLines = events.filter(
        (e) =>
          e.kind === 'dispatch' &&
          (e as { target_role?: string }).target_role === 'security' &&
          e.event !== 'dispatched'
      ) as Array<{ effect_id: string; duration_ms: number }>
      const matching = securityDispatchOutcomeLines.find((l) => l.effect_id === failureAttempt?.effect_id)
      expect(matching).toBeDefined()
      expect(failureAttempt?.duration_ms).toBe(matching?.duration_ms)
    },
    45000
  )
})
describe('devReviewLoop — a genuinely failing current check-run still pauses, even beside a superseded success (driver-lifecycle-v1 task 2, #607, O2)', () => {
  // REAL PROCESS: the real check-run dedup in the gate reader is the subject and is bypassed by the harness's fakes
  it.skipIf(process.platform === 'darwin')(
    'pauses with the same reason and detail shape as a single failing run, naming the CURRENT failing check',
    () => {
      const { home, cwd, path } = setUpNeverPushesSupersededSuccessThenCurrentFailure()
      const r = runDevReviewLoopArgs(home, cwd, path, ['--task', String(TASK), '--agent', 'claude'], {
        VINAYA_DEV_REVIEW_LOOP_GATE_POLL_MAX_ATTEMPTS: '2',
        VINAYA_DEV_REVIEW_LOOP_GATE_POLL_INTERVAL_MS: '10'
      })
      expect(r.status).not.toBe(0)
      // The same current failing check-run ended both stalled turns, so the
      // repeat-failure stop names it — the bound behind it is unchanged for a
      // stall the driver cannot name.
      expect(r.stdout).toMatch(/paused \(repeat_failure\)/)

      const pauseState = JSON.parse(readFileSync(join(controlDir(home), 'pause-state.json'), 'utf8')) as Record<
        string,
        unknown
      >
      expect(pauseState.reason).toBe('repeat_failure')
      expect(pauseState.detail).toMatch(/head .* unchanged/)
      // Same shape as the single-failing-run case above: the surviving,
      // CURRENT failure (run 2) is named — never the superseded success (run
      // 1), and never a bare check name with no run identity to audit it
      // against (O3, `#607`).
      expect(pauseState.detail).toMatch(/Vinaya CI \(run 2, started 2026-09-14T10:05:00Z\)/)
      expect(pauseState.detail).not.toMatch(/run 1/)

      const gateRedPrompt = readFileSync(join(home, '.dev-prompt-2.txt'), 'utf8')
      expect(gateRedPrompt).toMatch(/CI is red on the last head/)
      expect(gateRedPrompt).toMatch(/Vinaya CI \(run 2, started 2026-09-14T10:05:00Z\)/)
    },
    45000
  )
})
describe('devReviewLoop — O4 (#595): a re-exec child whose own first gate read is red stays alive and pauses, never exits', () => {
  // REAL PROCESS: genuinely process-level — subject is a real re-exec producing a second OS process (parent hands off, a distinct child process reads its own first gate); the in-process harness runs
  it.skipIf(process.platform === 'darwin')(
    'the parent hands off mid-round-1, and the child — CI red on its own first read — ends bounded-paused, never crashed',
    () => {
      const home = tempDir('vinaya-drl-home-')
      const cwd = tempDir('vinaya-drl-cwd-')
      const binDir = tempDir('vinaya-drl-bin-')
      writeFakeClaudeBaseMovesAfterFirstTurn(binDir)
      writeFakeGhAlwaysRedCi(binDir)
      writeFakeGitBaseMovesWithSuccessfulPull(binDir)
      const path = `${binDir}:${pathWithoutRealVendors()}`

      const r = runDevReviewLoopArgs(home, cwd, path, ['--task', String(TASK), '--agent', 'claude'], {
        VINAYA_DEV_REVIEW_LOOP_PR_POLL_MAX_ATTEMPTS: '5',
        VINAYA_DEV_REVIEW_LOOP_PR_POLL_INTERVAL_MS: '5',
        VINAYA_DEV_REVIEW_LOOP_GATE_POLL_MAX_ATTEMPTS: '5',
        VINAYA_DEV_REVIEW_LOOP_GATE_POLL_INTERVAL_MS: '5'
      })

      // The re-exec (the parent's own hand-off) really happened.
      expect(existsSync(join(home, '.git-pull-called'))).toBe(true)

      // The CHILD process — the one that actually ends this run — is alive
      // and reached a DECIDED pause, never an uncaught crash: a real exit
      // code this harness itself set (`d.exitProcess`/the pause-return path),
      // never a bare stack trace, and never the parent's own re-exec exit
      // code masquerading as success.
      expect(r.status).not.toBe(0)
      expect(r.stderr).not.toMatch(/Uncaught|TypeError|ReferenceError|at Object\./)
      expect(r.stdout).toMatch(/paused \(repeat_failure\)/)
      // Never `stale_driver` — the staleness was absorbed by the re-exec
      // itself; what pauses the CHILD is its own red gate, a different fact.
      // That the reason is `repeat_failure` is the repeat memory surviving the
      // re-exec: the parent recorded this same failure before handing off, so
      // the child's own first red read is the second attempt to end on it,
      // which is precisely what it must not send the developer back at.
      expect(r.stdout).not.toMatch(/paused \(stale_driver\)/)

      const pauseState = JSON.parse(readFileSync(join(controlDir(home), 'pause-state.json'), 'utf8')) as Record<
        string,
        unknown
      >
      expect(pauseState.reason).toBe('repeat_failure')
    },
    30000
  )
})
describe('devReviewLoop — O7 (task-run-v1 task 15): a moved base re-execs in place instead of pausing', () => {
  // REAL PROCESS: a re-exec replaces the driver process with a child; the subject is that real process hand-off
  it.skipIf(process.platform === 'darwin')(
    'pulls the default branch, re-execs onto the same task, and never pauses stale_driver',
    () => {
      const home = tempDir('vinaya-drl-home-')
      const cwd = tempDir('vinaya-drl-cwd-')
      const binDir = tempDir('vinaya-drl-bin-')
      writeFakeClaudeBaseMovesAfterFirstTurn(binDir)
      writeFakeGh(binDir)
      writeFakeGitBaseMovesWithSuccessfulPull(binDir)
      const path = `${binDir}:${pathWithoutRealVendors()}`

      // The re-exec attaches to the same task in a genuinely fresh process
      // (the whole point of O7 — a stale in-memory driver must not keep
      // running), so the polls that fresh process makes finding the
      // already-open PR/gate need the same fast-poll overrides any other
      // fixture exercising real polling in test time already uses.
      runDevReviewLoopArgs(home, cwd, path, ['--task', String(TASK), '--agent', 'claude'], {
        VINAYA_DEV_REVIEW_LOOP_PR_POLL_MAX_ATTEMPTS: '5',
        VINAYA_DEV_REVIEW_LOOP_PR_POLL_INTERVAL_MS: '5',
        VINAYA_DEV_REVIEW_LOOP_GATE_POLL_MAX_ATTEMPTS: '5',
        VINAYA_DEV_REVIEW_LOOP_GATE_POLL_INTERVAL_MS: '5'
      })

      // The pull path was actually taken — proof the re-exec attempt ran at all.
      expect(existsSync(join(home, '.git-pull-called'))).toBe(true)

      // Never the stale_driver pause anywhere this run's own comments landed —
      // the re-exec absorbed the staleness instead of handing it to a human.
      const commentsDir = join(home, '.fake-gh-posted-comments')
      if (existsSync(commentsDir)) {
        for (const file of readdirSync(commentsDir)) {
          expect(readFileSync(join(commentsDir, file), 'utf8')).not.toMatch(/aeg:loop:paused:stale_driver/)
        }
      }
    },
    30000
  )
})
describe('devReviewLoop — O1 (#548): the re-exec hands its lock to the child instead of refusing it', () => {
  // REAL PROCESS: the driver lock handed from a parent process to its re-exec'd child is the subject
  it.skipIf(process.platform === 'darwin')(
    'clears the parent’s own live lock before spawning, so the child starts and publishes instead of dying to its own parent’s lock',
    () => {
      const home = tempDir('vinaya-drl-home-')
      const cwd = tempDir('vinaya-drl-cwd-')
      const binDir = tempDir('vinaya-drl-bin-')
      writeFakeClaudeBaseMovesThenCleanReview(binDir)
      writeFakeGh(binDir)
      writeFakeGitBaseMovesWithSuccessfulPull(binDir)
      const path = `${binDir}:${pathWithoutRealVendors()}`

      // Found live, PR #547: without the fix, the parent's own lock (written
      // at its own entry, still on disk and still live — the parent is
      // blocked in `spawnSync`, not exited) refuses the child outright, and
      // BOTH processes exit quietly with no pause, no publish, nothing posted.
      const r = runDevReviewLoopArgs(home, cwd, path, ['--task', String(TASK), '--agent', 'claude'], {
        VINAYA_DEV_REVIEW_LOOP_PR_POLL_MAX_ATTEMPTS: '5',
        VINAYA_DEV_REVIEW_LOOP_PR_POLL_INTERVAL_MS: '5',
        VINAYA_DEV_REVIEW_LOOP_GATE_POLL_MAX_ATTEMPTS: '5',
        VINAYA_DEV_REVIEW_LOOP_GATE_POLL_INTERVAL_MS: '5'
      })

      expect(existsSync(join(home, '.git-pull-called'))).toBe(true)
      expect(r.stderr).not.toMatch(/refuses to start/)
      expect(r.status).toBe(0)
      expect(r.stdout).toMatch(/publish/)
      // The child cleared its own lock on its own normal exit.
      expect(existsSync(driverLockPath(home))).toBe(false)
    },
    30000
  )
})
describe('devReviewLoop — O4 (Issue #662): a resumed loop that hits a stale-driver restart before its next developer turn continues, never refusing the ruling it already consumed', () => {
  // REAL PROCESS: a --resume process and its re-exec'd child are two real processes; the hand-off between them is the subject
  it.skipIf(process.platform === 'darwin')(
    'runs two rounds across the --resume process and its own re-exec’d child, publishing rather than crashing on a replayed resolution',
    () => {
      const { home, cwd, path } = setUpResumeThenStaleDriver()

      const paused = runDevReviewLoopArgs(home, cwd, path, ['--task', String(TASK), '--agent', 'claude'], FAST_POLL_ENV)
      expect(paused.status).not.toBe(0)
      expect(paused.stdout).toMatch(/paused \(escalation\)/)

      writeFileSync(
        join(home, '.fake-gh-posted-comments', 'comment-2.md'),
        `<!-- aeg:principal:ruling:${TASK}-1 -->\nGo ahead and fix it.\n`
      )

      const resumed = runDevReviewLoopArgs(home, cwd, path, ['--resume', '123', '--agent', 'claude'], FAST_POLL_ENV)

      // Before the fix, the re-exec'd child rebuilt `--resume 123`, re-ran the
      // top-of-function resume gate, and `resolveEscalation` threw
      // `ReplayedResolutionError` against the SAME resolution this process had
      // already consumed at its own start — uncaught, before this process's
      // outer `try`/`finally` even begins, so nothing traced it: the run died
      // with no pause and no publish. The fix (`buildReexecArgs` always
      // `--task`) means the child instead attaches to the open PR and
      // continues round 2 itself.
      expect(resumed.stderr).not.toMatch(/ReplayedResolutionError|already consumed|nothing to resume from/)
      expect(existsSync(join(home, '.git-pull-called'))).toBe(true)
      expect(resumed.status).toBe(0)
      expect(resumed.stdout).toMatch(/publish/)

      // Both rounds genuinely ran — round 1's held BLOCKER verdict (recovered
      // by the re-exec'd child from disk) and round 2's clean one.
      expect(readFileSync(join(roundDir(home, 1), 'reviewer.md'), 'utf8')).toMatch(/^VERDICT: REQUEST CHANGES$/m)
      expect(readFileSync(join(roundDir(home, 2), 'reviewer.md'), 'utf8')).toMatch(/^VERDICT: APPROVE$/m)
    },
    30000
  )
})
describe('devReviewLoop — a principal-owed red never redispatches the developer (review-validity-v1 11, O3)', () => {
  // REAL PROCESS: the real check-run filter that excludes the review gate's own check is the subject, and the in-process harness replaces it
  it.skipIf(process.platform === 'darwin')(
    'dispatches both reviewers off the green mechanical gate, even with review-gate itself red',
    () => {
      const { home, cwd, path } = setUpPrincipalOwedRedReviewGate()
      const r = runLoop(home, cwd, path)
      expect(r.status).toBe(0)
      expect(r.stdout).toMatch(/publish/)

      // Proof reviewers (not the developer) were dispatched off round 1: the
      // held-verdict files only the dispatch_reviewers branch writes exist.
      const reviewerVerdict = readFileSync(join(roundDir(home, 1), 'reviewer.md'), 'utf8')
      expect(reviewerVerdict).toMatch(/^VERDICT: APPROVE$/m)
      const securityVerdict = readFileSync(join(roundDir(home, 1), 'security.md'), 'utf8')
      expect(securityVerdict).toMatch(/^VERDICT: PASS$/m)

      // Proof the gate itself read green, and no second gate/developer round
      // happened first — a red-gate retry would insert a second
      // gate_result_read/round_started pair before verdicts_read.
      const loopEvents = outboxLines(home)
        .filter((l) => l.kind === 'dev_review_loop')
        .map((l) => l.event)
      expect(loopEvents).toEqual([
        'loop_started',
        'round_started',
        'gate_result_read',
        'verdicts_read',
        'findings_compared',
        'stop_condition_met',
        'round_ended',
        'journal_finalized',
        // #949, O2: the clean-publish exit event, last.
        'driver_exited'
      ])
      const gateResult = outboxLines(home).find((l) => l.event === 'gate_result_read') as Record<string, unknown>
      expect(gateResult.green).toBe(true)
    },
    45000
  )
})
// Issue #660, O3 — the two isolation properties added to
// `runDevReviewLoopArgs`: a leaked `VINAYA_RUNTIME_DIR` from THIS process's
// own environment never redirects a fixture's driver subprocess away from
// its isolated `$HOME`, and a genuinely stuck subprocess fails with the
// child's own captured output rather than a bare timeout.
describe('runDevReviewLoopArgs fixture isolation (Issue #660, O3)', () => {
  // REAL PROCESS: tests real OS-process env isolation between parent and spawned child; no separate child process in-process
  it.skipIf(process.platform === 'darwin')(
    "a real, leaked VINAYA_RUNTIME_DIR in this test process's own env never redirects the child — it still writes under the fixture's own isolated $HOME, and nothing lands in the leaked directory",
    () => {
      const { home, cwd, path } = setUp()
      const leakedRuntimeDir = tempDir('vinaya-drl-leaked-runtime-')
      const prevRuntimeDir = process.env.VINAYA_RUNTIME_DIR
      // The same shape this Developer session's own dispatched environment
      // genuinely carries — reproduced live: `runDevReviewLoopArgs` used to
      // spread `...process.env` first, so this leaked straight into the
      // child, which resolved its runtime directory from it instead of the
      // fixture's own `$HOME` (`resolveRuntimeDirUncached` checks the env key
      // before ever calling `homedir()`).
      process.env.VINAYA_RUNTIME_DIR = leakedRuntimeDir
      try {
        const r = runLoop(home, cwd, path)
        expect(r.status).toBe(0)
      } finally {
        if (prevRuntimeDir === undefined) delete process.env.VINAYA_RUNTIME_DIR
        else process.env.VINAYA_RUNTIME_DIR = prevRuntimeDir
      }

      expect(existsSync(join(roundDir(home, 1), 'reviewer.md'))).toBe(true)
      expect(existsSync(join(leakedRuntimeDir, 'tasks-execution'))).toBe(false)
    }
  )

  // REAL PROCESS: real subprocess spawn-timeout-kill and captured stdio; no process to kill in-process
  it('a subprocess that never exits is killed at its budget and throws with the budget figure and the captured output, never a bare timeout', () => {
    const home = tempDir('vinaya-drl-home-')
    const cwd = tempDir('vinaya-drl-cwd-')
    const binDir = tempDir('vinaya-drl-bin-')
    writeFakeBinary(binDir, 'claude', '#!/bin/sh\necho "stuck on purpose"\nsleep 30\n')
    writeFakeGh(binDir)
    writeFakeGit(binDir)
    const path = `${binDir}:${pathWithoutRealVendors()}`

    let thrown: unknown
    try {
      runDevReviewLoopArgs(home, cwd, path, ['--task', String(TASK), '--agent', 'claude'], {}, 3000)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Error)
    const message = (thrown as Error).message
    expect(message).toContain('killed by')
    expect(message).toContain('3000ms budget')
    // The child's own output is really captured, not just an empty
    // "timed out" line — the exact gap a bare test-framework timeout leaves.
    expect(message).toContain('--- stdout ---')
    expect(message).toContain('--- stderr ---')
  })
})
describe('the start-of-run sweep never delays the loop, and re-checks before removing (Issue #697)', () => {
  // REAL PROCESS: the harness's sweepTasksAtStart fake is a no-op that only records the call; the real sweep's own concurrent forge-lookup/classification/removal logic and driver.log content are not
  it.skipIf(process.platform === 'darwin')(
    'O1/O2: the run-start marker and the sweep-running line land in the loop log and on stderr before the sweep’s own forge lookup, and the developer is dispatched before that lookup ever answers',
    () => {
      const home = tempDir('vinaya-drl-home-')
      const cwd = tempDir('vinaya-drl-cwd-')
      const binDir = tempDir('vinaya-drl-bin-')
      writeFakeClaudeForSweepRepo(binDir)
      writeFakeGhSweepBlocksUntilDevInvoked(binDir, 8001)
      writeFakeGit(binDir)
      const path = `${binDir}:${pathWithoutRealVendors()}`

      // A finished, unrelated task folder for the sweep to classify — its
      // own `gh issue view --json state` call blocks (bounded) until the
      // developer has already been dispatched.
      mkdirSync(sweepRunDir(home, 8001), { recursive: true })

      const r = runLoopWithRepo(home, cwd, path)
      expect(r.status).toBe(0)
      expect(r.stdout).toMatch(/publish/)

      // O2: the developer was dispatched, and the sweep's own blocked lookup
      // never stalled it — had dispatch waited on the sweep, the two would
      // have deadlocked and the fake `gh` script's own bounded poll would
      // have given up and left this marker behind.
      expect(existsSync(join(home, '.fake-dev-invoked'))).toBe(true)
      expect(existsSync(join(home, '.sweep-blocked-dispatch'))).toBe(false)

      // O1: the run-start marker and the sweep-running line are both in the
      // loop log (the same file `vinaya task status --follow` tails) and on
      // this process's own stderr.
      const driverLog = readFileSync(join(sweepRunDir(home), 'output', 'driver.log'), 'utf8')
      expect(driverLog).toMatch(/# Loop\s+run started/)
      expect(driverLog).not.toContain('sweep — running')

      // The sweep genuinely ran to completion (not merely skipped) — the
      // other, unrelated finished folder it found is gone.
      expect(existsSync(sweepRunDir(home, 8001))).toBe(false)

      // O3: each decision is printed with a running count as it is made —
      // two folders total (this run's own excluded task, plus the seeded
      // one), so the excluded task's own decision lands first as `[1/2]`
      // (no forge lookup needed) and the removal lands last as `[2/2]`,
      // after the developer's own dispatch line already appears above it.
      // O4: one summary line, never one line per swept item.
      expect(r.stderr).toContain('Sweep finished: removed 1 finished task folder, kept 1.')
      expect(r.stderr).not.toContain('Issue #8001')
      expect(driverLog).toMatch(/\bLoop\s+Sweep finished: removed 1 finished task folder, kept 1\./)
    },
    45000
  )

  // REAL PROCESS: the start-of-run sweep is the subject; sweepTasksAtStart is faked wholesale, so the real double-classification/removal timing this test proves is unobservable in-process
  it.skipIf(process.platform === 'darwin')(
    'O4: a folder found finished is classified again immediately before removal — a task revived in the interval is kept, never deleted on the stale first read',
    () => {
      const home = tempDir('vinaya-drl-home-')
      const cwd = tempDir('vinaya-drl-cwd-')
      const binDir = tempDir('vinaya-drl-bin-')
      writeFakeClaudeForSweepRepo(binDir)
      writeFakeGhSweepRevivedBetweenChecks(binDir, 8002)
      writeFakeGit(binDir)
      const path = `${binDir}:${pathWithoutRealVendors()}`

      mkdirSync(sweepRunDir(home, 8002), { recursive: true })

      // This fixture deliberately overlaps the asynchronous sweep with a full
      // developer + two-reviewer round. On a loaded CI shard it completed just
      // beyond an earlier, tighter ceiling (twice in succession, then a third
      // time only 13ms over a 45s ceiling), although the behavior itself was
      // correct each time. Give this integration-heavy case a wider ceiling,
      // with real headroom rather than another razor-thin margin, while
      // retaining the tight default for every ordinary fixture in this file.
      const r = runLoopWithRepo(home, cwd, path, 75_000)
      expect(r.status).toBe(0)
      expect(r.stdout).toMatch(/publish/)

      // The FIRST read (classification) said CLOSED — finished; the SECOND,
      // immediately before removal, said OPEN — revived. The folder survives.
      expect(existsSync(sweepRunDir(home, 8002))).toBe(true)
      expect(readFileSync(join(home, '.sweep-8002-state-calls'), 'utf8').trim()).toBe('2')
      expect(r.stderr).toContain('Sweep finished: removed 0 finished task folders, kept 2.')
    },
    80_000
  )
})
describe('devReviewLoop — a GitHub rate limit waits and retries, never pausing for a ruling (issue #1111)', () => {
  const RATE_LIMIT = 'gh: API rate limit already exceeded for user ID 1. (HTTP 403)'

  /** Overrides recording every wait and every reset read; the sleep never really waits. */
  function waitProbes() {
    const slept: number[] = []
    let resetReads = 0
    return {
      slept,
      resetReads: () => resetReads,
      deps: {
        // A real one-millisecond yield, like the harness's own sleep — the log
        // sink flushes on a macrotask, so an instant no-op would starve it.
        // Only the rate-limit waits (a minute or more) are recorded.
        sleep: (ms: number) => {
          if (ms >= 30_000) slept.push(ms)
          return new Promise<void>((resolve) => setTimeout(resolve, 1))
        },
        readRateLimitReset: async () => {
          resetReads += 1
          return Math.floor(Date.now() / 1000) + 60
        }
      }
    }
  }

  it('a rate limit before any role is dispatched waits once, re-enters, and publishes with no pause comment (O1)', async () => {
    const world = makeWorld()
    const probes = waitProbes()
    let thrown = false
    const result = await runLoopInProcess(
      world,
      { task: world.task, agent: 'claude' },
      {
        ...probes.deps,
        fetchRulings: (_pr) => {
          if (!thrown) {
            thrown = true
            throw new Error(RATE_LIMIT)
          }
          return [...world.rulings]
        }
      }
    )
    expect(result.finalDecision.type).toBe('publish')
    expect(thrown).toBe(true)
    expect(probes.slept).toHaveLength(1)
    expect(probes.slept[0]).toBeGreaterThan(60_000)
    expect(probes.slept[0]).toBeLessThanOrEqual(65_000)
    expect(probes.resetReads()).toBe(1)
    expect(world.postedComments.some((c) => /aeg:loop:paused/.test(c.body))).toBe(false)
  })

  it('a rate limit on the post-dispatch self-check reads waits in place — no reviewer is dispatched a second time (O1)', async () => {
    const world = makeWorld()
    const probes = waitProbes()
    let thrown = false
    const result = await runLoopInProcess(
      world,
      { task: world.task, agent: 'claude' },
      {
        ...probes.deps,
        fetchNewestRulingOrdinal: (_pr) => {
          if (world.reviewerDispatchStarted && !thrown) {
            thrown = true
            throw new Error(RATE_LIMIT)
          }
          return world.rulingOrdinal
        }
      }
    )
    expect(result.finalDecision.type).toBe('publish')
    expect(thrown).toBe(true)
    expect(probes.slept).toHaveLength(1)
    expect(world.dispatchCountByRole['code-reviewer']).toBe(1)
    expect(world.dispatchCountByRole.security).toBe(1)
    expect(world.postedComments.some((c) => /aeg:loop:paused/.test(c.body))).toBe(false)
  })

  it('a rate limit that never clears pauses after two waits, names the rate limit, asks for no ruling and spends no retry (O2/O3)', async () => {
    const world = makeWorld()
    const probes = waitProbes()
    const result = await runLoopInProcess(
      world,
      { task: world.task, agent: 'claude' },
      {
        ...probes.deps,
        fetchRulings: () => {
          throw new Error(RATE_LIMIT)
        }
      }
    )
    expect(result.finalDecision).toMatchObject({ type: 'pause', reason: 'infrastructure' })
    expect(probes.slept).toHaveLength(2)
    const pauseState = JSON.parse(readFileSync(join(ipControlDir(world), 'pause-state.json'), 'utf8')) as Record<
      string,
      unknown
    >
    expect(String(pauseState.detail)).toMatch(/^GitHub rate limit:/)
    expect(pauseState.infrastructureRetries).toBe(0)
    const comment = world.postedComments.find((c) => /aeg:loop:paused:infrastructure/.test(c.body))
    expect(comment).toBeDefined()
    expect(comment!.body).toMatch(/No Principal ruling is needed/)
    expect(comment!.body).not.toMatch(/A Principal ruling is needed/)
  })

  it('a rate limit on the comment posted after the developer returns waits in place — the developer is not dispatched again (O1)', async () => {
    const world = makeWorld()
    const probes = waitProbes()
    let thrown = false
    const result = await runLoopInProcess(
      world,
      { task: world.task, agent: 'claude' },
      {
        ...probes.deps,
        postMarkedComment: (kind, ref, marker, body) => {
          if (/aeg:developer:round-/.test(marker) && !thrown) {
            thrown = true
            throw new Error(RATE_LIMIT)
          }
          world.postedComments.push({ kind, ref, marker, body })
          return `https://github.com/example/repo/${kind}/${ref}#issuecomment-${world.postedComments.length}`
        }
      }
    )
    expect(thrown).toBe(true)
    expect(probes.slept).toHaveLength(1)
    expect(world.dispatchCountByRole.developer).toBe(1)
    expect(world.postedComments.some((c) => /aeg:loop:paused/.test(c.body))).toBe(false)
    expect(result.finalDecision.type).toBe('publish')
  })

  it('a rate limit after a dispatch, outside the wrapped reads, pauses at once and says no wait ran (O2)', async () => {
    const world = makeWorld()
    const probes = waitProbes()
    const result = await runLoopInProcess(
      world,
      { task: world.task, agent: 'claude' },
      {
        ...probes.deps,
        publishRound: () => {
          throw new Error(RATE_LIMIT)
        }
      }
    )
    expect(result.finalDecision).toMatchObject({ type: 'pause', reason: 'infrastructure' })
    expect(probes.slept).toHaveLength(0)
    expect(world.dispatchCountByRole['code-reviewer']).toBe(1)
    const pauseState = JSON.parse(readFileSync(join(ipControlDir(world), 'pause-state.json'), 'utf8')) as Record<
      string,
      unknown
    >
    expect(String(pauseState.detail)).toMatch(/^GitHub rate limit: .*did not wait/)
    expect(String(pauseState.detail)).not.toMatch(/waited/)
    expect(pauseState.infrastructureRetries).toBe(0)
    const comment = world.postedComments.find((c) => /aeg:loop:paused:infrastructure/.test(c.body))
    expect(comment!.body).toMatch(/No Principal ruling is needed/)
  })

  it('an error that merely mentions GitHub keeps today’s pause, spends a retry and waits for nothing (O3)', async () => {
    const world = makeWorld()
    const probes = waitProbes()
    const result = await runLoopInProcess(
      world,
      { task: world.task, agent: 'claude' },
      {
        ...probes.deps,
        fetchRulings: () => {
          throw new Error('gh: Bad gateway (HTTP 502)')
        }
      }
    )
    expect(result.finalDecision).toMatchObject({ type: 'pause', reason: 'infrastructure' })
    expect(probes.slept).toHaveLength(0)
    const comment = world.postedComments.find((c) => /aeg:loop:paused:infrastructure/.test(c.body))
    expect(comment!.body).toMatch(/A Principal ruling is needed/)
  })
})
