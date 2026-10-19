import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { changedLineRanges, resolveAddedFiles, resolveChangedFiles } from '../src/lib/diff-evidence'
import { coreCheckRegistry } from '../src/checks/registry'

// Code review, PR #290:
//   BLOCKER — resolveChangedFiles() fell open on a shallow-clone/orphan-
//     history diff failure: `git diff base...HEAD` throws when `base` and
//     `HEAD` share no merge base, and the pre-fix version caught that throw
//     and returned `[]`, which every caller read as "confirmed: nothing
//     changed" — silently dropping a real finding backlog to zero instead of
//     reporting it unfiltered.
//   MAJOR — path comparison assumed `process.cwd()` was the repo root.
// This file is the "crux function" test coverage the review's two MINORs
// asked for — a bare filter or transform test would not have caught either
// bug above; both need a real git fixture with a genuine no-merge-base
// history to reproduce.

let roots: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/**
 * `realpathSync` — never the raw `tmpdir()` path — because `git
 * rev-parse --show-toplevel` (which `resolveChangedFiles` uses to build its
 * absolute paths) resolves symlinks, and macOS's `/tmp` and `/var` are both
 * symlinks into `/private/...`. Comparing an un-resolved expected path
 * against the function's resolved output fails on every macOS run for a
 * reason that has nothing to do with the function under test.
 */
function newRoot(name: string): string {
  const raw = join(tmpdir(), `vinaya-diff-evidence-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(raw, { recursive: true })
  const root = realpathSync(raw)
  roots.push(root)
  return root
}

function initRepo(root: string): void {
  git(root, ['init', '-q', '-b', 'main'])
  git(root, ['config', 'user.email', 'test@example.com'])
  git(root, ['config', 'user.name', 'Test'])
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

describe('resolveChangedFiles — the normal case', () => {
  it('resolves a real diff against main as absolute paths', () => {
    const root = newRoot('normal')
    initRepo(root)
    writeFileSync(join(root, 'a.md'), '# a\n')
    git(root, ['add', 'a.md'])
    git(root, ['commit', '-q', '-m', 'Chore: initial'])

    git(root, ['checkout', '-q', '-b', 'feature'])
    writeFileSync(join(root, 'b.md'), '# b\n')
    git(root, ['add', 'b.md'])
    git(root, ['commit', '-q', '-m', 'Feat: add b'])

    const cwd = process.cwd()
    try {
      process.chdir(root)
      const changed = resolveChangedFiles('main')
      expect(changed).not.toBeNull()
      expect(changed).toEqual([join(root, 'b.md')])
      // Absolute, not repo-relative — every entry starts with the real root.
      for (const p of changed ?? []) expect(p.startsWith(root)).toBe(true)
    } finally {
      process.chdir(cwd)
    }
  })

  it('resolves correctly even when invoked from a different cwd than the repo root (review finding, MAJOR)', () => {
    const root = newRoot('cwd-independent')
    initRepo(root)
    writeFileSync(join(root, 'a.md'), '# a\n')
    git(root, ['add', 'a.md'])
    git(root, ['commit', '-q', '-m', 'Chore: initial'])
    git(root, ['checkout', '-q', '-b', 'feature'])
    writeFileSync(join(root, 'b.md'), '# b\n')
    git(root, ['add', 'b.md'])
    git(root, ['commit', '-q', '-m', 'Feat: add b'])

    const subdir = join(root, 'sub')
    mkdirSync(subdir, { recursive: true })

    const cwd = process.cwd()
    try {
      // Invoked from a SUBDIRECTORY of the repo, not the repo root itself —
      // `git` commands still resolve correctly (git walks up to find the
      // repo), but a caller comparing paths against `process.cwd()` directly
      // (the pre-fix bug) would compute the wrong relative base here.
      process.chdir(subdir)
      const changed = resolveChangedFiles('main')
      expect(changed).toEqual([join(root, 'b.md')])
    } finally {
      process.chdir(cwd)
    }
  })

  it('returns [] — a genuine, resolved, empty diff — when HEAD differs from main but touches no files', () => {
    const root = newRoot('genuinely-empty')
    initRepo(root)
    writeFileSync(join(root, 'a.md'), '# a\n')
    git(root, ['add', 'a.md'])
    git(root, ['commit', '-q', '-m', 'Chore: initial'])
    git(root, ['checkout', '-q', '-b', 'feature'])
    // A real commit distinct from `main` (different SHA — `resolveChangedFiles`
    // does not skip it as "indeterminate"), but an EMPTY one: no file changes
    // at all. This is the genuinely-distinguishable case a same-SHA branch
    // (see the "indeterminate" describe block below) is not: a real base ref
    // that legitimately differs from HEAD, diffed successfully, with nothing
    // in it.
    git(root, ['commit', '-q', '--allow-empty', '-m', 'Chore: empty commit, no file changes'])

    const cwd = process.cwd()
    try {
      process.chdir(root)
      expect(resolveChangedFiles('main')).toEqual([])
    } finally {
      process.chdir(cwd)
    }
  })
})

// CI checks out the pull request merged into the base branch's tip as that
// merge was built, while the event's base commit stays where the pull
// request was last updated. Once the base branch moves past it, only the
// merge's first parent diffs to the pull request's own files.
describe('resolveChangedFiles — a merge built on a moved base', () => {
  it("against the merge's first parent reports only the pull request's files; against the stale event base, the base branch's later commit too", () => {
    const root = newRoot('moved-base')
    initRepo(root)
    writeFileSync(join(root, 'a.md'), '# a\n')
    git(root, ['add', 'a.md'])
    git(root, ['commit', '-q', '-m', 'Chore: initial'])
    git(root, ['checkout', '-q', '-b', 'feature'])
    writeFileSync(join(root, 'pr.md'), '# pr\n')
    git(root, ['add', 'pr.md'])
    git(root, ['commit', '-q', '-m', 'Feat: the pull request'])
    git(root, ['checkout', '-q', 'main'])
    const staleBase = git(root, ['rev-parse', 'HEAD'])
    writeFileSync(join(root, 'later.md'), '# later\n')
    git(root, ['add', 'later.md'])
    git(root, ['commit', '-q', '-m', 'Feat: later on main'])
    git(root, ['merge', '-q', '--no-ff', '-m', 'Merge feature into main', 'feature'])
    const firstParent = git(root, ['rev-parse', 'HEAD^1'])

    const cwd = process.cwd()
    try {
      process.chdir(root)
      expect(resolveChangedFiles(staleBase)).toContain(join(root, 'later.md'))
      expect(resolveChangedFiles(firstParent)).toEqual([join(root, 'pr.md')])
    } finally {
      process.chdir(cwd)
    }
  })
})

describe('resolveChangedFiles — pre-commit staged evidence', () => {
  it('unions staged paths and line ranges with the committed branch diff only under the hook marker', () => {
    const root = newRoot('staged-union')
    initRepo(root)
    writeFileSync(join(root, 'committed.md'), 'base\n')
    writeFileSync(join(root, 'staged.md'), 'base\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-q', '-m', 'Chore: initial'])
    git(root, ['checkout', '-q', '-b', 'feature'])
    writeFileSync(join(root, 'committed.md'), 'base\ncommitted\n')
    git(root, ['add', 'committed.md'])
    git(root, ['commit', '-q', '-m', 'Fix: committed change'])
    writeFileSync(join(root, 'staged.md'), 'base\nstaged\n')
    git(root, ['add', 'staged.md'])

    const cwd = process.cwd()
    const oldMarker = process.env.VINAYA_COMMIT_HOOK
    const oldIndex = process.env.GIT_INDEX_FILE
    try {
      process.chdir(root)
      process.env.VINAYA_COMMIT_HOOK = '1'
      process.env.GIT_INDEX_FILE = join(root, '.git', 'index')
      expect(resolveChangedFiles('main')).toEqual([join(root, 'committed.md'), join(root, 'staged.md')])
      expect(changedLineRanges('main', 'staged.md')).not.toBeNull()

      delete process.env.VINAYA_COMMIT_HOOK
      expect(resolveChangedFiles('main')).toEqual([join(root, 'committed.md')])
      expect(changedLineRanges('main', 'staged.md')).toBeNull()
    } finally {
      process.chdir(cwd)
      if (oldMarker === undefined) delete process.env.VINAYA_COMMIT_HOOK
      else process.env.VINAYA_COMMIT_HOOK = oldMarker
      if (oldIndex === undefined) delete process.env.GIT_INDEX_FILE
      else process.env.GIT_INDEX_FILE = oldIndex
    }
  })

  it('returns null when a marked pre-commit staged diff cannot be read', () => {
    const root = newRoot('unreadable-index')
    initRepo(root)
    writeFileSync(join(root, 'a.md'), 'base\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-q', '-m', 'Chore: initial'])
    git(root, ['checkout', '-q', '-b', 'feature'])
    git(root, ['commit', '-q', '--allow-empty', '-m', 'Chore: distinct head'])
    const badIndex = join(root, 'bad-index')
    writeFileSync(badIndex, 'not a git index')

    const cwd = process.cwd()
    const oldMarker = process.env.VINAYA_COMMIT_HOOK
    const oldIndex = process.env.GIT_INDEX_FILE
    try {
      process.chdir(root)
      process.env.VINAYA_COMMIT_HOOK = '1'
      process.env.GIT_INDEX_FILE = badIndex
      expect(resolveChangedFiles('main')).toBeNull()
    } finally {
      process.chdir(cwd)
      if (oldMarker === undefined) delete process.env.VINAYA_COMMIT_HOOK
      else process.env.VINAYA_COMMIT_HOOK = oldMarker
      if (oldIndex === undefined) delete process.env.GIT_INDEX_FILE
      else process.env.GIT_INDEX_FILE = oldIndex
    }
  })
})

describe('resolveChangedFiles — indeterminate cases fail closed, never silently "clean" (review finding, BLOCKER)', () => {
  it('returns null, never [], when HEAD has no merge base with either candidate (shallow-clone/orphan-history shape)', () => {
    const root = newRoot('orphan')
    initRepo(root)
    writeFileSync(join(root, 'a.md'), '# a\n')
    git(root, ['add', 'a.md'])
    git(root, ['commit', '-q', '-m', 'Chore: initial on main'])

    // A second `main`-named ref with UNRELATED history — same shape a
    // shallow clone (`fetch-depth: 1`) presents: `origin/main` resolves to a
    // real, distinct commit, but `git diff origin/main...HEAD` throws
    // because the two share no common ancestor. `--orphan` reproduces that
    // exact failure locally, deterministically, without a real shallow
    // fetch.
    git(root, ['checkout', '-q', '--orphan', 'unrelated'])
    git(root, ['rm', '-rf', '--quiet', '.'])
    writeFileSync(join(root, 'unrelated.md'), '# unrelated history\n')
    git(root, ['add', 'unrelated.md'])
    git(root, ['commit', '-q', '-m', 'Chore: unrelated root commit'])

    const cwd = process.cwd()
    try {
      process.chdir(root)
      // `main` (the requested base) shares no history with HEAD (`unrelated`).
      // There is no second candidate ref that resolves to anything else here
      // — `resolveChangedFiles` must report "cannot answer," not "confirmed
      // clean."
      expect(resolveChangedFiles('main')).toBeNull()
    } finally {
      process.chdir(cwd)
    }
  })

  it('falls through to a working candidate rather than reporting null when only the FIRST base has no merge base', () => {
    const root = newRoot('orphan-with-fallback')
    initRepo(root)
    writeFileSync(join(root, 'a.md'), '# a\n')
    git(root, ['add', 'a.md'])
    git(root, ['commit', '-q', '-m', 'Chore: initial on main'])
    // `main` is a real, resolvable ancestor of HEAD from here on.
    git(root, ['checkout', '-q', '-b', 'feature'])
    writeFileSync(join(root, 'b.md'), '# b\n')
    git(root, ['add', 'b.md'])
    git(root, ['commit', '-q', '-m', 'Feat: add b'])

    const cwd = process.cwd()
    try {
      process.chdir(root)
      // The requested base ('nonexistent-ref') doesn't resolve at all — the
      // second candidate, 'main', does, and has a real merge base with HEAD.
      const changed = resolveChangedFiles('nonexistent-ref')
      expect(changed).toEqual([join(root, 'b.md')])
    } finally {
      process.chdir(cwd)
    }
  })

  it('returns null in a bare/single-commit fixture with no origin remote (RC3 fixture shape)', () => {
    const root = newRoot('bare-single-commit')
    initRepo(root)
    writeFileSync(join(root, 'README.md'), '# fixture\n')
    git(root, ['add', 'README.md'])
    git(root, ['commit', '-q', '-m', 'Chore: initial commit'])

    const cwd = process.cwd()
    try {
      process.chdir(root)
      // 'origin/main' doesn't exist (no remote); 'main' resolves, but it IS
      // HEAD — no distinct base to diff against at all.
      expect(resolveChangedFiles()).toBeNull()
    } finally {
      process.chdir(cwd)
    }
  })

  it('returns null outside any git repository', () => {
    const root = newRoot('not-a-repo')
    const cwd = process.cwd()
    try {
      process.chdir(root)
      expect(resolveChangedFiles()).toBeNull()
    } finally {
      process.chdir(cwd)
    }
  })
})

describe('resolveAddedFiles — committed additions and conservative fallback', () => {
  function fixture(): string {
    const root = newRoot('added')
    initRepo(root)
    writeFileSync(join(root, 'existing.md'), 'base\n')
    writeFileSync(join(root, 'deleted.md'), 'base\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-q', '-m', 'base'])
    git(root, ['checkout', '-q', '-b', 'feature'])
    return root
  }

  function fromRoot<T>(root: string, read: () => T): T {
    const cwd = process.cwd()
    try {
      process.chdir(root)
      return read()
    } finally {
      process.chdir(cwd)
    }
  }

  it('returns only committed additions, independent of index evidence or caller subdirectory', () => {
    const root = fixture()
    writeFileSync(join(root, 'existing.md'), 'edited\n')
    writeFileSync(join(root, 'added.md'), 'added\n')
    git(root, ['rm', 'deleted.md'])
    git(root, ['add', '.'])
    git(root, ['commit', '-q', '-m', 'changes'])
    writeFileSync(join(root, 'staged.md'), 'staged\n')
    git(root, ['add', 'staged.md'])
    const subdir = join(root, 'subdir')
    mkdirSync(subdir)
    const oldMarker = process.env.VINAYA_COMMIT_HOOK
    const oldIndex = process.env.GIT_INDEX_FILE
    try {
      process.env.VINAYA_COMMIT_HOOK = '1'
      process.env.GIT_INDEX_FILE = join(root, '.git', 'index')
      expect(fromRoot(subdir, () => resolveAddedFiles('main'))).toEqual(['added.md'])
    } finally {
      if (oldMarker === undefined) delete process.env.VINAYA_COMMIT_HOOK
      else process.env.VINAYA_COMMIT_HOOK = oldMarker
      if (oldIndex === undefined) delete process.env.GIT_INDEX_FILE
      else process.env.GIT_INDEX_FILE = oldIndex
    }
  })

  it('tries explicit base, origin/main, and main in order, skipping same-HEAD candidates', () => {
    const root = fixture()
    writeFileSync(join(root, 'first.md'), 'first\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-q', '-m', 'first'])
    git(root, ['branch', 'explicit'])
    git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
    writeFileSync(join(root, 'second.md'), 'second\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-q', '-m', 'second'])
    fromRoot(root, () => {
      expect(resolveAddedFiles('explicit')).toEqual(['second.md'])
      expect(resolveAddedFiles('missing')).toEqual(['second.md'])
      git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
      expect(resolveAddedFiles('HEAD')).toEqual(['first.md', 'second.md'])
    })
  })

  it('distinguishes a resolved empty diff from indeterminate or unrelated history', () => {
    const root = fixture()
    expect(fromRoot(root, () => resolveAddedFiles('missing'))).toBeNull()
    git(root, ['commit', '-q', '--allow-empty', '-m', 'empty'])
    expect(fromRoot(root, () => resolveAddedFiles('main'))).toEqual([])
    git(root, ['checkout', '-q', '--orphan', 'unrelated'])
    git(root, ['commit', '-q', '-m', 'unrelated'])
    expect(fromRoot(root, () => resolveAddedFiles('main'))).toBeNull()
    // A failed first candidate must not prevent a later usable main diff.
    git(root, ['checkout', '-q', 'feature'])
    expect(fromRoot(root, () => resolveAddedFiles('unrelated'))).toEqual([])
    expect(fromRoot(newRoot('no-git'), () => resolveAddedFiles())).toBeNull()
  })
})

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('diff-reading checks declare the variables their diff reader uses', () => {
  const srcDir = join(import.meta.dir, '..', 'src')
  // `repoRoot` resolves the repository root and reads no diff; `lineIsInRanges`
  // is a pure predicate over ranges it is handed.
  const NOT_READERS = new Set(['repoRoot', 'lineIsInRanges'])

  function readerSet(): Set<string> {
    const helper = stripComments(readFileSync(join(srcDir, 'lib', 'diff-evidence.ts'), 'utf8'))
    const names = new Set<string>()
    for (const m of helper.matchAll(/^export\s+(?:async\s+)?(?:function|const)\s+([A-Za-z_$][\w$]*)/gm)) {
      if (m[1] && !NOT_READERS.has(m[1])) names.add(m[1])
    }
    return names
  }

  it('derives the reader set from the helper and exports no shape the derivation misses', () => {
    const helper = stripComments(readFileSync(join(srcDir, 'lib', 'diff-evidence.ts'), 'utf8'))
    const readers = readerSet()
    for (const name of [
      'fileDiffAgainst',
      'resolveChangedFiles',
      'resolveAddedFiles',
      'resolveDiff',
      'changedLineRanges',
      'findingsInThisDiff'
    ]) {
      expect(readers.has(name), name).toBe(true)
    }
    expect(helper).not.toMatch(/^export\s*\{/m)
    expect(helper).not.toMatch(/^export\s+default\b/m)
    expect(helper).not.toMatch(/^export\s+(?:let|class)\b/m)
  })

  it('every check bin that calls a shared diff reader declares BASE_SHA, GIT_INDEX_FILE and VINAYA_COMMIT_HOOK', () => {
    const readers = readerSet()
    const diffReading: string[] = []
    for (const spec of coreCheckRegistry()) {
      const binPath = join(srcDir, 'checks', 'bin', `check-${spec.name}.ts`)
      if (!existsSync(binPath)) continue
      const source = stripComments(readFileSync(binPath, 'utf8'))
      const imported = new Set<string>()
      for (const m of source.matchAll(
        /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"][^'"]*\/lib\/diff-evidence['"]/g
      )) {
        for (const part of (m[1] ?? '').split(',')) {
          const name = part
            .trim()
            .split(/\s+as\s+/)[0]
            ?.trim()
          if (name) imported.add(name)
        }
      }
      if (![...imported].some((name) => readers.has(name))) continue
      diffReading.push(spec.name)
      for (const key of ['BASE_SHA', 'GIT_INDEX_FILE', 'VINAYA_COMMIT_HOOK']) {
        expect(spec.env?.[key], `${spec.name} must declare ${key}`).toEqual({ optional: true })
      }
    }
    expect(diffReading.length).toBeGreaterThanOrEqual(8)
  })

  it('review-gate declares no diff base', () => {
    const spec = coreCheckRegistry().find((candidate) => candidate.name === 'review-gate')
    expect(spec?.env?.BASE_SHA).toBeUndefined()
  })
})
