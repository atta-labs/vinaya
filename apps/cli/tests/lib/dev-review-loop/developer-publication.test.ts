/**
 * agent-confinement-v1 — unit tests for the pure gate logic the driver's
 * publishing tools run: commit-header validation (O2) and the pre-publication
 * checks (O7). The orchestration itself (the tool context's commit → push →
 * open, the reask loop) is covered through the in-process loop harness in
 * `inproc-5.test.ts`.
 */

import { describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultGitWorktreeChangedPaths, defaultReadMergedDefaultCommit } from '../../../src/lib/dev-review-loop.js'
import {
  checkPublicationPreconditions,
  validateCommitHeader
} from '../../../src/lib/dev-review-loop/developer-publication.js'

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

  it('passes when branch, base, head and Surface all hold', () => {
    expect(checkPublicationPreconditions(ok).ok).toBe(true)
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

  it('fails when a changed path crosses an out: glob', () => {
    const r = checkPublicationPreconditions({ ...ok, changedPaths: ['packages/aeg-core/src/x.ts'] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/out:/)
  })

  it('fails when a changed path matches no in: glob', () => {
    const r = checkPublicationPreconditions({ ...ok, changedPaths: ['apps/log-server/x.ts'] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/no `in:` glob/)
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

  /** A repo whose `origin/main` is a real remote-tracking ref, with a task branch cut from the first main commit. */
  const fixture = (): { dir: string; base: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'pub-range-'))
    git(dir, 'init', '-q', '-b', 'main')
    writeFileSync(join(dir, 'a.txt'), 'a\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'base')
    const base = git(dir, 'rev-parse', 'HEAD')
    git(dir, 'checkout', '-q', '-b', 'task')
    writeFileSync(join(dir, 'own.txt'), 'own\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'own')
    return { dir, base }
  }

  const advanceMain = (dir: string, file: string): string => {
    git(dir, 'checkout', '-q', 'main')
    writeFileSync(join(dir, file), 'main\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', `main ${file}`)
    const tip = git(dir, 'rev-parse', 'HEAD')
    git(dir, 'update-ref', 'refs/remotes/origin/main', tip)
    git(dir, 'checkout', '-q', 'task')
    return tip
  }

  it('reads nothing when the turn merged no default-branch commit', () => {
    const { dir, base } = fixture()
    git(dir, 'update-ref', 'refs/remotes/origin/main', base)
    expect(defaultReadMergedDefaultCommit(dir, base)).toBeNull()
  })

  it('ignores a merged commit unrelated to the default branch', () => {
    const { dir, base } = fixture()
    const pushed = git(dir, 'rev-parse', 'HEAD')
    git(dir, 'update-ref', 'refs/remotes/origin/main', base)
    git(dir, 'checkout', '-q', '--orphan', 'other')
    writeFileSync(join(dir, 'x.txt'), 'x\n')
    git(dir, 'add', 'x.txt')
    git(dir, 'commit', '-q', '-m', 'other')
    git(dir, 'checkout', '-q', 'task')
    git(dir, 'merge', '-q', '--allow-unrelated-histories', '-m', 'merge other', 'other')
    expect(defaultReadMergedDefaultCommit(dir, pushed)).toBeNull()
  })

  it('reads the committed merge parent, so main-only files are not the task change', () => {
    const { dir, base } = fixture()
    const pushed = git(dir, 'rev-parse', 'HEAD')
    const tip = advanceMain(dir, 'main-only.txt')
    git(dir, 'merge', '-q', '--no-ff', '-m', 'merge main', 'main')
    // A default-branch ref that is behind the merged commit must not hide the merge.
    git(dir, 'update-ref', 'refs/remotes/origin/main', base)
    expect(defaultReadMergedDefaultCommit(dir, pushed)?.commit).toBe(tip)
    git(dir, 'update-ref', 'refs/remotes/origin/main', tip)
    const merged = defaultReadMergedDefaultCommit(dir, pushed)
    expect(merged).toEqual({ commit: tip, regressedPaths: [] })
    expect(defaultGitWorktreeChangedPaths(dir, tip)).toEqual(['own.txt'])
    expect(defaultGitWorktreeChangedPaths(dir, pushed)).toContain('main-only.txt')
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
    git(dir, 'update-ref', 'refs/remotes/origin/main', git(dir, 'rev-parse', 'HEAD'))
    git(dir, 'checkout', '-q', 'task')
    git(dir, 'merge', '-q', '--no-commit', '--no-ff', older)
    const merged = defaultReadMergedDefaultCommit(dir, pushed)
    expect(merged?.commit).toBe(older)
    expect(merged?.regressedPaths).toEqual(['guarded.txt'])
  })

  it('reads the staged in-progress merge incoming commit', () => {
    const { dir } = fixture()
    const pushed = git(dir, 'rev-parse', 'HEAD')
    const tip = advanceMain(dir, 'main-only.txt')
    git(dir, 'merge', '-q', '--no-commit', '--no-ff', 'main')
    const merged = defaultReadMergedDefaultCommit(dir, pushed)
    expect(merged?.commit).toBe(tip)
    expect(defaultGitWorktreeChangedPaths(dir, tip)).toEqual(['own.txt'])
  })

  it('still reports a file the Developer itself changed outside the Surface', () => {
    const { dir } = fixture()
    const pushed = git(dir, 'rev-parse', 'HEAD')
    advanceMain(dir, 'main-only.txt')
    git(dir, 'merge', '-q', '--no-commit', '--no-ff', 'main')
    writeFileSync(join(dir, 'a.txt'), 'edited in the merge\n')
    git(dir, 'add', '.')
    const merged = defaultReadMergedDefaultCommit(dir, pushed)
    const changed = defaultGitWorktreeChangedPaths(dir, merged?.commit as string)
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
    expect(verdict.ok).toBe(false)
  })
})
