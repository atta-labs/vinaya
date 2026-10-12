// The module registry: the catalog mirrors the evaluation program's §6, every
// row carries the ten required fields and its own source, malformed rows are
// refused with a typed reason, and shards found by listing their directory
// aggregate with duplicate component ids refused at both locations.
import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  aggregateShards,
  type ComponentRow,
  loadRegistry,
  type ModuleCatalog,
  REQUIRED_FIELDS,
  type RegistryRefusalCode,
  type RegistryResult,
  readShardDirectory,
  suiteId,
  validateComponentRow,
  validateModuleCatalog,
  validateShard
} from '../../src/lib/dev-review-eval/registry'

const REGISTRY_DIR = join(import.meta.dir, 'registry')
const MODULES_FILE = join(REGISTRY_DIR, 'modules.json')
const SHARDS_DIR = join(REGISTRY_DIR, 'shards')
const PROGRAM_PATH = 'apps/cli/specs/dev-review-evaluation-program.md'
const PROGRAM = readFileSync(join(import.meta.dir, '../../specs/dev-review-evaluation-program.md'), 'utf8')
const PROVENANCE = JSON.parse(
  readFileSync(join(import.meta.dir, '../../specs/dev-review-evaluation-program.provenance.json'), 'utf8')
) as { revision: number }

const rawCatalog = JSON.parse(readFileSync(MODULES_FILE, 'utf8')) as { modules: Record<string, unknown>[] }
const catalogResult = validateModuleCatalog(rawCatalog, 'modules.json')
if (!catalogResult.ok) throw new Error(`modules.json refused: ${JSON.stringify(catalogResult.refusal)}`)
const catalog: ModuleCatalog = catalogResult.value

function refusedWith<T>(result: RegistryResult<T>, code: RegistryRefusalCode, path?: string): void {
  if (result.ok) throw new Error(`expected refusal ${code}, got ok`)
  expect(result.refusal.code).toBe(code)
  if (path !== undefined) expect(result.refusal.path).toBe(path)
}

const clone = <T>(value: T): T => structuredClone(value)

/** A well-formed component row on module 6.11, every field stated. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'node:assess_round',
    kind: 'node',
    module: '6.11',
    source: {
      document: 'apps/cli/specs/dev-review-engine-state-machine.md',
      revision: 17,
      section: 'The node contracts (O2)'
    },
    contract: 'assess_round returns one legal decision for its validated inputs.',
    owner: 'vinaya-policy',
    officialBasis: 'Vinaya product decision.',
    suite: ['assessment.l1@1'],
    tasks: {
      positive: { present: 'Every verdict approving and every objective met: publish.' },
      negative: { present: 'An objective not met: no publish.' },
      refusal: { notApplicable: 'The node refuses nothing; a pause is a decision it returns.' },
      recovery: { present: 'Resumed from its checkpoint, the same inputs give the same decision.' },
      adversarial: { notApplicable: 'Inputs reach it already validated.' }
    },
    grader: { kinds: ['code'], detail: 'The returned decision.' },
    backends: ['standalone', 'engine'],
    decisionRule: 'Deterministic 100%.',
    cadence: ['every-affected-change'],
    migrationGate: '§14 for module 6.11.',
    ...overrides
  }
}

function shardOf(name: string, rows: Record<string, unknown>[], kinds = ['node']): Record<string, unknown> {
  return { schemaVersion: 1, shard: name, kinds, components: rows }
}

/** Program text of one `### 6.x` section, up to the next heading. */
function sectionText(id: string): string {
  const start = PROGRAM.indexOf(`\n### ${id} `)
  const end = PROGRAM.indexOf('\n#', start + 1)
  return PROGRAM.slice(start, end)
}

describe('the module catalog mirrors the evaluation program', () => {
  const headings = PROGRAM.split('\n')
    .filter((line) => /^### 6\.\d+ /.test(line))
    .map((line) => line.slice(4))

  it('names the ten required fields of the program’s table, in order', () => {
    const table = PROGRAM.slice(PROGRAM.indexOf('**Required fields.**'), PROGRAM.indexOf('The entries below define'))
    const names = [...table.matchAll(/^\| ([A-Z][a-z]+(?: [a-z]+)?) \|/gm)]
      .map((match) => match[1] as string)
      .filter((name) => name !== 'Field')
    const camel = names.map((name) =>
      name.replace(/ ([a-z])/g, (_, c: string) => c.toUpperCase()).replace(/^./, (c) => c.toLowerCase())
    )
    expect(camel).toEqual([...REQUIRED_FIELDS])
  })

  it('has exactly one entry per §6 module, each citing its own heading at the mirror’s revision', () => {
    expect(headings.length).toBe(24)
    expect(catalog.modules.map((m) => m.source.section)).toEqual(headings)
    for (const module of catalog.modules) {
      expect(module.source.section).toBe(`${module.id} ${module.title}`)
      expect(module.source.document).toBe(PROGRAM_PATH)
      expect(module.source.revision).toBe(PROVENANCE.revision)
    }
  })

  it('declares one suite per layer the program lists for the module', () => {
    for (const module of catalog.modules) {
      const layersLine = /\*\*Layers:\*\* ([^\n]*)/.exec(sectionText(module.id))?.[1] ?? ''
      const layers = [...new Set(layersLine.match(/L[1-8]/g) ?? [])].sort()
      const declared: string[] = module.suites.map((s) => s.layer).sort()
      expect({ module: module.id, layers: declared }).toEqual({ module: module.id, layers })
    }
  })

  it('states every field of every included module as a value, and names only its own suites', () => {
    for (const module of catalog.modules.filter((m) => m.excluded === null)) {
      for (const key of REQUIRED_FIELDS) {
        expect({ module: module.id, key, notApplicable: 'notApplicable' in Object(module[key]) }).toEqual({
          module: module.id,
          key,
          notApplicable: false
        })
      }
      expect(module.suite).toEqual(module.suites.map(suiteId))
    }
  })

  it('excludes only the Planner, which the program lists so its absence is a decision', () => {
    expect(catalog.modules.filter((m) => m.excluded !== null).map((m) => m.id)).toEqual(['6.19'])
    expect(sectionText('6.19')).toContain('its absence is a decision, not an omission')
  })
})

describe('module catalog validation', () => {
  it('refuses a not-applicable field on a module that is not excluded', () => {
    const bad = clone(rawCatalog)
    ;(bad.modules[0] as Record<string, unknown>).grader = { notApplicable: 'no grader' }
    refusedWith(validateModuleCatalog(bad), 'not_applicable_refused', 'modules[0].grader')
  })

  it('refuses a module whose suite field names a suite it does not declare', () => {
    const bad = clone(rawCatalog)
    ;(bad.modules[0] as Record<string, unknown>).suite = ['assessment.l1@1']
    refusedWith(validateModuleCatalog(bad), 'unknown_suite', 'modules[0].suite[0]')
  })

  it('refuses one suite name declared by two modules', () => {
    const bad = clone(rawCatalog)
    const first = bad.modules[0] as { suites: unknown[] }
    first.suites.push(clone((bad.modules[1] as { suites: unknown[] }).suites[0]))
    refusedWith(validateModuleCatalog(bad), 'duplicate')
  })

  it('refuses an excluded module that declares a suite', () => {
    const bad = clone(rawCatalog)
    const planner = bad.modules.find((m) => m.id === '6.19') as { suites: unknown[] }
    planner.suites.push({ name: 'planner.l1', version: 1, layer: 'L1' })
    refusedWith(validateModuleCatalog(bad), 'wrong_type')
  })
})

describe('component row validation', () => {
  it('accepts a row stating all ten fields', () => {
    const result = validateComponentRow(row(), catalog)
    expect(result.ok).toBe(true)
  })

  it.each([...REQUIRED_FIELDS])('refuses a row missing %s', (key) => {
    const value = row()
    delete value[key]
    refusedWith(validateComponentRow(value, catalog), 'missing_field', key)
  })

  it.each(['contract', 'officialBasis', 'decisionRule', 'migrationGate'])('refuses an empty %s', (key) => {
    refusedWith(validateComponentRow(row({ [key]: '  ' }), catalog), 'empty', key)
  })

  it.each(['suite', 'backends', 'cadence'])('refuses an empty %s list', (key) => {
    refusedWith(validateComponentRow(row({ [key]: [] }), catalog), 'empty', key)
  })

  it.each(['TBD', 'todo', 'N/A', '—', '...', 'pending', 'Contract: TBD later', 'see module'])(
    'refuses the placeholder %p',
    (value) => {
      refusedWith(validateComponentRow(row({ contract: value }), catalog), 'placeholder', 'contract')
    }
  )

  it('refuses a placeholder inside a task case', () => {
    const tasks = clone(row().tasks) as Record<string, unknown>
    tasks.recovery = { notApplicable: 'TBD' }
    refusedWith(validateComponentRow(row({ tasks }), catalog), 'placeholder', 'tasks.recovery.notApplicable')
  })

  it('refuses a field stated as not applicable — a component row states every field', () => {
    refusedWith(
      validateComponentRow(row({ grader: { notApplicable: 'inherits the module' } }), catalog),
      'not_applicable_refused',
      'grader'
    )
  })

  it('refuses a task list missing one of the five cases, or one stating a case both ways', () => {
    const tasks = clone(row().tasks) as Record<string, unknown>
    delete tasks.adversarial
    refusedWith(validateComponentRow(row({ tasks }), catalog), 'missing_field', 'tasks.adversarial')
    const both = clone(row().tasks) as Record<string, unknown>
    both.refusal = { present: 'a refusal', notApplicable: 'none' }
    refusedWith(validateComponentRow(row({ tasks: both }), catalog), 'wrong_type', 'tasks.refusal')
  })

  it('refuses an unknown module, and the excluded one', () => {
    refusedWith(validateComponentRow(row({ module: '6.99' }), catalog), 'unknown_module', 'module')
    refusedWith(validateComponentRow(row({ module: '6.19' }), catalog), 'module_excluded', 'module')
  })

  it('refuses an additional module that is unknown, excluded, repeated or the row’s own', () => {
    expect(validateComponentRow(row({ additionalModules: ['6.21'] }), catalog).ok).toBe(true)
    refusedWith(
      validateComponentRow(row({ additionalModules: ['6.99'] }), catalog),
      'unknown_module',
      'additionalModules[0]'
    )
    refusedWith(
      validateComponentRow(row({ additionalModules: ['6.19'] }), catalog),
      'module_excluded',
      'additionalModules[0]'
    )
    refusedWith(
      validateComponentRow(row({ additionalModules: ['6.11'] }), catalog),
      'duplicate',
      'additionalModules[0]'
    )
    refusedWith(
      validateComponentRow(row({ additionalModules: ['6.21', '6.21'] }), catalog),
      'duplicate',
      'additionalModules[1]'
    )
    refusedWith(validateComponentRow(row({ additionalModules: '6.21' }), catalog), 'wrong_type', 'additionalModules')
  })

  it('refuses a catalog scope other than system', () => {
    const modules = (catalog.modules as unknown[]).map((m) => ({ ...(m as object) }))
    ;(modules[0] as Record<string, unknown>).scope = 'component'
    refusedWith(validateModuleCatalog({ schemaVersion: 1, modules }), 'unknown_value', 'modules[0].scope')
  })

  it('refuses a suite its module does not declare, and a malformed suite reference', () => {
    refusedWith(validateComponentRow(row({ suite: ['run-control.l2@1'] }), catalog), 'unknown_suite', 'suite[0]')
    refusedWith(validateComponentRow(row({ suite: ['assessment.l1@2'] }), catalog), 'unknown_suite', 'suite[0]')
    refusedWith(
      validateComponentRow(row({ suite: ['apps/cli/tests/eval/assessment.test.ts'] }), catalog),
      'bad_suite_ref',
      'suite[0]'
    )
  })

  it('refuses an owner, backend, cadence or grader kind outside the program’s vocabulary', () => {
    refusedWith(validateComponentRow(row({ owner: 'engine-runtime' }), catalog), 'unknown_value', 'owner')
    refusedWith(validateComponentRow(row({ backends: ['langgraph'] }), catalog), 'unknown_value', 'backends[0]')
    refusedWith(validateComponentRow(row({ cadence: ['weekly'] }), catalog), 'unknown_value', 'cadence[0]')
    refusedWith(
      validateComponentRow(row({ grader: { kinds: ['vibes'], detail: 'x' } }), catalog),
      'unknown_value',
      'grader.kinds[0]'
    )
  })

  it('refuses an id that does not name its kind, and a row without its own source', () => {
    refusedWith(validateComponentRow(row({ id: 'assess_round' }), catalog), 'bad_name', 'id')
    refusedWith(
      validateComponentRow(row({ source: { document: 'x.md', revision: 17, section: '' } }), catalog),
      'empty',
      'source.section'
    )
  })
})

describe('shard aggregation', () => {
  const a = row()
  const b = row({ id: 'node:build_revision_handoff' })

  it('joins every shard’s rows, each with its location', () => {
    const result = aggregateShards(catalog, [
      { location: 'shards/one.json', content: shardOf('one', [a]) },
      { location: 'shards/two.json', content: shardOf('two', [b]) }
    ])
    if (!result.ok) throw new Error(JSON.stringify(result.refusal))
    expect(result.value.components.map((c) => [c.location, c.row.id])).toEqual([
      ['shards/one.json#components[0]', 'node:assess_round'],
      ['shards/two.json#components[0]', 'node:build_revision_handoff']
    ])
  })

  it('refuses a duplicate component id within one shard, naming both locations', () => {
    const result = aggregateShards(catalog, [{ location: 'shards/one.json', content: shardOf('one', [a, b, a]) }])
    refusedWith(result, 'duplicate_component', 'shards/one.json#components[2].id')
    if (!result.ok) {
      expect(result.refusal.detail).toContain('shards/one.json#components[0]')
      expect(result.refusal.detail).toContain('shards/one.json#components[2]')
    }
  })

  it('refuses a duplicate component id across shards, naming both locations', () => {
    const result = aggregateShards(catalog, [
      { location: 'shards/one.json', content: shardOf('one', [a]) },
      { location: 'shards/two.json', content: shardOf('two', [b, a]) }
    ])
    refusedWith(result, 'duplicate_component', 'shards/two.json#components[1].id')
    if (!result.ok) {
      expect(result.refusal.detail).toContain('shards/one.json#components[0]')
      expect(result.refusal.detail).toContain('shards/two.json#components[1]')
    }
  })

  it('refuses a row of a kind its shard does not declare', () => {
    refusedWith(
      validateShard(shardOf('one', [a], ['transition']), catalog, 'shards/one.json'),
      'kind_not_declared',
      'shards/one.json#components[0].kind'
    )
  })

  it('refuses a shard whose name is not its file name', () => {
    refusedWith(validateShard(shardOf('other', [a]), catalog, 'shards/one.json'), 'bad_name', 'shards/one.json#shard')
  })

  it('discovers shards by listing their directory, so a new shard is a new file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'registry-shards-'))
    try {
      const shards = join(dir, 'shards')
      mkdirSync(shards)
      writeFileSync(join(shards, 'two.json'), JSON.stringify(shardOf('two', [b])))
      writeFileSync(join(shards, 'one.json'), JSON.stringify(shardOf('one', [a])))
      writeFileSync(join(shards, 'README.md'), 'not a shard')
      const listed = readShardDirectory(shards)
      if (!listed.ok) throw new Error(JSON.stringify(listed.refusal))
      expect(listed.value.map((s) => s.location)).toEqual(['shards/one.json', 'shards/two.json'])

      writeFileSync(join(dir, 'modules.json'), JSON.stringify(rawCatalog))
      const before = loadRegistry(join(dir, 'modules.json'), shards)
      if (!before.ok) throw new Error(JSON.stringify(before.refusal))
      expect(before.value.components.length).toBe(2)

      writeFileSync(join(shards, 'three.json'), JSON.stringify(shardOf('three', [a])))
      const after = loadRegistry(join(dir, 'modules.json'), shards)
      refusedWith(after, 'duplicate_component', 'shards/three.json#components[0].id')

      writeFileSync(join(shards, 'three.json'), '{ not json')
      refusedWith(loadRegistry(join(dir, 'modules.json'), shards), 'unreadable', 'shards/three.json')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the repository registry', () => {
  it('loads: the catalog and every shard validate and aggregate', () => {
    const result = loadRegistry(MODULES_FILE, SHARDS_DIR)
    if (!result.ok) throw new Error(JSON.stringify(result.refusal))
    const components: ComponentRow[] = result.value.components.map((c) => c.row)
    console.log(
      `registry: modules ${result.value.catalog.modules.length}, shards ${result.value.shards.length}, components ${components.length}`
    )
    expect(result.value.catalog.modules.length).toBe(24)
    expect(result.value.shards.length).toBeGreaterThan(0)
  })
})
