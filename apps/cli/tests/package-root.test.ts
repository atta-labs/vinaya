import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { copyFileSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { packageRoot } from '../src/lib/package-root'
import { resolveAuthorRepoSourceEntry } from '../src/lib/self-host'
import { spawnSyncBudgeted, stripVinayaEnv } from './lib/process-fixture'

describe('packageRoot', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = join(tmpdir(), `vinaya-package-root-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tmpDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('resolves the nearest package.json above the calling module', () => {
    const pkgRoot = join(tmpDir, 'pkg')
    const moduleDir = join(pkgRoot, 'src', 'deep')
    mkdirSync(moduleDir, { recursive: true })
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'fixture-pkg' }))

    const result = packageRoot(pathToFileURL(join(moduleDir, 'mod.js')).href)

    expect(realpathSync(result)).toBe(realpathSync(pkgRoot))
  })

  it('does not walk past the enclosing git repository to a planted package.json', () => {
    // Security review, PR #94: same walk class as studio.ts/config.ts. When
    // no package.json exists inside the enclosing repo, the walk must stop
    // at the repo root rather than resolving a planted ancestor file.
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ name: 'planted' }))

    const innerRepo = join(tmpDir, 'inner-repo')
    const moduleDir = join(innerRepo, 'deep')
    mkdirSync(moduleDir, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: innerRepo })

    const result = packageRoot(pathToFileURL(join(moduleDir, 'mod.js')).href)

    expect(realpathSync(result)).toBe(realpathSync(innerRepo))
    expect(realpathSync(result)).not.toBe(realpathSync(tmpDir))
  })
})

/**
 * Issue #505: inside the author repository the tree is the CLI. A fixture
 * repo (a real git toplevel, so `resolveDoctrineRootInfo`'s own `git
 * rev-parse --show-toplevel` probe resolves it) carrying its own
 * `aeg-root/roles/` and `apps/cli/src/index.ts` is the author repo; an
 * installed `vinaya` invoked with its cwd inside it must re-exec that file.
 */
describe('resolveAuthorRepoSourceEntry', () => {
  let repoRoot: string

  beforeEach(() => {
    repoRoot = join(tmpdir(), `vinaya-author-repo-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(repoRoot, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot })
  })

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true })
  })

  function withAuthorRepoShape(): string {
    const roleFile = join(repoRoot, 'aeg-root', 'roles', 'x.md')
    mkdirSync(dirname(roleFile), { recursive: true })
    writeFileSync(roleFile, '# x\n')
    const entry = join(repoRoot, 'apps', 'cli', 'src', 'index.ts')
    mkdirSync(dirname(entry), { recursive: true })
    writeFileSync(entry, '// fixture source entry\n')
    writeFileSync(join(repoRoot, 'apps', 'cli', 'package.json'), JSON.stringify({ name: '@attalabs/vinaya' }))
    return entry
  }

  it('resolves the tree source entry when an installed caller runs with cwd inside the author repo', () => {
    const entry = withAuthorRepoShape()
    const installedPkg = join(tmpdir(), 'fake-install', 'node_modules', '@attalabs', 'vinaya')

    expect(realpathSync(resolveAuthorRepoSourceEntry(installedPkg, repoRoot) as string)).toBe(realpathSync(entry))
  })

  it('never defers when the caller itself is running from source — the self-guard against a loop', () => {
    withAuthorRepoShape()
    const sourceLookingPkg = join(repoRoot, 'apps', 'cli')

    expect(resolveAuthorRepoSourceEntry(sourceLookingPkg, repoRoot)).toBeNull()
  })

  it('returns null when the repo carries aeg-root/roles/ but no apps/cli/src/index.ts of its own', () => {
    const roleFile = join(repoRoot, 'aeg-root', 'roles', 'x.md')
    mkdirSync(dirname(roleFile), { recursive: true })
    writeFileSync(roleFile, '# x\n')
    const installedPkg = join(tmpdir(), 'fake-install', 'node_modules', '@attalabs', 'vinaya')

    expect(resolveAuthorRepoSourceEntry(installedPkg, repoRoot)).toBeNull()
  })

  it('returns null when cwd is an ordinary repo with no aeg-root/roles/ of its own', () => {
    const installedPkg = join(tmpdir(), 'fake-install', 'node_modules', '@attalabs', 'vinaya')

    expect(resolveAuthorRepoSourceEntry(installedPkg, repoRoot)).toBeNull()
  })

  it('returns null when the directory shape matches but apps/cli/package.json is not really @attalabs/vinaya (security review, PR #513)', () => {
    // The exact spoof named in review: a repo that merely carries the two
    // paths (a shared sample/tutorial/fork) must not be treated as the
    // author repository just because the shape matches.
    const roleFile = join(repoRoot, 'aeg-root', 'roles', 'x.md')
    mkdirSync(dirname(roleFile), { recursive: true })
    writeFileSync(roleFile, '# x\n')
    const entry = join(repoRoot, 'apps', 'cli', 'src', 'index.ts')
    mkdirSync(dirname(entry), { recursive: true })
    writeFileSync(entry, '// fixture source entry\n')
    writeFileSync(join(repoRoot, 'apps', 'cli', 'package.json'), JSON.stringify({ name: 'totally-not-vinaya' }))
    const installedPkg = join(tmpdir(), 'fake-install', 'node_modules', '@attalabs', 'vinaya')

    expect(resolveAuthorRepoSourceEntry(installedPkg, repoRoot)).toBeNull()
  })

  it('returns null when apps/cli/package.json is missing entirely, even though the directory shape matches', () => {
    const roleFile = join(repoRoot, 'aeg-root', 'roles', 'x.md')
    mkdirSync(dirname(roleFile), { recursive: true })
    writeFileSync(roleFile, '# x\n')
    const entry = join(repoRoot, 'apps', 'cli', 'src', 'index.ts')
    mkdirSync(dirname(entry), { recursive: true })
    writeFileSync(entry, '// fixture source entry\n')
    const installedPkg = join(tmpdir(), 'fake-install', 'node_modules', '@attalabs', 'vinaya')

    expect(resolveAuthorRepoSourceEntry(installedPkg, repoRoot)).toBeNull()
  })
})

/**
 * O2 end to end, against this real checkout: a copy of the built,
 * self-contained `dist/index.js` placed under a `node_modules` segment (the
 * published-tarball shape) — run with `node`, cwd inside this repo — must
 * defer to this repo's own `apps/cli/src/index.ts`, producing stdout
 * byte-identical to running that source file directly, an exit code that
 * matches, and exactly one deferral line on stderr, never on stdout.
 */
describe('vinaya: an installed build defers to this repo’s own source (Issue #505)', () => {
  const CLI_ROOT = join(import.meta.dir, '..')
  const REPO_ROOT = join(CLI_ROOT, '..', '..')
  const SRC_INDEX = join(CLI_ROOT, 'src', 'index.ts')
  const DIST_INDEX = join(CLI_ROOT, 'dist', 'index.js')

  // Issue #660, O3 (round 5 review, MAJOR) — this process's own VINAYA_*
  // environment is stripped before `extraEnv` is applied, and the
  // subprocess is bounded by an explicit budget that throws with its own
  // captured stdout/stderr on expiry, rather than a bare timeout.
  function run(cmd: string, args: string[], cwd: string, extraEnv: Record<string, string> = {}) {
    return spawnSyncBudgeted(
      cmd,
      args,
      { cwd, encoding: 'utf8', env: { ...stripVinayaEnv(), ...extraEnv } },
      undefined,
      cmd
    )
  }

  it('an installed dist build, run from this repo, prints the same stdout as running the source directly, via exactly one stderr deferral line', () => {
    // Issue #660, O3 — bounded by an explicit budget (60s, generous for a
    // ~1s build on a quiet host) that throws with the child's own captured
    // stdout/stderr on expiry, rather than a bare test-framework timeout.
    const buildResult = spawnSyncBudgeted(
      'bun',
      ['run', 'build'],
      { cwd: CLI_ROOT, encoding: 'utf8' },
      60_000,
      'apps/cli build'
    )
    expect(buildResult.status, `apps/cli build failed:\n${buildResult.stdout}\n${buildResult.stderr}`).toBe(0)

    // Nested inside THIS repo's own real `node_modules` (rather than an
    // unrelated tmp dir) so the bundle's externalized npm dependencies
    // (workspace deps are inlined; real npm deps are not, per
    // scripts/build.ts) resolve exactly as they would for a real hoisted
    // install — Node's module resolution walks up from the requiring file
    // to each ancestor's `node_modules`, and this repo's root `node_modules`
    // is one such ancestor here. The path still carries a `node_modules`
    // segment, which is the only thing `resolveAuthorRepoSourceEntry` reads.
    const installedPkgDir = join(REPO_ROOT, 'node_modules', '.vinaya-defer-fixture')
    mkdirSync(join(installedPkgDir, 'dist'), { recursive: true })
    // `type: module` matches the real package.json's own declaration — the
    // bundle is emitted as ESM (`import`/`export`), and Node picks CJS vs
    // ESM parsing from the nearest ancestor package.json's `type` field.
    writeFileSync(join(installedPkgDir, 'package.json'), JSON.stringify({ name: '@attalabs/vinaya', type: 'module' }))
    copyFileSync(DIST_INDEX, join(installedPkgDir, 'dist', 'index.js'))

    try {
      const direct = run('bun', [SRC_INDEX, 'version'], REPO_ROOT, { VINAYA_NO_DEFER: '1' })
      const deferred = run('node', [join(installedPkgDir, 'dist', 'index.js'), 'version'], REPO_ROOT, {
        GITHUB_ACTIONS: ''
      })

      expect(deferred.status).toBe(direct.status)
      expect(deferred.stdout).toBe(direct.stdout)
      expect(deferred.stdout).not.toContain('deferring to source')

      const deferralLines = deferred.stderr.split('\n').filter((l) => l.includes('deferring to source at'))
      expect(deferralLines.length).toBe(1)
      expect(deferralLines[0]).toContain(SRC_INDEX)
    } finally {
      rmSync(installedPkgDir, { recursive: true, force: true })
    }
  })
})
