/**
 * The CI test schedule: every inventory test placed exactly once, shards
 * assigned deterministically, the same identity set kept by local grouping
 * and CI placement, and real Bun and Vitest runs checked against the files
 * each was given — sibling paths that collide as substrings after a
 * relocation, a missing file, extra execution, a repeated group, an
 * interrupted run and an unreadable report among them.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parse } from 'yaml'
import {
  CI_SHARD_COUNT,
  CI_SHARD_LIST_OWNER
} from '../../harness/processes/vinaya-strict/checks/ci-shard-membership.ts'
import { groupNativeTests, type NativeGroup, type NativeTestRequest, type TestIdentity } from '@attalabs/test-selection'
import {
  createTestTempRun,
  OWNER_MARKER_FILE,
  removeTestTempRun,
  TEST_TEMP_ROOT_ENV,
  type TestTempRun
} from '../../harness/kernel/conformance/unit/test-temp.ts'
import { type InventoryView, readTestInventory } from './inventory-check.ts'
import {
  assignShards,
  buildTestSchedule,
  bunJunitFiles,
  bunReportedFiles,
  checkSchedule,
  ciScheduleInput,
  FILES_PER_RUNNER,
  GROUP_TIME_LIMIT_MS,
  type GroupOutcome,
  groupOutcomeOf,
  OUTPUT_DRAIN_MS,
  type RunnerStart,
  readShardLists,
  runGroups,
  runnerCommand,
  runTestTempRoot,
  SCHEDULE_TEST_TEMP_REPO_ID,
  startRunner,
  TEST_CONCURRENCY_ENV,
  testConcurrency,
  vitestJsonFiles
} from './schedule.ts'

const REPO_ROOT = join(import.meta.dir, '../..')
const view = readTestInventory(REPO_ROOT).head
const shardLists = readShardLists(REPO_ROOT, view)

function fullSchedule(v: InventoryView = view, lists: readonly (readonly string[])[] = shardLists) {
  const input = ciScheduleInput(v, { scope: 'all', reason: 'a push to the default branch' })
  return { input, schedule: buildTestSchedule({ view: v, shardLists: lists, ...input }) }
}

const expectedOf = (input: ReturnType<typeof ciScheduleInput>): NativeTestRequest[] => [
  ...input.selected,
  ...input.wholeSuites.flatMap((w) => w.identities.map((t) => ({ ...t, configuration: w.configuration })))
]

describe('the full schedule of this repository', () => {
  const { input, schedule } = fullSchedule()

  test('places every inventory test exactly once, every owner and native runner included', () => {
    expect(checkSchedule(schedule, expectedOf(input))).toEqual([])
    expect(schedule.accounting.map((e) => e.test).sort()).toEqual(view.tests.map((t) => t.id).sort())
    const suites = new Set(Object.values(schedule.placements).flatMap((groups) => (groups ?? []).map((g) => g.suite)))
    expect([...suites].sort()).toEqual(view.suites.map((s) => s.id).sort())
  })

  test('root-suite tests are placed in the build job, whose unconditional steps run exactly them, each once', () => {
    const build = schedule.accounting
      .filter((e) => e.placement === 'build')
      .map((e) => e.test)
      .sort()
    const ofKind = (kind: TestIdentity['kind']) =>
      view.tests
        .filter((t) => t.kind === kind)
        .map((t) => t.id)
        .sort()
    expect(build).toEqual([...ofKind('repository'), ...ofKind('compatibility')].sort())
    const workflow = parse(readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8')) as {
      jobs: Record<string, { steps: { name?: string; if?: string; run?: string }[] }>
    }
    const listedBy = (name: string) => {
      const step = workflow.jobs.build?.steps.find((s) => s.name === name)
      expect(step?.if).toBeUndefined()
      const listed = (step?.run ?? '')
        .split('\n')
        .find((line) => line.trim().startsWith('bun test '))
        ?.trim()
        .split(/\s+/)
        .slice(2)
      expect(listed?.every((path) => path.startsWith('./'))).toBe(true)
      return (listed ?? []).map((path) => path.slice(2)).sort()
    }
    const repository = listedBy('Check the test inventory and run the repository suite')
    const compatibility = listedBy('Check every published package against its compatibility snapshot')
    expect(repository).toEqual(ofKind('repository'))
    expect(compatibility).toEqual(ofKind('compatibility'))
    expect([...repository, ...compatibility].sort()).toEqual(build)
    // The schedule tests themselves are among them, and so is the package-compatibility suite.
    expect(build).toContain('scripts/test-suites/schedule.test.ts')
    expect(build).toContain('scripts/test-suites/staged-driver-move.test.ts')
    expect(build).toContain('scripts/package-compat/package-compat.test.ts')
  })

  test('Vitest suites and other owners run in the shared job; CLI, kernel and process Bun tests in the shards', () => {
    for (const entry of schedule.accounting) {
      const t = view.tests.find((x) => x.id === entry.test) as TestIdentity
      if (t.kind === 'repository') continue
      const sharded =
        t.runner === 'bun' && ['@attalabs/vinaya', '@attalabs/harness', '@attalabs/process-vinaya'].includes(t.owner)
      expect(`${entry.test} ${entry.placement.startsWith('shard-')}`).toBe(`${entry.test} ${sharded}`)
    }
    // A full run asks for each Vitest suite whole, with its reason stated, and starts it one file per runner.
    for (const group of schedule.placements.shared ?? [])
      if (group.runner === 'vitest') expect([group.tests.length, typeof group.reason]).toEqual([1, 'string'])
  })

  test('every runner start serves one file, under its suite’s runner, folder, configuration, environment and preload', () => {
    const groups = Object.values(schedule.placements).flatMap((g) => g ?? [])
    expect(FILES_PER_RUNNER).toBe(1)
    expect(groups.length).toBe(schedule.accounting.length)
    expect(groups.filter((g) => g.tests.length !== 1).map((g) => g.id)).toEqual([])
    // Each placement is one CI job, whose runs are checked together: within it every group id is unique.
    for (const placed of Object.values(schedule.placements))
      expect(new Set((placed ?? []).map((g) => g.id)).size).toBe((placed ?? []).length)
    for (const group of groups) {
      const test = view.tests.find((t) => t.id === group.tests[0]) as TestIdentity
      expect([group.tests[0], group.suite, group.runner, group.cwd, group.preload, group.environment]).toEqual([
        test.id,
        test.suite,
        test.runner,
        test.cwd,
        test.preload,
        test.environment
      ])
      // A suite of several files gives each its own `#<k>of<n>` id under the suite and configuration.
      expect(group.id.startsWith(`${group.suite}@${group.configuration}`)).toBe(true)
    }
  })

  test('each CLI test keeps the shard its list names', () => {
    const cli = view.suites.find((s) => s.owner === CI_SHARD_LIST_OWNER)
    shardLists.forEach((list, i) => {
      for (const entry of list) expect(schedule.assignments[`${cli?.cwd}/${entry}`]).toBe(i + 1)
    })
  })

  test('is the same every time, with file counts no more uneven than the lists left them', () => {
    expect(fullSchedule().schedule).toEqual(schedule)
    const counts = Array.from(
      { length: CI_SHARD_COUNT },
      (_, i) => Object.values(schedule.assignments).filter((n) => n === i + 1).length
    )
    const listed = shardLists.map((l) => l.length)
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(
      Math.max(1, Math.max(...listed) - Math.min(...listed))
    )
  })
})

// ── Deterministic shards ───────────────────────────────────────────────────

function identity(id: string, owner: string, over: Partial<TestIdentity> = {}): TestIdentity {
  const cwd =
    owner === '@attalabs/vinaya'
      ? 'apps/cli'
      : owner === '@attalabs/process-vinaya'
        ? 'harness/processes/vinaya-strict'
        : 'harness'
  const suite =
    owner === '@attalabs/vinaya' ? 'cli' : owner === '@attalabs/process-vinaya' ? 'process-vinaya' : 'kernel'
  return { id, suite, owner, kind: 'workspace', runner: 'bun', cwd, preload: null, environment: {}, ...over }
}

function viewOf(tests: TestIdentity[]): InventoryView {
  const suites = [...new Map(tests.map((t) => [t.suite, t])).values()].map((t) => ({
    id: t.suite,
    owner: t.owner,
    kind: t.kind,
    dir: t.cwd,
    cwd: t.cwd,
    runner: t.runner,
    preload: t.preload,
    environment: t.environment,
    configFiles: [],
    include: [],
    exclude: []
  }))
  return { ...view, suites, tests }
}

describe('shard assignment', () => {
  const cli = (n: number) => identity(`apps/cli/tests/c${n}.test.ts`, '@attalabs/vinaya')
  const proc = (name: string) =>
    identity(`harness/processes/vinaya-strict/tests/${name}.test.ts`, '@attalabs/process-vinaya')
  const lists = [['tests/c1.test.ts', 'tests/c2.test.ts'], ['tests/c3.test.ts'], []]

  test('keeps listed shards, then fills the least-populated shard in identity order, ties to the lowest', () => {
    const v = viewOf([cli(1), cli(2), cli(3), proc('d'), proc('b'), proc('c'), proc('a')])
    const { assignments, problems } = assignShards(v, lists)
    expect(problems).toEqual([])
    expect(assignments).toEqual({
      'apps/cli/tests/c1.test.ts': 1,
      'apps/cli/tests/c2.test.ts': 1,
      'apps/cli/tests/c3.test.ts': 2,
      'harness/processes/vinaya-strict/tests/a.test.ts': 3,
      'harness/processes/vinaya-strict/tests/b.test.ts': 2,
      'harness/processes/vinaya-strict/tests/c.test.ts': 3,
      'harness/processes/vinaya-strict/tests/d.test.ts': 1
    })
    // Repeatable, and independent of the order the inventory lists tests in.
    expect(assignShards(viewOf([...v.tests].reverse()), lists).assignments).toEqual(assignments)
  })

  test('a listed path the listed owner no longer holds, or one listed twice, is a problem', () => {
    const v = viewOf([cli(1), cli(3)])
    const { problems } = assignShards(v, [
      ['tests/c1.test.ts', 'tests/c2.test.ts'],
      ['tests/c1.test.ts', 'tests/c3.test.ts']
    ])
    expect(problems.map((p) => `${p.code} ${p.path}`)).toEqual([
      'extra apps/cli/tests/c2.test.ts',
      'duplicate apps/cli/tests/c1.test.ts'
    ])
  })

  test('keeps a bounded file-count imbalance for any number of new files', () => {
    for (let extra = 0; extra < 12; extra++) {
      const v = viewOf([cli(1), cli(2), cli(3), ...Array.from({ length: extra }, (_, i) => proc(`p${i}`))])
      const { assignments } = assignShards(v, lists)
      const counts = [1, 2, 3].map((n) => Object.values(assignments).filter((s) => s === n).length)
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(2)
      if (extra >= 3) expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1)
    }
  })
})

// ── Local grouping and CI placement ────────────────────────────────────────

describe('local grouping and CI placement take the same identity set', () => {
  const root = view.tests.find((t) => t.kind === 'repository') as TestIdentity
  const cliTest = view.tests.find((t) => t.owner === CI_SHARD_LIST_OWNER) as TestIdentity
  const vitestTest = view.tests.find((t) => t.runner === 'vitest') as TestIdentity
  const requests: NativeTestRequest[] = [root, cliTest, { ...cliTest, configuration: 'root-config-probe' }, vitestTest]

  test('local grouping keeps the root obligation and both configurations of one file', () => {
    const { groups, problems } = groupNativeTests({ tests: requests, universe: view.tests })
    expect(problems).toEqual([])
    expect(groups.map((g) => g.id).sort()).toEqual(
      [
        `${root.suite}@default`,
        `${cliTest.suite}@default`,
        `${cliTest.suite}@root-config-probe`,
        `${vitestTest.suite}@default`
      ].sort()
    )
  })

  test('CI placement assigns the root test to the build job once and keeps both configurations', () => {
    const schedule = buildTestSchedule({ view, selected: requests, shardLists })
    expect(checkSchedule(schedule, requests)).toEqual([])
    expect(schedule.accounting.filter((e) => e.test === root.id)).toEqual([
      { test: root.id, configuration: 'default', placement: 'build' }
    ])
    const cliPlaces = schedule.accounting.filter((e) => e.test === cliTest.id)
    expect(cliPlaces.map((e) => e.configuration)).toEqual(['default', 'root-config-probe'])
    expect(new Set(cliPlaces.map((e) => e.placement)).size).toBe(1)
    expect(schedule.accounting.find((e) => e.test === vitestTest.id)?.placement).toBe('shared')
  })

  test('the schedule check fails a dropped or doubled test', () => {
    const schedule = buildTestSchedule({ view, selected: requests.slice(0, 2), shardLists })
    expect(checkSchedule(schedule, requests).map((p) => p.code)).toEqual(['missing', 'missing'])
    const doubled = buildTestSchedule({ view, selected: [...requests, cliTest], shardLists })
    expect(doubled.problems.map((p) => `${p.code} ${p.path}`)).toEqual([`duplicate ${cliTest.id}`])
    // An expectation listing a test twice is itself a repeat, never folded into one.
    const once = buildTestSchedule({ view, selected: requests, shardLists })
    expect(checkSchedule(once, [...requests, cliTest]).map((p) => `${p.code} ${p.path}`)).toEqual([
      `duplicate ${cliTest.id}@default`
    ])
  })

  test('a selected identity the inventory does not hold is reported, never defaulted to a shard', () => {
    const stray: TestIdentity = { ...cliTest, id: 'apps/cli/tests/not-in-the-inventory.test.ts' }
    const schedule = buildTestSchedule({ view, selected: [stray], shardLists })
    expect(schedule.problems.map((p) => `${p.code} ${p.path}`)).toEqual([`extra ${stray.id}`])
    expect(schedule.accounting).toEqual([])
  })
})

describe('what a CI run schedules', () => {
  const cliTest = view.tests.find((t) => t.owner === CI_SHARD_LIST_OWNER) as TestIdentity
  const forgeState = view.tests.find((t) => t.owner === '@attalabs/log-server') as TestIdentity

  test('a selected run schedules exactly the selection’s planned files, and adds none of its own', () => {
    const input = ciScheduleInput(view, { scope: 'selected', selected: [cliTest.id], native: [forgeState.id] })
    expect(input.reason).toBeNull()
    expect(input.selected.map((t) => t.id).sort()).toEqual([cliTest.id, forgeState.id].sort())
    // The root suites run because the selection's build-gate obligations plan them, never because the schedule adds them.
    expect(input.selected.map((t) => t.id)).not.toContain('scripts/package-compat/package-compat.test.ts')
    expect(input.wholeSuites).toEqual([])
  })

  test('a suite the selection runs whole runs every file of it, one runner start per file, in its place', () => {
    const portal = view.tests.filter((t) => t.owner === '@vinaya/portal').map((t) => t.id)
    expect(portal.length).toBeGreaterThan(0)
    const reason = 'the change touches a path under its folder, and the selection does not model the portal inputs'
    const decision = {
      scope: 'selected' as const,
      selected: portal,
      native: [],
      changed: ['apps/vinaya-portal/src/cms/utils/theme-corpus.fixture.json'],
      wholeSuites: [{ suite: 'portal', reason, tests: portal }]
    }
    const input = ciScheduleInput(view, decision)
    const whole = input.wholeSuites.find((w) => w.suite === 'portal')
    expect(whole?.reason).toBe(reason)
    expect(whole?.identities.map((t) => t.id).sort()).toEqual([...portal].sort())
    const schedule = buildTestSchedule({ view, shardLists, ...input })
    expect(checkSchedule(schedule, expectedOf(input))).toEqual([])
    const runs = (schedule.placements.shared ?? []).filter((g) => g.suite === 'portal')
    expect(runs.flatMap((g) => g.tests).sort()).toEqual([...portal].sort())
    for (const [k, g] of runs.entries())
      expect(g).toMatchObject({ id: `portal@default#${k + 1}of${portal.length}`, reason, cwd: 'apps/vinaya-portal' })
    expect(runs.every((g) => g.tests.length === 1 && g.args.length === 1)).toBe(true)
    expect(schedule.accounting.filter((e) => portal.includes(e.test)).map((e) => e.placement)).toEqual(
      portal.map(() => 'shared')
    )
    // A plan that runs no suite whole gives the schedule none.
    const elsewhere = ciScheduleInput(view, { ...decision, wholeSuites: [] })
    expect(elsewhere.wholeSuites.map((w) => w.suite)).toEqual([])
  })

  test('an unknown input runs everything, with its reason; so does a selected path the inventory does not hold', () => {
    const all = ciScheduleInput(view, {
      scope: 'all',
      reason: 'the selector cannot judge 1 changed path(s), first a.json'
    })
    expect(all.reason).toBe('the selector cannot judge 1 changed path(s), first a.json')
    expect(expectedOf(all)).toHaveLength(view.tests.length)
    const stray = ciScheduleInput(view, { scope: 'selected', selected: ['apps/cli/tests/not-a-test.test.ts'] })
    expect(stray.reason).toContain('apps/cli/tests/not-a-test.test.ts')
    expect(expectedOf(stray)).toHaveLength(view.tests.length)
  })
})

// ── Real runners ───────────────────────────────────────────────────────────

describe('report parsing', () => {
  test('a Bun JUnit report names each file once at the top level, nested suites ignored', () => {
    const xml = [
      '<?xml version="1.0"?>',
      '<testsuites name="bun test">',
      '  <testsuite name="a" file="tests/a&amp;b.test.ts"><testcase name="t" file="tests/a&amp;b.test.ts" /></testsuite>',
      '  <testsuite name="d" file="tests/d.test.ts"><testsuite name="inner" file="tests/d.test.ts"></testsuite></testsuite>',
      '</testsuites>'
    ].join('\n')
    expect(bunJunitFiles(xml)).toEqual(['tests/a&b.test.ts', 'tests/d.test.ts'])
    expect(bunJunitFiles('not xml')).toBeNull()
    expect(bunJunitFiles('<testsuites><testsuite file="x">')).toBeNull()
  })

  test('a Vitest JSON report names each file', () => {
    expect(vitestJsonFiles('{"testResults":[{"name":"/r/a.test.ts"}]}')).toEqual(['/r/a.test.ts'])
    expect(vitestJsonFiles('{"testResults":[{}]}')).toBeNull()
    expect(vitestJsonFiles('{')).toBeNull()
  })
})

const scratch: string[] = []
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

/** A repository with one Bun and one Vitest suite, each holding a relocated sibling whose path contains the other's. */
function runnerFixture(): { root: string; universe: TestIdentity[] } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'schedule-runners-')))
  scratch.push(root)
  const bunTest = "import { expect, test } from 'bun:test'\ntest('runs', () => expect(1).toBe(1))\n"
  const vitestTest = "import { expect, test } from 'vitest'\ntest('runs', () => expect(1).toBe(1))\n"
  const files: Record<string, string> = {
    'pkg/bun/package.json': '{ "name": "@fx/bun", "scripts": { "test": "bun test" } }\n',
    'pkg/bun/tests/a.test.ts': bunTest,
    'pkg/bun/moved/tests/a.test.ts': bunTest,
    // A synchronous child that never returns freezes Bun's whole runner: the test timeout cannot interrupt it.
    'pkg/bun/tests/freeze-once.test.ts': [
      "import { test } from 'bun:test'",
      "import { existsSync, writeFileSync } from 'node:fs'",
      "import { spawnSync } from 'node:child_process'",
      "test('freezes on its first run only', () => { const marker = `${import.meta.dir}/.froze`; if (!existsSync(marker)) { writeFileSync(marker, ''); spawnSync('sleep', ['600']) } })",
      ''
    ].join('\n'),
    'pkg/bun/tests/freeze.test.ts':
      "import { test } from 'bun:test'\nimport { spawnSync } from 'node:child_process'\ntest('always freezes', () => { spawnSync('sleep', ['600']) })\n",
    // An error thrown outside every test as the file loads: Bun reports "an unhandled error between tests", leaves the
    // file out of its report and exits non-zero.
    'pkg/bun/tests/load-reject.test.ts':
      "import { expect, test } from 'bun:test'\nPromise.reject(new Error('load reject'))\ntest('runs', () => expect(1).toBe(1))\n",
    // A test that leaves a child behind holding the runner's own stdout and stderr, and names its pid for cleanup.
    'pkg/bun/tests/linger.test.ts': [
      "import { test } from 'bun:test'",
      "import { spawn } from 'node:child_process'",
      "import { writeFileSync } from 'node:fs'",
      "test('leaves a child holding the output', () => { const child = spawn('sleep', ['30'], { stdio: 'inherit', detached: true }); child.unref(); writeFileSync(`${import.meta.dir}/.linger.pid`, String(child.pid)) })",
      ''
    ].join('\n'),
    'pkg/bun/tests/kill.test.ts':
      "import { test } from 'bun:test'\ntest('killed', () => { process.kill(process.pid, 'SIGTERM'); return new Promise((r) => setTimeout(r, 5000)) })\n",
    // A test that changes directory, as several CLI tests do: Bun then names its file a second time, from the new folder.
    'pkg/bun/tests/chdir.test.ts': [
      "import { describe, expect, test } from 'bun:test'",
      "describe('before', () => { test('a', () => expect(1).toBe(1)) })",
      "test('moves to the repository root', () => { process.chdir('../..') })",
      "describe('after', () => { test('b', () => expect(1).toBe(1)) })",
      "test('moves out of the repository', () => { process.chdir('/') })",
      "describe('outside', () => { test('c', () => expect(1).toBe(1)) })",
      ''
    ].join('\n'),
    'pkg/vt/package.json': '{ "name": "@fx/vt", "scripts": { "test": "vitest run" } }\n',
    'pkg/vt/vitest.config.mjs': "export default { test: { include: ['**/*.test.ts'] } }\n",
    'pkg/vt/src/run.test.ts': vitestTest,
    'pkg/vt/legacy/src/run.test.ts': vitestTest,
    'pkg/bun/tests/fail.test.ts':
      "import { expect, test } from 'bun:test'\ntest('breaks', () => expect(1).toBe(2))\ntest('holds', () => expect(1).toBe(1))\n",
    'pkg/vt/src/fail.test.ts':
      "import { expect, test } from 'vitest'\ntest('breaks', () => expect(1).toBe(2))\ntest('holds', () => expect(1).toBe(1))\n"
  }
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  // The installed Vitest, linked in so the fixture's own runner resolves without a network.
  const vitestDir = dirname(realpathSync(createRequire(join(REPO_ROOT, 'package.json')).resolve('vitest/package.json')))
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true })
  symlinkSync(vitestDir, join(root, 'node_modules/vitest'))
  symlinkSync(join(vitestDir, 'vitest.mjs'), join(root, 'node_modules/.bin/vitest'))
  const bun = (id: string): TestIdentity => ({
    id,
    suite: 'bun',
    owner: '@fx/bun',
    kind: 'workspace',
    runner: 'bun',
    cwd: 'pkg/bun',
    preload: null,
    environment: { timeoutMs: 30000 }
  })
  const vt = (id: string): TestIdentity => ({
    ...bun(id),
    suite: 'vt',
    owner: '@fx/vt',
    runner: 'vitest',
    cwd: 'pkg/vt',
    environment: {}
  })
  return {
    root,
    universe: [
      bun('pkg/bun/tests/a.test.ts'),
      bun('pkg/bun/moved/tests/a.test.ts'),
      bun('pkg/bun/tests/kill.test.ts'),
      bun('pkg/bun/tests/load-reject.test.ts'),
      bun('pkg/bun/tests/freeze-once.test.ts'),
      bun('pkg/bun/tests/freeze.test.ts'),
      bun('pkg/bun/tests/chdir.test.ts'),
      vt('pkg/vt/src/run.test.ts'),
      vt('pkg/vt/legacy/src/run.test.ts'),
      bun('pkg/bun/tests/fail.test.ts'),
      bun('pkg/bun/tests/linger.test.ts'),
      vt('pkg/vt/src/fail.test.ts')
    ]
  }
}

/** One-file groups of `ids`, in the order `ids` lists them: the plan order a test wants its runners started in. */
function oneFilePlan(universe: readonly TestIdentity[], ids: readonly string[]): NativeGroup[] {
  const identities = ids.map((id) => universe.find((t) => t.id === id) as TestIdentity)
  const { groups } = groupNativeTests({ tests: identities, universe, maxFilesPerGroup: FILES_PER_RUNNER })
  return ids.map((id) => groups.find((g) => g.tests[0] === id) as NativeGroup)
}

describe('real runners execute exactly their group', () => {
  const { root, universe } = runnerFixture()
  const byId = (id: string) => universe.find((t) => t.id === id) as TestIdentity
  const quiet = { log: () => {} }
  const groupsFor = (ids: string[]) => groupNativeTests({ tests: ids.map(byId), universe }).groups
  const exact = groupsFor(['pkg/bun/tests/a.test.ts', 'pkg/vt/src/run.test.ts'])
  const bunGroup = exact.find((g) => g.runner === 'bun') as NativeGroup
  const vitestGroup = exact.find((g) => g.runner === 'vitest') as NativeGroup

  test('Bun groups preserve the suite isolation flag', async () => {
    const isolated = { ...bunGroup, environment: { ...bunGroup.environment, isolate: true } }
    expect(runnerCommand(isolated, 'r.xml')).toContain('--isolate')
    expect(runnerCommand(bunGroup, 'r.xml')).not.toContain('--isolate')
  })

  test('the grouped arguments run only the scheduled files, one runner after the other', async () => {
    expect(bunGroup.args).toEqual(['./tests/a.test.ts'])
    expect(vitestGroup.exclude).toEqual(['legacy/src/run.test.ts'])
    expect(runnerCommand(bunGroup, 'r.xml')).toContain('--timeout=30000')
    expect(runnerCommand(bunGroup, 'r.xml')).not.toContain('--parallel')
    // Only the installed Vitest: a folder that cannot resolve one fails rather than downloading one.
    expect(runnerCommand(vitestGroup, 'r.json').slice(0, 3)).toEqual(['bunx', '--no-install', 'vitest'])
    const result = await runGroups(root, exact, quiet)
    expect(result.failedRunners).toEqual([])
    expect(result.problems).toEqual([])
    expect(result.executions.map((e) => e.group)).toEqual(['bun@default', 'vt@default'])
  }, 120_000)

  test('a Bun path given without ./ runs its substring sibling too, and the check fails it', async () => {
    const result = await runGroups(root, [{ ...bunGroup, args: ['tests/a.test.ts'] }], quiet)
    expect(result.problems.map((p) => `${p.code} ${p.path}`)).toEqual(['extra pkg/bun/moved/tests/a.test.ts'])
  }, 60_000)

  test('a Vitest file argument without the sibling exclusion runs the relocated sibling, and the check fails it', async () => {
    const result = await runGroups(root, [{ ...vitestGroup, exclude: [] }], quiet)
    expect(result.problems.map((p) => `${p.code} ${p.path}`)).toEqual(['extra pkg/vt/legacy/src/run.test.ts'])
  }, 60_000)

  test('a scheduled file that is not there is missing', async () => {
    const gone = {
      ...bunGroup,
      tests: [...bunGroup.tests, 'pkg/bun/tests/gone.test.ts'],
      args: [...bunGroup.args, './tests/gone.test.ts']
    }
    const result = await runGroups(root, [gone], quiet)
    expect(result.problems.map((p) => `${p.code} ${p.path}`)).toEqual(['missing pkg/bun/tests/gone.test.ts'])
  }, 60_000)

  test('the same group run twice is a duplicate, and a repeated request never groups', async () => {
    expect((await runGroups(root, [bunGroup, bunGroup], quiet)).problems.map((p) => `${p.code} ${p.path}`)).toEqual([
      'duplicate bun@default',
      'duplicate bun@default'
    ])
    const repeated = groupNativeTests({ tests: [byId('pkg/bun/tests/a.test.ts'), byId('pkg/bun/tests/a.test.ts')] })
    expect(repeated.problems.map((p) => p.code)).toEqual(['duplicate'])
  }, 60_000)

  test('an interrupted runner and an unreadable report fail', async () => {
    const killed = groupsFor(['pkg/bun/tests/kill.test.ts'])
    const result = await runGroups(root, killed, quiet)
    expect(result.problems.map((p) => `${p.code} ${p.path}`)).toEqual(['interrupted bun@default'])
    const silent = await runGroups(root, [bunGroup], {
      ...quiet,
      spawn: async () => ({ status: 0, signal: null, timedOut: false, output: null })
    })
    expect(silent.problems.map((p) => `${p.code} ${p.path}`)).toEqual(['unreadable bun@default'])
  }, 60_000)

  test('with the stop option a failing group leaves the next one unstarted; without it both run', async () => {
    const failing = groupsFor(['pkg/bun/tests/fail.test.ts'])
    const plan = [...failing, vitestGroup]
    const heard: string[] = []
    const stopped = await runGroups(root, plan, {
      ...quiet,
      stopAfterFailedGroup: true,
      onGroupEnd: (outcome) => heard.push(outcome.group)
    })
    expect(stopped.failedRunners).toEqual(['bun@default'])
    expect(heard).toEqual(['bun@default'])
    expect(stopped.outcomes.map((o) => o.group)).toEqual(['bun@default'])
    expect(stopped.executions.map((e) => e.group)).toEqual(['bun@default'])
    expect(stopped.problems).toEqual([])
    const whole = await runGroups(root, plan, quiet)
    expect(whole.failedRunners).toEqual(['bun@default'])
    expect(whole.executions.map((e) => e.group)).toEqual(['bun@default', 'vt@default'])
    expect(whole.outcomes.map((o) => o.group)).toEqual(['bun@default', 'vt@default'])
  }, 120_000)

  test('a killed group is reported either way; only the stop option leaves the next group unstarted', async () => {
    const plan = [...groupsFor(['pkg/bun/tests/kill.test.ts']), vitestGroup]
    const whole = await runGroups(root, plan, quiet)
    expect(whole.outcomes.map((o) => o.group)).toEqual(['bun@default', 'vt@default'])
    expect(whole.problems.map((p) => `${p.code} ${p.path}`)).toContain('interrupted bun@default')
    const stopped = await runGroups(root, plan, { ...quiet, stopAfterFailedGroup: true })
    expect(stopped.outcomes.map((o) => o.group)).toEqual(['bun@default'])
    expect(stopped.problems.map((p) => `${p.code} ${p.path}`)).toEqual(['interrupted bun@default'])
  }, 120_000)

  test('a runner frozen by a synchronous child is stopped at its limit and run once more', async () => {
    const lines: string[] = []
    const result = await runGroups(root, groupsFor(['pkg/bun/tests/freeze-once.test.ts']), {
      log: (line) => lines.push(line),
      groupTimeLimitMs: 4_000
    })
    expect(lines.filter((line) => line.includes('running it once more'))).toHaveLength(1)
    expect(result.failedRunners).toEqual([])
    expect(result.problems).toEqual([])
  }, 60_000)

  test('a runner frozen twice fails as interrupted instead of hanging', async () => {
    const lines: string[] = []
    const result = await runGroups(root, groupsFor(['pkg/bun/tests/freeze.test.ts']), {
      log: (line) => lines.push(line),
      groupTimeLimitMs: 4_000
    })
    expect(lines.filter((line) => line.includes('running it once more'))).toHaveLength(1)
    expect(result.failedRunners).toEqual(['bun@default'])
    expect(result.problems.map((p) => `${p.code} ${p.path}`)).toEqual(['interrupted bun@default'])
  }, 60_000)

  test('with one file per runner, a file stopped twice at the limit fails alone; the files around it stay confirmed', async () => {
    expect(GROUP_TIME_LIMIT_MS).toBe(15 * 60_000)
    const plan = groupNativeTests({
      tests: ['pkg/bun/tests/a.test.ts', 'pkg/bun/tests/chdir.test.ts', 'pkg/bun/tests/freeze.test.ts'].map(byId),
      universe,
      maxFilesPerGroup: FILES_PER_RUNNER
    }).groups
    expect(plan.map((g) => [g.id, g.tests])).toEqual([
      ['bun@default#1of3', ['pkg/bun/tests/a.test.ts']],
      ['bun@default#2of3', ['pkg/bun/tests/chdir.test.ts']],
      ['bun@default#3of3', ['pkg/bun/tests/freeze.test.ts']]
    ])
    // The frozen file runs between the two others, so a later file proves the run goes on after it.
    const ordered = [plan[0], plan[2], plan[1]] as NativeGroup[]
    const lines: string[] = []
    const result = await runGroups(root, ordered, { log: (line) => lines.push(line), groupTimeLimitMs: 4_000 })
    const retried = lines.filter((line) => line.includes('running it once more'))
    expect(retried).toHaveLength(1)
    expect(retried[0]).toContain('bun@default#3of3')
    expect(result.failedRunners).toEqual(['bun@default#3of3'])
    expect(result.failedTests).toEqual({ 'bun@default#3of3': 'all' })
    expect(result.problems.map((p) => `${p.code} ${p.path}`)).toEqual(['interrupted bun@default#3of3'])
    expect(result.outcomes.map((o) => [o.group, o.confirmed, o.obligations])).toEqual([
      ['bun@default#1of3', ['pkg/bun/tests/a.test.ts'], []],
      ['bun@default#3of3', [], ['pkg/bun/tests/freeze.test.ts']],
      ['bun@default#2of3', ['pkg/bun/tests/chdir.test.ts'], []]
    ])
  }, 60_000)

  test('an isolated group keeps the passes it reported when one file errors outside its tests', async () => {
    const [group] = groupsFor(['pkg/bun/tests/a.test.ts', 'pkg/bun/tests/load-reject.test.ts']) as [NativeGroup]
    const isolated = { ...group, environment: { ...group.environment, isolate: true } }
    const kept = (await runGroups(root, [isolated], quiet)).outcomes[0]
    expect([kept?.trusted, kept?.confirmed, kept?.obligations]).toEqual([
      true,
      ['pkg/bun/tests/a.test.ts'],
      ['pkg/bun/tests/load-reject.test.ts']
    ])
    // Without isolation the error may come from any file, so every file stays an obligation.
    const shared = (await runGroups(root, [group], quiet)).outcomes[0]
    expect([shared?.trusted, shared?.obligations]).toEqual([
      false,
      ['pkg/bun/tests/a.test.ts', 'pkg/bun/tests/load-reject.test.ts']
    ])
  }, 60_000)

  test('a test that changes directory is still one execution of its own file', async () => {
    const moving = groupsFor(['pkg/bun/tests/chdir.test.ts', 'pkg/bun/tests/a.test.ts'])
    const result = await runGroups(root, moving, quiet)
    expect(result.failedRunners).toEqual([])
    expect(result.problems).toEqual([])
    // Bun named the moving file more than once, from different folders; the check counts it once.
    const reported = result.executions[0]?.files ?? []
    expect(reported.filter((f) => f.endsWith('pkg/bun/tests/chdir.test.ts'))).toHaveLength(1)
  }, 60_000)

  test('a reported path is matched to a scheduled test from the group folder, the root or a climbed-out path', async () => {
    const group = groupsFor(['pkg/bun/tests/a.test.ts'])[0] as NativeGroup
    expect(
      bunReportedFiles(
        group,
        [
          'tests/a.test.ts',
          'pkg/bun/tests/a.test.ts',
          '../../work/repo/pkg/bun/tests/a.test.ts',
          'moved/tests/a.test.ts'
        ],
        '/r'
      )
    ).toEqual(['/r/pkg/bun/tests/a.test.ts', 'moved/tests/a.test.ts'])
    expect(bunReportedFiles(group, null, '/r')).toBeNull()
  })

  test('an empty group list starts no runner', async () => {
    let started = 0
    const result = await runGroups(root, [], {
      ...quiet,
      spawn: async () => {
        started++
        return { status: 0, signal: null, timedOut: false, output: null }
      }
    })
    expect([started, result.problems]).toEqual([0, []])
  })

  test('a failing file is named by both runners, and each runner, trusted, confirms the rest of its files', async () => {
    const groups = groupsFor([
      'pkg/bun/tests/a.test.ts',
      'pkg/bun/tests/fail.test.ts',
      'pkg/vt/src/run.test.ts',
      'pkg/vt/src/fail.test.ts'
    ])
    const lines: string[] = []
    const ended: GroupOutcome[] = []
    const result = await runGroups(root, groups, {
      log: (line) => lines.push(line),
      announce: true,
      onGroupEnd: (outcome) => ended.push(outcome)
    })
    expect(result.failedRunners).toEqual(['bun@default', 'vt@default'])
    expect(ended.map((o) => [o.group, o.trusted, o.confirmed, o.obligations])).toEqual([
      ['bun@default', true, ['pkg/bun/tests/a.test.ts'], ['pkg/bun/tests/fail.test.ts']],
      ['vt@default', true, ['pkg/vt/src/run.test.ts'], ['pkg/vt/src/fail.test.ts']]
    ])
    expect(result.outcomes).toEqual(ended)
    // Each group's scheduled files as it starts, and its report's files once it ends.
    expect(lines.filter((line) => line.startsWith('vinaya-test-group-'))).toEqual([
      `vinaya-test-group-start ${JSON.stringify({ group: 'bun@default', runner: 'bun', cwd: 'pkg/bun', tests: groups[0]?.tests })}`,
      `vinaya-test-group-end ${JSON.stringify({ group: 'bun@default', executed: groups[0]?.tests, failed: ['pkg/bun/tests/fail.test.ts'] })}`,
      `vinaya-test-group-start ${JSON.stringify({ group: 'vt@default', runner: 'vitest', cwd: 'pkg/vt', tests: groups[1]?.tests })}`,
      `vinaya-test-group-end ${JSON.stringify({ group: 'vt@default', executed: groups[1]?.tests, failed: ['pkg/vt/src/fail.test.ts'] })}`
    ])
  }, 120_000)

  test('without announce the runner prints no group line', async () => {
    const lines: string[] = []
    await runGroups(root, [bunGroup], { log: (line) => lines.push(line) })
    expect(lines.some((line) => line.startsWith('vinaya-test-group-'))).toBe(false)
  }, 60_000)

  test('one-file runners report the same outcomes at one and at four runners at once', async () => {
    const plan = oneFilePlan(universe, [
      'pkg/bun/tests/a.test.ts',
      'pkg/bun/tests/fail.test.ts',
      'pkg/bun/tests/chdir.test.ts',
      'pkg/bun/tests/kill.test.ts',
      'pkg/bun/tests/load-reject.test.ts',
      'pkg/vt/src/run.test.ts',
      'pkg/vt/src/fail.test.ts'
    ])
    expect(plan).toHaveLength(7)
    const ended = (concurrency: number) => {
      const heard: string[] = []
      return runGroups(root, plan, { ...quiet, concurrency, onGroupEnd: (o) => heard.push(o.group) }).then(
        (result) => ({ result, heard })
      )
    }
    const one = await ended(1)
    const four = await ended(4)
    expect(four.result).toEqual(one.result)
    // Every group's end is heard once either way; only the order the ends arrive in may differ.
    expect([...four.heard].sort()).toEqual([...one.heard].sort())
    expect(one.result.failedRunners.length).toBeGreaterThan(0)
    // A stopping push: one at a time it ends on its first failing file. Four at a time, the first four files start
    // together, and a file that ends before the failure frees a runner for the next file in plan order; once the
    // failure lands no further file starts, every started one finishes and is judged, and nothing that never started
    // counts as missing.
    const stopOne = await runGroups(root, plan, { ...quiet, stopAfterFailedGroup: true })
    expect(stopOne.failedRunners).toEqual([plan[1]?.id])
    expect(stopOne.outcomes.map((o) => o.group)).toEqual([plan[0]?.id, plan[1]?.id])
    const stopFour = await runGroups(root, plan, { ...quiet, stopAfterFailedGroup: true, concurrency: 4 })
    const judged = stopFour.outcomes.map((o) => o.group)
    // The judged files are a prefix of the plan, at least the four started together. (Which later files start depends
    // on which runners end first; the runner-pool tests below pin the no-further-start rule with a fixed order.)
    expect(judged).toEqual(plan.slice(0, judged.length).map((g) => g.id))
    expect(judged.length).toBeGreaterThanOrEqual(4)
    expect(stopFour.executions.map((e) => e.group)).toEqual(judged)
    expect(stopFour.failedRunners).toEqual(expect.arrayContaining([plan[1]?.id, plan[3]?.id]))
    expect(stopFour.outcomes.slice(0, 2)).toEqual(stopOne.outcomes)
    expect(stopFour.problems.map((p) => p.code)).not.toContain('missing')
    expect(stopFour.problems.map((p) => `${p.code} ${p.path}`)).toContain(`interrupted ${plan[3]?.id}`)
  }, 240_000)

  test('above one runner, each runner’s start line, output and end line reach the log as one block', async () => {
    const plan = oneFilePlan(universe, [
      'pkg/bun/tests/a.test.ts',
      'pkg/bun/tests/fail.test.ts',
      'pkg/bun/tests/chdir.test.ts',
      'pkg/vt/src/run.test.ts'
    ])
    const writes: string[] = []
    await runGroups(root, plan, { log: (text) => writes.push(text), announce: true, concurrency: 4 })
    // One write per runner, each opening with its own lines and closing on its own end line.
    expect(writes).toHaveLength(plan.length)
    const groupsSeen = writes.map((block) => {
      const lines = block.split('\n')
      const start = lines.find((line) => line.startsWith('vinaya-test-group-start '))
      const end = lines.at(-1) as string
      expect(lines[0]?.startsWith('vinaya schedule: ')).toBe(true)
      expect(lines[1]).toBe(start as string)
      expect(end.startsWith('vinaya-test-group-end ')).toBe(true)
      expect(lines.filter((line) => line.startsWith('vinaya-test-group-'))).toHaveLength(2)
      const startGroup = JSON.parse((start as string).slice('vinaya-test-group-start '.length)).group
      expect(JSON.parse(end.slice('vinaya-test-group-end '.length)).group).toBe(startGroup)
      // The runner's own output sits between the two lines.
      expect(lines.length).toBeGreaterThan(3)
      return startGroup as string
    })
    expect([...groupsSeen].sort()).toEqual(plan.map((g) => g.id).sort())
  }, 120_000)
})

describe('the runner pool', () => {
  const { root, universe } = runnerFixture()
  const plan = oneFilePlan(universe, [
    'pkg/bun/tests/a.test.ts',
    'pkg/bun/tests/fail.test.ts',
    'pkg/bun/tests/chdir.test.ts',
    'pkg/bun/tests/kill.test.ts',
    'pkg/bun/tests/load-reject.test.ts',
    'pkg/bun/tests/freeze.test.ts'
  ])
  const fileOf = (command: readonly string[]) => (command.at(-1) as string).replace(/^\.\//, '')
  type Behaviour = { ms?: number; fail?: boolean; timeouts?: number; output?: string }
  /**
   * A runner start that writes the JUnit report a passing or failing one-file Bun run writes, after `ms`, and records
   * how many runners run at once.
   */
  const fakeStart = (behaviour: Record<string, Behaviour>) => {
    const started: string[] = []
    const captured: boolean[] = []
    let active = 0
    let most = 0
    const timedOutOnce = new Map<string, number>()
    const spawn: RunnerStart = async (command, options) => {
      const file = fileOf(command)
      const how = behaviour[file] ?? {}
      started.push(file)
      captured.push(options.capture)
      active++
      most = Math.max(most, active)
      await new Promise((resolve) => setTimeout(resolve, how.ms ?? 5))
      active--
      const output = options.capture ? (how.output ?? `ran ${file}\n`) : null
      const stops = timedOutOnce.get(file) ?? 0
      if (stops < (how.timeouts ?? 0)) {
        timedOutOnce.set(file, stops + 1)
        return { status: null, signal: 'SIGKILL', timedOut: true, output }
      }
      const report = (command.find((arg) => arg.startsWith('--reporter-outfile=')) as string).slice(
        '--reporter-outfile='.length
      )
      const failures = how.fail ? 1 : 0
      writeFileSync(
        report,
        `<testsuites failures="${failures}"><testsuite name="${file}" file="${file}" tests="1" failures="${failures}"></testsuite></testsuites>\n`
      )
      return { status: failures, signal: null, timedOut: false, output }
    }
    return { spawn, started, captured, most: () => most }
  }

  test('never runs more runners than the setting allows, and starts them in plan order', async () => {
    const fake = fakeStart({ 'tests/a.test.ts': { ms: 40 }, 'tests/fail.test.ts': { ms: 5 } })
    const result = await runGroups(root, plan, { log: () => {}, spawn: fake.spawn, concurrency: 3 })
    expect(fake.most()).toBe(3)
    expect(fake.started).toEqual(plan.map((g) => fileOf(g.args)))
    expect(fake.captured.every(Boolean)).toBe(true)
    expect(result.outcomes.map((o) => o.group)).toEqual(plan.map((g) => g.id))
    expect(result.problems).toEqual([])
    const serial = fakeStart({})
    await runGroups(root, plan, { log: () => {}, spawn: serial.spawn })
    // Unset, one runner runs at a time and its output streams as today.
    expect(serial.most()).toBe(1)
    expect(serial.captured.some(Boolean)).toBe(false)
  })

  test('a stop after a failure starts no further file and lets the files already running finish and be judged', async () => {
    // The second file fails first, while the first is still running; the rest wait for a free runner.
    const fake = fakeStart({ 'tests/a.test.ts': { ms: 120 }, 'tests/fail.test.ts': { ms: 5, fail: true } })
    const heard: string[] = []
    const result = await runGroups(root, plan, {
      log: () => {},
      spawn: fake.spawn,
      concurrency: 2,
      stopAfterFailedGroup: true,
      onGroupEnd: (outcome) => heard.push(outcome.group)
    })
    expect(fake.started).toEqual(['tests/a.test.ts', 'tests/fail.test.ts'])
    expect(heard).toEqual([plan[1]?.id, plan[0]?.id])
    expect(result.failedRunners).toEqual([plan[1]?.id])
    expect(result.outcomes.map((o) => [o.group, o.confirmed])).toEqual([
      [plan[0]?.id, ['pkg/bun/tests/a.test.ts']],
      [plan[1]?.id, []]
    ])
    expect(result.executions.map((e) => e.group)).toEqual([plan[0]?.id, plan[1]?.id])
    // A file that never started is not a missing execution.
    expect(result.problems).toEqual([])
  })

  test('each file keeps its own limit and its single retry when runners run together', async () => {
    const fake = fakeStart({ 'tests/chdir.test.ts': { timeouts: 1 }, 'tests/freeze.test.ts': { timeouts: 2 } })
    const lines: string[] = []
    const result = await runGroups(root, plan, {
      log: (text) => lines.push(...text.split('\n')),
      spawn: fake.spawn,
      concurrency: 4,
      groupTimeLimitMs: 1_000
    })
    expect(fake.started.filter((f) => f === 'tests/chdir.test.ts')).toHaveLength(2)
    expect(fake.started.filter((f) => f === 'tests/freeze.test.ts')).toHaveLength(2)
    expect(fake.started).toHaveLength(plan.length + 2)
    expect(lines.filter((line) => line.includes('running it once more'))).toHaveLength(2)
    const frozen = plan.find((g) => g.tests[0] === 'pkg/bun/tests/freeze.test.ts') as NativeGroup
    expect(result.failedRunners).toEqual([frozen.id])
    expect(result.failedTests).toEqual({ [frozen.id]: 'all' })
    expect(result.problems.map((p) => `${p.code} ${p.path}`)).toEqual([`interrupted ${frozen.id}`])
  })

  test('a concurrency that is not a positive integer is refused', async () => {
    await expect(runGroups(root, plan, { log: () => {}, concurrency: 0 })).rejects.toThrow('positive integer')
    await expect(runGroups(root, plan, { log: () => {}, concurrency: 1.5 })).rejects.toThrow('positive integer')
  })

  test('a group that throws stops further starts, and the run waits for the runners already running', async () => {
    let running = 0
    let endedAfterThrow = false
    const spawn: RunnerStart = async (command) => {
      if (fileOf(command) === 'tests/fail.test.ts') throw new Error('runner could not start')
      running++
      await new Promise((resolve) => setTimeout(resolve, 80))
      running--
      endedAfterThrow = true
      return { status: 0, signal: null, timedOut: false, output: '' }
    }
    await expect(runGroups(root, plan, { log: () => {}, spawn, concurrency: 2 })).rejects.toThrow(
      'runner could not start'
    )
    // The first file's runner had finished before the run gave up, and no runner was left running.
    expect([endedAfterThrow, running]).toEqual([true, 0])
  })
})

describe('a real runner whose child holds its output', () => {
  const { root, universe } = runnerFixture()
  const pidFile = join(root, 'pkg/bun/tests/.linger.pid')
  const killLeftover = (pid: number) => {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }

  test('ends when the runner exits, not when the leftover child releases the pipes', async () => {
    const plan = oneFilePlan(universe, ['pkg/bun/tests/a.test.ts', 'pkg/bun/tests/linger.test.ts'])
    const lines: string[] = []
    const started = performance.now()
    try {
      const result = await runGroups(root, plan, {
        log: (text) => lines.push(...text.split('\n')),
        concurrency: 2,
        groupTimeLimitMs: 20_000
      })
      // Well before the leftover child's thirty seconds and the per-file limit: the runner's exit ended it.
      expect(performance.now() - started).toBeLessThan(15_000)
      expect(lines.some((line) => line.includes('running it once more'))).toBe(false)
      expect(result.failedRunners).toEqual([])
      expect(result.problems).toEqual([])
      expect(result.outcomes.map((o) => o.confirmed)).toEqual([
        ['pkg/bun/tests/a.test.ts'],
        ['pkg/bun/tests/linger.test.ts']
      ])
    } finally {
      killLeftover(Number(readFileSync(pidFile, 'utf8')))
    }
  }, 60_000)

  test('a runner killed at its limit ends at once even while a child of it still holds the pipes', async () => {
    const started = performance.now()
    const exit = await startRunner(['sh', '-c', 'sleep 30 & echo $! ; sleep 30'], {
      cwd: root,
      env: process.env,
      capture: true,
      timeLimitMs: 500
    })
    try {
      expect(performance.now() - started).toBeLessThan(500 + OUTPUT_DRAIN_MS + 3_000)
      expect([exit.timedOut, exit.signal]).toEqual([true, 'SIGKILL'])
    } finally {
      killLeftover(Number((exit.output ?? '').trim().split('\n')[0]))
    }
  }, 30_000)
})

describe('the concurrency setting', () => {
  test('is one when unset and the positive integer it names otherwise', () => {
    expect(TEST_CONCURRENCY_ENV).toBe('VINAYA_TEST_CONCURRENCY')
    expect(testConcurrency({})).toBe(1)
    expect(testConcurrency({ VINAYA_TEST_CONCURRENCY: '1' })).toBe(1)
    expect(testConcurrency({ VINAYA_TEST_CONCURRENCY: '4' })).toBe(4)
    expect(testConcurrency({ VINAYA_TEST_CONCURRENCY: '12' })).toBe(12)
  })

  test('anything else is refused with a message naming the setting', () => {
    for (const value of ['', '0', '-1', '1.5', ' 2', '2 ', 'four', '04', '1e3', '99999999999999999999'])
      expect(() => testConcurrency({ VINAYA_TEST_CONCURRENCY: value })).toThrow(
        'VINAYA_TEST_CONCURRENCY must be a positive integer'
      )
  })
})

describe('what a runner group confirms', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'schedule-outcome-')))
  scratch.push(root)
  const ids = ['a', 'b', 'c', 'd', 'e'].map((name) => `pkg/t/${name}.test.ts`)
  const group = (runner: 'bun' | 'vitest', tests = ids): NativeGroup => ({
    id: `${runner}@default`,
    suite: runner,
    owner: '@fx/x',
    kind: 'workspace',
    runner,
    cwd: 'pkg',
    preload: null,
    environment: {},
    configuration: 'default',
    scope: 'files',
    reason: null,
    tests,
    args: tests.map((id) => `./${id.slice('pkg/'.length)}`),
    exclude: []
  })
  /** A Bun JUnit report: the root's failures and errors, then each file with its own failures. */
  const junit = (root: { failures?: number; errors?: number }, files: [string, number][]) =>
    [
      `<testsuites name="bun test"${root.failures === undefined ? '' : ` failures="${root.failures}"`}${root.errors === undefined ? '' : ` errors="${root.errors}"`}>`,
      ...files.map(
        ([file, failures]) => `<testsuite name="${file}" file="${file}" failures="${failures}"></testsuite>`
      ),
      '</testsuites>'
    ].join('\n')
  const vitest = (
    totals: { numFailedTestSuites?: number; numFailedTests?: number; success?: boolean },
    files: [string, number][]
  ) =>
    JSON.stringify({
      ...totals,
      testResults: files.map(([file, failed]) => ({
        name: join(root, 'pkg', file),
        status: failed > 0 ? 'failed' : 'passed',
        assertionResults: [...Array.from({ length: failed }, () => ({ status: 'failed' })), { status: 'passed' }]
      }))
    })
  const outcome = (g: NativeGroup, status: number | null, report: string | null, signal: string | null = null) =>
    groupOutcomeOf(g, { status, signal, report }, root, [root])

  test('named failures plus two unreported files make exactly those files obligations, not the whole group', () => {
    const result = outcome(
      group('bun'),
      1,
      junit({ failures: 1 }, [
        ['t/a.test.ts', 1],
        ['t/b.test.ts', 0],
        ['t/c.test.ts', 0]
      ])
    )
    expect(result).toEqual({
      group: 'bun@default',
      executed: ['pkg/t/a.test.ts', 'pkg/t/b.test.ts', 'pkg/t/c.test.ts'],
      failed: ['pkg/t/a.test.ts'],
      unreported: ['pkg/t/d.test.ts', 'pkg/t/e.test.ts'],
      trusted: true,
      confirmed: ['pkg/t/b.test.ts', 'pkg/t/c.test.ts'],
      obligations: ['pkg/t/a.test.ts', 'pkg/t/d.test.ts', 'pkg/t/e.test.ts']
    })
  })

  test('a failed runner whose report totals its named files do not cover confirms nothing', () => {
    const listed: [string, number][] = ids.map((id, i) => [id.slice('pkg/'.length), i === 0 ? 1 : 0])
    for (const totals of [{ failures: 2 }, { failures: 1, errors: 1 }])
      expect(outcome(group('bun'), 1, junit(totals, listed))).toMatchObject({
        trusted: false,
        confirmed: [],
        obligations: ids
      })
    // A total the report omits counts as zero.
    expect(outcome(group('bun'), 1, junit({}, listed))).toMatchObject({ trusted: true, obligations: [ids[0]] })
  })

  test('a failed runner that names no file confirms nothing, whatever its totals', () => {
    const listed: [string, number][] = ids.map((id) => [id.slice('pkg/'.length), 0])
    for (const totals of [{}, { failures: 0 }, { errors: 1 }])
      expect(outcome(group('bun'), 1, junit(totals, listed))).toMatchObject({ trusted: false, obligations: ids })
  })

  test('an extra or duplicate execution, a signal or no readable report makes every test of the group an obligation', () => {
    const listed: [string, number][] = ids.map((id) => [id.slice('pkg/'.length), 0])
    expect(outcome(group('bun'), 0, junit({}, [...listed, ['t/x.test.ts', 0]]))).toMatchObject({
      trusted: false,
      confirmed: [],
      obligations: ids
    })
    expect(outcome(group('vitest'), 0, vitest({}, [...listed, listed[0] as [string, number]]))).toMatchObject({
      trusted: false,
      obligations: ids
    })
    expect(outcome(group('bun'), null, null, 'SIGKILL')).toMatchObject({ trusted: false, obligations: ids })
    expect(outcome(group('bun'), 0, null)).toMatchObject({ trusted: false, obligations: ids, unreported: [] })
    expect(outcome(group('bun'), 0, 'not a report')).toMatchObject({ trusted: false, obligations: ids })
  })

  test('a runner that exited zero confirms every file its report lists once; a missing one stays an obligation', () => {
    const listed: [string, number][] = ids.slice(0, 4).map((id) => [id.slice('pkg/'.length), 0])
    expect(outcome(group('bun'), 0, junit({ failures: 0 }, listed))).toMatchObject({
      trusted: true,
      confirmed: ids.slice(0, 4),
      unreported: [ids[4]],
      obligations: [ids[4]]
    })
  })

  test('a Vitest runner is trusted only when its failed suite and test counts are covered and it did not succeed', () => {
    const listed: [string, number][] = ids.map((id, i) => [id.slice('pkg/'.length), i === 1 ? 2 : 0])
    expect(
      outcome(group('vitest'), 1, vitest({ numFailedTestSuites: 1, numFailedTests: 2, success: false }, listed))
    ).toMatchObject({ trusted: true, obligations: [ids[1]] })
    expect(outcome(group('vitest'), 1, vitest({}, listed))).toMatchObject({ trusted: true, obligations: [ids[1]] })
    for (const totals of [
      { numFailedTestSuites: 2, numFailedTests: 2, success: false },
      { numFailedTestSuites: 1, numFailedTests: 3, success: false },
      { numFailedTestSuites: 1, numFailedTests: 2, success: true }
    ])
      expect(outcome(group('vitest'), 1, vitest(totals, listed))).toMatchObject({ trusted: false, obligations: ids })
  })
})

describe("each run's own test-temp root", () => {
  const fixture = runnerFixture()
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'schedule-test-temp-')))
  scratch.push(base)
  const runs = join(base, SCHEDULE_TEST_TEMP_REPO_ID)
  const create = () => createTestTempRun(SCHEDULE_TEST_TEMP_REPO_ID, runs)
  const group = groupNativeTests({
    tests: [fixture.universe.find((t) => t.id === 'pkg/bun/tests/a.test.ts') as TestIdentity],
    universe: fixture.universe
  }).groups[0] as NativeGroup
  /** Runs one group twice with a recording spawn: each runner's root, and whether it existed while the runner ran. */
  const run = async (env: NodeJS.ProcessEnv, fail = false) => {
    const seen: { root: string | undefined; existed: boolean }[] = []
    const spawn: RunnerStart = async (_command, opts) => {
      const root = opts.env[TEST_TEMP_ROOT_ENV]
      seen.push({ root, existed: root !== undefined && existsSync(join(root, OWNER_MARKER_FILE)) })
      if (fail) throw new Error('runner could not start')
      return { status: 0, signal: null, timedOut: false, output: null }
    }
    const go = () => runGroups(fixture.root, [group, group], { log: () => {}, spawn, env, createTestTempRoot: create })
    if (fail) await expect(go()).rejects.toThrow('runner could not start')
    else await go()
    return seen
  }
  const unset = { PATH: process.env.PATH }

  test('two runs hand their runners two distinct roots, each removed once the run ends', async () => {
    const first = await run(unset)
    const second = await run(unset)
    // Every runner of one run shares its run's root; the two runs never share one.
    expect(new Set(first.map((s) => s.root)).size).toBe(1)
    expect(new Set(second.map((s) => s.root)).size).toBe(1)
    expect(first[0]?.root).not.toBe(second[0]?.root)
    for (const { root } of [...first, ...second]) {
      expect(dirname(root as string)).toBe(runs)
      expect(existsSync(root as string)).toBe(false)
    }
    // Each root carried its owner marker while its runners ran, so a later sweep can judge one a killed run left.
    expect([...first, ...second].every((s) => s.existed)).toBe(true)
    expect(readdirSync(runs).filter((name) => !name.endsWith('.owner.json'))).toEqual([])
  })

  test("a caller's own root is kept and never removed", async () => {
    const own = join(base, 'caller-root')
    mkdirSync(own)
    const seen = await run({ ...unset, [TEST_TEMP_ROOT_ENV]: own })
    expect(seen.map((s) => s.root)).toEqual([own, own])
    expect(existsSync(own)).toBe(true)
  })

  test('the root a run created is removed even when its runner fails to start', async () => {
    const seen = await run(unset, true)
    expect(seen).toHaveLength(1)
    expect(existsSync(seen[0]?.root as string)).toBe(false)
  })

  test('a set root is kept without creating one; an empty setting creates one', () => {
    let created = 0
    const counted = () => {
      created++
      return create()
    }
    expect(runTestTempRoot({ [TEST_TEMP_ROOT_ENV]: '/disk/own' }, counted)).toEqual({
      root: '/disk/own',
      created: null
    })
    expect(created).toBe(0)
    const fresh = runTestTempRoot({ [TEST_TEMP_ROOT_ENV]: '' }, counted)
    expect(created).toBe(1)
    expect(fresh.created?.dir).toBe(fresh.root)
    expect(removeTestTempRun(fresh.created as TestTempRun).failed).toEqual([])
  })
})
