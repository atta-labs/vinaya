/**
 * The consumer config the `test-selection` command reads with `--config`: a
 * JSON document stating the rest of what a selection takes beyond the
 * inventory built from the workspace manifests — the import walk's depth,
 * folder-scanning tests, programs tests start, data folders, always-run
 * obligations, whole-suite policies, and declared inputs (files a test reads
 * without importing them). It is validated whole before anything is selected,
 * and an unknown key or a value of the wrong shape is refused naming the key.
 */
import { stableHash } from './inventory.js'
import type { PathAlias } from './path-aliases.js'
import type { ScannerDeclaration, ScannerTrigger } from './scanner-inputs.js'
import type { SpawnProgram } from './spawn-inputs.js'
import type { InventoryView, ResolvedEdge, SelectionObligation, SelectionPolicy, WholeSuitePolicy } from './types.js'

/** A file or folder (ending in `/`) some tests read without importing it, and the tests that read it. */
export type DeclaredInput = { path: string; readers: string[] }

/** A validated consumer config: the selection policy it states, and its declared inputs. */
export type ConsumerConfig = { policy: SelectionPolicy; inputs: DeclaredInput[] }

/** A consumer config the command refuses; the message names the offending key. */
export class ConsumerConfigError extends Error {}

const TOP_KEYS = [
  'depth',
  'pathAliases',
  'scanners',
  'spawnPrograms',
  'dataFolders',
  'alwaysRun',
  'wholeSuites',
  'inputs'
] as const
const TRIGGERS: readonly ScannerTrigger[] = ['tree-shape', 'process-start', 'listed-files', 'content']

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value)

function fail(key: string, detail: string): never {
  throw new ConsumerConfigError(`${key} ${detail}`)
}

function objectAt(value: unknown, key: string, keys: readonly string[], required: readonly string[]): Json {
  if (!isObject(value)) fail(key, 'is not an object')
  for (const name of Object.keys(value)) if (!keys.includes(name)) fail(`${key}.${name}`, 'is not a known key')
  for (const name of required) if (!(name in value)) fail(`${key}.${name}`, 'is missing')
  return value
}

function stringAt(value: unknown, key: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(key, 'is not a non-empty string')
  return value
}

function stringsAt(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) fail(key, 'is not a list of non-empty strings')
  return value.map((item, i) => stringAt(item, `${key}[${i}]`))
}

function listAt<T>(value: unknown, key: string, item: (entry: unknown, at: string) => T): T[] {
  if (!Array.isArray(value)) fail(key, 'is not a list')
  return value.map((entry, i) => item(entry, `${key}[${i}]`))
}

/**
 * The validated config of a parsed JSON document. Absent keys keep the
 * command's own defaults: a transitive walk and nothing declared.
 */
export function parseConsumerConfig(document: unknown): ConsumerConfig {
  if (!isObject(document)) throw new ConsumerConfigError('the document is not a JSON object')
  for (const name of Object.keys(document))
    if (!(TOP_KEYS as readonly string[]).includes(name)) fail(name, 'is not a known key')

  const policy: SelectionPolicy = { depth: 'transitive' }
  if ('depth' in document) {
    if (document.depth !== 'one' && document.depth !== 'transitive') fail('depth', 'is not "one" or "transitive"')
    policy.depth = document.depth
  }
  if ('scanners' in document)
    policy.scanners = listAt(document.scanners, 'scanners', (entry, at): ScannerDeclaration => {
      const value = objectAt(entry, at, ['test', 'roots', 'trigger'], ['test', 'roots', 'trigger'])
      const trigger = value.trigger
      if (typeof trigger !== 'string' || !(TRIGGERS as readonly string[]).includes(trigger))
        fail(`${at}.trigger`, `is not one of ${TRIGGERS.join(', ')}`)
      return {
        test: stringAt(value.test, `${at}.test`),
        roots: stringsAt(value.roots, `${at}.roots`),
        trigger: trigger as ScannerTrigger
      }
    })
  if ('spawnPrograms' in document)
    policy.spawnPrograms = listAt(document.spawnPrograms, 'spawnPrograms', (entry, at): SpawnProgram => {
      const value = objectAt(entry, at, ['binary', 'entrypoint'], ['binary', 'entrypoint'])
      return {
        binary: stringAt(value.binary, `${at}.binary`),
        entrypoint: stringAt(value.entrypoint, `${at}.entrypoint`)
      }
    })
  if ('pathAliases' in document)
    policy.pathAliases = listAt(document.pathAliases, 'pathAliases', (entry, at): PathAlias => {
      const value = objectAt(entry, at, ['prefix', 'directory'], ['prefix', 'directory'])
      const prefix = stringAt(value.prefix, `${at}.prefix`)
      const directory = stringAt(value.directory, `${at}.directory`)
      if (!prefix.endsWith('/')) fail(`${at}.prefix`, 'does not end in "/"')
      if (!directory.endsWith('/')) fail(`${at}.directory`, 'does not end in "/"')
      return { prefix, directory }
    })
  if ('dataFolders' in document) policy.dataFolders = stringsAt(document.dataFolders, 'dataFolders')
  if ('alwaysRun' in document)
    policy.obligations = listAt(document.alwaysRun, 'alwaysRun', (entry, at): SelectionObligation => {
      const value = objectAt(entry, at, ['id', 'reason', 'tests', 'suites'], ['id', 'reason'])
      if (!('tests' in value) && !('suites' in value)) fail(at, 'names neither tests nor suites')
      const obligation: SelectionObligation = {
        id: stringAt(value.id, `${at}.id`),
        kind: 'policy',
        reason: stringAt(value.reason, `${at}.reason`)
      }
      return {
        ...obligation,
        ...('tests' in value ? { tests: stringsAt(value.tests, `${at}.tests`) } : {}),
        ...('suites' in value ? { suites: stringsAt(value.suites, `${at}.suites`) } : {})
      }
    })
  if ('wholeSuites' in document)
    policy.wholeSuites = listAt(document.wholeSuites, 'wholeSuites', (entry, at): WholeSuitePolicy => {
      const value = objectAt(entry, at, ['suite', 'reason'], ['suite', 'reason'])
      return { suite: stringAt(value.suite, `${at}.suite`), reason: stringAt(value.reason, `${at}.reason`) }
    })
  const inputs =
    'inputs' in document
      ? listAt(document.inputs, 'inputs', (entry, at): DeclaredInput => {
          const value = objectAt(entry, at, ['path', 'readers'], ['path', 'readers'])
          return { path: stringAt(value.path, `${at}.path`), readers: stringsAt(value.readers, `${at}.readers`) }
        })
      : []
  return { policy, inputs }
}

/**
 * `view` with each declared input as an edge — kind `fixture`, reader kind
 * `raw-bytes`, source `config:<index>` — keeping only the readers that are
 * tests of this view, so a commit that lacks a named test (one a later commit
 * adds, or an earlier one deleted) still gives a valid view. With no input
 * the view is returned unchanged.
 */
export function withDeclaredInputs(view: InventoryView, inputs: readonly DeclaredInput[]): InventoryView {
  if (inputs.length === 0) return view
  const ids = new Set(view.tests.map((test) => test.id))
  const edges: ResolvedEdge[] = inputs.map((input, index) => ({
    input: input.path,
    kind: 'fixture',
    readerKind: 'raw-bytes',
    readers: [...new Set(input.readers)].filter((reader) => ids.has(reader)).sort(),
    source: `config:${index}`
  }))
  return {
    ...view,
    edges: [...view.edges, ...edges],
    declarationIdentity: stableHash({ declarations: view.declarationIdentity, inputs }),
    contextIdentity: stableHash({ context: view.contextIdentity, inputs }),
    graphIdentity: stableHash({ graph: view.graphIdentity, edges })
  }
}
