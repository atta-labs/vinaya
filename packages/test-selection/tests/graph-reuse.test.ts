// The compiler graph is built once per set of inputs in a process. These tests
// prove the reuse on both paths that build it, that every input of the graph
// makes the next call build a new program, and that the edges a selection adds
// after the graph are never taken from the reuse. Every workspace is built in a
// temporary directory or in memory, never from a committed fixture.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildCompilerGraph, resetCompilerGraphReuse, type TypeScriptApi } from '../src/compiler-graph.js'
import {
  diskTree,
  inventoryViewOf,
  loadLibraryTypeScript,
  memoryRepository,
  revisionTree,
  type SelectionPlan,
  selectAffectedFiles,
  selectTests
} from '../src/index.js'

const roots: string[] = []

beforeEach(() => resetCompilerGraphReuse())
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
})

/** The files of a two-package workspace, repository-relative: `a` has an entrypoint and a test, `b` a test, a spare module and a tree scanner. */
function workspaceFiles(): Record<string, string> {
  return {
    'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
    'packages/a/package.json': JSON.stringify({ name: '@t/a', main: './src/index.ts' }),
    'packages/a/src/index.ts': 'export const a = 1\n',
    'packages/a/src/alt.ts': 'export const a = 2\n',
    'packages/a/src/a.test.ts': "import { a } from './index'\nexport const t = a\n",
    'packages/b/package.json': JSON.stringify({ name: '@t/b' }),
    'packages/b/src/b.ts': 'export const b = 2\n',
    'packages/b/src/spare.ts': 'export const spare = 3\n',
    'packages/b/src/b.test.ts': "import { b } from './b'\nexport const t = b\n",
    'packages/b/src/scan.test.ts':
      "import { readdirSync } from 'node:fs'\nexport const names = readdirSync(import.meta.dir)\n"
  }
}

function writeAll(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
}

function diskWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'graph-reuse-'))
  roots.push(root)
  writeAll(root, workspaceFiles())
  return root
}

type Options = NonNullable<Parameters<typeof selectAffectedFiles>[2]>

/** One selection over the working tree at `root`, naming changed files repository-relative. */
function select(root: string, changed: string[], options: Options = {}) {
  return selectAffectedFiles(
    diskTree(root),
    changed.map((f) => join(root, f)),
    options
  )
}

const SPARE = 'packages/b/src/spare.ts'

describe('the working-tree selection reuses its compiler graph', () => {
  it('a repeat over identical inputs builds no program and selects the same set as a fresh build', () => {
    const root = diskWorkspace()
    const first = select(root, [SPARE])
    expect(first.resolver).toBe('compiler')
    expect(first.programMs).toBeGreaterThan(0)
    const second = select(root, [SPARE])
    expect(second.programMs).toBe(0)
    expect(second.selected).toEqual(first.selected)
    resetCompilerGraphReuse()
    const fresh = select(root, [SPARE])
    expect(fresh.programMs).toBeGreaterThan(0)
    expect(second.selected).toEqual(fresh.selected)
  })

  it('a call without the workspace key builds afresh every time', () => {
    const root = diskWorkspace()
    const ts = loadLibraryTypeScript() as TypeScriptApi
    const input = {
      repoRoot: root,
      files: [join(root, 'packages/a/src/index.ts')],
      packageOfFile: () => null,
      packageOfBareSpecifier: () => null,
      entrypoints: new Map<string, string>()
    }
    const first = buildCompilerGraph(ts, input)
    const second = buildCompilerGraph(ts, input)
    expect(first.programMs).toBeGreaterThan(0)
    expect(second.programMs).toBeGreaterThan(0)
    expect(second.edges).not.toBe(first.edges)
  })

  it('keeps at most two input sets: a third evicts the least recently used', () => {
    const [one, two, three] = [diskWorkspace(), diskWorkspace(), diskWorkspace()] as [string, string, string]
    select(one, [SPARE])
    select(two, [SPARE])
    expect(select(two, [SPARE]).programMs).toBe(0)
    select(three, [SPARE])
    expect(select(two, [SPARE]).programMs).toBe(0)
    expect(select(one, [SPARE]).programMs).toBeGreaterThan(0)
  })
})

describe('every input of the graph makes the next call build a new program', () => {
  /** Selects twice (build, reuse), changes one input, then selects again: that one must build. */
  function rebuildsAfter(change: (root: string) => void): void {
    const root = diskWorkspace()
    expect(select(root, [SPARE]).programMs).toBeGreaterThan(0)
    expect(select(root, [SPARE]).programMs).toBe(0)
    change(root)
    expect(select(root, [SPARE]).programMs).toBeGreaterThan(0)
  }

  it('a root file edited so that it gains an import selects the test that import now reaches', () => {
    const root = diskWorkspace()
    const index = 'packages/a/src/index.ts'
    const before = select(root, [index])
    expect(before.selected).toEqual([join(root, 'packages/a/src/a.test.ts')])
    expect(select(root, [index]).programMs).toBe(0)
    writeFileSync(join(root, 'packages/b/src/b.ts'), "import { a } from '@t/a'\nexport const b = a\n")
    const after = select(root, [index])
    expect(after.programMs).toBeGreaterThan(0)
    expect(new Set(after.selected)).toEqual(
      new Set([join(root, 'packages/a/src/a.test.ts'), join(root, 'packages/b/src/b.test.ts')])
    )
  })

  it('a root file added', () =>
    rebuildsAfter((root) => writeFileSync(join(root, 'packages/b/src/added.ts'), 'export const x = 1\n')))

  it('a root file removed', () => rebuildsAfter((root) => unlinkSync(join(root, 'packages/b/src/spare.ts'))))

  it('a root file edited without any import change', () =>
    rebuildsAfter((root) => writeFileSync(join(root, SPARE), 'export const spare = 4\n')))

  it('a package manifest edited so that its entrypoint changes', () =>
    rebuildsAfter((root) =>
      writeFileSync(join(root, 'packages/a/package.json'), JSON.stringify({ name: '@t/a', main: './src/alt.ts' }))
    ))

  it('a package manifest edited so that its name changes', () =>
    rebuildsAfter((root) => writeFileSync(join(root, 'packages/b/package.json'), JSON.stringify({ name: '@t/b2' }))))

  it('a different TypeScript module', () => {
    const root = diskWorkspace()
    const ts = loadLibraryTypeScript() as TypeScriptApi
    const other = { ...ts } as TypeScriptApi
    expect(select(root, [SPARE], { typescript: ts }).programMs).toBeGreaterThan(0)
    expect(select(root, [SPARE], { typescript: ts }).programMs).toBe(0)
    expect(select(root, [SPARE], { typescript: other }).programMs).toBeGreaterThan(0)
  })

  it('a workspace link under node_modules re-pointed to another directory', () => {
    const root = diskWorkspace()
    const link = join(root, 'node_modules', '@t', 'a')
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(join(root, 'packages/a'), link, 'dir')
    expect(select(root, [SPARE]).programMs).toBeGreaterThan(0)
    expect(select(root, [SPARE]).programMs).toBe(0)
    unlinkSync(link)
    symlinkSync(join(root, 'packages/b'), link, 'dir')
    expect(select(root, [SPARE]).programMs).toBeGreaterThan(0)
  })

  it('a different repository root with the same content', () => {
    const one = diskWorkspace()
    const two = diskWorkspace()
    expect(select(one, [SPARE]).programMs).toBeGreaterThan(0)
    expect(select(two, [SPARE]).programMs).toBeGreaterThan(0)
  })

  it('two different revisions read through views under the same snapshot root', () => {
    const ts = loadLibraryTypeScript() as TypeScriptApi
    const base = workspaceFiles()
    const head = { ...base, 'packages/b/src/b.ts': "import { a } from '@t/a'\nexport const b = a\n" }
    const repo = memoryRepository({ base, head })
    const over = (revision: string, files: Record<string, string>, changed: string) =>
      selectAffectedFiles(revisionTree(repo, revision, Object.keys(files), '/snapshot'), [join('/snapshot', changed)], {
        typescript: ts
      })
    const index = 'packages/a/src/index.ts'
    const first = over('base', base, index)
    expect(first.programMs).toBeGreaterThan(0)
    expect(over('base', base, index).programMs).toBe(0)
    const second = over('head', head, index)
    expect(second.programMs).toBeGreaterThan(0)
    expect(second.selected.length).toBeGreaterThan(first.selected.length)
  })
})

describe('the edges added after the compiler graph are never taken from the reuse', () => {
  const scan = 'packages/b/src/scan.test.ts'
  const combinations: [string, Options][] = [
    ['scan edges on', { repoTreeScanners: 'select' }],
    ['scan edges off', { repoTreeScanners: 'ignore' }],
    ['spawn edges off', { spawnDetection: 'ignore' }],
    ['depth one', { depth: 'one' }]
  ]

  it('a selection whose options switch the scan edges returns what a fresh build returns', () => {
    const root = diskWorkspace()
    // Prime the reuse with every combination, then compare each against a fresh build.
    for (const [, options] of combinations) select(root, [SPARE], options)
    for (const [label, options] of combinations) {
      const reused = select(root, [SPARE], options)
      expect(reused.programMs, label).toBe(0)
      resetCompilerGraphReuse()
      const fresh = select(root, [SPARE], options)
      expect(fresh.programMs, label).toBeGreaterThan(0)
      expect(reused.selected, label).toEqual(fresh.selected)
    }
    resetCompilerGraphReuse()
    const withScan = select(root, [SPARE], { repoTreeScanners: 'select' })
    const withoutScan = select(root, [SPARE], { repoTreeScanners: 'ignore' })
    expect(withoutScan.programMs).toBe(0)
    expect(withScan.selected).toContain(join(root, scan))
    expect(withoutScan.selected).not.toContain(join(root, scan))
  })
})

describe('the plan over two revisions reuses its compiler graphs', () => {
  const semantic = (plan: SelectionPlan): Omit<SelectionPlan, 'profile'> => {
    const { profile: _profile, ...rest } = plan
    return rest
  }

  function plan(headFiles: Record<string, string>) {
    const base = workspaceFiles()
    const declarations = {
      suites: [{ id: 'root', dir: '.', runner: 'bun' as const, preload: null }],
      edges: [],
      unknowns: [],
      policies: []
    }
    return selectTests({
      repo: memoryRepository({ base, head: headFiles }),
      base: 'base',
      head: 'head',
      inventory: {
        base: inventoryViewOf('base', base, declarations),
        head: inventoryViewOf('head', headFiles, declarations)
      },
      policy: { depth: 'transitive', scanners: [], spawnPrograms: [] }
    })
  }

  it('a repeat over identical revisions builds no program and returns the same plan', () => {
    const head = { ...workspaceFiles(), 'packages/a/src/index.ts': 'export const a = 5\n' }
    const first = plan(head)
    expect(first.profile.programMs).toBeGreaterThan(0)
    expect(first.required.map((t) => t.test)).toEqual(['packages/a/src/a.test.ts'])
    const second = plan(head)
    expect(second.profile.programMs).toBe(0)
    expect(semantic(second)).toEqual(semantic(first))
  })

  it('a head whose content differs under the same revision names builds again and selects what it reaches', () => {
    const edited = { ...workspaceFiles(), 'packages/a/src/index.ts': 'export const a = 5\n' }
    const importing = { ...edited, 'packages/b/src/b.ts': "import { a } from '@t/a'\nexport const b = a\n" }
    const first = plan(edited)
    const second = plan(importing)
    expect(second.profile.programMs).toBeGreaterThan(0)
    // The edit also sits under the folder the scan test reads, so that test is required as well.
    expect(second.required.map((t) => t.test)).toEqual([
      'packages/a/src/a.test.ts',
      'packages/b/src/b.test.ts',
      'packages/b/src/scan.test.ts'
    ])
    expect(first.required.map((t) => t.test)).toEqual(['packages/a/src/a.test.ts'])
  })
})
