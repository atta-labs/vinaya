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
const INVARIANT_SPEC = 'apps/cli/specs/dev-review-invariants.md'
/** The specifications that name the normative design's revision beside the register. */
const DESIGN_SPECS = [
  INVARIANT_SPEC,
  'apps/cli/specs/dev-review-engine-state-machine.md',
  'apps/cli/specs/dev-review-engine-capability-matrix.md'
] as const

/** The register's one classification vocabulary: the five the invariant specification defines. */
const CLASSIFICATIONS = [
  'product-guarantee',
  'implementation-accident',
  'named-defect',
  'advisory',
  'principal-ruling-required'
] as const
type Classification = (typeof CLASSIFICATIONS)[number]

/** Classes that promise behavior the Engine path must keep: each names a test oracle. */
const GUARANTEE_CLASSES: readonly Classification[] = ['product-guarantee']
/** Classes that record a demonstrated weakness: each cites the defect register. */
const DEFECT_CLASSES: readonly Classification[] = ['named-defect']
/**
 * Classes that must map to at least one corpus scenario. An implementation
 * accident need not: nothing promises it, so no scenario has to exercise it.
 */
const SCENARIO_CLASSES: readonly Classification[] = [
  'product-guarantee',
  'named-defect',
  'advisory',
  'principal-ruling-required'
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
  normativeDesign: { title: string; revision: number; url: string; sections: string[] }
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

/**
 * Every entry of either register missing its classification, its scope or its
 * summary. An invariant's summary is its `behavior`; a defect's is its `summary`.
 */
function missingFields(inv: Inventory): string[] {
  const out: string[] = []
  const entries = [...inv.invariants.map((i) => ({ ...i, summary: i.behavior })), ...inv.defects] as {
    id: string
    classification?: string
    scope?: string
    summary?: string
  }[]
  for (const e of entries) {
    if (!e.classification) out.push(`${e.id}: classification`)
    if (!e.scope) out.push(`${e.id}: scope`)
    if (!e.summary?.trim()) out.push(`${e.id}: summary`)
  }
  return out
}

function countBy<T extends string>(values: readonly T[], keys: readonly T[]): Record<T, number> {
  const counts = Object.fromEntries(keys.map((k) => [k, 0])) as Record<T, number>
  for (const v of values) counts[v] += 1
  return counts
}

/** Every entry of either register whose classification is outside the one vocabulary. */
function unknownClassifications(inv: Inventory): string[] {
  const known = new Set<string>(CLASSIFICATIONS)
  return [...inv.invariants, ...inv.defects]
    .filter((e) => !known.has(e.classification))
    .map((e) => `${e.id}: ${e.classification}`)
}

/** Every `revision <n>` a text states, read across its line breaks. */
function revisionsStated(text: string): number[] {
  return [...text.replace(/\s+/g, ' ').matchAll(/\brevision (\d+)\b/gi)].map((m) => Number(m[1]))
}

/** Every specification that states no revision, or a revision other than the register's own. */
function revisionDisagreements(revision: number, specs: Record<string, string>): string[] {
  return Object.entries(specs).flatMap(([path, markdown]) => {
    const stated = revisionsStated(markdown)
    if (stated.length === 0) return [`${path}: states no revision`]
    return stated.filter((r) => r !== revision).map((r) => `${path}: revision ${r}`)
  })
}

/**
 * Every reason that cites a revision other than the register's, or a numbered
 * section the register's normative design does not list as one it rests on.
 */
function staleReasonCitations(inv: Inventory): string[] {
  const sections = new Set(inv.normativeDesign.sections.map((s) => s.split(' ')[0]))
  return inv.invariants.flatMap((i) => {
    const out = revisionsStated(i.reason)
      .filter((r) => r !== inv.normativeDesign.revision)
      .map((r) => `${i.id}: revision ${r}`)
    for (const m of i.reason.matchAll(/\bsections? (\d+(?:\.\d+)?(?:(?:,| and) \d+(?:\.\d+)?)*)/gi)) {
      for (const s of m[1]?.match(/\d+(?:\.\d+)?/g) ?? []) if (!sections.has(s)) out.push(`${i.id}: section ${s}`)
    }
    return out
  })
}

/** The heading of the invariant specification's table of register counts. */
const COUNTS_HEADING = '## Register counts'

/** The register's counts, computed from the fixture and keyed by the label the count table uses. */
function computedCounts(inv: Inventory): Map<string, number> {
  const byClass = countBy(
    inv.invariants.map((i) => i.classification),
    CLASSIFICATIONS
  )
  const byScope = countBy(
    inv.invariants.map((i) => i.scope),
    SCOPES
  )
  const defectsByStatus = countBy(
    inv.defects.map((d) => d.status as (typeof DEFECT_STATUSES)[number]),
    DEFECT_STATUSES
  )
  const defectsByScope = countBy(
    inv.defects.map((d) => d.scope),
    SCOPES
  )
  return new Map<string, number>([
    ['invariants', inv.invariants.length],
    ...CLASSIFICATIONS.map((c) => [`invariants classified ${c}`, byClass[c]] as const),
    ...SCOPES.map((s) => [`invariants in ${s} scope`, byScope[s]] as const),
    ['defects', inv.defects.length],
    ...DEFECT_STATUSES.map((s) => [`defects ${s}`, defectsByStatus[s]] as const),
    ...SCOPES.map((s) => [`defects in ${s} scope`, defectsByScope[s]] as const),
    ['ambiguities', inv.ambiguities.length]
  ])
}

/** The counts the specification states: the `| label | n |` rows under its count heading. */
function statedCounts(markdown: string): Map<string, number> {
  const lines = markdown.split('\n')
  const start = lines.findIndex((l) => l.trim() === COUNTS_HEADING)
  const out = new Map<string, number>()
  if (start === -1) return out
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break
    const row = line.match(/^\|\s*([^|]+?)\s*\|\s*(\d+)\s*\|\s*$/)
    if (row?.[1] !== undefined) out.set(row[1].replaceAll('`', ''), Number(row[2]))
  }
  return out
}

/** Every count the specification leaves out, states wrongly, or states without a computed counterpart. */
function countDifferences(computed: Map<string, number>, stated: Map<string, number>): string[] {
  const out: string[] = []
  for (const [label, n] of computed) {
    const s = stated.get(label)
    if (s === undefined) out.push(`${label}: not stated (computed ${n})`)
    else if (s !== n) out.push(`${label}: stated ${s}, computed ${n}`)
  }
  for (const label of stated.keys()) if (!computed.has(label)) out.push(`${label}: stated, never computed`)
  return out
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

  it('an entry missing its classification, its scope or its summary is reported', () => {
    expect(missingFields(inventory)).toEqual([])
    const [first, second, third] = inventory.invariants as [Invariant, Invariant, Invariant]
    const [firstDefect, secondDefect] = inventory.defects as [
      Inventory['defects'][number],
      Inventory['defects'][number]
    ]
    const { scope: _scope, ...noScope } = first
    const { classification: _classification, ...noClass } = second
    const { scope: _defectScope, ...noDefectScope } = firstDefect
    const probe = {
      ...inventory,
      invariants: [noScope as Invariant, noClass as Invariant, { ...third, behavior: ' ' }],
      defects: [
        noDefectScope as Inventory['defects'][number],
        { ...secondDefect, summary: '' } as Inventory['defects'][number]
      ]
    }
    expect(missingFields(probe)).toEqual([
      `${first.id}: scope`,
      `${second.id}: classification`,
      `${third.id}: summary`,
      `${firstDefect.id}: scope`,
      `${secondDefect.id}: summary`
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
    const defectsByClass = countBy(
      inventory.defects.map((d) => d.classification),
      CLASSIFICATIONS
    )
    const defectsByScope = countBy(
      inventory.defects.map((d) => d.scope),
      SCOPES
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
      `defects: ${inventory.defects.length}; ambiguities awaiting a ruling: ${inventory.ambiguities.filter((a) => a.rulingStatus === 'awaiting-principal').length}`,
      `defects by classification: ${CLASSIFICATIONS.filter((c) => defectsByClass[c] > 0)
        .map((c) => `${c} ${defectsByClass[c]}`)
        .join(', ')}`,
      `defects by scope: ${SCOPES.map((s) => `${s} ${defectsByScope[s]}`).join(', ')}`
    ]
    process.stdout.write(`${lines.join('\n')}\n`)
    expect(missingFields(inventory)).toEqual([])
    expect(Object.values(byScope).reduce((a, b) => a + b, 0)).toBe(inventory.invariants.length)
    expect(Object.values(byClass).reduce((a, b) => a + b, 0)).toBe(inventory.invariants.length)
    expect(Object.values(defectsByScope).reduce((a, b) => a + b, 0)).toBe(inventory.defects.length)
    expect(Object.values(defectsByClass).reduce((a, b) => a + b, 0)).toBe(inventory.defects.length)
  })
})

const specText = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8')

describe('standalone dev-review loop invariant map (one normative revision, everywhere)', () => {
  it('the register and the invariant, state-machine and capability-matrix specifications state the same revision', () => {
    const specs = Object.fromEntries(DESIGN_SPECS.map((p) => [p, specText(p)]))
    expect(revisionDisagreements(inventory.normativeDesign.revision, specs)).toEqual([])
    expect(inventory.normativeDesign.sections.length).toBeGreaterThan(0)
  })

  it('a specification that states another revision, or none, is reported', () => {
    expect(
      revisionDisagreements(17, {
        'a.md': 'the Linear "Tech spec —\nDeveloper-review on Atta Engine", revision 9.',
        'b.md': 'no revision named here',
        'c.md': 'revision 17'
      })
    ).toEqual(['a.md: revision 9', 'b.md: states no revision'])
  })

  it('no reason cites an earlier revision or a section the register does not rest on', () => {
    expect(staleReasonCitations(inventory)).toEqual([])
  })

  it('a reason citing an earlier revision or an unlisted section is reported', () => {
    const [first] = inventory.invariants as [Invariant]
    const probe: Inventory = {
      ...inventory,
      normativeDesign: { ...inventory.normativeDesign, sections: ['16.4', '16.17 Outcome A'] },
      invariants: [
        { ...first, id: 'INV-PROBE-1', reason: 'Revision 7 section 16.10: stale basis.' },
        { ...first, id: 'INV-PROBE-2', reason: 'Revision 17 sections 16.4 and 16.17, Outcome A; section 2.' }
      ]
    }
    expect(staleReasonCitations(probe)).toEqual([
      'INV-PROBE-1: revision 7',
      'INV-PROBE-1: section 16.10',
      'INV-PROBE-2: section 2'
    ])
  })
})

describe('standalone dev-review loop invariant map (one classification vocabulary)', () => {
  it('every invariant and defect carries one of the five classifications', () => {
    expect(unknownClassifications(inventory)).toEqual([])
  })

  it('a classification outside the five is refused', () => {
    const [first] = inventory.invariants as [Invariant]
    const [firstDefect] = inventory.defects as [Inventory['defects'][number]]
    const probe = {
      ...inventory,
      invariants: [{ ...first, classification: 'guarantee' }],
      defects: [{ ...firstDefect, classification: 'defect' }]
    } as unknown as Inventory
    expect(unknownClassifications(probe)).toEqual([`${first.id}: guarantee`, `${firstDefect.id}: defect`])
  })
})

describe('standalone dev-review loop invariant map (counts computed from the register and stated by its specification)', () => {
  const computed = computedCounts(inventory)

  it('every count the specification states equals the count computed from the register', () => {
    const lines = [...computed].map(([label, n]) => `${label}: ${n}`)
    process.stdout.write(`${lines.join('\n')}\n`)
    expect(countDifferences(computed, statedCounts(specText(INVARIANT_SPEC)))).toEqual([])
  })

  it('a wrong, missing or uncomputed stated count is reported', () => {
    const table = [
      COUNTS_HEADING,
      '',
      '| Count | Value |',
      '| -- | -- |',
      ...[...computed]
        .filter(([label]) => label !== 'ambiguities')
        .map(([label, n]) => `| ${label} | ${label === 'invariants' ? n + 1 : n} |`),
      '| registered checks | 38 |',
      '',
      '## Next section',
      '| ambiguities | 13 |'
    ].join('\n')
    expect(countDifferences(computed, statedCounts(table))).toEqual([
      `invariants: stated ${(computed.get('invariants') ?? 0) + 1}, computed ${computed.get('invariants')}`,
      `ambiguities: not stated (computed ${computed.get('ambiguities')})`,
      'registered checks: stated, never computed'
    ])
  })
})
