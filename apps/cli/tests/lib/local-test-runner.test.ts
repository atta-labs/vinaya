/**
 * The repository's native local push adapter (`scripts/test-suites/local-run.ts`): the plan a push freezes from the
 * shared selector, its run once per native runner group, and the head-bound result, records and receipt the run
 * leaves. The runner groups below start real Bun processes; the plan and the verdicts are checked on fixtures.
 */
import { describe, expect, it } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  completionOf,
  type LocalRunOutcome,
  localNativePlan,
  nativeContext,
  recordLocalRun,
  runFrozenPlan
} from '../../../../scripts/test-suites/local-run'
import { type RunResult, runGroups } from '../../../../scripts/test-suites/schedule'
import {
  computeVerificationContext,
  FAILED_TESTS_RECORD,
  LAST_PUSH_RESULT,
  type NativeSelection,
  readJsonUnderGit,
  type SelectionNote,
  writeJsonUnderGit
} from '../../src/lib/pre-push-failed-tests'
import { lookupGreenRun, type TestRunCacheRecord } from '../../src/lib/pr-report-engine'
import { nativeRunCommand, parseNativeRunCommand, REPOSITORY_LOCAL_RUN } from '../../src/lib/pre-push-test-runner'
import type { InventoryView, NativeGroup, SelectionPlan, TestIdentity } from '../../src/lib/verification/index'
import { fixtureDir } from './test-temp-fixture'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

const identity = (id: string, suite: string, over: Partial<TestIdentity> = {}): TestIdentity => ({
  id,
  suite,
  owner: suite === 'cli' ? '@attalabs/vinaya' : suite === 'aeg-core' ? '@attalabs/aeg-core' : '@vinaya/portal',
  kind: 'workspace',
  runner: suite === 'aeg-core' ? 'vitest' : 'bun',
  cwd: suite === 'cli' ? 'apps/cli' : suite === 'aeg-core' ? 'packages/aeg-core' : 'apps/vinaya-portal',
  preload: null,
  environment: suite === 'cli' ? { timeoutMs: 30000 } : {},
  ...over
})

const TESTS = [
  identity('apps/cli/tests/a.test.ts', 'cli'),
  identity('apps/cli/tests/b.test.ts', 'cli'),
  identity('apps/cli/tests/failed.test.ts', 'cli'),
  identity('packages/aeg-core/src/x.test.ts', 'aeg-core'),
  identity('packages/aeg-core/src/y.test.ts', 'aeg-core'),
  identity('apps/vinaya-portal/src/p.test.ts', 'portal')
]

const suite = (id: string, owner: string, dir: string, runner: 'bun' | 'vitest') => ({
  id,
  owner,
  kind: 'workspace' as const,
  dir,
  cwd: dir,
  runner,
  preload: null,
  environment: {},
  configFiles: [],
  include: [],
  exclude: []
})

const VIEW = {
  revision: 'h'.repeat(40),
  contextIdentity: 'inventory-context',
  suites: [
    suite('cli', '@attalabs/vinaya', 'apps/cli', 'bun'),
    suite('aeg-core', '@attalabs/aeg-core', 'packages/aeg-core', 'vitest'),
    suite('portal', '@vinaya/portal', 'apps/vinaya-portal', 'bun')
  ],
  tests: TESTS
} as unknown as InventoryView

const plan = (over: Partial<SelectionPlan> = {}): SelectionPlan =>
  ({
    identity: 'plan',
    changes: [],
    required: [],
    fallbacks: [],
    obligations: [],
    removedTests: [],
    ...over
  }) as unknown as SelectionPlan

const required = (test: string) => ({ test, suite: 'cli', runner: 'bun' as const, reasons: [] })

describe('the plan a push freezes', () => {
  it('runs each planned test and each unresolved failed test once, grouped by its own runner', () => {
    const local = localNativePlan({
      plan: plan({ required: [required('apps/cli/tests/a.test.ts')] }),
      view: VIEW,
      obligations: ['apps/cli/tests/failed.test.ts', 'apps/cli/tests/a.test.ts']
    })
    expect(local.problems).toEqual([])
    expect(local.groups.map((g) => [g.id, g.scope, g.tests])).toEqual([
      ['cli@default', 'files', ['apps/cli/tests/a.test.ts', 'apps/cli/tests/failed.test.ts']]
    ])
    expect(local.identities).toEqual(['apps/cli/tests/a.test.ts@default', 'apps/cli/tests/failed.test.ts@default'])
  })

  it('a suite its runner cannot narrow runs whole, with its reason, before anything starts', () => {
    const local = localNativePlan({
      plan: plan({ required: [{ ...required('packages/aeg-core/src/x.test.ts'), suite: 'aeg-core' }] }),
      view: VIEW,
      obligations: []
    })
    expect(local.groups.map((g) => [g.id, g.scope, g.tests])).toEqual([
      ['aeg-core@default', 'suite', ['packages/aeg-core/src/x.test.ts', 'packages/aeg-core/src/y.test.ts']]
    ])
    expect(local.expanded).toEqual([{ suite: 'aeg-core', reason: expect.stringContaining('runs whole') }])
  })

  it('a change under a suite whose inputs the selection does not model runs that suite whole', () => {
    const local = localNativePlan({
      plan: plan({ changes: [{ path: 'apps/vinaya-portal/src/page.tsx', status: 'modified', accountedBy: [] }] }),
      view: VIEW,
      obligations: []
    })
    expect(local.groups.map((g) => [g.id, g.scope])).toEqual([['portal@default', 'suite']])
  })

  it('an empty plan starts nothing, and a removed test is never run', () => {
    expect(localNativePlan({ plan: plan(), view: VIEW, obligations: [] })).toMatchObject({ groups: [], identities: [] })
    expect(
      localNativePlan({
        plan: plan({ required: [required('apps/cli/tests/a.test.ts')], removedTests: ['apps/cli/tests/a.test.ts'] }),
        view: VIEW,
        obligations: []
      }).groups
    ).toEqual([])
  })

  it('a planned test the head inventory does not hold is a problem, never dropped', () => {
    const local = localNativePlan({
      plan: plan({ required: [required('apps/cli/tests/gone.test.ts')] }),
      view: VIEW,
      obligations: []
    })
    expect(local.problems).toEqual([expect.objectContaining({ code: 'missing', path: 'apps/cli/tests/gone.test.ts' })])
  })
})

// ── The verdict of a run ─────────────────────────────────────────────────────

const GROUP: NativeGroup = {
  id: 'cli@default',
  suite: 'cli',
  owner: '@attalabs/vinaya',
  kind: 'workspace',
  runner: 'bun',
  cwd: 'apps/cli',
  preload: null,
  environment: {},
  configuration: 'default',
  scope: 'files',
  reason: null,
  tests: ['apps/cli/tests/a.test.ts', 'apps/cli/tests/b.test.ts'],
  args: ['./tests/a.test.ts', './tests/b.test.ts'],
  exclude: []
}

const nativeOf = (groups: NativeGroup[], context = 'ctx'): NativeSelection => ({
  version: 1,
  base: 'm'.repeat(40),
  baseKind: 'merge-base',
  plan: 'plan',
  inventory: 'inventory-context',
  context,
  identities: groups.flatMap((g) => g.tests.map((t) => `${t}@${g.configuration}`)).sort(),
  obligations: [],
  groups,
  expanded: [],
  command: groups.length > 0 ? nativeRunCommand('c'.repeat(64), ['x@default']) : null
})

const ran = (over: Partial<RunResult> = {}): RunResult => ({
  failedRunners: [],
  problems: [],
  executions: [{ group: 'cli@default', outcome: 'completed', files: ['tests/a.test.ts', 'tests/b.test.ts'] }],
  failedTests: {},
  ...over
})

const verdict = (
  result: RunResult | null,
  over: { state?: () => string | null; context?: () => string | null } = {}
) => {
  let calls = 0
  const outcome = runFrozenPlan('/repo', nativeOf(result === null ? [] : [GROUP]), {
    run: () => {
      calls++
      return result as RunResult
    },
    state: over.state ?? (() => 'same'),
    context: over.context ?? (() => 'ctx'),
    roots: ['/repo']
  })
  return { outcome, calls }
}

describe('the verdict of a native run', () => {
  it('a complete green run of exactly the plan passes', () => {
    const { outcome } = verdict(ran())
    expect(outcome).toMatchObject({ passed: true, failed: [], drift: null })
    expect(outcome.completion.executed).toEqual([
      'apps/cli/tests/a.test.ts@default',
      'apps/cli/tests/b.test.ts@default'
    ])
  })

  it('an empty plan starts no runner and passes', () => {
    const { outcome, calls } = verdict(null)
    expect(calls).toBe(0)
    expect(outcome.passed).toBe(true)
  })

  it('a failing runner names its failing tests', () => {
    const { outcome } = verdict(
      ran({ failedRunners: ['cli@default'], failedTests: { 'cli@default': ['apps/cli/tests/b.test.ts'] } })
    )
    expect(outcome).toMatchObject({ passed: false, failed: ['apps/cli/tests/b.test.ts'] })
  })

  it.each([
    [
      'a missing file',
      ran({ executions: [{ group: 'cli@default', outcome: 'completed', files: ['tests/a.test.ts'] }] })
    ],
    [
      'an extra file',
      ran({
        executions: [
          {
            group: 'cli@default',
            outcome: 'completed',
            files: ['tests/a.test.ts', 'tests/b.test.ts', 'tests/c.test.ts']
          }
        ]
      })
    ],
    [
      'a file run twice',
      ran({
        executions: [
          {
            group: 'cli@default',
            outcome: 'completed',
            files: ['tests/a.test.ts', 'tests/b.test.ts', 'tests/b.test.ts']
          }
        ]
      })
    ],
    ['an unreadable report', ran({ executions: [{ group: 'cli@default', outcome: 'unreadable', files: [] }] })],
    [
      'an interrupted runner',
      ran({ executions: [{ group: 'cli@default', outcome: 'signaled', detail: 'SIGTERM', files: [] }] })
    ],
    ['no report at all', ran({ executions: [] })]
  ])('%s never establishes a pass, whatever the exit status', (_name, result) => {
    const problems = completionOf([GROUP], result, ['/repo']).problems
    expect(problems.length).toBeGreaterThan(0)
    const { outcome } = verdict(result)
    expect(outcome.passed).toBe(false)
    expect(outcome.failed).toBe('all')
  })

  it('a head or tree that moved during the run, or a changed context, proves nothing', () => {
    let state = 0
    expect(verdict(ran(), { state: () => `s${state++}` }).outcome).toMatchObject({
      passed: false,
      drift: expect.stringContaining('tracked tree')
    })
    let context = 0
    expect(verdict(ran(), { context: () => (context++ === 0 ? 'ctx' : 'other') }).outcome).toMatchObject({
      passed: false,
      drift: expect.stringContaining('verification context')
    })
    expect(verdict(ran(), { context: () => null }).outcome.passed).toBe(false)
  })
})

// ── Real runner starts ───────────────────────────────────────────────────────

describe('real native runner starts', () => {
  function suiteDir(files: Record<string, string>): string {
    const dir = realpathSync(fixtureDir('local-run-native-'))
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
    return dir
  }
  const pass = `import { test } from 'bun:test'\ntest('ok', () => {})\n`
  const fail = `import { expect, test } from 'bun:test'\ntest('bad', () => expect(1).toBe(2))\n`
  const group = (tests: string[], environment: NativeGroup['environment'] = {}): NativeGroup => ({
    ...GROUP,
    cwd: '.',
    environment,
    tests,
    args: tests.map((t) => `./${t}`)
  })

  it('every scheduled file executes once and the report confirms exactly those identities', () => {
    const dir = suiteDir({ 'a.test.ts': pass, 'b.test.ts': pass })
    const g = group(['a.test.ts', 'b.test.ts'])
    const result = runGroups(dir, [g], { log: () => {} })
    expect(result.failedRunners).toEqual([])
    expect(completionOf([g], result, [dir])).toMatchObject({
      completed: true,
      executed: ['a.test.ts@default', 'b.test.ts@default'],
      problems: []
    })
  })

  it('a failing file is named, and a file over its own timeout fails rather than reading green', () => {
    const slow = `import { test } from 'bun:test'\ntest('slow', async () => { await new Promise((r) => setTimeout(r, 2000)) })\n`
    const dir = suiteDir({ 'a.test.ts': pass, 'b.test.ts': fail, 'c.test.ts': slow })
    const g = group(['a.test.ts', 'b.test.ts', 'c.test.ts'], { timeoutMs: 200 })
    const result = runGroups(dir, [g], { log: () => {} })
    expect(result.failedRunners).toEqual(['cli@default'])
    expect(result.failedTests['cli@default']).toEqual(['b.test.ts', 'c.test.ts'])
  })

  it('a runner killed mid-run is interrupted: no executed identity, no pass', () => {
    const dir = suiteDir({
      'a.test.ts': `import { test } from 'bun:test'\ntest('die', () => { process.kill(process.pid, 'SIGKILL') })\n`
    })
    const g = group(['a.test.ts'])
    const result = runGroups(dir, [g], { log: () => {} })
    expect(result.executions[0]?.outcome).toBe('signaled')
    expect(result.failedTests['cli@default']).toBe('all')
    const completion = completionOf([g], result, [dir])
    expect(completion.completed).toBe(false)
    expect(completion.executed).toEqual([])
  })

  it('a runner never sees the git variables of the hook that started it', () => {
    const probe = join(fixtureDir('local-run-env-'), 'env.json')
    const dir = suiteDir({
      'a.test.ts': `import { test } from 'bun:test'\nimport { writeFileSync } from 'node:fs'\ntest('env', () => writeFileSync(${JSON.stringify(probe)}, JSON.stringify(Object.keys(process.env).filter((k) => k.startsWith('GIT_')))))\n`
    })
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_DIR: '/nowhere', GIT_CONFIG_KEY_0: 'x' }
    const cleaned: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(env)) if (!key.startsWith('GIT_')) cleaned[key] = value
    runGroups(dir, [group(['a.test.ts'])], { log: () => {}, env: cleaned })
    expect(JSON.parse(readFileSync(probe, 'utf8'))).toEqual([])
  })
})

// ── What a run records ───────────────────────────────────────────────────────

describe('what a native run records', () => {
  const memoryCache = () => {
    const store = new Map<string, TestRunCacheRecord>()
    return {
      get: (key: string) => store.get(key),
      set: (key: string, record: TestRunCacheRecord) => void store.set(key, record)
    }
  }
  function repo(): { dir: string; head: string } {
    const dir = realpathSync(fixtureDir('local-run-record-'))
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, stdio: 'ignore' })
    writeFileSync(join(dir, 'a.test.ts'), 'x\n')
    git('init', '-q', '-b', 'task/x/1')
    git('add', '.')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base')
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8', env }).trim()
    return { dir, head }
  }
  const frozen = (dir: string, head: string, identities: string[]): SelectionNote => {
    const context = nativeContext(computeVerificationContext(dir)?.digest ?? null, 'inventory-context') as string
    const groups = identities.length > 0 ? [{ ...GROUP, cwd: '.', tests: ['a.test.ts'], args: ['./a.test.ts'] }] : []
    return {
      version: 1,
      mode: 'full',
      head,
      fullCount: identities.length,
      selected: identities.map(() => join(dir, 'a.test.ts')),
      context,
      native: {
        ...nativeOf(groups, context),
        identities,
        command: identities.length > 0 ? nativeRunCommand(context, identities) : null
      }
    }
  }
  const green = (identities: string[]): LocalRunOutcome => ({
    passed: true,
    failed: [],
    drift: null,
    completion: { version: 1, completed: true, executed: identities, failedRunners: [], problems: [] }
  })

  it('a complete green run leaves the passing record, the head-bound result and a receipt under its own context', async () => {
    const { dir, head } = repo()
    const note = frozen(dir, head, ['a.test.ts@default'])
    const cache = memoryCache()
    const { receipt } = await recordLocalRun({
      repoRoot: dir,
      note,
      outcome: green(['a.test.ts@default']),
      log: ' 1 pass',
      elapsedSeconds: 1,
      mode: 'ready',
      cache
    })
    expect(receipt).toBe(true)
    expect(JSON.parse(readJsonUnderGit(dir, FAILED_TESTS_RECORD) as string)).toMatchObject({
      version: 2,
      kind: 'passed',
      head,
      context: note.native?.context
    })
    expect(JSON.parse(readJsonUnderGit(dir, LAST_PUSH_RESULT) as string)).toMatchObject({
      head,
      mode: 'ready',
      outcome: 'passed',
      selectionCompleted: true,
      native: { completed: true, executed: ['a.test.ts@default'] }
    })
    const reused = await lookupGreenRun(note.native?.command as string, dir, cache)
    expect(reused?.output).toBe(' 1 pass')
  })

  it('a refused run leaves its failed record under its context, and no receipt', async () => {
    const { dir, head } = repo()
    const note = frozen(dir, head, ['a.test.ts@default'])
    const cache = memoryCache()
    const { receipt } = await recordLocalRun({
      repoRoot: dir,
      note,
      outcome: {
        passed: false,
        failed: ['a.test.ts'],
        drift: null,
        completion: {
          version: 1,
          completed: true,
          executed: ['a.test.ts@default'],
          failedRunners: ['cli@default'],
          problems: []
        }
      },
      log: ' 1 fail',
      elapsedSeconds: 1,
      mode: 'default',
      cache
    })
    expect(receipt).toBe(false)
    expect(JSON.parse(readJsonUnderGit(dir, FAILED_TESTS_RECORD) as string)).toMatchObject({
      version: 1,
      head,
      failed: [join(dir, 'a.test.ts')],
      selectionCompleted: true,
      context: note.native?.context
    })
    expect(await lookupGreenRun(note.native?.command as string, dir, cache)).toBeNull()
  })

  it('a green run on an uncommitted tree leaves no passing record; drift leaves no proof at all', async () => {
    const { dir, head } = repo()
    writeFileSync(join(dir, 'a.test.ts'), 'edited\n')
    await recordLocalRun({
      repoRoot: dir,
      note: frozen(dir, head, ['a.test.ts@default']),
      outcome: green(['a.test.ts@default']),
      log: '',
      elapsedSeconds: 1,
      mode: 'ready',
      cache: memoryCache()
    })
    expect(readJsonUnderGit(dir, FAILED_TESTS_RECORD)).toBeNull()
    const cache = memoryCache()
    const note = frozen(dir, head, ['a.test.ts@default'])
    const { receipt } = await recordLocalRun({
      repoRoot: dir,
      note,
      outcome: {
        ...green(['a.test.ts@default']),
        passed: false,
        drift: 'the head or the tracked tree changed during the run'
      },
      log: '',
      elapsedSeconds: 1,
      mode: 'ready',
      cache
    })
    expect(receipt).toBe(false)
    expect(JSON.parse(readJsonUnderGit(dir, LAST_PUSH_RESULT) as string)).toMatchObject({
      outcome: 'failed',
      selectionCompleted: false
    })
  })

  it('a zero selection clears a stale refusal and records no command', async () => {
    const { dir, head } = repo()
    writeJsonUnderGit(dir, FAILED_TESTS_RECORD, {
      version: 1,
      head,
      branch: 'task/x/1',
      failed: ['x'],
      recordedAt: 'now'
    })
    const { receipt } = await recordLocalRun({
      repoRoot: dir,
      note: frozen(dir, head, []),
      outcome: green([]),
      log: '',
      elapsedSeconds: 0,
      mode: 'default',
      cache: memoryCache()
    })
    expect(receipt).toBe(false)
    expect(readJsonUnderGit(dir, FAILED_TESTS_RECORD)).toBeNull()
  })
})

describe('the generated hook hands every test-running push to the adapter', () => {
  it('after the deferral decision, with the git variables removed first, and its verdict is the run step’s exit', () => {
    const hook = readFileSync(join(REPO_ROOT, '.vinaya', 'hooks', 'pre-push'), 'utf8')
    const deferral = hook.indexOf('if [ "$VINAYA_READY_TESTS" = "deferred" ]')
    const native = hook.indexOf(`if [ -f ${REPOSITORY_LOCAL_RUN} ]`)
    const unset = hook.indexOf('unset', native)
    const select = hook.indexOf(`bun ${REPOSITORY_LOCAL_RUN} select`)
    const run = hook.indexOf(`bun ${REPOSITORY_LOCAL_RUN} run --log`)
    expect(deferral).toBeGreaterThan(0)
    expect(native).toBeGreaterThan(deferral)
    expect(unset).toBeGreaterThan(native)
    expect(select).toBeGreaterThan(unset)
    expect(run).toBeGreaterThan(select)
    expect(hook.slice(run, hook.indexOf('\nfi\n', run))).toContain('exit "$VINAYA_TEST_STATUS"')
  })
})

// ── The real adapter on a fixture clone ──────────────────────────────────────

describe('the real adapter, select then run, on a fixture clone of this head', () => {
  const env = (): NodeJS.ProcessEnv => {
    const out: NodeJS.ProcessEnv = { ...process.env }
    for (const key of Object.keys(out)) if (key.startsWith('GIT_')) delete out[key]
    return out
  }
  // A test the shared selector always plans, so every push here runs the same small native group.
  const BOUNDARY = 'apps/cli/tests/import-boundary.test.ts'
  const INJECTED =
    "import { test as injectedTest } from 'bun:test'\ninjectedTest('injected failure', () => { throw new Error('injected') })\n"

  function clone() {
    const dir = join(fixtureDir('native-adapter-'), 'repo')
    execFileSync('git', ['clone', '-q', '--no-hardlinks', REPO_ROOT, dir], { env: env(), stdio: 'ignore' })
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        cwd: dir,
        env: env(),
        encoding: 'utf8'
      }).trim()
    git('update-ref', 'refs/remotes/origin/main', 'HEAD')
    git('checkout', '-q', '-b', 'task/x/1')
    // The clone shares this checkout's installed dependencies.
    for (const pkg of ['.', 'apps/cli', 'packages/sources', 'packages/aeg-core', 'processes/vinaya']) {
      const from = join(REPO_ROOT, pkg, 'node_modules')
      if (existsSync(from) && !existsSync(join(dir, pkg, 'node_modules')))
        symlinkSync(from, join(dir, pkg, 'node_modules'))
    }
    const step = (sub: 'select' | 'run') => {
      const args =
        sub === 'select' ? [REPOSITORY_LOCAL_RUN, 'select'] : [REPOSITORY_LOCAL_RUN, 'run', '--log', '/dev/null']
      const run = spawnSync('bun', args, { cwd: dir, env: env(), encoding: 'utf8', timeout: 240_000 })
      return { status: run.status ?? -1, out: `${run.stdout}${run.stderr}` }
    }
    return { dir, git, step }
  }
  const json = (dir: string, file: string) =>
    JSON.parse(readJsonUnderGit(dir, file) as string) as Record<string, unknown> & {
      native?: { executed: string[] }
      selection?: { native?: NativeSelection }
    }

  it('initial green, unchanged head, refused failure and its repair: each push runs exactly its frozen native plan and records it', () => {
    const { dir, git, step } = clone()
    // Initial: compared with the merge base; every planned identity executed once; a passing record.
    appendFileSync(join(dir, BOUNDARY), '// initial\n')
    git('commit', '-qam', 'initial')
    const select = step('select')
    expect(select.status).toBe(0)
    expect(select.out).toContain('compared with merge-base')
    expect(select.out.split('\n').some((line) => line.endsWith(`/${BOUNDARY}`))).toBe(true)
    expect(step('run').status).toBe(0)
    const green = json(dir, LAST_PUSH_RESULT)
    expect(green).toMatchObject({ outcome: 'passed', selectionCompleted: true, native: { completed: true } })
    const plan = green.selection?.native as NativeSelection
    expect([...(green.native?.executed ?? [])].sort()).toEqual([...plan.identities].sort())
    expect(parseNativeRunCommand(plan.command as string)?.identities).toEqual(plan.identities)
    expect(json(dir, FAILED_TESTS_RECORD)).toMatchObject({ kind: 'passed', head: git('rev-parse', 'HEAD') })

    // Unchanged head: builds on the pass; only the mandatory tests remain, each run once.
    expect(step('select').out).toContain('compared with since-green')
    expect(step('run').status).toBe(0)
    const again = json(dir, LAST_PUSH_RESULT)
    const mandatory = again.selection?.native as NativeSelection
    expect(mandatory.baseKind).toBe('since-green')
    expect([...(again.native?.executed ?? [])].sort()).toEqual([...mandatory.identities].sort())

    // A failure: refused, the failing file named and kept as the next push's obligation.
    appendFileSync(join(dir, BOUNDARY), INJECTED)
    git('commit', '-qam', 'break')
    expect(step('select').status).toBe(0)
    const refused = step('run')
    expect(refused.status).toBe(1)
    expect(refused.out).toContain(`failing: ${BOUNDARY}`)
    expect(json(dir, FAILED_TESTS_RECORD)).toMatchObject({
      failed: [expect.stringMatching(/\/apps\/cli\/tests\/import-boundary\.test\.ts$/)],
      selectionCompleted: true
    })

    // The repair: compared with the refused head, the failed test re-run as an obligation, green again.
    writeFileSync(join(dir, BOUNDARY), readFileSync(join(dir, BOUNDARY), 'utf8').replace(INJECTED, ''))
    git('commit', '-qam', 'repair')
    const repair = step('select')
    expect(repair.out).toContain('compared with rerun')
    expect(repair.out).toContain(`re-running unresolved failed test ${BOUNDARY}`)
    expect(step('run').status).toBe(0)
    expect(json(dir, LAST_PUSH_RESULT)).toMatchObject({ outcome: 'passed', native: { completed: true } })
  }, 600_000)
})
