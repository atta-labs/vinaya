/**
 * The module registry: the evaluation program's §6 module catalog, and one
 * row per migrating component carrying the ten required fields the program's
 * "Required fields" table names. Vocabulary follows
 * `apps/cli/specs/dev-review-evaluation-program.md` exactly; this module's own
 * specification is `apps/cli/specs/evals.md`, "Module registry".
 *
 * The catalog lives in one file; component rows live in separate shard files
 * aggregated by listing their directory, so a later shard adds a file and
 * touches nothing shared. Every row — module or component — carries its own
 * source document, revision and section, and stores all ten fields itself: a
 * component never inherits a field from its module.
 *
 * Validation refuses with a typed reason naming the offending field, in the
 * shape `contracts.ts` uses. Shard completeness compares one shard against the
 * universes its caller derives from typed sources, for the kinds that shard
 * declares and no other; it is not the program's global exit check.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { EVALUATION_LAYERS, type EvaluationLayer } from './contracts'

// ── Vocabulary ──────────────────────────────────────────────────────────────

/** The ten required fields, in the order of the program's §6 table. */
export const REQUIRED_FIELDS = [
  'contract',
  'owner',
  'officialBasis',
  'suite',
  'tasks',
  'grader',
  'backends',
  'decisionRule',
  'cadence',
  'migrationGate'
] as const
export type RequiredField = (typeof REQUIRED_FIELDS)[number]

/** The component kinds the program's §6 names as migrating. */
export const COMPONENT_KINDS = [
  'port',
  'node',
  'role',
  'tool',
  'gate',
  'transition',
  'effect',
  'adapter',
  'isolation-boundary',
  'product-guarantee',
  'fault-attack',
  'cutover-gate'
] as const
export type ComponentKind = (typeof COMPONENT_KINDS)[number]

/** "Engine, Vinaya policy, adapter, sandbox, governed effect or process package." */
export const REGISTRY_OWNERS = [
  'engine',
  'vinaya-policy',
  'adapter',
  'sandbox',
  'governed-effect',
  'process-package'
] as const
export type RegistryOwner = (typeof REGISTRY_OWNERS)[number]

/** "Standalone and Engine, on identical inputs." */
export const BACKENDS = ['standalone', 'engine'] as const
export type Backend = (typeof BACKENDS)[number]

/** "Every affected change, scheduled live run, pre-release or canary." */
export const CADENCES = ['every-affected-change', 'scheduled-live', 'pre-release', 'canary'] as const
export type Cadence = (typeof CADENCES)[number]

/** "Code first; calibrated model or human only where code cannot judge." */
export const GRADER_KINDS = ['code', 'model', 'human'] as const
export type GraderKind = (typeof GRADER_KINDS)[number]

/** "Positive, negative, refusal, recovery and adversarial cases." */
export const TASK_CASES = ['positive', 'negative', 'refusal', 'recovery', 'adversarial'] as const
export type TaskCaseName = (typeof TASK_CASES)[number]

// ── Types ───────────────────────────────────────────────────────────────────

/** Where a row's content comes from: a repository document, its revision and a heading in it. */
export interface RowSource {
  document: string
  revision: number
  section: string
}

/** A field, or one task case, stated as not applicable — with the reason. */
export interface NotApplicable {
  notApplicable: string
}

/** One task case: what the case is, or why it does not apply. */
export type TaskCase = { present: string } | NotApplicable

export type TaskCases = Record<TaskCaseName, TaskCase>

export interface GraderField {
  kinds: GraderKind[]
  detail: string
}

/** The ten required fields, every one carrying a value. */
export interface RequiredFields {
  contract: string
  owner: RegistryOwner
  officialBasis: string
  /** Suite references, `<name>@<version>`, each declared by the row's module. */
  suite: string[]
  tasks: TaskCases
  grader: GraderField
  backends: Backend[]
  decisionRule: string
  cadence: Cadence[]
  migrationGate: string
}

/** A suite a module declares: a stable name, a version and its layer. */
export interface SuiteDeclaration {
  name: string
  version: number
  layer: EvaluationLayer
}

/**
 * One entry of the §6 module catalog. A module the catalog lists only so its
 * absence is a decision carries `excluded` with the reason; only such a
 * module may state a field as not applicable, and it declares no suite.
 */
export type ModuleEntry = {
  id: string
  title: string
  source: RowSource
  excluded: string | null
  /** `system`: proven by its own suites and owned by no single component, so no row need name it. */
  scope?: 'system'
  suites: SuiteDeclaration[]
} & { [K in RequiredField]: RequiredFields[K] | NotApplicable }

export interface ModuleCatalog {
  modules: ModuleEntry[]
}

/** One migrating component: its kind, its one catalog module, and the ten fields. */
export interface ComponentRow extends RequiredFields {
  /** `<kind>:<name>`, unique across the whole registry. */
  id: string
  kind: ComponentKind
  module: string
  /** Further catalog modules this component also names, never its own `module`. */
  additionalModules?: string[]
  source: RowSource
}

/** One shard file: the component kinds it covers and its rows. */
export interface Shard {
  shard: string
  kinds: ComponentKind[]
  components: ComponentRow[]
}

/** A shard file as read: where it was found and its parsed content. */
export interface ShardInput {
  location: string
  content: unknown
}

/** The aggregated registry: the catalog and every shard's rows, each with its location. */
export interface Registry {
  catalog: ModuleCatalog
  shards: Shard[]
  components: { location: string; row: ComponentRow }[]
}

// ── Validation result ───────────────────────────────────────────────────────

export type RegistryRefusalCode =
  | 'not_object'
  | 'missing_field'
  | 'wrong_type'
  | 'empty'
  | 'placeholder'
  | 'bad_name'
  | 'bad_suite_ref'
  | 'out_of_range'
  | 'unknown_value'
  | 'duplicate'
  | 'unknown_module'
  | 'module_excluded'
  | 'unknown_suite'
  | 'not_applicable_refused'
  | 'kind_not_declared'
  | 'duplicate_component'
  | 'unreadable'

/** Why a value was refused. `path` names the field, dotted from the root, prefixed by the file it came from. */
export interface RegistryRefusal {
  code: RegistryRefusalCode
  path: string
  detail: string
}

export type RegistryResult<T> = { ok: true; value: T } | { ok: false; refusal: RegistryRefusal }

class Refused extends Error {
  constructor(readonly refusal: RegistryRefusal) {
    super(refusal.detail)
  }
}

function refuse(code: RegistryRefusalCode, path: string, detail: string): never {
  throw new Refused({ code, path, detail })
}

function run<T>(check: () => T): RegistryResult<T> {
  try {
    return { ok: true, value: check() }
  } catch (error) {
    if (error instanceof Refused) return { ok: false, refusal: error.refusal }
    throw error
  }
}

// ── Field readers ───────────────────────────────────────────────────────────

/** Module ids follow the catalog's numbering: `6.1` … `6.24`. */
const MODULE_ID = /^6\.[1-9][0-9]?$/
/** Suite names: lowercase kebab segments joined by dots. */
const SUITE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/
const SUITE_REF = /^(.+)@([1-9][0-9]*)$/
const SHARD_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * A value that only stands in for content. Matched against the whole value,
 * or as a marker word anywhere in it.
 */
const PLACEHOLDER_VALUE =
  /^\s*(?:tbd|tba|todo|fixme|xxx|n\/?a|none|null|pending|placeholder|unknown|same as module|see module|-+|—|\.\.\.|…|\?+)\s*\.?\s*$/i
const PLACEHOLDER_MARKER = /\b(?:TODO|TBD|FIXME|XXX)\b|lorem ipsum/i

export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_VALUE.test(value) || PLACEHOLDER_MARKER.test(value)
}

/** A dotted path; under a file location (`….json`) the first key follows a `#`. */
function at(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key}]`
  if (path === '') return key
  return path.endsWith('.json') ? `${path}#${key}` : `${path}.${key}`
}

function record(input: unknown, path: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    refuse('not_object', path, `${path || 'value'} must be an object`)
  }
  return input as Record<string, unknown>
}

function field(obj: Record<string, unknown>, key: string, path: string): unknown {
  if (!(key in obj) || obj[key] === undefined) refuse('missing_field', at(path, key), `${at(path, key)} is required`)
  return obj[key]
}

/** A non-empty string that is not a placeholder. */
function text(input: unknown, path: string): string {
  if (typeof input !== 'string') refuse('wrong_type', path, `${path} must be a string`)
  if (input.trim() === '') refuse('empty', path, `${path} must not be empty`)
  if (isPlaceholder(input))
    refuse('placeholder', path, `${path} holds a placeholder, not a value: ${JSON.stringify(input)}`)
  return input
}

function integer(input: unknown, path: string, min: number): number {
  if (typeof input !== 'number' || !Number.isInteger(input)) refuse('wrong_type', path, `${path} must be an integer`)
  if (input < min) refuse('out_of_range', path, `${path} must be at least ${min}, got ${input}`)
  return input
}

function oneOf<T extends string>(input: unknown, path: string, allowed: readonly T[]): T {
  if (typeof input !== 'string') refuse('wrong_type', path, `${path} must be a string`)
  if (input.trim() === '') refuse('empty', path, `${path} must not be empty`)
  if (!(allowed as readonly string[]).includes(input)) {
    refuse('unknown_value', path, `${path} must be one of ${allowed.join(', ')}, got ${JSON.stringify(input)}`)
  }
  return input as T
}

/** A non-empty list without repeats. */
function nonEmptyList<T>(input: unknown, path: string, item: (value: unknown, path: string) => T): T[] {
  if (!Array.isArray(input)) refuse('wrong_type', path, `${path} must be an array`)
  if (input.length === 0) refuse('empty', path, `${path} must not be empty`)
  const values = input.map((value, index) => item(value, at(path, index)))
  const seen = new Set<string>()
  for (const value of values) {
    const key = JSON.stringify(value)
    if (seen.has(key)) refuse('duplicate', path, `${path} lists ${key} more than once`)
    seen.add(key)
  }
  return values
}

function isNotApplicable(input: unknown): boolean {
  return typeof input === 'object' && input !== null && !Array.isArray(input) && 'notApplicable' in input
}

function notApplicable(input: unknown, path: string): NotApplicable {
  const obj = record(input, path)
  const extra = Object.keys(obj).find((key) => key !== 'notApplicable')
  if (extra !== undefined)
    refuse('unknown_value', at(path, extra), `${at(path, extra)} is not a field of a not-applicable value`)
  return { notApplicable: text(obj.notApplicable, at(path, 'notApplicable')) }
}

function source(input: unknown, path: string): RowSource {
  const obj = record(input, path)
  return {
    document: text(field(obj, 'document', path), at(path, 'document')),
    revision: integer(field(obj, 'revision', path), at(path, 'revision'), 1),
    section: text(field(obj, 'section', path), at(path, 'section'))
  }
}

function taskCases(input: unknown, path: string): TaskCases {
  const obj = record(input, path)
  const extra = Object.keys(obj).find((key) => !(TASK_CASES as readonly string[]).includes(key))
  if (extra !== undefined) {
    refuse('unknown_value', at(path, extra), `${at(path, extra)} is not one of ${TASK_CASES.join(', ')}`)
  }
  const out = {} as TaskCases
  for (const name of TASK_CASES) {
    const casePath = at(path, name)
    const raw = record(field(obj, name, path), casePath)
    if ('present' in raw && 'notApplicable' in raw) {
      refuse('wrong_type', casePath, `${casePath} is either present or not applicable, never both`)
    }
    if ('notApplicable' in raw) out[name] = notApplicable(raw, casePath)
    else out[name] = { present: text(field(raw, 'present', casePath), at(casePath, 'present')) }
  }
  return out
}

function grader(input: unknown, path: string): GraderField {
  const obj = record(input, path)
  return {
    kinds: nonEmptyList(field(obj, 'kinds', path), at(path, 'kinds'), (v, p) => oneOf(v, p, GRADER_KINDS)),
    detail: text(field(obj, 'detail', path), at(path, 'detail'))
  }
}

/** Reads one of the ten fields to its value. `suite` is checked against the declared suites by the caller. */
function requiredField<K extends RequiredField>(key: K, input: unknown, path: string): RequiredFields[K] {
  switch (key) {
    case 'contract':
    case 'officialBasis':
    case 'decisionRule':
    case 'migrationGate':
      return text(input, path) as RequiredFields[K]
    case 'owner':
      return oneOf(input, path, REGISTRY_OWNERS) as RequiredFields[K]
    case 'suite':
      return nonEmptyList(input, path, suiteRef) as RequiredFields[K]
    case 'tasks':
      return taskCases(input, path) as RequiredFields[K]
    case 'grader':
      return grader(input, path) as RequiredFields[K]
    case 'backends':
      return nonEmptyList(input, path, (v, p) => oneOf(v, p, BACKENDS)) as RequiredFields[K]
    case 'cadence':
      return nonEmptyList(input, path, (v, p) => oneOf(v, p, CADENCES)) as RequiredFields[K]
  }
  throw new Error(`unhandled field ${key}`)
}

function suiteRef(input: unknown, path: string): string {
  const value = text(input, path)
  const match = SUITE_REF.exec(value)
  if (match === null || !SUITE_NAME.test(match[1] as string)) {
    refuse('bad_suite_ref', path, `${path} must name a suite as <name>@<version>, got ${JSON.stringify(value)}`)
  }
  return value
}

/** The reference a row uses for a declared suite. */
export function suiteId(suite: Pick<SuiteDeclaration, 'name' | 'version'>): string {
  return `${suite.name}@${suite.version}`
}

// ── Module catalog ──────────────────────────────────────────────────────────

function suiteDeclaration(input: unknown, path: string): SuiteDeclaration {
  const obj = record(input, path)
  const name = text(field(obj, 'name', path), at(path, 'name'))
  if (!SUITE_NAME.test(name))
    refuse('bad_name', at(path, 'name'), `${at(path, 'name')} must be a stable lowercase suite name`)
  return {
    name,
    version: integer(field(obj, 'version', path), at(path, 'version'), 1),
    layer: oneOf(field(obj, 'layer', path), at(path, 'layer'), EVALUATION_LAYERS)
  }
}

function moduleEntry(input: unknown, path: string): ModuleEntry {
  const obj = record(input, path)
  const id = text(field(obj, 'id', path), at(path, 'id'))
  if (!MODULE_ID.test(id))
    refuse('bad_name', at(path, 'id'), `${at(path, 'id')} must be a §6 module number such as 6.1`)
  const rawExcluded = field(obj, 'excluded', path)
  const excluded = rawExcluded === null ? null : text(rawExcluded, at(path, 'excluded'))
  const rawScope = obj.scope
  if (rawScope !== undefined && rawScope !== 'system')
    refuse('unknown_value', at(path, 'scope'), `${at(path, 'scope')} must be "system" when present`)
  const suitesPath = at(path, 'suites')
  const rawSuites = field(obj, 'suites', path)
  if (!Array.isArray(rawSuites)) refuse('wrong_type', suitesPath, `${suitesPath} must be an array`)
  const suites = rawSuites.map((value, index) => suiteDeclaration(value, at(suitesPath, index)))
  if (excluded === null && suites.length === 0)
    refuse('empty', suitesPath, `module ${id} must declare at least one suite`)
  if (excluded !== null && suites.length > 0) {
    refuse('wrong_type', suitesPath, `module ${id} is excluded and declares no suite`)
  }
  const entry = {
    id,
    title: text(field(obj, 'title', path), at(path, 'title')),
    source: source(field(obj, 'source', path), at(path, 'source')),
    excluded,
    suites
  } as ModuleEntry
  if (rawScope === 'system') {
    if (excluded !== null)
      refuse('wrong_type', at(path, 'scope'), `module ${id} is excluded and cannot be system scope`)
    entry.scope = 'system'
  }
  const declared = new Set(suites.map(suiteId))
  for (const key of REQUIRED_FIELDS) {
    const raw = field(obj, key, path)
    const fieldPath = at(path, key)
    if (isNotApplicable(raw)) {
      if (excluded === null) {
        refuse('not_applicable_refused', fieldPath, `${fieldPath} may be not applicable only on an excluded module`)
      }
      ;(entry as Record<string, unknown>)[key] = notApplicable(raw, fieldPath)
      continue
    }
    const value = requiredField(key, raw, fieldPath)
    if (key === 'suite') {
      const refs = value as string[]
      refs.forEach((ref, index) => {
        if (!declared.has(ref))
          refuse('unknown_suite', at(fieldPath, index), `module ${id} does not declare suite ${ref}`)
      })
    }
    ;(entry as Record<string, unknown>)[key] = value
  }
  return entry
}

function catalog(input: unknown, path: string): ModuleCatalog {
  const obj = record(input, path)
  const modulesPath = at(path, 'modules')
  const raw = field(obj, 'modules', path)
  const modules = nonEmptyList(raw, modulesPath, moduleEntry)
  const ids = new Map<string, number>()
  const suites = new Map<string, string>()
  modules.forEach((module, index) => {
    const prior = ids.get(module.id)
    if (prior !== undefined) {
      refuse(
        'duplicate',
        at(at(modulesPath, index), 'id'),
        `module ${module.id} is listed at ${at(modulesPath, prior)} and ${at(modulesPath, index)}`
      )
    }
    ids.set(module.id, index)
    for (const suite of module.suites) {
      const owner = suites.get(suite.name)
      if (owner !== undefined) {
        refuse(
          'duplicate',
          at(at(modulesPath, index), 'suites'),
          `suite ${suite.name} is declared by modules ${owner} and ${module.id}`
        )
      }
      suites.set(suite.name, module.id)
    }
  })
  return { modules }
}

export function validateModuleCatalog(input: unknown, location = ''): RegistryResult<ModuleCatalog> {
  return run(() => catalog(input, location))
}

// ── Component rows ──────────────────────────────────────────────────────────

function componentRow(input: unknown, path: string, modules: ReadonlyMap<string, ModuleEntry>): ComponentRow {
  const obj = record(input, path)
  const kind = oneOf(field(obj, 'kind', path), at(path, 'kind'), COMPONENT_KINDS)
  const id = text(field(obj, 'id', path), at(path, 'id'))
  if (!id.startsWith(`${kind}:`) || id.length === kind.length + 1) {
    refuse('bad_name', at(path, 'id'), `${at(path, 'id')} must read ${kind}:<name>, got ${JSON.stringify(id)}`)
  }
  const moduleId = text(field(obj, 'module', path), at(path, 'module'))
  const module = modules.get(moduleId)
  if (module === undefined)
    refuse('unknown_module', at(path, 'module'), `${id} names module ${moduleId}, which the catalog does not list`)
  if (module.excluded !== null) {
    refuse(
      'module_excluded',
      at(path, 'module'),
      `${id} names module ${moduleId}, which is excluded: ${module.excluded}`
    )
  }
  const row = {
    id,
    kind,
    module: moduleId,
    source: source(field(obj, 'source', path), at(path, 'source'))
  } as ComponentRow
  if (obj.additionalModules !== undefined) {
    const listPath = at(path, 'additionalModules')
    if (!Array.isArray(obj.additionalModules)) refuse('wrong_type', listPath, `${listPath} must be an array`)
    const named = new Set<string>([moduleId])
    row.additionalModules = obj.additionalModules.map((value, index) => {
      const entryPath = at(listPath, index)
      const other = text(value, entryPath)
      const found = modules.get(other)
      if (found === undefined)
        refuse('unknown_module', entryPath, `${id} names module ${other}, which the catalog does not list`)
      if (found.excluded !== null)
        refuse('module_excluded', entryPath, `${id} names module ${other}, which is excluded: ${found.excluded}`)
      if (named.has(other))
        refuse('duplicate', entryPath, `${id} names module ${other} twice; additionalModules never repeats module`)
      named.add(other)
      return other
    })
  }
  const declared = new Set(module.suites.map(suiteId))
  for (const key of REQUIRED_FIELDS) {
    const raw = field(obj, key, path)
    const fieldPath = at(path, key)
    if (isNotApplicable(raw)) {
      refuse('not_applicable_refused', fieldPath, `${fieldPath} must carry a value; a component row states every field`)
    }
    const value = requiredField(key, raw, fieldPath)
    if (key === 'suite') {
      ;(value as string[]).forEach((ref, index) => {
        if (!declared.has(ref)) {
          refuse(
            'unknown_suite',
            at(fieldPath, index),
            `${id} names suite ${ref}, which module ${moduleId} does not declare`
          )
        }
      })
    }
    ;(row as unknown as Record<string, unknown>)[key] = value
  }
  return row
}

function moduleIndex(catalog: ModuleCatalog): Map<string, ModuleEntry> {
  return new Map(catalog.modules.map((module) => [module.id, module]))
}

export function validateComponentRow(
  input: unknown,
  catalog: ModuleCatalog,
  location = ''
): RegistryResult<ComponentRow> {
  return run(() => componentRow(input, location, moduleIndex(catalog)))
}

// ── Shards and aggregation ──────────────────────────────────────────────────

function shardHeader(obj: Record<string, unknown>, location: string): { shard: string; kinds: ComponentKind[] } {
  integer(field(obj, 'schemaVersion', location), at(location, 'schemaVersion'), 1)
  const shard = text(field(obj, 'shard', location), at(location, 'shard'))
  if (!SHARD_NAME.test(shard))
    refuse('bad_name', at(location, 'shard'), `${at(location, 'shard')} must be a lowercase kebab name`)
  const file = basename(location.split('#')[0] ?? '', '.json')
  if (location !== '' && file !== shard) {
    refuse('bad_name', at(location, 'shard'), `shard ${shard} must live in a file named ${shard}.json`)
  }
  const kinds = nonEmptyList(field(obj, 'kinds', location), at(location, 'kinds'), (v, p) =>
    oneOf(v, p, COMPONENT_KINDS)
  )
  return { shard, kinds }
}

function shard(input: unknown, location: string, modules: ReadonlyMap<string, ModuleEntry>): Shard {
  const obj = record(input, location)
  const { shard: name, kinds } = shardHeader(obj, location)
  const rowsPath = at(location, 'components')
  const raw = field(obj, 'components', location)
  if (!Array.isArray(raw)) refuse('wrong_type', rowsPath, `${rowsPath} must be an array`)
  const components = raw.map((value, index) => {
    const row = componentRow(value, at(rowsPath, index), modules)
    if (!kinds.includes(row.kind)) {
      refuse(
        'kind_not_declared',
        at(at(rowsPath, index), 'kind'),
        `${row.id} is of kind ${row.kind}, which shard ${name} does not declare`
      )
    }
    return row
  })
  return { shard: name, kinds, components }
}

export function validateShard(input: unknown, catalog: ModuleCatalog, location = ''): RegistryResult<Shard> {
  return run(() => shard(input, location, moduleIndex(catalog)))
}

/**
 * Validates every shard against the catalog and joins their rows. A component
 * id appearing twice — in one shard or in two — is refused, naming both
 * locations.
 */
export function aggregateShards(catalog: ModuleCatalog, inputs: readonly ShardInput[]): RegistryResult<Registry> {
  return run(() => {
    const modules = moduleIndex(catalog)
    const shards: Shard[] = []
    const components: Registry['components'] = []
    const seen = new Map<string, string>()
    const names = new Map<string, string>()
    for (const input of inputs) {
      const value = shard(input.content, input.location, modules)
      const priorShard = names.get(value.shard)
      if (priorShard !== undefined) {
        refuse(
          'duplicate',
          at(input.location, 'shard'),
          `shard ${value.shard} is declared by ${priorShard} and ${input.location}`
        )
      }
      names.set(value.shard, input.location)
      value.components.forEach((row, index) => {
        const location = at(at(input.location, 'components'), index)
        const prior = seen.get(row.id)
        if (prior !== undefined) {
          refuse(
            'duplicate_component',
            at(location, 'id'),
            `component ${row.id} appears at ${prior} and at ${location}`
          )
        }
        seen.set(row.id, location)
        components.push({ location, row })
      })
      shards.push(value)
    }
    return { catalog, shards, components }
  })
}

/**
 * Lists a shard directory: every `.json` file in it, in name order, read and
 * parsed. Discovery is by listing alone, so adding a shard is adding a file.
 */
export function readShardDirectory(dir: string, locationPrefix = basename(dir)): RegistryResult<ShardInput[]> {
  return run(() =>
    readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort()
      .map((name) => {
        const location = `${locationPrefix}/${name}`
        return { location, content: parseJson(join(dir, name), location) }
      })
  )
}

function parseJson(file: string, location: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    refuse('unreadable', location, `${location} is not readable JSON: ${(error as Error).message}`)
  }
}

/** Reads the catalog file and every shard in the directory, and aggregates them. */
export function loadRegistry(modulesFile: string, shardsDir: string): RegistryResult<Registry> {
  const catalogResult = run(() => catalog(parseJson(modulesFile, basename(modulesFile)), basename(modulesFile)))
  if (!catalogResult.ok) return catalogResult
  const inputs = readShardDirectory(shardsDir)
  if (!inputs.ok) return inputs
  return aggregateShards(catalogResult.value, inputs.value)
}

// ── Shard completeness ──────────────────────────────────────────────────────

/** One component named by kind and by its name within that kind. */
export interface ComponentRef {
  kind: ComponentKind
  name: string
}

export interface ShardCompleteness {
  complete: boolean
  /** The kinds checked: exactly those the shard declares. */
  kinds: ComponentKind[]
  /** In a kind's universe, with no row in the shard. */
  missing: ComponentRef[]
  /** A row in the shard naming no member of its kind's universe, or repeating one. */
  extra: ComponentRef[]
  /** Rows refused by validation: an empty or placeholder field, an unknown module or suite. */
  invalid: RegistryRefusal[]
}

/**
 * Checks one shard against the universes its caller derives from typed
 * sources: every member of a declared kind's universe has exactly one row, no
 * row names anything else, and every row validates. Kinds the shard does not
 * declare are not looked at; a declared kind with no universe is refused.
 */
export function checkShardCompleteness(
  input: unknown,
  catalog: ModuleCatalog,
  universes: Partial<Record<ComponentKind, readonly string[]>>,
  location = ''
): RegistryResult<ShardCompleteness> {
  return run(() => {
    const modules = moduleIndex(catalog)
    const obj = record(input, location)
    const { kinds } = shardHeader(obj, location)
    for (const kind of kinds) {
      if (universes[kind] === undefined) {
        refuse('missing_field', at(location, 'kinds'), `no universe was derived for declared kind ${kind}`)
      }
    }
    const rowsPath = at(location, 'components')
    const raw = field(obj, 'components', location)
    if (!Array.isArray(raw)) refuse('wrong_type', rowsPath, `${rowsPath} must be an array`)

    const invalid: RegistryRefusal[] = []
    const extra: ComponentRef[] = []
    const covered = new Map<ComponentKind, Set<string>>(kinds.map((kind) => [kind, new Set<string>()]))
    raw.forEach((value, index) => {
      const rowPath = at(rowsPath, index)
      const result = run(() => componentRow(value, rowPath, modules))
      if (!result.ok) invalid.push(result.refusal)
      // Coverage is read from the row's own kind and id even when another field is refused.
      const loose = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
      const kind = loose.kind as ComponentKind
      const id = typeof loose.id === 'string' ? loose.id : ''
      const name = id.startsWith(`${String(kind)}:`) ? id.slice(String(kind).length + 1) : id
      const seen = covered.get(kind)
      if (seen === undefined || !(universes[kind] as readonly string[]).includes(name) || seen.has(name)) {
        extra.push({ kind, name })
        return
      }
      seen.add(name)
    })
    const missing: ComponentRef[] = kinds.flatMap((kind) =>
      (universes[kind] as readonly string[])
        .filter((name) => !(covered.get(kind) as Set<string>).has(name))
        .map((name) => ({ kind, name }))
    )
    return { complete: missing.length + extra.length + invalid.length === 0, kinds, missing, extra, invalid }
  })
}
