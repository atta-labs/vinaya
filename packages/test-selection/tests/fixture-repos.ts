/**
 * The committed fixture repositories the selection tests read, and the
 * inventory views a repository would build for each of their revisions.
 * Imports only the public entrypoint, so it travels with a copy of this
 * directory.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type InventoryDeclarations,
  inventoryViewOf,
  memoryRepository,
  type RepositoryReader,
  type SelectionPolicy,
  type SelectTestsInput,
  TEST_FILE_NAME
} from '../src/index.js'

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

export type FixtureDeclarations = InventoryDeclarations

/** One revision's inventory view, built the way a repository would from the fixture's declarations. */
export const viewOf = inventoryViewOf

export const TEST_NAME = TEST_FILE_NAME

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
