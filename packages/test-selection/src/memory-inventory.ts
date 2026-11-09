/**
 * An inventory view built straight from a revision's file list and a small
 * declaration — the view a repository with one runner per folder would build.
 * It is what an example, a fixture or a caller with no inventory program of
 * its own hands {@link selectTests}; a real repository validates its own
 * inventory instead.
 */
import { posix } from 'node:path'
import { stableHash } from './inventory.js'
import type { InventoryView, ResolvedEdge } from './types.js'

/** The declarations {@link inventoryViewOf} builds a view from. */
export type InventoryDeclarations = {
  suites: { id: string; dir: string; runner: 'bun' | 'vitest'; preload: string | null }[]
  /** Readers name test ids, or `suite:<id>` for every test of a suite. */
  edges: ResolvedEdge[]
  unknowns: { scope: string; reason: string }[]
  policies: InventoryView['policies']
}

/** What a test file is called: `*.test.*` or `*.spec.*`. */
export const TEST_FILE_NAME = /\.(test|spec)\.[cm]?[jt]sx?$/

/** One revision's inventory view: every test-named file belongs to the first suite whose folder holds it. */
export function inventoryViewOf(
  revision: string,
  files: Record<string, string>,
  decl: InventoryDeclarations,
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
      if (!suite || !TEST_FILE_NAME.test(path)) return []
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
