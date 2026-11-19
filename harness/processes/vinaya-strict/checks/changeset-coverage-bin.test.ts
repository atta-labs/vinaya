import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CheckError } from '../../../kernel/gates/checks/contract'

// Bin-level tests for check-changeset-coverage.ts's own I/O wiring — the
// pure predicate (changeset-coverage-logic.ts) has its own dedicated test
// file; this one exercises the git/fs glue the predicate can't see:
// resolveChangedFiles()'s null-vs-[] distinction (security review, PR #306
// MEDIUM — the pre-fix bin collapsed both into the same silent pass, the
// exact fail-open class PR #290 already documented as a real incident) and
// the release-branch exemption resolving from git alone, never a
// caller-supplied BRANCH env var (PR #306 LOW).

const BIN = join(import.meta.dir, 'bin', 'check-changeset-coverage.ts')

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

describe('check-changeset-coverage (bin) — ignored packages', () => {
  it.each(['ignored in index', 'ignored only in worktree', 'symlink'])(
    'reads regular snapshot blobs and reports both rules for %s',
    async (scenario) => {
      const root = newRoot('changeset-snapshot')
      initRepo(root)
      scaffoldFixedGroup(root)
      writeFileSync(
        join(root, '.changeset', 'config.json'),
        JSON.stringify({ fixed: [['@fixture/pkg-a']], ignore: ['@fixture/portal'] })
      )
      git(root, ['add', '.'])
      git(root, ['commit', '-qm', 'Chore: initial scaffold'])
      git(root, ['checkout', '-qb', 'fix/pkg-a'])
      writeFileSync(join(root, 'packages', 'pkg-a', 'src', 'index.ts'), 'export {}\n')
      git(root, ['add', '.'])
      git(root, ['commit', '-qm', 'Fix(pkg-a): update fixture'])

      const changeset = join(root, '.changeset', 'portal.md')
      const ignored = "---\n'@fixture/portal': patch\n---\n"
      const empty = '---\n---\n'
      if (scenario === 'symlink') {
        const target = join(newRoot('changeset-target'), 'outside.md')
        writeFileSync(target, ignored)
        symlinkSync(target, changeset)
      } else {
        writeFileSync(changeset, scenario === 'ignored in index' ? ignored : empty)
      }
      git(root, ['add', '.'])
      if (scenario !== 'symlink') writeFileSync(changeset, scenario === 'ignored in index' ? empty : ignored)
      const { exitCode, stderr } = await runBin(root, {
        VINAYA_COMMIT_HOOK: '1',
        GIT_INDEX_FILE: join(root, '.git', 'index')
      })
      const findings = parseFindings(stderr)
      if (scenario === 'ignored in index') {
        expect(exitCode).toBe(1)
        expect(findings.map(({ severity }) => severity)).toEqual(['error', 'error'])
        expect(findings[0]?.message).toContain('packages/pkg-a/src/index.ts')
        expect(findings[1]?.message).toContain('@fixture/portal')
      } else {
        expect(exitCode).toBe(0)
        expect(findings).toEqual([])
      }
    }
  )

  it.each(['add', 'edit', 'delete', 'release branch', 'no ignore list', 'no config', 'quoted path', 'line break'])(
    'grades the changed changeset for %s',
    async (scenario) => {
      const root = newRoot('ignored-package')
      initRepo(root)
      scaffoldFixedGroup(root)
      const config = join(root, '.changeset', 'config.json')
      if (scenario === 'no config') rmSync(config)
      else if (scenario !== 'no ignore list') {
        writeFileSync(config, JSON.stringify({ ignore: ['@fixture/portal', '@other/*'] }))
      }
      git(root, ['config', 'core.quotePath', 'true'])
      const filename =
        scenario === 'quoted path' ? 'café.md' : scenario === 'line break' ? 'portal\nupdate.md' : 'portal.md'
      const changeset = join(root, '.changeset', filename)
      const ignored = "---\n'@fixture/portal': patch\n'@other/tool': minor\n---\n"
      if (scenario === 'delete') writeFileSync(changeset, ignored)
      if (scenario === 'edit') writeFileSync(changeset, '---\n---\n')
      git(root, ['add', '.'])
      git(root, ['commit', '-qm', 'Chore: initial scaffold'])
      git(root, ['checkout', '-qb', scenario === 'release branch' ? 'changeset-release/main' : 'fix/portal'])
      mkdirSync(join(root, 'apps', 'portal'), { recursive: true })
      writeFileSync(join(root, 'apps', 'portal', 'index.ts'), 'export {}\n')
      if (scenario === 'delete') rmSync(changeset)
      else writeFileSync(changeset, ignored)
      git(root, ['add', '.'])
      git(root, ['commit', '-qm', 'Fix(portal): update fixture'])

      const { exitCode, stderr } = await runBin(root)
      const refused =
        scenario === 'add' || scenario === 'edit' || scenario === 'quoted path' || scenario === 'line break'
      expect(exitCode).toBe(refused ? 1 : 0)
      const findings = parseFindings(stderr)
      expect(findings).toHaveLength(refused ? 1 : 0)
      if (refused) {
        expect(findings[0]?.severity).toBe('error')
        expect(findings[0]?.message).toContain(`.changeset/${filename}`)
        expect(findings[0]?.message).toContain('@fixture/portal')
        expect(findings[0]?.message).toContain('@other/tool')
      }
    }
  )

  it('skips a deleted changeset restored byte-for-byte in the index', async () => {
    const root = newRoot('restored-changeset')
    initRepo(root)
    scaffoldFixedGroup(root)
    writeFileSync(join(root, '.changeset', 'config.json'), JSON.stringify({ ignore: ['@fixture/portal'] }))
    const changeset = join(root, '.changeset', 'portal.md')
    const ignored = "---\n'@fixture/portal': patch\n---\n"
    writeFileSync(changeset, ignored)
    git(root, ['add', '.'])
    git(root, ['commit', '-qm', 'Chore: initial scaffold'])
    git(root, ['checkout', '-qb', 'fix/portal'])
    git(root, ['rm', '.changeset/portal.md'])
    git(root, ['commit', '-qm', 'Fix(portal): remove changeset'])
    writeFileSync(changeset, ignored)
    writeFileSync(join(root, 'README.md'), '# Other staged change\n')
    git(root, ['add', '.'])

    const { exitCode, stderr } = await runBin(root, {
      VINAYA_COMMIT_HOOK: '1',
      GIT_INDEX_FILE: join(root, '.git', 'index')
    })
    expect(exitCode).toBe(0)
    expect(parseFindings(stderr)).toEqual([])
  })

  it.each([true, false])('reads the ignore list from the index when indexed config is %s', async (hasConfig) => {
    const root = newRoot('changeset-config-snapshot')
    initRepo(root)
    scaffoldFixedGroup(root)
    const config = join(root, '.changeset', 'config.json')
    rmSync(config)
    git(root, ['add', '.'])
    git(root, ['commit', '-qm', 'Chore: initial scaffold'])
    git(root, ['checkout', '-qb', 'fix/portal'])
    git(root, ['commit', '--allow-empty', '-qm', 'Chore: start branch'])
    const policy = JSON.stringify({ ignore: ['@fixture/portal'] })
    if (hasConfig) writeFileSync(config, policy)
    writeFileSync(join(root, '.changeset', 'portal.md'), "---\n'@fixture/portal': patch\n---\n")
    git(root, ['add', '.'])
    if (hasConfig) writeFileSync(config, '{}')
    else writeFileSync(config, policy)

    const { exitCode, stderr } = await runBin(root, {
      VINAYA_COMMIT_HOOK: '1',
      GIT_INDEX_FILE: join(root, '.git', 'index')
    })
    expect(exitCode).toBe(hasConfig ? 1 : 0)
    const findings = parseFindings(stderr)
    expect(findings).toHaveLength(hasConfig ? 1 : 0)
    if (hasConfig) expect(findings[0]?.message).toContain('@fixture/portal')
  })
})

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
    expect(exitCode).toBe(1) // blocking
    const findings = parseFindings(stderr)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.severity).toBe('error')
    expect(findings[0]?.message).toContain('packages/pkg-a/src/index.ts')
    expect(findings[0]?.message).toContain('add an empty one')
    expect(findings[0]?.agent_recovery_prompt).toContain('changeset add --empty')
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
    expect(exitCode).toBe(1)
    expect(parseFindings(stderr)).toHaveLength(1) // env spoof ignored — finding still fires
  })
})

describe('check-changeset-coverage (bin) — empty changeset waiver', () => {
  it('a shipped diff carrying an empty changeset passes', async () => {
    const root = newRoot('empty-changeset')
    initRepo(root)
    scaffoldFixedGroup(root)
    git(root, ['add', '.'])
    git(root, ['commit', '-q', '-m', 'Chore: initial scaffold'])
    git(root, ['checkout', '-q', '-b', 'fix/some-change'])
    writeFileSync(join(root, 'packages', 'pkg-a', 'src', 'index.ts'), 'export const a = 1\n')
    writeFileSync(join(root, '.changeset', 'quiet-owls-sleep.md'), '---\n---\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-q', '-m', 'Feat(pkg-a): add a'])

    const { exitCode, stderr } = await runBin(root)
    expect(exitCode).toBe(0)
    expect(parseFindings(stderr)).toHaveLength(0)
  })

  it('accepts a staged repair changeset after the shipped change was already committed', async () => {
    const root = newRoot('staged-repair-changeset')
    initRepo(root)
    scaffoldFixedGroup(root)
    git(root, ['add', '.'])
    git(root, ['commit', '-q', '-m', 'Chore: initial scaffold'])
    git(root, ['checkout', '-q', '-b', 'fix/some-change'])
    writeFileSync(join(root, 'packages', 'pkg-a', 'src', 'index.ts'), 'export const a = 1\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-q', '-m', 'Fix(pkg-a): add a'])

    writeFileSync(join(root, '.changeset', 'repair.md'), '---\n---\n')
    git(root, ['add', '.changeset/repair.md'])
    const { exitCode, stderr } = await runBin(root, {
      VINAYA_COMMIT_HOOK: '1',
      GIT_INDEX_FILE: join(root, '.git', 'index')
    })

    expect(exitCode).toBe(0)
    expect(parseFindings(stderr)).toHaveLength(0)
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
