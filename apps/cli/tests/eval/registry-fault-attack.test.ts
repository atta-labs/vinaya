// The fault-and-attack shard is complete: every row of the evaluation
// program's canonical fault-and-attack matrix, parsed from the repository
// mirror, has exactly one valid row carrying the table's suite, layers,
// expected typed outcome and cutover outcome, and the statement its cutover
// outcome requires, and the evidence for each backend it lists. It aggregates
// with the other shards and claims nothing about any other kind.
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type ComponentKind,
  checkShardCompleteness,
  loadRegistry,
  type ModuleCatalog,
  suiteId
} from '../../src/lib/dev-review-eval/registry'
import { engineEvidenceOf, OPERATOR_EXIT_EXCLUSIONS } from '../../src/lib/dev-review-eval/exit-check'
import {
  CONTAINMENT_PROBES,
  CONTAINMENT_ROW_IDS,
  CONTROLLER_BOUNDARY_RESIDUAL,
  CONTROLLER_BOUNDARY_ROW_IDS,
  CODEX_FILE_READ_RESIDUAL,
  CREDENTIAL_PROBES,
  CREDENTIAL_ROW_IDS,
  NON_SECRET_EGRESS_RESIDUAL,
  OWED_REASONS
} from '../sandbox-conformance/engine-attack-probes'

type LoadedRow = Parameters<typeof engineEvidenceOf>[0]
import {
  FAULT_ATTACK_HEADING,
  type FaultAttackEntry,
  MUST_PASS_STATEMENT,
  PROGRAM_DOCUMENT,
  parseFaultAttackTable,
  RESIDUAL_RISK_STATEMENT,
  readFaultAttackUniverse,
  slug
} from './registry/fault-attack-universe'

const REGISTRY_DIR = join(import.meta.dir, 'registry')
const SHARD_FILE = join(REGISTRY_DIR, 'shards/fault-attack.json')
const LOCATION = 'shards/fault-attack.json'
const UNIVERSE = readFaultAttackUniverse()
const EXCLUDED = new Set(
  OPERATOR_EXIT_EXCLUSIONS.filter((entry) => entry.kind === 'fault-attack').map((entry) => entry.name)
)
const ACTIVE_UNIVERSE = UNIVERSE.filter((entry) => !EXCLUDED.has(entry.name))

const loaded = loadRegistry(join(REGISTRY_DIR, 'modules.json'), join(REGISTRY_DIR, 'shards'))
if (!loaded.ok) throw new Error(`registry refused: ${JSON.stringify(loaded.refusal)}`)
const catalog: ModuleCatalog = loaded.value.catalog
const shard = loaded.value.shards.find((s) => s.shard === 'fault-attack')
if (shard === undefined) throw new Error('the fault-attack shard was not found by listing the shard directory')

type RawRow = Record<string, unknown> & {
  id: string
  module: string
  suite: string[]
  contract: string
  decisionRule: string
  backends: string[]
  faultAttack: Record<string, unknown>
  backendEvidence: Record<string, unknown>
}
const rawShard = JSON.parse(readFileSync(SHARD_FILE, 'utf8')) as { kinds: string[]; components: RawRow[] }

/** One way a row departs from its table row. */
interface Mismatch {
  name: string
  column: 'title' | 'suite' | 'layer' | 'expected-outcome' | 'cutover' | 'cutover-statement'
  detail: string
}

/**
 * The suites a module declares at the given layers. A process-layer `G` suite
 * is left out: it grades process-neutral outcomes, while every fault or attack
 * in the table is one on this process's own mechanics.
 */
function suitesAt(moduleId: string, layers: readonly string[]): string[] {
  const module = catalog.modules.find((m) => m.id === moduleId)
  return (module?.suites ?? []).filter((s) => layers.includes(s.layer) && s.processLayer !== 'G').map(suiteId)
}

/**
 * Compares each row with the table row its id names: suite, layers, expected
 * outcome and cutover outcome, and the statement that cutover outcome requires.
 * Missing, extra and invalid rows are the registry's completeness check.
 */
function compareWithTable(rows: readonly RawRow[], universe: readonly FaultAttackEntry[]): Mismatch[] {
  const byName = new Map(universe.map((entry) => [entry.name, entry]))
  const out: Mismatch[] = []
  for (const row of rows) {
    const name = String(row.id).slice('fault-attack:'.length)
    const entry = byName.get(name)
    if (entry === undefined) continue
    const table = (row.faultAttack ?? {}) as Record<string, unknown>
    const differ = (column: Mismatch['column'], detail: string) => out.push({ name, column, detail })
    if (table.title !== entry.title || table.order !== entry.order) differ('title', `${table.order} ${table.title}`)
    const [owner, ...rest] = entry.modules
    const expectedSuite = suitesAt(owner as string, entry.layers)
    if (
      row.module !== owner ||
      JSON.stringify(table.modules) !== JSON.stringify(entry.modules) ||
      JSON.stringify(row.suite) !== JSON.stringify(expectedSuite) ||
      rest.some((id) => !String(row.contract).includes(`module ${id} (`))
    ) {
      differ(
        'suite',
        `module ${row.module}, suites ${JSON.stringify(row.suite)}, table ${JSON.stringify(table.modules)}`
      )
    }
    if (JSON.stringify(table.layers) !== JSON.stringify(entry.layers)) differ('layer', JSON.stringify(table.layers))
    if (table.expectedOutcome !== entry.expectedOutcome || !String(row.contract).includes(entry.expectedOutcome)) {
      differ('expected-outcome', String(table.expectedOutcome))
    }
    if (table.cutover !== entry.cutover) differ('cutover', String(table.cutover))
    const statement = entry.cutover === 'must-pass' ? MUST_PASS_STATEMENT : RESIDUAL_RISK_STATEMENT
    if (!String(row.decisionRule).includes(statement)) differ('cutover-statement', `missing: ${statement}`)
  }
  return out
}

const clone = <T>(value: T): T => structuredClone(value)
const universes = { 'fault-attack': ACTIVE_UNIVERSE.map((entry) => entry.name) }
const check = (content: unknown, kinds: Partial<Record<ComponentKind, readonly string[]>> = universes) => {
  const filtered = clone(content as { components: RawRow[] })
  filtered.components = filtered.components.filter((row) => !EXCLUDED.has(row.id.slice('fault-attack:'.length)))
  const result = checkShardCompleteness(filtered, catalog, kinds, LOCATION)
  if (!result.ok) throw new Error(JSON.stringify(result.refusal))
  return result.value
}

describe('the fault-and-attack universe parsed from the mirror', () => {
  it('holds the ninety-six rows of the table, each its own component with a unique name', () => {
    expect(UNIVERSE.length).toBe(96)
    expect(new Set(UNIVERSE.map((entry) => entry.name)).size).toBe(96)
    expect(UNIVERSE.map((entry) => entry.order)).toEqual(UNIVERSE.map((_, index) => index + 1))
  })

  it('derives each name from the row’s order and title alone', () => {
    for (const entry of UNIVERSE) {
      expect(entry.name).toBe(`${String(entry.order).padStart(2, '0')}-${slug(entry.title)}`)
    }
    const program = readFileSync(join(import.meta.dir, '../../specs/dev-review-evaluation-program.md'), 'utf8')
    const reworded = parseFaultAttackTable(program.replace('| Developer process death |', '| Developer crash |'))
    expect(reworded.map((entry) => entry.name).filter((n, i) => n !== UNIVERSE[i]?.name)).toEqual([
      '01-developer-crash'
    ])
  })

  it('expands layer ranges and keeps every module the Suite column names, in order', () => {
    const budget = UNIVERSE.find((entry) => entry.title.startsWith('Hard-budget exhaustion'))
    expect(budget?.layers).toEqual(['L1', 'L2', 'L3'])
    expect(budget?.modules).toEqual(['6.11', '6.14'])
    const controller = UNIVERSE.find((entry) => entry.title === 'Controller process death')
    expect(controller?.layers).toEqual(['L2', 'L3', 'L7'])
  })
})

describe('the fault-attack shard', () => {
  it('declares only the fault-attack kind', () => {
    expect(shard.kinds).toEqual(['fault-attack'])
  })

  it('is complete against the universe parsed from the mirror', () => {
    const report = check(rawShard)
    const mismatches = compareWithTable(rawShard.components, ACTIVE_UNIVERSE)
    const mustPass = ACTIVE_UNIVERSE.filter((entry) => entry.cutover === 'must-pass').length
    process.stdout.write(
      `fault-attack shard: ${shard.components.length} rows (${mustPass} must pass, ${ACTIVE_UNIVERSE.length - mustPass} pass or accepted); missing ${report.missing.length}, extra ${report.extra.length}, invalid ${report.invalid.length}, differing ${mismatches.length}\n`
    )
    expect(report.missing).toEqual([])
    expect(report.extra).toEqual([])
    expect(report.invalid).toEqual([])
    expect(report.complete).toBe(true)
    expect(mismatches).toEqual([])
    expect(shard.components.length).toBe(58)
  })

  it('cites, on each row, the fault-and-attack heading of the mirror at its pinned revision', () => {
    for (const row of shard.components) {
      expect(row.source).toEqual({
        document: PROGRAM_DOCUMENT,
        revision: 11,
        section: FAULT_ATTACK_HEADING
      })
    }
  })

  it('aggregates with every other shard without a duplicate component id', () => {
    const ids = loaded.value.components.map((entry) => entry.row.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(
      loaded.value.components.filter((entry) => entry.location.startsWith('shards/fault-attack.json#'))
    ).toHaveLength(58)
  })

  it('records, on each row, evidence for exactly the backends it lists, owed to the Operator on its excluded rows', () => {
    for (const row of shard.components) {
      expect({ id: row.id, backends: Object.keys(row.backendEvidence ?? {}) }).toEqual({
        id: row.id,
        backends: row.backends
      })
      if (!EXCLUDED.has(row.id.slice('fault-attack:'.length))) continue
      for (const entry of Object.values(row.backendEvidence ?? {})) {
        expect('owed' in entry && entry.owed).toContain('Operator on one host')
      }
    }
  })
})

describe('the fault-attack check fails on what it must', () => {
  it('reports a missing row', () => {
    const content = clone(rawShard)
    const dropped = content.components.splice(4, 1)[0] as RawRow
    expect(check(content).missing).toEqual([{ kind: 'fault-attack', name: dropped.id.slice('fault-attack:'.length) }])
  })

  it('reports an extra row, and a repeated one', () => {
    const content = clone(rawShard)
    const extra = clone(content.components[0] as RawRow)
    extra.id = 'fault-attack:59-scheduler-outage'
    content.components.push(extra, clone(content.components[1] as RawRow))
    const report = check(content)
    expect(report.complete).toBe(false)
    expect(report.extra).toEqual([
      { kind: 'fault-attack', name: '59-scheduler-outage' },
      { kind: 'fault-attack', name: '02-reviewer-process-death' }
    ])
  })

  it('reports a row with an empty field', () => {
    const content = clone(rawShard)
    ;(content.components[6] as RawRow).contract = ''
    expect(check(content).invalid.map((r) => [r.code, r.path])).toEqual([
      ['empty', `${LOCATION}#components[6].contract`]
    ])
  })

  it('reports a row that differs from the table in suite, layer, expected outcome or cutover outcome', () => {
    const content = clone(rawShard)
    const rows = content.components
    ;(rows[0] as RawRow).suite = ['developer-invocation.l7@1']
    ;(rows[1] as RawRow).faultAttack.layers = ['L4']
    ;(rows[2] as RawRow).faultAttack.expectedOutcome = 'restart from scratch'
    ;(rows[3] as RawRow).faultAttack.cutover = 'pass-or-accepted'
    expect(compareWithTable(rows, ACTIVE_UNIVERSE).map((m) => [m.name, m.column])).toEqual([
      ['01-developer-process-death', 'suite'],
      ['02-reviewer-process-death', 'layer'],
      ['03-controller-process-death', 'expected-outcome'],
      ['04-stream-truncation', 'cutover']
    ])
  })

  it('reports a row naming another module, or dropping a further module from its contract', () => {
    const content = clone(rawShard)
    const provider = content.components.findIndex((row) => row.faultAttack.title === 'Provider timeout')
    ;(content.components[provider] as RawRow).contract = (content.components[provider] as RawRow).contract.replace(
      'module 6.14 (',
      'module 6.14 -'
    )
    ;(content.components[0] as RawRow).module = '6.14'
    expect(compareWithTable(content.components, ACTIVE_UNIVERSE).map((m) => [m.name, m.column])).toEqual([
      ['01-developer-process-death', 'suite'],
      [(content.components[provider] as RawRow).id.slice('fault-attack:'.length), 'suite']
    ])
  })

  it('reports a must-pass row admitting a known failure, and a pass-or-accepted row without the Principal’s acceptance', () => {
    const content = clone(rawShard)
    const mustPass = content.components.findIndex((row) => row.faultAttack.cutover === 'must-pass')
    const accepted = content.components.findIndex((row) => row.faultAttack.cutover === 'pass-or-accepted')
    ;(content.components[mustPass] as RawRow).decisionRule = 'Must pass: green on the Engine backend before cutover.'
    ;(content.components[accepted] as RawRow).decisionRule =
      'Pass or accepted: the test runs and its result is recorded.'
    expect(compareWithTable(content.components, ACTIVE_UNIVERSE).map((m) => m.column)).toEqual([
      'cutover-statement',
      'cutover-statement'
    ])
  })

  it('states the right statement on every row', () => {
    for (const row of rawShard.components) {
      const mustPass = row.faultAttack.cutover === 'must-pass'
      expect({
        id: row.id,
        holds: row.decisionRule.includes(mustPass ? MUST_PASS_STATEMENT : RESIDUAL_RISK_STATEMENT)
      }).toEqual({
        id: row.id,
        holds: true
      })
    }
  })

  it('reports a row with no evidence entry for a backend it lists, or one for a backend it does not list', () => {
    const content = clone(rawShard)
    delete (content.components[0] as RawRow).backendEvidence.standalone
    ;(content.components[1] as RawRow).backends = ['engine']
    const report = check(content)
    expect(report.invalid.map((r) => [r.code, r.path])).toEqual([
      ['missing_field', `${LOCATION}#components[0].backendEvidence.standalone`],
      ['unknown_value', `${LOCATION}#components[1].backendEvidence.standalone`]
    ])
    expect(report.invalid[0]?.detail).toContain('fault-attack:01-developer-process-death')
  })

  it('claims nothing about a kind the shard does not declare', () => {
    const report = check(rawShard, { ...universes, 'cutover-gate': ['gate-17'], role: ['developer'] })
    expect(report.kinds).toEqual(['fault-attack'])
    expect(report.complete).toBe(true)
  })
})

describe('the credential-confinement rows record Engine evidence, owed shrink-only', () => {
  const owedList = JSON.parse(readFileSync(join(import.meta.dir, 'engine-evidence-owed.json'), 'utf8')) as {
    owed: string[]
  }
  const byId = new Map(loaded.value.components.map((entry) => [entry.row.id, entry.row]))

  it('lists every credential row and fails while any has no recorded Engine evidence, printing the owed count', () => {
    // "Recorded" is a live-gated test entry or a stated owed reason; a row with no entry names itself in the failure.
    const unrecorded = CREDENTIAL_ROW_IDS.filter((id) => {
      const row = byId.get(id)
      return row === undefined || engineEvidenceOf(row) === undefined
    })
    expect(unrecorded).toEqual([])
    const owed = CREDENTIAL_ROW_IDS.filter((id) => owedList.owed.includes(id))
    // The owed list only shrinks under engine-evidence.test.ts's ceiling; this prints where the credential rows stand.
    process.stdout.write(
      `credential-confinement Engine evidence: ${owed.length} of ${CREDENTIAL_ROW_IDS.length} rows owed\n`
    )
  })

  const cutoverOf = new Map(
    rawShard.components.map((row) => [row.id, (row.faultAttack as { cutover?: string }).cutover])
  )

  it('records, for each pass-or-accepted credential row, denial on both adapters or its residual risk', () => {
    for (const probe of CREDENTIAL_PROBES) {
      const id = `fault-attack:${probe.row}`
      if (cutoverOf.get(id) !== 'pass-or-accepted') continue
      const row = byId.get(id)
      if (row === undefined) throw new Error(`no row for ${probe.row}`)
      const deniedBoth = Object.values(probe.byAdapter).every((d) => d.kind !== 'owed')
      const state = engineEvidenceOf(row)
      const namesResidual = state?.state === 'owed' && state.reason === CODEX_FILE_READ_RESIDUAL
      expect(deniedBoth || namesResidual).toBe(true)
    }
  })

  it('records a recognized owed reason on each credential row an adapter cannot deny, and the ruling reason where it applies', () => {
    for (const probe of CREDENTIAL_PROBES) {
      const owedReasons = Object.values(probe.byAdapter)
        .filter((d) => d.kind === 'owed')
        .map((d) => (d as { reason: string }).reason)
      if (owedReasons.length === 0) continue
      const row = byId.get(`fault-attack:${probe.row}`)
      const state = row === undefined ? undefined : engineEvidenceOf(row)
      expect(state?.state).toBe('owed')
      if (state?.state === 'owed') {
        expect([...OWED_REASONS]).toContain(state.reason)
        // The row's recorded owed reason is one its probe's own adapters name — never a reason from elsewhere.
        expect(owedReasons).toContain(state.reason)
      }
    }
  })
})

describe('the capability and controller-boundary rows record Engine evidence, owed shrink-only', () => {
  const owedList = JSON.parse(readFileSync(join(import.meta.dir, 'engine-evidence-owed.json'), 'utf8')) as {
    owed: string[]
  }
  const rows = CONTROLLER_BOUNDARY_ROW_IDS.map((id) => {
    const row = shard.components.find((component) => component.id === id)
    if (row === undefined) throw new Error(`${id} is not a row of the fault-attack shard`)
    return { id, row }
  })
  /** Remove entries only after the outside-sandbox Linux/macOS Claude/Codex output is pasted. */
  const owed = CONTROLLER_BOUNDARY_ROW_IDS.filter((id) => owedList.owed.includes(id))
  const owedCeiling = 9

  it('enumerates every task row and prints the count still owed', () => {
    process.stdout.write(`controller-boundary Engine evidence: ${owed.length} of ${rows.length} rows owed\n`)
    expect(owed).toEqual([...CONTROLLER_BOUNDARY_ROW_IDS])
    expect(owed.length).toBeLessThanOrEqual(owedCeiling)
    for (const { row } of rows) expect(engineEvidenceOf(row)?.state).toBe('owed')
  })

  it('fails while a row is off the owed list without recorded Engine evidence, and while an evidenced row stays on it', () => {
    const offWithoutEvidence = rows.filter(
      ({ id, row }) => !owedList.owed.includes(id) && engineEvidenceOf(row)?.state !== 'evidenced'
    )
    const evidencedButOwed = rows.filter(
      ({ id, row }) => owedList.owed.includes(id) && engineEvidenceOf(row)?.state === 'evidenced'
    )
    expect(offWithoutEvidence.map(({ id }) => id)).toEqual([])
    expect(evidencedButOwed.map(({ id }) => id)).toEqual([])
  })

  it('keeps gate-15 rows free of known failures and records residual risk for pass-or-accepted rows', () => {
    for (const { id } of rows) {
      const raw = rawShard.components.find((component) => component.id === id)
      expect(raw?.faultAttack.knownFailure).toBeUndefined()
      if (raw?.faultAttack.cutover === 'pass-or-accepted') {
        const row = shard.components.find((component) => component.id === id)
        const evidence = row === undefined ? undefined : engineEvidenceOf(row)
        expect(evidence).toEqual({ state: 'owed', reason: CONTROLLER_BOUNDARY_RESIDUAL })
      }
    }
  })
})

describe('the filesystem, role and content-containment rows record Engine evidence, owed shrink-only', () => {
  const owedList = JSON.parse(readFileSync(join(import.meta.dir, 'engine-evidence-owed.json'), 'utf8')) as {
    owed: string[]
  }
  const rows = CONTAINMENT_ROW_IDS.map((id) => {
    const row = shard.components.find((component) => component.id === id)
    if (row === undefined) throw new Error(`${id} is not a row of the fault-attack shard`)
    return { id, row }
  })
  /** The most rows still owed. Lower it as a row's probe-run output is pasted; never raise it. */
  const owedCeiling = 9
  /** The parallel-login row leaves the owed list only with the output of the `[principal]` run of two parallel Engine runs. */
  const PRINCIPAL_RUN_ROW = 'fault-attack:32-parallel-runs-invalidating-each-other-s-copied-login'

  const unrecorded = (candidates: readonly { id: string; row: LoadedRow }[]): string[] =>
    candidates
      .filter(({ row }) => {
        const state = engineEvidenceOf(row)
        return state === undefined || (state.state === 'owed' && state.reason.startsWith('No test that names'))
      })
      .map(({ id }) => id)

  it('lists every row and fails while any has no recorded Engine evidence, printing the owed count', () => {
    const owed = CONTAINMENT_ROW_IDS.filter((id) => owedList.owed.includes(id))
    process.stdout.write(`containment Engine evidence: ${owed.length} of ${rows.length} rows owed\n`)
    expect(unrecorded(rows)).toEqual([])
    expect(owed.length).toBeLessThanOrEqual(owedCeiling)
  })

  it('names itself when a row has no recorded Engine evidence', () => {
    const [first, ...rest] = rows
    if (first === undefined) throw new Error('the list names no row')
    const bare = {
      id: first.id,
      row: {
        ...first.row,
        backendEvidence: {
          ...first.row.backendEvidence,
          engine: { owed: "No test that names this row's full id proves it on the Engine backend yet." }
        }
      }
    }
    expect(unrecorded([bare, ...rest])).toEqual([first.id])
  })

  it('lets a row leave the owed list only once its live probe run is recorded, and the parallel-login row only with the principal run', () => {
    for (const { id, row } of rows) {
      const state = engineEvidenceOf(row)
      const listed = owedList.owed.includes(id)
      // Listed while its entry is a live-gated test without the pull request that carries the pasted output, or an owed reason.
      if (state?.state === 'live-run-owed' || state?.state === 'owed')
        expect({ id, listed }).toEqual({ id, listed: true })
      if (state?.state === 'evidenced') expect({ id, listed }).toEqual({ id, listed: false })
    }
    // The pasted principal run is recorded on the row as its live probe pull request, like any other row's.
    const parallel = rows.find(({ id }) => id === PRINCIPAL_RUN_ROW)
    expect(parallel === undefined ? undefined : engineEvidenceOf(parallel.row)?.state).toBe('live-run-owed')
  })

  it('probes, for every shell-driven row, both adapters, and keeps each Must-pass row’s declared outcome', () => {
    const mustPass = (id: string) =>
      rawShard.components.find((raw) => raw.id === id)?.faultAttack.cutover === 'must-pass'
    for (const probe of CONTAINMENT_PROBES) {
      expect(Object.keys(probe.byAdapter).sort()).toEqual(['claude', 'codex'])
      if (mustPass(probe.row)) {
        // A Must-pass row is denied or refused under both adapters; it admits no residual or owed outcome.
        expect({ row: probe.row, outcomes: Object.values(probe.byAdapter).filter((o) => o === 'residual') }).toEqual({
          row: probe.row,
          outcomes: []
        })
      }
    }
  })

  it('measures the non-secret egress row and records its mitigation or its residual risk, or fails', () => {
    const id = 'fault-attack:57-non-secret-data-leaving-through-an-allowed-host-excludes'
    const row = rows.find((entry) => entry.id === id)?.row
    const probe = CONTAINMENT_PROBES.find((entry) => entry.row === id)
    if (row === undefined || probe === undefined) throw new Error('the egress row has no row or probe')
    const mitigated = Object.values(probe.byAdapter).every((outcome) => outcome === 'deny')
    const state = engineEvidenceOf(row)
    const namesResidual = state?.state === 'owed' && state.reason === NON_SECRET_EGRESS_RESIDUAL
    expect(mitigated || namesResidual).toBe(true)
    // A row with neither fails: an owed entry that names no residual risk is neither.
    const neither = { ...row, backendEvidence: { ...row.backendEvidence, engine: { owed: 'No proof yet.' } } }
    const stateOfNeither = engineEvidenceOf(neither)
    expect(
      mitigated || (stateOfNeither?.state === 'owed' && stateOfNeither.reason === NON_SECRET_EGRESS_RESIDUAL)
    ).toBe(false)
    expect(rawShard.components.find((raw) => raw.id === id)?.faultAttack.cutover).toBe('pass-or-accepted')
  })
})

/** The run-control and governed-effects rows the Engine runner's fault-injection scenarios prove, under both vendors. */
const ENGINE_FAULT_INJECTION_ROWS = [
  'fault-attack:03-controller-process-death',
  'fault-attack:07-provider-rate-or-usage-limit',
  'fault-attack:08-version-incompatibility-on-resume',
  'fault-attack:09-checkpoint-corruption',
  'fault-attack:10-cancellation-races',
  'fault-attack:12-forge-latency',
  'fault-attack:13-duplicate-delivery',
  'fault-attack:14-remote-success-local-acknowledgement-lost',
  'fault-attack:19-forged-or-stale-beyond-surface-record'
] as const
const ENGINE_FAULT_INJECTION_PROOF = 'processes/vinaya/tests/fault-injection.test.ts'
/** The rows above still owing their Engine evidence. Remove a row when its proof lands; never add one. */
const ENGINE_FAULT_INJECTION_OWED: readonly string[] = []
/** The most rows the list above may hold. Lower it with the list; never raise it. */
const ENGINE_FAULT_INJECTION_OWED_CEILING = 0

/** The rows, of those given, whose Engine evidence is not a recorded proof. */
const owedEngineRows = (rows: readonly { id: string; row: LoadedRow }[]): string[] =>
  rows.filter(({ row }) => engineEvidenceOf(row)?.state !== 'evidenced').map(({ id }) => id)

describe('the Engine fault-injection rows', () => {
  const rows = ENGINE_FAULT_INJECTION_ROWS.map((id) => {
    const row = shard.components.find((component) => component.id === id)
    if (row === undefined) throw new Error(`${id} is not a row of the fault-attack shard`)
    return { id, row }
  })

  it('each records its Engine evidence, and the rows still owed shrink only; prints the count owed', () => {
    const owed = owedEngineRows(rows)
    process.stdout.write(
      `Engine fault-injection rows: ${rows.length}; owed Engine evidence: ${owed.length} (ceiling ${ENGINE_FAULT_INJECTION_OWED_CEILING})\n`
    )
    expect(owed).toEqual([...ENGINE_FAULT_INJECTION_OWED])
    expect(ENGINE_FAULT_INJECTION_OWED.length).toBeLessThanOrEqual(ENGINE_FAULT_INJECTION_OWED_CEILING)
    for (const { id, row } of rows) {
      if (ENGINE_FAULT_INJECTION_OWED.includes(id)) continue
      expect({ id, evidence: engineEvidenceOf(row) }).toEqual({
        id,
        evidence: { state: 'evidenced', test: ENGINE_FAULT_INJECTION_PROOF }
      })
    }
  })

  it('fails while any of them has no recorded Engine evidence', () => {
    const [first, ...rest] = rows
    if (first === undefined) throw new Error('the list names no row')
    const unproved = {
      id: first.id,
      row: { ...first.row, backendEvidence: { ...first.row.backendEvidence, engine: { owed: 'No proof yet.' } } }
    }
    expect(owedEngineRows([unproved, ...rest])).toEqual([first.id])
    expect(owedEngineRows([unproved, ...rest])).not.toEqual([...ENGINE_FAULT_INJECTION_OWED])
  })

  it('are must-pass rows the Operator project does not own; its consumed-ruling and human-wait rows stay excluded', () => {
    for (const { id } of rows) {
      expect({
        id,
        cutover: rawShard.components.find((raw) => raw.id === id)?.faultAttack.cutover,
        excluded: EXCLUDED.has(id.slice('fault-attack:'.length))
      }).toEqual({ id, cutover: 'must-pass', excluded: false })
    }
    expect(EXCLUDED.has('11-consumed-or-stale-ruling-replayed')).toBe(true)
    expect(EXCLUDED.has('51-human-wait-principal-ruling-pause')).toBe(true)
  })
})
