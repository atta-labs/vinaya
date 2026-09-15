import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assembleAndRenderBriefForIssue,
  canRenderBriefFromHere,
  checkDirtyPinnedFiles,
  checkStaleAgainstRemote,
  DRAFT_ISSUE_SENTINEL,
  resolveBoundaryPaths,
  resolveRemoteDefaultBranch,
  resolveTrancheTaskId,
  taskNotFoundMessage
} from '../../src/lib/brief-assembly.js'

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const REPO_ROOT = join(CLI_ROOT, '..', '..')

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

/**
 * `assembleAndRenderBriefForIssue`'s pre-write `override`
 * escape hatch and `canRenderBriefFromHere`'s infra-readiness gate. Reuses
 * this file's own real-fixture-repo pattern (no mocked git) rather than a
 * live network call — `assembleAndRenderBriefForIssue` shells out to real
 * `git`, so a fixture repo with a local `origin` remote is the same
 * network-free discipline `checkStaleAgainstRemote`'s own tests above already
 * use. `AEG_REPO` substitutes for a real GitHub remote (this fixture's origin
 * is a local file path, which `resolveRepo`'s GitHub-URL patterns don't
 * match) — the same env-var escape hatch production code already reads.
 */
describe('assembleAndRenderBriefForIssue — pre-write override', () => {
  let tmpDir: string
  let remoteDir: string
  let localDir: string
  let originalCwd: string
  let originalAegRepo: string | undefined

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'vinaya-brief-override-'))
    remoteDir = join(tmpDir, 'remote')
    localDir = join(tmpDir, 'local')
    mkdirSync(remoteDir, { recursive: true })
    git(remoteDir, ['init', '-q', '-b', 'main'])
    git(remoteDir, ['config', 'user.email', 'a@example.com'])
    git(remoteDir, ['config', 'user.name', 'A'])
    mkdirSync(join(remoteDir, 'aeg-root', 'templates'), { recursive: true })
    cpSync(
      join(REPO_ROOT, 'aeg-root', 'templates', 'brief-template.md'),
      join(remoteDir, 'aeg-root', 'templates', 'brief-template.md')
    )
    git(remoteDir, ['add', '.'])
    git(remoteDir, ['commit', '-q', '-m', 'seed'])
    git(tmpDir, ['clone', '-q', remoteDir, localDir])
    git(localDir, ['config', 'user.email', 'a@example.com'])
    git(localDir, ['config', 'user.name', 'A'])

    originalCwd = process.cwd()
    originalAegRepo = process.env.AEG_REPO
    process.chdir(localDir)
    process.env.AEG_REPO = 'test-owner/test-repo'
  })

  afterEach(() => {
    process.chdir(originalCwd)
    if (originalAegRepo === undefined) delete process.env.AEG_REPO
    else process.env.AEG_REPO = originalAegRepo
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('canRenderBriefFromHere is true once the template exists and the repo resolves', () => {
    expect(canRenderBriefFromHere()).toBe(true)
  })

  it('canRenderBriefFromHere is false with no resolvable repo, even with the template present', () => {
    delete process.env.AEG_REPO
    expect(canRenderBriefFromHere()).toBe(false)
  })

  const RATIONALE = [
    "## Task Issue — Planner's rationale",
    '',
    '**Boundary** — In: nothing real. Out: nothing.',
    '',
    '**Sizing** — n/a, test fixture.',
    '',
    '**Project(s) + blast radius** — `Project: cli`. No shared-primitive fan-out.',
    '',
    '**Dependency rationale** — `Depends-on: —`; `Conflicts-with: —`.',
    '',
    '**Traps to avoid** — n/a.',
    '',
    '**Suggested agent-class** — fast — test fixture.',
    '',
    '**Stop-and-escalate** — n/a.',
    '',
    '**Docs to keep coherent** — no-doc-surface.'
  ].join('\n')

  it('renders from the SUPPLIED override body, never fetching the (nonexistent) live Issue', () => {
    const body = [
      '**Project:** cli',
      '',
      '## Objectives',
      '',
      'O1. The fixture renders without a live forge fetch.',
      '',
      '## Documentation',
      '',
      'None.',
      '',
      '## Surface',
      '',
      'in: aeg-root',
      'out: —',
      '',
      '## Parts',
      '',
      'Part 1 (O1) — proves the override path never calls `gh`.',
      '',
      '## Test plan',
      '',
      'Test Plan: unit-tests-only',
      '',
      '## Stop conditions',
      '',
      '- None.',
      '',
      RATIONALE
    ].join('\n')

    const result = assembleAndRenderBriefForIssue(DRAFT_ISSUE_SENTINEL, {
      title: '[fixture] draft issue',
      body,
      labels: []
    })
    return result.then((r) => {
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.brief).toContain('O1. The fixture renders without a live forge fetch.')
        expect(r.brief).toContain('Part 1 (O1)')
      }
    })
  })

  it('refuses, naming the missing section, when the override body has no `## Test plan`', () => {
    const body = [
      '## Objectives',
      '',
      'O1. The fixture is missing its Test plan section.',
      '',
      '## Surface',
      '',
      'in: aeg-root',
      'out: —',
      '',
      '## Parts',
      '',
      'Part 1 (O1) — proves a missing section refuses the render.',
      '',
      '## Stop conditions',
      '',
      '- None.',
      '',
      RATIONALE
    ].join('\n')

    const result = assembleAndRenderBriefForIssue(DRAFT_ISSUE_SENTINEL, {
      title: '[fixture] draft issue',
      body,
      labels: []
    })
    return result.then((r) => {
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.missing.some((m) => /Test plan/i.test(m))).toBe(true)
      }
    })
  })

  it('refuses, naming the offending line, when the override body’s Test plan runs a whole-suite command', () => {
    const body = [
      '## Objectives',
      '',
      'O1. The fixture names a whole-suite Test plan line.',
      '',
      '## Surface',
      '',
      'in: aeg-root',
      'out: —',
      '',
      '## Parts',
      '',
      'Part 1 (O1) — proves a whole-suite Test plan line refuses the render.',
      '',
      '## Test plan',
      '',
      '```',
      'bun test apps/cli/tests',
      '```',
      '',
      '## Stop conditions',
      '',
      '- None.',
      '',
      RATIONALE
    ].join('\n')

    const result = assembleAndRenderBriefForIssue(DRAFT_ISSUE_SENTINEL, {
      title: '[fixture] draft issue',
      body,
      labels: []
    })
    return result.then((r) => {
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.missing.some((m) => m.includes('bun test apps/cli/tests'))).toBe(true)
      }
    })
  })

  it('refuses (never rendering) when the override body carries a `vinaya/tranche:*` label — that shape belongs to the tranche path', () => {
    const result = assembleAndRenderBriefForIssue(DRAFT_ISSUE_SENTINEL, {
      title: '[fixture] draft issue',
      body: '## Objectives\n\nO1. Anything.\n',
      labels: ['vinaya/tranche:demo']
    })
    return result.then((r) => {
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.missing[0]).toMatch(/vinaya\/tranche:\*/)
      }
    })
  })
})

/**
 * A tranche-labeled EDIT is not circular the way a tranche-labeled CREATE
 * is: the task already exists in its tranche's forge-derived task list, with
 * a real Issue number to look up. `resolveTrancheTaskId` is the lookup that
 * lets `forge-write.ts` route such an edit through `assembleAndRenderBrief`
 * instead of leaving the whole-brief render dormant.
 *
 * The lookup itself (`createForgeSource(...).getTranche(slug)`) goes through
 * `@attalabs/aeg-forge-state`'s `gh` module, whose `execFileSync('gh', ...)`
 * calls run against a `PATH` snapshotted into a module-level constant at
 * import time — a PATH-boundary fake bin placed after that snapshot is
 * silently ignored, so only the local, network-free guard (no resolvable
 * repo at all) is unit-testable here; the same live-network gap
 * `apps/cli/tests/commands/brief-render.test.ts` documents for
 * `assembleAndRenderBrief`'s own forge reads.
 */
describe('resolveTrancheTaskId', () => {
  it('returns null when the repo cannot be resolved at all', () => {
    const originalAegRepo = process.env.AEG_REPO
    delete process.env.AEG_REPO
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-no-repo-'))
    const originalCwd = process.cwd()
    process.chdir(dir)
    return resolveTrancheTaskId('fixture-tranche', 501)
      .then((id) => {
        expect(id).toBeNull()
      })
      .finally(() => {
        process.chdir(originalCwd)
        rmSync(dir, { recursive: true, force: true })
        if (originalAegRepo === undefined) delete process.env.AEG_REPO
        else process.env.AEG_REPO = originalAegRepo
      })
  })
})
