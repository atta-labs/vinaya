/**
 * The driver move, staged: a small repository shaped like this one, whose
 * driver and its test move from the CLI into the process. Removing the
 * test's line from the CLI shard lists, in the same change, gives it a
 * process-owned place in the schedule; a CLI or kernel change the driver
 * imports still selects it through the CI selection; and an unrelated CLI
 * change does not run the process suite, though the process package lists the
 * CLI as a development dependency.
 *
 * The selection is the CI adapter's own (`apps/cli/src/lib/ci-test-selection.ts
 * --decision`), run as its own process in the fixture repository; the
 * inventory is built from the fixture's committed declarations.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { CI_SHARD_COUNT } from '../../apps/cli/src/lib/ci-shard-membership.ts'
import type { CiDecision } from '../../apps/cli/src/lib/ci-test-selection.ts'
import { buildInventoryView, INVENTORY_PATH, type InventoryDeclarations, memoryReader } from './inventory-check.ts'
import { buildTestSchedule, checkSchedule, ciScheduleInput, type TestSchedule } from './schedule.ts'

const REPO_ROOT = join(import.meta.dir, '../..')
const SELECTION = join(REPO_ROOT, 'apps/cli/src/lib/ci-test-selection.ts')

const OLD_TEST = 'apps/cli/tests/driver.test.ts'
const NEW_TEST = 'processes/vinaya/tests/driver.test.ts'

/** The repository before or after the move; `listed` keeps the old shard line after the move, as a stale list would. */
function treeOf(moved: boolean, listed = !moved): Record<string, string> {
  const driver = moved ? 'processes/vinaya/loops/driver.ts' : 'apps/cli/src/lib/driver.ts'
  const driverTest = moved ? NEW_TEST : OLD_TEST
  const fromDriver = moved
    ? { shared: '../../../apps/cli/src/lib/shared', gate: '../../../harness/src/gate' }
    : { shared: './shared', gate: '../../../../harness/src/gate' }
  const shard = (n: number, lines: string[]) => [
    `apps/cli/tests/ci-shards/shard-${n}.txt`,
    lines.map((l) => `${l}\n`).join('')
  ]
  const files: Record<string, string> = {
    'package.json': JSON.stringify({
      name: 'fixture',
      private: true,
      workspaces: ['apps/*', 'harness', 'processes/*']
    }),
    'apps/cli/package.json': JSON.stringify({
      name: '@attalabs/vinaya',
      scripts: { test: 'bun test --timeout=30000' }
    }),
    'apps/cli/src/lib/shared.ts': 'export const shared = () => 1\n',
    'apps/cli/src/lib/other.ts': 'export const other = () => 2\n',
    'apps/cli/tests/other.test.ts': "import { other } from '../src/lib/other'\nexport const t = other\n",
    'harness/package.json': JSON.stringify({
      name: '@attalabs/harness',
      scripts: { test: 'bun test --timeout=30000' }
    }),
    'harness/src/gate.ts': 'export const gate = () => 3\n',
    'harness/tests/gate.test.ts': "import { gate } from '../src/gate'\nexport const t = gate\n",
    // The process lists the CLI as a development dependency; nothing of its flow imports it.
    'processes/vinaya/package.json': JSON.stringify({
      name: '@attalabs/process-vinaya',
      scripts: { test: 'bun test --timeout=30000' },
      devDependencies: { '@attalabs/vinaya': 'workspace:*' }
    }),
    'processes/vinaya/loops/flow.ts': 'export const flow = () => 4\n',
    'processes/vinaya/tests/flow.test.ts': "import { flow } from '../loops/flow'\nexport const t = flow\n",
    [driver]: `import { shared } from '${fromDriver.shared}'\nimport { gate } from '${fromDriver.gate}'\nexport const drive = () => shared() + gate()\n`,
    [driverTest]: `import { drive } from '${moved ? '../loops/driver' : '../src/lib/driver'}'\nexport const t = drive\n`,
    ...Object.fromEntries([
      shard(1, listed ? [OLD_TEST.slice('apps/cli/'.length)] : []),
      shard(2, ['tests/other.test.ts']),
      ...Array.from({ length: CI_SHARD_COUNT - 2 }, (_, i) => shard(i + 3, []))
    ])
  }
  const declarations: InventoryDeclarations = {
    schema: 'vinaya.test-inventory',
    schemaVersion: 1,
    declarationVersion: 1,
    suites: [
      { id: 'cli', owner: '@attalabs/vinaya', kind: 'workspace', dir: 'apps/cli', runner: 'bun', preload: null },
      { id: 'kernel', owner: '@attalabs/harness', kind: 'workspace', dir: 'harness', runner: 'bun', preload: null },
      {
        id: 'process-vinaya',
        owner: '@attalabs/process-vinaya',
        kind: 'workspace',
        dir: 'processes/vinaya',
        runner: 'bun',
        preload: null
      }
    ],
    typeInputs: [],
    exclusions: [],
    inputs: [],
    providers: [],
    policies: [],
    unknowns: []
  }
  files[INVENTORY_PATH] = JSON.stringify(declarations)
  return files
}

function shardListsOf(files: Record<string, string>): string[][] {
  return Array.from({ length: CI_SHARD_COUNT }, (_, i) =>
    (files[`apps/cli/tests/ci-shards/shard-${i + 1}.txt`] ?? '').split('\n').filter(Boolean)
  )
}

function scheduleOf(files: Record<string, string>, decision: CiDecision): TestSchedule {
  const view = buildInventoryView(memoryReader('fixture', files))
  expect(view.problems).toEqual([])
  const input = ciScheduleInput(view, decision)
  const schedule = buildTestSchedule({ view, shardLists: shardListsOf(files), ...input })
  expect(checkSchedule(schedule, input.selected)).toEqual([])
  return schedule
}

const placeOf = (schedule: TestSchedule, test: string) => schedule.accounting.find((e) => e.test === test)?.placement

describe('removing the driver test from the CLI shard lists gives it a process-owned place', () => {
  test('before the move the listed CLI test keeps its shard', () => {
    const schedule = scheduleOf(treeOf(false), { scope: 'all', reason: 'everything' })
    expect(placeOf(schedule, OLD_TEST)).toBe('shard-1')
    expect(schedule.placements['shard-1']?.map((g) => g.owner)).toEqual(['@attalabs/vinaya'])
  })

  test('after the move, with the line removed in the same change, the process owns it in one shard, every run alike', () => {
    const files = treeOf(true)
    const schedule = scheduleOf(files, { scope: 'all', reason: 'everything' })
    expect(placeOf(schedule, OLD_TEST)).toBeUndefined()
    // By sorted identity, each to the shard with the fewest files: the kernel test fills the vacated
    // shard 1, the driver test the next empty one, shard 3 — shard 2 already holds the CLI's other test.
    expect(schedule.assignments).toEqual({
      'apps/cli/tests/other.test.ts': 2,
      'harness/tests/gate.test.ts': 1,
      [NEW_TEST]: 3,
      'processes/vinaya/tests/flow.test.ts': 4
    })
    const group = schedule.placements[`shard-${schedule.assignments[NEW_TEST]}` as const]?.find((g) =>
      g.tests.includes(NEW_TEST)
    )
    expect(group).toMatchObject({
      owner: '@attalabs/process-vinaya',
      cwd: 'processes/vinaya',
      args: ['./tests/driver.test.ts']
    })
    expect(scheduleOf(files, { scope: 'all', reason: 'everything' })).toEqual(schedule)
  })

  test('a stale line left in the shard lists fails the schedule, so the move must remove it in the same change', () => {
    const files = treeOf(true, true)
    const view = buildInventoryView(memoryReader('fixture', files))
    const schedule = buildTestSchedule({
      view,
      shardLists: shardListsOf(files),
      ...ciScheduleInput(view, { scope: 'all', reason: 'x' })
    })
    expect(schedule.problems.map((p) => `${p.code} ${p.path}`)).toEqual([`extra ${OLD_TEST}`])
  })
})

// ── The CI selection over real commits ─────────────────────────────────────

const scratch: string[] = []
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value
  return { ...env, GIT_AUTHOR_NAME: 'f', GIT_AUTHOR_EMAIL: 'f@x', GIT_COMMITTER_NAME: 'f', GIT_COMMITTER_EMAIL: 'f@x' }
}

function git(cwd: string, args: string[]): string {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv() })
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`)
  return run.stdout.trim()
}

function writeTree(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
}

/** A repository at the moved layout, one commit, and a function committing a change and reading the CI selection for it. */
function movedRepository(): { root: string; decide: (change: Record<string, string>) => CiDecision } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'staged-driver-move-')))
  scratch.push(root)
  git(root, ['init', '-q', '-b', 'main'])
  writeTree(root, treeOf(true))
  git(root, ['add', '-A'])
  git(root, ['commit', '-q', '-m', 'the driver moved'])
  const base = git(root, ['rev-parse', 'HEAD'])
  return {
    root,
    decide: (change) => {
      git(root, ['checkout', '-q', '-B', `change-${Object.keys(change).join('-').replace(/\W/g, '')}`, base])
      writeTree(root, change)
      git(root, ['commit', '-q', '-am', 'change'])
      const out = join(root, '.git', 'decision.json')
      const run = spawnSync('bun', [SELECTION, '--base', base, '--decision', out], {
        cwd: root,
        encoding: 'utf8',
        env: gitEnv()
      })
      if (run.status !== 0) throw new Error(run.stderr)
      return JSON.parse(readFileSync(out, 'utf8')) as CiDecision
    }
  }
}

describe('the CI selection after the move', () => {
  const repo = movedRepository()
  const files = treeOf(true)

  test('a relevant CLI change still selects the moved driver test, in its process-owned shard', () => {
    const decision = repo.decide({ 'apps/cli/src/lib/shared.ts': 'export const shared = () => 10\n' })
    expect(decision).toEqual({
      scope: 'selected',
      selected: [NEW_TEST],
      native: [],
      changed: ['apps/cli/src/lib/shared.ts']
    })
    const schedule = scheduleOf(files, decision)
    expect(placeOf(schedule, NEW_TEST)).toBe(`shard-${schedule.assignments[NEW_TEST]}`)
  }, 60_000)

  test('a relevant kernel change selects it with the kernel test', () => {
    const decision = repo.decide({ 'harness/src/gate.ts': 'export const gate = () => 30\n' })
    expect(decision).toEqual({
      scope: 'selected',
      selected: ['harness/tests/gate.test.ts', NEW_TEST],
      native: [],
      changed: ['harness/src/gate.ts']
    })
    const schedule = scheduleOf(files, decision)
    expect(schedule.accounting.map((e) => e.test)).toEqual(['harness/tests/gate.test.ts', NEW_TEST])
  }, 60_000)

  test('an unrelated CLI change does not run the process suite for its development dependency', () => {
    const decision = repo.decide({ 'apps/cli/src/lib/other.ts': 'export const other = () => 20\n' })
    expect(decision).toEqual({
      scope: 'selected',
      selected: ['apps/cli/tests/other.test.ts'],
      native: [],
      changed: ['apps/cli/src/lib/other.ts']
    })
    const schedule = scheduleOf(files, decision)
    const owners = Object.values(schedule.placements).flatMap((groups) => (groups ?? []).map((g) => g.owner))
    expect(owners).toEqual(['@attalabs/vinaya'])
    expect(placeOf(schedule, 'apps/cli/tests/other.test.ts')).toBe('shard-2')
  }, 60_000)
})
