import { describe, expect, it } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `apps/cli/specs/dev-review-invariants.md`'s own test — the standalone
 * developer-review loop's invariant map, frozen as the migration oracle.
 *
 * It enumerates the loop's surface from the filesystem (never from a source
 * scan), then checks the inventory in
 * `tests/fixtures/dev-review-architecture-invariants.json` against it: every
 * implementation module and test file is mapped to at least one invariant or
 * excluded with a reason, every path the map names exists, and every
 * observed behavior carries one of the five classifications. It never
 * re-derives WHAT a behavior is; that is the map's own audited content.
 */

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')
const FIXTURE_PATH = join(REPO_ROOT, 'apps', 'cli', 'tests', 'fixtures', 'dev-review-architecture-invariants.json')

const CLASSIFICATIONS = [
  'product-guarantee',
  'implementation-accident',
  'named-defect',
  'advisory',
  'principal-ruling-required',
  // The register's classification-of-guarantee vocabulary, added beside the five above
  // (never replacing them, so an entry's recorded classification and its count stay put).
  'guarantee',
  'defect',
  'accident',
  'hygiene'
] as const
type Classification = (typeof CLASSIFICATIONS)[number]

/** Classes that promise behavior the Engine path must keep: each names a test oracle. */
const GUARANTEE_CLASSES: readonly Classification[] = ['product-guarantee', 'guarantee']
/** Classes that record a demonstrated weakness: each cites the defect register. */
const DEFECT_CLASSES: readonly Classification[] = ['named-defect', 'defect']
/** Classes that must map to at least one corpus scenario; the rest may map to none. */
const SCENARIO_CLASSES: readonly Classification[] = [
  'product-guarantee',
  'named-defect',
  'implementation-accident',
  'advisory',
  'principal-ruling-required',
  'guarantee',
  'defect'
]
/** Whose a finding is: the product, the reference process around it, or this implementation. */
const SCOPES = ['product', 'reference-process', 'implementation'] as const
type Scope = (typeof SCOPES)[number]

const OWNERS = [
  'vinaya-policy',
  'engine-runtime',
  'provider-adapter',
  'governed-operation',
  'log',
  'operator-control',
  'standalone-only'
] as const
const AUTHORITIES = ['control-state', 'forge', 'telemetry', 'pure-policy', 'effect'] as const
/** The normative design's Phase A scenario list. */
const SCENARIOS = [
  'happy-path',
  'revisions',
  'invalid-reviews',
  'stale-evidence',
  'reviewer-failure',
  'developer-failure',
  'context-pressure',
  'cancellation',
  'restart',
  'uncertain-effects',
  'isolation-refusal',
  'operator-intervention'
] as const
const RULING_STATUSES = ['awaiting-principal', 'ruled'] as const
/** A fixed defect keeps its entry, so the register stays a record of what not to regress to. */
const DEFECT_STATUSES = ['open', 'fixed'] as const

interface PathRef {
  path: string
  locator?: string
  symbol?: string
}
interface Invariant {
  id: string
  behavior: string
  classification: Classification
  scope: Scope
  defect?: string
  ambiguity?: string
  owner: string
  authority: string
  scenarios: string[]
  sources: PathRef[]
  tests: string[]
  loopSpec: string[]
  reason: string
}
interface ReasonedPath {
  path: string
  reason: string
  kind?: string
}
interface Inventory {
  schemaVersion: number
  loopSpec: string
  baseline: {
    revision: string
    implementationModules: string[]
    testFiles: string[]
    addedSinceBaseline: ReasonedPath[]
  }
  exclusions: ReasonedPath[]
  supportFiles: ReasonedPath[]
  invariants: Invariant[]
  defects: {
    id: string
    summary: string
    code: PathRef
    spec: PathRef
    status: string
    classification: Classification
    scope: Scope
  }[]
  ambiguities: { id: string; question: string; citations: string[]; rulingStatus: string }[]
}

const inventory: Inventory = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))

// --- surface discovery: directory listings, never a source scan -----------

function tsFilesIn(relDir: string): string[] {
  const abs = join(REPO_ROOT, relDir)
  if (!existsSync(abs)) return []
  return readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => `${relDir}/${e.name}`)
}

function existing(rel: string): string[] {
  return existsSync(join(REPO_ROOT, rel)) ? [rel] : []
}

const isTestFile = (p: string) => p.endsWith('.test.ts')

/** Every `.ts` file that belongs to the standalone loop, by location. */
function discoverLoopSurface(): { implementation: string[]; tests: string[]; other: string[] } {
  const sourceSide = [
    ...existing('apps/cli/src/commands/dev-review-loop.ts'),
    ...existing('apps/cli/src/lib/dev-review-loop.ts'),
    ...tsFilesIn('apps/cli/src/lib/dev-review-loop'),
    ...tsFilesIn('packages/aeg-core/src/dev-review-loop')
  ]
  const testSide = [
    ...existing('apps/cli/tests/commands/dev-review-loop.test.ts'),
    ...tsFilesIn('apps/cli/tests/lib').filter((p) =>
      p.slice('apps/cli/tests/lib/'.length).startsWith('dev-review-loop')
    ),
    ...tsFilesIn('apps/cli/tests/lib/dev-review-loop')
  ]
  const all = [...sourceSide, ...testSide]
  return {
    implementation: sourceSide.filter((p) => !isTestFile(p)).sort(),
    tests: all.filter(isTestFile).sort(),
    other: testSide.filter((p) => !isTestFile(p)).sort()
  }
}

// --- the checks, as pure functions so their own failure modes are testable --

/** Every surface file neither cited by an invariant nor excluded with a reason. */
function unmappedPaths(inv: Inventory, surface: readonly string[]): string[] {
  const mapped = new Set<string>()
  for (const i of inv.invariants) {
    for (const s of i.sources) mapped.add(s.path)
    for (const t of i.tests) mapped.add(t)
  }
  const excluded = new Set(inv.exclusions.filter((e) => e.reason.trim().length > 0).map((e) => e.path))
  return surface.filter((p) => !mapped.has(p) && !excluded.has(p))
}

/** Every path the inventory names, deduplicated. */
function namedPaths(inv: Inventory): string[] {
  const out = new Set<string>([inv.loopSpec])
  for (const p of [...inv.baseline.implementationModules, ...inv.baseline.testFiles]) out.add(p)
  for (const r of [...inv.baseline.addedSinceBaseline, ...inv.exclusions, ...inv.supportFiles]) out.add(r.path)
  for (const i of inv.invariants) {
    for (const s of i.sources) out.add(s.path)
    for (const t of i.tests) out.add(t)
  }
  for (const d of inv.defects) {
    out.add(d.code.path)
    out.add(d.spec.path)
  }
  for (const a of inv.ambiguities) for (const c of a.citations) out.add(c)
  return [...out]
}

/** Every named path that does not exist in the checkout. */
function unresolvedPaths(inv: Inventory, exists: (rel: string) => boolean): string[] {
  return namedPaths(inv).filter((p) => !exists(p))
}

/** The loop spec's own headings, without their leading `#`s. */
function headingsOf(markdown: string): Set<string> {
  const out = new Set<string>()
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('#')) continue
    const text = line.replace(/^#+/, '').trim()
    if (text.length > 0) out.add(text)
  }
  return out
}

/** Every entry of either register missing its classification or its scope. */
function missingFields(inv: Inventory): string[] {
  const out: string[] = []
  for (const e of [...inv.invariants, ...inv.defects] as { id: string; classification?: string; scope?: string }[]) {
    if (!e.classification) out.push(`${e.id}: classification`)
    if (!e.scope) out.push(`${e.id}: scope`)
  }
  return out
}

function countBy<T extends string>(values: readonly T[], keys: readonly T[]): Record<T, number> {
  const counts = Object.fromEntries(keys.map((k) => [k, 0])) as Record<T, number>
  for (const v of values) counts[v] += 1
  return counts
}

const surface = discoverLoopSurface()
const supportPaths = new Set(inventory.supportFiles.map((s) => s.path))
const implementation = surface.implementation.filter((p) => !supportPaths.has(p))
const tests = surface.tests
const added = inventory.baseline.addedSinceBaseline
const unmapped = unmappedPaths(inventory, [...implementation, ...tests])
const unresolved = unresolvedPaths(inventory, (rel) => existsSync(join(REPO_ROOT, rel)))

describe('standalone dev-review loop invariant map (O1: every module and test mapped or excluded)', () => {
  it('the frozen baseline is 15 implementation modules and 26 test files', () => {
    expect(new Set(inventory.baseline.implementationModules).size).toBe(15)
    expect(inventory.baseline.implementationModules.length).toBe(15)
    expect(new Set(inventory.baseline.testFiles).size).toBe(26)
    expect(inventory.baseline.testFiles.length).toBe(26)
  })

  it('the discovered surface is exactly the baseline plus the paths recorded as added since it', () => {
    const expectedImpl = [
      ...inventory.baseline.implementationModules,
      ...added.filter((a) => a.kind === 'implementation').map((a) => a.path)
    ].sort()
    const expectedTests = [
      ...inventory.baseline.testFiles,
      ...added.filter((a) => a.kind === 'test').map((a) => a.path)
    ].sort()
    expect(implementation).toEqual(expectedImpl)
    expect(tests).toEqual(expectedTests)
    for (const a of added) expect(a.reason.trim().length).toBeGreaterThan(0)
  })

  it('every non-test, non-module file on the surface is a declared support file with a reason', () => {
    const supportInSource = surface.implementation.filter((p) => supportPaths.has(p))
    const declared = new Set([...supportInSource, ...surface.other])
    expect([...declared].sort()).toEqual([...supportPaths].sort())
    for (const s of inventory.supportFiles) expect(s.reason.trim().length).toBeGreaterThan(0)
  })

  it('every exclusion is on the surface and carries a concrete reason', () => {
    for (const e of inventory.exclusions) {
      expect([...implementation, ...tests]).toContain(e.path)
      expect(e.reason.trim().length).toBeGreaterThan(40)
    }
  })

  it('reports zero unmapped paths', () => {
    expect(unmapped).toEqual([])
  })

  it('an unmapped surface file is reported, and an exclusion with an empty reason does not count', () => {
    const probe: Inventory = {
      ...inventory,
      exclusions: [{ path: 'apps/cli/src/lib/dev-review-loop/not-a-module.ts', reason: ' ' }]
    }
    expect(unmappedPaths(probe, ['apps/cli/src/lib/dev-review-loop/not-a-module.ts'])).toEqual([
      'apps/cli/src/lib/dev-review-loop/not-a-module.ts'
    ])
  })
})

describe('standalone dev-review loop invariant map (O2: every named path resolves)', () => {
  it('reports zero unresolved paths', () => {
    expect(unresolved).toEqual([])
  })

  it('a mapped path that does not exist fails', () => {
    const invented = 'apps/cli/src/lib/dev-review-loop/invented-module.ts'
    const probeEntry: Invariant = {
      id: 'INV-PROBE',
      behavior: 'probe',
      classification: 'implementation-accident',
      scope: 'implementation',
      owner: 'standalone-only',
      authority: 'effect',
      scenarios: ['happy-path'],
      sources: [{ path: invented, symbol: 'x' }],
      tests: [],
      loopSpec: [],
      reason: 'probe'
    }
    const probe: Inventory = { ...inventory, invariants: [...inventory.invariants, probeEntry] }
    expect(unresolvedPaths(probe, (rel) => existsSync(join(REPO_ROOT, rel)))).toEqual([invented])
  })

  it('every cited loop.md section is a real heading of that spec', () => {
    const headings = headingsOf(readFileSync(join(REPO_ROOT, inventory.loopSpec), 'utf8'))
    const missing = inventory.invariants.flatMap((i) =>
      i.loopSpec.filter((h) => !headings.has(h)).map((h) => `${i.id}: ${h}`)
    )
    const defectMissing = inventory.defects
      .filter(
        (d) => d.spec.path === inventory.loopSpec && d.spec.locator !== undefined && !headings.has(d.spec.locator)
      )
      .map((d) => `${d.id}: ${d.spec.locator}`)
    expect([...missing, ...defectMissing]).toEqual([])
  })
})

describe('standalone dev-review loop invariant map (O3: every behavior classified)', () => {
  it('every invariant is well-formed and carries a known classification and scope', () => {
    const ids = inventory.invariants.map((i) => i.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const i of inventory.invariants) {
      expect(CLASSIFICATIONS).toContain(i.classification)
      expect(SCOPES).toContain(i.scope)
      expect(OWNERS).toContain(i.owner as (typeof OWNERS)[number])
      expect(AUTHORITIES).toContain(i.authority as (typeof AUTHORITIES)[number])
      if (SCENARIO_CLASSES.includes(i.classification)) expect(i.scenarios.length).toBeGreaterThan(0)
      for (const s of i.scenarios) expect(SCENARIOS).toContain(s as (typeof SCENARIOS)[number])
      expect(i.sources.length).toBeGreaterThan(0)
      expect(i.behavior.trim().length).toBeGreaterThan(0)
      expect(i.reason.trim().length).toBeGreaterThan(0)
    }
  })

  it('every product guarantee names at least one test as its oracle', () => {
    const untested = inventory.invariants.filter(
      (i) => GUARANTEE_CLASSES.includes(i.classification) && i.tests.length === 0
    )
    expect(untested.map((i) => i.id)).toEqual([])
  })

  it('an entry missing its classification or its scope is reported', () => {
    expect(missingFields(inventory)).toEqual([])
    const [first, second] = inventory.invariants as [Invariant, Invariant]
    const [firstDefect] = inventory.defects as [Inventory['defects'][number]]
    const { scope: _scope, ...noScope } = first
    const { classification: _classification, ...noClass } = second
    const { scope: _defectScope, ...noDefectScope } = firstDefect
    const probe = {
      ...inventory,
      invariants: [noScope as Invariant, noClass as Invariant],
      defects: [noDefectScope as Inventory['defects'][number]]
    }
    expect(missingFields(probe)).toEqual([
      `${first.id}: scope`,
      `${second.id}: classification`,
      `${firstDefect.id}: scope`
    ])
  })

  it('every defect-register entry carries the classification and scope of the invariant citing it', () => {
    for (const d of inventory.defects) {
      const citing = inventory.invariants.filter((i) => i.defect === d.id)
      expect(citing.length).toBe(1)
      const [owner] = citing as [Invariant]
      expect(d.classification).toBe(owner.classification)
      expect(d.scope).toBe(owner.scope)
    }
  })

  it('every guarantee or defect maps to a corpus scenario', () => {
    const unmapped = inventory.invariants.filter(
      (i) => [...GUARANTEE_CLASSES, ...DEFECT_CLASSES].includes(i.classification) && i.scenarios.length === 0
    )
    expect(unmapped.map((i) => i.id)).toEqual([])
  })

  it('every named defect is in the defect register, and every register entry is cited', () => {
    const defectIds = new Set(inventory.defects.map((d) => d.id))
    expect(defectIds.size).toBe(inventory.defects.length)
    const cited = new Set<string>()
    for (const i of inventory.invariants) {
      if (DEFECT_CLASSES.includes(i.classification)) {
        expect(i.defect).toBeDefined()
        expect(defectIds.has(i.defect as string)).toBe(true)
        cited.add(i.defect as string)
      } else {
        expect(i.defect).toBeUndefined()
      }
    }
    expect([...defectIds].filter((d) => !cited.has(d))).toEqual([])
    for (const d of inventory.defects) {
      expect(d.summary.trim().length).toBeGreaterThan(0)
      expect(DEFECT_STATUSES).toContain(d.status as (typeof DEFECT_STATUSES)[number])
    }
  })

  it('every Principal-ruling-required behavior is in the ambiguity register with its ruling status', () => {
    const ambiguityIds = new Set(inventory.ambiguities.map((a) => a.id))
    expect(ambiguityIds.size).toBe(inventory.ambiguities.length)
    const cited = new Set<string>()
    for (const i of inventory.invariants) {
      if (i.classification === 'principal-ruling-required') {
        expect(i.ambiguity).toBeDefined()
        expect(ambiguityIds.has(i.ambiguity as string)).toBe(true)
        cited.add(i.ambiguity as string)
      } else {
        expect(i.ambiguity).toBeUndefined()
      }
    }
    expect([...ambiguityIds].filter((a) => !cited.has(a))).toEqual([])
    for (const a of inventory.ambiguities) {
      expect(RULING_STATUSES).toContain(a.rulingStatus as (typeof RULING_STATUSES)[number])
      expect(a.question.trim().length).toBeGreaterThan(0)
    }
  })

  it('prints the totals and the counts by classification', () => {
    const byClass = countBy(
      inventory.invariants.map((i) => i.classification),
      CLASSIFICATIONS
    )
    const byScope = countBy(
      inventory.invariants.map((i) => i.scope),
      SCOPES
    )
    const byAuthority = countBy(
      inventory.invariants.map((i) => i.authority as (typeof AUTHORITIES)[number]),
      AUTHORITIES
    )
    const byScenario = countBy(
      inventory.invariants.flatMap((i) => i.scenarios as (typeof SCENARIOS)[number][]),
      SCENARIOS
    )
    const addedImpl = added.filter((a) => a.kind === 'implementation').length
    const addedTests = added.filter((a) => a.kind === 'test').length
    const lines = [
      `implementation modules: ${inventory.baseline.implementationModules.length} at baseline ${inventory.baseline.revision.slice(0, 8)}, ${implementation.length} now (${addedImpl} added since)`,
      `test files: ${inventory.baseline.testFiles.length} at baseline, ${tests.length} now (${addedTests} added since)`,
      `exclusions: ${inventory.exclusions.length}; support files: ${inventory.supportFiles.length}`,
      `unmapped paths: ${unmapped.length}`,
      `unresolved paths: ${unresolved.length}`,
      `invariants: ${inventory.invariants.length}`,
      ...CLASSIFICATIONS.map((c) => `  ${c}: ${byClass[c]}`),
      `by scope: ${SCOPES.map((s) => `${s} ${byScope[s]}`).join(', ')}`,
      `by authority: ${AUTHORITIES.map((a) => `${a} ${byAuthority[a]}`).join(', ')}`,
      `by scenario: ${SCENARIOS.map((s) => `${s} ${byScenario[s]}`).join(', ')}`,
      `defects: ${inventory.defects.length}; ambiguities awaiting a ruling: ${inventory.ambiguities.filter((a) => a.rulingStatus === 'awaiting-principal').length}`
    ]
    process.stdout.write(`${lines.join('\n')}\n`)
    expect(missingFields(inventory)).toEqual([])
    expect(Object.values(byScope).reduce((a, b) => a + b, 0)).toBe(inventory.invariants.length)
    expect(Object.values(byClass).reduce((a, b) => a + b, 0)).toBe(inventory.invariants.length)
  })
})
