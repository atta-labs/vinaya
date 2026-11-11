// The compiler graph is built once per content: the same files, texts and entry points are answered from the cache
// without a new compiler program, and any change of content builds a fresh graph.
import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { buildCompilerGraph } from '../src/compiler-graph'

/** A tiny repository on disk: `a.ts` imports `b.ts`, and an installed dependency sits under `node_modules`. */
function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'graph-cache-'))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

const inputOf = (root: string) => ({
  repoRoot: root,
  files: [join(root, 'a.ts'), join(root, 'b.ts'), join(root, 'c.ts')],
  packageOfFile: () => null,
  packageOfBareSpecifier: () => null,
  entrypoints: new Map<string, string>()
})

const dependsOn = (edges: Map<string, string[]>, from: string, to: string): boolean =>
  [...edges].some(([node, deps]) => node.includes(from) && deps.some((dep) => dep.includes(to)))

describe('the compiler graph cache', () => {
  it('answers a second request for the same content without building a program, with the same edges', () => {
    const root = repository({
      'a.ts': "import { b } from './b'\nexport const a = b\n",
      'b.ts': 'export const b = 1\n',
      'c.ts': 'export const c = 2\n',
      'node_modules/dep/index.d.ts': 'export declare const dep: number\n'
    })
    try {
      const first = buildCompilerGraph(ts, inputOf(root))
      const second = buildCompilerGraph(ts, inputOf(root))
      expect(first.programMs).toBeGreaterThan(0)
      expect(second.programMs).toBe(0)
      expect([...second.edges].sort()).toEqual([...first.edges].sort())
      expect(dependsOn(first.edges, '/a.ts', '/b.ts')).toBe(true)
      // A caller changing what it got never changes what the next caller reads.
      for (const deps of second.edges.values()) deps.push('changed-by-a-caller')
      const third = buildCompilerGraph(ts, inputOf(root))
      expect([...third.edges].sort()).toEqual([...first.edges].sort())
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('builds a fresh graph when a file changes, and its edges follow the change', () => {
    const root = repository({
      'a.ts': "import { b } from './b'\nexport const a = b\n",
      'b.ts': 'export const b = 1\n',
      'c.ts': 'export const c = 2\n'
    })
    try {
      const before = buildCompilerGraph(ts, inputOf(root))
      writeFileSync(join(root, 'a.ts'), "import { c } from './c'\nexport const a = c\n")
      const after = buildCompilerGraph(ts, inputOf(root))
      expect(after.programMs).toBeGreaterThan(0)
      expect(dependsOn(before.edges, '/a.ts', '/b.ts')).toBe(true)
      expect(dependsOn(after.edges, '/a.ts', '/c.ts')).toBe(true)
      expect(dependsOn(after.edges, '/a.ts', '/b.ts')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
