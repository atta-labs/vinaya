import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const CLI = join(import.meta.dir, '../..')
const FIXTURES = 'tests/fixtures/atta-engine'
const SOURCE = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/
const TRANSPILERS = {
  ts: new Bun.Transpiler({ loader: 'ts' }),
  tsx: new Bun.Transpiler({ loader: 'tsx' }),
  js: new Bun.Transpiler({ loader: 'js' })
}
// Every textual import form; it backs the parser for type-only imports, which
// scanImports erases, and for any file the parser refuses.
const TEXT_IMPORT = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"`]@atta\//

function filesUnder(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Every `@atta/` specifier a source file imports, in any import form. */
function attaImports(source: string, path = 'source.ts'): string[] {
  const loader = /\.[jt]sx$/.test(path) ? 'tsx' : /\.[cm]?ts$/.test(path) ? 'ts' : 'js'
  let atta: string[] = []
  try {
    atta = TRANSPILERS[loader]
      .scanImports(source.replace(/^#!.*/, ''))
      .map((entry) => entry.path)
      .filter((specifier) => specifier.startsWith('@atta/'))
  } catch {
    // A file the parser refuses still gets the textual check below.
  }
  return atta.length === 0 && TEXT_IMPORT.test(source) ? ['@atta/ (textual import)'] : atta
}

/** Every file npm would publish from `root` under a manifest `files` list. */
function publishedFiles(root: string, files: readonly string[]): string[] {
  const found = new Set<string>()
  for (const entry of files) {
    const pattern = entry.replace(/^\.\//, '').replace(/\/+$/, '')
    for (const glob of [pattern, `${pattern}/**`]) {
      for (const path of new Bun.Glob(glob).scanSync({ cwd: root, onlyFiles: true, dot: true })) found.add(path)
    }
  }
  return [...found].sort()
}

/**
 * Every published path that carries a vendored tarball — by location, by
 * extension, or by identical bytes under another name — or an `@atta/` import.
 */
function publishedOffenders(root: string, files: readonly string[], vendored: ReadonlyMap<number, string>): string[] {
  return publishedFiles(root, files).filter((path) => {
    if (path === FIXTURES || path.startsWith(`${FIXTURES}/`) || path.endsWith('.tgz')) return true
    const abs = join(root, path)
    const digest = vendored.get(statSync(abs).size)
    if (digest !== undefined && sha256(abs) === digest) return true
    return SOURCE.test(path) && attaImports(readFileSync(abs, 'utf8'), path).length > 0
  })
}

const vendored = readdirSync(join(CLI, FIXTURES)).filter((name) => name.endsWith('.tgz'))
// Keyed by byte size, so only a same-sized published file is hashed.
const vendoredDigests = new Map(
  vendored.map((name) => [statSync(join(CLI, FIXTURES, name)).size, sha256(join(CLI, FIXTURES, name))] as const)
)

describe('packed Atta fixtures remain development-only', () => {
  const scratch: string[] = []
  afterEach(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('keeps tarballs and @atta imports outside the published CLI surface', () => {
    const manifest = JSON.parse(readFileSync(join(CLI, 'package.json'), 'utf8')) as {
      files: string[]
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    const sourceImports = filesUnder(join(CLI, 'src'))
      .filter((path) => SOURCE.test(path))
      .filter((path) => attaImports(readFileSync(path, 'utf8'), path).length > 0)
      .map((path) => relative(CLI, path))

    expect(vendored.length).toBe(5)
    expect(publishedOffenders(CLI, manifest.files, vendoredDigests)).toEqual([])
    expect(Object.keys(manifest.dependencies).filter((name) => name.startsWith('@atta/'))).toEqual([])
    expect(
      Object.entries(manifest.devDependencies)
        .filter(([name, specifier]) => name.startsWith('@atta/') && specifier.startsWith(`file:${FIXTURES}/`))
        .map(([name]) => name)
        .sort()
    ).toEqual(['@atta/adapter-langgraph', '@atta/agents', '@atta/engine', '@atta/executor-agent-spawn', '@atta/models'])
    expect(sourceImports).toEqual([])
  })

  it('detects every @atta import form, type-only imports included', () => {
    expect(attaImports(`import '@atta/engine'`)).toEqual(['@atta/engine'])
    expect(attaImports(`export * from '@atta/engine'`)).toEqual(['@atta/engine'])
    expect(attaImports(`const engine = require('@atta/engine')`)).toEqual(['@atta/engine'])
    expect(attaImports(`const engine = await import('@atta/engine')`)).toEqual(['@atta/engine'])
    expect(attaImports(`import type { Flow } from '@atta/engine'`)).toEqual(['@atta/ (textual import)'])
    expect(attaImports(`#!/usr/bin/env node\nimport '@atta/engine'\n`)).toEqual(['@atta/engine'])
    expect(attaImports(`import { z } from 'zod'`)).toEqual([])
  })

  it('flags a vendored tarball published by directory, by path, by glob, or copied under another name', () => {
    const root = mkdtempSync(join(tmpdir(), 'packed-runtime-not-shipped-'))
    scratch.push(root)
    mkdirSync(join(root, FIXTURES), { recursive: true })
    mkdirSync(join(root, 'dist'), { recursive: true })
    copyFileSync(join(CLI, FIXTURES, vendored[0] as string), join(root, FIXTURES, vendored[0] as string))
    writeFileSync(join(root, 'dist/index.js'), 'console.log(1)\n')

    expect(publishedOffenders(root, ['dist'], vendoredDigests)).toEqual([])
    for (const files of [['tests'], [FIXTURES], [`${FIXTURES}/${vendored[0]}`], ['**/*.tgz']]) {
      expect(publishedOffenders(root, files, vendoredDigests)).toEqual([`${FIXTURES}/${vendored[0]}`])
    }

    copyFileSync(join(CLI, FIXTURES, vendored[0] as string), join(root, 'dist/runtime.bin'))
    expect(publishedOffenders(root, ['dist'], vendoredDigests)).toEqual(['dist/runtime.bin'])
  })

  it('flags a published file that imports @atta', () => {
    const root = mkdtempSync(join(tmpdir(), 'packed-runtime-not-shipped-'))
    scratch.push(root)
    mkdirSync(join(root, 'dist'), { recursive: true })
    writeFileSync(join(root, 'dist/index.js'), `import '@atta/engine'\n`)
    expect(publishedOffenders(root, ['dist'], vendoredDigests)).toEqual(['dist/index.js'])
  })
})
