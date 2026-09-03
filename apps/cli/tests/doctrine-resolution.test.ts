import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  it("resolves the repo root's aeg-root, not the package-relative bundle, when running from source", () => {
    const { pkg, repoRoot } = checkoutWithBothRoots(tempDir('doctrine-both-'))
    expect(resolveDoctrineRoot(pkg)).toBe(join(repoRoot, 'aeg-root'))
  })

  it('ignores the package-relative bundle entirely — it is never even a fallback from source', () => {
    const { pkg, bundled } = checkoutWithBothRoots(tempDir('doctrine-both-'))
    expect(resolveDoctrineRoot(pkg)).not.toBe(bundled)
  })

  it('returns null from source when only the package-relative bundle exists', () => {
    const dir = tempDir('doctrine-bundle-only-')
    const pkg = join(dir, 'repo', 'apps', 'cli')
    const entry = join(pkg, 'aeg-root', ...ENTRY_SEGMENTS)
    mkdirSync(dirname(entry), { recursive: true })
    writeFileSync(entry, '# bundled only\n')
    expect(resolveDoctrineRoot(pkg)).toBeNull()
  })

  it('resolves the package-relative bundle for an installed copy, and never walks above it', () => {
    const dir = tempDir('doctrine-installed-')
    const pkg = join(dir, 'repo', 'node_modules', '@attalabs', 'vinaya')
    const bundled = join(pkg, 'aeg-root')
    for (const root of [join(dir, 'repo', 'node_modules', 'aeg-root'), bundled]) {
      const entry = join(root, ...ENTRY_SEGMENTS)
      mkdirSync(dirname(entry), { recursive: true })
      writeFileSync(entry, '# doctrine\n')
    }
    expect(resolveDoctrineRoot(pkg)).toBe(bundled)
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

  it('still refuses an unknown role, naming what the caller actually asked for', () => {
    const result = run(['doctrine', '--role', 'not-a-role'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("'not-a-role' is not a known role")
  })
})
