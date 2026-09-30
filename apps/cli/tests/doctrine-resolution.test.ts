import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'bun:test'
import { extractShortVersionAndChecklist } from '@attalabs/aeg-core/docs'
import { ENTRY_SEGMENTS, resolveDoctrineRoot } from '../src/commands/doctrine'
import { buildRolePlan } from '../src/roles/plan'

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

describe('vinaya doctrine --role — configured overrides and additive roles (Issue #762)', () => {
  // The command now resolves role names through the SAME role plan the review
  // loop uses (`buildRolePlan` → `resolveRoles`), so a config override or an
  // additive role is served — not just the bare `<root>/roles/*.md` files. Each
  // case spawns the CLI with `cwd` at a throwaway repo carrying a
  // `vinaya.config.json`: a non-git tmpdir, so `resolveDoctrineRoot` falls
  // through to THIS monorepo's own `aeg-root/` (the vendored-dev fallback that
  // `check-roles-plan.test.ts` relies on) for the CORE roles, while the config
  // and its contract files come from the fixture. The two doctrine-root SHAPES
  // (installed-tarball vs. tree-first) are exercised by the `resolveDoctrineRoot`
  // cases above; override/additive resolution is orthogonal to which shape
  // resolved the root — it turns entirely on the config the fixture supplies.

  const roleFixtures: string[] = []
  afterEach(() => {
    for (const dir of roleFixtures.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function roleFixture(config: unknown, files: Record<string, string>): { repo: string; home: string } {
    const repo = mkdtempSync(join(tmpdir(), 'doctrine-role-repo-'))
    const home = mkdtempSync(join(tmpdir(), 'doctrine-role-home-'))
    roleFixtures.push(repo, home)
    mkdirSync(join(home, '.vinaya'), { recursive: true })
    writeFileSync(join(repo, 'vinaya.config.json'), JSON.stringify(config, null, 2), 'utf-8')
    for (const [name, content] of Object.entries(files)) writeFileSync(join(repo, name), content, 'utf-8')
    return { repo, home }
  }

  async function runCli(
    args: string[],
    repo: string,
    home: string
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(['bun', INDEX, ...args], {
      cwd: repo,
      env: { ...process.env, HOME: home },
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    return { code: await proc.exited, stdout, stderr }
  }

  /** A full, structurally-valid role contract carrying a distinctive body marker — and an ack-token only when asked for one. */
  function contract(roleId: string, opts: { ackToken?: string; marker: string; withChecklist?: boolean }): string {
    const lines = ['---', `title: Custom ${roleId}`, 'order: 42', `role_id: ${roleId}`]
    if (opts.ackToken !== undefined) lines.push(`ack-token: ${opts.ackToken}`)
    lines.push(
      'description: A fixture-authored role contract.',
      'actor: agent',
      'performs:',
      '  - do-the-thing',
      'refuses_when: Never.',
      'summary: A fixture role.',
      '---',
      '## The short version',
      '',
      `${opts.marker} — this body is the configured text, not the core role.`,
      ''
    )
    if (opts.withChecklist) {
      lines.push('---', '', '## What you check', '', `1. ${opts.marker}-CHECK: the configured checklist item.`, '')
    }
    return lines.join('\n')
  }

  it("serves an overriding role's own body and ack-token, never the core role's (O1)", async () => {
    const { repo, home } = roleFixture(
      { roles: { reviewer: { contract: './custom-reviewer.md' } } },
      { 'custom-reviewer.md': contract('reviewer', { ackToken: 'ov117abc', marker: 'OVERRIDE-BODY' }) }
    )
    const print = await runCli(['doctrine', '--role', 'reviewer', '--print'], repo, home)
    expect(print.code).toBe(0)
    // The override's OWN read-receipt token is the first line, and its body is
    // served — the core reviewer's short version never leaks through.
    expect(print.stdout.split('\n')[0]).toBe('ov117abc')
    expect(print.stdout).toContain('OVERRIDE-BODY')
    expect(print.stdout).not.toContain('did not write the code')

    // The bare (path) mode points at the config contract file, so
    // `cat "$(vinaya doctrine --role reviewer)"` opens the override.
    const path = await runCli(['doctrine', '--role', 'reviewer'], repo, home)
    expect(path.code).toBe(0)
    expect(path.stdout.trim().endsWith('custom-reviewer.md')).toBe(true)
  })

  it('serves an override that carries no ack-token without inventing one (O1, Traps to avoid)', async () => {
    const { repo, home } = roleFixture(
      { roles: { reviewer: { contract: './tokenless-reviewer.md' } } },
      { 'tokenless-reviewer.md': contract('reviewer', { marker: 'TOKENLESS-OVERRIDE' }) }
    )
    const print = await runCli(['doctrine', '--role', 'reviewer', '--print'], repo, home)
    expect(print.code).toBe(0)
    // No token line is prepended: the output begins with the override's body.
    expect(print.stdout.trimStart().startsWith('## The short version')).toBe(true)
    expect(print.stdout).toContain('TOKENLESS-OVERRIDE')
  })

  it('serves the SAME override text the review loop resolves for that role (O3)', async () => {
    const overrideConfig = { reviewer: { contract: './loop-parity-reviewer.md' } }
    const { repo, home } = roleFixture(
      { roles: overrideConfig },
      {
        'loop-parity-reviewer.md': contract('reviewer', {
          ackToken: 'lp01aa22',
          marker: 'LOOP-PARITY',
          withChecklist: true
        })
      }
    )

    // What the review loop resolves for `reviewer`, through the same plan
    // (`resolveRoleDoctrineText` reads exactly this `buildRolePlan` result).
    const rolePlan = await buildRolePlan(repo, overrideConfig)
    expect(rolePlan.available).toBe(true)
    if (!rolePlan.available) return
    const reviewer = rolePlan.resolved.find((r) => r.renderId === 'reviewer')
    expect(reviewer?.state).toBe('overridden')
    const loopText = extractShortVersionAndChecklist(reviewer?.contract.body ?? '')
    expect(loopText).toContain('LOOP-PARITY')
    expect(loopText).toContain('LOOP-PARITY-CHECK')

    // What `vinaya doctrine --role reviewer --print` serves — the same override,
    // from the same resolution — carrying the same distinctive text, and never
    // the core reviewer body the loop also never resolves here.
    const print = await runCli(['doctrine', '--role', 'reviewer', '--print'], repo, home)
    expect(print.code).toBe(0)
    expect(print.stdout).toContain('LOOP-PARITY')
    expect(print.stdout).toContain('LOOP-PARITY-CHECK')
    expect(print.stdout).not.toContain('did not write the code')
    expect(loopText).not.toContain('did not write the code')
  })
})
