// task-run-v1 20, O3: `ci.yml` shards the apps/cli test suite across six
// jobs by an explicit, measured-balanced file list (`ci-shards/shard-{1..6}
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
import { parse } from 'yaml'
import { CI_SHARD_COUNT, isCliTestFile } from '../src/lib/ci-shard-membership'
import { spawnSyncBudgeted, stripVinayaEnv } from './lib/process-fixture'

const CLI_ROOT = join(import.meta.dir, '..')
const SHARD_DIR = join(import.meta.dir, 'ci-shards')
const SHARD_COUNT = CI_SHARD_COUNT
const CI_WORKFLOW = readFileSync(join(CLI_ROOT, '..', '..', '.github', 'workflows', 'ci.yml'), 'utf8')
const GITHUB_EXPRESSION = '$' + '{{'

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

// The shard lists name only the CLI's files; the schedule
// (`scripts/test-suites/schedule.ts`) places every other owner's tests. This
// is the same exactly-once check over every owner: run as its own process so
// the CLI's tests import nothing from the repository's scripts.
describe('the CI test schedule covers every owner', () => {
  const SCHEDULE = join(CLI_ROOT, '..', '..', 'scripts', 'test-suites', 'schedule.ts')

  it('places every inventory test exactly once, CLI tests in the shard their list names', () => {
    const run = spawnSyncBudgeted('bun', [SCHEDULE, '--json', '--full'], {
      cwd: join(CLI_ROOT, '..', '..'),
      encoding: 'utf8',
      env: stripVinayaEnv()
    })
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    const schedule = JSON.parse(run.stdout) as {
      problems: unknown[]
      accounting: { test: string; placement: string }[]
      assignments: Record<string, number>
    }
    expect(schedule.problems).toEqual([])
    const tests = schedule.accounting.map((e) => e.test)
    expect(new Set(tests).size).toBe(tests.length)
    // Every owner is in it, not only the CLI: the kernel, the process, a Vitest package and the root suite.
    for (const dir of ['apps/cli/', 'harness/', 'processes/vinaya/', 'packages/aeg-core/', 'scripts/'])
      expect(`${dir} ${tests.some((t) => t.startsWith(dir))}`).toBe(`${dir} true`)
    for (let n = 1; n <= SHARD_COUNT; n++)
      for (const f of shardFiles(n)) {
        expect(schedule.assignments[`apps/cli/${f}`]).toBe(n)
        expect(schedule.accounting.find((e) => e.test === `apps/cli/${f}`)?.placement).toBe(`shard-${n}`)
      }
  })
})

describe('the repository CI workflow', () => {
  type Job = {
    name?: string
    needs?: string | string[]
    steps?: { name?: string; run?: string; 'working-directory'?: string }[]
  }
  const jobs = (parse(CI_WORKFLOW) as { jobs: Record<string, Job> }).jobs

  it('keeps every test job name and its dependency on the build job alone', () => {
    expect(jobs['test-cli']?.name).toBe(`Test (apps/cli, shard ${GITHUB_EXPRESSION} matrix.shard }})`)
    expect(jobs['test-shared-packages']?.name).toBe('Test (shared packages)')
    expect(jobs.build?.name).toBe('Build, lint & typecheck')
    for (const job of ['test-cli', 'test-shared-packages', 'test-cli-config-anchor'])
      expect(jobs[job]?.needs).toBe('build')
  })

  it('runs each place of the schedule from the repository root, selected on a pull request and whole on main', () => {
    const run = (job: string, step: string) => jobs[job]?.steps?.find((s) => s.name === step)?.run ?? ''
    const shard = `--placement shard-${GITHUB_EXPRESSION} matrix.shard }}`
    const prShard = run('test-cli', `Test shard ${GITHUB_EXPRESSION} matrix.shard }}'s selected files`)
    // The decision is the build job's CI plan, never a selection the shard runs itself.
    expect(prShard).toContain('printf \'%s\\n\' "$CI_PLAN_DECISION" > "$DECISION"')
    expect(prShard).toContain(`schedule.ts --run ${shard} --decision "$DECISION"`)
    expect(run('test-cli', `Test shard ${GITHUB_EXPRESSION} matrix.shard }}`)).toContain(
      `schedule.ts --run ${shard} --full`
    )
    const prShared = run('test-shared-packages', 'Test the packages the pull request affects')
    expect(prShared).toContain('schedule.ts --run --placement shared --decision "$DECISION"')
    expect(run('test-shared-packages', 'Test')).toContain('schedule.ts --run --placement shared --full')
    for (const job of ['test-cli', 'test-shared-packages'])
      for (const step of jobs[job]?.steps ?? []) {
        expect(step['working-directory']).toBeUndefined()
        expect(step.run ?? '').not.toContain('--parallel')
        expect(step.run ?? '').not.toContain('turbo test')
      }
  })

  it('runs every default-branch commit in full without cancelling an earlier merge', () => {
    expect(CI_WORKFLOW).toContain('push:\n    branches: [main]')
    expect(CI_WORKFLOW).toContain(`group: ci-${GITHUB_EXPRESSION} github.event.pull_request.number || github.sha }}`)
    expect(CI_WORKFLOW).toContain(`cancel-in-progress: ${GITHUB_EXPRESSION} github.event_name == 'pull_request' }}`)
    expect(CI_WORKFLOW).toContain(`if [ "${GITHUB_EXPRESSION} github.event_name }}" = "push" ]; then`)
    expect(CI_WORKFLOW).toContain('echo "docs_only=false" >> "$GITHUB_OUTPUT"')
  })

  it('preserves pull-request triggers and their superseded-run cancellation', () => {
    expect(CI_WORKFLOW).toContain('pull_request:\n    types: [opened, synchronize, reopened]')
    expect(CI_WORKFLOW).toContain(`cancel-in-progress: ${GITHUB_EXPRESSION} github.event_name == 'pull_request' }}`)
  })
})

// Real git fixtures exercise staged and committed membership independently.
describe('ci-shard-coverage — hook-specific membership', () => {
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
    git(dir, ['checkout', '-b', 'work'])

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

  function run(
    cwd: string,
    preCommit = true,
    extraEnv: NodeJS.ProcessEnv = {}
  ): { status: number; stdout: string; stderr: string } {
    return spawnSyncBudgeted('bun', [BIN], {
      cwd,
      encoding: 'utf8',
      env: {
        ...stripVinayaEnv(),
        PATH: process.env.PATH,
        BASE_SHA: '',
        GIT_INDEX_FILE: preCommit ? join(cwd, '.git', 'index') : '',
        VINAYA_COMMIT_HOOK: preCommit ? '1' : '',
        ...extraEnv
      }
    })
  }

  it('refuses a new CLI test file staged without a shard line, naming the file and the shard files', () => {
    const dir = repoStagingCliFile('tests/widget.test.ts', 'test("x", () => {})\n')
    const result = run(dir)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('apps/cli/tests/widget.test.ts')
    expect(result.stderr).toContain('apps/cli/tests/ci-shards/shard-1.txt')
    expect(result.stderr).toContain('apps/cli/tests/ci-shards/shard-2.txt')
    for (const n of [3, 4, 5, 6]) expect(result.stderr).toContain(`apps/cli/tests/ci-shards/shard-${n}.txt`)
  })

  it('passes when the new CLI test file and its shard line are staged together', () => {
    const dir = repoStagingCliFile('tests/widget.test.ts', 'test("x", () => {})\n')
    stageShardLine(dir, 2, 'tests/widget.test.ts')
    const result = run(dir)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('0 missing from a shard')
  })

  it('does not count an unstaged shard line at pre-commit', () => {
    const dir = repoStagingCliFile('tests/widget.test.ts', 'test("x", () => {})\n')
    stageShardLine(dir, 1, 'tests/other.test.ts')
    writeFileSync(join(dir, 'apps/cli/tests/ci-shards/shard-1.txt'), 'tests/widget.test.ts\n')
    expect(run(dir).status).toBe(1)
  })

  for (const withIndex of [false, true]) {
    it(`refuses committed additions with an empty index (index variable: ${withIndex})`, () => {
      const dir = repoStagingCliFile('tests/widget.test.ts', 'test("x", () => {})\n')
      git(dir, ['commit', '-m', 'add unlisted test'])
      const result = run(dir, false, { GIT_INDEX_FILE: withIndex ? join(dir, '.git', 'index') : '' })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('apps/cli/tests/widget.test.ts')
    })
  }

  it('uses HEAD shard lists despite staged and unstaged attempts to list a committed addition', () => {
    const dir = repoStagingCliFile('tests/widget.test.ts', 'test("x", () => {})\n')
    git(dir, ['commit', '-m', 'add unlisted test'])
    stageShardLine(dir, 1, 'tests/widget.test.ts')
    const extraEnv = { GIT_INDEX_FILE: join(dir, '.git', 'index') }
    expect(run(dir, false, extraEnv).status).toBe(1)
    writeFileSync(join(dir, 'apps/cli/tests/ci-shards/shard-1.txt'), 'tests/widget.test.ts\ntests/other.test.ts\n')
    expect(run(dir, false, extraEnv).status).toBe(1)
    git(dir, ['add', '.'])
    git(dir, ['commit', '-m', 'list test'])
    const result = run(dir, false, extraEnv)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('1 CLI test file(s) judged from HEAD')
  })

  it('ignores index-only additions outside pre-commit, including when only the marker is supplied', () => {
    const dir = repoStagingCliFile('tests/widget.test.ts', 'test("x", () => {})\n')
    git(dir, ['commit', '--allow-empty', '--only', '-m', 'distinct head'])
    expect(run(dir, false, { GIT_INDEX_FILE: join(dir, '.git', 'index') }).status).toBe(0)
    expect(run(dir, false, { VINAYA_COMMIT_HOOK: '1' }).status).toBe(0)
  })

  it('judges every tracked test when no distinct base resolves, using HEAD shard content', () => {
    const dir = repoStagingCliFile('tests/widget.test.ts', 'test("x", () => {})\n')
    git(dir, ['commit', '-m', 'add unlisted test'])
    git(dir, ['branch', '-f', 'main', 'HEAD'])
    stageShardLine(dir, 2, 'tests/widget.test.ts')
    expect(run(dir, false, { BASE_SHA: 'missing-ref' }).status).toBe(1)
    git(dir, ['commit', '-m', 'list test'])
    git(dir, ['branch', '-f', 'main', 'HEAD'])
    expect(run(dir, false, { BASE_SHA: 'missing-ref' }).status).toBe(0)
  })

  /** A repo whose base commit lists `tests/driver.test.ts` in shard 1, on a work branch. */
  function repoWithListedTest(): string {
    const dir = repoStagingCliFile('tests/driver.test.ts', 'test("x", () => {})\n')
    stageShardLine(dir, 1, 'tests/driver.test.ts')
    git(dir, ['commit', '-m', 'listed test'])
    git(dir, ['branch', '-f', 'main', 'HEAD'])
    return dir
  }

  /** Moves the listed CLI test to another owner, staged. */
  function moveToProcess(dir: string): void {
    mkdirSync(join(dir, 'processes', 'vinaya', 'tests'), { recursive: true })
    git(dir, ['mv', 'apps/cli/tests/driver.test.ts', 'processes/vinaya/tests/driver.test.ts'])
  }

  it('refuses a CLI test moved to another owner while its shard line stays, at commit and at push', () => {
    const dir = repoWithListedTest()
    moveToProcess(dir)
    const staged = run(dir)
    expect(staged.status).toBe(1)
    expect(staged.stderr).toContain('apps/cli/tests/driver.test.ts is listed in a CI shard')
    expect(staged.stdout).toContain('1 listed but no longer there')
    git(dir, ['commit', '-m', 'move without the list'])
    expect(run(dir, false).status).toBe(1)
  })

  it('passes the move once its shard line leaves in the same change', () => {
    const dir = repoWithListedTest()
    moveToProcess(dir)
    stageShardLine(dir, 1, '')
    const staged = run(dir)
    expect(staged.status).toBe(0)
    expect(staged.stdout).toContain('0 listed but no longer there')
    git(dir, ['commit', '-m', 'move with the list'])
    expect(run(dir, false).status).toBe(0)
  })

  it('judges tracked tests when candidate history has no merge base', () => {
    const dir = repoStagingCliFile('tests/widget.test.ts', 'test("x", () => {})\n')
    git(dir, ['commit', '-m', 'test'])
    git(dir, ['checkout', '--orphan', 'unrelated'])
    git(dir, ['commit', '-m', 'unrelated test tree'])
    const result = run(dir, false)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('apps/cli/tests/widget.test.ts')
  })
})
