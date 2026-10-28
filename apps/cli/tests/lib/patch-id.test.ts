import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { ownPatchAt, ownPatchIdAt, ownPatchInterdiff, patchIdAt } from '../../src/lib/patch-id'
import { fixtureDir } from './test-temp-fixture'

// The pull request's own patch, read from real git histories: the one-line assertion both sides extend (each adds a
// `.replace(...)` call at the same place, so the merge conflicts and its resolution keeps both), a resolution that
// changes the pull request's own line, a main-only file, and a criss-cross history with two merge bases.

const BASE = ['expect(', '  value', '    .trim()', ')', ''].join('\n')
const OWN = ['expect(', '  value', '    .trim()', '    .replace(/a/, "b")', ')', ''].join('\n')
const MAIN = ['expect(', '  value', '    .trim()', '    .replace(/x/, "y")', ')', ''].join('\n')
const BOTH = ['expect(', '  value', '    .trim()', '    .replace(/x/, "y")', '    .replace(/a/, "b")', ')', ''].join(
  '\n'
)

function repository() {
  const dir = fixtureDir('own-patch-')
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  const write = (file: string, content: string) => writeFileSync(join(dir, file), content)
  const tryGit = (...args: string[]) => {
    try {
      git(...args)
    } catch {}
  }
  git('init', '-q', '-b', 'main')
  write('assert.test.ts', BASE)
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  git('checkout', '-q', '-b', 'task')
  write('assert.test.ts', OWN)
  git('commit', '-q', '-am', 'task: one replace')
  const judged = git('rev-parse', 'HEAD')
  git('checkout', '-q', 'main')
  write('assert.test.ts', MAIN)
  write('main-only.ts', 'export const fromMain = true\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'main: another replace, and a file of its own')
  const tip = git('rev-parse', 'HEAD')
  git('checkout', '-q', 'task')
  /** Merges the tip as a Developer does (`git merge --no-commit`), resolves the conflict to `content`, commits it. */
  const repair = (content: string) => {
    tryGit('merge', '--no-commit', '--no-ff', tip)
    write('assert.test.ts', content)
    git('add', 'assert.test.ts')
    git('commit', '-q', '--no-edit')
    return git('rev-parse', 'HEAD')
  }
  return { dir, git, tryGit, write, judged, tip, repair }
}

describe('the own patch across a merge of the default branch', () => {
  it('a resolution that keeps both .replace(...) lines merges main in and keeps the own patch identity', () => {
    const repo = repository()
    const merged = repo.repair(BOTH)
    // A real merge, with the default branch's tip as its merged parent, keeping both additions.
    expect(repo.git('rev-list', '--parents', '-n', '1', merged).split(' ').slice(1)).toEqual([repo.judged, repo.tip])
    const file = readFileSync(join(repo.dir, 'assert.test.ts'), 'utf8')
    expect(file).toContain('.replace(/x/, "y")')
    expect(file).toContain('.replace(/a/, "b")')
    const options = { cwd: repo.dir }
    const before = ownPatchIdAt(repo.tip, repo.judged, options)
    expect(before).not.toBeNull()
    expect(ownPatchIdAt(repo.tip, merged, options)).toBe(before)
    // Neither the main-only file nor main's own line is part of the merge's own patch.
    const own = ownPatchAt(repo.tip, merged, options) ?? ''
    expect(own).not.toContain('main-only.ts')
    expect(own).not.toContain('+    .replace(/x/, "y")')
    // The context around the own line did change: a patch with context would not have matched.
    const contextual = (sha: string) =>
      execFileSync('git', ['patch-id', '--stable'], {
        cwd: repo.dir,
        input: repo.git('diff', repo.git('merge-base', repo.tip, sha), sha),
        encoding: 'utf8'
      }).split(' ')[0]
    expect(contextual(merged)).not.toBe(contextual(repo.judged))
    expect(ownPatchInterdiff(repo.tip, repo.judged, merged, options)).toBeNull()
  })

  it('a resolution that changes the own line changes the identity, and the interdiff holds only that change', () => {
    const repo = repository()
    const merged = repo.repair(BOTH.replace('.replace(/a/, "b")', '.replace(/a/, "c")'))
    const options = { cwd: repo.dir }
    expect(ownPatchIdAt(repo.tip, merged, options)).not.toBe(ownPatchIdAt(repo.tip, repo.judged, options))
    const interdiff = ownPatchInterdiff(repo.tip, repo.judged, merged, options) ?? ''
    expect(interdiff).toContain('-+    .replace(/a/, "b")')
    expect(interdiff).toContain('++    .replace(/a/, "c")')
    // Main-only work never appears as a change to review.
    expect(interdiff).not.toContain('main-only.ts')
    expect(interdiff).not.toContain('fromMain')
    expect(interdiff).not.toContain('.replace(/x/, "y")')
    expect(interdiff).not.toMatch(/^index /m)
  })

  it('an object git cannot read, and an ambiguous merge base, answer null — never "the same"', () => {
    const repo = repository()
    const options = { cwd: repo.dir }
    expect(ownPatchIdAt(repo.tip, 'f'.repeat(40), options)).toBeNull()
    expect(ownPatchIdAt('f'.repeat(40), repo.judged, options)).toBeNull()
    // A criss-cross: each side merges the other's first commit, so the two tips share two merge bases.
    repo.git('checkout', '-q', '-b', 'left', repo.judged)
    repo.write('left.ts', 'left\n')
    repo.git('add', '-A')
    repo.git('commit', '-q', '-m', 'left')
    const left = repo.git('rev-parse', 'HEAD')
    repo.git('checkout', '-q', '-b', 'right', repo.judged)
    repo.write('right.ts', 'right\n')
    repo.git('add', '-A')
    repo.git('commit', '-q', '-m', 'right')
    const right = repo.git('rev-parse', 'HEAD')
    repo.git('merge', '-q', '--no-edit', left)
    const rightMerge = repo.git('rev-parse', 'HEAD')
    repo.git('checkout', '-q', 'left')
    repo.git('merge', '-q', '--no-edit', right)
    const leftMerge = repo.git('rev-parse', 'HEAD')
    expect(repo.git('merge-base', '--all', leftMerge, rightMerge).split('\n')).toHaveLength(2)
    expect(ownPatchIdAt(rightMerge, leftMerge, options)).toBeNull()
  })

  it('the base-branch form reads origin/<base>, fetching the commit first', () => {
    const repo = repository()
    const merged = repo.repair(BOTH)
    repo.git('remote', 'add', 'origin', repo.dir)
    repo.git('fetch', '-q', 'origin', 'main:refs/remotes/origin/main')
    const previous = process.cwd()
    process.chdir(repo.dir)
    try {
      expect(patchIdAt('main', merged)).toBe(patchIdAt('main', repo.judged))
      expect(patchIdAt('main', merged)).toBe(ownPatchIdAt(repo.tip, merged))
    } finally {
      process.chdir(previous)
    }
  })
})
