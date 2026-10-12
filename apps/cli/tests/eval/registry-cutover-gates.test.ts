// The cutover-gate shard is complete: every gate of the evaluation program's
// cutover-gate coverage table, parsed from the repository mirror, has exactly
// one valid row, in number order, naming the table's evidence, its source in
// the evaluation program and in the Engine specification, and the statements
// gates 14, 15 and 17 require. It aggregates with the other shards and claims
// nothing about any other kind.
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type ComponentKind,
  checkShardCompleteness,
  loadRegistry,
  type ModuleCatalog
} from '../../src/lib/dev-review-eval/registry'
import {
  type CutoverGateEntry,
  CUTOVER_GATES_HEADING,
  ENGINE_SPEC,
  NO_KNOWN_FAILURE_STATEMENT,
  PRINCIPAL_DECISION_STATEMENT,
  PROGRAM_DOCUMENT,
  parseCutoverGateTable,
  readCutoverGateUniverse
} from './registry/cutover-gates-universe'

const REGISTRY_DIR = join(import.meta.dir, 'registry')
const SHARD_FILE = join(REGISTRY_DIR, 'shards/cutover-gates.json')
const LOCATION = 'shards/cutover-gates.json'
const PROVENANCE = JSON.parse(
  readFileSync(join(import.meta.dir, '../../specs/dev-review-evaluation-program.provenance.json'), 'utf8')
) as { revision: number }

const UNIVERSE = readCutoverGateUniverse()

const loaded = loadRegistry(join(REGISTRY_DIR, 'modules.json'), join(REGISTRY_DIR, 'shards'))
if (!loaded.ok) throw new Error(`registry refused: ${JSON.stringify(loaded.refusal)}`)
const catalog: ModuleCatalog = loaded.value.catalog
const shard = loaded.value.shards.find((s) => s.shard === 'cutover-gates')
if (shard === undefined) throw new Error('the cutover-gates shard was not found by listing the shard directory')

type RawRow = Record<string, unknown> & {
  id: string
  module: string
  contract: string
  decisionRule: string
  cutoverGate: Record<string, unknown>
}
const rawShard = JSON.parse(readFileSync(SHARD_FILE, 'utf8')) as { kinds: string[]; components: RawRow[] }

/** One way the shard departs from the table. */
interface Mismatch {
  name: string
  column: 'order' | 'gate' | 'evidence' | 'module' | 'engine-spec' | 'statement'
  detail: string
}

/**
 * Compares the rows, in file order, with the table: the order, each gate's
 * number, title and evidence, its owning module, its Engine specification
 * source, and the statements gates 14, 15 and 17 require. Missing, extra and
 * invalid rows are the registry's completeness check.
 */
function compareWithTable(rows: readonly RawRow[], universe: readonly CutoverGateEntry[]): Mismatch[] {
  const byName = new Map(universe.map((entry) => [entry.name, entry]))
  const out: Mismatch[] = []
  const numbers = rows.map((row) => Number((row.cutoverGate ?? {}).number))
  if (numbers.some((n, i) => i > 0 && n <= (numbers[i - 1] as number))) {
    out.push({ name: 'shard', column: 'order', detail: JSON.stringify(numbers) })
  }
  for (const row of rows) {
    const name = String(row.id).slice('cutover-gate:'.length)
    const entry = byName.get(name)
    if (entry === undefined) continue
    const gate = (row.cutoverGate ?? {}) as Record<string, unknown>
    const differ = (column: Mismatch['column'], detail: string) => out.push({ name, column, detail })
    if (gate.number !== entry.number || gate.title !== entry.title) differ('gate', `${gate.number} ${gate.title}`)
    if (gate.evidence !== entry.evidence || !String(row.contract).includes(entry.evidence)) {
      differ('evidence', String(gate.evidence))
    }
    const [owner, ...rest] = entry.modules
    if (
      row.module !== owner ||
      JSON.stringify(gate.modules) !== JSON.stringify(entry.modules) ||
      JSON.stringify(gate.layers) !== JSON.stringify(entry.layers) ||
      rest.some((id) => !String(row.contract).includes(`module ${id} (`))
    ) {
      differ('module', `module ${row.module}, table ${JSON.stringify(gate.modules)}`)
    }
    if (JSON.stringify(gate.engineSpec) !== JSON.stringify(engineSpec())) {
      differ('engine-spec', JSON.stringify(gate.engineSpec))
    }
    const statement =
      entry.number === 14 || entry.number === 15
        ? NO_KNOWN_FAILURE_STATEMENT
        : entry.number === 17
          ? PRINCIPAL_DECISION_STATEMENT
          : undefined
    if (statement !== undefined && !String(row.decisionRule).includes(statement)) {
      differ('statement', `missing: ${statement}`)
    }
  }
  return out
}

const engineSpec = () => ({
  document: ENGINE_SPEC.document,
  revision: ENGINE_SPEC.revision,
  section: ENGINE_SPEC.section
})
const clone = <T>(value: T): T => structuredClone(value)
const universes = { 'cutover-gate': UNIVERSE.map((entry) => entry.name) }
const check = (content: unknown, kinds: Partial<Record<ComponentKind, readonly string[]>> = universes) => {
  const result = checkShardCompleteness(content, catalog, kinds, LOCATION)
  if (!result.ok) throw new Error(JSON.stringify(result.refusal))
  return result.value
}

describe('the cutover-gate universe parsed from the mirror', () => {
  it('holds the seventeen gates of the table, in number order, each with a unique name', () => {
    expect(UNIVERSE.length).toBe(17)
    expect(UNIVERSE.map((entry) => entry.number)).toEqual(UNIVERSE.map((_, index) => index + 1))
    expect(new Set(UNIVERSE.map((entry) => entry.name)).size).toBe(17)
  })

  it('reads the module and layers the evidence names', () => {
    const gate = (n: number) => UNIVERSE.find((entry) => entry.number === n) as CutoverGateEntry
    expect(gate(4).modules).toEqual(['6.3', '6.4', '6.8', '6.21', '6.22'])
    expect(gate(7).modules).toEqual(['6.13', '6.14'])
    expect(gate(9).layers).toEqual(['L8'])
    expect(gate(17).modules).toEqual(['6.24'])
  })

  it('follows the table, not a list: a reworded gate changes the universe', () => {
    const program = readFileSync(join(import.meta.dir, '../../specs/dev-review-evaluation-program.md'), 'utf8')
    const reworded = parseCutoverGateTable(program.replace('| 5 Controller-owned source evidence |', '| 5 Source |'))
    expect(reworded[4]?.title).toBe('Source')
    expect(reworded.length).toBe(17)
  })
})

describe('the cutover-gates shard', () => {
  it('declares only the cutover-gate kind', () => {
    expect(shard.kinds).toEqual(['cutover-gate'])
  })

  it('is complete against the universe parsed from the mirror', () => {
    const report = check(rawShard)
    const mismatches = compareWithTable(rawShard.components, UNIVERSE)
    console.log(
      `cutover-gates shard: ${shard.components.length} rows; missing ${report.missing.length}, extra ${report.extra.length}, invalid ${report.invalid.length}, differing ${mismatches.length}`
    )
    expect(report.missing).toEqual([])
    expect(report.extra).toEqual([])
    expect(report.invalid).toEqual([])
    expect(report.complete).toBe(true)
    expect(mismatches).toEqual([])
    expect(shard.components.length).toBe(17)
  })

  it('cites, on each row, the cutover-gate heading of the mirror at its pinned revision', () => {
    for (const row of shard.components) {
      expect(row.source).toEqual({
        document: PROGRAM_DOCUMENT,
        revision: PROVENANCE.revision,
        section: CUTOVER_GATES_HEADING
      })
    }
  })

  it('cites, on each row, Engine specification section 16.18 at the revision its mirror states', () => {
    const mirror = readFileSync(join(import.meta.dir, '../../../..', ENGINE_SPEC.document), 'utf8')
    expect(mirror).toContain(`revision ${ENGINE_SPEC.revision}`)
    for (const row of rawShard.components) expect(row.cutoverGate.engineSpec).toEqual(engineSpec())
  })

  it('states, on gates 14 and 15, that no known-failure entry is admitted, and on gate 17 that the decision stays the Principal’s', () => {
    const rule = (n: number) => rawShard.components.find((row) => row.id === `cutover-gate:gate-${n}`)?.decisionRule
    expect(rule(14)).toContain(NO_KNOWN_FAILURE_STATEMENT)
    expect(rule(15)).toContain(NO_KNOWN_FAILURE_STATEMENT)
    expect(rule(17)).toContain(PRINCIPAL_DECISION_STATEMENT)
    expect(rule(17)).toContain('cutover authorization suite')
  })

  it('aggregates with every other shard without a duplicate component id', () => {
    const ids = loaded.value.components.map((entry) => entry.row.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(
      loaded.value.components.filter((entry) => entry.location.startsWith('shards/cutover-gates.json#'))
    ).toHaveLength(17)
  })
})

describe('the cutover-gate check fails on what it must', () => {
  it('reports a missing gate', () => {
    const content = clone(rawShard)
    content.components.splice(4, 1)
    expect(check(content).missing).toEqual([{ kind: 'cutover-gate', name: 'gate-5' }])
  })

  it('reports an extra gate, and a repeated one', () => {
    const content = clone(rawShard)
    const extra = clone(content.components[0] as RawRow)
    extra.id = 'cutover-gate:gate-18'
    content.components.push(extra, clone(content.components[1] as RawRow))
    const report = check(content)
    expect(report.complete).toBe(false)
    expect(report.extra).toEqual([
      { kind: 'cutover-gate', name: 'gate-18' },
      { kind: 'cutover-gate', name: 'gate-2' }
    ])
  })

  it('reports gates out of number order', () => {
    const content = clone(rawShard)
    const [first, second] = content.components.splice(0, 2) as [RawRow, RawRow]
    content.components.splice(1, 0, second, first)
    expect(compareWithTable(content.components, UNIVERSE).map((m) => m.column)).toEqual(['order'])
  })

  it('reports a row with an empty field', () => {
    const content = clone(rawShard)
    ;(content.components[6] as RawRow).contract = ''
    expect(check(content).invalid.map((r) => [r.code, r.path])).toEqual([
      ['empty', `${LOCATION}#components[6].contract`]
    ])
  })

  it('reports a row naming different evidence from the table, or another module', () => {
    const content = clone(rawShard)
    content.components[0]!.cutoverGate.evidence = '§6.17 unit suite'
    content.components[1]!.cutoverGate.title = 'Invariant map'
    content.components[3]!.module = '6.4'
    expect(compareWithTable(content.components, UNIVERSE).map((m) => [m.name, m.column])).toEqual([
      ['gate-1', 'evidence'],
      ['gate-2', 'gate'],
      ['gate-4', 'module']
    ])
  })

  it('reports a row citing another Engine specification section', () => {
    const content = clone(rawShard)
    content.components[2]!.cutoverGate.engineSpec = { ...engineSpec(), section: '16.17' }
    expect(compareWithTable(content.components, UNIVERSE).map((m) => [m.name, m.column])).toEqual([
      ['gate-3', 'engine-spec']
    ])
  })

  it('reports gates 14 and 15 admitting a known failure, and gate 17 without the Principal’s decision', () => {
    const content = clone(rawShard)
    const row = (n: number) => content.components.find((r) => r.id === `cutover-gate:gate-${n}`) as RawRow
    row(14).decisionRule = 'Must pass: every §6.15 case green.'
    row(15).decisionRule = 'Must pass, or a known-failure entry.'
    row(17).decisionRule = 'Satisfied when the cutover authorization suite passes.'
    expect(compareWithTable(content.components, UNIVERSE).map((m) => [m.name, m.column])).toEqual([
      ['gate-14', 'statement'],
      ['gate-15', 'statement'],
      ['gate-17', 'statement']
    ])
  })

  it('claims nothing about a kind the shard does not declare', () => {
    const report = check(rawShard, { ...universes, 'fault-attack': ['01-x'], role: ['developer'] })
    expect(report.kinds).toEqual(['cutover-gate'])
    expect(report.complete).toBe(true)
  })
})
