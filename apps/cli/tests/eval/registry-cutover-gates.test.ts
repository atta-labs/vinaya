// The cutover-gate shard is complete: the gate universe is parsed from the
// cutover-gate coverage table of the repository mirror of the evaluation
// program, never listed here, and every gate has exactly one valid row, in
// number order, naming the evidence the table names. It claims nothing about
// any other kind.
import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type ComponentKind,
  checkShardCompleteness,
  loadRegistry,
  type ModuleCatalog
} from '../../src/lib/dev-review-eval/registry'
import { type CoverageGate, checkGateRows, gateUniverse, readCoverageTable } from './registry/cutover-gates-universe'

const CLI = join(import.meta.dir, '../..')
const REGISTRY_DIR = join(import.meta.dir, 'registry')
const MIRROR = join(CLI, 'specs/dev-review-evaluation-program.md')
const SHARD_LOCATION = 'shards/cutover-gates.json'

const gates: CoverageGate[] = readCoverageTable(MIRROR)
const UNIVERSES: Partial<Record<ComponentKind, readonly string[]>> = { gate: gateUniverse(gates) }
const provenance = JSON.parse(
  readFileSync(join(CLI, 'specs/dev-review-evaluation-program.provenance.json'), 'utf8')
) as {
  revision: number
}

const loaded = loadRegistry(join(REGISTRY_DIR, 'modules.json'), join(REGISTRY_DIR, 'shards'))
if (!loaded.ok) throw new Error(`registry refused: ${JSON.stringify(loaded.refusal)}`)
const catalog: ModuleCatalog = loaded.value.catalog
const rawShard = JSON.parse(readFileSync(join(REGISTRY_DIR, SHARD_LOCATION), 'utf8')) as {
  kinds: string[]
  components: Record<string, unknown>[]
}
const shard = loaded.value.shards.find((s) => s.shard === 'cutover-gates')
if (shard === undefined) throw new Error('the cutover-gates shard was not found by listing the shard directory')

const clone = <T>(value: T): T => structuredClone(value)
const check = (content: unknown, universes = UNIVERSES) => {
  const result = checkShardCompleteness(content, catalog, universes, SHARD_LOCATION)
  if (!result.ok) throw new Error(JSON.stringify(result.refusal))
  return result.value
}
const rowOf = (content: typeof rawShard, n: number) =>
  content.components.find((row) => row.id === `gate:${n}`) as Record<string, unknown>

describe('the cutover-gate universe', () => {
  it('is the seventeen gates of the mirror table, in number order', () => {
    expect(gates.map((g) => g.number)).toEqual(Array.from({ length: 17 }, (_, i) => i + 1))
    expect(gates.every((g) => g.evidence.length > 0)).toBe(true)
  })
})

describe('the cutover-gates shard', () => {
  it('declares only the gate kind', () => {
    expect(shard.kinds).toEqual(['gate'])
  })

  it('is complete against the gate universe parsed from the mirror', () => {
    const report = check(rawShard)
    expect(report.missing).toEqual([])
    expect(report.extra).toEqual([])
    expect(report.invalid).toEqual([])
    expect(report.complete).toBe(true)
    expect(shard.components.length).toBe(gates.length)
    expect(checkGateRows(rawShard.components, gates)).toEqual([])
  })

  it('pins every row to the mirror at its revision and to the Engine specification', () => {
    const mirrorHeader = readFileSync(MIRROR, 'utf8').match(/^\*\*Revision:\*\* (\d+)/m)
    expect(Number(mirrorHeader?.[1])).toBe(provenance.revision)
    for (const row of rawShard.components) {
      const source = row.source as { document: string; revision: number; section: string }
      const engine = row.engineSource as { document: string; revision: number; section: string }
      expect(source.document).toBe('apps/cli/specs/dev-review-evaluation-program.md')
      expect(source.revision).toBe(provenance.revision)
      expect(source.section).toBe('12. Cutover gate coverage')
      expect(engine.revision).toBe(17)
      for (const cited of [source, engine]) {
        const document = join(CLI, '..', '..', cited.document)
        expect(existsSync(document)).toBe(true)
        const headings = readFileSync(document, 'utf8')
          .split('\n')
          .filter((line) => line.startsWith('#'))
          .map((line) => line.replace(/^#+ /, ''))
        expect({ id: row.id, section: headings.includes(cited.section) }).toEqual({ id: row.id, section: true })
      }
    }
  })

  it('states for gates 14 and 15 that no known-failure entry is admitted, and for gate 17 that the decision stays the Principal’s', () => {
    for (const n of [14, 15]) {
      expect(String(rowOf(rawShard, n).contract)).toContain('no known-failure entry is admitted')
      expect(String(rowOf(rawShard, n).decisionRule)).toContain('no known-failure entry is admitted')
    }
    expect(String(rowOf(rawShard, 17).contract)).toContain("The decision itself stays the Principal's")
    expect(String(rowOf(rawShard, 17).contract)).toContain('cutover authorization suite')
  })

  it('aggregates with the other shards without a duplicate id, and claims no other kind', () => {
    const ids = loaded.value.components.map((c) => c.row.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(loaded.value.shards.length).toBeGreaterThan(1)
    expect(shard.components.every((row) => row.kind === 'gate')).toBe(true)
    const report = check(rawShard, { ...UNIVERSES, role: ['developer', 'code-reviewer'] })
    expect(report.kinds).not.toContain('role')
    expect(report.complete).toBe(true)
  })
})

describe('the shard checks fail on what they must', () => {
  it('reports a missing gate', () => {
    const content = clone(rawShard)
    content.components.splice(4, 1)
    const report = check(content)
    expect(report.complete).toBe(false)
    expect(report.missing).toEqual([{ kind: 'gate', name: '5' }])
  })

  it('reports an extra gate', () => {
    const content = clone(rawShard)
    const extra = clone(rowOf(content, 1))
    extra.id = 'gate:18'
    content.components.push(extra)
    const report = check(content)
    expect(report.complete).toBe(false)
    expect(report.extra).toEqual([{ kind: 'gate', name: '18' }])
  })

  it('reports rows out of number order', () => {
    const content = clone(rawShard)
    const [first] = content.components.splice(0, 1)
    content.components.splice(3, 0, first as Record<string, unknown>)
    expect(checkGateRows(content.components, gates).join('\n')).toContain('not in ascending gate-number order')
  })

  it('reports a gate naming different evidence from the table', () => {
    const content = clone(rawShard)
    rowOf(content, 6).evidence = '§6.7'
    expect(checkGateRows(content.components, gates).join('\n')).toContain('gate 6 names evidence')
  })

  it('reports an empty or placeholder field', () => {
    const content = clone(rawShard)
    rowOf(content, 2).decisionRule = ''
    rowOf(content, 3).migrationGate = 'TBD'
    rowOf(content, 4).evidence = ' '
    const report = check(content)
    expect(report.complete).toBe(false)
    expect(report.invalid.map((r) => [r.code, r.path])).toEqual([
      ['empty', `${SHARD_LOCATION}#components[1].decisionRule`],
      ['placeholder', `${SHARD_LOCATION}#components[2].migrationGate`]
    ])
    expect(checkGateRows(content.components, gates).join('\n')).toContain('gate 4 has an empty evidence')
  })

  it('reports gates 14, 15 or 17 missing their statement', () => {
    const content = clone(rawShard)
    rowOf(content, 14).contract = 'Worktree code cannot reach forge credentials.'
    rowOf(content, 15).decisionRule = 'Deterministic: 100%.'
    rowOf(content, 17).contract = 'Principal approval.'
    const problems = checkGateRows(content.components, gates)
    expect(problems.some((p) => p.startsWith('gate 14 does not state'))).toBe(true)
    expect(problems.some((p) => p.startsWith('gate 15 does not state'))).toBe(true)
    expect(problems.some((p) => p.startsWith('gate 17 does not state'))).toBe(true)
  })
})
