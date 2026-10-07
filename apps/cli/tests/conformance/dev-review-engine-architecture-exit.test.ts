import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanupWorlds } from '../lib/dev-review-loop-harness.js'
import { NODE_CONTRACTS } from '../lib/dev-review-loop/dev-review-engine-state-contract.fixture.js'
import { type Observation, SCENARIO_DRIVERS } from './dev-review-current-loop-adapter.js'

/**
 * The developer-review architecture exit gate.
 *
 * One test file executes every scenario of the normalized behavioral corpus
 * (`tests/fixtures/dev-review-engine-scenarios.json`) against the current
 * standalone loop through `dev-review-current-loop-adapter.ts`, and classifies
 * each result against the scenario's portable expectation: passed, an
 * expected failure that names an open entry of the frozen defect register, or
 * an unexpected failure. Nothing is skipped and no failure is accepted without
 * a register identifier. It then checks the exit condition over every product
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
const GUARANTEE_CLASSES = ['product-guarantee', 'guarantee']
const DEFECT_CLASSES = ['named-defect', 'defect']
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
  }
}, 240_000)

afterAll(cleanupWorlds)

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
        return `  ${r.scenario.id}: ${tag} (${r.observation.decision})`
      })
    ]
    process.stdout.write(`${lines.join('\n')}\n`)
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

/** Every loop-surface file whose content differs from the recorded baseline, or that the baseline does not list. */
function baselineDrift(recorded: Corpus['baseline']['loopSurface'], current: string[]): string[] {
  const byPath = new Map(recorded.map((f) => [f.path, f.sha256]))
  const out = current
    .filter((p) => byPath.get(p) !== sha256(p))
    .map((p) => (byPath.has(p) ? `${p}: changed` : `${p}: not in baseline`))
  for (const f of recorded) if (!current.includes(f.path)) out.push(`${f.path}: removed`)
  return out
}

function git(args: string[]): { ok: boolean; out: Buffer } {
  const r = spawnSync('git', args, { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 })
  return { ok: r.status === 0, out: r.stdout ?? Buffer.alloc(0) }
}

const CORPUS_REL = 'apps/cli/tests/fixtures/dev-review-engine-scenarios.json'

/**
 * Every way the checked-out history fails to tie the corpus run to `commit`.
 * The commit must be in this checkout's history and an ancestor of the head
 * under test. A later commit that changes a loop module must update this
 * corpus in that same commit; that is the only way a change can re-pin the
 * baseline, because no change can name the default-branch commit it will
 * itself become. While no later commit has changed the loop, the loop bytes
 * at `commit` must equal the pinned digests exactly.
 */
function commitDrift(commit: string, recorded: Corpus['baseline']['loopSurface']): string[] {
  if (!git(['cat-file', '-e', `${commit}^{commit}`]).ok) return [`${commit}: not in this checkout's history`]
  if (!git(['merge-base', '--is-ancestor', commit, 'HEAD']).ok) return [`${commit}: not an ancestor of HEAD`]
  const later = git(['log', '--format=%H', `${commit}..HEAD`, '--', ...recorded.map((f) => f.path)])
    .out.toString()
    .split('\n')
    .filter(Boolean)
  const out: string[] = []
  for (const sha of later) {
    const touched = git(['show', '--name-only', '--format=', sha]).out.toString().split('\n')
    if (!touched.includes(CORPUS_REL)) out.push(`${sha}: changed the loop without updating the baseline`)
  }
  if (later.length > 0) return out
  for (const f of recorded) {
    const blob = git(['show', `${commit}:${f.path}`])
    const digest = blob.ok ? createHash('sha256').update(blob.out).digest('hex') : null
    if (digest !== f.sha256) out.push(`${f.path}: differs at ${commit.slice(0, 8)}`)
  }
  return out
}

describe('architecture exit gate (O4: the corpus pins its standalone baseline)', () => {
  it('records the default-branch commit the corpus ran against, verified against the checked-out history', () => {
    expect(corpus.baseline.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(corpus.baseline.branch).toBe('main')
    expect(commitDrift(corpus.baseline.commit, corpus.baseline.loopSurface)).toEqual([])
    process.stdout.write(
      `standalone baseline: ${corpus.baseline.branch}@${corpus.baseline.commit} (${corpus.baseline.loopSurface.length} loop modules pinned)\n`
    )
  })

  it('a commit outside the history, a pinned byte the commit does not hold, or an unrecorded loop change is drift', () => {
    const recorded = corpus.baseline.loopSurface
    expect(commitDrift('0'.repeat(40), recorded)).toEqual([`${'0'.repeat(40)}: not in this checkout's history`])
    const [first, ...rest] = recorded as [Corpus['baseline']['loopSurface'][number]]
    expect(commitDrift(corpus.baseline.commit, [{ ...first, sha256: '0'.repeat(64) }, ...rest])).toEqual([
      `${first.path}: differs at ${corpus.baseline.commit.slice(0, 8)}`
    ])
    // The newest commit that changed a loop module did not update this corpus, so
    // a baseline recorded at its parent sees an unrecorded change on the way to HEAD.
    const paths = recorded.map((f) => f.path)
    const lastTouch = git(['log', '-1', '--format=%H', corpus.baseline.commit, '--', ...paths])
      .out.toString()
      .trim()
    const before = git(['rev-parse', `${lastTouch}^`])
      .out.toString()
      .trim()
    expect(commitDrift(before, recorded)).toContain(`${lastTouch}: changed the loop without updating the baseline`)
  })

  it('the standalone loop under test is byte-identical to that baseline', () => {
    expect(baselineDrift(corpus.baseline.loopSurface, loopSurface())).toEqual([])
  })

  it('a changed, added or removed loop module is drift', () => {
    const current = loopSurface()
    const [first, ...rest] = corpus.baseline.loopSurface as [Corpus['baseline']['loopSurface'][number]]
    expect(baselineDrift([{ ...first, sha256: '0'.repeat(64) }, ...rest], current)).toEqual([`${first.path}: changed`])
    expect(baselineDrift(rest, current)).toEqual([`${first.path}: not in baseline`])
    expect(
      baselineDrift([...corpus.baseline.loopSurface, { path: 'gone.ts', sha256: '0'.repeat(64) }], current)
    ).toEqual(['gone.ts: removed'])
  })
})
