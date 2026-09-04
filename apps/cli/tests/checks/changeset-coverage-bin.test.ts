import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CheckError } from '../../src/checks/contract'

// Bin-level tests for check-changeset-coverage.ts's own I/O wiring — the
// pure predicate (changeset-coverage-logic.ts) has its own dedicated test
// file; this one exercises the git/fs glue the predicate can't see:
// resolveChangedFiles()'s null-vs-[] distinction (security review, PR #306
// MEDIUM — the pre-fix bin collapsed both into the same silent pass, the
// exact fail-open class PR #290 already documented as a real incident) and
// the release-branch exemption resolving from git alone, never a
// caller-supplied BRANCH env var (PR #306 LOW).

const BIN = join(import.meta.dir, '..', '..', 'src', 'checks', 'bin', 'check-changeset-coverage.ts')

let roots: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/** `realpathSync` — macOS's tmpdir is a symlink, and `git rev-parse --show-toplevel` resolves it. */
function newRoot(name: string): string {
  const raw = join(
    tmpdir(),
    `vinaya-changeset-coverage-bin-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
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

/** A minimal fixed-group workspace: one member (`@fixture/pkg-a`) shipping `src`. */
function scaffoldFixedGroup(root: string): void {
  mkdirSync(join(root, 'packages', 'pkg-a', 'src'), { recursive: true })
  mkdirSync(join(root, '.changeset'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture-root', workspaces: ['packages/*'] }))
  writeFileSync(
    join(root, 'packages', 'pkg-a', 'package.json'),
    JSON.stringify({ name: '@fixture/pkg-a', files: ['src'] })
  )
  writeFileSync(join(root, '.changeset', 'config.json'), JSON.stringify({ fixed: [['@fixture/pkg-a']] }))
}

async function runBin(
  cwd: string,
  env: Record<string, string | undefined> = {}
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const proc = Bun.spawn(['bun', BIN], { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } })
  const exitCode = await proc.exited
  const stderr = await new Response(proc.stderr).text()
  const stdout = await new Response(proc.stdout).text()
  return { exitCode, stderr, stdout }
}

function parseFindings(stderr: string): CheckError[] {
  return stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CheckError)
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

describe('check-changeset-coverage (bin) — indeterminate diff (PR #306 MEDIUM)', () => {
  it('a bare/single-commit fixture (no origin remote, main IS HEAD) reports a WARNING naming the ambiguity — never a silent pass', async () => {
    const root = newRoot('bare-single-commit')
    initRepo(root)
    writeFileSync(join(root, 'README.md'), '# fixture\n')
    git(root, ['add', 'README.md'])
    git(root, ['commit', '-q', '-m', 'Chore: initial commit'])

    const { exitCode, stderr } = await runBin(root)
    expect(exitCode).toBe(0) // still report-only — a warning, never a hard failure

    const findings = parseFindings(stderr)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.severity).toBe('warning')
    expect(findings[0]?.message).toContain('could not determine this diff')
  })

  it("a same-SHA branch with zero new commits is ALSO treated as indeterminate, not confirmed-empty — resolveChangedFiles()'s own documented, deliberate false-negative", async () => {
    const root = newRoot('same-sha-branch')
    initRepo(root)
    scaffoldFixedGroup(root)
    git(root, ['add', '.'])
    git(root, ['commit', '-q', '-m', 'Chore: initial scaffold'])
    git(root, ['checkout', '-q', '-b', 'feature/nothing-new'])

    const { exitCode, stderr } = await runBin(root)
    expect(exitCode).toBe(0)
    const findings = parseFindings(stderr)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('could not determine this diff')
  })

  it('a real, resolvable, GENUINELY empty diff (a distinct SHA via an empty commit) stays silent — that IS confirmed clean', async () => {
    const root = newRoot('genuinely-empty')
    initRepo(root)
    scaffoldFixedGroup(root)
    git(root, ['add', '.'])
    git(root, ['commit', '-q', '-m', 'Chore: initial scaffold'])
    git(root, ['checkout', '-q', '-b', 'feature/nothing-new'])
    git(root, ['commit', '-q', '--allow-empty', '-m', 'Chore: empty commit, distinct SHA'])

    const { exitCode, stderr } = await runBin(root)
    expect(exitCode).toBe(0)
    expect(parseFindings(stderr)).toHaveLength(0)
  })
})

describe('check-changeset-coverage (bin) — release-branch exemption is git-only (PR #306 LOW)', () => {
  it('exempts a shipped, changeset-less diff when the REAL current branch is changeset-release/main', async () => {
    const root = newRoot('real-release-branch')
    initRepo(root)
    scaffoldFixedGroup(root)
    git(root, ['add', '.'])
    git(root, ['commit', '-q', '-m', 'Chore: initial scaffold'])
    git(root, ['checkout', '-q', '-b', 'changeset-release/main'])
    writeFileSync(join(root, 'packages', 'pkg-a', 'src', 'index.ts'), 'export const a = 1\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-q', '-m', 'Chore: version bump'])

    const { exitCode, stderr } = await runBin(root)
    expect(exitCode).toBe(0)
    expect(parseFindings(stderr)).toHaveLength(0)
  })

  it('the SAME shipped, changeset-less diff on an ordinary branch name is a real finding', async () => {
    const root = newRoot('ordinary-branch')
    initRepo(root)
    scaffoldFixedGroup(root)
    git(root, ['add', '.'])
    git(root, ['commit', '-q', '-m', 'Chore: initial scaffold'])
    git(root, ['checkout', '-q', '-b', 'fix/some-change'])
    writeFileSync(join(root, 'packages', 'pkg-a', 'src', 'index.ts'), 'export const a = 1\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-q', '-m', 'Feat(pkg-a): add a'])

    const { exitCode, stderr } = await runBin(root)
    expect(exitCode).toBe(0) // report-only — still 0, but a real finding
    const findings = parseFindings(stderr)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.severity).toBe('warning')
    expect(findings[0]?.message).toContain('packages/pkg-a/src/index.ts')
  })

  it('a BRANCH env var claiming the release branch is NOT trusted — the real (non-release) git branch still fires the finding', async () => {
    const root = newRoot('branch-env-not-trusted')
    initRepo(root)
    scaffoldFixedGroup(root)
    git(root, ['add', '.'])
    git(root, ['commit', '-q', '-m', 'Chore: initial scaffold'])
    git(root, ['checkout', '-q', '-b', 'fix/some-change'])
    writeFileSync(join(root, 'packages', 'pkg-a', 'src', 'index.ts'), 'export const a = 1\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-q', '-m', 'Feat(pkg-a): add a'])

    const { exitCode, stderr } = await runBin(root, { BRANCH: 'changeset-release/main' })
    expect(exitCode).toBe(0)
    expect(parseFindings(stderr)).toHaveLength(1) // env spoof ignored — finding still fires
  })
})

/** Wires a real `origin` remote whose `refs/remotes/origin/HEAD` resolves to `defaultBranchName` — the same derivation `check-main-branch-refusal.ts`'s own `defaultBranch()` reads, so `root`'s current branch can genuinely equal it. */
function wireOriginDefaultBranch(root: string, defaultBranchName: string): void {
  const bare = newRoot('origin-bare')
  git(bare, ['init', '-q', '--bare', '-b', defaultBranchName])
  git(root, ['remote', 'add', 'origin', bare])
  git(root, ['push', '-q', 'origin', `${defaultBranchName}:${defaultBranchName}`])
  git(root, ['remote', 'set-head', 'origin', defaultBranchName])
}

describe('check-changeset-coverage (bin) — silent on the default branch itself (O3)', () => {
  it('current branch IS the resolved default branch — prints nothing and passes, even with no real diff to grade', async () => {
    const root = newRoot('on-default-branch')
    initRepo(root)
    scaffoldFixedGroup(root)
    git(root, ['add', '.'])
    git(root, ['commit', '-q', '-m', 'Chore: initial scaffold'])
    wireOriginDefaultBranch(root, 'main')

    const { exitCode, stdout, stderr } = await runBin(root)
    expect(exitCode).toBe(0)
    expect(stdout).toBe('')
    expect(parseFindings(stderr)).toHaveLength(0)
  })

  it('a feature branch off that same default branch is UNAFFECTED — the bare/single-commit ambiguity still warns', async () => {
    const root = newRoot('feature-branch-still-warns')
    initRepo(root)
    writeFileSync(join(root, 'README.md'), '# fixture\n')
    git(root, ['add', 'README.md'])
    git(root, ['commit', '-q', '-m', 'Chore: initial commit'])
    wireOriginDefaultBranch(root, 'main')
    git(root, ['checkout', '-q', '-b', 'feature/nothing-new'])

    const { exitCode, stderr } = await runBin(root)
    expect(exitCode).toBe(0)
    const findings = parseFindings(stderr)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('could not determine this diff')
  })
})
