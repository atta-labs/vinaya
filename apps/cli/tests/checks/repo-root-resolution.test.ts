import { describe, expect, it } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { coreCheckRegistry } from '../../src/checks/registry.js'
import { packageRoot } from '../../src/lib/package-root.js'

// vinaya-cli-v1 task 7, Correction 2 — regression coverage for all three root
// causes a live [principal] test-plan run found two layers deep in code this
// PR's own diff didn't originally touch: `demo break` (and therefore any real
// `npx vinaya check` an installed hook runs) failed once bundled, and leaked
// THIS repo's own forge/tranche facts into whatever repo actually invoked it.

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function initFixture(name: string): string {
  const root = join(tmpdir(), `vinaya-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
  git(root, ['init', '-q', '-b', 'main'])
  git(root, ['config', 'user.email', 'test@example.com'])
  git(root, ['config', 'user.name', 'Test'])
  writeFileSync(join(root, 'README.md'), '# fixture\n')
  git(root, ['add', 'README.md'])
  git(root, ['commit', '-q', '-m', 'Chore: initial commit'])
  return root
}

describe('RC1 — packageRoot() resolves regardless of the calling module’s depth', () => {
  let tmpRoot: string

  it('walks up to package.json from both a "source" depth and a "bundled" depth, landing on the SAME package root', () => {
    tmpRoot = join(tmpdir(), `vinaya-rc1-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const pkgRoot = join(tmpRoot, 'fake-pkg')
    // Mirrors this workspace's real shape: `src/checks/bin/*.ts` unbundled,
    // vs. a single-file `dist/index.js` once bundled — two genuinely
    // different depths from the same package root, exactly the case a fixed
    // `../..`/`../../../../../..` walk cannot handle for both at once.
    const sourceDepthDir = join(pkgRoot, 'src', 'checks', 'bin')
    const bundledDepthDir = join(pkgRoot, 'dist')
    mkdirSync(sourceDepthDir, { recursive: true })
    mkdirSync(bundledDepthDir, { recursive: true })
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'fake-pkg' }))
    writeFileSync(join(sourceDepthDir, 'check-example.ts'), '// fixture\n')
    writeFileSync(join(bundledDepthDir, 'index.js'), '// fixture\n')

    const fromSource = packageRoot(pathToFileURL(join(sourceDepthDir, 'check-example.ts')).href)
    const fromBundle = packageRoot(pathToFileURL(join(bundledDepthDir, 'index.js')).href)

    expect(fromSource).toBe(pkgRoot)
    expect(fromBundle).toBe(pkgRoot)
  })

  it('every real coreCheckRegistry() bin path resolves to a file that actually exists on disk', () => {
    for (const spec of coreCheckRegistry()) {
      expect(existsSync(spec.run), `${spec.name}'s run path does not exist: ${spec.run}`).toBe(true)
    }
  })
})

describe('RC3 — reader-resolvable-prose/retired-vocabulary are part of the adopter-facing registry (task 7, Issue #56)', () => {
  it('coreCheckRegistry() contains both prose-gate entries, alongside every other core registration', () => {
    const specs = coreCheckRegistry()
    expect(specs.map((s) => s.name).sort()).toEqual(
      [
        'body-bare-digits',
        'brief-shape',
        'branch-topology',
        'changeset-coverage',
        'closes-n',
        'coherence',
        'dead-branch-push',
        'dispatch-readiness',
        'doc-coverage',
        'doc-coverage-push',
        'doctrine-portability',
        'evidence-fresh',
        'first-push-dispatch',
        'issue-assignment',
        'main-branch-refusal',
        'no-disk-state',
        'quoted-command',
        'reader-resolvable-prose',
        'registry-gates',
        'retired-vocabulary',
        'review-gate',
        'single-plan-pr',
        'test-plan',
        'token-collection-wired',
        'workspace-escape'
      ].sort()
    )
  })

  it('`vinaya check --all` in a plain fixture repo (no aeg-root/, no configured reader-facing surface) passes clean — both checks run, exit 0, plain-text never leaks onto stderr', () => {
    const root = initFixture('rc3')
    try {
      const indexTs = join(import.meta.dir, '..', '..', 'src', 'index.ts')
      const result = spawnSync('bun', [indexTs, 'check', '--all', '--diff-only'], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, PR_BODY: undefined }
      })
      expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0)
      // Report-only, always exit 0 regardless of what they find — proof
      // they're registered and never block, not proof of what they swept.
      expect(result.stdout).toContain('reader-resolvable-prose: pass')
      expect(result.stdout).toContain('retired-vocabulary: pass')
      // Never a plain-text line on stderr — that channel is CheckError JSON
      // only; a stray human-readable line there would force `status: error`
      // regardless of exit code (the exact bug this rewrite fixed).
      expect(result.stderr).not.toContain('aeg-root/glossary.md')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("unconfigured doctrineRoot resolves via resolveDoctrineRoot() (the package's own copy), not a cwd-relative literal — task vinaya-adopter-portability-v1 2, Issue #232", () => {
    // The pre-232 default was the bare literal `'aeg-root'`, cwd-relative —
    // permanently empty for every `vinaya init` adopter, none of whom ever
    // gets a repo-relative `aeg-root/` (settled by experiment, see this
    // task's PR body). Spawning THIS repo's own dev source against an
    // unrelated fixture cwd proves the new default is package-identity
    // resolved, not cwd-resolved: it's expected, not a leak, that it lands
    // on this monorepo's own real `aeg-root/` here — an installed adopter
    // copy runs from inside its OWN `node_modules/@attalabs/vinaya`, where
    // the identical resolution lands on that adopter's own bundled copy
    // instead (proven separately by this task's real npm-install fixture,
    // not reproducible from dev source without a real package boundary).
    const root = initFixture('rc3-doctrine-root')
    try {
      const indexTs = join(import.meta.dir, '..', '..', 'src', 'index.ts')
      const result = spawnSync('bun', [indexTs, 'check', 'reader-resolvable-prose'], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, PR_BODY: undefined }
      })
      expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0)
      // Real doctrine content, swept from THIS repo's own aeg-root — proof
      // the sweep is no longer permanently vacuous by construction.
      expect(result.stderr).toContain('aeg-root/')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('RC2 — coherence/dispatch-readiness evaluate the CALLER’s repo, never this monorepo’s own', () => {
  it('dispatch-readiness resolves the FIXTURE’s own remote/branch identity, never this repo’s, when run with cwd set to a different repo', () => {
    const root = initFixture('rc2')
    try {
      git(root, ['remote', 'add', 'origin', 'https://github.com/fixture-owner-xyz/fixture-repo-xyz.git'])
      git(root, ['checkout', '-b', 'task/fixture-tranche-xyz/1'])

      const binPath = join(import.meta.dir, '..', '..', 'src', 'checks', 'bin', 'check-dispatch-readiness.ts')
      const result = spawnSync('bun', [binPath], { cwd: root, encoding: 'utf8', env: { ...process.env } })
      const combined = `${result.stdout}\n${result.stderr}`

      // Positive proof: the check resolved and acted on the FIXTURE's own
      // identity (its fake owner/repo and its own branch-derived tranche
      // slug), not a hardcoded/leaked one.
      expect(combined).toContain('fixture-owner-xyz')
      expect(combined).toContain('fixture-tranche-xyz')

      // Negative proof — the actual leak this regression closes: this
      // monorepo's own real forge identity (owner/repo) must never appear.
      // (Not asserting on the absence of "vinaya-cli-v1" — the fixture runs
      // via this repo's own real absolute file path, which legitimately
      // contains that string in a worktree-name segment; that's an artifact
      // of where this test happens to run from, not a leaked forge fact.)
      expect(combined).not.toContain('daniboomerang/attalabs')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)

  it('coherence resolves the FIXTURE’s own remote/branch identity, never this repo’s, when run with cwd set to a different repo', () => {
    const root = initFixture('rc2-coherence')
    try {
      git(root, ['remote', 'add', 'origin', 'https://github.com/fixture-owner-abc/fixture-repo-abc.git'])
      git(root, ['checkout', '-b', 'task/fixture-tranche-abc/1'])

      const binPath = join(import.meta.dir, '..', '..', 'src', 'checks', 'bin', 'check-coherence.ts')
      const result = spawnSync('bun', [binPath], { cwd: root, encoding: 'utf8', env: { ...process.env } })
      const combined = `${result.stdout}\n${result.stderr}`

      // Positive proof: the underlying `gh api` call it shells out to
      // targets the FIXTURE's own owner/repo (visible in the crash's own
      // command-failure message) — resolveRepo() read the fixture's git
      // remote, not this monorepo's.
      expect(combined).toContain('fixture-owner-abc/fixture-repo-abc')
      expect(combined).not.toContain('daniboomerang/attalabs')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)

  // Correction 3: the identical chdir(REPO_ROOT) leak, missed by Correction 2,
  // still live in check-doc-coverage.ts — this is the test that should have
  // existed there and would have caught it. Mirrors the coherence/
  // dispatch-readiness tests above exactly: a real fixture repo, a real
  // `.vinaya/doc-owners` binding that names only the FIXTURE's own file, and
  // a positive/negative assertion on whose diff and whose doc-owners state
  // the check actually evaluated.
  it('doc-coverage evaluates the FIXTURE’s own diff and doc-owners, never this monorepo’s own, when run with cwd set to a different repo', () => {
    const root = initFixture('rc2-doc-coverage')
    try {
      mkdirSync(join(root, '.vinaya'), { recursive: true })
      // A dangling in-repo pointer — FAILS deterministically regardless of
      // PR_BODY/waiver state, so the check's own findings are forced to name
      // whichever repo's diff/doc-owners it actually read.
      writeFileSync(join(root, '.vinaya', 'doc-owners'), 'fixture-marker.ts   .vinaya/nonexistent-fixture-doc.md\n')
      git(root, ['add', '.vinaya/doc-owners'])
      git(root, ['commit', '-q', '-m', 'Chore: add fixture doc-owners'])
      const baseSha = git(root, ['rev-parse', 'HEAD'])

      writeFileSync(join(root, 'fixture-marker.ts'), 'fixture content\n')
      git(root, ['add', 'fixture-marker.ts'])
      git(root, ['commit', '-q', '-m', 'Chore: add the bound fixture file'])

      const binPath = join(import.meta.dir, '..', '..', 'src', 'checks', 'bin', 'check-doc-coverage.ts')
      const result = spawnSync('bun', [binPath], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, BASE_SHA: baseSha, PR_BODY: undefined }
      })
      const combined = `${result.stdout}\n${result.stderr}`

      // Positive proof: the finding names the FIXTURE's own dangling pointer
      // — proof it parsed the fixture's own `.vinaya/doc-owners` content
      // (this repo's real doc-owners has no such binding) and that the
      // fixture's own bound file (matched via the fixture's own diff against
      // the fixture's own baseSha) actually fired the binding.
      expect(combined).toContain('nonexistent-fixture-doc.md')
      expect(result.status).toBe(1)

      // Negative proof — the actual leak: none of this monorepo's own real
      // bound files/docs (from this repo's OWN `.vinaya/doc-owners`) appear.
      expect(combined).not.toContain('daniboomerang/attalabs')
      expect(combined).not.toContain('packages/aeg-core')
      expect(combined).not.toContain('aeg-root/state-machine.md')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)
})
