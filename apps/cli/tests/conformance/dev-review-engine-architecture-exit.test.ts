import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { cleanupWorlds } from '../lib/dev-review-loop-harness.js'
import { NODE_CONTRACTS } from '../lib/dev-review-loop/dev-review-engine-state-contract.fixture.js'
import { SCANNER_DECLARATIONS, underDeclaredRoot } from '../../src/lib/repo-scanner-tests.js'
import { REFRESH_COMMAND, refreshLoopBaseline } from '../../scripts/refresh-loop-baseline.js'
import { type Observation, SCENARIO_DRIVERS } from './dev-review-current-loop-adapter.js'
import { ENGINE_SCENARIO_DRIVERS } from './dev-review-engine-loop-adapter.js'
import engineFailureFixture from '../fixtures/dev-review-engine-expected-failures.json'

/**
 * The developer-review architecture exit gate.
 *
 * One test file executes every scenario of the normalized behavioral corpus
 * (`tests/fixtures/dev-review-engine-scenarios.json`) against the current
 * standalone loop through `dev-review-current-loop-adapter.ts` and the real
 * Engine Flow through `dev-review-engine-loop-adapter.ts`, using both vendor
 * launch shapes. It classifies
 * each result against the scenario's portable expectation: passed, an
 * expected failure that names an open entry of the frozen defect register, or
 * an unexpected failure. Nothing is skipped and no failure is accepted without
 * a register identifier. Engine failures name a scenario product guarantee
 * in the shrinking expected-failure fixture, checked for invalid and stale
 * mappings and bounded by a pinned ceiling. It then checks the exit condition over every product
 * guarantee of the invariant register — an owner, a typed representation, a
 * failure behavior, an executed corpus scenario and, where an external
 * standard applies, a normative source — and pins the standalone baseline the
 * corpus ran against.
 */

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')
const CORPUS_PATH = join(REPO_ROOT, 'apps', 'cli', 'tests', 'fixtures', 'dev-review-engine-scenarios.json')

type Expectation = {
  decision: string
  refusalMatches?: string
  durable?: Partial<Record<keyof Observation['durable'], unknown>>
  effects?: Partial<Record<keyof Observation['effects'], unknown>> & {
    markersInclude?: string[]
    markersExclude?: string[]
  }
  events?: {
    sequence?: string[]
    include?: string[]
    exclude?: string[]
    uniqueRoundStarts?: boolean
    journalResults?: string[]
  }
}

interface Scenario {
  id: string
  title: string
  categories: string[]
  guarantees: string[]
  expect: Expectation
  expectedDefect?: string
}

interface Corpus {
  schemaVersion: number
  stateContract: string
  invariantRegister: string
  capabilityMatrix: string
  baseline: { commit: string; branch: string; loopSurface: { path: string; sha256: string }[] }
  behaviors: Record<string, string[]>
  scenarios: Scenario[]
  guarantees: { id: string; node: string }[]
}

interface Invariant {
  id: string
  classification: string
  owner: string
  authority: string
  scenarios: string[]
}

interface Register {
  baseline: {
    implementationModules: string[]
    addedSinceBaseline: { path: string; kind?: string }[]
  }
  supportFiles: { path: string }[]
  invariants: Invariant[]
  defects: { id: string; status: string }[]
}

interface Matrix {
  sources: Record<string, { kind: string; url?: string }>
  rows: { id: string; kind: string; traces?: string[]; citations: { source: string; anchor: string }[] }[]
}

const corpus: Corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8'))
const register: Register = JSON.parse(readFileSync(join(REPO_ROOT, corpus.invariantRegister), 'utf8'))
const matrix: Matrix = JSON.parse(readFileSync(join(REPO_ROOT, corpus.capabilityMatrix), 'utf8'))

/** The register's own Phase A scenario categories. */
const CATEGORIES = [
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
const GUARANTEE_CLASSES = ['product-guarantee']
const DEFECT_CLASSES = ['named-defect']
const OWNERS = [
  'vinaya-policy',
  'engine-runtime',
  'provider-adapter',
  'governed-operation',
  'log',
  'operator-control',
  'standalone-only'
]
/** Source kinds that are this repository's own records; every other kind is an external standard. */
const INTERNAL_SOURCE_KINDS = new Set(['repo-spec', 'repo-source'])
/**
 * Capability-matrix row kinds judged against something outside this
 * repository — the Atta runtime, a provider CLI, a vendor sandbox, a published
 * pattern. `policy` and `core-port` rows are Vinaya's own contract, so a
 * guarantee traced only by them has no external standard to cite.
 */
const EXTERNALLY_GOVERNED_ROW_KINDS = new Set(['runtime', 'adapter', 'pattern', 'confinement', 'confinement-gap'])

// --- comparison and classification, pure so their own failure modes are tested --

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Every way `obs` differs from `exp`; empty when the scenario meets its expectation. */
function mismatches(exp: Expectation, obs: Observation): string[] {
  const out: string[] = []
  if (obs.decision !== exp.decision) out.push(`decision: expected ${exp.decision}, observed ${obs.decision}`)
  if (exp.refusalMatches !== undefined && !new RegExp(exp.refusalMatches).test(obs.refusal ?? '')) {
    out.push(`refusal: expected /${exp.refusalMatches}/, observed ${obs.refusal}`)
  }
  for (const [key, want] of Object.entries(exp.durable ?? {})) {
    const got = obs.durable[key as keyof Observation['durable']]
    if (!sameJson(got, want))
      out.push(`durable.${key}: expected ${JSON.stringify(want)}, observed ${JSON.stringify(got)}`)
  }
  const { markersInclude, markersExclude, ...counts } = exp.effects ?? {}
  for (const [key, want] of Object.entries(counts)) {
    const got = obs.effects[key as keyof Observation['effects']]
    if (!sameJson(got, want))
      out.push(`effects.${key}: expected ${JSON.stringify(want)}, observed ${JSON.stringify(got)}`)
  }
  for (const m of markersInclude ?? []) if (!obs.effects.markers.includes(m)) out.push(`effects.markers: missing ${m}`)
  for (const m of markersExclude ?? [])
    if (obs.effects.markers.includes(m)) out.push(`effects.markers: unexpected ${m}`)
  const ev = exp.events ?? {}
  if (ev.sequence !== undefined && !sameJson(obs.events, ev.sequence)) {
    out.push(`events: expected ${ev.sequence.join(',')}, observed ${obs.events.join(',')}`)
  }
  for (const e of ev.include ?? []) if (!obs.events.includes(e)) out.push(`events: missing ${e}`)
  for (const e of ev.exclude ?? []) if (obs.events.includes(e)) out.push(`events: unexpected ${e}`)
  if (ev.uniqueRoundStarts) {
    for (const [round, n] of Object.entries(obs.roundStartsByRound)) {
      if (n !== 1) out.push(`events: round_started emitted ${n} times for round ${round}`)
    }
  }
  if (ev.journalResults !== undefined && !sameJson(obs.journalResults, ev.journalResults)) {
    out.push(`journal_finalized: expected ${ev.journalResults.join(',')}, observed ${obs.journalResults.join(',')}`)
  }
  return out
}

type Verdict =
  | { kind: 'passed' }
  | { kind: 'expected-defect'; defect: string; mismatches: string[] }
  | { kind: 'unexpected-failure'; mismatches: string[] }
  /** A defect mapping the run contradicts: the named id is absent or fixed, or the scenario now passes. */
  | { kind: 'bad-mapping'; defect: string; reason: string }

/** Classifies one scenario run against the frozen defect register. */
function classify(scenario: Pick<Scenario, 'expectedDefect'>, found: string[], defects: Register['defects']): Verdict {
  const named = scenario.expectedDefect
  if (named === undefined)
    return found.length === 0 ? { kind: 'passed' } : { kind: 'unexpected-failure', mismatches: found }
  const entry = defects.find((d) => d.id === named)
  if (entry === undefined) return { kind: 'bad-mapping', defect: named, reason: 'not in the defect register' }
  if (entry.status !== 'open')
    return { kind: 'bad-mapping', defect: named, reason: `register status is ${entry.status}` }
  if (found.length === 0)
    return { kind: 'bad-mapping', defect: named, reason: 'the scenario passes; the mapping is stale' }
  return { kind: 'expected-defect', defect: named, mismatches: found }
}

// --- the corpus run -----------------------------------------------------------

const results: { scenario: Scenario; observation: Observation; verdict: Verdict }[] = []

beforeAll(async () => {
  for (const scenario of corpus.scenarios) {
    const driver = SCENARIO_DRIVERS[scenario.id]
    if (driver === undefined) continue
    const observation = await driver()
    results.push({
      scenario,
      observation,
      verdict: classify(scenario, mismatches(scenario.expect, observation), register.defects)
    })
    cleanupWorlds()
    for (const agent of ENGINE_AGENTS) {
      const engineDriver = ENGINE_SCENARIO_DRIVERS[scenario.id]
      if (engineDriver === undefined) continue
      const engineObservation = await engineDriver(agent)
      engineResults.push({
        scenario,
        agent,
        observation: engineObservation,
        verdict: classifyEngine(
          scenario,
          mismatches(scenario.expect, engineObservation),
          engineFailures.entries.find((entry) => entry.scenario === scenario.id)
        )
      })
    }
  }
}, 240_000)

afterAll(() => {
  cleanupWorlds()
  process.stdout.write(
    `Engine expected-failure count: ${engineFailures.entries.length}; ceiling: ${ENGINE_FAILURE_CEILING}\n`
  )
})

const countOf = (kind: Verdict['kind']) => results.filter((r) => r.verdict.kind === kind).length

describe('architecture exit gate (O1: every corpus scenario executes on the standalone loop)', () => {
  it('every scenario has a driver and every driver a scenario', () => {
    const ids = corpus.scenarios.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.filter((id) => SCENARIO_DRIVERS[id] === undefined)).toEqual([])
    expect(Object.keys(SCENARIO_DRIVERS).filter((id) => !ids.includes(id))).toEqual([])
  })

  it('every register scenario category and every named behavior is covered by a corpus scenario', () => {
    const ids = new Set(corpus.scenarios.map((s) => s.id))
    for (const s of corpus.scenarios) {
      expect(s.categories.length).toBeGreaterThan(0)
      for (const c of s.categories) expect(CATEGORIES as readonly string[]).toContain(c)
    }
    const covered = new Set(corpus.scenarios.flatMap((s) => s.categories))
    expect(CATEGORIES.filter((c) => !covered.has(c))).toEqual([])
    for (const [behavior, scenarioIds] of Object.entries(corpus.behaviors)) {
      expect(scenarioIds.length).toBeGreaterThan(0)
      for (const id of scenarioIds) expect(ids.has(id) ? id : `${behavior}: ${id}`).toBe(id)
    }
  })

  it('every scenario names only real register entries as the behavior it exercises', () => {
    const known = new Map(register.invariants.map((i) => [i.id, i.classification]))
    for (const s of corpus.scenarios) {
      expect(s.guarantees.length).toBeGreaterThan(0)
      for (const g of s.guarantees) {
        expect([...GUARANTEE_CLASSES, ...DEFECT_CLASSES]).toContain(known.get(g) ?? `${s.id}: unknown ${g}`)
      }
    }
  })

  it('executes every scenario, skips none, and prints the counts', () => {
    const skipped = corpus.scenarios.length - results.length
    const lines = [
      `scenarios: ${corpus.scenarios.length} total, ${countOf('passed')} passed, ${countOf('expected-defect')} expected-defect, ${countOf('unexpected-failure') + countOf('bad-mapping')} unexpected-failure, ${skipped} skipped`,
      ...results.map((r) => {
        const v = r.verdict
        const tag = v.kind === 'expected-defect' ? `expected-defect ${v.defect}` : v.kind
        return `  standalone ${r.scenario.id}: ${tag} (${r.observation.decision})`
      })
    ]
    process.stdout.write(`${lines.join('\n')}\n`)
    expect(countOf('passed')).toBe(22)
    expect(countOf('expected-defect')).toBe(1)
    expect(skipped).toBe(0)
    expect(results.length).toBe(corpus.scenarios.length)
  })
})

describe('architecture exit gate (O2: every failure names an open defect-register identifier)', () => {
  it('reports zero unexpected failures and zero bad defect mappings', () => {
    const bad = results
      .filter((r) => r.verdict.kind === 'unexpected-failure' || r.verdict.kind === 'bad-mapping')
      .map((r) => `${r.scenario.id}: ${JSON.stringify(r.verdict)}`)
    expect(bad).toEqual([])
  })

  it('every expected failure still fails for the defect it names', () => {
    for (const r of results.filter((x) => x.verdict.kind === 'expected-defect')) {
      const v = r.verdict as Extract<Verdict, { kind: 'expected-defect' }>
      expect(v.defect).toBe(r.scenario.expectedDefect as string)
      expect(v.mismatches.length).toBeGreaterThan(0)
      process.stdout.write(`${r.scenario.id} → ${v.defect}: ${v.mismatches.join('; ')}\n`)
    }
  })

  it('a failure with no defect identifier is unexpected', () => {
    expect(classify({}, ['decision: expected publish, observed pause:infrastructure'], register.defects).kind).toBe(
      'unexpected-failure'
    )
  })

  it('a named defect absent from the register, a fixed one, or one whose scenario now passes is rejected', () => {
    const failing = ['events: round_started emitted 2 times for round 1']
    expect(classify({ expectedDefect: 'DEF-999' }, failing, register.defects)).toMatchObject({
      kind: 'bad-mapping',
      reason: 'not in the defect register'
    })
    const fixed = register.defects.find((d) => d.status === 'fixed')
    expect(fixed).toBeDefined()
    expect(classify({ expectedDefect: fixed!.id }, failing, register.defects).kind).toBe('bad-mapping')
    const open = register.defects.find((d) => d.status === 'open')!
    expect(classify({ expectedDefect: open.id }, [], register.defects)).toMatchObject({
      kind: 'bad-mapping',
      reason: 'the scenario passes; the mapping is stale'
    })
    expect(classify({ expectedDefect: open.id }, failing, register.defects).kind).toBe('expected-defect')
  })

  it('a difference in decision, durable state, effects or events is a mismatch', () => {
    const r = results.find((x) => x.scenario.id === 'clean-completion')!
    expect(mismatches(r.scenario.expect, r.observation)).toEqual([])
    const changed: Observation = {
      ...r.observation,
      decision: 'pause:infrastructure',
      durable: { ...r.observation.durable, driverLockHeld: true },
      effects: { ...r.observation.effects, publishedRounds: [], markers: [] },
      events: r.observation.events.filter((e) => e !== 'journal_finalized'),
      journalResults: []
    }
    const found = mismatches(r.scenario.expect, changed)
    for (const prefix of [
      'decision',
      'durable.driverLockHeld',
      'effects.publishedRounds',
      'effects.markers',
      'journal_finalized'
    ]) {
      expect(found.some((m) => m.startsWith(prefix))).toBe(true)
    }
  })
})

// The deletion-owner allowlist is frozen from the task rationale. It is not
// inferred from whichever guarantees happen to fail in this run.
const ENGINE_DELETION_OWNERS: Readonly<Record<string, readonly string[]>> = {
  '3': ['INV-093', 'INV-094'],
  '4': ['INV-025', 'INV-026', 'INV-075', 'INV-092', 'INV-101', 'INV-106', 'INV-113', 'INV-116'],
  '5': ['INV-002', 'INV-008', 'INV-076', 'INV-078', 'INV-086', 'INV-109', 'INV-144'],
  '6': ['INV-079', 'INV-082', 'INV-088', 'INV-090', 'INV-107'],
  '7': [
    'INV-005',
    'INV-010',
    'INV-011',
    'INV-016',
    'INV-020',
    'INV-023',
    'INV-042',
    'INV-057',
    'INV-063',
    'INV-013',
    'INV-031',
    'INV-125'
  ],
  '8': ['INV-033', 'INV-037', 'INV-038', 'INV-039', 'INV-041', 'INV-120', 'INV-122', 'INV-126', 'INV-137'],
  '9': ['INV-043', 'INV-071', 'INV-099', 'INV-102'],
  '10': ['INV-103', 'INV-118', 'INV-124', 'INV-127', 'INV-163'],
  '11': ['INV-021', 'INV-164'],
  '12': ['INV-089']
}
const ENGINE_ALLOWED_GUARANTEES = new Set(Object.values(ENGINE_DELETION_OWNERS).flat())
const ENGINE_AGENTS = ['claude', 'codex'] as const
// This ceiling may only fall together with removal of resolved fixture entries.
const ENGINE_FAILURE_CEILING = 11
interface EngineFailure {
  scenario: string
  guarantee: string
  reason: string
}
const engineFailures: { schemaVersion: number; entries: EngineFailure[] } = engineFailureFixture
type EngineVerdict =
  | { kind: 'passed' }
  | { kind: 'expected failure'; guarantee: string; mismatches: string[] }
  | { kind: 'unexpected'; reason: string; mismatches: string[] }
const engineResults: {
  scenario: Scenario
  agent: (typeof ENGINE_AGENTS)[number]
  observation: Observation
  verdict: EngineVerdict
}[] = []

function engineMappingError(scenario: Scenario, entry: EngineFailure): string | null {
  if (entry.scenario !== scenario.id) return 'mapping names another scenario'
  if (
    !register.invariants.some(
      (invariant) => invariant.id === entry.guarantee && invariant.classification === 'product-guarantee'
    )
  )
    return 'not a product-guarantee in the invariant register'
  if (!scenario.guarantees.includes(entry.guarantee)) return 'guarantee is not named by this scenario'
  if (!ENGINE_ALLOWED_GUARANTEES.has(entry.guarantee)) return 'guarantee has no later deletion owner'
  if (!entry.reason?.trim()) return 'mapping has no observed reason'
  return null
}

function classifyEngine(scenario: Scenario, found: string[], entry?: EngineFailure): EngineVerdict {
  if (entry === undefined)
    return found.length === 0
      ? { kind: 'passed' }
      : { kind: 'unexpected', reason: 'unmapped mismatch', mismatches: found }
  const error = engineMappingError(scenario, entry)
  if (error !== null) return { kind: 'unexpected', reason: error, mismatches: found }
  if (found.length === 0) return { kind: 'unexpected', reason: 'stale entry: scenario now passes', mismatches: found }
  return { kind: 'expected failure', guarantee: entry.guarantee, mismatches: found }
}

function engineFixtureErrors(entries: EngineFailure[], ceiling: number): string[] {
  const errors: string[] = []
  if (entries.length > ceiling) errors.push('expected-failure ceiling exceeded')
  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.scenario)) errors.push(`duplicate scenario: ${entry.scenario}`)
    seen.add(entry.scenario)
    const scenario = corpus.scenarios.find((candidate) => candidate.id === entry.scenario)
    const error = scenario ? engineMappingError(scenario, entry) : 'unknown scenario'
    if (error !== null) errors.push(`${entry.scenario}: ${error}`)
  }
  return errors
}

describe('architecture exit gate (Engine: the same corpus, real Flow and actions, both stub vendors)', () => {
  it('executes every scenario with each vendor and prints one classification per run', () => {
    expect(Object.keys(ENGINE_SCENARIO_DRIVERS).sort()).toEqual(corpus.scenarios.map((scenario) => scenario.id).sort())
    for (const agent of ENGINE_AGENTS) {
      const rows = engineResults.filter((row) => row.agent === agent)
      expect(rows.map((row) => row.scenario.id)).toEqual(corpus.scenarios.map((scenario) => scenario.id))
      for (const row of rows) {
        const verdict = row.verdict
        const tag = verdict.kind === 'expected failure' ? `expected failure ${verdict.guarantee}` : verdict.kind
        process.stdout.write(`  engine ${agent} ${row.scenario.id}: ${tag} (${row.observation.decision})\n`)
      }
      process.stdout.write(
        `Engine ${agent}: ${rows.filter((row) => row.verdict.kind === 'passed').length} passed, ${rows.filter((row) => row.verdict.kind === 'expected failure').length} expected failure, ${rows.filter((row) => row.verdict.kind === 'unexpected').length} unexpected\n`
      )
    }
  })

  it('an unreadable policy is observed at preparation, before any worker attempt', () => {
    for (const agent of ENGINE_AGENTS) {
      const row = engineResults.find(
        (result) => result.agent === agent && result.scenario.id === 'review-policy-unreadable'
      )!
      expect(['refused', 'pause:infrastructure']).toContain(row.observation.decision)
      expect(row.observation.effects.developerDispatches).toBe(0)
      expect(row.observation.effects.codeReviewerDispatches).toBe(0)
      expect(row.observation.effects.securityDispatches).toBe(0)
      expect(row.observation.events).not.toContain('role_attempt:attempted')
      if (row.observation.decision === 'refused') {
        expect(row.observation.refusal).toBe('fake: trust-anchor read failed')
        expect(row.observation.events).toEqual([])
      }
    }
  })

  it('accepts no unexpected mismatch or stale entry and both vendors classify identically', () => {
    expect(
      engineResults
        .filter((row) => row.verdict.kind === 'unexpected')
        .map((row) => ({ scenario: row.scenario.id, agent: row.agent, verdict: row.verdict }))
    ).toEqual([])
    for (const scenario of corpus.scenarios) {
      const rows = engineResults.filter((row) => row.scenario.id === scenario.id)
      expect(rows).toHaveLength(2)
      const classification = (row: (typeof rows)[number]) =>
        row.verdict.kind === 'expected failure' ? [row.verdict.kind, row.verdict.guarantee] : [row.verdict.kind]
      expect(classification(rows[0]!)).toEqual(classification(rows[1]!))
    }
  })

  it('the fixture has unique scenarios, product guarantees with later owners and the pinned entry count', () => {
    expect(engineFailures.schemaVersion).toBe(1)
    expect(engineFixtureErrors(engineFailures.entries, ENGINE_FAILURE_CEILING)).toEqual([])
    expect(engineFailures.entries.length).toBe(ENGINE_FAILURE_CEILING)
  })

  it('rejects an unmapped failure, a non-product id, an unrelated id, an unowned id and a stale entry', () => {
    const scenario = corpus.scenarios.find((row) => row.id === 'clean-completion')!
    const entry = { scenario: scenario.id, guarantee: 'INV-099', reason: 'probe' }
    expect(classifyEngine(scenario, ['probe']).kind).toBe('unexpected')
    for (const guarantee of ['DEF-03', 'INV-014', 'INV-999', 'INV-057', 'INV-001']) {
      expect(classifyEngine(scenario, ['probe'], { ...entry, guarantee }).kind).toBe('unexpected')
    }
    expect(classifyEngine(scenario, [], entry)).toMatchObject({
      kind: 'unexpected',
      reason: 'stale entry: scenario now passes'
    })
    expect(classifyEngine(scenario, ['probe'], entry)).toMatchObject({ kind: 'expected failure', guarantee: 'INV-099' })
    expect(classifyEngine(scenario, []).kind).toBe('passed')
    expect(engineFixtureErrors([entry, entry], 1)).toContain('expected-failure ceiling exceeded')
    expect(engineFixtureErrors([entry, entry], 2)).toContain(`duplicate scenario: ${scenario.id}`)
    expect(engineFixtureErrors([{ ...entry, scenario: 'absent' }], 1)).toContain('absent: unknown scenario')
  })
})

// --- O3: every product guarantee is fully represented ---------------------------

const guarantees = register.invariants.filter((i) => GUARANTEE_CLASSES.includes(i.classification))
const nodeById = new Map(NODE_CONTRACTS.map((n) => [n.id, n]))
const nodeOfGuarantee = new Map(corpus.guarantees.map((g) => [g.id, g.node]))

function executedScenariosFor(g: Invariant): string[] {
  return results.filter((r) => r.scenario.categories.some((c) => g.scenarios.includes(c))).map((r) => r.scenario.id)
}

/** External citations on the externally governed matrix rows tracing `g`; `null` when none traces it (no external standard applies). */
function normativeSourcesFor(g: Invariant): string[] | null {
  const tracing = matrix.rows.filter(
    (r) => EXTERNALLY_GOVERNED_ROW_KINDS.has(r.kind) && (r.traces ?? []).includes(g.id)
  )
  if (tracing.length === 0) return null
  return tracing.flatMap((r) =>
    r.citations
      .filter((c) => {
        const s = matrix.sources[c.source]
        return (
          s !== undefined &&
          !INTERNAL_SOURCE_KINDS.has(s.kind) &&
          (s.url ?? '').startsWith('https://') &&
          c.anchor.trim() !== ''
        )
      })
      .map((c) => `${r.id}:${c.source}`)
  )
}

/** Every field a guarantee lacks, as `<id>: <field>`. */
function guaranteeGaps(g: Invariant): string[] {
  const out: string[] = []
  if (!OWNERS.includes(g.owner)) out.push(`${g.id}: owner`)
  const node = nodeById.get(nodeOfGuarantee.get(g.id) ?? '')
  if (node === undefined || node.typedOutput.trim() === '' || g.authority.trim() === '')
    out.push(`${g.id}: representation`)
  if (node === undefined || node.failureBehavior.trim() === '') out.push(`${g.id}: failure behavior`)
  if (executedScenariosFor(g).length === 0) out.push(`${g.id}: scenario`)
  const sources = normativeSourcesFor(g)
  if (sources !== null && sources.length === 0) out.push(`${g.id}: normative source`)
  return out
}

describe('architecture exit gate (O3: no product guarantee lacks an owner, representation, failure behavior or oracle)', () => {
  it('the guarantee map names exactly the register guarantees, each bound to a real node contract', () => {
    expect(corpus.guarantees.map((g) => g.id).sort()).toEqual(guarantees.map((g) => g.id).sort())
    expect(corpus.guarantees.filter((g) => !nodeById.has(g.node)).map((g) => g.id)).toEqual([])
  })

  it('reports zero guarantee gaps and prints the guarantee and field-coverage counts', () => {
    const gaps = guarantees.flatMap(guaranteeGaps)
    const withOwner = guarantees.filter((g) => OWNERS.includes(g.owner)).length
    const withRepresentation = guarantees.filter((g) => !guaranteeGaps(g).includes(`${g.id}: representation`)).length
    const withFailure = guarantees.filter((g) => !guaranteeGaps(g).includes(`${g.id}: failure behavior`)).length
    const withScenario = guarantees.filter((g) => executedScenariosFor(g).length > 0).length
    const named = new Set(corpus.scenarios.flatMap((s) => s.guarantees))
    const applicable = guarantees.filter((g) => normativeSourcesFor(g) !== null)
    const withSource = applicable.filter((g) => (normativeSourcesFor(g) ?? []).length > 0).length
    const lines = [
      `product guarantees: ${guarantees.length}`,
      `  owner: ${withOwner}/${guarantees.length}`,
      `  typed representation: ${withRepresentation}/${guarantees.length}`,
      `  failure behavior: ${withFailure}/${guarantees.length}`,
      `  executed corpus scenario: ${withScenario}/${guarantees.length} (${guarantees.filter((g) => named.has(g.id)).length} named directly by a scenario)`,
      `  normative source: ${withSource}/${applicable.length} where an external standard applies (${guarantees.length - applicable.length} with none)`,
      `product guarantees with no directly named corpus scenario (proved by their owners): ${guarantees
        .filter((g) => !named.has(g.id))
        .map((g) => g.id)
        .join(', ')}`,
      `guarantee gaps: ${gaps.length}`
    ]
    process.stdout.write(`${lines.join('\n')}\n`)
    expect(gaps).toEqual([])
  })

  it('a guarantee missing any field is reported', () => {
    const [first] = guarantees as [Invariant]
    const probe: Invariant = { ...first, id: 'INV-PROBE', owner: 'nobody', scenarios: [] }
    expect(guaranteeGaps(probe)).toEqual([
      'INV-PROBE: owner',
      'INV-PROBE: representation',
      'INV-PROBE: failure behavior',
      'INV-PROBE: scenario'
    ])
  })
})

// --- O4: the standalone baseline the corpus ran against -------------------------

function sha256(rel: string): string {
  return createHash('sha256')
    .update(readFileSync(join(REPO_ROOT, rel)))
    .digest('hex')
}

/**
 * The standalone loop's implementation modules, as the invariant register
 * lists them: its baseline modules, the modules recorded as added since, and
 * its non-test support files. The register's own coverage test discovers the
 * loop's source tree and fails on any module it does not list, so a new module
 * reaches this list through the register rather than through a second walk of
 * the tree here.
 */
function loopSurface(): string[] {
  const { baseline, supportFiles } = register
  return [
    ...baseline.implementationModules,
    ...baseline.addedSinceBaseline.filter((a) => a.kind === 'implementation').map((a) => a.path),
    ...supportFiles.map((s) => s.path).filter((p) => !p.startsWith('apps/cli/tests/'))
  ]
    .filter((p) => existsSync(join(REPO_ROOT, p)))
    .sort()
}

it('declares every named input as a listed-files root', () => {
  const declaration = SCANNER_DECLARATIONS.find(
    (entry) => entry.test === 'apps/cli/tests/conformance/dev-review-engine-architecture-exit.test.ts'
  )
  expect(declaration?.trigger).toBe('listed-files')
  const inputs = [CORPUS_REL, corpus.invariantRegister, corpus.capabilityMatrix, ...loopSurface()]
  expect(inputs.filter((path) => !declaration?.roots.some((root) => underDeclaredRoot(path, root)))).toEqual([])
})

/** Every loop-surface file whose content differs from the recorded baseline, or that the baseline does not list. */
function baselineDrift(
  recorded: Corpus['baseline']['loopSurface'],
  current: string[],
  digest: (rel: string) => string = sha256
): string[] {
  const byPath = new Map(recorded.map((f) => [f.path, f.sha256]))
  const out = current
    .filter((p) => byPath.get(p) !== digest(p))
    .map((p) => (byPath.has(p) ? `${p}: changed` : `${p}: not in baseline`))
  for (const f of recorded) if (!current.includes(f.path)) out.push(`${f.path}: removed`)
  return out
}

/**
 * Drift entries for a changed loop module, closed with the command that
 * re-pins it. A module that is `not in baseline` keeps its plain text: adding
 * a loop module stays a deliberate edit of the corpus.
 */
function withRefreshHint(drift: string[]): string[] {
  const stale = drift.some(
    (d) => d.endsWith(': changed') || d.endsWith('changed the loop without updating the baseline')
  )
  return stale ? [...drift, `Run \`${REFRESH_COMMAND}\` and commit its result after the loop change.`] : drift
}

function git(args: string[], cwd: string = REPO_ROOT): { ok: boolean; out: Buffer } {
  const r = spawnSync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })
  return { ok: r.status === 0, out: r.stdout ?? Buffer.alloc(0) }
}

const CORPUS_REL = 'apps/cli/tests/fixtures/dev-review-engine-scenarios.json'

function commitsTouching(cwd: string, range: string, paths: string[]): string[] {
  return git(['log', '--no-merges', '--full-history', '--format=%H', range, '--', ...paths], cwd)
    .out.toString()
    .split('\n')
    .filter(Boolean)
}

/**
 * Every way the history in `cwd` fails to tie the corpus run to `commit`.
 * The commit must be in that history and an ancestor of its head. Loop modules
 * may change over several commits, so commits are not judged one by one: every
 * newest loop-module change (a change no later loop change follows) must be
 * the commit that updates this corpus or have a corpus update after it; that is
 * the only way a change can re-pin the baseline, because no change can name
 * the default-branch commit it will itself become. While no later commit has
 * changed the loop, the loop bytes at `commit` must equal the pinned digests
 * exactly.
 */
function commitDrift(commit: string, recorded: Corpus['baseline']['loopSurface'], cwd: string = REPO_ROOT): string[] {
  if (!git(['cat-file', '-e', `${commit}^{commit}`], cwd).ok) return [`${commit}: not in this checkout's history`]
  if (!git(['merge-base', '--is-ancestor', commit, 'HEAD'], cwd).ok) return [`${commit}: not an ancestor of HEAD`]
  const range = `${commit}..HEAD`
  const later = commitsTouching(
    cwd,
    range,
    recorded.map((f) => f.path)
  )
  const corpusCommits = commitsTouching(cwd, range, [CORPUS_REL])
  const out: string[] = []
  for (const sha of later) {
    const newest = !later.some((o) => o !== sha && git(['merge-base', '--is-ancestor', sha, o], cwd).ok)
    if (!newest) continue
    const recordedAfter = corpusCommits.some((c) => c === sha || git(['merge-base', '--is-ancestor', sha, c], cwd).ok)
    if (!recordedAfter) out.push(`${sha}: changed the loop without updating the baseline`)
  }
  if (later.length > 0) return out
  for (const f of recorded) {
    const blob = git(['show', `${commit}:${f.path}`], cwd)
    const digest = blob.ok ? createHash('sha256').update(blob.out).digest('hex') : null
    if (digest !== f.sha256) out.push(`${f.path}: differs at ${commit.slice(0, 8)}`)
  }
  return out
}

/** A small repository the self-tests build themselves, so every case is the same on any branch. */
function buildRepo(dir: string) {
  const run = (...args: string[]) => {
    const r = spawnSync(
      'git',
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        ...args
      ],
      { cwd: dir, encoding: 'utf8' }
    )
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
    return r.stdout.trim()
  }
  const LOOP = 'loop.ts'
  const loopDigest = (content: string) => createHash('sha256').update(content).digest('hex')
  const commitFiles = (message: string, files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true })
      writeFileSync(join(dir, path), content)
    }
    run('add', '-A')
    run('commit', '-m', message)
    return run('rev-parse', 'HEAD')
  }
  run('init', '-q', '-b', 'main')
  const base = commitFiles('base', { [LOOP]: 'v0', [CORPUS_REL]: 'c0' })
  return {
    run,
    base,
    LOOP,
    loopDigest,
    loop: (n: string) => commitFiles(`loop ${n}`, { [LOOP]: n }),
    corpus: (n: string) => commitFiles(`corpus ${n}`, { [CORPUS_REL]: n }),
    both: (n: string) => commitFiles(`both ${n}`, { [LOOP]: n, [CORPUS_REL]: n }),
    commitFiles
  }
}

describe('architecture exit gate (O4: the corpus pins its standalone baseline)', () => {
  it('records the default-branch commit the corpus ran against, verified against the checked-out history', () => {
    expect(corpus.baseline.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(corpus.baseline.branch).toBe('main')
    expect(withRefreshHint(commitDrift(corpus.baseline.commit, corpus.baseline.loopSurface))).toEqual([])
    process.stdout.write(
      `standalone baseline: ${corpus.baseline.branch}@${corpus.baseline.commit} (${corpus.baseline.loopSurface.length} loop modules pinned)\n`
    )
  })

  describe('the history rule, on a repository the test builds', () => {
    let dir: string
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'arch-exit-'))
    })
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })
    const recordedAt = (r: ReturnType<typeof buildRepo>) => [{ path: r.LOOP, sha256: r.loopDigest('v0') }]

    it('a commit outside the history, a pinned byte the commit does not hold, or no ancestry is drift', () => {
      const r = buildRepo(dir)
      const recorded = recordedAt(r)
      expect(commitDrift(r.base, recorded, dir)).toEqual([])
      expect(commitDrift('0'.repeat(40), recorded, dir)).toEqual([`${'0'.repeat(40)}: not in this checkout's history`])
      expect(commitDrift(r.base, [{ path: r.LOOP, sha256: '0'.repeat(64) }], dir)).toEqual([
        `${r.LOOP}: differs at ${r.base.slice(0, 8)}`
      ])
      r.run('checkout', '-q', '--orphan', 'other')
      const other = r.commitFiles('other', { x: '1' })
      r.run('checkout', '-q', 'main')
      r.run('checkout', '-q', other)
      expect(commitDrift(r.base, recorded, dir)).toEqual([`${r.base}: not an ancestor of HEAD`])
    })

    it('several loop commits followed by a corpus update pass; earlier commits are not judged', () => {
      const r = buildRepo(dir)
      r.loop('v1')
      r.loop('v2')
      r.corpus('c1')
      expect(commitDrift(r.base, recordedAt(r), dir)).toEqual([])
    })

    it('a corpus update inside the newest loop commit passes', () => {
      const r = buildRepo(dir)
      r.loop('v1')
      r.both('v2')
      expect(commitDrift(r.base, recordedAt(r), dir)).toEqual([])
    })

    it('a single squashed commit changing the loop and the corpus passes', () => {
      const r = buildRepo(dir)
      r.both('v1')
      expect(commitDrift(r.base, recordedAt(r), dir)).toEqual([])
    })

    it('a loop change after the last corpus update fails and names that commit', () => {
      const r = buildRepo(dir)
      r.both('v1')
      const newest = r.loop('v2')
      expect(commitDrift(r.base, recordedAt(r), dir)).toEqual([
        `${newest}: changed the loop without updating the baseline`
      ])
    })

    it('a loop change with no corpus update at all fails and names the newest loop commit', () => {
      const r = buildRepo(dir)
      r.loop('v1')
      const newest = r.loop('v2')
      expect(commitDrift(r.base, recordedAt(r), dir)).toEqual([
        `${newest}: changed the loop without updating the baseline`
      ])
    })

    it('a branch that merged the default branch passes when a corpus update follows its last loop change', () => {
      const r = buildRepo(dir)
      r.run('checkout', '-q', '-b', 'task')
      r.commitFiles('branch loop', { [r.LOOP]: 'branch' })
      r.run('checkout', '-q', 'main')
      r.commitFiles('main squash', { 'other.ts': 'm', [CORPUS_REL]: 'cm' })
      r.run('checkout', '-q', 'task')
      r.run('merge', '-q', '--no-edit', 'main')
      expect(commitDrift(r.base, recordedAt(r), dir)).toHaveLength(1)
      r.corpus('c-final')
      expect(commitDrift(r.base, recordedAt(r), dir)).toEqual([])
    })

    it('a merge of the default branch whose corpus update predates the branch loop change still fails', () => {
      const r = buildRepo(dir)
      r.run('checkout', '-q', '-b', 'task')
      const branchLoop = r.commitFiles('branch loop', { [r.LOOP]: 'branch' })
      r.run('checkout', '-q', 'main')
      r.commitFiles('main change', { [r.LOOP]: 'main', [CORPUS_REL]: 'cm' })
      r.run('checkout', '-q', 'task')
      r.run('merge', '-q', '-X', 'theirs', '--no-edit', 'main')
      expect(commitDrift(r.base, recordedAt(r), dir)).toEqual([
        `${branchLoop}: changed the loop without updating the baseline`
      ])
    })
  })

  it('the standalone loop under test is byte-identical to that baseline', () => {
    expect(withRefreshHint(baselineDrift(corpus.baseline.loopSurface, loopSurface()))).toEqual([])
  })

  it('a changed, added or removed loop module is drift', () => {
    const root = mkdtempSync(join(tmpdir(), 'arch-exit-drift-'))
    try {
      const files = { 'a.ts': 'one', 'b.ts': 'two' }
      for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text)
      const digest = (rel: string) =>
        createHash('sha256')
          .update(readFileSync(join(root, rel)))
          .digest('hex')
      const current = Object.keys(files)
      const [first, second] = current.map((path) => ({ path, sha256: digest(path) })) as [
        Corpus['baseline']['loopSurface'][number],
        Corpus['baseline']['loopSurface'][number]
      ]
      expect(baselineDrift([first, second], current, digest)).toEqual([])
      expect(baselineDrift([{ ...first, sha256: '0'.repeat(64) }, second], current, digest)).toEqual([
        `${first.path}: changed`
      ])
      expect(baselineDrift([second], current, digest)).toEqual([`${first.path}: not in baseline`])
      expect(baselineDrift([first, second, { path: 'gone.ts', sha256: '0'.repeat(64) }], current, digest)).toEqual([
        'gone.ts: removed'
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('architecture exit gate (the refresh command re-pins a changed loop module)', () => {
  const fixture = (digestA: string) =>
    [
      '{',
      '  "baseline": {',
      '    "commit": "8fb270e9a28a76ceaffd7f795f52d4df3155a284",',
      '    "branch": "main",',
      '    "loopSurface": [',
      '      {',
      '        "path": "a.ts",',
      `        "sha256": "${digestA}"`,
      '      },',
      '      {',
      '        "path": "b.ts",',
      `        "sha256": "${createHash('sha256').update('two').digest('hex')}"`,
      '      }',
      '    ]',
      '  },',
      '  "other": ["x"]',
      '}',
      ''
    ].join('\n')

  it('corrects one stale digest with a one-line diff, and a second run changes nothing', () => {
    const root = mkdtempSync(join(tmpdir(), 'arch-exit-refresh-'))
    try {
      writeFileSync(join(root, 'a.ts'), 'one')
      writeFileSync(join(root, 'b.ts'), 'two')
      const stale = fixture('0'.repeat(64))
      const once = refreshLoopBaseline(stale, root)
      expect(once).toBe(fixture(createHash('sha256').update('one').digest('hex')))
      const before = stale.split('\n')
      const after = once.split('\n')
      expect(after.length).toBe(before.length)
      expect(after.filter((line, i) => line !== before[i])).toHaveLength(1)
      expect(refreshLoopBaseline(once, root)).toBe(once)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('the failure names the command for a changed module and keeps `not in baseline` plain', () => {
    expect(withRefreshHint(['a.ts: changed']).at(-1)).toContain(REFRESH_COMMAND)
    expect(withRefreshHint(['abc: changed the loop without updating the baseline']).at(-1)).toContain(REFRESH_COMMAND)
    expect(withRefreshHint(['a.ts: not in baseline'])).toEqual(['a.ts: not in baseline'])
  })
})
