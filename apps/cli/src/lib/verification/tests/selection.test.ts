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
    expect(withObligations.obligations.filter((o) => o.obligation === 'linux')).toHaveLength(11)
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
