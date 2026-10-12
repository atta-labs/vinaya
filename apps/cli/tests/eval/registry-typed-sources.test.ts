// The typed-sources shard is complete: for each kind it declares — ports,
// engine nodes, engine transitions, product guarantees — every member of the
// universe its typed source enumerates has exactly one valid row, and no row
// names anything else. It claims nothing about any other kind.
import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type ComponentKind,
  checkShardCompleteness,
  loadRegistry,
  type ModuleCatalog,
  type RegistryOwner
} from '../../src/lib/dev-review-eval/registry'
import {
  ENGINE_STATES,
  ENGINE_TRANSITIONS,
  NODE_CONTRACTS
} from '../lib/dev-review-loop/dev-review-engine-state-contract.fixture'

const CLI = join(import.meta.dir, '../..')
const REGISTRY_DIR = join(import.meta.dir, 'registry')
const SHARD_FILE = join(REGISTRY_DIR, 'shards/typed-sources.json')

const matrix = JSON.parse(
  readFileSync(join(CLI, 'tests/fixtures/dev-review-engine-capability-matrix.json'), 'utf8')
) as { ports: string[] }
const register = JSON.parse(
  readFileSync(join(CLI, 'tests/fixtures/dev-review-architecture-invariants.json'), 'utf8')
) as {
  normativeDesign: { revision: number }
  invariants: { id: string; classification: string; scope: string; owner: string }[]
}

/** Each kind's universe, derived from the typed source that enumerates it — never listed here. */
const productGuarantees = register.invariants.filter(
  (entry) => entry.classification === 'product-guarantee' && entry.scope === 'product'
)
const UNIVERSES: Record<'port' | 'node' | 'transition' | 'product-guarantee', readonly string[]> = {
  port: matrix.ports,
  node: [...new Set([...ENGINE_STATES.map((s) => s.id), ...NODE_CONTRACTS.map((n) => n.id)])],
  transition: ENGINE_TRANSITIONS.map((t) => t.id),
  'product-guarantee': productGuarantees.map((entry) => entry.id)
}

/**
 * The register's and the state model's owner vocabulary, read into the
 * program's: `log` and `operator-control` are Vinaya policy (the capability
 * matrix gives Vinaya Log production and Operator controls).
 */
const OWNER: Record<string, RegistryOwner> = {
  'vinaya-policy': 'vinaya-policy',
  'engine-runtime': 'engine',
  'provider-adapter': 'adapter',
  'governed-operation': 'governed-effect',
  log: 'vinaya-policy',
  'operator-control': 'vinaya-policy'
}

const loaded = loadRegistry(join(REGISTRY_DIR, 'modules.json'), join(REGISTRY_DIR, 'shards'))
if (!loaded.ok) throw new Error(`registry refused: ${JSON.stringify(loaded.refusal)}`)
const catalog: ModuleCatalog = loaded.value.catalog
const rawShard = JSON.parse(readFileSync(SHARD_FILE, 'utf8')) as {
  kinds: string[]
  components: Record<string, unknown>[]
}
const shard = loaded.value.shards.find((s) => s.shard === 'typed-sources')
if (shard === undefined) throw new Error('the typed-sources shard was not found by listing the shard directory')

const clone = <T>(value: T): T => structuredClone(value)
const check = (content: unknown, universes: Partial<Record<ComponentKind, readonly string[]>> = UNIVERSES) => {
  const result = checkShardCompleteness(content, catalog, universes, 'shards/typed-sources.json')
  if (!result.ok) throw new Error(JSON.stringify(result.refusal))
  return result.value
}

describe('the typed-sources shard', () => {
  it('declares exactly the kinds whose universe a typed source enumerates', () => {
    expect(shard.kinds).toEqual(['port', 'node', 'transition', 'product-guarantee'])
  })

  it('is complete against the universes derived from its typed sources', () => {
    const report = check(rawShard)
    const counts = shard.kinds.map((kind) => `${kind} ${shard.components.filter((c) => c.kind === kind).length}`)
    console.log(
      `typed-sources shard: ${counts.join(', ')}; missing ${report.missing.length}, extra ${report.extra.length}, invalid ${report.invalid.length}`
    )
    expect(report.missing).toEqual([])
    expect(report.extra).toEqual([])
    expect(report.invalid).toEqual([])
    expect(report.complete).toBe(true)
    for (const kind of shard.kinds) {
      expect(shard.components.filter((c) => c.kind === kind).length).toBe(
        (UNIVERSES as Record<string, readonly string[]>)[kind]?.length ?? -1
      )
    }
  })

  it('gives each row the owner its typed source records', () => {
    const nodeOwner = new Map(NODE_CONTRACTS.map((n) => [n.id, n.owner as string]))
    const guaranteeOwner = new Map(productGuarantees.map((entry) => [entry.id, entry.owner]))
    for (const row of shard.components) {
      const name = row.id.slice(row.kind.length + 1)
      const expected =
        row.kind === 'node'
          ? OWNER[nodeOwner.get(name) as string]
          : row.kind === 'product-guarantee'
            ? OWNER[guaranteeOwner.get(name) as string]
            : // The capability matrix gives Vinaya the five core ports and the legal transitions.
              'vinaya-policy'
      expect({ id: row.id, owner: row.owner }).toEqual({ id: row.id, owner: expected as RegistryOwner })
    }
  })

  it('cites, on each row, a heading of its source document at the re-pinned Engine revision', () => {
    for (const row of shard.components) {
      const document = join(CLI, '..', '..', row.source.document)
      expect(existsSync(document)).toBe(true)
      const headings = readFileSync(document, 'utf8')
        .split('\n')
        .filter((line) => line.startsWith('#'))
        .map((line) => line.replace(/^#+ /, ''))
      expect({ id: row.id, section: headings.includes(row.source.section) }).toEqual({ id: row.id, section: true })
      expect(row.source.revision).toBe(register.normativeDesign.revision)
    }
  })
})

describe('shard completeness fails on what it must', () => {
  it('reports a missing component', () => {
    const shardContent = clone(rawShard)
    const dropped = shardContent.components.splice(3, 1)[0] as { id: string; kind: ComponentKind }
    const report = check(shardContent)
    expect(report.complete).toBe(false)
    expect(report.missing).toEqual([{ kind: dropped.kind, name: dropped.id.slice(dropped.kind.length + 1) }])
  })

  it('reports an extra component, and a repeated one', () => {
    const shardContent = clone(rawShard)
    const extra = clone(shardContent.components[0] as Record<string, unknown>)
    extra.id = 'port:Scheduler'
    shardContent.components.push(extra, clone(shardContent.components[1] as Record<string, unknown>))
    const report = check(shardContent)
    expect(report.complete).toBe(false)
    expect(report.extra).toEqual([
      { kind: 'port', name: 'Scheduler' },
      {
        kind: (shardContent.components[1] as { kind: ComponentKind }).kind,
        name: String(shardContent.components[1]?.id).split(':')[1] as string
      }
    ])
  })

  it('reports a row with an empty or placeholder field', () => {
    const shardContent = clone(rawShard)
    ;(shardContent.components[5] as Record<string, unknown>).decisionRule = ''
    ;(shardContent.components[7] as Record<string, unknown>).migrationGate = 'TBD'
    const report = check(shardContent)
    expect(report.complete).toBe(false)
    expect(report.invalid.map((r) => [r.code, r.path])).toEqual([
      ['empty', 'shards/typed-sources.json#components[5].decisionRule'],
      ['placeholder', 'shards/typed-sources.json#components[7].migrationGate']
    ])
    expect(report.missing).toEqual([])
  })

  it('claims nothing about a kind the shard does not declare', () => {
    const report = check(rawShard, { ...UNIVERSES, role: ['developer', 'code-reviewer'] })
    expect(report.kinds).not.toContain('role')
    expect(report.complete).toBe(true)
  })

  it('refuses to judge a declared kind with no derived universe', () => {
    const { transition: _, ...withoutTransitions } = UNIVERSES
    const result = checkShardCompleteness(rawShard, catalog, withoutTransitions, 'shards/typed-sources.json')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.detail).toContain('transition')
  })
})
