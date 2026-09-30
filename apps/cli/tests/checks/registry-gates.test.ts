import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { buildInitOps } from '../../src/lib/artifacts.js'
import { HOOK_DIRS, initHookPaths } from '../../src/lib/init-hook-paths.js'

// Task `vinaya-adopter-portability-v1` 2 (Issue #232): before this fix, an
// absent `aeg-root/enforcement.md` made `check-registry-gates.ts` exit 0 with
// ZERO findings — a vacuous pass, byte-indistinguishable from a real pass
// that inspected a real doctrine tree. Reproduced on a fresh
// `npm i @attalabs/vinaya@0.19.2 && vinaya init --yes` fixture (this task's
// PR body carries the exact transcript): `registry-gates: pass`, having
// examined zero files. This suite proves the fix: the check now announces
// its own dormancy as a visible warning finding instead of a silent exit.

const BIN_PATH = join(import.meta.dir, '..', '..', 'src', 'checks', 'bin', 'check-registry-gates.ts')

function initFixture(name: string): string {
  const root = join(tmpdir(), `vinaya-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root })
  writeFileSync(join(root, 'README.md'), '# fixture\n')
  execFileSync('git', ['add', 'README.md'], { cwd: root })
  execFileSync('git', ['commit', '-q', '-m', 'Chore: initial commit'], { cwd: root })
  return root
}

describe('registry-gates — task vinaya-adopter-portability-v1 2 (Issue #232)', () => {
  it('announces dormancy on stderr as a warning finding, exit 0, instead of a silent zero-finding pass', () => {
    const root = initFixture('registry-gates-dormant')
    try {
      const result = Bun.spawnSync(['bun', BIN_PATH], { cwd: root, env: { ...process.env } })
      expect(result.exitCode).toBe(0)
      const stderr = result.stderr.toString()
      expect(stderr).toContain('"check":"registry-gates.dormant"')
      expect(stderr).toContain('"severity":"warning"')
      expect(stderr).toContain('dormant')
      expect(stderr).toContain('no aeg-root/enforcement.md in this repository')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)

  it("the dormancy finding is visible through `vinaya check --all`'s own renderer (findings print under their check regardless of exit code)", () => {
    const root = initFixture('registry-gates-dormant-all')
    try {
      const indexTs = join(import.meta.dir, '..', '..', 'src', 'index.ts')
      const result = Bun.spawnSync(['bun', indexTs, 'check', '--all', '--diff-only'], {
        cwd: root,
        env: { ...process.env, PR_BODY: undefined }
      })
      expect(result.exitCode).toBe(0)
      const stdout = result.stdout.toString()
      expect(stdout).toContain('registry-gates: pass')
      expect(stdout).toContain('warning: registry-gates: dormant')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 45_000)

  it('no longer hardcodes packages/aeg-core/bin as a candidate-file location (repo-specific, not portable)', () => {
    const source = readFileSync(BIN_PATH, 'utf8')
    expect(source).not.toContain("existsSync('packages/aeg-core/bin')")
  })

  it("this repository's own run still exercises the real corpus — no dormancy finding when aeg-root/enforcement.md exists", () => {
    const repoRoot = join(import.meta.dir, '..', '..', '..', '..')
    const result = Bun.spawnSync(['bun', BIN_PATH], { cwd: repoRoot, env: { ...process.env } })
    const stderr = result.stderr.toString()
    expect(stderr).not.toContain('registry-gates.dormant')
  }, 20_000)
})

describe('registry-gates — brief-author retirement (plan-brief-v1 4, Issue #429)', () => {
  // Task 3 (Issue #428) tolerated `brief-developer.md`/`planner-brief.md`
  // naming `brief-author` as producer/consumer until task 4 deleted/renamed
  // them. Task 4 has landed: `roles/brief-author.md` is gone, and no
  // contract names `brief-author` as producer or consumer any more.
  it('no contract names brief-author as producer or consumer', () => {
    const contractsDir = join(import.meta.dir, '..', '..', '..', '..', 'aeg-root', 'contracts')
    const offenders: string[] = []
    for (const file of readdirSync(contractsDir)) {
      if (!file.endsWith('.md')) continue
      const content = readFileSync(join(contractsDir, file), 'utf8')
      if (/^(?:producer|consumer):\s*brief-author\s*$/m.test(content)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })
})

describe('registry-gates G1 — hook scripts the doctrine names must be shipped', () => {
  it('fails on a doctrine hook path that is neither tracked nor emitted by init, and passes on an emitted one', () => {
    const root = initFixture('registry-gates-hook-refs')
    try {
      mkdirSync(join(root, 'aeg-root'), { recursive: true })
      writeFileSync(join(root, 'aeg-root', 'enforcement.md'), '# Enforcement\n')
      writeFileSync(
        join(root, 'aeg-root', 'note.md'),
        'Emitted: `.husky/pre-push`. Unshipped: `.claude/hooks/check-gone.sh` and `check-gone.sh`.\n'
      )
      const result = Bun.spawnSync(['bun', BIN_PATH], { cwd: root, env: { ...process.env } })
      const g1 = result.stderr
        .toString()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { check: string; message: string })
        .filter((f) => f.check === 'registry-gates.G1')
        .map((f) => f.message)
      expect(g1).toHaveLength(2)
      expect(g1.some((m) => m.includes('hook ".claude/hooks/check-gone.sh"'))).toBe(true)
      expect(g1.some((m) => m.includes('hook "check-gone.sh"'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)
})

describe('initHookPaths — parity with buildInitOps', () => {
  it('lists exactly the managed hook blocks buildInitOps emits under each hook directory', () => {
    const emitted = new Set<string>()
    for (const hookDir of HOOK_DIRS) {
      const ops = buildInitOps({ owner: '', repo: '', hookDir, selfHost: null, ciSetup: null, agents: new Set() })
      for (const op of ops) {
        if ('path' in op && op.path.startsWith(`${hookDir}/`)) emitted.add(op.path)
      }
    }
    expect(new Set(initHookPaths())).toEqual(emitted)
    expect(emitted.has('.git/hooks/pre-push')).toBe(true)
    expect(emitted.has('.vinaya/hooks/pre-commit')).toBe(true)
  })
})
