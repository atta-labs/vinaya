import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkDirtyPinnedFiles,
  checkStaleAgainstRemote,
  resolveBoundaryPaths,
  resolveRemoteDefaultBranch,
  taskNotFoundMessage
} from '../../src/lib/brief-assembly.js'

/**
 * O2 (task-run-v1 task 11) — a dispatch not-found message names the title
 * form, the label, and the count of open Issues carrying it, so the three
 * distinct causes (no Issue yet, wrong label, wrong title) are
 * distinguishable from the message alone.
 */
describe('taskNotFoundMessage (O2)', () => {
  it('names the title form, the label, and the open-Issue count', () => {
    const msg = taskNotFoundMessage('task-run-v1', '11', 3)
    expect(msg).toContain('task "11" is not present in tranche "task-run-v1"')
    expect(msg).toContain('[task-run-v1] 11 —')
    expect(msg).toContain('vinaya/tranche:task-run-v1')
    expect(msg).toContain('3 open Issue(s) carry that label')
  })

  it('reports zero cleanly when no open Issue carries the label at all', () => {
    const msg = taskNotFoundMessage('task-run-v1', '99', 0)
    expect(msg).toContain('0 open Issue(s) carry that label')
  })
})

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/**
 * `resolveBoundaryPaths` — the impure-adjacent half of task 5 (Issue #447,
 * O3): resolving `extractBoundaryFilePaths` tokens (tested purely in
 * `packages/aeg-core/src/brief-render.test.ts`) against a real `git
 * ls-files` snapshot. The snapshot is injected here so this stays a fast,
 * network-free unit test.
 */
describe('resolveBoundaryPaths', () => {
  it('resolves a full repo-relative path via an exact match', () => {
    const files = ['apps/cli/src/lib/dispatch-task.ts', 'apps/cli/src/lib/brief-assembly.ts']
    expect(resolveBoundaryPaths(['apps/cli/src/lib/dispatch-task.ts'], files)).toEqual([
      'apps/cli/src/lib/dispatch-task.ts'
    ])
  })

  it('resolves a bare filename elided from a shared directory prefix via a unique suffix match', () => {
    const files = ['aeg-root/roles/developer.md', 'aeg-root/process.md', 'aeg-root/aeg-manual-flow.md']
    expect(resolveBoundaryPaths(['process.md'], files)).toEqual(['aeg-root/process.md'])
    expect(resolveBoundaryPaths(['roles/developer.md'], files)).toEqual(['aeg-root/roles/developer.md'])
  })

  it('drops a token with zero matches, never guessing a new/renamed path', () => {
    expect(resolveBoundaryPaths(['this-file-does-not-exist.ts'], ['apps/cli/src/lib/dispatch-task.ts'])).toEqual([])
  })

  it('drops an ambiguous token that suffix-matches more than one tracked file', () => {
    const files = ['apps/cli/src/commands/brief.ts', 'apps/aeg-core/src/other/brief.ts']
    expect(resolveBoundaryPaths(['brief.ts'], files)).toEqual([])
  })

  it('deduplicates when two tokens resolve to the same tracked file', () => {
    const files = ['aeg-root/roles/developer.md']
    expect(resolveBoundaryPaths(['roles/developer.md', 'aeg-root/roles/developer.md'], files)).toEqual([
      'aeg-root/roles/developer.md'
    ])
  })
})

/**
 * task-run-v1 task 4, Issue #483, O1 — Part 1's own Test plan sentence:
 * "proven with a fixture repo in both states." A real remote/local repo
 * pair, no network, no mocked `git` — `resolveRemoteDefaultBranch`/
 * `checkStaleAgainstRemote`/`checkDirtyPinnedFiles` are the exact functions
 * `assembleAndRenderBrief` calls.
 */
describe('checkStaleAgainstRemote / checkDirtyPinnedFiles — fixture repo, both states', () => {
  let tmpDir: string
  let remoteDir: string
  let localDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'vinaya-brief-freshness-'))
    remoteDir = join(tmpDir, 'remote')
    localDir = join(tmpDir, 'local')
    mkdirSync(remoteDir, { recursive: true })
    git(remoteDir, ['init', '-q', '-b', 'main'])
    git(remoteDir, ['config', 'user.email', 'a@example.com'])
    git(remoteDir, ['config', 'user.name', 'A'])
    writeFileSync(join(remoteDir, 'pinned.md'), 'v1\n')
    git(remoteDir, ['add', 'pinned.md'])
    git(remoteDir, ['commit', '-q', '-m', 'first'])

    git(tmpDir, ['clone', '-q', remoteDir, localDir])
    git(localDir, ['config', 'user.email', 'a@example.com'])
    git(localDir, ['config', 'user.name', 'A'])
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('resolveRemoteDefaultBranch reads the real remote default branch name and sha', () => {
    const headSha = git(remoteDir, ['rev-parse', 'HEAD'])
    const resolved = resolveRemoteDefaultBranch(localDir)
    expect(resolved).toEqual({ branch: 'main', sha: headSha })
  })

  it('checkStaleAgainstRemote passes cleanly when HEAD equals the remote default branch tip', () => {
    const headSha = git(localDir, ['rev-parse', 'HEAD'])
    const result = checkStaleAgainstRemote(headSha, () => resolveRemoteDefaultBranch(localDir))
    expect(result).toEqual([])
  })

  it('checkStaleAgainstRemote refuses, naming both revisions, when the local checkout is one commit behind', () => {
    const staleHeadSha = git(localDir, ['rev-parse', 'HEAD'])

    // Advance the remote's main past the local checkout's HEAD.
    writeFileSync(join(remoteDir, 'pinned.md'), 'v2\n')
    git(remoteDir, ['add', 'pinned.md'])
    git(remoteDir, ['commit', '-q', '-m', 'second'])
    const newRemoteSha = git(remoteDir, ['rev-parse', 'HEAD'])

    const result = checkStaleAgainstRemote(staleHeadSha, () => resolveRemoteDefaultBranch(localDir))
    expect(result.length).toBe(1)
    expect(result[0]).toContain(staleHeadSha)
    expect(result[0]).toContain(newRemoteSha)
    expect(result[0]).toContain('main')
  })

  it('checkStaleAgainstRemote refuses when the remote cannot be resolved (offline)', () => {
    const result = checkStaleAgainstRemote('deadbeef', () => null)
    expect(result.length).toBe(1)
    expect(result[0]).toMatch(/could not be resolved/)
  })

  it('checkDirtyPinnedFiles passes cleanly on a clean tree', () => {
    expect(checkDirtyPinnedFiles(['pinned.md'], localDir)).toEqual([])
  })

  it('checkDirtyPinnedFiles refuses, naming the file, when a pinned file has an uncommitted edit — even though HEAD still equals the remote tip', () => {
    const headSha = git(localDir, ['rev-parse', 'HEAD'])
    expect(checkStaleAgainstRemote(headSha, () => resolveRemoteDefaultBranch(localDir))).toEqual([])

    writeFileSync(join(localDir, 'pinned.md'), 'uncommitted edit\n')

    const result = checkDirtyPinnedFiles(['pinned.md'], localDir)
    expect(result.length).toBe(1)
    expect(result[0]).toContain('pinned.md')
  })

  it('checkDirtyPinnedFiles never blocks on a dirty file it was not asked to pin (Traps to avoid: no unrelated dirty file blocks)', () => {
    writeFileSync(join(localDir, 'scratch.md'), 'an operator scratch file\n')
    expect(checkDirtyPinnedFiles(['pinned.md'], localDir)).toEqual([])
  })
})
