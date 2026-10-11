/**
 * agent-confinement-v1 — unit tests for the pure gate logic the driver's
 * publishing tools run: commit-header validation (O2) and the pre-publication
 * checks (O7). The orchestration itself (the tool context's commit → push →
 * open, the reask loop) is covered through the in-process loop harness in
 * `inproc-5.test.ts`.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordedBeyondSurfacePaths } from '@attalabs/aeg-core'
import {
  type LoopDeps,
  defaultGitWorktreeChangedPaths,
  defaultGitWorktreeUntrackedPaths,
  defaultReadMergedDefaultCommit
} from '../../../src/lib/dev-review-loop.js'
import {
  checkPublicationPreconditions,
  fastForwardedOntoDefaultTip,
  validateCommitHeader
} from '../../../src/lib/dev-review-loop/developer-publication.js'
import {
  cleanupWorlds,
  makeInProcessDeps,
  makeWorld,
  runLoopInProcess,
  defaultDeveloperTurnOutput
} from '../dev-review-loop-harness.js'

afterEach(cleanupWorlds)

describe('validateCommitHeader (O2)', () => {
  it('accepts a conforming Type(scope): Description header', () => {
    const r = validateCommitHeader('Feat(cli): add the publication step')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.header).toBe('Feat(cli): add the publication step')
  })

  it('accepts a scope-less Type: Description header', () => {
    expect(validateCommitHeader('Fix: correct the gate').ok).toBe(true)
  })

  it('trims a trailing newline and still accepts', () => {
    const r = validateCommitHeader('Docs: update the loop spec\n')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.header).toBe('Docs: update the loop spec')
  })

  it('rejects a missing header (null)', () => {
    const r = validateCommitHeader(null)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/no commit header/)
  })

  it('rejects an empty header file', () => {
    const r = validateCommitHeader('   \n')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/empty/)
  })

  it('rejects a multi-line body', () => {
    const r = validateCommitHeader('Feat(cli): add the step\n\nA longer body paragraph.')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/more than one non-empty line/)
  })

  it('rejects a non-conforming first line', () => {
    const r = validateCommitHeader('added the thing')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/does not match `Type\(scope\): Description`/)
  })

  it('rejects a header longer than 72 characters', () => {
    const header = `Feat(cli): ${'x'.repeat(70)}`
    expect(header.length).toBeGreaterThan(72)
    const r = validateCommitHeader(header)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/72/)
  })

  it('accepts a header exactly 72 characters long', () => {
    const header = `Feat(cli): ${'x'.repeat(61)}`
    expect(header.length).toBe(72)
    expect(validateCommitHeader(header).ok).toBe(true)
  })
})

describe('checkPublicationPreconditions (O7)', () => {
  const ok = {
    worktreeBranch: 'task/t/1',
    expectedBranch: 'task/t/1',
    worktreeHead: 'a'.repeat(40),
    recordedHead: 'a'.repeat(40),
    base: 'b'.repeat(40),
    expectedBase: 'b'.repeat(40),
    changedPaths: ['apps/cli/src/lib/x.ts'],
    surface: { in: ['apps/cli'], out: ['packages'] }
  }

  it('passes when branch, base and head hold, recording no path beyond the Surface', () => {
    expect(checkPublicationPreconditions(ok)).toEqual({ ok: true, beyondSurface: [] })
  })

  it('fails when the worktree is on the wrong branch', () => {
    const r = checkPublicationPreconditions({ ...ok, worktreeBranch: 'task/t/2' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/not the task branch/)
  })

  it('fails when the worktree branch is unreadable', () => {
    const r = checkPublicationPreconditions({ ...ok, worktreeBranch: null })
    expect(r.ok).toBe(false)
  })

  it('fails when the base is not the expected base', () => {
    const r = checkPublicationPreconditions({ ...ok, base: 'c'.repeat(40) })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/not the expected base/)
  })

  it('fails closed when the branch base cannot be read', () => {
    const r = checkPublicationPreconditions({ ...ok, base: null })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/could not read the worktree branch base/)
  })

  it('fails when the head moved during the turn (the Developer committed)', () => {
    const r = checkPublicationPreconditions({ ...ok, worktreeHead: 'z'.repeat(40) })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/do not commit yourself/)
  })

  it("accepts undoing only the driver's own unpushed commit", () => {
    const remote = 'r'.repeat(40)
    const r = checkPublicationPreconditions({
      ...ok,
      worktreeHead: remote,
      recordedHead: 'd'.repeat(40),
      remoteHead: remote,
      driverUnpushedCommit: { sha: 'd'.repeat(40), parent: remote }
    })
    expect(r.ok).toBe(true)
  })

  it('refuses a moved head that is a Developer commit, not the driver unpushed commit', () => {
    const remote = 'r'.repeat(40)
    const moved = {
      ...ok,
      recordedHead: 'd'.repeat(40),
      remoteHead: remote,
      driverUnpushedCommit: { sha: 'd'.repeat(40), parent: remote }
    }
    // Developer commit on top of the remote head
    expect(checkPublicationPreconditions({ ...moved, worktreeHead: 'e'.repeat(40) }).ok).toBe(false)
    // head equals the remote head but the recorded head is not a driver commit
    expect(checkPublicationPreconditions({ ...moved, worktreeHead: remote, driverUnpushedCommit: null }).ok).toBe(false)
    // driver commit whose parent is not the remote head
    expect(
      checkPublicationPreconditions({
        ...moved,
        worktreeHead: remote,
        driverUnpushedCommit: { sha: 'd'.repeat(40), parent: 'p'.repeat(40) }
      }).ok
    ).toBe(false)
  })

  describe('a worktree fast-forwarded onto the default branch tip', () => {
    const recorded = 'a'.repeat(40)
    const tip = 't'.repeat(40)
    const movedReason = (head: string) =>
      `the worktree head moved to \`${head}\` during your turn (expected the recorded \`${recorded}\`) — do not commit yourself; call \`publish_changes\` to make this turn's single commit`
    const fastForward = {
      ...ok,
      recordedHead: recorded,
      worktreeHead: tip,
      base: tip,
      defaultBranchTip: { sha: tip, recordedHeadIsAncestor: true }
    }

    it('accepts a head equal to the tip, the recorded head its ancestor and the base that tip', () => {
      expect(fastForwardedOntoDefaultTip(fastForward)).toBe(true)
      expect(checkPublicationPreconditions(fastForward).ok).toBe(true)
    })

    it('refuses a commit the Developer made, with the existing reason', () => {
      const own = 'e'.repeat(40)
      expect(checkPublicationPreconditions({ ...fastForward, worktreeHead: own, base: 'b'.repeat(40) })).toEqual({
        ok: false,
        reason: movedReason(own)
      })
    })

    it('refuses a merge commit of the tip, with the existing reason', () => {
      const merge = 'm'.repeat(40)
      expect(checkPublicationPreconditions({ ...fastForward, worktreeHead: merge, expectedBase: tip })).toEqual({
        ok: false,
        reason: movedReason(merge)
      })
    })

    it('refuses a rebase onto anything but the tip, with the existing reason', () => {
      const rebased = 'r'.repeat(40)
      const other = 'o'.repeat(40)
      const verdict = checkPublicationPreconditions({
        ...fastForward,
        worktreeHead: rebased,
        base: other,
        expectedBase: other,
        defaultBranchTip: { sha: tip, recordedHeadIsAncestor: true }
      })
      expect(verdict).toEqual({ ok: false, reason: movedReason(rebased) })
    })

    it('needs every one of the three facts', () => {
      const noAncestor = { ...fastForward, defaultBranchTip: { sha: tip, recordedHeadIsAncestor: false } }
      const baseElsewhere = { ...fastForward, base: 'c'.repeat(40), expectedBase: 'c'.repeat(40) }
      const tipUnread = { ...fastForward, expectedBase: tip, defaultBranchTip: null }
      for (const input of [noAncestor, baseElsewhere, tipUnread]) {
        expect(fastForwardedOntoDefaultTip(input)).toBe(false)
        expect(checkPublicationPreconditions({ ...input, expectedBase: input.base })).toEqual({
          ok: false,
          reason: movedReason(tip)
        })
      }
    })
  })

  it('publishes a changed path that crosses an out: glob, recording it with the glob', () => {
    const r = checkPublicationPreconditions({
      ...ok,
      changedPaths: ['apps/cli/src/lib/x.ts', 'packages/aeg-core/src/x.ts']
    })
    expect(r).toEqual({
      ok: true,
      beyondSurface: [{ path: 'packages/aeg-core/src/x.ts', reason: 'out', glob: 'packages' }]
    })
  })

  it('publishes a changed path that matches no in: glob, recording it', () => {
    const r = checkPublicationPreconditions({ ...ok, changedPaths: ['apps/log-server/x.ts'] })
    expect(r).toEqual({ ok: true, beyondSurface: [{ path: 'apps/log-server/x.ts', reason: 'in', glob: null }] })
  })

  it('a beyond-Surface path never hides a failing precondition', () => {
    const r = checkPublicationPreconditions({
      ...ok,
      worktreeHead: 'c'.repeat(40),
      changedPaths: ['apps/log-server/x.ts']
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/do not commit yourself/)
  })

  it('allows an initial unrecorded expected base and inactive head/Surface checks', () => {
    expect(
      checkPublicationPreconditions({
        worktreeBranch: 'task/t/1',
        expectedBranch: 'task/t/1',
        worktreeHead: 'a'.repeat(40),
        recordedHead: null,
        base: 'b'.repeat(40),
        expectedBase: null,
        changedPaths: ['anything/at/all.ts'],
        surface: null
      }).ok
    ).toBe(true)
  })
})

describe('publication range after a default-branch merge', () => {
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()

  const remotes = new Map<string, string>()
  /** The reader as the driver calls it: with the repository URL, never the worktree's `origin`. */
  const readMerged = (dir: string, since: string | null) =>
    defaultReadMergedDefaultCommit(dir, since, remotes.get(dir) ?? null)

  /** A repo with a real bare `origin` whose main is the first commit, and a task branch cut from it. */
  const fixture = (fixtureDir?: string, taskBranch = 'task'): { dir: string; base: string } => {
    const dir = fixtureDir ?? mkdtempSync(join(tmpdir(), 'pub-range-'))
    const remote = mkdtempSync(join(tmpdir(), 'pub-origin-'))
    mkdirSync(dir, { recursive: true })
    git(remote, 'init', '-q', '--bare', '-b', 'main')
    git(dir, 'init', '-q', '-b', 'main')
    git(dir, 'remote', 'add', 'origin', remote)
    remotes.set(dir, remote)
    writeFileSync(join(dir, 'a.txt'), 'a\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'base')
    const base = git(dir, 'rev-parse', 'HEAD')
    git(dir, 'push', '-q', 'origin', 'main')
    git(dir, 'checkout', '-q', '-b', taskBranch)
    writeFileSync(join(dir, 'own.txt'), 'own\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'own')
    return { dir, base }
  }

  const advanceMain = (dir: string, file: string, taskBranch = 'task'): string => {
    git(dir, 'checkout', '-q', 'main')
    writeFileSync(join(dir, file), 'main\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', `main ${file}`)
    const tip = git(dir, 'rev-parse', 'HEAD')
    git(dir, 'push', '-q', 'origin', 'main')
    git(dir, 'checkout', '-q', taskBranch)
    return tip
  }

  it('reads nothing when the turn merged no default-branch commit', () => {
    const { dir, base } = fixture()
    expect(readMerged(dir, base)).toBeNull()
  })

  it('refuses a merged side branch cut from the default branch: its paths stay task changes', () => {
    const { dir, base } = fixture()
    const pushed = git(dir, 'rev-parse', 'HEAD')
    git(dir, 'checkout', '-q', '-b', 'side', base)
    writeFileSync(join(dir, 'guarded.txt'), 'sneaky\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'side')
    git(dir, 'checkout', '-q', 'task')
    git(dir, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side')
    expect(readMerged(dir, pushed)).toBeNull()
    expect(defaultGitWorktreeChangedPaths(dir, pushed)).toContain('guarded.txt')
  })

  it('a crafted merge of a side commit never moves the base off a genuine default-branch merge', () => {
    const { dir, base } = fixture()
    const pushed = git(dir, 'rev-parse', 'HEAD')
    const tip = advanceMain(dir, 'main-only.txt')
    git(dir, 'merge', '-q', '--no-ff', '-m', 'merge main', 'main')
    git(dir, 'checkout', '-q', '-b', 'side', base)
    writeFileSync(join(dir, 'guarded.txt'), 'sneaky\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'side')
    git(dir, 'checkout', '-q', 'task')
    git(dir, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side')
    expect(readMerged(dir, pushed)?.commit).toBe(tip)
    expect(defaultGitWorktreeChangedPaths(dir, tip)).toContain('guarded.txt')
  })

  it('reads the repository URL, not a worktree origin the Developer repointed', () => {
    const { dir } = fixture()
    const pushed = git(dir, 'rev-parse', 'HEAD')
    const tip = advanceMain(dir, 'main-only.txt')
    git(dir, 'merge', '-q', '--no-ff', '-m', 'merge main', 'main')
    git(dir, 'remote', 'set-url', 'origin', join(tmpdir(), 'pub-nowhere-does-not-exist'))
    expect(readMerged(dir, pushed)?.commit).toBe(tip)
    expect(defaultReadMergedDefaultCommit(dir, pushed, null)).toBeNull()
  })

  it('ignores a merged commit unrelated to the default branch', () => {
    const { dir } = fixture()
    const pushed = git(dir, 'rev-parse', 'HEAD')
    git(dir, 'checkout', '-q', '--orphan', 'other')
    writeFileSync(join(dir, 'x.txt'), 'x\n')
    git(dir, 'add', 'x.txt')
    git(dir, 'commit', '-q', '-m', 'other')
    git(dir, 'checkout', '-q', 'task')
    git(dir, 'merge', '-q', '--allow-unrelated-histories', '-m', 'merge other', 'other')
    expect(readMerged(dir, pushed)).toBeNull()
  })

  it('reads the committed merge parent of a genuine default-branch merge, fetching the remote head itself', () => {
    const { dir } = fixture()
    const pushed = git(dir, 'rev-parse', 'HEAD')
    const tip = advanceMain(dir, 'main-only.txt')
    git(dir, 'merge', '-q', '--no-ff', '-m', 'merge main', 'main')
    expect(readMerged(dir, pushed)).toEqual({ commit: tip, regressedPaths: [] })
    expect(defaultGitWorktreeChangedPaths(dir, tip)).toEqual(['own.txt'])
    expect(defaultGitWorktreeChangedPaths(dir, pushed)).toContain('main-only.txt')
    // The remote moves on; its new head is missing locally until the reader fetches it.
    const clone = mkdtempSync(join(tmpdir(), 'pub-clone-'))
    git(clone, 'clone', '-q', git(dir, 'remote', 'get-url', 'origin'), '.')
    writeFileSync(join(clone, 'later.txt'), 'later\n')
    git(clone, 'add', '.')
    git(clone, 'commit', '-q', '-m', 'later')
    git(clone, 'push', '-q', 'origin', 'main')
    expect(readMerged(dir, pushed)).toEqual({ commit: tip, regressedPaths: ['later.txt'] })
  })

  it('reports a file reset to an older default-branch state after merging an older commit', () => {
    const { dir } = fixture()
    const pushed = git(dir, 'rev-parse', 'HEAD')
    git(dir, 'checkout', '-q', 'main')
    writeFileSync(join(dir, 'guarded.txt'), 'old\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'guarded old')
    const older = git(dir, 'rev-parse', 'HEAD')
    writeFileSync(join(dir, 'guarded.txt'), 'new\n')
    git(dir, 'commit', '-q', '-am', 'guarded new')
    git(dir, 'push', '-q', 'origin', 'main')
    git(dir, 'checkout', '-q', 'task')
    git(dir, 'merge', '-q', '--no-commit', '--no-ff', older)
    const merged = readMerged(dir, pushed)
    expect(merged?.commit).toBe(older)
    expect(merged?.regressedPaths).toEqual(['guarded.txt'])
  })

  it('allows the publication tool during an uncommitted merge without treating default-branch files as task changes', async () => {
    const world = makeWorld({
      worktreeExists: true,
      surface: { in: ['own.txt', 'untracked.txt'], out: ['main-only.txt'] }
    })
    const dir = join(world.repoRoot, '.worktrees', world.branch)
    const { base } = fixture(dir, world.branch)
    const pushed = git(dir, 'rev-parse', 'HEAD')
    const tip = advanceMain(dir, 'main-only.txt', world.branch)
    git(dir, 'merge', '-q', '--no-commit', '--no-ff', 'main')
    writeFileSync(join(dir, 'untracked.txt'), 'untracked\n')
    world.head = pushed
    world.worktreeHead = pushed
    world.base = base
    world.mergeBase = base
    world.worktreeDirty = ['main-only.txt', 'untracked.txt']

    const baseDeps = makeInProcessDeps(world)
    const publicationResults: boolean[] = []
    const recorded: (string[] | undefined)[] = []
    await runLoopInProcess(
      world,
      { task: world.task, agent: 'codex' },
      {
        ...baseDeps,
        resolveHead: () => world.head,
        readWorktreeHead: () => world.worktreeHead,
        readUnpushedWorkDetail: () => ({ dirtyFiles: [...world.worktreeDirty], aheadCount: 0 }),
        gitMergeBase: async () => base,
        gitWorktreeChangedPaths: defaultGitWorktreeChangedPaths,
        readMergedDefaultCommit: (_worktree, sinceBase) => readMerged(dir, sinceBase),
        dispatchRole: async (role, agent, prompt, opts) => {
          if (role !== 'developer') return baseDeps.dispatchRole!(role, agent, prompt, opts)
          const publicationResult = await world.devToolContext!.publishChanges('Fix(cli): publish uncommitted merge')
          publicationResults.push(publicationResult.ok)
          if (publicationResult.ok) recorded.push(publicationResult.result.beyondSurface)
          if (publicationResult.ok) {
            await world.devToolContext!.openPullRequest(world.issueTitle, '## Scope\n\n**Tier:** 3\n')
          }
          return {
            exitCode: 0,
            durationMs: 1,
            usage: null,
            resumeId: 'dev',
            timedOut: false,
            effectId: 'dev',
            turnOutput: defaultDeveloperTurnOutput(prompt)
          }
        }
      }
    )

    expect(readMerged(dir, pushed)?.commit).toBe(tip)
    expect(publicationResults).toEqual([true])
    // The default branch's own `main-only.txt` is no task change, so it is
    // never recorded beyond the Surface though an `out:` glob covers it.
    expect(recorded).toEqual([[]])
    expect(world.commits).toHaveLength(1)
  })

  it('still records a file the Developer itself changed outside the Surface', () => {
    const { dir } = fixture()
    const pushed = git(dir, 'rev-parse', 'HEAD')
    advanceMain(dir, 'main-only.txt')
    git(dir, 'merge', '-q', '--no-commit', '--no-ff', 'main')
    writeFileSync(join(dir, 'a.txt'), 'edited in the merge\n')
    git(dir, 'add', '.')
    const merged = readMerged(dir, pushed)
    const changed = [
      ...defaultGitWorktreeChangedPaths(dir, merged?.commit as string),
      ...defaultGitWorktreeUntrackedPaths(dir)
    ]
    expect(changed.sort()).toEqual(['a.txt', 'own.txt'])
    const verdict = checkPublicationPreconditions({
      worktreeBranch: 't',
      expectedBranch: 't',
      worktreeHead: 'a'.repeat(40),
      recordedHead: 'a'.repeat(40),
      base: 'b'.repeat(40),
      expectedBase: 'b'.repeat(40),
      changedPaths: changed,
      surface: { in: ['own.txt'], out: [] }
    })
    expect(verdict).toEqual({ ok: true, beyondSurface: [{ path: 'a.txt', reason: 'in', glob: null }] })
  })

  it('publishes a worktree fast-forwarded onto the default tip, measured from that tip, and keeps the re-recorded head for the next check', async () => {
    const world = makeWorld({
      worktreeExists: true,
      surface: { in: ['own.txt', 'stray.txt'], out: ['main-only.txt', 'stray.txt'] }
    })
    const dir = join(world.repoRoot, '.worktrees', world.branch)
    const remote = mkdtempSync(join(tmpdir(), 'pub-origin-'))
    mkdirSync(dir, { recursive: true })
    git(remote, 'init', '-q', '--bare', '-b', 'main')
    git(dir, 'init', '-q', '-b', 'main')
    git(dir, 'remote', 'add', 'origin', remote)
    writeFileSync(join(dir, 'a.txt'), 'a\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'base')
    const base = git(dir, 'rev-parse', 'HEAD')
    git(dir, 'push', '-q', 'origin', 'main')
    git(dir, 'checkout', '-q', '-b', world.branch)
    const tip = advanceMain(dir, 'main-only.txt', world.branch)
    world.head = base
    world.base = base
    world.mergeBase = base

    const realHead = (): string => git(dir, 'rev-parse', 'HEAD')
    const dirty = (): string[] =>
      git(dir, 'status', '--porcelain')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => l.slice(3))
    let tipReads = 0
    const baseDeps = makeInProcessDeps(world)
    const results: { ok: boolean; reason: string; beyondSurface?: string[] }[] = []
    await runLoopInProcess(
      world,
      { task: world.task, agent: 'codex' },
      {
        ...baseDeps,
        resolveHead: () => world.head,
        readWorktreeHead: () => realHead(),
        readUnpushedWorkDetail: () => ({ dirtyFiles: dirty(), aheadCount: 0 }),
        gitMergeBase: async (head) => git(dir, 'merge-base', head, 'main'),
        gitIsAncestor: (ancestor, descendant) => {
          try {
            git(dir, 'merge-base', '--is-ancestor', ancestor, descendant)
            return true
          } catch {
            return false
          }
        },
        gitWorktreeChangedPaths: defaultGitWorktreeChangedPaths,
        // The first read sees the tip; every later read sees the default
        // branch moved on, so only a re-recorded head lets the second check pass.
        readDefaultBranchTip: () => (tipReads++ === 0 ? tip : 'f'.repeat(40)),
        dispatchRole: async (role, agent, prompt, opts) => {
          if (role !== 'developer') return baseDeps.dispatchRole!(role, agent, prompt, opts)
          if (results.length === 0) {
            git(dir, 'merge', '-q', '--ff-only', 'main')
            writeFileSync(join(dir, 'own.txt'), 'own\n')
            writeFileSync(join(dir, 'stray.txt'), 'stray\n')
            const first = await world.devToolContext!.publishChanges('Fix(cli): publish after a fast-forward')
            results.push(
              first.ok
                ? { ok: true, reason: '', beyondSurface: first.result.beyondSurface }
                : { ok: false, reason: JSON.stringify(first) }
            )
            rmSync(join(dir, 'stray.txt'))
            const second = await world.devToolContext!.publishChanges('Fix(cli): publish after a fast-forward')
            results.push(
              second.ok
                ? { ok: true, reason: '', beyondSurface: second.result.beyondSurface }
                : { ok: false, reason: JSON.stringify(second) }
            )
            if (second.ok) await world.devToolContext!.openPullRequest(world.issueTitle, '## Scope\n\n**Tier:** 3\n')
          }
          return {
            exitCode: 0,
            durationMs: 1,
            usage: null,
            resumeId: 'dev',
            timedOut: false,
            effectId: 'dev',
            turnOutput: defaultDeveloperTurnOutput(prompt)
          }
        }
      }
    )

    expect(realHead()).toBe(tip)
    // The first check accepted the fast-forward, measured from the tip: it
    // records the stray file beyond the Surface, never the default branch's
    // own `main-only.txt`, and publishes rather than refusing.
    expect(results[0]).toEqual({ ok: true, reason: '', beyondSurface: ['stray.txt'] })
    // The second check sees the head the first publication recorded, and
    // measures from it: the stray file is gone, so nothing is beyond.
    expect(results[1]).toEqual({ ok: true, reason: '', beyondSurface: [] })
    expect(world.commits).toHaveLength(2)
  })
})

describe('the beyond-Surface record when an input cannot be read', () => {
  const handWritten =
    '## Scope\n\nScope.\n\n<!-- AEG:BEYOND-SURFACE:START -->\n- `src/sneaked.ts` hand-added\n<!-- AEG:BEYOND-SURFACE:END -->\n\n**Tier:** 3\n'

  /**
   * Runs a loop whose round-1 review blocks; between that review and the
   * round-2 Developer dispatch the open body carries `handWritten` and
   * `unreadable` replaces the reads, so the body returned is the one the
   * driver writes before that dispatch (its `**For:**` line update).
   */
  async function writtenBody(world: ReturnType<typeof makeWorld>, unreadable: Partial<LoopDeps>): Promise<string> {
    const baseDeps = makeInProcessDeps(world)
    let broken = false
    let firstUpdate = -1
    const read = <K extends 'resolveTaskSurface' | 'readWorktreeHead' | 'gitMergeBase'>(key: K): LoopDeps[K] =>
      ((...args: unknown[]) =>
        ((broken && unreadable[key] ? unreadable[key] : baseDeps[key]) as (...a: unknown[]) => unknown)(
          ...args
        )) as LoopDeps[K]
    await runLoopInProcess(
      world,
      { task: world.task, agent: 'codex' },
      {
        ...baseDeps,
        resolveTaskSurface: read('resolveTaskSurface'),
        readWorktreeHead: read('readWorktreeHead'),
        gitMergeBase: read('gitMergeBase'),
        dispatchRole: async (role, agent, prompt, opts) => {
          if (role === 'developer') broken = false
          const handle = await baseDeps.dispatchRole!(role, agent, prompt, opts)
          if (role === 'code-reviewer' && (opts.round ?? 1) === 1) {
            world.prBody = handWritten
            firstUpdate = world.prBodyUpdates.length
            broken = true
          }
          return handle
        }
      }
    )
    return world.prBodyUpdates[firstUpdate] ?? ''
  }

  function surfaceWorld(): ReturnType<typeof makeWorld> {
    return makeWorld({
      worktreeExists: true,
      developerPushed: true,
      prOpened: true,
      surface: { in: ['apps/cli/src'], out: [] },
      worktreeChangedPaths: ['apps/cli/src/lib/x.ts', 'docs/z.md'],
      roleOutcomes: {
        1: {
          reviewer: {
            findings: 'BLOCKER|apps/cli/src/lib/x.ts:1|clarify the PR body',
            report: 'BRIEF_CONFORMANCE: yes\nSPEC_CONFORMANCE: yes\nSCOPE: small\nTESTS: pass\nDOCS: n/a\n',
            objectives: 'O1|MET|done.\n',
            sessionId: 'rev-session-1'
          }
        }
      }
    })
  }

  it('lists the paths beyond the Surface when the Surface, head and merge base all read', async () => {
    const body = await writtenBody(surfaceWorld(), {})
    expect(recordedBeyondSurfacePaths(body)).toEqual(['docs/z.md'])
    expect(body).not.toContain('src/sneaked.ts')
  })

  const unreadable: [string, Partial<LoopDeps>][] = [
    ['the Surface', { resolveTaskSurface: () => null }],
    ['the worktree head', { readWorktreeHead: () => null }],
    [
      'the merge base',
      {
        gitMergeBase: async () => {
          throw new Error('no merge base')
        }
      }
    ]
  ]
  for (const [input, overrides] of unreadable) {
    it(`writes the block empty when ${input} cannot be read, dropping the hand-written list`, async () => {
      const body = await writtenBody(surfaceWorld(), overrides)
      expect(body).toContain('<!-- AEG:BEYOND-SURFACE:START -->\n<!-- AEG:BEYOND-SURFACE:END -->')
      expect(recordedBeyondSurfacePaths(body)).toEqual([])
      expect(body).not.toContain('src/sneaked.ts')
    })
  }
})
