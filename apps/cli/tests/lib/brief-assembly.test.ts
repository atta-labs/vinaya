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
  dispatchPremiseRefusals,
  DRAFT_ISSUE_SENTINEL,
  fastForwardToRemoteIfSafe,
  readFileAtRevision,
  repoBriefCommandFacts,
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
 * Issue #839, O1/O2/O3 — `fastForwardToRemoteIfSafe` on a real remote/local
 * repo pair, no network, no mocked `git`. A clean default-branch checkout that
 * is only behind is fast-forwarded to the remote tip; the three unsafe cases
 * (another branch, uncommitted tracked change, local commits the remote lacks)
 * and an unreachable remote each refuse, moving nothing. This is the fixture
 * the Test plan calls for: "a clean default-branch checkout two commits behind
 * its remote prepares after fast-forwarding, while the same checkout with a
 * local commit, an uncommitted tracked change, or on another branch is refused."
 */
describe('fastForwardToRemoteIfSafe (Issue #839)', () => {
  let tmpDir: string
  let remoteDir: string
  let localDir: string

  // Advances the remote's default branch by one commit past the local clone,
  // returning the new remote tip sha — so the local checkout is strictly behind.
  const advanceRemote = (content: string): string => {
    writeFileSync(join(remoteDir, 'pinned.md'), content)
    git(remoteDir, ['add', 'pinned.md'])
    git(remoteDir, ['commit', '-q', '-m', `advance ${content.trim()}`])
    return git(remoteDir, ['rev-parse', 'HEAD'])
  }

  const resolve = () => resolveRemoteDefaultBranch(localDir)

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'vinaya-brief-ff-'))
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

  it('fast-forwards a clean default-branch checkout that is two commits behind, and moves HEAD to the remote tip (O1)', () => {
    advanceRemote('v2\n')
    const newTip = advanceRemote('v3\n')
    const before = git(localDir, ['rev-parse', 'HEAD'])
    expect(before).not.toBe(newTip)

    const result = fastForwardToRemoteIfSafe(localDir, resolve)

    expect(result).toEqual({ kind: 'moved', from: before, to: newTip })
    // The checkout actually advanced — a real fast-forward, not just a report.
    expect(git(localDir, ['rev-parse', 'HEAD'])).toBe(newTip)
  })

  it('is a no-op when the checkout already equals the remote tip, moving nothing', () => {
    const tip = git(localDir, ['rev-parse', 'HEAD'])
    const result = fastForwardToRemoteIfSafe(localDir, resolve)
    expect(result).toEqual({ kind: 'noop' })
    expect(git(localDir, ['rev-parse', 'HEAD'])).toBe(tip)
  })

  it('refuses, naming the branch and `git switch`, when on another branch — and never moves (O2)', () => {
    advanceRemote('v2\n')
    git(localDir, ['switch', '-c', 'feature'])
    const before = git(localDir, ['rev-parse', 'HEAD'])

    const result = fastForwardToRemoteIfSafe(localDir, resolve)

    expect(result.kind).toBe('refused')
    if (result.kind === 'refused') {
      expect(result.reason).toContain('feature')
      expect(result.reason).toContain('not the remote default branch `main`')
      expect(result.reason).toContain('git switch main')
    }
    expect(git(localDir, ['rev-parse', 'HEAD'])).toBe(before)
  })

  it('refuses, naming the tracked file and `git stash`, on an uncommitted tracked change — and never moves (O2)', () => {
    advanceRemote('v2\n')
    const before = git(localDir, ['rev-parse', 'HEAD'])
    writeFileSync(join(localDir, 'pinned.md'), 'uncommitted local edit\n')

    const result = fastForwardToRemoteIfSafe(localDir, resolve)

    expect(result.kind).toBe('refused')
    if (result.kind === 'refused') {
      expect(result.reason).toContain('uncommitted changes to tracked file(s)')
      expect(result.reason).toContain('pinned.md')
      expect(result.reason).toContain('git stash')
    }
    expect(git(localDir, ['rev-parse', 'HEAD'])).toBe(before)
  })

  it('refuses, naming the local commits and `git push`, when the checkout is ahead — and never moves (O2)', () => {
    // Local commits the remote does not have, with the remote NOT advanced:
    // ahead of the remote tip, so a fast-forward would have to discard them.
    writeFileSync(join(localDir, 'local-only.md'), 'a local commit\n')
    git(localDir, ['add', 'local-only.md'])
    git(localDir, ['commit', '-q', '-m', 'local only'])
    const before = git(localDir, ['rev-parse', 'HEAD'])

    const result = fastForwardToRemoteIfSafe(localDir, resolve)

    expect(result.kind).toBe('refused')
    if (result.kind === 'refused') {
      expect(result.reason).toContain('local commit(s) the remote default branch `main` does not have')
      expect(result.reason).toContain('git push')
    }
    expect(git(localDir, ['rev-parse', 'HEAD'])).toBe(before)
  })

  it('fast-forwards past an untracked file, which never blocks (Traps to avoid)', () => {
    const newTip = advanceRemote('v2\n')
    writeFileSync(join(localDir, 'scratch.md'), 'an operator scratch file\n')

    const result = fastForwardToRemoteIfSafe(localDir, resolve)

    expect(result.kind).toBe('moved')
    expect(git(localDir, ['rev-parse', 'HEAD'])).toBe(newTip)
  })

  it('refuses when the remote cannot be reached, moving nothing (O3)', () => {
    advanceRemote('v2\n')
    const before = git(localDir, ['rev-parse', 'HEAD'])
    const result = fastForwardToRemoteIfSafe(localDir, () => null)
    expect(result.kind).toBe('refused')
    if (result.kind === 'refused') expect(result.reason).toMatch(/could not be resolved/)
    expect(git(localDir, ['rev-parse', 'HEAD'])).toBe(before)
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
    mkdirSync(join(remoteDir, 'src'), { recursive: true })
    writeFileSync(join(remoteDir, 'src', 'fixture.ts'), 'export const fixture = true\n')
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

  it('keeps the local issue-validation probe dormant when the adopter has no aeg-root directory', () => {
    rmSync(join(localDir, 'aeg-root'), { recursive: true, force: true })
    expect(canRenderBriefFromHere()).toBe(false)
  })

  it('canRenderBriefFromHere is false with no resolvable repo, even with the template present', () => {
    delete process.env.AEG_REPO
    expect(canRenderBriefFromHere()).toBe(false)
  })

  const RATIONALE = [
    "## Task Issue — Planner's rationale",
    '',
    // issue-657, O3 — the render now refuses when the Surface resolves to a
    // tracked file but the Boundary names none of them; this shared
    // fixture's own `## Surface` `in: aeg-root` resolves to real tracked
    // files, so the Boundary must name one.
    "**Boundary** — In: `src/fixture.ts`, the fixture's own committed source file. Out: nothing.",
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
    rmSync(join(localDir, 'aeg-root'), { recursive: true, force: true })
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
      'in: src',
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
      expect(r.ok, JSON.stringify(r)).toBe(true)
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

/**
 * Issue #807 — a brief's commands are written the way the repository it is
 * rendered for reaches the CLI, so an adopter never receives one naming a path
 * only this repository has.
 */
describe('repoBriefCommandFacts', () => {
  it('this repository vendors the CLI: the source entry, plus the unabridged gate derivations it ships', () => {
    const facts = repoBriefCommandFacts(REPO_ROOT)
    expect(facts.cliInvocation).toBe('bun apps/cli/src/index.ts')
    expect(facts.localGateCommands).toEqual({
      dispatchReadiness: 'bun packages/aeg-core/bin/verify-dispatch.ts',
      docCoverage: 'bun packages/aeg-core/bin/verify-docs.ts'
    })
  })

  it('a repository is not credited with a derivation it merely has a file at the path of (round 2, security F4)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brief-cli-lookalike-'))
    try {
      // Vendors the CLI, so the invocation is the vendored one — but its
      // `packages/aeg-core` declares someone else's name, so the bin files it
      // carries are not this package's own derivations and are never named to
      // a Developer as commands to run.
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'lookalike', workspaces: ['apps/*', 'packages/*'] })
      )
      mkdirSync(join(dir, 'apps', 'cli', 'src'), { recursive: true })
      writeFileSync(join(dir, 'apps', 'cli', 'package.json'), JSON.stringify({ name: '@attalabs/vinaya' }))
      // A real entry, so this case isolates the package-name identity check
      // rather than also tripping the entry-existence one below.
      writeFileSync(join(dir, 'apps', 'cli', 'src', 'index.ts'), '')
      mkdirSync(join(dir, 'packages', 'aeg-core', 'bin'), { recursive: true })
      writeFileSync(join(dir, 'packages', 'aeg-core', 'package.json'), JSON.stringify({ name: 'not-aeg-core' }))
      writeFileSync(join(dir, 'packages', 'aeg-core', 'bin', 'verify-dispatch.ts'), '')
      writeFileSync(join(dir, 'packages', 'aeg-core', 'bin', 'verify-docs.ts'), '')

      const facts = repoBriefCommandFacts(dir)
      expect(facts.cliInvocation).toBe('bun apps/cli/src/index.ts')
      expect(facts.localGateCommands).toEqual({ dispatchReadiness: null, docCoverage: null })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a vendored member with no src/index.ts falls back to the registry form rather than naming a missing file (round 3, security F2)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brief-cli-layout-'))
    try {
      // `detectVendoredVinaya` matches on the member's package NAME, which says
      // nothing about where its sources live. Without the entry check, every
      // command in this repository's brief named a file that is not there.
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'odd-layout', workspaces: ['tools/*'] }))
      mkdirSync(join(dir, 'tools', 'vinaya'), { recursive: true })
      writeFileSync(
        join(dir, 'tools', 'vinaya', 'package.json'),
        JSON.stringify({ name: '@attalabs/vinaya', bin: 'lib/main.js' })
      )

      const facts = repoBriefCommandFacts(dir)
      expect(facts.cliInvocation).toMatch(/^npx --yes @attalabs\/vinaya@\d+\.\d+\.\d+$/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a repository that installs from the registry: the pinned npx form, and no local derivation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brief-cli-adopter-'))
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'adopter' }))
      const facts = repoBriefCommandFacts(dir)
      expect(facts.cliInvocation).toMatch(/^npx --yes @attalabs\/vinaya@\d+\.\d+\.\d+$/)
      expect(facts.localGateCommands).toEqual({ dispatchReadiness: null, docCoverage: null })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * Every premise on the Issue, prefixed or not, is
 * re-asserted against the default branch before a brief renders, and a failing
 * one refuses the dispatch naming it. `readFileAtRevision` is exercised against
 * a real fixture repository, so the "reads the commit, not the working tree"
 * property is proved rather than asserted.
 */
describe('dispatchPremiseRefusals', () => {
  let tmpDir: string
  let repoDir: string

  const bodyWithPremises = (premises: string): string =>
    ['**Boundary** — a task.', '', '## Premises', '', premises, ''].join('\n')

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'vinaya-brief-premise-'))
    repoDir = join(tmpDir, 'repo')
    mkdirSync(repoDir, { recursive: true })
    git(repoDir, ['init', '-q', '-b', 'main'])
    git(repoDir, ['config', 'user.email', 'a@example.com'])
    git(repoDir, ['config', 'user.name', 'A'])
    writeFileSync(join(repoDir, 'cancel.ts'), 'export const signal = new AbortController()\n')
    git(repoDir, ['add', 'cancel.ts'])
    git(repoDir, ['commit', '-q', '-m', 'first'])
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  const readAt = (rev: string, path: string): string | null => readFileAtRevision(rev, path, repoDir)

  it('passes an Issue with no `## Premises` section — nothing to assert', () => {
    expect(dispatchPremiseRefusals('**Boundary** — a task.\n', 'HEAD', 'all', readAt)).toEqual([])
  })

  it('passes a premise the default branch holds', () => {
    const refusals = dispatchPremiseRefusals(
      bodyWithPremises('`cancel.ts` contains `AbortController`'),
      'HEAD',
      'all',
      readAt
    )
    expect(refusals).toEqual([])
  })

  it('refuses, naming the premise, when the default branch does not hold it', () => {
    const refusals = dispatchPremiseRefusals(
      bodyWithPremises('`cancel.ts` contains `drainOutbox`'),
      'HEAD',
      'all',
      readAt
    )
    expect(refusals.length).toBe(1)
    expect(refusals[0]).toContain('premise 1 binds `cancel.ts contains:drainOutbox`')
  })

  it('checks a deferred `after #<n>:` premise too — dispatch is the first moment it can be asserted at all', () => {
    const refusals = dispatchPremiseRefusals(
      bodyWithPremises('after #841: `cancel.ts` contains `drainOutbox`'),
      'HEAD',
      'all',
      readAt
    )
    expect(refusals.length).toBe(1)
    expect(refusals[0]).toContain('premise 1 binds')
  })

  it('accepts the same deferred premise once the text lands on the branch', () => {
    writeFileSync(
      join(repoDir, 'cancel.ts'),
      'export const signal = new AbortController()\nexport function drainOutbox() {}\n'
    )
    git(repoDir, ['add', 'cancel.ts'])
    git(repoDir, ['commit', '-q', '-m', 'second'])
    const refusals = dispatchPremiseRefusals(
      bodyWithPremises('after #841: `cancel.ts` contains `drainOutbox`'),
      'HEAD',
      'all',
      readAt
    )
    expect(refusals).toEqual([])
  })

  it('reads the commit, never the working tree — an uncommitted edit neither satisfies a premise nor breaks one', () => {
    writeFileSync(join(repoDir, 'cancel.ts'), 'export function drainOutbox() {}\n')
    expect(
      dispatchPremiseRefusals(bodyWithPremises('`cancel.ts` contains `drainOutbox`'), 'HEAD', 'all', readAt).length
    ).toBe(1)
    expect(
      dispatchPremiseRefusals(bodyWithPremises('`cancel.ts` contains `AbortController`'), 'HEAD', 'all', readAt)
    ).toEqual([])
  })

  it('refuses a premise naming a path the revision does not carry', () => {
    const refusals = dispatchPremiseRefusals(bodyWithPremises('`gone.ts` contains `x`'), 'HEAD', 'all', readAt)
    expect(refusals.length).toBe(1)
    expect(refusals[0]).toContain('could not be read')
  })

  it('reports a malformed `## Premises` section rather than rendering from it', () => {
    const refusals = dispatchPremiseRefusals(bodyWithPremises('the signal is already wired.'), 'HEAD', 'all', readAt)
    expect(refusals.length).toBe(1)
    expect(refusals[0]).toMatch(/^Premises: /)
    expect(refusals[0]).toContain('is not a premise')
  })

  it("leaves a deferred premise unasserted under `'due-now'` — a plan-time render must not refuse what has not merged yet", () => {
    const body = bodyWithPremises('after #841: `cancel.ts` contains `drainOutbox`')
    expect(dispatchPremiseRefusals(body, 'HEAD', 'all', readAt).length).toBe(1)
    expect(dispatchPremiseRefusals(body, 'HEAD', 'due-now', readAt)).toEqual([])
  })

  it("still asserts an unprefixed premise under `'due-now'` — it claims something true now, whoever is asking", () => {
    const body = bodyWithPremises('`cancel.ts` contains `drainOutbox`')
    expect(dispatchPremiseRefusals(body, 'HEAD', 'due-now', readAt).length).toBe(1)
  })

  it("reports a malformed section under `'due-now'` too — grammar is not deferrable", () => {
    const refusals = dispatchPremiseRefusals(bodyWithPremises('not a premise'), 'HEAD', 'due-now', readAt)
    expect(refusals.length).toBe(1)
    expect(refusals[0]).toContain('is not a premise')
  })

  it('asserts every premise when no scope is given — a dispatch is the default caller', () => {
    const body = bodyWithPremises('after #841: `cancel.ts` contains `drainOutbox`')
    expect(dispatchPremiseRefusals(body, 'HEAD', undefined, readAt).length).toBe(1)
  })

  it('readFileAtRevision returns the revision’s bytes untrimmed, and null for an absent path', () => {
    expect(readFileAtRevision('HEAD', 'cancel.ts', repoDir)).toBe('export const signal = new AbortController()\n')
    expect(readFileAtRevision('HEAD', 'gone.ts', repoDir)).toBeNull()
  })
})
