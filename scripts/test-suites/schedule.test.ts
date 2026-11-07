/**
 * The CI test schedule: every inventory test placed exactly once, shards
 * assigned deterministically, the same identity set kept by local grouping
 * and CI placement, and real Bun and Vitest runs checked against the files
 * each was given — sibling paths that collide as substrings after a
 * relocation, a missing file, extra execution, a repeated group, an
 * interrupted run and an unreadable report among them.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parse } from 'yaml'
import {
  CI_SHARD_COUNT,
  CI_SHARD_LIST_OWNER
} from '../../harness/processes/vinaya-strict/checks/ci-shard-membership.ts'
import {
  groupNativeTests,
  type NativeGroup,
  type NativeTestRequest,
  type TestIdentity
} from '../../harness/kernel/gates/ring0-hooks/pre-push/verification/index.ts'
import { type InventoryView, readTestInventory } from './inventory-check.ts'
import {
  assignShards,
  buildTestSchedule,
  bunJunitFiles,
  bunReportedFiles,
  checkSchedule,
  ciScheduleInput,
  type GroupOutcome,
  groupOutcomeOf,
  readShardLists,
  runGroups,
  runnerCommand,
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
    // A full run starts each Vitest suite whole, with its reason stated, under its own configuration.
    for (const group of schedule.placements.shared ?? [])
      if (group.runner === 'vitest') expect([group.scope, typeof group.reason]).toEqual(['suite', 'string'])
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

  test('a selected run schedules the selected files, every root-suite test and the whole-run suite with its reason', () => {
    const input = ciScheduleInput(view, { scope: 'selected', selected: [cliTest.id], native: [forgeState.id] })
    expect(input.reason).toBeNull()
    expect(input.selected.map((t) => t.id).sort()).toEqual(
      [cliTest.id, forgeState.id, ...view.tests.filter((t) => t.kind !== 'workspace').map((t) => t.id)].sort()
    )
    // The package-compatibility suite is never skipped, whatever the selection holds.
    expect(input.selected.map((t) => t.id)).toContain('scripts/package-compat/package-compat.test.ts')
    expect(input.wholeSuites.map((w) => [w.suite, w.reason.includes('whole repository')])).toEqual([])
  })

  test('a non-TypeScript portal change runs the whole portal suite, which a selection there never narrows', () => {
    const portal = view.tests.filter((t) => t.owner === '@vinaya/portal').map((t) => t.id)
    expect(portal.length).toBeGreaterThan(0)
    const decision = {
      scope: 'selected' as const,
      selected: [],
      native: [],
      changed: ['apps/vinaya-portal/src/cms/utils/theme-corpus.fixture.json']
    }
    const input = ciScheduleInput(view, decision)
    const whole = input.wholeSuites.find((w) => w.suite === 'portal')
    expect(whole?.reason).toContain('changes a path under its folder')
    expect(whole?.identities.map((t) => t.id).sort()).toEqual([...portal].sort())
    const schedule = buildTestSchedule({ view, shardLists, ...input })
    expect(checkSchedule(schedule, expectedOf(input))).toEqual([])
    expect(schedule.placements.shared?.find((g) => g.suite === 'portal')).toMatchObject({ scope: 'suite', args: [] })
    expect(schedule.accounting.filter((e) => portal.includes(e.test)).map((e) => e.placement)).toEqual(
      portal.map(() => 'shared')
    )
    // A change outside the portal leaves it to the selection.
    const elsewhere = ciScheduleInput(view, { ...decision, changed: ['apps/cli/src/lib/config.ts'] })
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
      bun('pkg/bun/tests/freeze-once.test.ts'),
      bun('pkg/bun/tests/freeze.test.ts'),
      bun('pkg/bun/tests/chdir.test.ts'),
      vt('pkg/vt/src/run.test.ts'),
      vt('pkg/vt/legacy/src/run.test.ts'),
      bun('pkg/bun/tests/fail.test.ts'),
      vt('pkg/vt/src/fail.test.ts')
    ]
  }
}

describe('real runners execute exactly their group', () => {
  const { root, universe } = runnerFixture()
  const byId = (id: string) => universe.find((t) => t.id === id) as TestIdentity
  const quiet = { log: () => {} }
  const groupsFor = (ids: string[]) => groupNativeTests({ tests: ids.map(byId), universe }).groups
  const exact = groupsFor(['pkg/bun/tests/a.test.ts', 'pkg/vt/src/run.test.ts'])
  const bunGroup = exact.find((g) => g.runner === 'bun') as NativeGroup
  const vitestGroup = exact.find((g) => g.runner === 'vitest') as NativeGroup

  test('Bun groups preserve the suite isolation flag', () => {
    const isolated = { ...bunGroup, environment: { ...bunGroup.environment, isolate: true } }
    expect(runnerCommand(isolated, 'r.xml')).toContain('--isolate')
    expect(runnerCommand(bunGroup, 'r.xml')).not.toContain('--isolate')
  })

  test('the grouped arguments run only the scheduled files, one runner after the other', () => {
    expect(bunGroup.args).toEqual(['./tests/a.test.ts'])
    expect(vitestGroup.exclude).toEqual(['legacy/src/run.test.ts'])
    expect(runnerCommand(bunGroup, 'r.xml')).toContain('--timeout=30000')
    expect(runnerCommand(bunGroup, 'r.xml')).not.toContain('--parallel')
    // Only the installed Vitest: a folder that cannot resolve one fails rather than downloading one.
    expect(runnerCommand(vitestGroup, 'r.json').slice(0, 3)).toEqual(['bunx', '--no-install', 'vitest'])
    const result = runGroups(root, exact, quiet)
    expect(result.failedRunners).toEqual([])
    expect(result.problems).toEqual([])
    expect(result.executions.map((e) => e.group)).toEqual(['bun@default', 'vt@default'])
  }, 120_000)

  test('a Bun path given without ./ runs its substring sibling too, and the check fails it', () => {
    const result = runGroups(root, [{ ...bunGroup, args: ['tests/a.test.ts'] }], quiet)
    expect(result.problems.map((p) => `${p.code} ${p.path}`)).toEqual(['extra pkg/bun/moved/tests/a.test.ts'])
  }, 60_000)

  test('a Vitest file argument without the sibling exclusion runs the relocated sibling, and the check fails it', () => {
    const result = runGroups(root, [{ ...vitestGroup, exclude: [] }], quiet)
    expect(result.problems.map((p) => `${p.code} ${p.path}`)).toEqual(['extra pkg/vt/legacy/src/run.test.ts'])
  }, 60_000)

  test('a scheduled file that is not there is missing', () => {
    const gone = {
      ...bunGroup,
      tests: [...bunGroup.tests, 'pkg/bun/tests/gone.test.ts'],
      args: [...bunGroup.args, './tests/gone.test.ts']
    }
    const result = runGroups(root, [gone], quiet)
    expect(result.problems.map((p) => `${p.code} ${p.path}`)).toEqual(['missing pkg/bun/tests/gone.test.ts'])
  }, 60_000)

  test('the same group run twice is a duplicate, and a repeated request never groups', () => {
    expect(runGroups(root, [bunGroup, bunGroup], quiet).problems.map((p) => `${p.code} ${p.path}`)).toEqual([
      'duplicate bun@default',
      'duplicate bun@default'
    ])
    const repeated = groupNativeTests({ tests: [byId('pkg/bun/tests/a.test.ts'), byId('pkg/bun/tests/a.test.ts')] })
    expect(repeated.problems.map((p) => p.code)).toEqual(['duplicate'])
  }, 60_000)

  test('an interrupted runner and an unreadable report fail', () => {
    const killed = groupsFor(['pkg/bun/tests/kill.test.ts'])
    const result = runGroups(root, killed, quiet)
    expect(result.problems.map((p) => `${p.code} ${p.path}`)).toEqual(['interrupted bun@default'])
    const silent = runGroups(root, [bunGroup], {
      ...quiet,
      spawn: (() => ({ status: 0, signal: null })) as unknown as typeof import('node:child_process').spawnSync
    })
    expect(silent.problems.map((p) => `${p.code} ${p.path}`)).toEqual(['unreadable bun@default'])
  }, 60_000)

  test('a runner frozen by a synchronous child is stopped at its limit and run once more', () => {
    const lines: string[] = []
    const result = runGroups(root, groupsFor(['pkg/bun/tests/freeze-once.test.ts']), {
      log: (line) => lines.push(line),
      groupTimeLimitMs: 4_000
    })
    expect(lines.filter((line) => line.includes('running it once more'))).toHaveLength(1)
    expect(result.failedRunners).toEqual([])
    expect(result.problems).toEqual([])
  }, 60_000)

  test('a runner frozen twice fails as interrupted instead of hanging', () => {
    const lines: string[] = []
    const result = runGroups(root, groupsFor(['pkg/bun/tests/freeze.test.ts']), {
      log: (line) => lines.push(line),
      groupTimeLimitMs: 4_000
    })
    expect(lines.filter((line) => line.includes('running it once more'))).toHaveLength(1)
    expect(result.failedRunners).toEqual(['bun@default'])
    expect(result.problems.map((p) => `${p.code} ${p.path}`)).toEqual(['interrupted bun@default'])
  }, 60_000)

  test('a test that changes directory is still one execution of its own file', () => {
    const moving = groupsFor(['pkg/bun/tests/chdir.test.ts', 'pkg/bun/tests/a.test.ts'])
    const result = runGroups(root, moving, quiet)
    expect(result.failedRunners).toEqual([])
    expect(result.problems).toEqual([])
    // Bun named the moving file more than once, from different folders; the check counts it once.
    const reported = result.executions[0]?.files ?? []
    expect(reported.filter((f) => f.endsWith('pkg/bun/tests/chdir.test.ts'))).toHaveLength(1)
  }, 60_000)

  test('a reported path is matched to a scheduled test from the group folder, the root or a climbed-out path', () => {
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

  test('an empty group list starts no runner', () => {
    let started = 0
    const result = runGroups(root, [], {
      ...quiet,
      spawn: (() => {
        started++
        return { status: 0, signal: null }
      }) as unknown as typeof import('node:child_process').spawnSync
    })
    expect([started, result.problems]).toEqual([0, []])
  })

  test('a failing file is named by both runners, and each runner, trusted, confirms the rest of its files', () => {
    const groups = groupsFor([
      'pkg/bun/tests/a.test.ts',
      'pkg/bun/tests/fail.test.ts',
      'pkg/vt/src/run.test.ts',
      'pkg/vt/src/fail.test.ts'
    ])
    const lines: string[] = []
    const ended: GroupOutcome[] = []
    const result = runGroups(root, groups, {
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

  test('without announce the runner prints no group line', () => {
    const lines: string[] = []
    runGroups(root, [bunGroup], { log: (line) => lines.push(line) })
    expect(lines.some((line) => line.startsWith('vinaya-test-group-'))).toBe(false)
  }, 60_000)
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
