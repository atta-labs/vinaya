// The package is a closed unit: nothing in it imports anything outside its
// own folder but a dependency its own `package.json` declares, and nothing
// outside it reaches past its package name into its files.
import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

const PACKAGE_DIR = resolve(import.meta.dir, '..')
const PACKAGE_NAME = '@attalabs/test-selection'

/** The repository the package sits in: the git work tree around it. */
function repositoryRoot(): string {
  const run = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: PACKAGE_DIR,
    encoding: 'utf8',
    timeout: 30_000
  })
  if (run.status !== 0) throw new Error(`git rev-parse failed: ${run.stderr}`)
  return run.stdout.trim()
}

const SOURCE = /\.(?:[cm]?[jt]sx?)$/

/** Every tracked or untracked-but-not-ignored source file of the repository, as absolute paths. */
function repositorySources(root: string): string[] {
  const run = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 256 * 1024 * 1024
  })
  if (run.status !== 0) throw new Error(`git ls-files failed: ${run.stderr}`)
  return run.stdout
    .split('\0')
    .filter((path) => SOURCE.test(path) && !path.split('/').includes('node_modules'))
    .map((path) => join(root, path))
}

/** Every module specifier a source names, in every form: imports and exports (type-only too), `import x = require`, `require()`, `import()` and `import('…')` types. */
function specifiersOf(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      out.push(node.moduleSpecifier.text)
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression
      if (ts.isStringLiteral(expression)) out.push(expression.text)
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      out.push(node.argument.literal.text)
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const arg = node.arguments[0]
      out.push(arg && ts.isStringLiteral(arg) ? arg.text : '<computed>')
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

type Manifest = {
  name: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

/** The package a bare specifier names: `@scope/name` or `name`. */
function packageOf(specifier: string): string {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] as string)
}

const isBuiltin = (specifier: string): boolean =>
  specifier.startsWith('node:') || builtinModules.includes(specifier.split('/')[0] as string)

type Read = (file: string) => string
const readText: Read = (file) => readFileSync(file, 'utf8')

/**
 * Every import inside the package that escapes its folder or names a module its manifest does not declare: runtime
 * sources may use the standard library and `dependencies`/`peerDependencies`; tests may also use `bun:test` and
 * `devDependencies`.
 */
export function packageViolations(
  packageDir: string,
  files: readonly string[],
  manifest: Manifest,
  read: Read = readText
): string[] {
  const runtime = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {})
  ])
  const forTests = new Set([...runtime, ...Object.keys(manifest.devDependencies ?? {})])
  const violations: string[] = []
  for (const file of files) {
    if (!file.startsWith(`${packageDir}/`)) continue
    const where = relative(packageDir, file)
    const inTests = where.startsWith('tests/')
    for (const specifier of specifiersOf(file, read(file))) {
      if (specifier === '<computed>') violations.push(`${where}: a computed specifier`)
      else if (specifier.startsWith('.')) {
        if (!resolve(dirname(file), specifier).startsWith(`${packageDir}/`))
          violations.push(`${where}: ${specifier} escapes the package folder`)
      } else if (specifier.startsWith('/')) violations.push(`${where}: ${specifier} is an absolute path`)
      else if (isBuiltin(specifier) || (inTests && specifier === 'bun:test')) continue
      else if (!(inTests ? forTests : runtime).has(packageOf(specifier)))
        violations.push(`${where}: ${specifier} is not declared in package.json`)
    }
  }
  return violations.sort()
}

/** Every import outside the package that reaches into its files instead of naming the package. */
export function importerViolations(
  root: string,
  packageDir: string,
  files: readonly string[],
  name: string,
  read: Read = readText
): string[] {
  const violations: string[] = []
  const inside = (path: string) => path === packageDir || path.startsWith(`${packageDir}/`)
  for (const file of files) {
    if (inside(file)) continue
    for (const specifier of specifiersOf(file, read(file))) {
      const where = `${relative(root, file)}: ${specifier}`
      if (specifier.startsWith(`${name}/`)) violations.push(`${where} reaches past the package name`)
      else if (specifier.startsWith('.') && inside(resolve(dirname(file), specifier)))
        violations.push(`${where} reaches into the package folder`)
      else if (specifier.startsWith('/') && inside(specifier))
        violations.push(`${where} reaches into the package folder`)
    }
  }
  return violations.sort()
}

const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')) as Manifest

describe('the package is closed', () => {
  const root = repositoryRoot()
  const files = repositorySources(root)

  it('reads the whole repository, the package included', () => {
    expect(files).toContain(join(PACKAGE_DIR, 'src/selector.ts'))
    expect(files.filter((file) => !file.startsWith(`${PACKAGE_DIR}/`)).length).toBeGreaterThan(100)
  })

  it('imports nothing outside its folder but what its package.json declares', () => {
    expect(manifest.name).toBe(PACKAGE_NAME)
    expect(packageViolations(PACKAGE_DIR, files, manifest)).toEqual([])
    // The one third-party module the runtime sources name is the compiler, an optional peer.
    const runtimeBare = new Set(
      files
        .filter((file) => file.startsWith(`${PACKAGE_DIR}/src/`))
        .flatMap((file) => specifiersOf(file, readText(file)))
        .filter((specifier) => !specifier.startsWith('.') && !isBuiltin(specifier))
        .map(packageOf)
    )
    expect([...runtimeBare]).toEqual(['typescript'])
    expect(manifest.dependencies ?? {}).toEqual({})
    expect(Object.keys(manifest.peerDependencies ?? {})).toEqual(['typescript'])
  })

  it('is imported only by its package name, and this repository does import it', () => {
    expect(importerViolations(root, PACKAGE_DIR, files, PACKAGE_NAME)).toEqual([])
    const importers = files.filter(
      (file) => !file.startsWith(`${PACKAGE_DIR}/`) && specifiersOf(file, readText(file)).includes(PACKAGE_NAME)
    )
    expect(importers.length).toBeGreaterThan(10)
  })

  it('rejects an escaping, undeclared or computed import, and an importer reaching past the name', () => {
    const fakeRoot = '/repo'
    const fake = `${fakeRoot}/packages/test-selection`
    const tree = new Map<string, string>([
      [
        `${fake}/src/escape.ts`,
        [
          "import type { VinayaConfig } from '../../../harness/config.js'",
          "export { globToRegex } from '@attalabs/harness'",
          "import helper = require('../../ops.js')",
          "export type Sink = import('../../log-sink.js').Sink",
          'export const late = (name: string) => import(name)',
          "import { readFileSync } from 'node:fs'",
          "import type ts from 'typescript'",
          "import { gitRepository } from './selector.js'",
          ''
        ].join('\n')
      ],
      [
        `${fake}/tests/ok.test.ts`,
        "import { test } from 'bun:test'\nimport ts from 'typescript'\nimport { selectTests } from '../src/index.js'\n"
      ],
      [
        `${fakeRoot}/scripts/user.ts`,
        [
          "import { selectTests } from '@attalabs/test-selection'",
          "import { gitRepository } from '@attalabs/test-selection/src/selector.js'",
          "import { stableHash } from '../packages/test-selection/src/inventory.js'",
          "import { other } from '../packages/test-selection-other/index.js'",
          ''
        ].join('\n')
      ]
    ])
    const read: Read = (file) => tree.get(file) as string
    const files = [...tree.keys()]
    expect(packageViolations(fake, files, manifest, read)).toEqual([
      'src/escape.ts: ../../../harness/config.js escapes the package folder',
      'src/escape.ts: ../../log-sink.js escapes the package folder',
      'src/escape.ts: ../../ops.js escapes the package folder',
      'src/escape.ts: @attalabs/harness is not declared in package.json',
      'src/escape.ts: a computed specifier'
    ])
    expect(importerViolations(fakeRoot, fake, files, PACKAGE_NAME, read)).toEqual([
      'scripts/user.ts: ../packages/test-selection/src/inventory.js reaches into the package folder',
      'scripts/user.ts: @attalabs/test-selection/src/selector.js reaches past the package name'
    ])
  })
})
