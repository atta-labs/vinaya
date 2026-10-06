/**
 * `task-sweep.ts` — the keep-policy (`classifyTaskFolder`/`sweepModernTasks`)
 * and the earlier-layout listing/attribution (`sweepLegacyLayout`). Every
 * forge read is injected (`TaskSweepDeps`), so these run in-process against
 * plain temp directories rather than shelling out to real `gh`.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyTaskFolder,
  IssueNotFoundError,
  parseWorktreeList,
  removeWorktreeAsync,
  runTaskSweep,
  sweepLegacyLayout,
  sweepModernTasks,
  sweepModernTasksAsync,
  type TaskSweepAsyncDeps,
  type TaskSweepDeps,
  worktreeHasUncommittedAsync,
  worktreeHasUnpushedCommitsAsync
} from '../../src/lib/task-sweep.js'
import { runPath } from '../../src/lib/run-paths.js'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function baseDeps(root: string, overrides: Partial<TaskSweepDeps> = {}): TaskSweepDeps {
  return {
    runtimeDir: () => root,
    isDriverPidAlive: () => false,
    readDriverLockForScope: () => null,
    readPauseStateForScope: () => null,
    fetchIssueState: () => {
      throw new Error('fetchIssueState: not stubbed for this test')
    },
    developerBranchFor: (issue) => `task/issue-${issue}`,
    fetchPrForBranch: () => null,
    fetchPrBody: () => {
      throw new Error('fetchPrBody: not stubbed for this test')
    },
    taskFromPrBody: () => null,
    rm: (p) => rmSync(p, { recursive: true, force: true }),
    resolveRepo: () => ({ owner: 'atta-labs', repo: 'vinaya' }),
    commitExistsInThisRepo: () => false,
    ...overrides
  }
}

describe('classifyTaskFolder', () => {
  it('live: a driver lock naming a live pid wins outright, before any forge read', () => {
    const root = tempDir('vinaya-sweep-live-')
    const deps = baseDeps(root, {
      readDriverLockForScope: () => ({ pid: 4242, startedAt: '2026-09-21T00:00:00.000Z' }),
      isDriverPidAlive: (pid) => pid === 4242,
      fetchIssueState: () => {
        throw new Error('must never be called — a live driver wins before any forge read')
      }
    })
    const cls = classifyTaskFolder(101, root, deps)
    expect(cls.kind).toBe('live')
    expect(cls.reason).toContain('4242')
  })

  it('finished: Issue closed', () => {
    const root = tempDir('vinaya-sweep-finished-issue-')
    const deps = baseDeps(root, { fetchIssueState: () => 'CLOSED' })
    const cls = classifyTaskFolder(102, root, deps)
    expect(cls).toEqual({ kind: 'finished', reason: 'Issue #102 is closed' })
  })

  it('finished: Issue open but pull request merged', () => {
    const root = tempDir('vinaya-sweep-finished-pr-merged-')
    const deps = baseDeps(root, {
      fetchIssueState: () => 'OPEN',
      fetchPrForBranch: () => ({ number: 55, state: 'MERGED' })
    })
    const cls = classifyTaskFolder(103, root, deps)
    expect(cls.kind).toBe('finished')
    expect(cls.reason).toContain('PR #55 is merged')
  })

  it('finished: Issue open but pull request closed (never merged)', () => {
    const root = tempDir('vinaya-sweep-finished-pr-closed-')
    const deps = baseDeps(root, {
      fetchIssueState: () => 'OPEN',
      fetchPrForBranch: () => ({ number: 56, state: 'CLOSED' })
    })
    const cls = classifyTaskFolder(104, root, deps)
    expect(cls.kind).toBe('finished')
    expect(cls.reason).toContain('PR #56 is closed')
  })

  it('open: Issue open, pull request open', () => {
    const root = tempDir('vinaya-sweep-open-')
    const deps = baseDeps(root, {
      fetchIssueState: () => 'OPEN',
      fetchPrForBranch: () => ({ number: 57, state: 'OPEN' })
    })
    const cls = classifyTaskFolder(105, root, deps)
    expect(cls.kind).toBe('open')
    expect(cls.reason).toContain('PR #57 open')
  })

  it('open: Issue open, no pull request yet', () => {
    const root = tempDir('vinaya-sweep-open-no-pr-')
    const deps = baseDeps(root, { fetchIssueState: () => 'OPEN', fetchPrForBranch: () => null })
    const cls = classifyTaskFolder(106, root, deps)
    expect(cls.kind).toBe('open')
    expect(cls.reason).toContain('no pull request yet')
  })

  it('paused: a pause-awaiting-ruling record, even with an open PR', () => {
    const root = tempDir('vinaya-sweep-paused-')
    const deps = baseDeps(root, {
      fetchIssueState: () => 'OPEN',
      fetchPrForBranch: () => ({ number: 58, state: 'OPEN' }),
      readPauseStateForScope: () => ({ reason: 'escalation' })
    })
    const cls = classifyTaskFolder(107, root, deps)
    expect(cls.kind).toBe('paused')
    expect(cls.reason).toContain('escalation')
  })

  it('unknown: the forge cannot be read — kept, never guessed as finished', () => {
    const root = tempDir('vinaya-sweep-unreadable-')
    const deps = baseDeps(root, {
      fetchIssueState: () => {
        throw new Error('gh: rate limited')
      }
    })
    const cls = classifyTaskFolder(108, root, deps)
    expect(cls.kind).toBe('unknown')
    expect(cls.reason).toContain('gh: rate limited')
  })

  it('finished: the forge reports the Issue as nonexistent — an orphan, removed', () => {
    const root = tempDir('vinaya-sweep-orphan-')
    const deps = baseDeps(root, {
      fetchIssueState: (issue) => {
        throw new IssueNotFoundError(issue)
      }
    })
    const cls = classifyTaskFolder(9001, root, deps)
    expect(cls.kind).toBe('finished')
    expect(cls.reason).toContain('does not exist')
  })

  it('unknown: an unscoped dispatch folder has nothing to check against the forge', () => {
    const root = tempDir('vinaya-sweep-unscoped-')
    const deps = baseDeps(root)
    const cls = classifyTaskFolder('unscoped', root, deps)
    expect(cls.kind).toBe('unknown')
    expect(cls.reason).toContain('unscoped')
  })

  it("a {pr} scope resolves its task via the PR body's `Closes #N`", () => {
    const root = tempDir('vinaya-sweep-pr-scope-')
    const deps = baseDeps(root, {
      fetchPrBody: () => 'Some report\n\nCloses #109\n',
      taskFromPrBody: (body) => {
        const m = /Closes #(\d+)/.exec(body)
        return m ? Number(m[1]) : null
      },
      fetchIssueState: () => 'CLOSED'
    })
    const cls = classifyTaskFolder({ pr: 60 }, root, deps)
    expect(cls).toEqual({ kind: 'finished', reason: 'Issue #109 is closed' })
  })

  it('unknown: a {pr} scope whose body carries no `Closes #N`', () => {
    const root = tempDir('vinaya-sweep-pr-scope-no-closes-')
    const deps = baseDeps(root, { fetchPrBody: () => 'no closes line here' })
    const cls = classifyTaskFolder({ pr: 61 }, root, deps)
    expect(cls.kind).toBe('unknown')
    expect(cls.reason).toContain('Closes #N')
  })
})

describe('sweepModernTasks', () => {
  it('removes exactly the finished folders and keeps the rest, each with its reason — never touching the excluded (own) task', () => {
    const root = tempDir('vinaya-sweep-modern-')
    for (const task of [201, 202, 203, 204, 205]) {
      mkdirSync(runPath(root, task, { area: 'task' }), { recursive: true })
      writeFileSync(runPath(root, task, { area: 'task', file: 'marker.txt' }), String(task))
    }
    const deps = baseDeps(root, {
      fetchIssueState: (issue) => (issue === 201 ? 'CLOSED' : 'OPEN'),
      fetchPrForBranch: (branch) => (branch.endsWith('202') ? { number: 1, state: 'MERGED' } : null),
      readDriverLockForScope: (r, scope) =>
        scope === 204 ? { pid: process.pid, startedAt: '2026-09-21T00:00:00.000Z' } : null,
      isDriverPidAlive: (pid) => pid === process.pid,
      readPauseStateForScope: (r, scope) => (scope === 203 ? { reason: 'confidence' } : null)
    })

    const report = sweepModernTasks(deps, 205)

    const removedFolders = report.removed.map((r) => r.folder).sort()
    expect(removedFolders).toEqual(['Issue #201', 'Issue #202'])
    expect(existsSync(runPath(root, 201, { area: 'task' }))).toBe(false)
    expect(existsSync(runPath(root, 202, { area: 'task' }))).toBe(false)

    const kept = Object.fromEntries(report.kept.map((k) => [k.folder, k.reason]))
    expect(kept['Issue #203']).toContain('paused')
    expect(kept['Issue #204']).toContain('live')
    expect(kept['Issue #205']).toContain('own task')
    expect(existsSync(runPath(root, 203, { area: 'task' }))).toBe(true)
    expect(existsSync(runPath(root, 204, { area: 'task' }))).toBe(true)
    expect(existsSync(runPath(root, 205, { area: 'task' }))).toBe(true)
  })

  it('removes nothing when the tasks-execution directory does not exist yet', () => {
    const root = tempDir('vinaya-sweep-empty-')
    const deps = baseDeps(root)
    const report = sweepModernTasks(deps)
    expect(report).toEqual({ removed: [], kept: [] })
  })

  it('removes nothing when the forge read fails for every folder', () => {
    const root = tempDir('vinaya-sweep-all-unreadable-')
    for (const task of [301, 302]) {
      mkdirSync(runPath(root, task, { area: 'task' }), { recursive: true })
    }
    const deps = baseDeps(root, {
      fetchIssueState: () => {
        throw new Error('gh: not authenticated')
      }
    })
    const report = sweepModernTasks(deps)
    expect(report.removed).toEqual([])
    expect(report.kept.every((k) => k.reason.includes('not authenticated'))).toBe(true)
    expect(existsSync(runPath(root, 301, { area: 'task' }))).toBe(true)
    expect(existsSync(runPath(root, 302, { area: 'task' }))).toBe(true)
  })
})

describe('sweepLegacyLayout', () => {
  function homeDir(): string {
    return tempDir('vinaya-sweep-legacy-home-')
  }

  it('attributes control-store/<task>/ via its own manifest record, and removes it only when finished AND --include-legacy', () => {
    const home = homeDir()
    const root = tempDir('vinaya-sweep-legacy-root-')
    const manifestDir = join(home, 'control-store', '401', 'manifest')
    mkdirSync(manifestDir, { recursive: true })
    writeFileSync(
      join(manifestDir, 'round-000001.json'),
      JSON.stringify({ repository: 'atta-labs/vinaya', pr: 1, branch: 'task/issue-401', round: 1 })
    )
    const deps = baseDeps(root, { fetchIssueState: () => 'CLOSED' })

    const listOnly = sweepLegacyLayout(false, deps, home)
    const entry = listOnly.entries.find((e) => e.dirname === 'control-store')
    expect(entry?.attribution.kind).toBe('this-repo')
    expect(entry?.class?.kind).toBe('finished')
    expect(entry?.removed).toBe(false)
    expect(existsSync(join(home, 'control-store', '401'))).toBe(true)

    const withRemoval = sweepLegacyLayout(true, deps, home)
    const removedEntry = withRemoval.entries.find((e) => e.dirname === 'control-store')
    expect(removedEntry?.removed).toBe(true)
    expect(existsSync(join(home, 'control-store', '401'))).toBe(false)
  })

  it('reports a control-store task with no manifest record as unattributable, and never removes it', () => {
    const home = homeDir()
    const root = tempDir('vinaya-sweep-legacy-root2-')
    mkdirSync(join(home, 'control-store', '402'), { recursive: true })
    writeFileSync(join(home, 'control-store', '402', 'driver.pid.json'), '{}')
    const deps = baseDeps(root, { fetchIssueState: () => 'CLOSED' })

    const report = sweepLegacyLayout(true, deps, home)
    const entry = report.entries.find((e) => e.dirname === 'control-store')
    expect(entry?.attribution.kind).toBe('unattributable')
    expect(entry?.removed).toBe(false)
    expect(existsSync(join(home, 'control-store', '402'))).toBe(true)
  })

  it('never attributes a control-store task whose manifest names a different repository', () => {
    const home = homeDir()
    const root = tempDir('vinaya-sweep-legacy-root3-')
    const manifestDir = join(home, 'control-store', '403', 'manifest')
    mkdirSync(manifestDir, { recursive: true })
    writeFileSync(join(manifestDir, 'round-000001.json'), JSON.stringify({ repository: 'other-org/other-repo' }))
    const deps = baseDeps(root, { fetchIssueState: () => 'CLOSED' })

    const report = sweepLegacyLayout(true, deps, home)
    const entry = report.entries.find((e) => e.dirname === 'control-store')
    expect(entry?.attribution.kind).toBe('other-repo')
    expect(entry?.removed).toBe(false)
    expect(existsSync(join(home, 'control-store', '403'))).toBe(true)
  })

  it('attributes loops/<owner>-<repo>/<issue>.log by its own repo-segment directory name', () => {
    const home = homeDir()
    const root = tempDir('vinaya-sweep-legacy-root4-')
    mkdirSync(join(home, 'loops', 'atta-labs-vinaya'), { recursive: true })
    writeFileSync(join(home, 'loops', 'atta-labs-vinaya', '404.log'), 'narration')
    mkdirSync(join(home, 'loops', 'other-owner-other-repo'), { recursive: true })
    writeFileSync(join(home, 'loops', 'other-owner-other-repo', '999.log'), 'narration')
    const deps = baseDeps(root, { fetchIssueState: () => 'CLOSED' })

    const report = sweepLegacyLayout(true, deps, home)
    const mine = report.entries.find((e) => e.path.includes('404.log'))
    const theirs = report.entries.find((e) => e.path.includes('999.log'))
    expect(mine?.attribution).toEqual({ kind: 'this-repo', scope: 404 })
    expect(mine?.removed).toBe(true)
    expect(existsSync(join(home, 'loops', 'atta-labs-vinaya', '404.log'))).toBe(false)
    expect(theirs?.attribution.kind).toBe('other-repo')
    expect(existsSync(join(home, 'loops', 'other-owner-other-repo', '999.log'))).toBe(true)
  })

  it('attributes dispatch-resume records by repo segment and scope suffix, and keeps an unscoped one always', () => {
    const home = homeDir()
    const root = tempDir('vinaya-sweep-legacy-root5-')
    const repoDir = join(home, 'dispatch-resume', 'atta-labs-vinaya')
    mkdirSync(repoDir, { recursive: true })
    writeFileSync(join(repoDir, 'developer-claude-issue405.json'), '{}')
    writeFileSync(join(repoDir, 'developer-claude-unscoped.json'), '{}')
    const deps = baseDeps(root, { fetchIssueState: () => 'CLOSED' })

    const report = sweepLegacyLayout(true, deps, home)
    const scoped = report.entries.find((e) => e.path.includes('issue405'))
    const unscoped = report.entries.find((e) => e.path.includes('unscoped'))
    expect(scoped?.attribution).toEqual({ kind: 'this-repo', scope: 405 })
    expect(scoped?.removed).toBe(true)
    expect(unscoped?.attribution.kind).toBe('unattributable')
    expect(unscoped?.removed).toBe(false)
    expect(existsSync(join(repoDir, 'developer-claude-unscoped.json'))).toBe(true)
  })

  it('dispatch-output, dispatch-settings and task-start are always reported unattributable, never removed', () => {
    const home = homeDir()
    const root = tempDir('vinaya-sweep-legacy-root6-')
    mkdirSync(join(home, 'dispatch-output'), { recursive: true })
    writeFileSync(join(home, 'dispatch-output', 'effect-abc123.log'), 'raw bytes')
    mkdirSync(join(home, 'dispatch-settings'), { recursive: true })
    writeFileSync(join(home, 'dispatch-settings', 'deny-background-bash.mjs'), '// script')
    mkdirSync(join(home, 'task-start'), { recursive: true })
    writeFileSync(join(home, 'task-start', 'req-xyz.json'), '{}')
    const deps = baseDeps(root)

    const report = sweepLegacyLayout(true, deps, home)
    const byDirname = (d: string) => report.entries.filter((e) => e.dirname === d)
    for (const dirname of ['dispatch-output', 'dispatch-settings', 'task-start']) {
      const entries = byDirname(dirname)
      expect(entries.length).toBeGreaterThan(0)
      for (const e of entries) {
        expect(e.attribution.kind).toBe('unattributable')
        expect(e.removed).toBe(false)
      }
    }
    expect(existsSync(join(home, 'dispatch-output', 'effect-abc123.log'))).toBe(true)
    expect(existsSync(join(home, 'dispatch-settings', 'deny-background-bash.mjs'))).toBe(true)
    expect(existsSync(join(home, 'task-start', 'req-xyz.json'))).toBe(true)
  })

  it('never removes an attributed entry when --include-legacy is absent, listing it only', () => {
    const home = homeDir()
    const root = tempDir('vinaya-sweep-legacy-root7-')
    mkdirSync(join(home, 'loops', 'atta-labs-vinaya'), { recursive: true })
    writeFileSync(join(home, 'loops', 'atta-labs-vinaya', '406.log'), 'narration')
    const deps = baseDeps(root, { fetchIssueState: () => 'CLOSED' })

    const report = sweepLegacyLayout(false, deps, home)
    const entry = report.entries.find((e) => e.path.includes('406.log'))
    expect(entry?.attribution.kind).toBe('this-repo')
    expect(entry?.class?.kind).toBe('finished')
    expect(entry?.removed).toBe(false)
    expect(existsSync(join(home, 'loops', 'atta-labs-vinaya', '406.log'))).toBe(true)
  })

  it('never removes an attributed entry that is not finished, even with --include-legacy', () => {
    const home = homeDir()
    const root = tempDir('vinaya-sweep-legacy-root8-')
    mkdirSync(join(home, 'loops', 'atta-labs-vinaya'), { recursive: true })
    writeFileSync(join(home, 'loops', 'atta-labs-vinaya', '407.log'), 'narration')
    const deps = baseDeps(root, { fetchIssueState: () => 'OPEN', fetchPrForBranch: () => null })

    const report = sweepLegacyLayout(true, deps, home)
    const entry = report.entries.find((e) => e.path.includes('407.log'))
    expect(entry?.class?.kind).toBe('open')
    expect(entry?.removed).toBe(false)
    expect(existsSync(join(home, 'loops', 'atta-labs-vinaya', '407.log'))).toBe(true)
  })

  it("drivers/*.out — an operator's own ad hoc files — are always reported unattributable, never removed", () => {
    const home = homeDir()
    const root = tempDir('vinaya-sweep-legacy-root9-')
    mkdirSync(join(home, 'drivers'), { recursive: true })
    writeFileSync(join(home, 'drivers', '560-r7.out'), 'narration')
    writeFileSync(join(home, 'drivers', '575vps.out'), 'narration')
    const deps = baseDeps(root, { fetchIssueState: () => 'CLOSED' })

    const report = sweepLegacyLayout(true, deps, home)
    const entries = report.entries.filter((e) => e.dirname === 'drivers')
    expect(entries.length).toBe(2)
    for (const e of entries) {
      expect(e.attribution.kind).toBe('unattributable')
      expect(e.removed).toBe(false)
    }
    expect(existsSync(join(home, 'drivers', '560-r7.out'))).toBe(true)
    expect(existsSync(join(home, 'drivers', '575vps.out'))).toBe(true)
  })

  it("attributes control-store/<task>/ via an escalation record's branch+pr when no manifest exists (the real historical shape)", () => {
    const home = homeDir()
    const root = tempDir('vinaya-sweep-legacy-root10-')
    const escalationDir = join(home, 'control-store', '625', 'escalation')
    mkdirSync(escalationDir, { recursive: true })
    writeFileSync(
      join(escalationDir, '625-1-unknown.json'),
      JSON.stringify({ task: 625, branch: 'task/driver-lifecycle-v1/7', pr: 630 })
    )
    const deps = baseDeps(root, {
      fetchIssueState: () => 'CLOSED',
      fetchPrForBranch: (branch) => (branch === 'task/driver-lifecycle-v1/7' ? { number: 630, state: 'OPEN' } : null)
    })

    const report = sweepLegacyLayout(true, deps, home)
    const entry = report.entries.find((e) => e.dirname === 'control-store')
    expect(entry?.attribution).toEqual({ kind: 'this-repo', scope: 625 })
    expect(entry?.removed).toBe(true)
    expect(existsSync(join(home, 'control-store', '625'))).toBe(false)
  })

  describe('outbox task folders (O3) — the even-older tree nested inside the telemetry outbox', () => {
    function outboxTaskDir(home: string, task: number): string {
      return join(home, 'outbox', 'dev-review-loop', String(task))
    }

    it("attributes via pause-state.json's own branch+prNumber, and removes it only when finished AND --include-legacy", () => {
      const home = homeDir()
      const root = tempDir('vinaya-sweep-legacy-outbox1-')
      const taskDir = outboxTaskDir(home, 560)
      mkdirSync(taskDir, { recursive: true })
      writeFileSync(
        join(taskDir, 'pause-state.json'),
        JSON.stringify({ task: 560, branch: 'task/worker-isolation-v1/3', prNumber: 623, reason: 'infrastructure' })
      )
      const deps = baseDeps(root, {
        fetchIssueState: () => 'CLOSED',
        fetchPrForBranch: (branch) =>
          branch === 'task/worker-isolation-v1/3' ? { number: 623, state: 'CLOSED' } : null
      })

      const listOnly = sweepLegacyLayout(false, deps, home)
      const entry = listOnly.entries.find((e) => e.dirname === 'outbox task folders')
      expect(entry?.attribution).toEqual({ kind: 'this-repo', scope: 560 })
      expect(entry?.class?.kind).toBe('finished')
      expect(entry?.removed).toBe(false)

      const withRemoval = sweepLegacyLayout(true, deps, home)
      const removedEntry = withRemoval.entries.find((e) => e.dirname === 'outbox task folders')
      expect(removedEntry?.removed).toBe(true)
      expect(existsSync(taskDir)).toBe(false)
    })

    it("attributes via a held round verdict's own Judged head sha when no pause-state or escalation record exists", () => {
      const home = homeDir()
      const root = tempDir('vinaya-sweep-legacy-outbox2-')
      const taskDir = outboxTaskDir(home, 636)
      mkdirSync(taskDir, { recursive: true })
      writeFileSync(
        join(taskDir, 'round-1-reviewer.md'),
        'VERDICT: REQUEST CHANGES\n\nJudged head: 1ead23d57d2bae9ecfcf457b1abe845e1ee58729\n'
      )
      const deps = baseDeps(root, {
        fetchIssueState: () => 'OPEN',
        fetchPrForBranch: () => ({ number: 641, state: 'OPEN' }),
        commitExistsInThisRepo: (sha) => sha === '1ead23d57d2bae9ecfcf457b1abe845e1ee58729'
      })

      const report = sweepLegacyLayout(false, deps, home)
      const entry = report.entries.find((e) => e.dirname === 'outbox task folders')
      expect(entry?.attribution).toEqual({ kind: 'this-repo', scope: 636 })
      expect(entry?.class?.kind).toBe('open')
    })

    it('reports unattributable when the folder carries neither a pause/escalation record nor a round verdict', () => {
      const home = homeDir()
      const root = tempDir('vinaya-sweep-legacy-outbox3-')
      const taskDir = outboxTaskDir(home, 553)
      mkdirSync(taskDir, { recursive: true })
      writeFileSync(
        join(taskDir, 'driver.pid.json'),
        JSON.stringify({ pid: 999999, startedAt: '2026-09-14T11:08:26.582Z' })
      )
      const deps = baseDeps(root, { fetchIssueState: () => 'CLOSED' })

      const report = sweepLegacyLayout(true, deps, home)
      const entry = report.entries.find((e) => e.dirname === 'outbox task folders')
      expect(entry?.attribution.kind).toBe('unattributable')
      expect(entry?.removed).toBe(false)
      expect(existsSync(taskDir)).toBe(true)
    })

    it('never touches the live telemetry ndjson directories sitting beside it in the same outbox root', () => {
      const home = homeDir()
      const root = tempDir('vinaya-sweep-legacy-outbox4-')
      mkdirSync(join(home, 'outbox', 'atta-labs-vinaya'), { recursive: true })
      writeFileSync(join(home, 'outbox', 'atta-labs-vinaya', '999.ndjson'), '{"line":"one"}\n')
      const deps = baseDeps(root)

      const report = sweepLegacyLayout(true, deps, home)
      expect(report.entries.some((e) => e.path.includes('.ndjson'))).toBe(false)
      expect(existsSync(join(home, 'outbox', 'atta-labs-vinaya', '999.ndjson'))).toBe(true)
    })
  })
})

describe('runTaskSweep', () => {
  it('composes the modern sweep and the legacy listing behind one call', () => {
    const root = tempDir('vinaya-sweep-combined-')
    const home = tempDir('vinaya-sweep-combined-home-')
    mkdirSync(runPath(root, 501, { area: 'task' }), { recursive: true })
    const deps = baseDeps(root, { fetchIssueState: () => 'CLOSED' })
    const result = runTaskSweep({ includeLegacy: false }, deps, undefined, home)
    expect(result.modern.removed.map((r) => r.folder)).toEqual(['Issue #501'])
    expect(result.legacy.entries).toEqual([])
  })
})

describe('sweepModernTasksAsync — task worktrees under .worktrees/', () => {
  const MAIN = '/repo'
  const wt = (branch: string | null, extra: { locked?: boolean; name?: string } = {}) => ({
    path: `${MAIN}/.worktrees/${extra.name ?? branch ?? 'detached'}`,
    branch,
    locked: extra.locked ?? false
  })

  function asyncDeps(root: string, overrides: Partial<TaskSweepAsyncDeps> = {}) {
    const removedPaths: string[] = []
    const deps: TaskSweepAsyncDeps = {
      runtimeDir: () => root,
      isDriverPidAlive: () => false,
      readDriverLockForScope: () => null,
      readPauseStateForScope: () => null,
      fetchIssueState: async () => 'OPEN',
      developerBranchFor: async (issue) => `task/issue-${issue}`,
      fetchPrForBranch: async () => null,
      fetchPrBody: async () => '',
      taskFromPrBody: () => null,
      rm: () => {},
      listWorktrees: async () => ({ main: MAIN, entries: [] }),
      worktreeHasUncommitted: async () => false,
      worktreeHasUnpushedCommits: async () => false,
      removeWorktree: async (_main, path) => {
        removedPaths.push(path)
      },
      ...overrides
    }
    return { deps, removedPaths }
  }

  const merged = async () => ({ number: 9, state: 'MERGED' as const })

  it('removes a worktree whose pull request is merged or closed, fully pushed and clean, and lists it', async () => {
    const root = tempDir('vinaya-sweep-wt-')
    const { deps, removedPaths } = asyncDeps(root, {
      listWorktrees: async () => ({ main: MAIN, entries: [wt('task/issue-1'), wt('task/issue-2')] }),
      fetchPrForBranch: async (b) =>
        b.endsWith('1') ? { number: 9, state: 'MERGED' } : { number: 10, state: 'CLOSED' }
    })
    const report = await sweepModernTasksAsync(undefined, () => {}, deps)
    expect(removedPaths).toEqual([`${MAIN}/.worktrees/task/issue-1`, `${MAIN}/.worktrees/task/issue-2`])
    expect(report.removed.map((r) => r.folder)).toEqual([
      'worktree .worktrees/task/issue-1',
      'worktree .worktrees/task/issue-2'
    ])
    expect(report.removed[0]?.reason).toContain('PR #9 is merged')
  })

  it('reads the branch from the worktree list, never from the folder name', async () => {
    const root = tempDir('vinaya-sweep-wt-name-')
    const asked: string[] = []
    const { deps, removedPaths } = asyncDeps(root, {
      listWorktrees: async () => ({ main: MAIN, entries: [wt('task/issue-3', { name: 'something-else' })] }),
      fetchPrForBranch: async (b) => {
        asked.push(b)
        return merged()
      }
    })
    await sweepModernTasksAsync(undefined, () => {}, deps)
    expect(asked).toContain('task/issue-3')
    expect(removedPaths).toEqual([`${MAIN}/.worktrees/something-else`])
  })

  const keepCases: [string, Partial<TaskSweepAsyncDeps>, ReturnType<typeof wt>, string][] = [
    [
      'open pull request',
      { fetchPrForBranch: async () => ({ number: 4, state: 'OPEN' }) },
      wt('task/issue-4'),
      'PR #4 is open'
    ],
    ['no pull request', { fetchPrForBranch: async () => null }, wt('task/issue-5'), 'no pull request'],
    [
      'unpushed commits',
      { fetchPrForBranch: merged, worktreeHasUnpushedCommits: async () => true },
      wt('task/issue-6'),
      'commits the remote lacks'
    ],
    [
      'uncommitted changes',
      { fetchPrForBranch: merged, worktreeHasUncommitted: async () => true },
      wt('task/issue-7'),
      'uncommitted changes'
    ],
    [
      'forge read failure',
      {
        fetchPrForBranch: async () => {
          throw new Error('gh: offline')
        }
      },
      wt('task/issue-8'),
      'gh: offline'
    ],
    ['locked worktree', { fetchPrForBranch: merged }, wt('task/issue-10', { locked: true }), 'locked'],
    ['detached HEAD', { fetchPrForBranch: merged }, wt(null), 'no branch'],
    ['non-task branch', { fetchPrForBranch: merged }, wt('feature/x'), 'not a task branch']
  ]
  for (const [name, overrides, entry, reason] of keepCases) {
    it(`keeps a worktree with ${name}, with the reason`, async () => {
      const root = tempDir('vinaya-sweep-wt-keep-')
      const { deps, removedPaths } = asyncDeps(root, {
        ...overrides,
        listWorktrees: async () => ({ main: MAIN, entries: [entry] })
      })
      const report = await sweepModernTasksAsync(undefined, () => {}, deps)
      expect(removedPaths).toEqual([])
      expect(report.removed).toEqual([])
      expect(report.kept).toHaveLength(1)
      expect(report.kept[0]?.reason).toContain(reason)
    })
  }

  it('keeps a worktree whose task a live driver lock names, and the run’s own task', async () => {
    const root = tempDir('vinaya-sweep-wt-live-')
    mkdirSync(runPath(root, 11, { area: 'task' }), { recursive: true })
    const { deps, removedPaths } = asyncDeps(root, {
      listWorktrees: async () => ({ main: MAIN, entries: [wt('task/issue-11'), wt('task/issue-12')] }),
      fetchPrForBranch: merged,
      readDriverLockForScope: (_r, scope) => (scope === 11 ? { pid: 4242, startedAt: 'now' } : null),
      isDriverPidAlive: (pid) => pid === 4242
    })
    const report = await sweepModernTasksAsync(12, () => {}, deps)
    expect(removedPaths).toEqual([])
    const kept = Object.fromEntries(report.kept.map((k) => [k.folder, k.reason]))
    expect(kept['worktree .worktrees/task/issue-11']).toContain('live driver lock')
    expect(kept['worktree .worktrees/task/issue-12']).toContain('own task')
  })

  it('keeps every worktree when a live lock cannot be resolved to a branch', async () => {
    const root = tempDir('vinaya-sweep-wt-unresolved-')
    mkdirSync(runPath(root, { pr: 30 }, { area: 'task' }), { recursive: true })
    const { deps, removedPaths } = asyncDeps(root, {
      listWorktrees: async () => ({ main: MAIN, entries: [wt('task/issue-13')] }),
      fetchPrForBranch: merged,
      readDriverLockForScope: () => ({ pid: 4242, startedAt: 'now' }),
      isDriverPidAlive: () => true
    })
    await sweepModernTasksAsync(undefined, () => {}, deps)
    expect(removedPaths).toEqual([])
  })

  it('ignores worktrees outside .worktrees/', async () => {
    const root = tempDir('vinaya-sweep-wt-outside-')
    const { deps, removedPaths } = asyncDeps(root, {
      listWorktrees: async () => ({
        main: MAIN,
        entries: [{ path: '/elsewhere/task-14', branch: 'task/issue-14', locked: false }]
      }),
      fetchPrForBranch: merged
    })
    const report = await sweepModernTasksAsync(undefined, () => {}, deps)
    expect(removedPaths).toEqual([])
    expect(report).toEqual({ removed: [], kept: [] })
  })

  it('keeps the worktree when the pull request moves between the first read and the removal', async () => {
    const root = tempDir('vinaya-sweep-wt-recheck-')
    let reads = 0
    const { deps, removedPaths } = asyncDeps(root, {
      listWorktrees: async () => ({ main: MAIN, entries: [wt('task/issue-15')] }),
      fetchPrForBranch: async () => ({ number: 9, state: ++reads === 1 ? 'MERGED' : 'OPEN' })
    })
    const report = await sweepModernTasksAsync(undefined, () => {}, deps)
    expect(removedPaths).toEqual([])
    expect(report.kept[0]?.reason).toContain('PR #9 is open')
  })

  it('parses git worktree list --porcelain: main first, branch from refs/heads, locked flag', () => {
    const listing = parseWorktreeList(
      [
        'worktree /repo\nHEAD aaa\nbranch refs/heads/main',
        'worktree /repo/.worktrees/task/issue-1\nHEAD bbb\nbranch refs/heads/task/issue-1\nlocked reason',
        'worktree /repo/.worktrees/x\nHEAD ccc\ndetached',
        ''
      ].join('\n\n')
    )
    expect(listing.main).toBe('/repo')
    expect(listing.entries).toEqual([
      { path: '/repo/.worktrees/task/issue-1', branch: 'task/issue-1', locked: true },
      { path: '/repo/.worktrees/x', branch: null, locked: false }
    ])
  })
})

describe('worktree removal against a real temporary repository', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim()

  function setup() {
    const base = realpathSync(tempDir('vinaya-sweep-real-'))
    const origin = join(base, 'origin.git')
    const main = join(base, 'main')
    execFileSync('git', ['init', '--bare', '-b', 'main', origin])
    execFileSync('git', ['clone', '-q', origin, main])
    writeFileSync(join(main, 'a.txt'), 'a')
    git(main, 'add', '.')
    git(main, 'commit', '-q', '-m', 'init')
    git(main, 'push', '-q', 'origin', 'HEAD:main')
    const wtPath = join(main, '.worktrees', 'task', 'issue-1')
    git(main, 'worktree', 'add', '-q', '-b', 'task/issue-1', wtPath)
    return { main, wtPath }
  }

  it('removes a pushed, clean worktree through git, leaving the worktree list consistent', async () => {
    const { main, wtPath } = setup()
    writeFileSync(join(wtPath, 'b.txt'), 'b')
    git(wtPath, 'add', '.')
    git(wtPath, 'commit', '-q', '-m', 'work')
    git(wtPath, 'push', '-q', 'origin', 'task/issue-1')
    expect(await worktreeHasUncommittedAsync(wtPath)).toBe(false)
    expect(await worktreeHasUnpushedCommitsAsync(wtPath, null)).toBe(false)

    await removeWorktreeAsync(main, wtPath)

    expect(existsSync(wtPath)).toBe(false)
    expect(git(main, 'worktree', 'list', '--porcelain')).not.toContain('issue-1')
  })

  it('sees an unpushed commit and an uncommitted file, and git refuses to remove a dirty worktree', async () => {
    const { main, wtPath } = setup()
    writeFileSync(join(wtPath, 'b.txt'), 'b')
    git(wtPath, 'add', '.')
    git(wtPath, 'commit', '-q', '-m', 'work')
    expect(await worktreeHasUnpushedCommitsAsync(wtPath, null)).toBe(true)
    expect(await worktreeHasUnpushedCommitsAsync(wtPath, git(wtPath, 'rev-parse', 'HEAD'))).toBe(false)

    writeFileSync(join(wtPath, 'c.txt'), 'c')
    expect(await worktreeHasUncommittedAsync(wtPath)).toBe(true)
    await expect(removeWorktreeAsync(main, wtPath)).rejects.toThrow()
    expect(existsSync(wtPath)).toBe(true)
  })
})
