/**
 * The evaluation foundation's global exit check: one pure function over the
 * aggregated registry rows and the universes the caller derives, claiming
 * zero uncovered components across the complete kind set. Each shard's own
 * check proves completeness for its kinds alone; only this check claims the
 * exit. It reads no file and is run by a test, not imported by the CLI. Its
 * specification is `apps/cli/specs/evals.md`, "Global exit check".
 */

import {
  COMPONENT_KINDS,
  type ComponentKind,
  type ComponentRow,
  isPlaceholder,
  type ModuleCatalog,
  REQUIRED_FIELDS,
  type Shard,
  TASK_CASES
} from './registry'

/** The shards the foundation delivers, by name. */
export const EXPECTED_SHARDS = ['typed-sources', 'contract-kinds', 'cutover-gates', 'fault-attack'] as const

/** The row counts the mirror's tables fix: seventeen cutover gates, fifty-eight fault-and-attack rows. */
export const EXPECTED_COUNTS: Partial<Record<ComponentKind, number>> = { 'cutover-gate': 17, 'fault-attack': 58 }

export type ExitCauseCode =
  | 'shard_absent'
  | 'kind_missing'
  | 'duplicate_id'
  | 'empty_field'
  | 'no_module'
  | 'module_unnamed'
  | 'universe_missing'
  | 'universe_extra'
  | 'count_mismatch'

/** One reason the exit is not met, naming what is wrong. */
export interface ExitCause {
  code: ExitCauseCode
  detail: string
}

export interface ExitKindReport {
  /** Rows of this kind, each id counted once. */
  covered: number
  /** Required fields empty, absent or a placeholder, over this kind's rows. */
  emptyFields: number
  /** Universe members with no row, plus rows naming no live catalog module. */
  unmapped: number
}

export interface ExitInput {
  catalog: ModuleCatalog
  /** Every shard, as aggregated. */
  shards: readonly Shard[]
  /** Every row with its location, as aggregated; checked as given, not re-derived. */
  components: readonly { location: string; row: ComponentRow }[]
  /** Each kind's universe, by name within the kind, derived by the caller from its typed source. */
  universes: Partial<Record<ComponentKind, readonly string[]>>
  /** The row counts the mirror's tables state, for the kinds a table fixes. */
  mirrorCounts: Partial<Record<ComponentKind, number>>
  expectedShards?: readonly string[]
  expectedCounts?: Partial<Record<ComponentKind, number>>
}

export interface ExitReport {
  pass: boolean
  kinds: Record<ComponentKind, ExitKindReport>
  emptyFields: number
  unmapped: number
  causes: ExitCause[]
}

/** The ten fields of a row that are empty, absent or a placeholder. */
export function emptyFieldsOf(row: ComponentRow): string[] {
  const bare = (value: unknown): boolean => typeof value !== 'string' || value.trim() === '' || isPlaceholder(value)
  const list = (value: unknown): boolean => !Array.isArray(value) || value.length === 0
  const loose = row as unknown as Record<string, unknown>
  const out: string[] = []
  for (const key of REQUIRED_FIELDS) {
    const value = loose[key]
    let empty: boolean
    if (key === 'suite' || key === 'backends' || key === 'cadence') empty = list(value)
    else if (key === 'tasks') {
      const cases = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
      empty = TASK_CASES.some((name) => {
        const one = cases[name] as { present?: unknown; notApplicable?: unknown } | undefined
        return one === undefined || one === null || bare(one.present ?? one.notApplicable)
      })
    } else if (key === 'grader') {
      const g = (typeof value === 'object' && value !== null ? value : {}) as { kinds?: unknown; detail?: unknown }
      empty = list(g.kinds) || bare(g.detail)
    } else empty = bare(value)
    if (empty) out.push(key)
  }
  return out
}

const nameOf = (row: ComponentRow): string =>
  row.id.startsWith(`${row.kind}:`) ? row.id.slice(row.kind.length + 1) : row.id

/** Checks the whole registry against every universe and count; passes only with no cause. */
export function checkExit(input: ExitInput): ExitReport {
  const causes: ExitCause[] = []
  const cause = (code: ExitCauseCode, detail: string) => causes.push({ code, detail })
  const kinds = Object.fromEntries(
    COMPONENT_KINDS.map((k) => [k, { covered: 0, emptyFields: 0, unmapped: 0 }])
  ) as Record<ComponentKind, ExitKindReport>

  const present = new Set(input.shards.map((s) => s.shard))
  for (const name of input.expectedShards ?? EXPECTED_SHARDS) {
    if (!present.has(name)) cause('shard_absent', `shard ${name} is absent`)
  }

  const modules = new Map(input.catalog.modules.map((m) => [m.id, m]))
  const named = new Set<string>()
  const seen = new Map<string, string>()
  const rowsByKind = new Map<ComponentKind, Set<string>>()
  for (const { location, row } of input.components) {
    const report = kinds[row.kind]
    if (report === undefined) {
      cause('kind_missing', `${row.id} at ${location} is of unknown kind ${String(row.kind)}`)
      continue
    }
    const prior = seen.get(row.id)
    if (prior !== undefined) {
      cause('duplicate_id', `${row.id} appears at ${prior} and at ${location}`)
      continue
    }
    seen.set(row.id, location)
    report.covered++
    const names = rowsByKind.get(row.kind) ?? new Set<string>()
    names.add(nameOf(row))
    rowsByKind.set(row.kind, names)

    const empty = emptyFieldsOf(row)
    report.emptyFields += empty.length
    for (const key of empty) cause('empty_field', `${row.id} at ${location} has an empty ${key}`)

    const module = typeof row.module === 'string' ? modules.get(row.module) : undefined
    if (module === undefined || module.excluded !== null) {
      report.unmapped++
      cause('no_module', `${row.id} at ${location} names no live catalog module (${JSON.stringify(row.module)})`)
    } else named.add(module.id)
    for (const other of row.additionalModules ?? []) {
      const extra = modules.get(other)
      if (extra === undefined || extra.excluded !== null) {
        report.unmapped++
        cause('no_module', `${row.id} at ${location} names no live catalog module (${JSON.stringify(other)})`)
      } else named.add(extra.id)
    }
  }

  for (const kind of COMPONENT_KINDS) {
    if (kinds[kind].covered === 0) cause('kind_missing', `no component of kind ${kind}`)
    const universe = input.universes[kind]
    if (universe === undefined) {
      cause('universe_missing', `no universe was derived for kind ${kind}`)
      continue
    }
    const have = rowsByKind.get(kind) ?? new Set<string>()
    for (const name of universe) {
      if (have.has(name)) continue
      kinds[kind].unmapped++
      cause('universe_missing', `${kind}:${name} is in the universe and has no row`)
    }
    const members = new Set(universe)
    for (const name of have)
      if (!members.has(name)) cause('universe_extra', `${kind}:${name} has a row naming no universe member`)
  }

  for (const module of input.catalog.modules) {
    if (module.excluded === null && module.scope !== 'system' && !named.has(module.id)) {
      cause('module_unnamed', `catalog module ${module.id} is named by no component and is not system scope`)
    }
  }

  const expected = input.expectedCounts ?? EXPECTED_COUNTS
  for (const kind of COMPONENT_KINDS) {
    const want = expected[kind]
    if (want === undefined) continue
    const mirror = input.mirrorCounts[kind]
    if (mirror !== want)
      cause('count_mismatch', `the mirror's ${kind} table has ${mirror ?? 'no'} rows, expected ${want}`)
    if (kinds[kind].covered !== want) {
      cause('count_mismatch', `${kind} has ${kinds[kind].covered} rows, expected ${want}`)
    }
  }

  const emptyFields = COMPONENT_KINDS.reduce((n, k) => n + kinds[k].emptyFields, 0)
  const unmapped = COMPONENT_KINDS.reduce((n, k) => n + kinds[k].unmapped, 0)
  return { pass: causes.length === 0 && emptyFields === 0 && unmapped === 0, kinds, emptyFields, unmapped, causes }
}
