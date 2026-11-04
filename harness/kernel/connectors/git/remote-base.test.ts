// task-run-v1 20, O5/O6 — real git repos, never mocked: a bare "remote", a
// clone with an upstream, and a fresh repo with no remote at all, proving
// the fallback chain actually falls back rather than just reading right on
// the happy path.
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addedOrRenamedFilesSinceRemoteBase,
  changedFilesSinceRemoteBase,
  cleanMergeOnto,
  resolveRemoteBase
} from './remote-base'

// This suite's own process (`bun test`) can itself be running INSIDE a git
// hook — the pre-push hook this very selector feeds runs the affected suite
// before the push it's part of ever leaves the machine. A hook's invoking
// git sets GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE for ITS OWN repo, and those
// inherit into any child `git` command that doesn't build its own explicit
// `env` — confirmed live, expensively: a "no remote at all" fixture, cwd in
// a fresh tmpdir with no remote configured, resolved `@{u}` to THIS
// BRANCH'S real upstream, and four of this suite's real `git commit` calls
// landed as genuine commits on it — the worktree needed a `git reset --hard`
// to its last real commit to recover. `resolveRemoteBase`/
// `changedFilesSinceRemoteBase` themselves now build the same clean `env`
// internally (`remote-base.ts`'s own `cleanGitEnv`) for every call they
// make, so the direct, in-process calls to them below are covered by that
// fix; this file's OWN setup calls (`git init`/`commit`/`push` against the
// fixtures) need the identical treatment for the same reason. A same-process
// mutation of `process.env` was tried first and does NOT work on this
// runtime — a child process spawned afterward still saw the ORIGINAL
// `GIT_DIR`, proving `execFileSync`'s default env inheritance reads a
// snapshot taken at process start, not the live object. The fix has to be
// an explicit `env` at every call site, never a deletion anywhere earlier.
const GIT_ENV: NodeJS.ProcessEnv = { ...process.env }
for (const key of Object.keys(GIT_ENV)) {
  if (key.startsWith('GIT_')) delete GIT_ENV[key]
}

// A ready push names its own base through `VINAYA_PUSH_MODE`/`VINAYA_PUSH_BASE`,
// which `resolveRemoteBase` reads in this process; that base is a commit of the
// pushing repository, absent from these scratch repositories, so the suite
// clears both for the fallback chain it proves.
delete process.env.VINAYA_PUSH_MODE
delete process.env.VINAYA_PUSH_BASE

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim()
}

function initRepo(dir: string): void {
  git(dir, ['init', '--quiet', '--initial-branch=main'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
}

function commit(dir: string, file: string, content: string, message: string): void {
  writeFileSync(join(dir, file), content)
  git(dir, ['add', '--', file])
  git(dir, ['commit', '--quiet', '-m', message])
}

describe('resolveRemoteBase / changedFilesSinceRemoteBase (task-run-v1 20, O5/O6)', () => {
  it('with a configured upstream, resolves it and diffs against it', () => {
    const bareDir = mkdtempSync(join(tmpdir(), 'vinaya-remote-bare-'))
    git(bareDir, ['init', '--quiet', '--bare', '--initial-branch=main'])

    const cloneDir = mkdtempSync(join(tmpdir(), 'vinaya-remote-clone-'))
    git(cloneDir, ['clone', '--quiet', bareDir, '.'])
    git(cloneDir, ['config', 'user.email', 'test@example.com'])
    git(cloneDir, ['config', 'user.name', 'Test'])
    commit(cloneDir, 'a.txt', 'one\n', 'Initial commit')
    git(cloneDir, ['push', '--quiet', '-u', 'origin', 'main'])

    // Local commit not yet pushed — exactly the pre-push moment this exists for.
    commit(cloneDir, 'b.txt', 'two\n', 'Second commit')

    try {
      expect(resolveRemoteBase(cloneDir)).toBe('origin/main')
      expect(changedFilesSinceRemoteBase(cloneDir)).toEqual(['b.txt'])
    } finally {
      rmSync(bareDir, { recursive: true, force: true })
      rmSync(cloneDir, { recursive: true, force: true })
    }
  })

  it('with no upstream but a resolvable origin/main, falls back to it', () => {
    const bareDir = mkdtempSync(join(tmpdir(), 'vinaya-remote-bare-'))
    git(bareDir, ['init', '--quiet', '--bare', '--initial-branch=main'])

    const cloneDir = mkdtempSync(join(tmpdir(), 'vinaya-remote-clone-'))
    initRepo(cloneDir)
    git(cloneDir, ['remote', 'add', 'origin', bareDir])
    commit(cloneDir, 'a.txt', 'one\n', 'Initial commit')
    git(cloneDir, ['push', '--quiet', 'origin', 'main']) // no -u: no upstream tracking set
    commit(cloneDir, 'c.txt', 'three\n', 'Untracked-upstream commit')

    try {
      expect(resolveRemoteBase(cloneDir)).toBe('origin/main')
      expect(changedFilesSinceRemoteBase(cloneDir)).toEqual(['c.txt'])
    } finally {
      rmSync(bareDir, { recursive: true, force: true })
      rmSync(cloneDir, { recursive: true, force: true })
    }
  })

  it('with no remote at all, falls back to the previous commit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-remote-none-'))
    initRepo(dir)
    commit(dir, 'a.txt', 'one\n', 'Initial commit')
    commit(dir, 'd.txt', 'four\n', 'Second commit, still local-only')

    try {
      expect(resolveRemoteBase(dir)).toBe('HEAD~1')
      expect(changedFilesSinceRemoteBase(dir)).toEqual(['d.txt'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a deleted file is never reported — nothing left to lint or test', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-remote-delete-'))
    initRepo(dir)
    commit(dir, 'a.txt', 'one\n', 'Initial commit')
    commit(dir, 'b.txt', 'two\n', 'Add b')
    git(dir, ['rm', '--quiet', 'b.txt'])
    git(dir, ['commit', '--quiet', '-m', 'Remove b'])

    try {
      expect(changedFilesSinceRemoteBase(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('addedOrRenamedFilesSinceRemoteBase reports an added file and a rename, never a plain modification (O1)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-remote-added-'))
    initRepo(dir)
    commit(dir, 'a.txt', 'one\n', 'Initial commit')
    commit(dir, 'orig.txt', 'renamed-away\n', 'Add orig.txt (to be renamed)')

    // One commit, three changes: a plain modification, a brand-new file, and
    // a rename — proving the filter picks the latter two and drops the first.
    writeFileSync(join(dir, 'a.txt'), 'one, modified\n')
    writeFileSync(join(dir, 'new.txt'), 'brand new\n')
    git(dir, ['add', '--', 'a.txt', 'new.txt'])
    git(dir, ['mv', 'orig.txt', 'renamed.txt'])
    git(dir, ['commit', '--quiet', '-m', 'Modify, add, and rename in one commit'])

    try {
      expect(addedOrRenamedFilesSinceRemoteBase(dir).sort()).toEqual(['new.txt', 'renamed.txt'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('resolveRemoteBase after a merge of the default branch', () => {
  // A remote, a branch pushed with one commit, then a default-branch commit
  // pushed from elsewhere and merged by URL — `FETCH_HEAD`, the way the loop's
  // pre-turn merge does it — so `origin/main` never points at the merged commit;
  // then one more branch-only commit, not yet pushed.
  function mergedBranchFixture(): { bareDir: string; cloneDir: string; otherDir: string; merged: string } {
    const bareDir = mkdtempSync(join(tmpdir(), 'vinaya-remote-bare-'))
    git(bareDir, ['init', '--quiet', '--bare', '--initial-branch=main'])

    const cloneDir = mkdtempSync(join(tmpdir(), 'vinaya-remote-clone-'))
    git(cloneDir, ['clone', '--quiet', bareDir, '.'])
    git(cloneDir, ['config', 'user.email', 'test@example.com'])
    git(cloneDir, ['config', 'user.name', 'Test'])
    commit(cloneDir, 'a.txt', 'one\n', 'Initial commit')
    git(cloneDir, ['push', '--quiet', '-u', 'origin', 'main'])
    git(cloneDir, ['checkout', '--quiet', '-b', 'feature'])
    commit(cloneDir, 'f1.txt', 'branch one\n', 'Branch commit, pushed')
    git(cloneDir, ['push', '--quiet', '-u', 'origin', 'feature'])

    const otherDir = mkdtempSync(join(tmpdir(), 'vinaya-remote-other-'))
    git(otherDir, ['clone', '--quiet', bareDir, '.'])
    git(otherDir, ['config', 'user.email', 'test@example.com'])
    git(otherDir, ['config', 'user.name', 'Test'])
    commit(otherDir, 'm.txt', 'default branch\n', 'Default-branch commit')
    git(otherDir, ['push', '--quiet', 'origin', 'main'])

    git(cloneDir, ['fetch', '--quiet', bareDir, 'main'])
    const merged = git(cloneDir, ['rev-parse', 'FETCH_HEAD'])
    git(cloneDir, ['merge', '--quiet', '--no-ff', '--no-edit', 'FETCH_HEAD'])
    commit(cloneDir, 'f2.txt', 'branch two\n', 'Branch commit after the merge')
    return { bareDir, cloneDir, otherDir, merged }
  }

  function cleanUp(...dirs: string[]): void {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  }

  it('measures from the merged commit, keeping every branch file and none the merge brought in', () => {
    const { bareDir, cloneDir, otherDir, merged } = mergedBranchFixture()
    try {
      expect(git(cloneDir, ['rev-parse', 'origin/main'])).not.toBe(merged)
      expect(resolveRemoteBase(cloneDir)).toBe(merged)
      expect(changedFilesSinceRemoteBase(cloneDir).sort()).toEqual(['f1.txt', 'f2.txt'])
    } finally {
      cleanUp(bareDir, cloneDir, otherDir)
    }
  })

  it('a ready push whose named base is the stale remote-tracking ref resolves the same merged commit', () => {
    const { bareDir, cloneDir, otherDir, merged } = mergedBranchFixture()
    process.env.VINAYA_PUSH_MODE = 'ready'
    process.env.VINAYA_PUSH_BASE = 'origin/main'
    try {
      expect(resolveRemoteBase(cloneDir)).toBe(merged)
      expect(changedFilesSinceRemoteBase(cloneDir).sort()).toEqual(['f1.txt', 'f2.txt'])
    } finally {
      delete process.env.VINAYA_PUSH_MODE
      delete process.env.VINAYA_PUSH_BASE
      cleanUp(bareDir, cloneDir, otherDir)
    }
  })

  it('with no merge, the upstream stands and a ready push keeps its named base', () => {
    const bareDir = mkdtempSync(join(tmpdir(), 'vinaya-remote-bare-'))
    git(bareDir, ['init', '--quiet', '--bare', '--initial-branch=main'])
    const cloneDir = mkdtempSync(join(tmpdir(), 'vinaya-remote-clone-'))
    git(cloneDir, ['clone', '--quiet', bareDir, '.'])
    git(cloneDir, ['config', 'user.email', 'test@example.com'])
    git(cloneDir, ['config', 'user.name', 'Test'])
    commit(cloneDir, 'a.txt', 'one\n', 'Initial commit')
    const initial = git(cloneDir, ['rev-parse', 'HEAD'])
    git(cloneDir, ['push', '--quiet', '-u', 'origin', 'main'])
    git(cloneDir, ['checkout', '--quiet', '-b', 'feature'])
    commit(cloneDir, 'f1.txt', 'branch one\n', 'Branch commit, pushed')
    git(cloneDir, ['push', '--quiet', '-u', 'origin', 'feature'])
    commit(cloneDir, 'f2.txt', 'branch two\n', 'Branch commit, not yet pushed')

    try {
      expect(resolveRemoteBase(cloneDir)).toBe('origin/feature')
      expect(changedFilesSinceRemoteBase(cloneDir)).toEqual(['f2.txt'])
      process.env.VINAYA_PUSH_MODE = 'ready'
      process.env.VINAYA_PUSH_BASE = initial
      expect(resolveRemoteBase(cloneDir)).toBe(initial)
    } finally {
      delete process.env.VINAYA_PUSH_MODE
      delete process.env.VINAYA_PUSH_BASE
      cleanUp(bareDir, cloneDir)
    }
  })
})

describe('newest merge', () => {
  // One repository: a base commit, the branch's recorded commit, default-branch commits and the merge of them.
  function mergeRepo(options: { main?: Record<string, string>; inMerge?: Record<string, string> } = {}): {
    dir: string
    recordHead: string
    merge: string
  } {
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-newest-merge-'))
    initRepo(dir)
    commit(dir, 'shared.txt', 'one\ntwo\nthree\n', 'Initial commit')
    git(dir, ['checkout', '--quiet', '-b', 'feature'])
    commit(dir, 'shared.txt', 'ONE\ntwo\nthree\n', 'Recorded branch commit')
    const recordHead = git(dir, ['rev-parse', 'HEAD'])
    git(dir, ['checkout', '--quiet', 'main'])
    for (const [file, content] of Object.entries(options.main ?? { 'm.txt': 'default branch\n' }))
      commit(dir, file, content, `Default-branch edit of ${file}`)
    git(dir, ['checkout', '--quiet', 'feature'])
    git(dir, ['merge', '--quiet', '--no-ff', '--no-commit', 'main'])
    for (const [file, content] of Object.entries(options.inMerge ?? {})) {
      writeFileSync(join(dir, file), content)
      git(dir, ['add', '--', file])
    }
    git(dir, ['commit', '--quiet', '-m', 'Merge the default branch'])
    return { dir, recordHead, merge: git(dir, ['rev-parse', 'HEAD']) }
  }

  it('a clean merge whose first parent is the recorded head is the base', () => {
    const { dir, recordHead, merge } = mergeRepo()
    try {
      commit(dir, 'f2.txt', 'after\n', 'Branch commit after the merge')
      expect(cleanMergeOnto(dir, recordHead)).toBe(merge)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('both sides editing one file, the merge holding both edits, is not a clean union', () => {
    const { dir, recordHead } = mergeRepo({ main: { 'shared.txt': 'one\ntwo\nTHREE\n' } })
    try {
      expect(git(dir, ['show', 'HEAD:shared.txt'])).toBe('ONE\ntwo\nTHREE')
      expect(cleanMergeOnto(dir, recordHead)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a file only the merge changed is not a clean union', () => {
    const { dir, recordHead } = mergeRepo({ inMerge: { 'resolved.txt': 'edited in the merge\n' } })
    try {
      expect(cleanMergeOnto(dir, recordHead)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a second merge since the recorded head is not the merge onto it', () => {
    const { dir, recordHead } = mergeRepo()
    try {
      git(dir, ['checkout', '--quiet', 'main'])
      commit(dir, 'm2.txt', 'again\n', 'Second default-branch commit')
      git(dir, ['checkout', '--quiet', 'feature'])
      git(dir, ['merge', '--quiet', '--no-ff', '--no-edit', 'main'])
      expect(cleanMergeOnto(dir, recordHead)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('no merge since the recorded head, or an unknown head, gives no merge', () => {
    const { dir, merge } = mergeRepo()
    try {
      expect(cleanMergeOnto(dir, merge)).toBeNull()
      expect(cleanMergeOnto(dir, 'f'.repeat(40))).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
