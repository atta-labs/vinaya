// The fault-and-attack shard is complete: every row of the evaluation
// program's canonical fault-and-attack matrix, parsed from the repository
// mirror, has exactly one valid row carrying the table's suite, layers,
// expected typed outcome and cutover outcome, and the statement its cutover
// outcome requires. It aggregates with the other shards and claims nothing
// about any other kind.
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
import { OPERATOR_EXIT_EXCLUSIONS } from '../../src/lib/dev-review-eval/exit-check'
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
  faultAttack: Record<string, unknown>
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
    console.log(
      `fault-attack shard: ${shard.components.length} rows (${mustPass} must pass, ${ACTIVE_UNIVERSE.length - mustPass} pass or accepted); missing ${report.missing.length}, extra ${report.extra.length}, invalid ${report.invalid.length}, differing ${mismatches.length}`
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

  it('claims nothing about a kind the shard does not declare', () => {
    const report = check(rawShard, { ...universes, 'cutover-gate': ['gate-17'], role: ['developer'] })
    expect(report.kinds).toEqual(['fault-attack'])
    expect(report.complete).toBe(true)
  })
})
