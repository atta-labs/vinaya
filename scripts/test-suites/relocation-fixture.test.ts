/**
 * The relocation proof: one small repository written in five layouts —
 * today's tree, the kernel re-rooted under `harness/kernel`, the process
 * re-rooted under `harness/processes/vinaya-strict`, a driver moved from the
 * CLI into the process, and that move with the old path kept as a
 * compatibility re-export — selects the same affected tests in every layout
 * once each selected path is mapped back through the relocation map.
 *
 * Each layout is a real tree on disk, read by the real selector (its own
 * workspace discovery, import graph and CI eligibility) and by the inventory
 * (its declared fixture, preload and spawned-program edges), the two answers
 * joined. Nothing here selects by owner or folder: a test is affected only
 * through an import, a declared input, or a test file changed itself.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { discoveredLayout, isSelectablePath } from '../../apps/cli/src/lib/ci-test-selection.ts'
import { discoverWorkspaceDirs, selectAffectedTestFiles } from '../../apps/cli/src/lib/test-selector.ts'
import {
  buildInventoryView,
  changedInputReaders,
  diffTestIdentities,
  INVENTORY_PATH,
  type InventoryDeclarations,
  layoutOf,
  memoryReader
} from './inventory-check.ts'

type Layout = 'today' | 'kernel-re-root' | 'process-re-root' | 'driver-move' | 'compatibility-re-export'
const LAYOUTS: readonly Layout[] = [
  'today',
  'kernel-re-root',
  'process-re-root',
  'driver-move',
  'compatibility-re-export'
]

/** Where each moving part sits in a layout. Today's paths are the canonical identities. */
function placesOf(layout: Layout) {
  const kernel = layout === 'today' ? 'harness' : 'harness/kernel'
  const processDir =
    layout === 'today' || layout === 'kernel-re-root' ? 'processes/vinaya' : 'harness/processes/vinaya-strict'
  const moved = layout === 'driver-move' || layout === 'compatibility-re-export'
  return {
    kernel,
    process: processDir,
    workspaces: [
      'apps/*',
      layout === 'today' ? 'harness' : 'harness/kernel',
      layout === 'today' || layout === 'kernel-re-root' ? 'processes/*' : 'harness/processes/*'
    ],
    driver: moved ? `${processDir}/loops/driver.ts` : 'apps/cli/src/lib/driver.ts',
    /** The old driver path, kept as a re-export, only in the compatibility layout. */
    shim: layout === 'compatibility-re-export' ? 'apps/cli/src/lib/driver.ts' : null
  }
}

/** Maps a layout's path back to today's — the relocation map. */
function canonical(layout: Layout, path: string): string {
  const places = placesOf(layout)
  if (path === places.driver) return 'apps/cli/src/lib/driver.ts'
  if (path.startsWith(`${places.process}/`)) return `processes/vinaya/${path.slice(places.process.length + 1)}`
  if (path.startsWith(`${places.kernel}/`)) return `harness/${path.slice(places.kernel.length + 1)}`
  return path
}

/** Maps today's path to the layout's — the relocation map, forward. */
function placed(layout: Layout, path: string): string {
  const places = placesOf(layout)
  if (path === 'apps/cli/src/lib/driver.ts') return places.driver
  if (path.startsWith('processes/vinaya/')) return `${places.process}/${path.slice('processes/vinaya/'.length)}`
  if (path.startsWith('harness/')) return `${places.kernel}/${path.slice('harness/'.length)}`
  return path
}

/** A relative import specifier from one file to another, without extension. */
function spec(from: string, to: string): string {
  const rel = posix.relative(posix.dirname(from), to).replace(/\.ts$/, '')
  return rel.startsWith('.') ? rel : `./${rel}`
}

/** The whole tree of a layout, before any change. */
function treeOf(layout: Layout): Record<string, string> {
  const p = placesOf(layout)
  const run = `${p.kernel}/gates/run.ts`
  const flow = `${p.process}/loops/flow.ts`
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fixture', private: true, workspaces: p.workspaces }),
    // The CLI: a preload every one of its tests loads, a test of the driver, a test that spawns the process's program.
    'apps/cli/package.json': JSON.stringify({ name: '@fx/cli', scripts: { test: 'bun test' } }),
    'apps/cli/bunfig.toml': '[test]\npreload = "./tests/lib/preload.ts"\n',
    'apps/cli/tests/lib/preload.ts': 'process.env.FIXTURE = "1"\n',
    'apps/cli/src/index.ts': `import { drive } from '${spec('apps/cli/src/index.ts', p.shim ?? p.driver)}'\nexport const main = () => drive()\n`,
    'apps/cli/tests/driver.test.ts': `import { drive } from '${spec('apps/cli/tests/driver.test.ts', p.shim ?? p.driver)}'\nexport const t = drive\n`,
    'apps/cli/tests/spawn.test.ts': [
      "import { spawnSync } from 'node:child_process'",
      `const PROGRAM = '${p.process}/bin/run.ts'`,
      "export const t = () => spawnSync('node', [PROGRAM])",
      ''
    ].join('\n'),
    // The kernel: a gate, an unrelated module nothing imports, and their tests.
    [`${p.kernel}/package.json`]: JSON.stringify({ name: '@fx/kernel', scripts: { test: 'bun test' } }),
    [run]: 'export const runGate = () => 1\n',
    [`${p.kernel}/gates/other.ts`]: 'export const other = () => 2\n',
    [`${p.kernel}/gates/notes.ts`]: 'export const notes = 3\n',
    [`${p.kernel}/tests/run.test.ts`]: `import { runGate } from '${spec(`${p.kernel}/tests/run.test.ts`, run)}'\nexport const t = runGate\n`,
    [`${p.kernel}/tests/other.test.ts`]: `import { other } from '${spec(`${p.kernel}/tests/other.test.ts`, `${p.kernel}/gates/other.ts`)}'\nexport const t = other\n`,
    // The process: a flow over the kernel's gate, a fixture its test reads, a program a CLI test spawns.
    [`${p.process}/package.json`]: JSON.stringify({ name: '@fx/process', scripts: { test: 'bun test' } }),
    [flow]: `import { runGate } from '${spec(flow, run)}'\nexport const flow = () => runGate()\n`,
    [`${p.process}/tests/flow.test.ts`]: [
      `import { flow } from '${spec(`${p.process}/tests/flow.test.ts`, flow)}'`,
      "import { readFileSync } from 'node:fs'",
      "export const t = () => [flow(), readFileSync(new URL('./fixtures/scenario.json', import.meta.url), 'utf8')]",
      ''
    ].join('\n'),
    [`${p.process}/tests/fixtures/scenario.json`]: '{"rounds":3}\n',
    [`${p.process}/bin/run.ts`]: `import { flow } from '${spec(`${p.process}/bin/run.ts`, flow)}'\nflow()\n`,
    // The driver, wherever it lives, drives the flow.
    [p.driver]: `import { flow } from '${spec(p.driver, flow)}'\nexport const drive = () => flow()\n`
  }
  if (p.shim) files[p.shim] = `export { drive } from '${spec(p.shim, p.driver)}'\n`
  const declarations: InventoryDeclarations = {
    schema: 'vinaya.test-inventory',
    schemaVersion: 1,
    declarationVersion: 1,
    suites: [
      {
        id: 'cli',
        owner: '@fx/cli',
        kind: 'workspace',
        dir: 'apps/cli',
        runner: 'bun',
        preload: 'apps/cli/tests/lib/preload.ts'
      },
      {
        id: 'kernel',
        owner: '@fx/kernel',
        kind: 'workspace',
        dir: p.kernel,
        runner: 'bun',
        preload: null,
        sourceRoots: ['.']
      },
      {
        id: 'process',
        owner: '@fx/process',
        kind: 'workspace',
        dir: p.process,
        runner: 'bun',
        preload: null,
        sourceRoots: ['.']
      }
    ],
    typeInputs: [],
    exclusions: [],
    inputs: [
      {
        id: 'scenario',
        kind: 'fixture',
        paths: [`${p.process}/tests/fixtures/scenario.json`],
        format: 'json',
        readers: [{ kind: 'raw-bytes', tests: [`${p.process}/tests/flow.test.ts`] }],
        reason: 'the flow test reads it from disk'
      },
      {
        id: 'program',
        kind: 'spawn',
        paths: [`${p.process}/bin/run.ts`],
        readers: [{ kind: 'code', tests: ['apps/cli/tests/spawn.test.ts'] }],
        reason: 'the CLI test starts it as a process'
      }
    ],
    providers: [],
    policies: [],
    unknowns: []
  }
  files[INVENTORY_PATH] = JSON.stringify(declarations)
  return files
}

type Change = { kind: 'modify' | 'delete' | 'add'; path: string; text?: string }

/** A named change, in today's paths. */
const SCENARIOS: { name: string; changes: Change[]; expected: string[] }[] = [
  {
    name: 'an affected change reaches the gate test, the flow test, the driver test and the spawning test',
    changes: [{ kind: 'modify', path: 'harness/gates/run.ts', text: 'export const runGate = () => 42\n' }],
    expected: [
      'apps/cli/tests/driver.test.ts',
      'apps/cli/tests/spawn.test.ts',
      'harness/tests/run.test.ts',
      'processes/vinaya/tests/flow.test.ts'
    ]
  },
  {
    name: 'an unrelated change selects nothing',
    changes: [{ kind: 'modify', path: 'harness/gates/notes.ts', text: 'export const notes = 4\n' }],
    expected: []
  },
  {
    name: 'a changed test selects itself',
    changes: [
      { kind: 'modify', path: 'processes/vinaya/tests/flow.test.ts', text: "export const t = () => 'changed'\n" }
    ],
    expected: ['processes/vinaya/tests/flow.test.ts']
  },
  {
    name: 'a deleted test selects nothing and is reported removed',
    changes: [{ kind: 'delete', path: 'harness/tests/other.test.ts' }],
    expected: []
  },
  {
    name: 'a new test selects itself',
    changes: [{ kind: 'add', path: 'harness/tests/new.test.ts', text: 'export const t = 1\n' }],
    expected: ['harness/tests/new.test.ts']
  },
  {
    // The flow test through the inventory's declared fixture edge; the driver
    // test through the selector's own conservative edge — a non-source file
    // of a package its imports resolve through changed — in every layout.
    name: 'a changed fixture reaches the test that reads it',
    changes: [{ kind: 'modify', path: 'processes/vinaya/tests/fixtures/scenario.json', text: '{"rounds":4}\n' }],
    expected: ['apps/cli/tests/driver.test.ts', 'processes/vinaya/tests/flow.test.ts']
  },
  {
    name: 'a changed preload reaches every test of its suite',
    changes: [{ kind: 'modify', path: 'apps/cli/tests/lib/preload.ts', text: 'process.env.FIXTURE = "2"\n' }],
    expected: ['apps/cli/tests/driver.test.ts', 'apps/cli/tests/spawn.test.ts']
  },
  {
    name: 'a changed spawned program reaches the test that starts it',
    changes: [{ kind: 'modify', path: 'processes/vinaya/bin/run.ts', text: 'export {}\n' }],
    expected: ['apps/cli/tests/spawn.test.ts']
  },
  {
    name: 'a changed driver reaches its test, through the compatibility re-export where one is kept',
    changes: [
      {
        kind: 'modify',
        path: 'apps/cli/src/lib/driver.ts',
        text: '' // filled per layout: the driver's own import of the flow must stay
      }
    ],
    expected: ['apps/cli/tests/driver.test.ts']
  }
]

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function write(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
}

/** What one layout selects for one scenario, mapped back to today's paths. */
function selectIn(
  layout: Layout,
  changes: Change[]
): { selected: string[]; removed: string[]; eligible: Record<string, boolean> } {
  const before = treeOf(layout)
  const after = { ...before }
  const placedChanges = changes.map((c) => {
    const path = placed(layout, c.path)
    let text = c.text
    if (path === placesOf(layout).driver && c.path === 'apps/cli/src/lib/driver.ts' && !text)
      text = `${before[path]}export const version = 2\n`
    return { ...c, path, text }
  })
  for (const c of placedChanges) {
    if (c.kind === 'delete') delete after[c.path]
    else after[c.path] = c.text as string
  }
  const root = mkdtempSync(join(tmpdir(), `relocation-${layout}-`))
  roots.push(root)
  write(root, after)

  const changed = placedChanges.filter((c) => c.kind === 'modify').map((c) => c.path)
  const added = placedChanges.filter((c) => c.kind === 'add').map((c) => c.path)
  const removed = placedChanges.filter((c) => c.kind === 'delete').map((c) => c.path)
  const selection = selectAffectedTestFiles(root, [...changed, ...added], { addedOrRenamed: added, removed })
  const fromSelector = selection.selected.map((f) => f.slice(root.length + 1))

  const baseView = buildInventoryView(memoryReader('base', before), { imports: true })
  const headView = buildInventoryView(memoryReader('head', after), { imports: true })
  expect(baseView.problems).toEqual([])
  expect(headView.problems).toEqual([])
  const fromInventory = placedChanges.flatMap((c) =>
    changedInputReaders(baseView, headView, {
      path: c.path,
      before: before[c.path] ?? null,
      after: after[c.path] ?? null
    }).readers.map((r) => r.test)
  )
  const live = new Set(headView.tests.map((t) => t.id))
  const selected = [...new Set([...fromSelector, ...fromInventory])].filter((id) => live.has(id))

  // CI eligibility for each changed path, from the discovered layout and from the inventory's.
  const inventoryLayout = layoutOf(headView)
  const eligible: Record<string, boolean> = {}
  for (const c of placedChanges) eligible[canonical(layout, c.path)] = isSelectablePath(c.path, inventoryLayout)
  return {
    selected: selected.map((id) => canonical(layout, id)).sort(),
    removed: diffTestIdentities(baseView, headView).removed.map((id) => canonical(layout, id)),
    eligible
  }
}

describe('workspace discovery finds every layout from its own manifest', () => {
  for (const layout of LAYOUTS)
    test(layout, () => {
      const root = mkdtempSync(join(tmpdir(), `relocation-discovery-${layout}-`))
      roots.push(root)
      write(root, treeOf(layout))
      const places = placesOf(layout)
      expect(discoverWorkspaceDirs(root).sort()).toEqual(['apps/cli', places.kernel, places.process].sort())
      expect([...discoveredLayout(root).packageDirs].sort()).toEqual(['apps/cli', places.kernel, places.process].sort())
    })
})

describe('every layout selects the same affected tests after the relocation map', () => {
  for (const scenario of SCENARIOS) {
    test(scenario.name, () => {
      const answers = LAYOUTS.map((layout) => ({ layout, ...selectIn(layout, scenario.changes) }))
      for (const answer of answers)
        expect({ layout: answer.layout, selected: answer.selected }).toEqual({
          layout: answer.layout,
          selected: scenario.expected
        })
      const first = answers[0] as (typeof answers)[number]
      for (const answer of answers) {
        expect({ layout: answer.layout, removed: answer.removed }).toEqual({
          layout: answer.layout,
          removed: first.removed
        })
        expect({ layout: answer.layout, eligible: answer.eligible }).toEqual({
          layout: answer.layout,
          eligible: first.eligible
        })
      }
      if (scenario.changes[0]?.kind === 'delete') expect(first.removed).toEqual(['harness/tests/other.test.ts'])
    }, 60_000)
  }
})

describe('CI eligibility follows what is modeled, in every layout', () => {
  test('a modeled source is eligible; a spawned program, a preload and a fixture keep the full run', () => {
    for (const layout of LAYOUTS) {
      const view = buildInventoryView(memoryReader('head', treeOf(layout)), { imports: true })
      const layoutFacts = layoutOf(view)
      const at = (path: string) => isSelectablePath(placed(layout, path), layoutFacts)
      expect([layout, at('harness/gates/run.ts')]).toEqual([layout, true])
      expect([layout, at('processes/vinaya/loops/flow.ts')]).toEqual([layout, true])
      expect([layout, at('apps/cli/src/lib/driver.ts')]).toEqual([layout, true])
      expect([layout, at('processes/vinaya/bin/run.ts')]).toEqual([layout, false])
      expect([layout, at('apps/cli/tests/lib/preload.ts')]).toEqual([layout, false])
      expect([layout, at('processes/vinaya/tests/fixtures/scenario.json')]).toEqual([layout, false])
      // Without the inventory's source folders, the kernel's and process's own folders are not modeled: full run.
      expect([
        layout,
        isSelectablePath(placed(layout, 'harness/gates/run.ts'), { packageDirs: layoutFacts.packageDirs })
      ]).toEqual([layout, false])
    }
  })
})
