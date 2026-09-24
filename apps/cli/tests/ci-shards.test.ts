// task-run-v1 20, O3: `ci.yml` shards the apps/cli test suite across three
// jobs by an explicit, measured-balanced file list (`ci-shards/shard-{1,2,3}
// .txt`, one path per line, relative to `apps/cli/`) rather than a directory
// split (Trap: sharding by directory concentrates the suite's few genuinely
// slow files — `dispatch.test.ts`, `quickstart.test.ts`, `demo.test.ts` — in
// whichever directory happens to hold them, defeating the balance a shard
// exists to provide).
//
// Nothing on the CI side re-derives this list from disk — a test file added,
// removed, or renamed without a matching edit to a shard file would either
// silently stop running in CI (dropped) or run twice under one shard's own
// `bun test` invocation (duplicated, wasting the shard's own budget). This
// test is that re-derivation, run locally and in CI like any other test, so
// the gap surfaces as a failing assertion instead of a quietly incomplete
// suite.
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CI_SHARD_COUNT, isCliTestFile } from '../src/lib/ci-shard-membership'

const CLI_ROOT = join(import.meta.dir, '..')
const SHARD_DIR = join(import.meta.dir, 'ci-shards')
const SHARD_COUNT = CI_SHARD_COUNT

function allTestFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const abs = join(dir, entry)
    if (statSync(abs).isDirectory()) {
      out.push(...allTestFiles(abs))
    } else {
      const rel = abs.slice(CLI_ROOT.length + 1)
      if (isCliTestFile(rel)) out.push(rel)
    }
  }
  return out
}

function shardFiles(n: number): string[] {
  return readFileSync(join(SHARD_DIR, `shard-${n}.txt`), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

describe('CI shard file lists (task-run-v1 20, O3)', () => {
  it('every test file on disk appears in exactly one shard — none dropped, none duplicated', () => {
    const onDisk = new Set(allTestFiles(CLI_ROOT))
    const shards = Array.from({ length: SHARD_COUNT }, (_, i) => shardFiles(i + 1))
    const allSharded = shards.flat()

    const seen = new Map<string, number>()
    for (const f of allSharded) seen.set(f, (seen.get(f) ?? 0) + 1)
    const duplicated = [...seen.entries()].filter(([, count]) => count > 1).map(([f]) => f)
    expect(duplicated).toEqual([])

    const dropped = [...onDisk].filter((f) => !seen.has(f)).sort()
    expect(dropped).toEqual([])

    const phantom = allSharded.filter((f) => !onDisk.has(f)).sort()
    expect(phantom).toEqual([])
  })

  it('every shard file path resolves and is itself a *.test.ts file', () => {
    for (let n = 1; n <= SHARD_COUNT; n++) {
      for (const f of shardFiles(n)) {
        expect(f.endsWith('.test.ts')).toBe(true)
        expect(statSync(join(CLI_ROOT, f)).isFile()).toBe(true)
      }
    }
  })
})

// `check-ci-shard-coverage.ts` enforces the same membership rule
// as the suite above, but over a commit's STAGED diff, at commit time — so a
// Developer who forgets a shard line is refused in seconds, not after a
// whole pre-push affected-suite run. Exercised against a real git index
// (`git diff --cached` / `git show :<path>`, never a stub) because the
// staged-but-uncommitted state this check reads has no meaningful fixture
// other than a real repo.
describe('ci-shard-coverage — the commit-time check', () => {
  const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'checks', 'bin', 'check-ci-shard-coverage.ts')

  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function git(cwd: string, args: string[]): void {
    execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'ignore'] })
  }

  /** A repo with one base commit, then `apps/cli/<relPath>` staged (never committed) with `content`. */
  function repoStagingCliFile(relPath: string, content: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'ci-shard-coverage-'))
    tempDirs.push(dir)
    git(dir, ['init', '--initial-branch=main'])
    git(dir, ['config', 'user.email', 'test@example.com'])
    git(dir, ['config', 'user.name', 'Test'])
    writeFileSync(join(dir, 'README.md'), '# base\n')
    git(dir, ['add', 'README.md'])
    git(dir, ['commit', '-m', 'base'])

    const abs = join(dir, 'apps', 'cli', relPath)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
    git(dir, ['add', join('apps', 'cli', relPath)])
    return dir
  }

  function stageShardLine(dir: string, shardN: number, line: string): void {
    const rel = join('tests', 'ci-shards', `shard-${shardN}.txt`)
    const abs = join(dir, 'apps', 'cli', rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, `${line}\n`)
    git(dir, ['add', join('apps', 'cli', rel)])
  }

  function run(cwd: string): { status: number; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync('bun', [BIN], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return { status: 0, stdout, stderr: '' }
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string }
      return { status: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
    }
  }

  it('refuses a new CLI test file staged without a shard line, naming the file and the shard files', () => {
    const dir = repoStagingCliFile('tests/widget.test.ts', 'test("x", () => {})\n')
    const result = run(dir)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('apps/cli/tests/widget.test.ts')
    expect(result.stderr).toContain('apps/cli/tests/ci-shards/shard-1.txt')
    expect(result.stderr).toContain('apps/cli/tests/ci-shards/shard-2.txt')
    expect(result.stderr).toContain('apps/cli/tests/ci-shards/shard-3.txt')
  })

  it('passes when the new CLI test file and its shard line are staged together', () => {
    const dir = repoStagingCliFile('tests/widget.test.ts', 'test("x", () => {})\n')
    stageShardLine(dir, 2, 'tests/widget.test.ts')
    const result = run(dir)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('0 missing from a shard')
  })
})
