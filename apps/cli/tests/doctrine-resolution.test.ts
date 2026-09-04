import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'bun:test'
import { ENTRY_SEGMENTS, resolveDoctrineRoot } from '../src/commands/doctrine'

/**
 * The resolution rule, exercised against a checkout that carries BOTH roots
 * — the shape every real dev machine has the moment `bundle-doctrine` has
 * ever run, since the package-relative copy is git-ignored and therefore
 * invisible in `git status` while it silently outranks the live tree.
 */

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const INDEX = join(CLI_ROOT, 'src', 'index.ts')

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A fake checkout: `<repo>/aeg-root` (live) and `<repo>/apps/cli/aeg-root` (bundled), each a real doctrine root. */
function checkoutWithBothRoots(repoParent: string): { pkg: string; repoRoot: string; bundled: string } {
  const repoRoot = join(repoParent, 'repo')
  const pkg = join(repoRoot, 'apps', 'cli')
  const bundled = join(pkg, 'aeg-root')
  for (const root of [join(repoRoot, 'aeg-root'), bundled]) {
    const entry = join(root, ...ENTRY_SEGMENTS)
    mkdirSync(dirname(entry), { recursive: true })
    writeFileSync(entry, `# doctrine at ${root}\n`)
  }
  return { pkg, repoRoot, bundled }
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

describe('resolveDoctrineRoot — a checkout carrying both roots', () => {
  // `cwd` pins each case to its own fixture dir, never the real vinaya
  // checkout the test process happens to run from — none of these fixtures
  // is a git worktree, so `git -C <cwd> rev-parse --show-toplevel` fails and
  // resolution falls through to the package-relative candidates exercised
  // here, exactly as before the tree-first lookup (O1) was added.
  it("resolves the repo root's aeg-root, not the package-relative bundle, when running from source", () => {
    const { pkg, repoRoot } = checkoutWithBothRoots(tempDir('doctrine-both-'))
    expect(resolveDoctrineRoot(pkg, repoRoot)).toBe(join(repoRoot, 'aeg-root'))
  })

  it('ignores the package-relative bundle entirely — it is never even a fallback from source', () => {
    const { pkg, bundled, repoRoot } = checkoutWithBothRoots(tempDir('doctrine-both-'))
    expect(resolveDoctrineRoot(pkg, repoRoot)).not.toBe(bundled)
  })

  it('returns null from source when only the package-relative bundle exists', () => {
    const dir = tempDir('doctrine-bundle-only-')
    const pkg = join(dir, 'repo', 'apps', 'cli')
    const entry = join(pkg, 'aeg-root', ...ENTRY_SEGMENTS)
    mkdirSync(dirname(entry), { recursive: true })
    writeFileSync(entry, '# bundled only\n')
    expect(resolveDoctrineRoot(pkg, dir)).toBeNull()
  })

  it('resolves the package-relative bundle for an installed copy, and never walks above it — the published-tarball shape', () => {
    const dir = tempDir('doctrine-installed-')
    const pkg = join(dir, 'repo', 'node_modules', '@attalabs', 'vinaya')
    const bundled = join(pkg, 'aeg-root')
    for (const root of [join(dir, 'repo', 'node_modules', 'aeg-root'), bundled]) {
      const entry = join(root, ...ENTRY_SEGMENTS)
      mkdirSync(dirname(entry), { recursive: true })
      writeFileSync(entry, '# doctrine\n')
    }
    expect(resolveDoctrineRoot(pkg, dir)).toBe(bundled)
  })
})

describe('resolveDoctrineRoot — tree-first resolution (atta-labs/vinaya#408)', () => {
  it("resolves the current repository's own aeg-root/ from any subdirectory, whatever binary runs it", () => {
    const dir = tempDir('doctrine-tree-')
    execFileSync('git', ['init', '-q'], { cwd: dir })
    const roleFile = join(dir, 'aeg-root', 'roles', 'x.md')
    mkdirSync(dirname(roleFile), { recursive: true })
    writeFileSync(roleFile, '# x\n')
    const subdir = join(dir, 'nested', 'deeper')
    mkdirSync(subdir, { recursive: true })

    // `pkg` points at an installed-looking copy elsewhere — the tree still
    // wins, because the repo under `cwd` carries its own aeg-root/roles/.
    // `realpathSync` matches `git rev-parse --show-toplevel`, which resolves
    // macOS's `/var` → `/private/var` tmpdir symlink.
    const installedPkg = join(tempDir('doctrine-tree-pkg-'), 'node_modules', '@attalabs', 'vinaya')
    expect(resolveDoctrineRoot(installedPkg, subdir)).toBe(join(realpathSync(dir), 'aeg-root'))
  })

  it('falls back to the installed bundle when the enclosing git repo has no aeg-root/roles/ of its own', () => {
    const dir = tempDir('doctrine-no-tree-')
    execFileSync('git', ['init', '-q'], { cwd: dir })
    const pkg = join(dir, 'node_modules', '@attalabs', 'vinaya')
    const bundled = join(pkg, 'aeg-root')
    const entry = join(bundled, ...ENTRY_SEGMENTS)
    mkdirSync(dirname(entry), { recursive: true })
    writeFileSync(entry, '# bundled\n')
    expect(resolveDoctrineRoot(pkg, dir)).toBe(bundled)
  })
})

describe('vinaya doctrine --role — both spellings of the reviewing role', () => {
  function run(args: string[]): { status: number; stdout: string; stderr: string } {
    try {
      return { status: 0, stdout: execFileSync('bun', [INDEX, ...args], { encoding: 'utf8' }), stderr: '' }
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string }
      return { status: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
    }
  }

  it('resolves `--role reviewer` to reviewer.md', () => {
    const result = run(['doctrine', '--role', 'reviewer'])
    expect(result.status).toBe(0)
    expect(result.stdout.trim().endsWith(join('roles', 'reviewer.md'))).toBe(true)
  })

  it('resolves the alias `--role code-reviewer` to the same file', () => {
    const alias = run(['doctrine', '--role', 'code-reviewer'])
    const canonical = run(['doctrine', '--role', 'reviewer'])
    expect(alias.status).toBe(0)
    expect(alias.stdout).toBe(canonical.stdout)
  })

  it('refuses an inherited Object.prototype key like `constructor` the same way, never a crash', () => {
    const result = run(['doctrine', '--role', 'constructor'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("'constructor' is not a known role")
  })

  it('still refuses an unknown role, naming what the caller actually asked for', () => {
    const result = run(['doctrine', '--role', 'not-a-role'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("'not-a-role' is not a known role")
  })
})
