import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assembleDeveloperDoctrine,
  checkDocumentationSourcesReadable,
  checkTaskDispatchReadiness,
  createTaskWorktree,
  createTaskWorktreeFromRemote,
  DEVELOPER_CHECKLIST_HEADINGS,
  developerBranchFor,
  extractDeveloperSection,
  launchNeverSpawned,
  reconcileLaunch,
  type ReconcileLaunchDeps,
  renderDeveloperDoctrineBlock,
  TaskWorktreeDivergedError
} from '../../../src/lib/dev-review-loop/developer-dispatch'
import {
  FetchTransportError,
  type FetchDocumentationDeps,
  type RawResponse
} from '../../../src/lib/task-tools/fetch-documentation'
import { ownChangesRangeBase } from '../../../src/lib/dev-review-loop'
import type { LaunchRecord, ParsedLaunch } from '../../../src/lib/dispatch'

// task-run-v1 task 15, O1: `developerBranchFor` derives `task/issue-<n>` for
// a backlog Issue (no `[<tranche>] <n> — …` title, no `vinaya/tranche:*`
// label) instead of throwing — the same function, extended to a second
// branch shape, never a synthetic tranche.

describe('developerBranchFor', () => {
  it('derives task/<tranche>/<n> from a tranche-shaped title', () => {
    const branch = developerBranchFor(
      521,
      () => '[task-run-v1] 15 — A backlog Issue runs like a task',
      () => ['vinaya/tranche:task-run-v1']
    )
    expect(branch).toBe('task/task-run-v1/15')
  })

  it('derives task/issue-<n> for a backlog Issue with no tranche-shaped title or label', () => {
    const branch = developerBranchFor(
      600,
      () => 'Fix the flaky retry loop',
      () => []
    )
    expect(branch).toBe('task/issue-600')
  })

  it('throws when the title fails to parse but the Issue still carries a tranche label — a real defect, not a backlog Issue', () => {
    expect(() =>
      developerBranchFor(
        601,
        () => 'not a tranche-shaped title',
        () => ['vinaya/tranche:some-tranche']
      )
    ).toThrow(/does not match the `\[<tranche>\] <n> — …` shape, but it carries a vinaya\/tranche:\* label/)
  })

  // `#548` v3, O3: the label decides, never the title. An unlabeled backlog
  // Issue whose title happens to look tranche-shaped (copy-paste, or a
  // coincidence) must still poll `task/issue-<n>` — the OLD code checked the
  // title first and would have derived `task/some-slug/1` here instead.
  it('derives task/issue-<n> for an unlabeled Issue even when its title is tranche-shaped', () => {
    const branch = developerBranchFor(
      602,
      () => '[some-slug] 1 — looks like a tranche task but carries no tranche label',
      () => []
    )
    expect(branch).toBe('task/issue-602')
  })
})

// Principal ruling: the driver runs this task's dispatch-readiness gate
// from its own unsandboxed process, before every Developer turn — never
// inside the Developer's own sandbox, where either script's own `gh` call
// (spawned by `bun`, never typed directly) hits the denied forge-token
// file. `checkTaskDispatchReadiness` is the pure composition this gets
// built from — `runGate` injected so these tests never shell out to a real
// `bun`/forge.
const ACTIVE_LOCAL_GATE = () => ({ control: 'local-gate', active: true, detail: '', remedy: '' })

describe('checkTaskDispatchReadiness', () => {
  it('runs both scripts with <tranche> <n> derived from a task/<tranche>/<n> branch, and is ready when both exit clean', () => {
    const calls: { script: string; args: readonly string[] }[] = []
    const result = checkTaskDispatchReadiness(
      'task/agent-confinement-v1/7',
      (script, args) => {
        calls.push({ script, args })
        return `${script} ok`
      },
      ACTIVE_LOCAL_GATE
    )
    expect(result.ready).toBe(true)
    expect(calls.map((c) => c.args)).toEqual([
      ['agent-confinement-v1', '7'],
      ['agent-confinement-v1', '7', '--existing-work']
    ])
    expect(calls[0]?.script.endsWith('check-dispatch-readiness.ts')).toBe(true)
    expect(calls[1]?.script.endsWith('verify-dispatch.ts')).toBe(true)
    expect(result.output).toContain('check-dispatch-readiness.ts ok')
    expect(result.output).toContain('verify-dispatch.ts ok')
  })

  it('runs both scripts with --issue <n> derived from a task/issue-<n> branch', () => {
    const calls: { script: string; args: readonly string[] }[] = []
    checkTaskDispatchReadiness(
      'task/issue-600',
      (script, args) => {
        calls.push({ script, args })
        return 'ok'
      },
      ACTIVE_LOCAL_GATE
    )
    expect(calls.map((c) => c.args)).toEqual([
      ['--issue', '600'],
      ['--issue', '600', '--existing-work']
    ])
  })

  it('is NOT ready, and stages the thrown stdout/stderr, when either script exits non-zero', () => {
    const result = checkTaskDispatchReadiness(
      'task/agent-confinement-v1/7',
      (script) => {
        if (script.includes('check-dispatch-readiness')) return 'READY TO DISPATCH'
        const err = new Error('Command failed') as Error & { stdout: string; stderr: string }
        err.stdout = ''
        err.stderr = 'dispatch-gate depends-on-not-merged: task 6 is not merged yet.'
        throw err
      },
      ACTIVE_LOCAL_GATE
    )
    expect(result.ready).toBe(false)
    expect(result.output).toContain('READY TO DISPATCH')
    expect(result.output).toContain('dispatch-gate depends-on-not-merged')
  })

  it('is NOT ready, with no script ever run, when the branch matches neither task shape', () => {
    const calls: unknown[] = []
    const result = checkTaskDispatchReadiness(
      'main',
      (script, args) => {
        calls.push({ script, args })
        return 'unreachable'
      },
      ACTIVE_LOCAL_GATE
    )
    expect(result.ready).toBe(false)
    expect(calls).toEqual([])
    expect(result.output).toContain("branch 'main' matches neither")
  })
})

// A launch refused before any vendor
// process started has no session AND no turn state to lose, so recovery
// dispatches a fresh developer session instead of pausing the task forever;
// a launch that DID spawn and lost its session still pauses, unchanged.

const RECOVERY_HOST = 'recovery-test-host'

/** A launch record whose defaults describe a cleanly finished, session-bound launch; each case overrides only the lifecycle facts it exercises. */
function launchRecord(overrides: Partial<LaunchRecord> = {}): LaunchRecord {
  return {
    runId: 'run-1',
    role: 'developer',
    agent: 'claude',
    repo: { owner: 'acme', repo: 'widgets' },
    task: 734,
    pr: null,
    round: 1,
    attempt: 2,
    effectId: 'eff-1',
    dispatcherPid: 1000,
    childPid: 2000,
    childStartedAt: null,
    childCommand: null,
    host: RECOVERY_HOST,
    startedAt: '2026-09-26T00:00:00.000Z',
    status: 'completed',
    resumeId: 'sess-1',
    boundAt: '2026-09-26T00:00:01.000Z',
    finishedAt: '2026-09-26T00:00:02.000Z',
    failureReason: null,
    ...overrides
  }
}

/** Deps that find no process at all — every case below reconciles a launch that is already over. */
const noProcess: ReconcileLaunchDeps = {
  isPidAlive: () => false,
  hostname: () => RECOVERY_HOST,
  getProcessSnapshot: () => null,
  terminateChild: () => {}
}

/** The pre-spawn refusal shape `dispatchRole` writes: a terminal record, a reason, and no child pid ever stamped. */
function preSpawnRefusal(failureReason: LaunchRecord['failureReason']): { status: 'ok'; record: LaunchRecord } {
  return {
    status: 'ok',
    record: launchRecord({
      status: 'interrupted',
      failureReason,
      childPid: null,
      childStartedAt: null,
      childCommand: null,
      resumeId: null,
      boundAt: null,
      finishedAt: '2026-09-26T00:00:02.000Z'
    })
  }
}

describe('reconcileLaunch — a launch refused before any process started (O1/O2)', () => {
  it.each([['authentication-failed'], ['startup-failed'], ['hook-setup-failed'], ['refused']] as const)(
    'a pre-spawn %s refusal dispatches fresh — never the continuity pause',
    (failureReason) => {
      const out = reconcileLaunch(preSpawnRefusal(failureReason), { requireContinuity: true }, noProcess)
      expect(out.kind).toBe('fresh')
    }
  )

  it('is decided from the record, not from the reason string — an unrecognised future pre-spawn reason needs no new case', () => {
    // `launchNeverSpawned` is the whole decision, and it never reads which
    // reason the record carries: a reason this code has never heard of, on
    // the same never-spawned lifecycle shape, still dispatches fresh.
    expect(launchNeverSpawned(preSpawnRefusal('connection-failed').record)).toBe(true)
  })

  it('a launch that DID spawn and lost its session still pauses — continuity is only waived when there was none', () => {
    const parsed: ParsedLaunch = {
      status: 'ok',
      record: launchRecord({ status: 'interrupted', failureReason: 'crash', resumeId: null, boundAt: null })
    }
    const out = reconcileLaunch(parsed, { requireContinuity: true }, noProcess)
    expect(out.kind).toBe('pause')
    if (out.kind === 'pause') expect(out.detail).toContain('would lose worker continuity')
  })

  it('a launch interrupted before its pid was ever stamped is possibly-spawned, and still pauses', () => {
    // The dispatcher died in the window between `spawn` returning and the
    // pid being stamped: the record never reached a terminal state, so
    // "no pid on record" is not proof that nothing ran.
    const parsed: ParsedLaunch = {
      status: 'ok',
      record: launchRecord({ status: 'launched', failureReason: null, childPid: null, resumeId: null, boundAt: null })
    }
    expect(launchNeverSpawned(parsed.record)).toBe(false)
    expect(reconcileLaunch(parsed, { requireContinuity: true }, noProcess).kind).toBe('pause')
  })

  it('a pre-spawn refusal whose session was somehow bound still resumes that exact session', () => {
    const parsed: ParsedLaunch = {
      status: 'ok',
      record: launchRecord({ status: 'interrupted', failureReason: 'authentication-failed', resumeId: 'sess-live' })
    }
    const out = reconcileLaunch(parsed, { requireContinuity: true }, noProcess)
    expect(out.kind).toBe('resume')
  })
})

// --- the developer doctrine prepended to a fresh dispatch (role-reach-v1/2) ---

// A short version followed by the two checklist sections and an unrelated
// third — the reference-document shape `resolveDeveloperDoctrineText` reads for
// the core role. The trailing `---` rule closes the short version exactly as
// the real developer role file does.
const DEV_SHORT = 'THE SHORT VERSION.\n\nYou execute one brief on one branch.\n\n---'
const REFERENCE_BODY = [
  '## Stop conditions',
  '',
  'STOP when a pre-flight check fails.',
  '- a `depends-on` PR is not merged',
  '',
  '## What the Developer does NOT do',
  '',
  'Author own briefs.',
  '',
  '## Verification before reporting done',
  '',
  'Run typecheck, lint, tests before opening the PR.',
  '',
  '## Verification — the phase between review and merge',
  '',
  'Runs the Test Plan against a booted app.'
].join('\n')

describe('extractDeveloperSection', () => {
  it('returns a `## <heading>` section body up to the next `## ` heading, trimmed', () => {
    expect(extractDeveloperSection(REFERENCE_BODY, 'Stop conditions')).toBe(
      'STOP when a pre-flight check fails.\n- a `depends-on` PR is not merged'
    )
    // Bounded by the NEXT `## ` — never bleeds into `## Verification — the
    // phase between review and merge`, which follows it.
    expect(extractDeveloperSection(REFERENCE_BODY, 'Verification before reporting done')).toBe(
      'Run typecheck, lint, tests before opening the PR.'
    )
  })

  it('returns an empty string when the heading is absent', () => {
    expect(extractDeveloperSection(REFERENCE_BODY, 'What you check')).toBe('')
  })
})

describe('assembleDeveloperDoctrine', () => {
  it('is the short version (trailing rule stripped) plus both checklist sections, in doctrine order', () => {
    const out = assembleDeveloperDoctrine(DEV_SHORT, REFERENCE_BODY)
    expect(out).toBe(
      [
        'THE SHORT VERSION.\n\nYou execute one brief on one branch.',
        '## Stop conditions\n\nSTOP when a pre-flight check fails.\n- a `depends-on` PR is not merged',
        '## Verification before reporting done\n\nRun typecheck, lint, tests before opening the PR.'
      ].join('\n\n')
    )
    // The trailing `---` that closes the short version never survives into the block.
    expect(out).not.toContain('---')
    // The two headings appear in the ruled order — Stop conditions before Verification.
    const [a, b] = DEVELOPER_CHECKLIST_HEADINGS
    expect((out ?? '').indexOf(`## ${a}`)).toBeLessThan((out ?? '').indexOf(`## ${b}`))
  })

  it('drops a section absent from the source rather than fabricating it — the reviewer graceful-degrade precedent', () => {
    const onlyStop = '## Stop conditions\n\nSTOP when a pre-flight check fails.'
    expect(assembleDeveloperDoctrine(DEV_SHORT, onlyStop)).toBe(
      'THE SHORT VERSION.\n\nYou execute one brief on one branch.\n\n## Stop conditions\n\nSTOP when a pre-flight check fails.'
    )
  })

  it('returns the short version alone when the source carries neither section', () => {
    expect(assembleDeveloperDoctrine(DEV_SHORT, 'no headings here')).toBe(
      'THE SHORT VERSION.\n\nYou execute one brief on one branch.'
    )
  })

  it('reads both sections from the same body — the adopter-override shape, where they live inline', () => {
    const overrideBody = `${DEV_SHORT}\n\n${REFERENCE_BODY}`
    const out = assembleDeveloperDoctrine(DEV_SHORT, overrideBody)
    expect(out).toContain('## Stop conditions')
    expect(out).toContain('## Verification before reporting done')
  })

  it('returns null when there is no short version at all (an unresolved role)', () => {
    expect(assembleDeveloperDoctrine(null, REFERENCE_BODY)).toBeNull()
    expect(assembleDeveloperDoctrine('   \n  ', REFERENCE_BODY)).toBeNull()
  })
})

describe('renderDeveloperDoctrineBlock', () => {
  it('labels the block and names the doctrine COMMAND, never a repository path an adopter lacks (O2)', () => {
    const block = renderDeveloperDoctrineBlock(assembleDeveloperDoctrine(DEV_SHORT, REFERENCE_BODY) ?? '')
    expect(block).toContain('YOUR ROLE DOCTRINE')
    expect(block).toContain('THE SHORT VERSION.')
    expect(block).toContain('## Stop conditions')
    expect(block).toContain('bun apps/cli/src/index.ts doctrine --role developer --print')
    expect(block).not.toContain('aeg-root/roles/developer.md')
  })
})

// O1: real git, real worktree — `createTaskWorktree`
// shells out directly (`sh()`, no injectable deps), so these drive a real
// local checkout with a real `origin` remote rather than faking git calls.
describe('createTaskWorktree (O1)', () => {
  function initRepoWithOrigin(): { repoDir: string; originDir: string } {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'vinaya-create-task-worktree-')))
    const originDir = join(base, 'origin.git')
    const repoDir = join(base, 'repo')
    execFileSync('git', ['init', '--bare', '-b', 'main', originDir])
    execFileSync('git', ['init', '-b', 'main', repoDir])
    const run = (args: string[]): void => {
      execFileSync('git', args, { cwd: repoDir })
    }
    run(['config', 'user.email', 'test@example.com'])
    run(['config', 'user.name', 'Test'])
    run(['commit', '--allow-empty', '-m', 'initial'])
    run(['remote', 'add', 'origin', originDir])
    run(['push', 'origin', 'main'])
    run(['fetch', 'origin'])
    return { repoDir, originDir }
  }

  const cwdStack: string[] = []
  function withCwd<T>(dir: string, fn: () => T): T {
    cwdStack.push(process.cwd())
    process.chdir(dir)
    try {
      return fn()
    } finally {
      const prev = cwdStack.pop()
      if (prev) process.chdir(prev)
    }
  }

  const cleanupDirs: string[] = []
  afterEach(() => {
    for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('creates the worktree on a fresh branch cut from origin/main, then pushes it from the worktree with upstream set', () => {
    const { repoDir, originDir } = initRepoWithOrigin()
    cleanupDirs.push(repoDir, originDir)
    const branch = 'task/x/1'

    withCwd(repoDir, () => createTaskWorktree(branch))

    const worktreeDir = join(repoDir, '.worktrees', branch)
    expect(existsSync(worktreeDir)).toBe(true)
    const checkedOutBranch = execFileSync('git', ['-C', worktreeDir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8'
    }).trim()
    expect(checkedOutBranch).toBe(branch)

    // Pushed FROM the worktree, reached the remote, and the worktree's own
    // upstream is now set (never the bare `--no-track origin/main` the
    // `--no-track` flag left it with at creation).
    const remoteBranches = execFileSync('git', ['-C', originDir, 'branch', '--list', branch], { encoding: 'utf8' })
    expect(remoteBranches).toContain(branch)
    const upstream = execFileSync('git', ['-C', worktreeDir, 'rev-parse', '--abbrev-ref', `${branch}@{upstream}`], {
      encoding: 'utf8'
    }).trim()
    expect(upstream).toBe(`origin/${branch}`)
  })

  // Ruling 1, finding 4: a regression test that fails if `--no-verify` is
  // ever dropped from the branch-creation ref push. A managed pre-push hook
  // that unconditionally exits 1 stands in for the real dispatch-readiness
  // gate a fresh worktree (no `apps/cli/dist`) cannot pass — hooks live in
  // the shared `.git` common dir, so this one hook covers a push run from
  // either the main checkout or the worktree. `createTaskWorktree` must
  // still succeed (the ref push is commit-free and `--no-verify`d), proving
  // the hook was bypassed rather than satisfied.
  it('creates the remote branch even when the local pre-push hook unconditionally refuses (--no-verify)', () => {
    const { repoDir, originDir } = initRepoWithOrigin()
    cleanupDirs.push(repoDir, originDir)
    const branch = 'task/x/3'

    const hooksDir = join(repoDir, '.git', 'hooks')
    mkdirSync(hooksDir, { recursive: true })
    const hookPath = join(hooksDir, 'pre-push')
    writeFileSync(hookPath, '#!/bin/sh\nexit 1\n', { mode: 0o755 })

    withCwd(repoDir, () => createTaskWorktree(branch))

    const remoteBranches = execFileSync('git', ['-C', originDir, 'branch', '--list', branch], { encoding: 'utf8' })
    expect(remoteBranches).toContain(branch)
    const worktreeDir = join(repoDir, '.worktrees', branch)
    const upstream = execFileSync('git', ['-C', worktreeDir, 'rev-parse', '--abbrev-ref', `${branch}@{upstream}`], {
      encoding: 'utf8'
    }).trim()
    expect(upstream).toBe(`origin/${branch}`)
  })

  it('reuses an already-existing worktree rather than recreating it (Traps to avoid)', () => {
    const { repoDir, originDir } = initRepoWithOrigin()
    cleanupDirs.push(repoDir, originDir)
    const branch = 'task/x/2'

    withCwd(repoDir, () => createTaskWorktree(branch))
    const worktreeDir = join(repoDir, '.worktrees', branch)
    const headAfterFirst = execFileSync('git', ['-C', worktreeDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

    // A second call must not attempt `git worktree add` again (which would
    // fail outright against an already-existing branch/dir) — it only
    // re-pushes/re-asserts the upstream.
    withCwd(repoDir, () => createTaskWorktree(branch))
    const headAfterSecond = execFileSync('git', ['-C', worktreeDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    expect(headAfterSecond).toBe(headAfterFirst)
  })
})

// A restarted task's existing worktree is reconciled with the remote branch,
// never overwritten: real git, a real `origin`, a default branch that moves on.
describe('createTaskWorktree on a restart with an existing worktree', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  function setup(): { repoDir: string; originDir: string; worktreeDir: string; branch: string } {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'vinaya-restart-worktree-')))
    dirs.push(base)
    const originDir = join(base, 'origin.git')
    const repoDir = join(base, 'repo')
    execFileSync('git', ['init', '--bare', '-b', 'main', originDir])
    execFileSync('git', ['init', '-b', 'main', repoDir])
    const git = (args: string[], cwd = repoDir): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    git(['commit', '--allow-empty', '-m', 'initial'])
    git(['remote', 'add', 'origin', originDir])
    git(['push', 'origin', 'main'])
    git(['fetch', 'origin'])
    const branch = 'task/issue-9'
    const cwd = process.cwd()
    process.chdir(repoDir)
    try {
      createTaskWorktree(branch)
    } finally {
      process.chdir(cwd)
    }
    return { repoDir, originDir, worktreeDir: join(repoDir, '.worktrees', branch), branch }
  }

  function advanceMain(repoDir: string): void {
    writeFileSync(join(repoDir, 'from-main.txt'), 'main moved on\n')
    execFileSync('git', ['add', 'from-main.txt'], { cwd: repoDir })
    execFileSync('git', ['commit', '-m', 'main moves on'], { cwd: repoDir })
    execFileSync('git', ['push', 'origin', 'main'], { cwd: repoDir })
  }

  const rev = (dir: string, ref: string): string =>
    execFileSync('git', ['-C', dir, 'rev-parse', ref], { encoding: 'utf8' }).trim()

  it('leaves the remote branch unmoved and the task publishes only its own paths', () => {
    const { repoDir, originDir, worktreeDir, branch } = setup()
    const remoteBefore = rev(originDir, branch)
    writeFileSync(join(worktreeDir, 'own-work.txt'), 'unpublished\n')
    advanceMain(repoDir)

    const cwd = process.cwd()
    process.chdir(repoDir)
    try {
      createTaskWorktree(branch)
    } finally {
      process.chdir(cwd)
    }

    expect(rev(originDir, branch)).toBe(remoteBefore)
    expect(existsSync(join(worktreeDir, 'own-work.txt'))).toBe(true)
    expect(rev(worktreeDir, 'HEAD')).toBe(remoteBefore)
  })

  it('creates a missing remote branch at the worktree head, not at the default branch tip', () => {
    const { repoDir, originDir, worktreeDir, branch } = setup()
    const worktreeHead = rev(worktreeDir, 'HEAD')
    execFileSync('git', ['push', 'origin', `:refs/heads/${branch}`], { cwd: repoDir })
    advanceMain(repoDir)

    const cwd = process.cwd()
    process.chdir(repoDir)
    try {
      createTaskWorktree(branch)
    } finally {
      process.chdir(cwd)
    }

    expect(rev(originDir, branch)).toBe(worktreeHead)
    expect(rev(originDir, 'main')).not.toBe(worktreeHead)
  })

  it('throws with both heads named when the worktree cannot fast-forward to the remote branch', () => {
    const { repoDir, originDir, worktreeDir, branch } = setup()
    writeFileSync(join(worktreeDir, 'own.txt'), 'task commit\n')
    execFileSync('git', ['-C', worktreeDir, 'add', 'own.txt'])
    execFileSync('git', ['-C', worktreeDir, 'commit', '-m', 'task commit'])
    const worktreeHead = rev(worktreeDir, 'HEAD')
    // Another machine put a different commit on the remote branch.
    const other = join(repoDir, '..', 'other')
    execFileSync('git', ['clone', '-b', branch, originDir, other])
    writeFileSync(join(other, 'elsewhere.txt'), 'elsewhere\n')
    execFileSync('git', ['-C', other, 'add', 'elsewhere.txt'])
    execFileSync('git', ['-C', other, '-c', 'user.email=a@b.c', '-c', 'user.name=T', 'commit', '-m', 'elsewhere'])
    execFileSync('git', ['-C', other, 'push', 'origin', branch])
    const remoteHead = rev(originDir, branch)

    const cwd = process.cwd()
    process.chdir(repoDir)
    let thrown: unknown
    try {
      createTaskWorktree(branch)
    } catch (err) {
      thrown = err
    } finally {
      process.chdir(cwd)
    }

    expect(thrown).toBeInstanceOf(TaskWorktreeDivergedError)
    const diverged = thrown as TaskWorktreeDivergedError
    expect(diverged.branch).toBe(branch)
    expect(diverged.worktreeHead).toBe(worktreeHead)
    expect(diverged.remoteHead).toBe(remoteHead)
    expect(rev(originDir, branch)).toBe(remoteHead)
  })

  it('measures changed paths from the merge base when the pushed head is not an ancestor of the worktree head', () => {
    const { repoDir, worktreeDir } = setup()
    const base = rev(worktreeDir, 'HEAD')
    advanceMain(repoDir)
    const mainTip = rev(repoDir, 'origin/main')
    writeFileSync(join(worktreeDir, 'own.txt'), 'task\n')
    execFileSync('git', ['-C', worktreeDir, 'add', 'own.txt'])
    execFileSync('git', ['-C', worktreeDir, 'commit', '-m', 'task'])

    // The newer default-branch tip is not an ancestor of the task's head.
    expect(ownChangesRangeBase(worktreeDir, mainTip)).toBe(base)
    const paths = execFileSync(
      'git',
      ['-C', worktreeDir, 'diff', '--name-only', ownChangesRangeBase(worktreeDir, mainTip) ?? ''],
      {
        encoding: 'utf8'
      }
    )
      .trim()
      .split('\n')
    expect(paths).toEqual(['own.txt'])
    // An ancestor stays the bound as it is; no bound stays none.
    expect(ownChangesRangeBase(worktreeDir, base)).toBe(base)
    expect(ownChangesRangeBase(worktreeDir, null)).toBeNull()
  })
})

// A task whose required source cannot be read never starts a Developer turn:
// the readiness gate fetches each `## Documentation` URL with the documentation
// tool's own fetch, faked here at its two seams so no test needs a network.
describe('checkDocumentationSourcesReadable', () => {
  const page = (text: string): RawResponse => ({
    status: 200,
    headers: { 'content-type': 'text/plain' },
    body: new TextEncoder().encode(text),
    framed: true
  })
  const depsFor = (respond: (path: string, hostname: string) => RawResponse | Error): FetchDocumentationDeps => ({
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async (target) => {
      const out = respond(target.path, target.hostname)
      if (out instanceof Error) throw out
      return out
    },
    now: () => new Date('2026-01-01T00:00:00Z')
  })
  const briefWith = (...sources: string[]) =>
    `## Documentation\n\n${sources.map((s) => `- ${s} — the mechanism it governs`).join('\n')}\n\n## Premises\n`

  it('is ready when the brief names no source or only an in-repo path, fetching nothing', async () => {
    const deps = depsFor(() => new Error('must not fetch'))
    expect((await checkDocumentationSourcesReadable('## Documentation\n\nNone — nothing governs.\n', deps)).ready).toBe(
      true
    )
    expect((await checkDocumentationSourcesReadable(briefWith('docs/spec.md'), deps)).ready).toBe(true)
  })

  it('is ready when every source answers with a readable page', async () => {
    const result = await checkDocumentationSourcesReadable(
      briefWith('https://example.com/a', 'https://example.com/b'),
      depsFor(() => page('x'.repeat(1500)))
    )
    expect(result.ready).toBe(true)
    expect(result.output).toContain('https://example.com/a read')
    expect(result.output).toContain('https://example.com/b read')
  })

  it('refuses a source that times out as retryable, naming the source', async () => {
    const result = await checkDocumentationSourcesReadable(
      briefWith('https://example.com/slow'),
      depsFor(() => new FetchTransportError('timeout', 'no complete response within 30000ms'))
    )
    expect(result).toMatchObject({ ready: false, retryable: true, source: 'https://example.com/slow' })
    expect(result.output).toContain('timeout')
    expect(result.output).toContain('retryable')
  })

  it('refuses a dropped connection as retryable', async () => {
    const result = await checkDocumentationSourcesReadable(
      briefWith('https://example.com/flaky'),
      depsFor(() => new FetchTransportError('connection-failed', 'ECONNRESET'))
    )
    expect(result).toMatchObject({ ready: false, retryable: true, source: 'https://example.com/flaky' })
  })

  it('refuses an error status as a Planner correction', async () => {
    const result = await checkDocumentationSourcesReadable(
      briefWith('https://example.com/gone'),
      depsFor(() => ({ ...page('x'.repeat(1500)), status: 404 }))
    )
    expect(result).toMatchObject({ ready: false, retryable: false, source: 'https://example.com/gone' })
    expect(result.output).toContain('HTTP 404')
    expect(result.output).toContain('Planner')
  })

  it('refuses a login-page shell as a Planner correction', async () => {
    const result = await checkDocumentationSourcesReadable(
      briefWith('https://example.com/private'),
      depsFor(() => ({
        ...page('<html><body>Sign in</body></html>'),
        headers: { 'content-type': 'text/html' }
      }))
    )
    expect(result).toMatchObject({ ready: false, retryable: false })
    expect(result.output).toContain('Planner')
  })

  it('refuses a source that redirects to another host as a Planner correction', async () => {
    const result = await checkDocumentationSourcesReadable(
      briefWith('https://example.com/moved'),
      depsFor((_path, hostname) =>
        hostname === 'example.com'
          ? { status: 302, headers: { location: 'https://login.other.test/in' }, body: new Uint8Array(), framed: true }
          : page('x'.repeat(1500))
      )
    )
    expect(result).toMatchObject({ ready: false, retryable: false, source: 'https://example.com/moved' })
    expect(result.output).toContain('another host')
  })
})

describe('createTaskWorktreeFromRemote', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

  function setup(): { repoDir: string; originDir: string; remoteHead: string } {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'vinaya-from-remote-')))
    dirs.push(base)
    const originDir = join(base, 'origin.git')
    const repoDir = join(base, 'repo')
    const otherDir = join(base, 'other')
    execFileSync('git', ['init', '--bare', '-b', 'main', originDir])
    for (const dir of [repoDir, otherDir]) {
      execFileSync('git', ['init', '-b', 'main', dir])
      git(dir, 'config', 'user.email', 'test@example.com')
      git(dir, 'config', 'user.name', 'Test')
      git(dir, 'remote', 'add', 'origin', originDir)
    }
    git(repoDir, 'commit', '--allow-empty', '-m', 'initial')
    git(repoDir, 'push', 'origin', 'main')
    // Another machine pushes the task branch with a task commit.
    git(otherDir, 'fetch', 'origin')
    git(otherDir, 'checkout', '-b', 'task/x/2', 'origin/main')
    git(otherDir, 'commit', '--allow-empty', '-m', 'task work')
    git(otherDir, 'push', 'origin', 'task/x/2')
    return { repoDir, originDir, remoteHead: git(otherDir, 'rev-parse', 'HEAD') }
  }

  function inDir<T>(dir: string, fn: () => T): T {
    const prev = process.cwd()
    process.chdir(dir)
    try {
      return fn()
    } finally {
      process.chdir(prev)
    }
  }

  it('creates a tracking worktree at the pushed head though this machine never fetched the branch', () => {
    const { repoDir, remoteHead } = setup()
    inDir(repoDir, () => createTaskWorktreeFromRemote('task/x/2'))
    const wt = join(repoDir, '.worktrees', 'task/x/2')
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(remoteHead)
    expect(git(wt, 'rev-parse', '--abbrev-ref', 'task/x/2@{upstream}')).toBe('origin/task/x/2')
  })

  it('reuses a local branch at the remote head', () => {
    const { repoDir, remoteHead } = setup()
    git(repoDir, 'fetch', 'origin')
    git(repoDir, 'branch', 'task/x/2', remoteHead)
    inDir(repoDir, () => createTaskWorktreeFromRemote('task/x/2'))
    expect(git(join(repoDir, '.worktrees', 'task/x/2'), 'rev-parse', 'HEAD')).toBe(remoteHead)
  })

  it('refuses a local branch at another head, naming both heads, and leaves it untouched', () => {
    const { repoDir, remoteHead } = setup()
    git(repoDir, 'branch', 'task/x/2', 'main')
    const localHead = git(repoDir, 'rev-parse', 'task/x/2')
    expect(() => inDir(repoDir, () => createTaskWorktreeFromRemote('task/x/2'))).toThrow(
      new RegExp(`${localHead}[\\s\\S]*${remoteHead}`)
    )
    expect(git(repoDir, 'rev-parse', 'task/x/2')).toBe(localHead)
    expect(existsSync(join(repoDir, '.worktrees', 'task/x/2'))).toBe(false)
  })
})
