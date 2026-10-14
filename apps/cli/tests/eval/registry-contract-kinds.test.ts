// The contract-kinds shard is complete: for each kind it declares — roles,
// agent-facing tools, governed effects, provider adapters, isolation
// boundaries and controller workflow gates — every member of the universe its
// repository source states has exactly one valid row citing that source, and
// no row names anything else. It aggregates with the other shards without a
// duplicate id and claims nothing about any other kind.
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
  CONTRACT_UNIVERSE_EXCLUSIONS,
  CONTRACT_KINDS,
  type ContractKind,
  type ContractSources,
  deriveContractUniverses,
  PROGRAM_DOC,
  REPO_ROOT,
  readContractSources,
  sectionBody,
  universeNames
} from './registry/contract-kinds-universe'

const REGISTRY_DIR = join(import.meta.dir, 'registry')
const SHARD_FILE = join(REGISTRY_DIR, 'shards/contract-kinds.json')
const LOCATION = 'shards/contract-kinds.json'

const sources = readContractSources()
const derived = deriveContractUniverses(sources)
const UNIVERSES = universeNames(derived)

/** Specifications outside the evaluation program are cited at the Engine revision the register is pinned to. */
const engineRevision = (
  JSON.parse(
    readFileSync(join(REPO_ROOT, 'apps/cli/tests/fixtures/dev-review-architecture-invariants.json'), 'utf8')
  ) as { normativeDesign: { revision: number } }
).normativeDesign.revision

/** Owners fixed by kind: the capability matrix gives each adapter its adapter, §6.15 gives confinement the sandbox. */
const KIND_OWNER: Partial<Record<ContractKind, RegistryOwner>> = {
  adapter: 'adapter',
  'isolation-boundary': 'sandbox',
  effect: 'governed-effect'
}

const loaded = loadRegistry(join(REGISTRY_DIR, 'modules.json'), join(REGISTRY_DIR, 'shards'))
if (!loaded.ok) throw new Error(`registry refused: ${JSON.stringify(loaded.refusal)}`)
const catalog: ModuleCatalog = loaded.value.catalog
const rawShard = JSON.parse(readFileSync(SHARD_FILE, 'utf8')) as {
  kinds: string[]
  components: Record<string, unknown>[]
}
const shard = loaded.value.shards.find((s) => s.shard === 'contract-kinds')
if (shard === undefined) throw new Error('the contract-kinds shard was not found by listing the shard directory')

const clone = <T>(value: T): T => structuredClone(value)
const check = (content: unknown, universes: Partial<Record<ComponentKind, readonly string[]>> = UNIVERSES) => {
  const result = checkShardCompleteness(content, catalog, universes, LOCATION)
  if (!result.ok) throw new Error(JSON.stringify(result.refusal))
  return result.value
}
const nameOf = (row: { id: string; kind: string }) => row.id.slice(row.kind.length + 1)

describe('the contract-kinds shard', () => {
  it('declares exactly the kinds the contract specifications and typed tool lists state', () => {
    expect(shard.kinds).toEqual([...CONTRACT_KINDS])
  })

  it('is complete against the universes derived from its repository sources', () => {
    const report = check(rawShard)
    const counts = shard.kinds.map((kind) => `${kind} ${shard.components.filter((c) => c.kind === kind).length}`)
    console.log(
      `contract-kinds shard: ${counts.join(', ')}; missing ${report.missing.length}, extra ${report.extra.length}, invalid ${report.invalid.length}`
    )
    expect(report.missing).toEqual([])
    expect(report.extra).toEqual([])
    expect(report.invalid).toEqual([])
    expect(report.complete).toBe(true)
    for (const kind of CONTRACT_KINDS) {
      expect(shard.components.filter((c) => c.kind === kind).length).toBe(UNIVERSES[kind].length)
    }
  })

  it('makes the canonical catalog and shared error model independently mandatory', () => {
    for (const id of ['tool:canonical_catalog', 'tool:shared_error_model']) {
      const shardContent = clone(rawShard)
      shardContent.components = shardContent.components.filter((row) => row.id !== id)
      const report = check(shardContent)
      expect(report.complete).toBe(false)
      expect(report.missing).toContainEqual({ kind: 'tool', name: id.slice('tool:'.length) })
    }
  })

  it('derives each universe from its source, not from a hand list', () => {
    expect(UNIVERSES.role).toEqual(['developer', 'code-reviewer', 'security-reviewer', 'operator', 'controller'])
    expect(UNIVERSES.tool).toEqual([
      'canonical_catalog',
      'shared_error_model',
      ...sources.devTools,
      'read_source',
      ...sources.taskTools
    ])
    expect(UNIVERSES.adapter).toEqual([...sources.adapters])
    expect(UNIVERSES['isolation-boundary']).toHaveLength(6)
    expect(UNIVERSES.gate).toHaveLength(9)
    // Every effect but the controller's own publications is a §4.1 write tool.
    const writeEffects = UNIVERSES.effect.filter((name) => sources.devTools.includes(name))
    expect(writeEffects).toEqual([
      'publish_changes',
      'open_pull_request',
      'update_pull_request_body',
      'refresh_evidence'
    ])
    expect(UNIVERSES.effect.filter((name) => !writeEffects.includes(name))).toEqual([
      'publish_ready_for_merge',
      'beyond-surface-record'
    ])
  })

  it('cites, on each row, the document and section its universe member is stated in, at that document’s revision', () => {
    for (const row of shard.components) {
      const member = derived[row.kind as ContractKind].find((m) => m.name === nameOf(row))
      expect({ id: row.id, document: row.source.document, section: row.source.section }).toEqual({
        id: row.id,
        document: member?.source.document as string,
        section: member?.source.section as string
      })
      const document = join(REPO_ROOT, row.source.document)
      expect(existsSync(document)).toBe(true)
      expect(() => sectionBody(readFileSync(document, 'utf8'), row.source.section)).not.toThrow()
      expect({ id: row.id, revision: row.source.revision }).toEqual({
        id: row.id,
        // This task changes no registry row. Program citations therefore stay
        // pinned to revision 11; the sole changed source assertion (§6.23) is
        // guarded by the shrink-only Operator exclusion below.
        revision: row.source.document === PROGRAM_DOC ? 11 : engineRevision
      })
    }
  })

  it('gives adapters, isolation boundaries and effects the owner their kind fixes', () => {
    for (const row of shard.components) {
      const expected = KIND_OWNER[row.kind as ContractKind]
      if (expected !== undefined) expect({ id: row.id, owner: row.owner }).toEqual({ id: row.id, owner: expected })
    }
  })

  it('describes the reviewers’ source read as live, with no planned-only case left', () => {
    const row = shard.components.find((c) => c.id === 'tool:read_source')
    expect(row?.contract).not.toContain('Planned')
    expect(JSON.stringify(row?.tasks)).not.toContain('Planned:')
    expect(row?.source.section.startsWith('4.2 ')).toBe(true)
  })
})

describe('the contract-kinds shard aggregates with the other shards', () => {
  it('joins every shard without a duplicate component id', () => {
    const ids = loaded.value.components.map((c) => c.row.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(loaded.value.shards.map((s) => s.shard)).toContain('typed-sources')
    expect(ids.length).toBe(loaded.value.shards.reduce((sum, s) => sum + s.components.length, 0))
  })

  it('shares no declared kind with another shard', () => {
    for (const other of loaded.value.shards.filter((s) => s.shard !== 'contract-kinds')) {
      expect({ shard: other.shard, shared: other.kinds.filter((kind) => shard.kinds.includes(kind)) }).toEqual({
        shard: other.shard,
        shared: []
      })
    }
  })
})

describe('shard completeness fails on what it must', () => {
  it('reports a missing component', () => {
    const shardContent = clone(rawShard)
    const dropped = shardContent.components.splice(9, 1)[0] as { id: string; kind: ComponentKind }
    const report = check(shardContent)
    expect(report.complete).toBe(false)
    expect(report.missing).toEqual([{ kind: dropped.kind, name: nameOf(dropped) }])
  })

  it('reports an extra component, and a repeated one', () => {
    const shardContent = clone(rawShard)
    const extra = clone(shardContent.components[0] as Record<string, unknown>)
    extra.id = 'role:planner'
    const repeated = clone(shardContent.components[1] as Record<string, unknown>)
    shardContent.components.push(extra, repeated)
    const report = check(shardContent)
    expect(report.complete).toBe(false)
    expect(report.extra).toEqual([
      { kind: 'role', name: 'planner' },
      { kind: repeated.kind as ComponentKind, name: nameOf(repeated as { id: string; kind: string }) }
    ])
  })

  it('reports a row with an empty or placeholder field', () => {
    const shardContent = clone(rawShard)
    ;(shardContent.components[4] as Record<string, unknown>).contract = ''
    ;(shardContent.components[20] as Record<string, unknown>).officialBasis = 'TBD'
    const report = check(shardContent)
    expect(report.complete).toBe(false)
    expect(report.invalid.map((r) => [r.code, r.path])).toEqual([
      ['empty', `${LOCATION}#components[4].contract`],
      ['placeholder', `${LOCATION}#components[20].officialBasis`]
    ])
    expect(report.missing).toEqual([])
  })

  it('claims nothing about a kind the shard does not declare', () => {
    const report = check(rawShard, { ...UNIVERSES, port: ['AgentRuntime'], 'product-guarantee': ['INV-NONE'] })
    expect(report.kinds).not.toContain('port')
    expect(report.kinds).not.toContain('product-guarantee')
    expect(report.complete).toBe(true)
  })

  it('refuses to judge a declared kind with no derived universe', () => {
    const { gate: _, ...withoutGates } = UNIVERSES
    const result = checkShardCompleteness(rawShard, catalog, withoutGates, LOCATION)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.detail).toContain('gate')
  })
})

describe('the universe derivation follows its sources', () => {
  const derive = (change: Partial<ContractSources>) => deriveContractUniverses({ ...sources, ...change })

  it('adds a member when its source adds one', () => {
    const contracts = sources.contracts.replace(
      'ruling intake and resume;',
      'ruling intake and resume; budget ceiling;'
    )
    expect(universeNames(derive({ contracts })).gate).toContain('budget-ceiling')
  })

  it('refuses when the §4.1 table and DEV_TOOL_NAMES disagree', () => {
    expect(() => derive({ devTools: [...sources.devTools, 'merge_pull_request'] })).toThrow(/disagree/)
  })

  it('refuses when §3 no longer counts the Operator tools TASK_TOOL_NAMES holds', () => {
    expect(() => derive({ taskTools: [...sources.taskTools, 'task_halt'] })).toThrow(/Operator/)
  })

  it('keeps the Operator-owned wording-check exclusion shrink-only and rejects it once covered', () => {
    expect(CONTRACT_UNIVERSE_EXCLUSIONS).toEqual([
      {
        kind: 'check',
        name: 'program-6.23-supporting-pull-request-read',
        owner: 'Operator on one host',
        reason: 'Owned by the Operator on one host project; its own exit check runs with no exclusions.'
      }
    ])
    const program = sources.program.replace(
      'the nine governed Operator tools—task start',
      'the supporting pull-request read and the nine governed Operator tools—task start'
    )
    expect(() => derive({ program })).toThrow(/exclusion is covered and must be removed/)
  })

  it('refuses when the isolation table no longer holds six boundaries', () => {
    const isolation = sources.isolation.replace(/\n\| \*\*Broker\*\* \|[^\n]*/, '')
    expect(() => derive({ isolation })).toThrow(/not six/)
  })
})
