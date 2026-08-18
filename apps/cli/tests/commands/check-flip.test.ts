/**
 * The execution flip: `vinaya check` executes what the RESOLVER decides, and
 * `--plan` is a preview of that same decision rather than a parallel
 * description of it. Every test here is behavioural — it asserts what RAN,
 * never that the config parsed. (`rings` validated and rendered for releases
 * while executing nothing; the whole point of this task is that `checks`
 * does not repeat that.)
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { duplicateIdFailures } from '../../src/commands/check'
import { coreCheckRegistry, runsUnderAll } from '../../src/checks/registry'

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX = join(CLI_ROOT, 'src', 'index.ts')

/** Derived, never hard-coded: the first core check `--all` actually selects. */
const CORE_NAME = coreCheckRegistry().filter(runsUnderAll)[0]?.name as string
/** Core ids `--all` withholds because their own workflow reports them. */
const WITHHELD = new Set(
  coreCheckRegistry()
    .filter((s) => !runsUnderAll(s))
    .map((s) => s.name)
)

let repoDir: string | undefined
let homeDir: string | undefined

afterEach(() => {
  if (repoDir) rmSync(repoDir, { recursive: true, force: true })
  if (homeDir) rmSync(homeDir, { recursive: true, force: true })
  repoDir = undefined
  homeDir = undefined
})

/** A fresh temp repo plus a temp HOME, so no real global config leaks in. */
function fixture(config: unknown): { repo: string; home: string } {
  repoDir = mkdtempSync(join(tmpdir(), 'vinaya-flip-repo-'))
  homeDir = mkdtempSync(join(tmpdir(), 'vinaya-flip-home-'))
  mkdirSync(join(homeDir, '.vinaya'), { recursive: true })
  writeFileSync(join(repoDir, 'vinaya.config.json'), JSON.stringify(config, null, 2), 'utf-8')
  return { repo: repoDir, home: homeDir }
}

/** A real spawnable check: prints one CheckError line naming `id`, then fails. */
function stubCheck(repo: string, file: string, id: string): string {
  const path = join(repo, file)
  const finding = JSON.stringify({
    schema: 1,
    check: id,
    severity: 'error',
    message: `ran ${id}`,
    agent_recovery_prompt: `nothing to do — ${id} is a test stub`
  })
  writeFileSync(path, `#!/bin/sh\necho '${finding}' >&2\nexit 1\n`, 'utf-8')
  chmodSync(path, 0o755)
  return path
}

type Run = { code: number; stdout: string; stderr: string }

async function runCli(args: string[], repo: string, home: string): Promise<Run> {
  const proc = Bun.spawn(['bun', INDEX, ...args], {
    cwd: repo,
    env: { ...process.env, HOME: home },
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, stdout, stderr }
}

/** Names in `--plan --json`'s resolved registry. */
function planNames(stdout: string): string[] {
  return Object.keys(JSON.parse(stdout).checks)
}

/** Names of the outcomes `check --all --json` actually produced. */
function executedNames(stdout: string): string[] {
  return JSON.parse(stdout).data.checks.map((c: { name: string }) => c.name)
}

describe('vinaya check — plan-vs-execution agreement (the flip is the resolver deciding execution)', () => {
  it('executes exactly the set `--plan` printed, minus the ids `--all` withholds', async () => {
    const { repo, home } = fixture({
      checks: {
        'myteam/agree': { run: './agree.sh', scope: 'full' },
        [CORE_NAME]: { run: './override.sh', scope: 'full' }
      }
    })
    stubCheck(repo, 'agree.sh', 'myteam/agree')
    stubCheck(repo, 'override.sh', 'config-override')

    const plan = await runCli(['check', '--plan', '--json'], repo, home)
    expect(plan.code).toBe(0)

    const run = await runCli(['check', '--all', '--json'], repo, home)
    const expected = planNames(plan.stdout).filter((n) => !WITHHELD.has(n))

    expect(executedNames(run.stdout).sort()).toEqual(expected.sort())
    expect(expected).toContain('myteam/agree')
  }, 120000)
})

describe('vinaya check — FAIL_CLOSED refuses the whole run', () => {
  it('refuses entirely on a malformed entry: exit 1, no check outcome at all', async () => {
    // `scope` missing — a schema failure, not a resolvable entry.
    const { repo, home } = fixture({ checks: { 'myteam/broken': { run: './broken.sh' } } })

    const run = await runCli(['check', '--all', '--json'], repo, home)

    expect(run.code).toBe(1)
    expect(executedNames(run.stdout)).toEqual(['config'])
    expect(run.stdout).toContain('refusing to run any check')
    // The decisive assertion: not one real check ran.
    expect(executedNames(run.stdout)).not.toContain(CORE_NAME)
  }, 120000)

  it('refuses on a bare un-namespaced key, naming the rename requirement and its grace-period caveat', async () => {
    const { repo, home } = fixture({ checks: { my_check: { run: './my.sh', scope: 'full' } } })
    stubCheck(repo, 'my.sh', 'my_check')

    const run = await runCli(['check', '--all'], repo, home)

    expect(run.code).toBe(1)
    expect(run.stdout).toContain('refused — no checks ran')
    expect(run.stdout).toContain('my_check')
    expect(run.stdout).not.toContain(`✓ ${CORE_NAME}`)

    // The rejection must name the rename requirement AND its grace-period
    // caveat: prefixing alone is not enough when the bare name itself breaks
    // the segment grammar — `my_check` needs a real rename, not just a prefix.
    expect(run.stdout).toContain('<yourname>/<id>')
    expect(run.stdout).toContain('prefixing alone is not enough')
    expect(run.stdout).toContain('a real rename')
  }, 120000)

  it('a named single check is refused too — FAIL_CLOSED is not an `--all`-only property', async () => {
    const { repo, home } = fixture({ checks: { my_check: { run: './my.sh', scope: 'full' } } })
    stubCheck(repo, 'my.sh', 'my_check')

    const run = await runCli(['check', CORE_NAME], repo, home)

    expect(run.code).toBe(1)
    expect(run.stdout).toContain('refused — no checks ran')
  }, 120000)
})

describe('vinaya check — same-name-as-core REPLACES', () => {
  it('runs the config spec once under the core id, and the core check not at all', async () => {
    const { repo, home } = fixture({ checks: { [CORE_NAME]: { run: './override.sh', scope: 'full' } } })
    stubCheck(repo, 'override.sh', 'replacement')

    const run = await runCli(['check', '--all', '--json'], repo, home)
    const names = executedNames(run.stdout)

    // Not duplicated: exactly one outcome carries the core id (pre-flip the
    // flat concat produced two, one core and one config).
    expect(names.filter((n) => n === CORE_NAME)).toHaveLength(1)
    // And the one that ran is the CONFIG spec — its stub's own finding.
    expect(run.stderr).toContain('ran replacement')

    const plan = JSON.parse((await runCli(['check', '--plan', '--json'], repo, home)).stdout)
    expect(plan.checks[CORE_NAME]).toMatchObject({ state: 'overridden', source: 'config' })
  }, 120000)
})

describe('vinaya check — substitution is announced on the surface that enforces', () => {
  it('prints a notice and emits a warning finding when a core check is replaced', async () => {
    const { repo, home } = fixture({ checks: { [CORE_NAME]: { run: './override.sh', scope: 'full' } } })
    stubCheck(repo, 'override.sh', 'replacement')

    const run = await runCli(['check', '--all'], repo, home)

    // Human surface: the CI log for a substituted gate must not read
    // byte-identically to the real gate's.
    expect(run.stdout).toContain('REPLACES that core check')
    expect(run.stdout).toContain(CORE_NAME)

    // Machine surface: one well-formed `warning` CheckError on stderr.
    const findings = run.stderr
      .split('\n')
      .filter((l) => l.trim().startsWith('{'))
      .map((l) => JSON.parse(l) as { check: string; severity: string; message: string })
    const notice = findings.find((f) => f.severity === 'warning' && f.message.includes('REPLACES'))
    expect(notice).toBeDefined()
    expect(notice?.check).toBe('config')
  }, 120000)

  it('says nothing when no core check is replaced — the notice is not noise', async () => {
    const { repo, home } = fixture({ checks: { 'myteam/only-additive': { run: './add.sh', scope: 'full' } } })
    stubCheck(repo, 'add.sh', 'myteam/only-additive')

    const run = await runCli(['check', '--all'], repo, home)

    expect(run.stdout).not.toContain('REPLACES that core check')
  }, 120000)
})

describe('duplicateIdFailures — the execution-boundary invariant', () => {
  const entry = (name: string) =>
    ({
      name,
      state: 'default',
      source: 'core',
      spec: { name, run: './x.sh', scope: 'full' }
    }) as const

  it('passes a set of distinct ids', () => {
    expect(duplicateIdFailures([entry('a'), entry('b')])).toEqual([])
  })

  it('reports a duplicated id exactly once, however many times it repeats', () => {
    const failures = duplicateIdFailures([entry('a'), entry('a'), entry('a'), entry('b')])
    expect(failures).toHaveLength(1)
    expect(failures[0]?.key).toBe('a')
    expect(failures[0]?.reason).toContain('duplicate check id')
  })
})
