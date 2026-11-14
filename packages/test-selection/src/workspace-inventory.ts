/**
 * An inventory view built from one commit's own package manifests, for a
 * repository with no inventory program of its own: one suite per package whose
 * `test` script starts Bun's test runner or Vitest, and every test-named file
 * as a test of the deepest package that holds it. It reads only through the
 * repository reader it is given, for exactly the commit it is given.
 */
import { posix } from 'node:path'
import { type InventoryDeclarations, inventoryViewOf, TEST_FILE_NAME } from './memory-inventory.js'
import { discoverWorkspaceDirs, revisionTree, testRunnerOf } from './selector.js'
import type { InventoryView, RepositoryReader } from './types.js'

/** The schema name of a view {@link workspaceInventory} builds. */
export const WORKSPACE_INVENTORY_SCHEMA = 'workspace-inventory@1'

/** Why a package has no suite: it declares no `test` script, or its `test` script starts another runner. */
export type LeftOutReason = 'no-test-script' | 'other-runner'

/** A package the inventory has no suite for, and why. */
export type LeftOutPackage = {
  /** Repository-relative folder; `.` for the root package. */
  dir: string
  /** The manifest's `name`, or `null` for a root manifest with none. */
  name: string | null
  reason: LeftOutReason
  /** The `test` script as written, or `null` when there is none. */
  script: string | null
}

/** What {@link workspaceInventory} returns: the commit's view and what it left out. */
export type WorkspaceInventory = {
  view: InventoryView
  leftOut: {
    packages: LeftOutPackage[]
    /** Test-named files that belong to no suite: under no package with a suite, or in a left-out package. */
    tests: string[]
  }
}

/** The folder virtual paths are read under; never a place on disk. */
const VIRTUAL_ROOT = '/workspace-inventory'

type Manifest = { name?: unknown; scripts?: { test?: unknown } }

function manifestAt(read: (path: string) => string | null, dir: string): Manifest | null {
  try {
    const parsed: unknown = JSON.parse(read(posix.join(VIRTUAL_ROOT, dir, 'package.json')) ?? '')
    return parsed !== null && typeof parsed === 'object' ? (parsed as Manifest) : null
  } catch {
    return null
  }
}

const depth = (dir: string): number => (dir === '.' ? 0 : dir.split('/').length)

/** Whether `path` sits inside the package folder `dir`. */
const holds = (dir: string, path: string): boolean => dir === '.' || path.startsWith(`${dir}/`)

/**
 * One commit's inventory view, from the root manifest's `workspaces` field and
 * each member's manifest. A package gets a suite when its `test` script starts
 * `bun test` or Vitest; a package with no `test` script or another runner is
 * left out with its reason. The root package gets a suite on the same rule
 * from its own `test` script; a root manifest that declares no workspaces
 * yields the root suite alone. Every test-named file (`*.test.*`, `*.spec.*`)
 * belongs to the deepest package folder that holds it; when that package has
 * no suite, or no package holds it, the file is left out.
 */
export function workspaceInventory(repo: RepositoryReader, revision: string): WorkspaceInventory {
  const files = repo.list(revision)
  const tree = revisionTree(repo, revision, files, VIRTUAL_ROOT)
  const read = (path: string): string | null => tree.readFile(path)

  const packages: { dir: string; name: string | null; script: string | null }[] = []
  const root = manifestAt(read, '.')
  if (root) {
    const name = typeof root.name === 'string' && root.name.length > 0 ? root.name : null
    const script = typeof root.scripts?.test === 'string' ? root.scripts.test : null
    packages.push({ dir: '.', name, script })
    for (const dir of discoverWorkspaceDirs(tree)) {
      const member = manifestAt(read, dir)
      if (!member || typeof member.name !== 'string') continue
      const memberScript = typeof member.scripts?.test === 'string' ? member.scripts.test : null
      packages.push({ dir, name: member.name, script: memberScript })
    }
  }

  const suites: InventoryDeclarations['suites'] = []
  const leftOutPackages: LeftOutPackage[] = []
  const usedIds = new Set<string>()
  for (const pkg of packages) {
    const runner = testRunnerOf(pkg.script ?? undefined)
    if (runner === 'bun' || runner === 'vitest') {
      let id = pkg.name ?? 'root'
      if (usedIds.has(id)) id = `${id}@${pkg.dir}`
      usedIds.add(id)
      suites.push({ id, dir: pkg.dir, runner, preload: null })
    } else
      leftOutPackages.push({
        dir: pkg.dir,
        name: pkg.name,
        reason: runner === 'none' ? 'no-test-script' : 'other-runner',
        script: pkg.script
      })
  }
  // `inventoryViewOf` gives a test to the first suite whose folder holds it: deepest folder first, the root last.
  suites.sort((a, b) => depth(b.dir) - depth(a.dir) || a.dir.localeCompare(b.dir))

  // A test-named file belongs to the deepest package folder holding it, suite or not.
  const byDepth = [...packages].sort((a, b) => depth(b.dir) - depth(a.dir) || a.dir.localeCompare(b.dir))
  const suiteDirs = new Set(suites.map((s) => s.dir))
  const kept: Record<string, string> = {}
  const leftOutTests: string[] = []
  for (const path of files) {
    if (!TEST_FILE_NAME.test(path)) continue
    const owner = byDepth.find((pkg) => holds(pkg.dir, path))
    if (owner && suiteDirs.has(owner.dir)) kept[path] = ''
    else leftOutTests.push(path)
  }

  const built = inventoryViewOf(revision, kept, {
    suites,
    edges: [],
    unknowns: [],
    policies: []
  })
  const view: InventoryView = {
    ...built,
    schemaIdentity: WORKSPACE_INVENTORY_SCHEMA,
    workspaces: packages.filter((pkg) => pkg.dir !== '.').map((pkg) => pkg.dir)
  }
  return {
    view,
    leftOut: {
      packages: leftOutPackages.sort((a, b) => a.dir.localeCompare(b.dir)),
      tests: leftOutTests.sort()
    }
  }
}
