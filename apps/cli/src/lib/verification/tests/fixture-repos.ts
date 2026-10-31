/**
 * The committed fixture repositories the selection tests read, and the
 * inventory views a repository would build for each of their revisions.
 * Imports only the public entrypoint, so it travels with a copy of this
 * directory.
 */
import { readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import {
  type InventoryView,
  memoryRepository,
  type RepositoryReader,
  type ResolvedEdge,
  type SelectionPolicy,
  type SelectTestsInput,
  stableHash
} from '../index.js'

export type Scenario = {
  name: string
  depth: 'one' | 'transitive'
  change?: Record<string, string | null>
  rename?: Record<string, string>
  headInventory?: { dropEdges?: string[] }
  policy?: Partial<SelectionPolicy>
  required: string[]
  requiredRevision?: Record<string, 'base' | 'head'>
  fallbacks: string[]
  removedTests?: string[]
  renamedTests?: { from: string; to: string }[]
  policies?: string[]
}

export type FixtureDeclarations = {
  suites: { id: string; dir: string; runner: 'bun' | 'vitest'; preload: string | null }[]
  /** Readers name test ids, or `suite:<id>` for every test of a suite. */
  edges: ResolvedEdge[]
  unknowns: { scope: string; reason: string }[]
  policies: InventoryView['policies']
}

export type Fixture = {
  files: Record<string, string>
  inventory: FixtureDeclarations
  policy: Pick<SelectionPolicy, 'scanners' | 'spawnPrograms'>
  scenarios: Scenario[]
}

export const FIXTURES = ['workspaces-repo.json', 'flat-repo.json'] as const

export function fixture(name: (typeof FIXTURES)[number]): Fixture {
  return JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', name), 'utf8')) as Fixture
}

export const TEST_NAME = /\.(test|spec)\.[cm]?[jt]sx?$/

/** One revision's inventory view, built the way a repository would from the fixture's declarations. */
export function viewOf(
  revision: string,
  files: Record<string, string>,
  decl: FixtureDeclarations,
  dropEdges: readonly string[] = []
): InventoryView {
  const suites = decl.suites.map((s) => ({
    id: s.id,
    owner: s.id,
    kind: 'workspace' as const,
    dir: s.dir,
    cwd: s.dir,
    runner: s.runner,
    preload: s.preload,
    environment: {},
    configFiles: [posix.join(s.dir, 'package.json')],
    include: [],
    exclude: []
  }))
  const tests = Object.keys(files)
    .sort()
    .flatMap((path) => {
      const suite = suites.find((s) => s.dir === '.' || path.startsWith(`${s.dir}/`))
      if (!suite || !TEST_NAME.test(path)) return []
      return [
        {
          id: path,
          suite: suite.id,
          owner: suite.owner,
          kind: suite.kind,
          runner: suite.runner,
          cwd: suite.cwd,
          preload: suite.preload,
          environment: {}
        }
      ]
    })
  const ids = new Set(tests.map((t) => t.id))
  const edges = decl.edges
    .filter((e) => !dropEdges.includes(e.source))
    .map((e) => ({
      ...e,
      readers: e.readers
        .flatMap((r) => (r.startsWith('suite:') ? tests.filter((t) => t.suite === r.slice(6)).map((t) => t.id) : [r]))
        .filter((r) => ids.has(r))
        .sort()
    }))
  return {
    revision,
    modeled: true,
    schemaIdentity: 'fixture-inventory@1',
    declarationVersion: 1,
    declarationIdentity: stableHash(decl),
    contextIdentity: stableHash({ suites, decl }),
    graphIdentity: stableHash({ revision, suites, tests, edges, unknowns: decl.unknowns }),
    workspaces: [],
    suites,
    tests,
    exclusions: [],
    typeInputs: [],
    edges,
    unknowns: decl.unknowns,
    policies: decl.policies,
    problems: []
  }
}

/** A scenario's head files: the fixture's files with its changes and renames applied. */
export function headFiles(fx: Fixture, scenario: Scenario): Record<string, string> {
  const files = { ...fx.files }
  for (const [path, text] of Object.entries(scenario.change ?? {})) {
    if (text === null) delete files[path]
    else files[path] = text
  }
  for (const [from, to] of Object.entries(scenario.rename ?? {})) {
    files[to] = files[from] as string
    delete files[from]
  }
  return files
}

/** The `selectTests` input for one scenario, over an in-memory repository unless another reader is given. */
export function scenarioInput(
  fx: Fixture,
  scenario: Scenario,
  revisions: { repo?: RepositoryReader; base?: string; head?: string } = {}
): SelectTestsInput {
  const head = headFiles(fx, scenario)
  const baseRev = revisions.base ?? 'base'
  const headRev = revisions.head ?? 'head'
  return {
    repo: revisions.repo ?? memoryRepository({ [baseRev]: fx.files, [headRev]: head }),
    base: baseRev,
    head: headRev,
    inventory: {
      head: viewOf(headRev, head, fx.inventory, scenario.headInventory?.dropEdges),
      base: viewOf(baseRev, fx.files, fx.inventory)
    },
    policy: { depth: scenario.depth, ...fx.policy, ...scenario.policy }
  }
}
