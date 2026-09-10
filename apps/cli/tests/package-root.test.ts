import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { packageRoot } from '../src/lib/package-root'
import { resolveAuthorRepoSourceEntry } from '../src/lib/self-host'

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
})
