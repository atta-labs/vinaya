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
import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  memoryRepository,
  plannedTests,
  READ_RECORD_SCHEMA,
  type ReadRecord,
  type RecordedTest,
  type SelectionPlan,
  selectTests
} from '../../harness/kernel/gates/ring0-hooks/pre-push/verification/index.js'
import {
  type FixtureDeclarations,
  viewOf
} from '../../harness/kernel/gates/ring0-hooks/pre-push/verification/tests/fixture-repos.js'
import { localNativePlan } from './local-run.js'

const DECLARATIONS: FixtureDeclarations = {
  suites: [{ id: 'all', dir: '.', runner: 'bun', preload: null }],
  edges: [],
  unknowns: [],
  policies: []
}

function selectionOf(
  base: Record<string, string>,
  head: Record<string, string>,
  record: ReadRecord | null
): { plan: SelectionPlan; view: ReturnType<typeof viewOf> } {
  const view = viewOf('head', head, DECLARATIONS)
  const plan = selectTests({
    repo: memoryRepository({ base, head }),
    base: 'base',
    head: 'head',
    inventory: { head: view, base: viewOf('base', base, DECLARATIONS) },
    policy: { depth: 'transitive' },
    records: record ? { record, platform: 'linux' } : null
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
    const { plan, view } = selectionOf(base, head, recordOf(reads))
    expect(plan.fallbacks).toEqual([])
    const local = localNativePlan({ plan, view, obligations: failures })
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

  const SELECTOR = 'harness/kernel/gates/ring0-hooks/pre-push/verification/selector.ts'
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
