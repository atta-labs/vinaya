// The evaluation foundation's global exit check passes on the real registry —
// every kind, every shard, seventeen cutover gates, fifty-eight fault-and-attack
// rows, every catalog module named, zero empty fields, zero unmapped — and
// fails, naming its cause, for each planted gap on a copy of the real data.
// It reports the Engine evidence each kind has and owes without failing on
// owed proof, and reports the Operator-owned rows apart. No shard file is
// edited; the check is not imported by the CLI.
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  checkExit,
  EXPECTED_COUNTS,
  EXPECTED_SHARDS,
  OPERATOR_EXIT_EXCLUSIONS,
  type ExitCauseCode,
  type ExitInput
} from '../../src/lib/dev-review-eval/exit-check'
import { COMPONENT_KINDS, type ComponentKind, loadRegistry } from '../../src/lib/dev-review-eval/registry'
import {
  ENGINE_STATES,
  ENGINE_TRANSITIONS,
  NODE_CONTRACTS
} from '../lib/dev-review-loop/dev-review-engine-state-contract.fixture'
import { deriveContractUniverses, readContractSources, universeNames } from './registry/contract-kinds-universe'
import { readCutoverGateUniverse } from './registry/cutover-gates-universe'
import { readFaultAttackUniverse } from './registry/fault-attack-universe'

const CLI = join(import.meta.dir, '../..')
const REGISTRY_DIR = join(import.meta.dir, 'registry')

const loaded = loadRegistry(join(REGISTRY_DIR, 'modules.json'), join(REGISTRY_DIR, 'shards'))
if (!loaded.ok) throw new Error(`registry refused: ${JSON.stringify(loaded.refusal)}`)
const registry = loaded.value

/** Universes assembled from each shard's own typed sources — never listed here. */
const matrix = JSON.parse(
  readFileSync(join(CLI, 'tests/fixtures/dev-review-engine-capability-matrix.json'), 'utf8')
) as { ports: string[] }
const invariants = JSON.parse(
  readFileSync(join(CLI, 'tests/fixtures/dev-review-architecture-invariants.json'), 'utf8')
) as { invariants: { id: string; classification: string; scope: string }[] }
const gates = readCutoverGateUniverse()
const faults = readFaultAttackUniverse()
const universes: Partial<Record<ComponentKind, readonly string[]>> = {
  port: matrix.ports,
  node: [...new Set([...ENGINE_STATES.map((s) => s.id), ...NODE_CONTRACTS.map((n) => n.id)])],
  transition: ENGINE_TRANSITIONS.map((t) => t.id),
  'product-guarantee': invariants.invariants
    .filter((e) => e.classification === 'product-guarantee' && e.scope === 'product')
    .map((e) => e.id),
  ...universeNames(deriveContractUniverses(readContractSources())),
  'cutover-gate': gates.map((g) => g.name),
  'fault-attack': faults.map((f) => f.name)
}
const mirrorCounts: Partial<Record<ComponentKind, number>> = {
  'cutover-gate': gates.length,
  'fault-attack': faults.length
}

const mirrorMatchedComponents = registry.components.flatMap(({ row }) => {
  if (row.kind === 'cutover-gate') {
    const mirror = gates.find((entry) => entry.name === row.id.slice('cutover-gate:'.length))
    const actual = (row as unknown as { cutoverGate?: (typeof gates)[number] }).cutoverGate
    if (
      mirror !== undefined &&
      actual !== undefined &&
      JSON.stringify({
        number: actual.number,
        title: actual.title,
        evidence: actual.evidence,
        modules: actual.modules,
        layers: actual.layers
      }) ===
        JSON.stringify({
          number: mirror.number,
          title: mirror.title,
          evidence: mirror.evidence,
          modules: mirror.modules,
          layers: mirror.layers
        })
    )
      return [row.id]
  }
  if (row.kind === 'fault-attack') {
    const mirror = faults.find((entry) => entry.name === row.id.slice('fault-attack:'.length))
    const actual = (row as unknown as { faultAttack?: Omit<(typeof faults)[number], 'name'> }).faultAttack
    if (
      mirror !== undefined &&
      actual !== undefined &&
      JSON.stringify(actual) ===
        JSON.stringify({
          order: mirror.order,
          title: mirror.title,
          modules: mirror.modules,
          layerCell: mirror.layerCell,
          layers: mirror.layers,
          expectedOutcome: mirror.expectedOutcome,
          cutover: mirror.cutover
        })
    )
      return [row.id]
  }
  return []
})

const real = (): ExitInput => ({
  ...structuredClone({ catalog: registry.catalog, shards: registry.shards, components: registry.components }),
  universes: structuredClone(universes),
  mirrorCounts: { ...mirrorCounts },
  mirrorMatchedComponents: [...mirrorMatchedComponents]
})

const causesOf = (input: ExitInput): ExitCauseCode[] => [...new Set(checkExit(input).causes.map((c) => c.code))]

describe('the global exit check', () => {
  it('passes on the real registry with zero uncovered components in every kind', () => {
    const report = checkExit(real())
    expect(report.causes).toEqual([])
    expect(report.pass).toBe(true)
    expect(report.emptyFields).toBe(0)
    expect(report.unmapped).toBe(0)
    for (const kind of COMPONENT_KINDS) {
      const excluded = OPERATOR_EXIT_EXCLUSIONS.filter((entry) => entry.kind === kind).length
      expect({ kind, covered: report.kinds[kind].covered }).toEqual({
        kind,
        covered: (universes[kind]?.length ?? -1) - excluded
      })
      expect(report.kinds[kind].covered).toBeGreaterThan(0)
    }
    expect(report.kinds['cutover-gate'].covered).toBe(16)
    expect(report.kinds['fault-attack'].covered).toBe(56)
    expect(registry.shards.map((s) => s.shard).sort()).toEqual([...EXPECTED_SHARDS].sort())
    console.log(
      COMPONENT_KINDS.map((k) => `${k}: ${report.kinds[k].covered}`).join(', '),
      `| empty fields ${report.emptyFields}, unmapped ${report.unmapped}`
    )
  })

  it('reads the kind set from the registry, so the exit names every kind', () => {
    expect(Object.keys(checkExit(real()).kinds)).toEqual([...COMPONENT_KINDS])
    expect(COMPONENT_KINDS).toHaveLength(12)
  })

  it('fails when a shard is absent', () => {
    const input = real()
    input.shards = input.shards.filter((s) => s.shard !== 'fault-attack')
    input.components = input.components.filter((c) => c.row.kind !== 'fault-attack')
    const report = checkExit(input)
    expect(report.pass).toBe(false)
    expect(report.causes.find((c) => c.code === 'shard_absent')?.detail).toContain('fault-attack')
  })

  it('fails when a kind is missing', () => {
    const input = real()
    input.components = input.components.filter((c) => c.row.kind !== 'effect')
    const report = checkExit(input)
    expect(report.pass).toBe(false)
    expect(report.causes.find((c) => c.code === 'kind_missing')?.detail).toContain('effect')
  })

  it('fails when a duplicate id appears', () => {
    const input = real()
    const first = input.components[0] as ExitInput['components'][number]
    input.components = [...input.components, { location: 'planted#components[0]', row: structuredClone(first.row) }]
    const report = checkExit(input)
    expect(report.pass).toBe(false)
    const cause = report.causes.find((c) => c.code === 'duplicate_id')
    expect(cause?.detail).toContain(first.row.id)
    expect(cause?.detail).toContain('planted#components[0]')
  })

  it('fails when a field is empty, a placeholder, or a list is empty', () => {
    for (const mutate of [
      (r: Record<string, unknown>) => (r.contract = ''),
      (r: Record<string, unknown>) => (r.decisionRule = 'TBD'),
      (r: Record<string, unknown>) => (r.suite = []),
      (r: Record<string, unknown>) => (r.tasks = { ...(r.tasks as object), recovery: { present: ' ' } }),
      (r: Record<string, unknown>) => (r.grader = { kinds: [], detail: 'x' })
    ]) {
      const input = real()
      mutate((input.components[0] as ExitInput['components'][number]).row as unknown as Record<string, unknown>)
      const report = checkExit(input)
      expect(report.pass).toBe(false)
      expect(report.emptyFields).toBe(1)
      expect(causesOf(input)).toEqual(['empty_field'])
    }
  })

  it('fails when a component names no module', () => {
    const input = real()
    ;(input.components[0] as ExitInput['components'][number]).row.module = '6.99'
    const report = checkExit(input)
    expect(report.pass).toBe(false)
    expect(report.unmapped).toBe(1)
    expect(causesOf(input)).toContain('no_module')
  })

  it('fails when a catalog module is named by no component', () => {
    const input = real()
    const target = input.components[0]?.row.module as string
    input.components = input.components.map((c) =>
      c.row.module === target
        ? {
            ...c,
            row: {
              ...c.row,
              module: input.catalog.modules.find((m) => m.id !== target && m.excluded === null)?.id as string
            }
          }
        : c
    )
    const report = checkExit(input)
    expect(report.pass).toBe(false)
    expect(report.causes.find((c) => c.code === 'module_unnamed')?.detail).toContain(target)
  })

  it('counts an additional module as named, and a system-scope module without any row', () => {
    const input = real()
    const system = input.catalog.modules.filter((m) => m.scope === 'system').map((m) => m.id)
    expect(system).toEqual(['6.18'])
    expect(input.components.some((c) => c.row.module === '6.18' || c.row.additionalModules?.includes('6.18'))).toBe(
      false
    )
    expect(input.components.some((c) => c.row.additionalModules?.includes('6.21'))).toBe(true)
    expect(input.components.some((c) => c.row.module === '6.21')).toBe(false)
  })

  it('fails when a module has neither a row nor the system scope, and keeps an excluded module excluded', () => {
    const noExtra = real()
    for (const c of noExtra.components) delete c.row.additionalModules
    expect(checkExit(noExtra).causes.find((c) => c.code === 'module_unnamed')?.detail).toContain('6.21')
    const noScope = real()
    for (const m of noScope.catalog.modules) delete m.scope
    expect(checkExit(noScope).causes.find((c) => c.code === 'module_unnamed')?.detail).toContain('6.18')
    const bad = real()
    ;(bad.components[0] as ExitInput['components'][number]).row.additionalModules = ['6.19']
    expect(causesOf(bad)).toEqual(['no_module'])
  })

  it('fails when a universe member has no row or a row names no member', () => {
    const missing = real()
    missing.universes.port = [...(universes.port as string[]), 'PlantedPort']
    expect(checkExit(missing).unmapped).toBe(1)
    expect(causesOf(missing)).toEqual(['universe_missing'])
    const extra = real()
    extra.universes.port = (universes.port as string[]).slice(1)
    expect(causesOf(extra)).toEqual(['universe_extra'])
  })

  it('fails when a count differs from the mirror’s tables', () => {
    expect(EXPECTED_COUNTS).toEqual({ 'cutover-gate': 16, 'fault-attack': 56 })
    const rows = real()
    rows.components = rows.components.filter((c) => c.row.id !== 'cutover-gate:gate-17')
    rows.universes['cutover-gate'] = (universes['cutover-gate'] as string[]).filter((name) => name !== 'gate-17')
    expect(causesOf(rows)).toContain('count_mismatch')
    expect(checkExit(rows).causes.some((c) => c.code === 'count_mismatch' && c.detail.includes('15 rows'))).toBe(true)
    const mirror = real()
    mirror.mirrorCounts['fault-attack'] = 95
    expect(causesOf(mirror)).toEqual(['count_mismatch'])
  })

  it('keeps the Operator-owned exclusion list shrink-only and fully attributed', () => {
    const ceiling = new Set([
      'check:program-6.23-supporting-pull-request-read',
      'module:6.14',
      'module:6.23',
      'cutover-gate:gate-11',
      'fault-attack:11-consumed-or-stale-ruling-replayed',
      'fault-attack:51-human-wait-principal-ruling-pause',
      ...faults.slice(58).map((entry) => `fault-attack:${entry.name}`)
    ])
    expect(ceiling.size).toBe(44)
    for (const entry of OPERATOR_EXIT_EXCLUSIONS) {
      expect(ceiling.has(`${entry.kind}:${entry.name}`)).toBe(true)
      expect(entry.owner).toBe('Operator on one host')
      expect(entry.reason).toContain('Operator on one host')
    }
  })

  it('reports, per kind, the rows proved on the Engine and the rows owing it, and passes while proof is owed', () => {
    const report = checkExit(real())
    expect(report.pass).toBe(true)
    const gates = report.kinds['cutover-gate'].engine
    const faultRows = report.kinds['fault-attack'].engine
    expect(gates).toEqual({
      evidenced: 1,
      owed: 15,
      owedIds: registry.components
        .map(({ row }) => row.id)
        .filter(
          (id) => id.startsWith('cutover-gate:') && id !== 'cutover-gate:gate-16' && id !== 'cutover-gate:gate-11'
        )
    })
    expect(faultRows?.evidenced).toBe(0)
    expect(faultRows?.owed).toBe(56)
    expect(faultRows?.owedIds).toHaveLength(56)
    expect(report.kinds.port.engine).toBeUndefined()
    console.log(
      `Engine evidence — cutover-gate: ${gates?.evidenced} evidenced, ${gates?.owed} owed; fault-attack: ${faultRows?.evidenced} evidenced, ${faultRows?.owed} owed; owed to the Operator on one host: ${report.operatorOwed.length}`
    )

    const allOwed = real()
    for (const { row } of allOwed.components) {
      if (row.backendEvidence?.engine !== undefined) row.backendEvidence.engine = { owed: 'planted' }
    }
    const planted = checkExit(allOwed)
    expect(planted.pass).toBe(true)
    expect(planted.kinds['cutover-gate'].engine?.owed).toBe(16)
  })

  it('reports the Operator-owned rows as owed to the Operator on one host, never as owed Engine evidence', () => {
    const report = checkExit(real())
    const componentExclusions = OPERATOR_EXIT_EXCLUSIONS.filter((entry) =>
      (COMPONENT_KINDS as readonly string[]).includes(entry.kind)
    ).map((entry) => `${entry.kind}:${entry.name}`)
    expect(report.operatorOwed).toEqual(componentExclusions)
    expect(report.operatorOwed).toHaveLength(41)
    const engineOwed = new Set(COMPONENT_KINDS.flatMap((kind) => report.kinds[kind].engine?.owedIds ?? []))
    for (const id of report.operatorOwed)
      expect({ id, engineOwed: engineOwed.has(id) }).toEqual({ id, engineOwed: false })
  })

  it('fails for a stale exclusion or one whose registry row now matches the mirror', () => {
    const stale = real()
    stale.exclusions = [
      ...OPERATOR_EXIT_EXCLUSIONS,
      {
        kind: 'fault-attack',
        name: 'not-in-the-mirror',
        owner: 'Operator on one host',
        reason: 'Owned by the Operator on one host project.'
      }
    ]
    expect(causesOf(stale)).toContain('exclusion_stale')

    const covered = real()
    covered.mirrorMatchedComponents = [...(covered.mirrorMatchedComponents ?? []), 'cutover-gate:gate-11']
    expect(causesOf(covered)).toContain('exclusion_covered')
  })
})
