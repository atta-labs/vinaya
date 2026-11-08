// The selection library's own tests. They import only the public entrypoint
// and their fixture helper, read only their committed fixture repositories,
// and need no preload, global or configuration — they run unchanged from a
// copy of this directory.
import { describe, expect, it } from 'bun:test'
import { posix } from 'node:path'
import {
  lineDiffRanges,
  memoryRepository,
  parseHunkRanges,
  plannedTests,
  READ_RECORD_SCHEMA,
  type ReadRecord,
  type RecordedTest,
  type RepositoryReader,
  type ResolvedEdge,
  SelectionInputError,
  type SelectionPlan,
  selectTests,
  stableHash,
  validateInventory
} from '../index.js'
import { FIXTURES, type Fixture, fixture, type Scenario, scenarioInput, TEST_NAME, viewOf } from './fixture-repos.js'

const setup = (fx: Fixture, scenario: Scenario, overrides: { repo?: RepositoryReader } = {}) =>
  scenarioInput(fx, scenario, overrides)

const semantic = (plan: SelectionPlan): Omit<SelectionPlan, 'profile'> => {
  const { profile: _profile, ...rest } = plan
  return rest
}

// ── The scenarios ──────────────────────────────────────────────────────────

describe('selectTests on two differently structured repositories', () => {
  for (const name of FIXTURES) {
    const fx = fixture(name)
    for (const scenario of fx.scenarios) {
      it(`${name}: ${scenario.name}`, () => {
        const plan = selectTests(setup(fx, scenario))
        expect(plan.required.map((t) => t.test)).toEqual([...scenario.required].sort())
        expect(plan.fallbacks.map((f) => f.id)).toEqual(scenario.fallbacks)
        expect(plan.removedTests).toEqual(scenario.removedTests ?? [])
        expect(plan.renamedTests).toEqual(scenario.renamedTests ?? [])
        if (scenario.policies) expect(plan.policies.map((p) => p.id)).toEqual(scenario.policies)
        for (const [test, revision] of Object.entries(scenario.requiredRevision ?? {}))
          expect(plan.required.find((t) => t.test === test)?.reasons.map((r) => r.revision)).toEqual([revision])
        // Every change is accounted for, and every required test says why.
        expect(plan.changes.length).toBeGreaterThan(0)
        for (const change of plan.changes) expect(change.accountedBy.length).toBeGreaterThan(0)
        for (const test of plan.required) expect(test.reasons.length).toBeGreaterThan(0)
        // A fallback scope is every test, said so — never a silent expansion.
        const every = setup(fx, scenario)
          .inventory.head.tests.map((t) => t.id)
          .sort()
        for (const scope of plan.fallbacks) {
          expect(scope.reason.length).toBeGreaterThan(0)
          expect(scope.tests).toEqual(every)
        }
      })
    }
  }

  it('the same immutable inputs give the same ordered plan, whatever order the reader lists in', () => {
    const fx = fixture('workspaces-repo.json')
    const scenario = fx.scenarios[1] as Scenario
    const first = selectTests(setup(fx, scenario))
    const second = selectTests(setup(fx, scenario))
    expect(JSON.stringify(semantic(second))).toBe(JSON.stringify(semantic(first)))
    const sorted = setup(fx, scenario).repo
    const reversed: RepositoryReader = {
      list: (revision) => [...sorted.list(revision)].reverse(),
      read: (revision, path) => sorted.read(revision, path),
      identity: (revision, path) => sorted.identity?.(revision, path) ?? null
    }
    expect(selectTests(setup(fx, scenario, { repo: reversed })).identity).toBe(first.identity)
    // Timings live in `profile` and never reach the identity.
    const { identity, ...rest } = semantic(first)
    expect(stableHash(rest)).toBe(identity)
  })

  it('reads only the two requested revisions, through the reader alone, and runs nothing', () => {
    const fx = fixture('workspaces-repo.json')
    const scenario = fx.scenarios[2] as Scenario
    const inner = setup(fx, scenario).repo
    const calls: string[] = []
    const instrumented: RepositoryReader = {
      list: (revision) => {
        calls.push(`list ${revision}`)
        return inner.list(revision)
      },
      read: (revision, path) => {
        calls.push(`read ${revision}`)
        return inner.read(revision, path)
      },
      identity: (revision, path) => {
        calls.push(`identity ${revision}`)
        return inner.identity?.(revision, path) ?? null
      }
    }
    const before = JSON.stringify(fx)
    const plan = selectTests(setup(fx, scenario, { repo: instrumented }))
    expect(plan.required.length).toBeGreaterThan(0)
    expect(new Set(calls.map((c) => c.split(' ')[1]))).toEqual(new Set(['base', 'head']))
    expect(new Set(calls.map((c) => c.split(' ')[0]))).toEqual(new Set(['list', 'read', 'identity']))
    expect(JSON.stringify(fx)).toBe(before)
  })

  it('obligations are explicit additions, never part of what the change requires', () => {
    const fx = fixture('workspaces-repo.json')
    const scenario = fx.scenarios[0] as Scenario
    const bare = selectTests(setup(fx, scenario))
    const input = setup(fx, scenario)
    const withObligations = selectTests({
      ...input,
      policy: {
        ...input.policy,
        obligations: [
          { id: 'always', kind: 'policy', reason: 'runs on every change', tests: ['packages/app/tests/add.test.ts'] },
          { id: 'linux', kind: 'platform', reason: 'the platform job runs the suite', suites: ['app'] }
        ]
      }
    })
    expect(withObligations.required).toEqual(bare.required)
    expect(withObligations.obligations.filter((o) => o.obligation === 'always').map((o) => o.test)).toEqual([
      'packages/app/tests/add.test.ts'
    ])
    expect(withObligations.obligations.filter((o) => o.obligation === 'linux')).toHaveLength(12)
    expect(withObligations.identity).not.toBe(bare.identity)
    expect(plannedTests(withObligations)).toContain('packages/app/tests/add.test.ts')
  })

  it('a base with no valid inventory falls back for every change, named', () => {
    const fx = fixture('workspaces-repo.json')
    const scenario = fx.scenarios[0] as Scenario
    const input = setup(fx, scenario)
    const plan = selectTests({ ...input, inventory: { head: input.inventory.head, base: null } })
    expect(plan.fallbacks.map((f) => f.id)).toEqual(['base-unmodeled'])
    expect(plan.fallbacks[0]?.paths).toEqual(['packages/core/src/mul.ts'])
  })

  it('the text-scan graph never selects less than the compiler graph', () => {
    const fx = fixture('workspaces-repo.json')
    for (const scenario of fx.scenarios) {
      const compiler = selectTests(setup(fx, scenario))
      const text = selectTests(setup(fx, { ...scenario, policy: { ...scenario.policy, resolver: 'text-scan' } }))
      expect(text.context.resolver).toBe('text-scan')
      for (const test of plannedTests(compiler)) expect(plannedTests(text)).toContain(test)
    }
  })
})

describe('selectTests refuses inputs it cannot answer for', () => {
  const fx = fixture('workspaces-repo.json')
  const scenario = fx.scenarios[0] as Scenario

  it('an inventory built for another revision', () => {
    const input = setup(fx, scenario)
    expect(() => selectTests({ ...input, head: 'elsewhere' })).toThrow(SelectionInputError)
    expect(() => selectTests({ ...input, base: 'elsewhere' })).toThrow(SelectionInputError)
  })

  it('a revision the reader cannot list', () => {
    const input = setup(fx, scenario)
    const broken: RepositoryReader = {
      list: (revision) => {
        if (revision === 'base') throw new Error('object not found')
        return input.repo.list(revision)
      },
      read: (revision, path) => input.repo.read(revision, path)
    }
    expect(() => selectTests({ ...input, repo: broken })).toThrow(/cannot be listed/)
  })

  it('a view whose edge names a reader that is not one of its tests', () => {
    const input = setup(fx, scenario)
    const head = input.inventory.head
    const bad = {
      ...head,
      edges: [...head.edges, { ...(head.edges[0] as ResolvedEdge), readers: ['nowhere.test.ts'] }]
    }
    expect(validateInventory({ head: bad, base: null }).map((p) => p.detail)).toEqual([
      'edge suite:app names nowhere.test.ts, which is not a test of this view'
    ])
    expect(() => selectTests({ ...input, inventory: { head: bad, base: input.inventory.base } })).toThrow(
      SelectionInputError
    )
  })
})

// ── Tests that start a script ──────────────────────────────────────────────

describe('a test that starts a script is linked to that script, not to the whole program folder', () => {
  const fx = fixture('workspaces-repo.json')
  const startTest = (name: string, body: string[]) => [
    `packages/app/tests/${name}.test.ts`,
    [
      "import { expect, test } from 'bun:test'",
      "import { readFileSync } from 'node:fs'",
      "import { spawnSync } from 'node:child_process'",
      "import { join } from 'node:path'",
      '',
      "const TOOLS = join(import.meta.dir, '../../../tools')",
      ...body,
      ''
    ].join('\n')
  ]
  const files: Record<string, string> = {
    ...fx.files,
    'tools/build.ts': "import { format } from './format.js'\n\nconsole.log(format(['build']))\n",
    'tools/lone.ts': 'export const lone = 1\n',
    'tools/relay.ts': "import { spawnSync } from 'node:child_process'\n\nspawnSync('bun', ['--version'])\n",
    ...Object.fromEntries([
      startTest('build', [
        "test('build', () => expect(spawnSync('bun', [join(TOOLS, 'build.ts'), 'tools/lone.ts']).status).toBe(0))"
      ]),
      startTest('hash', [
        "test('build', () => expect(spawnSync('bun', [join(TOOLS, 'build.ts')]).status).toBe(0))",
        "test('hash', () => expect(readFileSync(join(TOOLS, 'cli.ts'), 'utf8').length).toBeGreaterThan(0))"
      ]),
      startTest('relay', ["test('relay', () => expect(spawnSync('bun', [join(TOOLS, 'relay.ts')]).status).toBe(0))"])
    ])
  }
  const required = (path: string, text: string): string[] => {
    const head = { ...files, [path]: text }
    const plan = selectTests({
      repo: memoryRepository({ base: files, head }),
      base: 'base',
      head: 'head',
      inventory: { head: viewOf('head', head, fx.inventory), base: viewOf('base', files, fx.inventory) },
      policy: { depth: 'transitive', ...fx.policy }
    })
    return plan.required.map((t) => t.test)
  }
  const FORMAT = "export function format(args: string[]): string {\n  return args.join('+')\n}\n"

  it('a `bun <script>` start is selected by a change the script imports, and not by one it does not', () => {
    expect(required('tools/format.ts', FORMAT)).toContain('packages/app/tests/build.test.ts')
    // `tools/lone.ts` is only an argument after the script — never linked.
    expect(required('tools/lone.ts', 'export const lone = 2\n')).not.toContain('packages/app/tests/build.test.ts')
  })

  it('a test that also names a program path without `bun` on the same call keeps the coarse folder edge', () => {
    expect(required('tools/lone.ts', 'export const lone = 2\n')).toContain('packages/app/tests/hash.test.ts')
  })

  it('a test starting a script that itself starts `bun` keeps the coarse folder edge', () => {
    expect(required('tools/lone.ts', 'export const lone = 2\n')).toContain('packages/app/tests/relay.test.ts')
    expect(required('tools/format.ts', FORMAT)).toContain('packages/app/tests/relay.test.ts')
  })
})

// ── An independent oracle ──────────────────────────────────────────────────

/**
 * Which repository files each test reads by a literal path, derived from the
 * test's own source text — a different mechanism from the inventory's edges,
 * so a reader the inventory forgot shows up as a miss.
 */
function literalReads(files: Record<string, string>): { test: string; input: string }[] {
  const out: { test: string; input: string }[] = []
  for (const [path, text] of Object.entries(files)) {
    if (!TEST_NAME.test(path)) continue
    for (const m of text.matchAll(/join\(import\.meta\.dir, '([^']+)'\)/g)) {
      const input = posix.normalize(posix.join(posix.dirname(path), m[1] as string))
      if (input in files) out.push({ test: path, input })
      else if (Object.keys(files).some((f) => f.startsWith(`${input}/`)))
        for (const f of Object.keys(files)) if (f.startsWith(`${input}/`)) out.push({ test: path, input: f })
    }
    for (const m of text.matchAll(/readFileSync\('([^']+)'/g))
      if ((m[1] as string) in files) out.push({ test: path, input: m[1] as string })
  }
  return out
}

/** A change to `input` that alters what any reader of it reads. */
function mutate(text: string, input: string): string {
  return input.endsWith('.json') ? '{ "oracle": true }\n' : `${text}\n// oracle\n`
}

function oracleMisses(fx: Fixture, dropReader?: { source: string; test: string }): string[] {
  const misses: string[] = []
  const decl = dropReader
    ? {
        ...fx.inventory,
        edges: fx.inventory.edges.map((e) =>
          e.source === dropReader.source ? { ...e, readers: e.readers.filter((r) => r !== dropReader.test) } : e
        )
      }
    : fx.inventory
  for (const { test, input } of literalReads(fx.files)) {
    const head = { ...fx.files, [input]: mutate(fx.files[input] as string, input) }
    const plan = selectTests({
      repo: memoryRepository({ base: fx.files, head }),
      base: 'base',
      head: 'head',
      inventory: { head: viewOf('head', head, decl), base: viewOf('base', fx.files, decl) },
      // The never-miss claim is the transitive walk's; depth one trades it away on purpose.
      policy: { depth: 'transitive', ...fx.policy }
    })
    if (!plannedTests(plan).includes(test)) misses.push(`${test} reads ${input}`)
  }
  return misses
}

describe('an independent mutation oracle', () => {
  it('finds every literal read covered, on both fixtures', () => {
    for (const name of FIXTURES) expect(oracleMisses(fixture(name))).toEqual([])
    expect(literalReads(fixture('workspaces-repo.json').files).length).toBeGreaterThan(5)
  })

  it('detects a deliberately missing reader', () => {
    const fx = fixture('workspaces-repo.json')
    expect(oracleMisses(fx, { source: 'table', test: 'packages/app/tests/data.test.ts' })).toEqual([
      'packages/app/tests/data.test.ts reads packages/app/tests/fixtures/table.txt'
    ])
  })

  it('a read no literal names is still covered, by its unknown scope', () => {
    const fx = fixture('workspaces-repo.json')
    expect(literalReads(fx.files).some((r) => r.test.endsWith('opaque.test.ts'))).toBe(false)
    const head = { ...fx.files, 'opaque/input.json': '{ "value": 3 }\n' }
    const plan = selectTests({
      repo: memoryRepository({ base: fx.files, head }),
      base: 'base',
      head: 'head',
      inventory: { head: viewOf('head', head, fx.inventory), base: viewOf('base', fx.files, fx.inventory) },
      policy: { depth: 'one', ...fx.policy }
    })
    expect(plannedTests(plan)).toContain('packages/app/tests/opaque.test.ts')
  })
})

// ── Recorded reads ─────────────────────────────────────────────────────────

describe('selectTests decided by recorded reads', () => {
  const fx = fixture('workspaces-repo.json')
  const RECORD_COMMIT = 'record'
  const core = 'packages/core/src'
  const reading: Record<string, Partial<RecordedTest>> = {
    'packages/app/tests/add.test.ts': { reads: [`${core}/index.ts`, `${core}/add.ts`] },
    'packages/app/tests/mul.test.ts': { reads: [`${core}/index.ts`, `${core}/mul.ts`, `${core}/add.ts`] },
    'packages/app/tests/square.test.ts': { reads: [`${core}/index.ts`, `${core}/mul.ts`, `${core}/add.ts`] },
    'packages/app/tests/tree.test.ts': { reads: [], listed: [core] },
    'packages/app/tests/opaque.test.ts': { reads: ['opaque/input.json', 'scratch/notes.txt'] }
  }
  /** A record taken at the comparison's base, one entry per test of the fixture unless an override drops it. */
  const record = (overrides: Record<string, Partial<RecordedTest> | null> = {}, commit = 'base'): ReadRecord => {
    const tests: Record<string, RecordedTest> = {}
    for (const test of viewOf('head', fx.files, fx.inventory).tests.map((t) => t.id)) {
      if (overrides[test] === null) continue
      const own = { ...(reading[test] ?? {}), ...(overrides[test] ?? {}) }
      tests[test] = { ...own, reads: [...new Set([test, ...(own.reads ?? [])])], listed: own.listed ?? [] }
    }
    return { schema: READ_RECORD_SCHEMA, schemaVersion: 1, commit, platform: 'linux', tests }
  }
  const scenario = (change: Record<string, string | null>): Scenario => ({
    name: 'recorded',
    depth: 'transitive',
    change,
    required: [],
    fallbacks: []
  })
  const select = (change: Record<string, string | null>, records: ReadRecord | null, platform = 'linux') =>
    selectTests({
      ...scenarioInput(fx, scenario(change)),
      records: records ? { record: records, platform } : null
    })
  const headOf = (change: Record<string, string | null>) => {
    const files = { ...fx.files }
    for (const [path, text] of Object.entries(change)) {
      if (text === null) delete files[path]
      else files[path] = text
    }
    return files
  }

  it('a path nothing models selects only the test whose record read it, and falls back for no one', () => {
    const plan = select({ 'scratch/notes.txt': 'changed\n' }, record())
    expect(plan.required.map((t) => t.test)).toEqual(['packages/app/tests/opaque.test.ts'])
    expect(plan.required[0]?.reasons[0]?.kind).toBe('recorded-read')
    expect(plan.fallbacks).toEqual([])
    expect(plan.records.commit).toBe('base')
    expect(plan.records.fallbacks).toEqual([])
    expect(plan.changes[0]?.accountedBy).toContain('record')
  })

  it('without a record the same change falls back to every test, named', () => {
    const plan = select({ 'scratch/notes.txt': 'changed\n' }, null)
    expect(plan.fallbacks.map((f) => f.id)).toEqual(['unattributed'])
    expect(plan.records.fallbacks.map((f) => f.id)).toEqual(['no-reachable-record'])
    expect(plan.records.recorded).toEqual([])
  })

  it('a test with no record is decided statically while the others are decided by their records', () => {
    const plan = select({ 'scratch/notes.txt': 'changed\n' }, record({ 'packages/app/tests/data.test.ts': null }))
    expect(plan.fallbacks.map((f) => f.id)).toEqual(['unattributed'])
    expect(plan.fallbacks[0]?.tests).toEqual(['packages/app/tests/data.test.ts'])
    expect(plan.required.map((t) => t.test)).toEqual(['packages/app/tests/opaque.test.ts'])
    expect(plan.records.fallbacks).toEqual([
      expect.objectContaining({ id: 'no-record', tests: ['packages/app/tests/data.test.ts'] })
    ])
  })

  it('an added or deleted path selects the test that listed its folder; a modified one does not', () => {
    const added = select({ [`${core}/extra.ts`]: 'export const extra = 1\n' }, record())
    expect(added.required.map((t) => t.test)).toEqual(['packages/app/tests/tree.test.ts'])
    const deleted = select({ [`${core}/add.ts`]: null }, record())
    expect(deleted.required.map((t) => t.test)).toContain('packages/app/tests/tree.test.ts')
    const modified = select(
      { [`${core}/add.ts`]: 'export function add(a: number, b: number): number {\n  return b + a\n}\n' },
      record()
    )
    expect(modified.required.map((t) => t.test)).not.toContain('packages/app/tests/tree.test.ts')
  })

  it('a lookup that failed is a read: the path added later selects the test', () => {
    const plan = select(
      { 'probe/missing.json': '{}\n' },
      record({ 'packages/app/tests/data.test.ts': { reads: ['probe/missing.json'] } })
    )
    expect(plan.required.map((t) => t.test)).toEqual(['packages/app/tests/data.test.ts'])
  })

  it('a changed exported declaration the import closure does not reach narrows the recorded read', () => {
    const mul = fx.files[`${core}/mul.ts`] as string
    const plan = select({ [`${core}/mul.ts`]: mul.replace('return a * a', 'return a ** 2') }, record())
    expect(plan.required.map((t) => t.test)).toEqual(['packages/app/tests/square.test.ts'])
  })

  it('top-level code, an import or an initialiser always selects every test whose record contains the file', () => {
    const mul = fx.files[`${core}/mul.ts`] as string
    const plan = select({ [`${core}/mul.ts`]: `${mul}\nconsole.log('loaded')\n` }, record())
    expect(plan.required.map((t) => t.test)).toEqual([
      'packages/app/tests/mul.test.ts',
      'packages/app/tests/square.test.ts'
    ])
  })

  it('a folder read selects on any path beneath it, and a read under a package build output is its source folder', () => {
    const plan = select(
      { [`${core}/mul.ts`]: `${fx.files[`${core}/mul.ts`]}\n// edit\n` },
      record({ 'packages/app/tests/cli.test.ts': { reads: [`${core}/`] } })
    )
    expect(plan.required.map((t) => t.test)).toContain('packages/app/tests/cli.test.ts')
  })

  it('a test that read under .git/ is decided statically, with the reason', () => {
    const plan = select(
      { 'scratch/notes.txt': 'changed\n' },
      record({ 'packages/app/tests/data.test.ts': { fallback: 'git-read' } })
    )
    expect(plan.records.fallbacks.map((f) => f.id)).toEqual(['record-git-read'])
    expect(plan.fallbacks[0]?.tests).toEqual(['packages/app/tests/data.test.ts'])
  })

  it('a push from another platform is decided by the same Linux record, so it selects what CI selects', () => {
    const records = record({ 'packages/app/tests/data.test.ts': { branchesOnPlatform: true } })
    const linux = select({ 'scratch/notes.txt': 'changed\n' }, records, 'linux')
    const mac = select({ 'scratch/notes.txt': 'changed\n' }, records, 'darwin')
    expect(linux.records.fallbacks).toEqual([])
    expect(mac.records.fallbacks).toEqual([])
    expect(mac.required.map((t) => t.test)).toEqual(linux.required.map((t) => t.test))
  })

  it('a record is used for a test only when none of its paths changed between the record commit and the base', () => {
    const changed = { ...fx.files, 'scratch/notes.txt': 'moved on\n' }
    const input = scenarioInput(fx, scenario({ 'opaque/input.json': '{ "value": 9 }\n' }))
    const plan = selectTests({
      ...input,
      repo: memoryRepository({
        [RECORD_COMMIT]: changed,
        base: fx.files,
        head: headOf({ 'opaque/input.json': '{ "value": 9 }\n' })
      }),
      records: { record: record({}, RECORD_COMMIT), platform: 'linux' }
    })
    const drifted = plan.records.fallbacks.find((f) => f.id === 'record-input-changed')
    expect(drifted?.tests).toEqual(['packages/app/tests/opaque.test.ts'])
    expect(plan.records.recorded).not.toContain('packages/app/tests/opaque.test.ts')
  })

  it('a record whose commit cannot be listed decides nothing', () => {
    const input = scenarioInput(fx, scenario({ 'scratch/notes.txt': 'changed\n' }))
    const plan = selectTests({ ...input, records: { record: record({}, RECORD_COMMIT), platform: 'linux' } })
    expect(plan.records.recorded).toEqual([])
    expect(plan.records.fallbacks.map((f) => f.id)).toEqual(['record-unreadable'])
    expect(plan.fallbacks.map((f) => f.id)).toEqual(['unattributed'])
  })

  it('the inventory readers and the package-level non-source edge no longer decide a recorded test', () => {
    // settings.json is a declared input the static selection reads through a package edge; a record that never read it decides.
    const input = scenarioInput(fx, scenario({ 'packages/app/settings.json': '{ "theme": "light", "lang": "en" }\n' }))
    const statically = selectTests(input)
    expect(plannedTests(statically)).toContain('packages/app/tests/settings.test.ts')
    const decided = selectTests({ ...input, records: { record: record(), platform: 'linux' } })
    expect(decided.required.map((t) => t.test)).toEqual([])
    expect(decided.fallbacks).toEqual([])
  })
})

// ── The line diff ──────────────────────────────────────────────────────────

describe('lineDiffRanges', () => {
  it('reads like git diff -U0 hunks', () => {
    expect(lineDiffRanges('a\nb\nc\n', 'a\nB\nc\n')).toEqual(parseHunkRanges('@@ -2 +2 @@'))
    expect(lineDiffRanges('a\nc\n', 'a\nb\nc\n')).toEqual(parseHunkRanges('@@ -1,0 +2 @@'))
    expect(lineDiffRanges('a\nb\nc\n', 'a\nc\n')).toEqual(parseHunkRanges('@@ -2 +1,0 @@'))
    expect(lineDiffRanges('', 'a\nb\n')).toEqual(parseHunkRanges('@@ -0,0 +1,2 @@'))
    expect(lineDiffRanges('x\ny\n', 'x\ny\n')).toEqual({ beforeRanges: [], afterRanges: [] })
    expect(lineDiffRanges('a\nb\nc\nd\n', 'A\nb\nc\nD\n')).toEqual(parseHunkRanges('@@ -1 +1 @@\n@@ -4 +4 @@'))
  })
})
