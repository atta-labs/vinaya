/**
 * Selection by recorded reads, end to end over small repositories whose tests really run:
 *
 * - the replay: five merged-style changes, each with its expected test set pinned, never wider than the static
 *   selection of the same change;
 * - the mutation check: an invalid `process.yaml`, an invalid flow YAML, an emptied doctrine page and a changed
 *   exported function made to throw — the tests that really fail under each mutation are all selected, and every test
 *   selected without failing is listed with its reason; one more case covers a test that runs built `dist/` output;
 * - per-test reuse: a branch that failed 27 of 210 test files and then merged a default branch that deleted a
 *   workspace package re-runs the 27 and the tests reaching the package, not the rest;
 * - the architecture rule: no path-, folder-, owner- or extension-specific rule outside the static fallback.
 *
 * The recorded reads are the fixtures; the oracle is execution, so the check does not use the record it judges.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  bunLockIdentity,
  type InventoryDeclarations as FixtureDeclarations,
  inventoryViewOf as viewOf,
  memoryRepository,
  plannedTests,
  READ_RECORD_SCHEMA,
  type ReadRecord,
  type RecordedTest,
  type SelectionPlan,
  selectTests
} from '@attalabs/test-selection'
import { junitFileResults, marksOnly } from '../../harness/kernel/gates/ring0-hooks/pre-push/junit-store.js'
import { buildCiPlan } from '../ci/impact-plan.ts'
import { freezeLocalPlan, localNativePlan } from './local-run.js'
import { loadSelectionInputs, passEntriesOfRun, storePassEntries, trustedPassProducer } from './repository-selection.js'

const DECLARATIONS: FixtureDeclarations = {
  suites: [{ id: 'all', dir: '.', runner: 'bun', preload: null }],
  edges: [],
  unknowns: [],
  policies: []
}

function selectionOf(
  base: Record<string, string>,
  head: Record<string, string>,
  record: ReadRecord | null,
  failures: readonly string[] = []
): { plan: SelectionPlan; view: ReturnType<typeof viewOf> } {
  const view = viewOf('head', head, DECLARATIONS)
  const plan = selectTests({
    repo: memoryRepository({ base, head }),
    base: 'base',
    head: 'head',
    inventory: { head: view, base: viewOf('base', base, DECLARATIONS) },
    policy: { depth: 'transitive' },
    records: record ? { record, platform: 'linux' } : null,
    history: { context: null, passes: [], failures }
  })
  return { plan, view }
}

const recordOf = (reads: Record<string, string[]>, listed: Record<string, string[]> = {}): ReadRecord => {
  const tests: Record<string, RecordedTest> = {}
  for (const [test, files] of Object.entries(reads))
    tests[test] = { reads: [...new Set([test, ...files])], listed: listed[test] ?? [] }
  return { schema: READ_RECORD_SCHEMA, schemaVersion: 1, commit: 'base', platform: 'linux', tests }
}

// ── The small repository whose tests really run ────────────────────────────

const CORE = 'packages/core/src/index.ts'
const MAIN = 'packages/core/src/main.ts'
const TESTS = 'packages/app/tests'

const BASE_FILES: Record<string, string> = {
  'package.json': '{ "name": "fx", "private": true, "workspaces": ["packages/*"] }\n',
  'packages/core/package.json': '{ "name": "@fx/core", "exports": { ".": "./src/index.ts" } }\n',
  [CORE]:
    'export function double(n: number): number {\n  return n * 2\n}\n\nexport function triple(n: number): number {\n  return n * 3\n}\n',
  [MAIN]: "import { double } from './index.ts'\n\nconsole.log(double(2))\n",
  'packages/app/package.json': '{ "name": "@fx/app" }\n',
  'process.yaml': '{ "name": "process", "version": 1 }\n',
  'flows/main.yaml': '{ "steps": ["a", "b"] }\n',
  'doctrine/page.md': '# Doctrine\n\nA page.\n',
  [`${TESTS}/double.test.ts`]:
    "import { expect, test } from 'bun:test'\nimport { double } from '../../core/src/index.ts'\n\ntest('double', () => expect(double(2)).toBe(4))\n",
  [`${TESTS}/triple.test.ts`]:
    "import { expect, test } from 'bun:test'\nimport { triple } from '../../core/src/index.ts'\n\ntest('triple', () => expect(triple(2)).toBe(6))\n",
  [`${TESTS}/process.test.ts`]:
    "import { expect, test } from 'bun:test'\nimport { readFileSync } from 'node:fs'\nimport { join } from 'node:path'\n\ntest('process', () => expect(JSON.parse(readFileSync(join(import.meta.dir, '../../../process.yaml'), 'utf8')).name).toBe('process'))\n",
  [`${TESTS}/flow.test.ts`]:
    "import { expect, test } from 'bun:test'\nimport { readFileSync } from 'node:fs'\nimport { join } from 'node:path'\n\ntest('flow', () => expect(JSON.parse(readFileSync(join(import.meta.dir, '../../../flows/main.yaml'), 'utf8')).steps.length).toBe(2))\n",
  [`${TESTS}/doctrine.test.ts`]:
    "import { expect, test } from 'bun:test'\nimport { readFileSync } from 'node:fs'\nimport { join } from 'node:path'\n\ntest('doctrine', () => expect(readFileSync(join(import.meta.dir, '../../../doctrine/page.md'), 'utf8').trim().length).toBeGreaterThan(0))\n",
  // Runs built output: bundles the program, then runs the bundle. What it reads of `src/` the recorder files under the
  // package's source folder, never `dist/`.
  [`${TESTS}/dist.test.ts`]:
    "import { expect, test } from 'bun:test'\nimport { spawnSync } from 'node:child_process'\nimport { mkdtempSync } from 'node:fs'\nimport { tmpdir } from 'node:os'\nimport { join } from 'node:path'\n\ntest('dist', () => {\n  const out = join(mkdtempSync(join(tmpdir(), 'fx-dist-')), 'main.js')\n  const built = spawnSync(process.execPath, ['build', join(import.meta.dir, '../../core/src/main.ts'), '--outfile', out])\n  expect(built.status).toBe(0)\n  const ran = spawnSync(process.execPath, [out], { encoding: 'utf8' })\n  expect(ran.status).toBe(0)\n  expect(ran.stdout.trim()).toBe('4')\n})\n"
}

const T = {
  double: `${TESTS}/double.test.ts`,
  triple: `${TESTS}/triple.test.ts`,
  process: `${TESTS}/process.test.ts`,
  flow: `${TESTS}/flow.test.ts`,
  doctrine: `${TESTS}/doctrine.test.ts`,
  dist: `${TESTS}/dist.test.ts`
}

/** What each test read when it ran, as the recorder files it. */
const RECORD = recordOf({
  [T.double]: [CORE],
  [T.triple]: [CORE],
  [T.process]: ['process.yaml'],
  [T.flow]: ['flows/main.yaml'],
  [T.doctrine]: ['doctrine/page.md'],
  [T.dist]: ['packages/core/src/']
})

const change = (files: Record<string, string | null>): Record<string, string> => {
  const out = { ...BASE_FILES }
  for (const [path, text] of Object.entries(files)) {
    if (text === null) delete out[path]
    else out[path] = text
  }
  return out
}

/** Runs every test of `files` for real and returns the ones that fail. */
function failingTests(files: Record<string, string>): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-recorded-'))
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true })
      writeFileSync(join(dir, path), text)
    }
    return Object.values(T)
      .filter((test) => spawnSync(process.execPath, ['test', test], { cwd: dir, stdio: 'ignore' }).status !== 0)
      .sort()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('the replay: pinned test sets, never wider than the static selection', () => {
  const double = BASE_FILES[CORE] as string
  // `narrower`: the static selection cannot place the change, so it runs every test; the record never runs more.
  // Where the static selection is blind to a test (the one that bundles `src/`), the record rightly runs one more.
  const commits: { name: string; files: Record<string, string>; expected: string[]; narrower: boolean }[] = [
    {
      name: 'a body change of an exported function a single test imports',
      files: change({ [CORE]: double.replace('n * 3', 'n * 3 + 0') }),
      expected: [T.dist, T.triple],
      narrower: false
    },
    {
      name: 'a valid edit of process.yaml',
      files: change({ 'process.yaml': '{ "name": "process", "version": 2 }\n' }),
      expected: [T.process],
      narrower: true
    },
    {
      name: 'a new page nothing read',
      files: change({ 'doctrine/new.md': '# New\n' }),
      expected: [],
      narrower: true
    },
    {
      name: 'a valid edit of the flow',
      files: change({ 'flows/main.yaml': '{ "steps": ["a", "c"] }\n' }),
      expected: [T.flow],
      narrower: true
    },
    {
      name: 'a body change of the function the bundled program calls',
      files: change({ [CORE]: double.replace('n * 2', 'n * 2 + 0') }),
      expected: [T.dist, T.double],
      narrower: false
    }
  ]
  for (const commit of commits)
    it(commit.name, () => {
      const recorded = selectionOf(BASE_FILES, commit.files, RECORD)
      const statically = selectionOf(BASE_FILES, commit.files, null)
      expect(plannedTests(recorded.plan)).toEqual([...commit.expected].sort())
      if (commit.narrower)
        expect(plannedTests(recorded.plan).length).toBeLessThanOrEqual(plannedTests(statically.plan).length)
      // The test the static selection cannot see is the one the record adds.
      else expect(plannedTests(statically.plan)).not.toContain(T.dist)
      // Every selected test says why.
      for (const test of recorded.plan.required) expect(test.reasons.length).toBeGreaterThan(0)
    })
})

describe('the mutation check: every test that fails under a mutation is selected', () => {
  const mutations: { name: string; files: Record<string, string>; fails: string[] }[] = [
    { name: 'an invalid process.yaml', files: change({ 'process.yaml': '{ "name": \n' }), fails: [T.process] },
    { name: 'an invalid flow YAML', files: change({ 'flows/main.yaml': '{ "steps": [ \n' }), fails: [T.flow] },
    { name: 'an emptied doctrine page', files: change({ 'doctrine/page.md': '' }), fails: [T.doctrine] },
    {
      name: 'the changed exported function made to throw',
      files: change({
        [CORE]: (BASE_FILES[CORE] as string).replace('return n * 2', "throw new Error('mutant')")
      }),
      fails: [T.double, T.dist]
    }
  ]
  for (const mutation of mutations)
    it(mutation.name, () => {
      const failing = failingTests(mutation.files)
      // The oracle is execution: it finds exactly the tests the mutation breaks.
      expect(failing).toEqual([...mutation.fails].sort())
      const { plan } = selectionOf(BASE_FILES, mutation.files, RECORD)
      const selected = plannedTests(plan)
      for (const test of failing) expect(selected).toContain(test)
      // A selected test that does not fail is listed with its reason.
      for (const test of selected.filter((t) => !failing.includes(t))) {
        const required = plan.required.find((r) => r.test === test)
        expect(required?.reasons.length ?? 0).toBeGreaterThan(0)
      }
      expect(plan.fallbacks).toEqual([])
    }, 60_000)

  it('a test that runs built output is selected by the source folder its build read', () => {
    const { plan } = selectionOf(
      BASE_FILES,
      change({ [MAIN]: (BASE_FILES[MAIN] as string).replace('double(2)', 'double(3)') }),
      RECORD
    )
    expect(plan.required.map((t) => t.test)).toEqual([T.dist])
    expect(plan.required[0]?.reasons[0]?.detail).toContain('packages/core/src/')
  })
})

// ── Per-test reuse ─────────────────────────────────────────────────────────

describe('a branch that failed 27 of 210 test files and merged a default branch that deleted a package', () => {
  const packages = Array.from({ length: 10 }, (_, p) => `p${p}`)
  const fixture = (): Record<string, string> => {
    const files: Record<string, string> = {
      'package.json': '{ "name": "fx", "private": true, "workspaces": ["packages/*"] }\n',
      'packages/gone/package.json': '{ "name": "@fx/gone", "exports": { ".": "./src/index.ts" } }\n',
      'packages/gone/src/index.ts': 'export const gone = 1\n'
    }
    for (const p of packages) {
      files[`packages/${p}/package.json`] = `{ "name": "@fx/${p}", "exports": { ".": "./src/index.ts" } }\n`
      files[`packages/${p}/src/index.ts`] = `export const ${p} = 1\n`
      for (let t = 0; t < 21; t++) {
        const importsGone = p === 'p3' && t < 6
        files[`packages/${p}/tests/t${t}.test.ts`] =
          `import { ${p} } from '../src/index.ts'\n${importsGone ? "import { gone } from '../../gone/src/index.ts'\n" : ''}\nexport const used = [${p}${importsGone ? ', gone' : ''}]\n`
      }
    }
    return files
  }

  it('re-runs the failures and the tests reaching the deleted package, not the rest', () => {
    const base = fixture()
    expect(Object.keys(base).filter((p) => p.endsWith('.test.ts'))).toHaveLength(210)
    const head = { ...base }
    for (const path of Object.keys(head)) if (path.startsWith('packages/gone/')) delete head[path]
    // 27 of the 210 failed, none of them among the six that reach the deleted package.
    const failures = packages
      .flatMap((p) => Array.from({ length: 21 }, (_, t) => `packages/${p}/tests/t${t}.test.ts`))
      .filter((test) => !test.startsWith('packages/p3/tests/t') || Number(test.match(/t(\d+)\./)?.[1]) >= 6)
      .slice(0, 27)
    expect(failures).toHaveLength(27)
    // What each test read when the base ran on the default branch: its own package and, for six, the one deleted.
    const reads: Record<string, string[]> = {}
    for (const test of Object.keys(base).filter((p) => p.endsWith('.test.ts'))) {
      const own = test.split('/').slice(0, 2).join('/')
      reads[test] = [`${own}/src/index.ts`, `${own}/package.json`]
      if (base[test]?.includes('gone')) reads[test].push('packages/gone/src/index.ts', 'packages/gone/package.json')
    }
    const { plan, view } = selectionOf(base, head, recordOf(reads), failures)
    expect(plan.fallbacks).toEqual([])
    const local = localNativePlan({ plan, view })
    expect(local.problems).toEqual([])
    const reached = Array.from({ length: 6 }, (_, t) => `packages/p3/tests/t${t}.test.ts`)
    const ran = local.identities.map((id) => id.replace(/@.*$/, '')).sort()
    expect(ran).toEqual([...new Set([...failures, ...reached])].sort())
    expect(ran).toHaveLength(33)
    expect(ran.length).toBeLessThan(201)
  })
})

// ── The architecture rule ──────────────────────────────────────────────────

describe('no rule outside the static fallback names a path, folder, owner or extension', () => {
  const read = (path: string) => readFileSync(join(import.meta.dir, '../..', path), 'utf8')
  /** The file without its regions between the static-fallback markers. */
  const withoutFallback = (text: string): string =>
    text.replace(/\/\/ static-fallback begin[\s\S]*?\/\/ static-fallback end/g, '')
  /** Code only: no comments and no import lines, which name symbols rather than apply rules. */
  const codeOutside = (text: string): string =>
    withoutFallback(text)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/^import [^\n]*$/gm, '')

  const SELECTOR = 'packages/test-selection/src/selector.ts'
  const BANNED_IN_SELECTOR = [
    'PACKAGE_PROSE_FILE_NAMES',
    'PACKAGE_TEST_DATA_FOLDERS',
    'isPackageTestData',
    'README.md',
    'CHANGELOG.md',
    'nonSourcePackages'
  ]

  it('the selector keeps its package-level non-source edge and its prose exemption inside the static fallback', () => {
    const outside = withoutFallback(read(SELECTOR))
    // `nonSourcePackages` is the type the walk reads; the rule that fills it sits in the fallback region.
    for (const token of BANNED_IN_SELECTOR.filter((t) => t !== 'nonSourcePackages'))
      expect(outside.includes(token), token).toBe(false)
    expect(read(SELECTOR)).toContain('// static-fallback begin')
  })

  for (const file of ['scripts/test-suites/schedule.ts', 'scripts/test-suites/local-run.ts']) {
    it(`${file} holds no owner, folder or extension rule outside the static fallback`, () => {
      const outside = codeOutside(read(file))
      expect(outside.includes('WHOLE_ON_CHANGE_OWNERS'), 'WHOLE_ON_CHANGE_OWNERS').toBe(false)
      expect(outside.includes('@vinaya/portal'), 'a named owner').toBe(false)
      expect(/\.(?:md|ya?ml)['"`]/.test(outside), 'a file extension').toBe(false)
      expect(/['"`](?:apps|packages|harness|scripts|aeg-root|docs)\//.test(outside), 'a literal folder').toBe(false)
    })
  }
})

describe('a lockfile change reaches the tests that read a changed package', () => {
  const lockOf = (zod: string) =>
    `{\n  "lockfileVersion": 1,\n  "workspaces": { "": { "name": "fx" } },\n  "packages": {\n    "react": ["react@18.0.0", "", {}, "sha-r"],\n    "zod": ["zod@${zod}", "", {}, "sha-${zod}"],\n  },\n}\n`
  const base = { ...BASE_FILES, 'bun.lock': lockOf('3.0.0') }
  const record = recordOf({
    [T.double]: [CORE, 'bun.lock#zod'],
    [T.triple]: [CORE, 'bun.lock#react'],
    [T.process]: ['process.yaml', 'bun.lock'],
    [T.flow]: ['flows/main.yaml'],
    [T.doctrine]: ['doctrine/page.md'],
    [T.dist]: ['packages/core/src/']
  })
  const select = (head: Record<string, string>, parse: boolean) => {
    const plan = selectTests({
      repo: memoryRepository({ base, head }),
      base: 'base',
      head: 'head',
      inventory: { head: viewOf('head', head, DECLARATIONS), base: viewOf('base', base, DECLARATIONS) },
      policy: {
        depth: 'transitive',
        ...(parse ? { parsers: { 'bun-lock': (text: string) => bunLockIdentity(Bun.JSONC.parse(text)) } } : {})
      },
      records: { record, platform: 'linux' }
    })
    return plannedTests(plan).sort()
  }

  it('selects the readers of the changed package and of the whole lockfile, not the readers of another package', () => {
    expect(select({ ...base, 'bun.lock': lockOf('3.1.0') }, true)).toEqual([T.double, T.process].sort())
  })

  it('selects every package reader when the lockfile cannot be compared package by package', () => {
    expect(select({ ...base, 'bun.lock': lockOf('3.1.0') }, false)).toEqual([T.double, T.process, T.triple].sort())
  })
})

// ── One entry point: the push gate and CI only call it ────────────────────

/** A small git repository shaped like this one: a workspace suite, a repository suite and committed declarations. */
function callersRepository(): { dir: string; git: (...args: string[]) => string; base: string; head: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vinaya-callers-')))
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd: dir,
      encoding: 'utf8',
      env
    }).trim()
  const inventory = {
    schema: 'vinaya.test-inventory',
    schemaVersion: 1,
    declarationVersion: 1,
    suites: [
      { id: 'app', owner: '@fx/app', kind: 'workspace', dir: 'packages/app', runner: 'bun', preload: null },
      {
        id: 'repository',
        owner: 'repository',
        kind: 'repository',
        dir: '.',
        runner: 'bun',
        preload: null,
        tests: ['scripts/check.test.ts']
      }
    ],
    typeInputs: [{ path: 'packages/core', role: 'the library the app tests import' }],
    exclusions: [],
    inputs: [],
    providers: [],
    policies: [
      {
        id: 'inventory-gate',
        kind: 'mandatory',
        inputs: ['scripts/test-suites/'],
        duty: 'the repository suite runs on every change',
        source: 'ci'
      }
    ],
    unknowns: []
  }
  const files: Record<string, string> = {
    'package.json': '{ "name": "callers", "private": true, "workspaces": ["packages/*"] }\n',
    'packages/core/package.json': '{ "name": "@fx/core" }\n',
    'packages/core/src/add.ts': 'export const add = (a: number, b: number) => a + b\n',
    'packages/core/src/mul.ts': 'export const mul = (a: number, b: number) => a * b\n',
    'packages/app/package.json': '{ "name": "@fx/app", "scripts": { "test": "bun test" } }\n',
    'packages/app/tests/add.test.ts': "import { add } from '../../core/src/add.ts'\nexport const used = add\n",
    'packages/app/tests/mul.test.ts': "import { mul } from '../../core/src/mul.ts'\nexport const used = mul\n",
    'scripts/check.test.ts': "import { test } from 'bun:test'\ntest('check', () => {})\n",
    'scripts/test-suites/inventory.json': `${JSON.stringify(inventory, null, 2)}\n`,
    'vinaya.config.json': '{ "prePush": { "alwaysRun": [] } }\n'
  }
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  const base = git('rev-parse', 'HEAD')
  git('update-ref', 'refs/remotes/origin/main', base)
  git('checkout', '-q', '-b', 'task/x/1')
  writeFileSync(join(dir, 'packages/core/src/add.ts'), 'export const add = (a: number, b: number) => b + a\n')
  git('commit', '-q', '-am', 'head')
  return { dir, git, base, head: git('rev-parse', 'HEAD') }
}

const NO_RECORD = () => ({ record: null, reason: 'no record in this fixture' })

/** The tests the push gate's frozen plan runs. */
function pushRunList(dir: string): string[] {
  const { note } = freezeLocalPlan(dir)
  return [...new Set((note.native?.identities ?? []).map((id) => id.replace(/@[^@]*$/, '')))].sort()
}

/** The tests CI's plan runs for a pull request from `base` to `head`. */
function ciRunList(dir: string, base: string, head: string, passes?: string): string[] {
  const plan = buildCiPlan({
    repoRoot: dir,
    event: 'pull_request',
    base,
    approvedHead: head,
    testedTree: head,
    guard: { verdict: 'plan', reason: 'the fixture changes no planning input', guarded: [] },
    reachRecord: NO_RECORD,
    fetch: () => {},
    ...(passes ? { passes } : {})
  })
  expect(plan.scope).toBe('selected')
  return plan.tests.map((t) => t.test).sort()
}

describe('the push gate and CI run exactly the one entry point’s planned tests', () => {
  let previous: string | undefined
  beforeAll(() => {
    previous = process.env.VINAYA_READ_RECORD
    // No record anywhere: the push and CI see the same (absent) record without a network call.
    process.env.VINAYA_READ_RECORD = 'off'
  })
  afterAll(() => {
    if (previous === undefined) delete process.env.VINAYA_READ_RECORD
    else process.env.VINAYA_READ_RECORD = previous
  })

  it('for one base, head, record and platform, the two run lists are the same set and equal plannedTests', () => {
    const { dir, base, head } = callersRepository()
    try {
      const expected = plannedTests(
        selectTests(loadSelectionInputs({ repoRoot: dir, caller: 'ci', base, head, reach: NO_RECORD }))
      )
      const viaPush = plannedTests(
        selectTests(loadSelectionInputs({ repoRoot: dir, caller: 'push', reach: NO_RECORD }))
      )
      expect(expected).toEqual(['packages/app/tests/add.test.ts', 'scripts/check.test.ts'])
      expect(viaPush).toEqual(expected)
      expect(pushRunList(dir)).toEqual(expected)
      expect(ciRunList(dir, base, head)).toEqual(expected)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it('the push gate reuses a complete pass whose key matches at the pushed head, and only then', () => {
    const { dir, git, head } = callersRepository()
    try {
      const view = loadSelectionInputs({ repoRoot: dir, caller: 'push', reach: NO_RECORD }).inventory.head
      const report = (file: string, body: string) =>
        `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test">\n  <testsuite name="${file}" file="${file}" tests="1">\n${body}  </testsuite>\n</testsuites>\n`
      const passed = '    <testcase name="t" file="x" />\n'
      // A complete pass of `add.test.ts`, run in its suite's folder, and a skip-carrying run of `check.test.ts`.
      const entries = passEntriesOfRun({
        repoRoot: dir,
        view,
        reports: [
          { cwd: 'packages/app', xml: report('tests/add.test.ts', passed) },
          { cwd: '.', xml: report('scripts/check.test.ts', `${passed}    <testcase name="s"><skipped /></testcase>\n`) }
        ],
        record: null,
        source: 'a hand run'
      })
      expect(entries.map((e) => [e.test, e.head])).toEqual([['packages/app/tests/add.test.ts', head]])
      storePassEntries(dir, entries)
      const reused = selectTests(loadSelectionInputs({ repoRoot: dir, caller: 'push', reach: NO_RECORD }))
      expect(reused.reused.map((r) => r.test)).toEqual(['packages/app/tests/add.test.ts'])
      expect(pushRunList(dir)).toEqual(['scripts/check.test.ts'])
      // Any tracked change: with no record the key is the whole tree, so the pass no longer holds.
      writeFileSync(join(dir, 'packages/core/src/mul.ts'), 'export const mul = (a: number, b: number) => b * a\n')
      git('commit', '-q', '-am', 'later')
      expect(pushRunList(dir)).toEqual([
        'packages/app/tests/add.test.ts',
        'packages/app/tests/mul.test.ts',
        'scripts/check.test.ts'
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it('CI reuses the pass entries an earlier run of the same pull request stored, unless their key changed', () => {
    const { dir, git, base, head } = callersRepository()
    const passes = realpathSync(mkdtempSync(join(tmpdir(), 'vinaya-ci-passes-')))
    try {
      const view = loadSelectionInputs({ repoRoot: dir, caller: 'ci', base, head, reach: NO_RECORD }).inventory.head
      const xml =
        '<testsuites name="bun test">\n  <testsuite name="scripts/check.test.ts" file="scripts/check.test.ts" tests="1">\n    <testcase name="check" />\n  </testsuite>\n</testsuites>\n'
      const entries = passEntriesOfRun({
        repoRoot: dir,
        view,
        reports: [{ cwd: '.', xml }],
        record: null,
        source: 'ci shared'
      })
      // The workflow files each run's artifacts under the head commit GitHub reports for that run.
      mkdirSync(join(passes, head, '1'), { recursive: true })
      writeFileSync(join(passes, head, '1', 'shared.json'), JSON.stringify({ version: 1, entries }))
      expect(ciRunList(dir, base, head)).toEqual(['packages/app/tests/add.test.ts', 'scripts/check.test.ts'])
      expect(ciRunList(dir, base, head, passes)).toEqual(['packages/app/tests/add.test.ts'])
      // The next push to the pull request changes a tracked file: the stored pass no longer holds.
      writeFileSync(join(dir, 'vinaya.config.json'), '{ "prePush": { "alwaysRun": [] }, "x": 1 }\n')
      git('commit', '-q', '-am', 'next push')
      expect(ciRunList(dir, base, git('rev-parse', 'HEAD'), passes)).toContain('scripts/check.test.ts')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(passes, { recursive: true, force: true })
    }
  }, 120_000)

  it('CI reuses only entries filed under a commit of this branch whose every change is still under review', () => {
    const { dir, git, base, head } = callersRepository()
    const passes = realpathSync(mkdtempSync(join(tmpdir(), 'vinaya-ci-passes-')))
    try {
      // Another pull request's branch of the same name: a commit outside this branch's history.
      git('checkout', '-q', '-b', 'fork/x/1', base)
      writeFileSync(join(dir, 'packages/core/src/mul.ts'), 'export const mul = (a: number, b: number) => b * a\n')
      git('commit', '-q', '-am', 'a fork')
      const fork = git('rev-parse', 'HEAD')
      // This branch: a commit whose change is reverted before the head under review.
      git('checkout', '-q', 'task/x/1')
      writeFileSync(join(dir, 'scripts/forge.ts'), 'export const forged = true\n')
      git('add', '-A')
      git('commit', '-q', '-m', 'forge')
      const reverted = git('rev-parse', 'HEAD')
      git('rm', '-q', 'scripts/forge.ts')
      git('commit', '-q', '-m', 'revert')
      const final = git('rev-parse', 'HEAD')
      // Entries whose key matches the head under review, as a run that wrote whatever it liked could produce them.
      const view = loadSelectionInputs({ repoRoot: dir, caller: 'ci', base, head: final, reach: NO_RECORD }).inventory
        .head
      const xml =
        '<testsuites name="bun test">\n  <testsuite name="scripts/check.test.ts" file="scripts/check.test.ts" tests="1">\n    <testcase name="check" />\n  </testsuite>\n</testsuites>\n'
      const entries = passEntriesOfRun({
        repoRoot: dir,
        view,
        reports: [{ cwd: '.', xml }],
        record: null,
        source: 'ci'
      })
      expect(entries.map((e) => e.test)).toEqual(['scripts/check.test.ts'])
      const file = (folder: string) => {
        mkdirSync(join(passes, folder, '1'), { recursive: true })
        writeFileSync(join(passes, folder, '1', 'shared.json'), JSON.stringify({ version: 1, entries }))
      }
      const unplanned = ['packages/app/tests/add.test.ts', 'scripts/check.test.ts']
      for (const folder of [fork, reverted, 'not-a-commit']) {
        file(folder)
        expect(trustedPassProducer(dir, base, final, folder)).toBe(false)
        expect(ciRunList(dir, base, final, passes)).toEqual(unplanned)
        rmSync(join(passes, folder), { recursive: true, force: true })
      }
      // The earlier head, whose one change is still in the change under review, is trusted.
      expect(trustedPassProducer(dir, base, final, head)).toBe(true)
      file(head)
      expect(ciRunList(dir, base, final, passes)).toEqual(['packages/app/tests/add.test.ts'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(passes, { recursive: true, force: true })
    }
  }, 120_000)

  it('a JUnit report counts a file passed only when every test in it ran and passed', () => {
    const suite = (file: string, body: string, attrs = '') =>
      `  <testsuite name="${file}" file="${file}"${attrs}>\n${body}  </testsuite>\n`
    const xml = [
      '<testsuites name="bun test">',
      suite('a.test.ts', '    <testcase name="ok" />\n'),
      suite('skip.test.ts', '    <testcase name="ok" />\n    <testcase name="s"><skipped /></testcase>\n'),
      suite('todo.test.ts', '    <testcase name="t"><skipped message="TODO" /></testcase>\n'),
      suite('fail.test.ts', '    <testcase name="f"><failure message="x">x</failure></testcase>\n', ' failures="1"'),
      suite('empty.test.ts', ''),
      '</testsuites>',
      ''
    ].join('\n')
    expect(junitFileResults(xml)).toEqual([
      { file: 'a.test.ts', passed: true },
      { file: 'empty.test.ts', passed: false },
      { file: 'fail.test.ts', passed: false },
      { file: 'skip.test.ts', passed: false },
      { file: 'todo.test.ts', passed: false }
    ])
    // A truncated report proves nothing.
    expect(junitFileResults(xml.slice(0, xml.length - 20))).toBeNull()
    // `.only` leaves the other tests out of the report: the file's source decides.
    expect(marksOnly("test.only('a', () => {})")).toBe(true)
    expect(marksOnly("describe . only ('a', () => {})")).toBe(true)
    expect(marksOnly("test('only the start', () => {})")).toBe(false)
  })
})
