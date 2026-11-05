import { afterAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import ts from 'typescript'
import { parse } from 'yaml'
import {
  BASELINE_PATH,
  COMPARE_COMMAND,
  compareBase,
  compareWithBaseline,
  countSource,
  countTree,
  importsOfAProcess,
  importsThroughForwarding,
  OWNERSHIP_MAP_PATH,
  ownershipRefusals,
  REPOSITORY_ROOT,
  readBaseline,
  readOwnershipMap,
  SOURCE_FILE,
  serializeBaseline,
  sourceFiles,
  WRITE_COMMAND,
  workingTree
} from './architecture-ratchet'

export { importsOfAProcess, sourceFiles }

// The harness is generic machinery: it knows no process. A file under
// `harness/` that imports from `processes/`, by relative path or by the
// `@attalabs/process-` package scope, would tie the harness to one process.

const harnessRoot = join(import.meta.dir, '..')

// A module specifier inside `from '…'`, `import '…'`, `import('…')` or `require('…')`.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"`])([^'"`\n]+)\1/g

// Nor does it reach into an application: a file under `harness/` that imports
// from `apps/` would make the generic machinery depend on one product's code.
export function importsOfAnApp(source: string): string[] {
  const offending: string[] = []
  for (const match of source.matchAll(SPECIFIER)) {
    const specifier = match[2] ?? ''
    if (specifier.startsWith('.') && specifier.split('/').includes('apps')) offending.push(specifier)
  }
  return offending
}

describe('harness never imports an app', () => {
  test('no file under harness/ imports from apps/', () => {
    const violations: string[] = []
    for (const file of sourceFiles(harnessRoot)) {
      if (file === import.meta.path) continue
      for (const specifier of importsOfAnApp(readFileSync(file, 'utf8'))) {
        violations.push(`${file.slice(harnessRoot.length + 1)} imports ${specifier}`)
      }
    }
    expect(violations).toEqual([])
  })

  test('the scan catches a planted offending import', () => {
    expect(importsOfAnApp("import { x } from '../../apps/cli/src/lib/thing'")).toEqual(['../../apps/cli/src/lib/thing'])
    expect(importsOfAnApp("const m = await import('../../../apps/cli/x')")).toEqual(['../../../apps/cli/x'])
    expect(importsOfAnApp("import { x } from './local'\nimport y from 'node:fs'")).toEqual([])
  })
})

describe('harness never imports a process', () => {
  test('no file under harness/ imports from processes/', () => {
    const violations: string[] = []
    for (const file of sourceFiles(harnessRoot)) {
      // This file names the forbidden specifiers as data, so it is not scanned.
      if (file === import.meta.path) continue
      for (const specifier of importsOfAProcess(readFileSync(file, 'utf8'))) {
        violations.push(`${file.slice(harnessRoot.length + 1)} imports ${specifier}`)
      }
    }
    expect(violations).toEqual([])
  })

  test('the scan catches a planted offending import', () => {
    expect(importsOfAProcess("import { x } from '../../processes/vinaya/thing'")).toEqual([
      '../../processes/vinaya/thing'
    ])
    expect(importsOfAProcess("import { x } from '@attalabs/process-vinaya'")).toEqual(['@attalabs/process-vinaya'])
    expect(importsOfAProcess("const m = await import('../processes/other')")).toEqual(['../processes/other'])
    expect(importsOfAProcess("import { x } from './local'\nimport y from 'node:fs'")).toEqual([])
  })

  test('no file under harness/ reaches a process through a forwarding entry of the ownership map', () => {
    expect(importsThroughForwarding(REPOSITORY_ROOT)).toEqual([])
  })
})

// ── Imports through a compatibility package ─────────────────────────────────

// A published package's entry may re-export a module from its owner, so a
// kernel import of one of these packages can reach process code without a
// `processes/` specifier. The check reads the workspace sources: each
// package subpath resolves through the package's own `exports` map, and each
// imported symbol is followed through every re-export to the file that
// declares it.

/** The packages whose subpaths a kernel import is followed through, by workspace folder. */
export const COMPATIBILITY_PACKAGES: Readonly<Record<string, string>> = {
  '@attalabs/aeg-core': 'packages/aeg-core',
  '@attalabs/aeg-forge-state': 'packages/aeg-forge-state',
  '@attalabs/aeg-types': 'packages/aeg-types'
}

export type PackageImportTarget = { file: string; specifier: string; symbol: string; target: string }

const packageOfSpecifier = (specifier: string): string | undefined =>
  Object.keys(COMPATIBILITY_PACKAGES).find((name) => specifier === name || specifier.startsWith(`${name}/`))

/** The workspace file a compatibility-package specifier names through the package's `exports` map, or `undefined`. */
function workspaceEntry(root: string, specifier: string): string | undefined {
  const name = packageOfSpecifier(specifier)
  if (!name) return undefined
  const dir = join(root, COMPATIBILITY_PACKAGES[name] as string)
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) return undefined
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { exports?: Record<string, string> }
  const entry = manifest.exports?.[`.${specifier.slice(name.length)}`]
  return entry === undefined ? undefined : join(dir, entry)
}

/**
 * Every symbol a file under `harness/kernel/` imports or re-exports from a
 * compatibility package, with the repository file that declares it.
 */
export function packageImportTargets(root: string): PackageImportTarget[] {
  const kernel = join(root, 'harness', 'kernel')
  const files = existsSync(kernel)
    ? [...sourceFiles(kernel)].filter((file) => readFileSync(file, 'utf8').includes('@attalabs/aeg-'))
    : []
  if (files.length === 0) return []
  const options: ts.CompilerOptions = {
    noEmit: true,
    allowJs: true,
    allowImportingTsExtensions: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    skipLibCheck: true,
    types: []
  }
  const host = ts.createCompilerHost(options, true)
  host.resolveModuleNameLiterals = (literals, containingFile, _ref, compilerOptions) =>
    literals.map((literal) => {
      const entry = workspaceEntry(root, literal.text)
      if (entry !== undefined && existsSync(entry))
        return {
          resolvedModule: { resolvedFileName: entry, extension: ts.Extension.Ts, isExternalLibraryImport: false }
        }
      return ts.resolveModuleName(literal.text, containingFile, compilerOptions, host)
    })
  const program = ts.createProgram(files, options, host)
  const checker = program.getTypeChecker()
  const repositoryPath = (path: string) => relative(root, path).split(sep).join('/')
  const targetsOf = (symbol: ts.Symbol): string[] => {
    const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
    return [...new Set((resolved.declarations ?? []).map((d) => repositoryPath(d.getSourceFile().fileName)))]
  }
  const out: PackageImportTarget[] = []
  for (const file of files) {
    const source = program.getSourceFile(file)
    if (!source) continue
    const record = (specifier: string, symbol: ts.Symbol | undefined, name: string) => {
      if (!symbol) return
      for (const target of targetsOf(symbol)) out.push({ file: repositoryPath(file), specifier, symbol: name, target })
    }
    const wholeModule = (literal: ts.Expression) => {
      const moduleSymbol = checker.getSymbolAtLocation(literal)
      if (!moduleSymbol || !ts.isStringLiteralLike(literal)) return
      for (const exported of checker.getExportsOfModule(moduleSymbol)) record(literal.text, exported, exported.name)
    }
    const visit = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier) &&
        packageOfSpecifier(node.moduleSpecifier.text)
      ) {
        const specifier = node.moduleSpecifier.text
        if (ts.isImportDeclaration(node)) {
          const clause = node.importClause
          if (clause?.name) record(specifier, checker.getSymbolAtLocation(clause.name), 'default')
          const bindings = clause?.namedBindings
          if (bindings && ts.isNamespaceImport(bindings)) wholeModule(node.moduleSpecifier)
          else if (bindings)
            for (const element of bindings.elements)
              record(specifier, checker.getSymbolAtLocation(element.name), (element.propertyName ?? element.name).text)
          if (!clause) wholeModule(node.moduleSpecifier)
        } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
          for (const element of node.exportClause.elements)
            record(
              specifier,
              checker.getExportSpecifierLocalTargetSymbol(element),
              (element.propertyName ?? element.name).text
            )
        } else wholeModule(node.moduleSpecifier)
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0]) &&
        packageOfSpecifier(node.arguments[0].text)
      ) {
        wholeModule(node.arguments[0])
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return out
}

const underProcesses = (path: string): boolean => path.startsWith('processes/') || path.startsWith('harness/processes/')

/** Each kernel import of a compatibility package whose symbol's authoritative file lies under the processes folder. */
export function importsReachingAProcessThroughAPackage(root: string): string[] {
  return [
    ...new Set(
      packageImportTargets(root)
        .filter((t) => underProcesses(t.target))
        .map(
          (t) =>
            `${t.file} imports ${t.symbol} from ${t.specifier}, whose authoritative file ${t.target} lies under the processes folder`
        )
    )
  ].sort()
}

describe('harness never reaches a process through a compatibility package', () => {
  test('every kernel import of a compatibility package resolves to a file outside the processes folder', () => {
    const targets = packageImportTargets(REPOSITORY_ROOT)
    expect(targets.every((t) => !t.target.startsWith('..') && existsSync(join(REPOSITORY_ROOT, t.target)))).toBe(true)
    expect(importsReachingAProcessThroughAPackage(REPOSITORY_ROOT)).toEqual([])
  })

  test('the check follows re-exports through a package entry to a planted process file', () => {
    const root = join(scratch, `indirect-${repositories++}`)
    const files: Record<string, string> = {
      'packages/aeg-core/package.json': JSON.stringify({
        name: '@attalabs/aeg-core',
        exports: { '.': './src/index.ts', './log': './src/log/index.ts' }
      }),
      'packages/aeg-core/src/index.ts': "export { captureBaseline } from './baseline'\nexport const safe = 1\n",
      'packages/aeg-core/src/baseline.ts': "export { captureBaseline } from '../../../processes/vinaya/capture.ts'\n",
      'packages/aeg-core/src/log/index.ts': "export * from '../baseline'\n",
      'processes/vinaya/capture.ts': 'export function captureBaseline(): number {\n  return 1\n}\n',
      'harness/kernel/gates/named.ts':
        "import { captureBaseline, safe } from '@attalabs/aeg-core'\nexport const x = [captureBaseline, safe]\n",
      'harness/kernel/gates/whole.ts': "export * from '@attalabs/aeg-core/log'\n",
      'harness/kernel/gates/clean.ts': "import { safe } from '@attalabs/aeg-core'\nexport const y = safe\n"
    }
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), text)
    }
    expect(importsReachingAProcessThroughAPackage(root)).toEqual([
      'harness/kernel/gates/named.ts imports captureBaseline from @attalabs/aeg-core, whose authoritative file processes/vinaya/capture.ts lies under the processes folder',
      'harness/kernel/gates/whole.ts imports captureBaseline from @attalabs/aeg-core/log, whose authoritative file processes/vinaya/capture.ts lies under the processes folder'
    ])
  })
})

// ── Planted repositories ────────────────────────────────────────────────────

const scratch = mkdtempSync(join(tmpdir(), 'architecture-ratchet-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
let repositories = 0

function run(root: string, args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=ratchet',
      '-c',
      'user.email=ratchet@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args
    ],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim()
}

/** Writes each file (a `null` deletes it), then commits; returns the new commit. */
function commit(root: string, files: Record<string, string | null>): string {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) rmSync(join(root, path), { force: true })
    else {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), content)
    }
  }
  run(root, ['add', '-A'])
  run(root, ['commit', '-q', '--allow-empty', '-m', 'planted'])
  return run(root, ['rev-parse', 'HEAD'])
}

/** A planted repository whose base commit holds `files` and, unless told otherwise, their fresh baseline. */
function plantedRepository(files: Record<string, string>, withBaseline = true): { root: string; base: string } {
  const root = join(scratch, `repo-${++repositories}`)
  mkdirSync(root, { recursive: true })
  run(root, ['init', '-q'])
  commit(root, files)
  const base = withBaseline ? commitBaseline(root) : run(root, ['rev-parse', 'HEAD'])
  return { root, base }
}

/** Rewrites the planted repository's baseline from its tree and commits it, as the write command does. */
function commitBaseline(root: string, extra: Record<string, string | null> = {}): string {
  for (const [path, content] of Object.entries(extra)) {
    if (content === null) rmSync(join(root, path), { force: true })
    else {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), content)
    }
  }
  return commit(root, { [BASELINE_PATH]: serializeBaseline(countTree(root)) })
}

/** Moves a file as `git mv` does, keeping its content, so git's rename detection pairs the two paths. */
function move(root: string, from: string, to: string, content?: string): Record<string, string | null> {
  return { [from]: null, [to]: content ?? readFileSync(join(root, from), 'utf8') }
}

// Enough unchanged lines that a small edit still reads as a rename to git.
const BODY = Array.from({ length: 40 }, (_, i) => `export const line${i} = ${i}`).join('\n')

// ── The counted ratchet ─────────────────────────────────────────────────────

describe('the counted ratchet', () => {
  test('every scanned file counts exactly its baseline entry', () => {
    expect(compareWithBaseline(countTree(REPOSITORY_ROOT), readBaseline(REPOSITORY_ROOT))).toEqual([])
  })

  test('the count is the same on two runs over an unchanged tree', () => {
    expect(serializeBaseline(countTree(REPOSITORY_ROOT))).toBe(serializeBaseline(countTree(REPOSITORY_ROOT)))
  })

  test('scanned files are the ones the import checks walk', () => {
    expect(SOURCE_FILE.source).toBe('\\.(ts|tsx|js|jsx|mjs|cjs)$')
  })

  test('the committed ownership map holds no refused entry', () => {
    const read = (path: string): string | null => {
      try {
        return readFileSync(join(REPOSITORY_ROOT, path), 'utf8')
      } catch {
        return null
      }
    }
    expect(ownershipRefusals(readOwnershipMap(REPOSITORY_ROOT), read, workingTree(REPOSITORY_ROOT))).toEqual([])
  })

  test('a role token matches as a whole word, case-insensitively, optionally plural', () => {
    expect(countSource('const seat = "code-reviewer"')).toBe(1)
    expect(countSource('the developers and the reviewers')).toBe(2)
    expect(countSource('type DeveloperTurnResult = developerTurn')).toBe(2)
    expect(countSource('the code was developed')).toBe(0)
    expect(countSource('tranche-archivist, execution-planner, security-reviewer')).toBe(3)
    expect(countSource('the Principal ruled; the operator, the controller')).toBe(3)
    expect(countSource('reviewer_count, reviewer-seat, codeReviewer, reviewerss')).toBe(0)
  })

  test('process tokens match as substrings, and overlapping ones in one path count once', () => {
    expect(countSource("const doctrine = 'aeg-root/roles'")).toBe(1)
    expect(countSource("const launcher = '../../processes/vinaya/bin/run-engine.ts'")).toBe(1)
    expect(countSource("const launcher = '../../harness/processes/vinaya-strict/bin/run-engine.ts'")).toBe(1)
    expect(countSource("const scope = '@attalabs/process-vinaya-strict'")).toBe(1)
  })

  test('an import counts once per specifier, the names inside it included', () => {
    expect(countSource("import { x } from '../../processes/vinaya/loops/developer.ts'")).toBe(1)
    expect(countSource("import { x } from '@attalabs/aeg-core/reviewer'")).toBe(1)
    expect(countSource("import { x } from '@attalabs/aeg-forge-state'")).toBe(1)
    expect(countSource("import { x } from '@attalabs/aeg-types'\nimport y from './local'")).toBe(0)
  })

  test('a role token added to a scanned file is above its baseline entry, naming the file, both counts and both commands', () => {
    const failures = compareWithBaseline({ 'apps/cli/src/lib/a.ts': 3 }, { 'apps/cli/src/lib/a.ts': 2 })
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('apps/cli/src/lib/a.ts: counts 3, baseline 2')
    expect(failures[0]).toContain(WRITE_COMMAND)
    expect(failures[0]).toContain(COMPARE_COMMAND)
  })

  test('a new scanned file with a token fails with no baseline entry', () => {
    const failures = compareWithBaseline({ 'packages/aeg-core/src/new.ts': 1 }, {})
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('packages/aeg-core/src/new.ts: counts 1, baseline 0 — and has no baseline entry')
  })

  test('a lowered count fails until the baseline is lowered in the same change', () => {
    const failures = compareWithBaseline({ 'harness/kernel/gates/a.ts': 1 }, { 'harness/kernel/gates/a.ts': 4 })
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('harness/kernel/gates/a.ts: counts 1, baseline 4 — below its baseline entry')
    expect(compareWithBaseline({}, { 'harness/kernel/gates/a.ts': 1 })[0]).toContain('counts 0, baseline 1')
  })

  test('only non-test source files of the scope roots, outside a process, are counted', () => {
    const { root } = plantedRepository(
      {
        'apps/cli/src/lib/a.ts': 'the developer',
        'apps/cli/src/lib/a.test.ts': 'the developer',
        'apps/cli/tests/b.ts': 'the developer',
        'packages/aeg-core/src/fixtures/c.ts': 'the developer',
        'packages/aeg-core/README.md': 'the developer',
        'packages/aeg-core/src/d.json': '{"role":"developer"}',
        'harness/processes/vinaya-strict/e.ts': 'the developer',
        'harness/kernel/tests/f.ts': 'the developer',
        'harness/kernel/gates/g.ts': 'the reviewer and the developer',
        'processes/vinaya/h.ts': 'the developer',
        'apps/log-server/src/i.ts': 'the developer'
      },
      false
    )
    expect(countTree(root)).toEqual({ 'apps/cli/src/lib/a.ts': 1, 'harness/kernel/gates/g.ts': 2 })
  })
})

// ── The base comparison ─────────────────────────────────────────────────────

describe('the base comparison', () => {
  test('a base with no baseline file passes with a notice', () => {
    const { root, base } = plantedRepository({ 'apps/cli/src/a.ts': 'the developer' }, false)
    commitBaseline(root)
    const result = compareBase(root, base)
    expect(result.failures).toEqual([])
    expect(result.notice).toContain('has no baseline')
  })

  test('an unchanged tree passes', () => {
    const { root, base } = plantedRepository({ 'apps/cli/src/a.ts': 'the developer' })
    expect(compareBase(root, base)).toMatchObject({ notice: null, failures: [], baseTotal: 1, headTotal: 1 })
  })

  test('a growth committed together with a rewritten baseline still fails', () => {
    const { root, base } = plantedRepository({ 'apps/cli/src/a.ts': 'the developer' })
    commitBaseline(root, { 'apps/cli/src/a.ts': 'the developer and the reviewer' })
    expect(compareWithBaseline(countTree(root), readBaseline(root))).toEqual([])
    const { failures } = compareBase(root, base)
    expect(failures[0]).toContain('apps/cli/src/a.ts: counts 2, base 1 — above its base entry')
    expect(failures[0]).toContain(WRITE_COMMAND)
    expect(failures[0]).toContain(COMPARE_COMMAND)
    expect(failures[1]).toContain('total: counts 2, base 1')
  })

  test('a new scanned file with a token fails against a base with no entry for it', () => {
    const { root, base } = plantedRepository({ 'apps/cli/src/a.ts': 'the developer' })
    commitBaseline(root, { 'packages/sources/src/b.ts': 'the planner' })
    expect(compareBase(root, base).failures[0]).toContain(
      'packages/sources/src/b.ts: counts 1, base 0 — a file with no base entry counts above zero'
    )
  })

  test('a renamed file keeps its count, and fails when its count grew', () => {
    const { root, base } = plantedRepository({ 'apps/cli/src/lib/a.ts': `// the developer\n${BODY}\n` })
    commitBaseline(root, move(root, 'apps/cli/src/lib/a.ts', 'harness/kernel/gates/a.ts'))
    expect(compareBase(root, base).failures).toEqual([])

    commitBaseline(root, { 'harness/kernel/gates/a.ts': `// the developer and the reviewer\n${BODY}\n` })
    expect(compareBase(root, base).failures[0]).toContain(
      'harness/kernel/gates/a.ts: counts 2, base 1 — above the base entry of apps/cli/src/lib/a.ts, which it was renamed from'
    )
  })

  test('a lowered count with a lowered baseline passes', () => {
    const { root, base } = plantedRepository({ 'apps/cli/src/a.ts': 'the developer and the reviewer' })
    commitBaseline(root, { 'apps/cli/src/a.ts': 'the developer' })
    expect(compareBase(root, base)).toMatchObject({ failures: [], baseTotal: 2, headTotal: 1 })
  })
})

// ── Relocation equivalence ──────────────────────────────────────────────────

describe('a relocated dependency is unchanged, never growth', () => {
  const launcher = (path: string): string =>
    `import { resolve } from 'node:path'\nexport const launcher = (root: string) => resolve(root, '${path}')\n`

  test('the launcher path rewritten to its location under the renamed process folder keeps its count', () => {
    const { root, base } = plantedRepository({
      'apps/cli/package.json': '{}',
      'apps/cli/src/lib/task-run-engine.ts': launcher('../../processes/vinaya/bin/run-engine.ts'),
      'processes/vinaya/bin/run-engine.ts': `${BODY}\n`
    })
    commitBaseline(root, {
      ...move(root, 'processes/vinaya/bin/run-engine.ts', 'harness/processes/vinaya-strict/bin/run-engine.ts'),
      'apps/cli/src/lib/task-run-engine.ts': launcher('../../harness/processes/vinaya-strict/bin/run-engine.ts')
    })
    expect(compareBase(root, base)).toMatchObject({ failures: [], baseTotal: 1, headTotal: 1 })

    commitBaseline(root, {
      'harness/processes/vinaya-strict/integration/other.ts': `${BODY}\n`,
      'apps/cli/src/lib/task-run-engine.ts': `import { other } from '../../../harness/processes/vinaya-strict/integration/other.ts'\n${launcher('../../harness/processes/vinaya-strict/bin/run-engine.ts')}`
    })
    expect(compareBase(root, base).failures[0]).toContain('apps/cli/src/lib/task-run-engine.ts: counts 2, base 1')
  })

  test("a CLI caller whose driver import is rewritten to the driver's process location keeps its count", () => {
    const caller = (specifier: string): string => `import { cancelDevReviewLoop } from '${specifier}'\n${BODY}\n`
    const { root, base } = plantedRepository({
      'apps/cli/src/lib/dev-review-loop.ts': `export function cancelDevReviewLoop() {}\n${BODY}\n`,
      'apps/cli/src/lib/task-tools/cancel.ts': caller('../dev-review-loop.js')
    })
    expect(countTree(root)).toEqual({})
    commitBaseline(root, {
      ...move(
        root,
        'apps/cli/src/lib/dev-review-loop.ts',
        'harness/processes/vinaya-strict/loops/dev-review/driver.ts'
      ),
      'apps/cli/src/lib/task-tools/cancel.ts': caller(
        '../../../../../harness/processes/vinaya-strict/loops/dev-review/driver.js'
      )
    })
    expect(countTree(root)).toEqual({ 'apps/cli/src/lib/task-tools/cancel.ts': 1 })
    expect(compareBase(root, base)).toMatchObject({ failures: [], baseTotal: 0, headTotal: 0 })

    commitBaseline(root, {
      'harness/processes/vinaya-strict/loops/dev-review/seats.ts': `${BODY}\n`,
      'apps/cli/src/lib/task-tools/cancel.ts': `import { seats } from '../../../../../harness/processes/vinaya-strict/loops/dev-review/seats.js'\n${caller('../../../../../harness/processes/vinaya-strict/loops/dev-review/driver.js')}`
    })
    expect(compareBase(root, base).failures[0]).toContain(
      'apps/cli/src/lib/task-tools/cancel.ts: counts 1, base 0 — above its base entry'
    )
  })

  test('a claim anchor re-pointed to its moved file keeps its count, and a new claim naming a process path is growth', () => {
    const claim = (path: string): string => `// AEG:CLAIM: ${path} contains:export function dispatchRole(\n`
    const { root, base } = plantedRepository({
      'apps/cli/src/lib/dispatch.ts': `export function dispatchRole() {}\n${BODY}\n`,
      'packages/sources/src/commands.ts': `${claim('apps/cli/src/lib/dispatch.ts')}${BODY}\n`
    })
    expect(countTree(root)).toEqual({})
    commitBaseline(root, {
      ...move(
        root,
        'apps/cli/src/lib/dispatch.ts',
        'harness/processes/vinaya-strict/loops/dev-review/dispatch/dispatch.ts'
      ),
      'packages/sources/src/commands.ts': `${claim('harness/processes/vinaya-strict/loops/dev-review/dispatch/dispatch.ts')}${BODY}\n`
    })
    expect(countTree(root)).toEqual({ 'packages/sources/src/commands.ts': 1 })
    expect(compareBase(root, base)).toMatchObject({ failures: [], baseTotal: 0, headTotal: 0 })

    commitBaseline(root, {
      'harness/processes/vinaya-strict/loops/dev-review/dispatch/seats.ts': `export function dispatchRole() {}\n${BODY}\n`,
      'packages/sources/src/commands.ts': `${claim('harness/processes/vinaya-strict/loops/dev-review/dispatch/dispatch.ts')}${claim('harness/processes/vinaya-strict/loops/dev-review/dispatch/seats.ts')}${BODY}\n`
    })
    expect(compareBase(root, base).failures[0]).toContain(
      'packages/sources/src/commands.ts: counts 1, base 0 — above its base entry'
    )
  })
})

// ── Moving code is moving, never adding ─────────────────────────────────────

// Nothing in common with BODY, so git's default rename detection does not pair a file holding one with a file holding the other.
const REWRITTEN = Array.from({ length: 40 }, (_, i) => `export const moved${i} = 'moved ${i}'`).join('\n')
const PROCESS_FILE = (name: string): string => `harness/processes/vinaya-strict/tools/${name}.ts`

describe('a moved file is moving, never adding', () => {
  test('(a) a rename git does not pair keeps its base entry when it is the only deleted and added file of that name', () => {
    const { root, base } = plantedRepository({ 'apps/cli/src/lib/a.ts': `// the developer\n${BODY}\n` })
    commitBaseline(
      root,
      move(root, 'apps/cli/src/lib/a.ts', 'harness/kernel/gates/a.ts', `// the developer\n${REWRITTEN}\n`)
    )
    expect(compareBase(root, base)).toMatchObject({ failures: [], baseTotal: 1, headTotal: 1 })

    commitBaseline(root, { 'harness/kernel/gates/a.ts': `// the developer and the reviewer\n${REWRITTEN}\n` })
    expect(compareBase(root, base).failures[0]).toContain(
      'harness/kernel/gates/a.ts: counts 2, base 1 — above the base entry of apps/cli/src/lib/a.ts, which it was renamed from'
    )
  })

  test('(a) two deleted files of one name are never paired with the file added under it', () => {
    const { root, base } = plantedRepository({
      'apps/cli/src/lib/a.ts': `// the developer\n${BODY}\n`,
      'apps/cli/src/other/a.ts': `// the developer\n${BODY}\n`
    })
    commitBaseline(root, {
      'apps/cli/src/lib/a.ts': null,
      'apps/cli/src/other/a.ts': null,
      'harness/kernel/gates/a.ts': `// the developer\n${REWRITTEN}\n`
    })
    expect(compareBase(root, base).failures[0]).toContain(
      'harness/kernel/gates/a.ts: counts 1, base 0 — a file with no base entry counts above zero'
    )
  })

  test('(b) one counted import split into several, each of a file the change moves or adds out of its target, counts once', () => {
    const importing = (...names: string[]): string =>
      `${names.map((n) => `import { ${n} } from '../../../harness/processes/vinaya-strict/tools/${n}.js'`).join('\n')}\n${BODY}\n`
    const { root, base } = plantedRepository({
      [PROCESS_FILE('m')]: `export const m = 1\nexport const n = 2\n${BODY}\n`,
      'apps/cli/src/lib/c/c.ts': importing('m')
    })
    commitBaseline(root, {
      [PROCESS_FILE('m')]: `export const m = 1\n${BODY}\n`,
      [PROCESS_FILE('n')]: 'export const n = 2\n',
      'apps/cli/src/lib/c/c.ts': importing('m', 'n')
    })
    expect(countTree(root)).toEqual({ 'apps/cli/src/lib/c/c.ts': 2 })
    expect(compareBase(root, base)).toMatchObject({ failures: [], baseTotal: 1, headTotal: 1 })

    // The same second import of a file the change did not take out of the base import's target is growth.
    const untouched = plantedRepository({
      [PROCESS_FILE('m')]: `export const m = 1\n${BODY}\n`,
      [PROCESS_FILE('n')]: 'export const n = 2\n',
      'apps/cli/src/lib/c/c.ts': importing('m')
    })
    commitBaseline(untouched.root, { 'apps/cli/src/lib/c/c.ts': importing('m', 'n') })
    expect(compareBase(untouched.root, untouched.base).failures[0]).toContain(
      'apps/cli/src/lib/c/c.ts: counts 2, base 1 — above its base entry'
    )

    // A file the change adds while the base import's target stays as it was is not taken out of that target.
    const added = plantedRepository({
      [PROCESS_FILE('m')]: `export const m = 1\n${BODY}\n`,
      'apps/cli/src/lib/c/c.ts': importing('m')
    })
    commitBaseline(added.root, {
      [PROCESS_FILE('n')]: 'export const n = 2\n',
      'apps/cli/src/lib/c/c.ts': importing('m', 'n')
    })
    expect(compareBase(added.root, added.base).failures[0]).toContain(
      'apps/cli/src/lib/c/c.ts: counts 2, base 1 — above its base entry'
    )
  })

  test('(b) an import of a file split into two added files counts once, and a third counted import is growth', () => {
    const importing = (...names: string[]): string =>
      `${names.map((n) => `import { ${n} } from '../../../harness/processes/vinaya-strict/tools/${n}.js'`).join('\n')}\n${BODY}\n`
    const { root, base } = plantedRepository({
      [PROCESS_FILE('whole')]: `export const x = 1\nexport const y = 2\n${BODY}\n`,
      'apps/cli/src/lib/c/c.ts': importing('whole')
    })
    commitBaseline(root, {
      [PROCESS_FILE('whole')]: null,
      [PROCESS_FILE('x')]: 'export const x = 1\n',
      [PROCESS_FILE('y')]: 'export const y = 2\n',
      [PROCESS_FILE('z')]: 'export const z = 3\n',
      'apps/cli/src/lib/c/c.ts': importing('x', 'y')
    })
    expect(compareBase(root, base)).toMatchObject({ failures: [], baseTotal: 1, headTotal: 1 })

    commitBaseline(root, { 'apps/cli/src/lib/c/c.ts': importing('x', 'y', 'z') })
    expect(compareBase(root, base).failures[0]).toContain(
      'apps/cli/src/lib/c/c.ts: counts 2, base 1 — above its base entry'
    )
  })

  test('(c) a path string re-pointed to a file moved by an unpaired rename keeps its count, and a new one is growth', () => {
    const launcher = (path: string): string =>
      `import { resolve } from 'node:path'\nexport const launcher = (root: string) => resolve(root, '${path}')\n${BODY}\n`
    const { root, base } = plantedRepository({
      'apps/cli/src/lib/launch.ts': launcher('../../processes/vinaya/bin/run.ts'),
      'processes/vinaya/bin/run.ts': `${BODY}\n`
    })
    commitBaseline(root, {
      ...move(root, 'processes/vinaya/bin/run.ts', 'harness/processes/vinaya-strict/bin/run.ts', `${REWRITTEN}\n`),
      'apps/cli/src/lib/launch.ts': launcher('../../harness/processes/vinaya-strict/bin/run.ts')
    })
    expect(compareBase(root, base)).toMatchObject({ failures: [], baseTotal: 1, headTotal: 1 })

    commitBaseline(root, {
      'harness/processes/vinaya-strict/bin/other.ts': 'export const unrelated = 1\n',
      'apps/cli/src/lib/launch.ts': `${launcher('../../harness/processes/vinaya-strict/bin/run.ts')}export const other = '../../harness/processes/vinaya-strict/bin/other.ts'\n`
    })
    expect(compareBase(root, base).failures[0]).toContain('apps/cli/src/lib/launch.ts: counts 2, base 1')
  })

  test('(d) a path in a comment re-pointed to its moved file keeps its count, and a comment naming another process file is growth', () => {
    const comment = (path: string): string => `// The entry point lives in ${path}.\n${BODY}\n`
    const { root, base } = plantedRepository({
      'apps/cli/src/lib/dispatch.ts': `export function dispatchRole() {}\n${BODY}\n`,
      'packages/sources/src/notes.ts': comment('apps/cli/src/lib/dispatch.ts')
    })
    expect(countTree(root)).toEqual({})
    commitBaseline(root, {
      ...move(root, 'apps/cli/src/lib/dispatch.ts', 'harness/processes/vinaya-strict/loops/dispatch.ts'),
      'packages/sources/src/notes.ts': comment('harness/processes/vinaya-strict/loops/dispatch.ts')
    })
    expect(countTree(root)).toEqual({ 'packages/sources/src/notes.ts': 1 })
    expect(compareBase(root, base)).toMatchObject({ failures: [], baseTotal: 0, headTotal: 0 })

    commitBaseline(root, {
      'harness/processes/vinaya-strict/loops/seats.ts': `export function seats() {}\n${BODY}\n`,
      'packages/sources/src/notes.ts': `${comment('harness/processes/vinaya-strict/loops/dispatch.ts')}${comment('harness/processes/vinaya-strict/loops/seats.ts')}`
    })
    expect(compareBase(root, base).failures[0]).toContain(
      'packages/sources/src/notes.ts: counts 1, base 0 — above its base entry'
    )
  })

  test('(e) a file moved from a path the ratchet does not scan into one it scans brings its own count, and a unit added in the move is growth', () => {
    const script = `// runs under the developer's sandbox\n${BODY}\n`
    const { root, base } = plantedRepository({ 'apps/cli/scripts/probe.ts': script })
    expect(countTree(root)).toEqual({})
    commitBaseline(root, move(root, 'apps/cli/scripts/probe.ts', 'harness/kernel/isolation/probe.ts'))
    expect(countTree(root)).toEqual({ 'harness/kernel/isolation/probe.ts': 1 })
    expect(compareBase(root, base)).toMatchObject({ failures: [], baseTotal: 1, headTotal: 1 })

    commitBaseline(root, {
      'harness/kernel/isolation/probe.ts': `// runs under the developer's sandbox, for the reviewer\n${BODY}\n`
    })
    expect(compareBase(root, base).failures[0]).toContain(
      'harness/kernel/isolation/probe.ts: counts 2, base 1 — above the base entry of apps/cli/scripts/probe.ts, which it was renamed from'
    )
  })

  test('(e) a test-path helper moved into a scanned root brings its own count, and a new file there still fails', () => {
    const helper = `// the developer fixture\n${BODY}\n`
    const { root, base } = plantedRepository({ 'apps/cli/tests/lib/probe.ts': helper })
    commitBaseline(root, move(root, 'apps/cli/tests/lib/probe.ts', 'harness/kernel/isolation/dispatch/probe.ts'))
    expect(compareBase(root, base)).toMatchObject({ failures: [], baseTotal: 1, headTotal: 1 })

    commitBaseline(root, { 'harness/kernel/isolation/fresh.ts': `// the developer\n${BODY}\n` })
    expect(compareBase(root, base).failures[0]).toContain(
      'harness/kernel/isolation/fresh.ts: counts 1, base 0 — a file with no base entry counts above zero'
    )
  })
})

// ── Ownership transfer with a forwarding entry ──────────────────────────────

describe('an ownership transfer that keeps a forwarding entry is a relocation', () => {
  const OLD = 'packages/aeg-core/src/baseline-capture.ts'
  const OWNER = 'harness/processes/vinaya-strict/tools/baseline-capture.ts'
  const FORWARD = "export * from '../../../harness/processes/vinaya-strict/tools/baseline-capture.ts'\n"
  const CAPTURED_FROM = 'harness/processes/vinaya-strict/checks/baseline-capture.ts'
  const captured = readFileSync(join(REPOSITORY_ROOT, CAPTURED_FROM), 'utf8')

  function transferred(oldContent: string): { root: string; base: string } {
    const { root, base } = plantedRepository({ [OLD]: captured, 'harness/kernel/gates/kernel.ts': 'export {}\n' })
    commit(root, { [OLD]: oldContent, [OWNER]: captured, [OWNERSHIP_MAP_PATH]: JSON.stringify({ [OLD]: OWNER }) })
    return { root, base }
  }

  test('the capture module, counting zero today, kept as a pure re-export of its mapped process owner passes', () => {
    expect(countSource(captured)).toBe(0)
    const { root, base } = transferred(`/** Moved to its process owner. */\n${FORWARD}`)
    expect(countTree(root)).toEqual({})
    expect(compareBase(root, base)).toMatchObject({ notice: null, failures: [], headTotal: 0 })
  })

  test('the same entry with executable code added is refused', () => {
    const { root, base } = transferred(`${FORWARD}export const extra = captureBaseline\n`)
    expect(compareBase(root, base).failures[0]).toContain(
      `ownership map entry refused: ${OLD} holds code beyond forwarding statements`
    )
  })

  test('the same entry with an unrelated process import is refused', () => {
    const { root, base } = transferred(
      `${FORWARD}export { other } from '../../../harness/processes/vinaya-strict/tools/other.ts'\n`
    )
    commit(root, { 'harness/processes/vinaya-strict/tools/other.ts': 'export const other = 1\n' })
    expect(compareBase(root, base).failures[0]).toContain(`ownership map entry refused: ${OLD} forwards to`)
  })

  test('a map entry for a file that is not pure forwarding is refused', () => {
    const tree = { isFile: (path: string) => path === OWNER, isDirectory: () => false }
    expect(ownershipRefusals({ [OLD]: OWNER }, () => captured, tree)[0]).toContain(
      `${OLD} holds no forwarding statement`
    )
    expect(ownershipRefusals({ [OLD]: OWNER }, () => FORWARD, tree)).toEqual([])
  })

  test("a scanned owner inherits the old file's base entry", () => {
    const old = 'packages/aeg-core/src/seats.ts'
    const owner = 'harness/kernel/gates/seats.ts'
    const { root, base } = plantedRepository({ [old]: `// the developer and the reviewer\n${BODY}\n` })
    commitBaseline(root, {
      [old]: "export * from '../../../harness/kernel/gates/seats.ts'\n",
      [owner]: `// the developer and the reviewer\n${BODY}\n`,
      [OWNERSHIP_MAP_PATH]: JSON.stringify({ [old]: owner })
    })
    expect(compareBase(root, base)).toMatchObject({ failures: [], baseTotal: 2, headTotal: 2 })
  })

  test("the kernel's indirect-boundary check follows the entry to its process owner", () => {
    const { root } = transferred(FORWARD)
    commit(root, {
      'harness/kernel/gates/kernel.ts':
        "import { captureBaseline } from '../../../packages/aeg-core/src/baseline-capture.ts'\n"
    })
    expect(importsThroughForwarding(root)).toEqual([
      `harness/kernel/gates/kernel.ts imports ../../../packages/aeg-core/src/baseline-capture.ts, which forwards to ${OWNER}`
    ])
  })
})

// ── Continuous integration ──────────────────────────────────────────────────

describe('continuous integration runs the ratchet on every pull request', () => {
  const RATCHET_STEP = 'Test the architecture ratchet against the base'
  const workflow = parse(readFileSync(join(REPOSITORY_ROOT, '.github/workflows/ci.yml'), 'utf8')) as {
    jobs: Record<string, { if?: unknown; steps: Array<{ name?: string; if?: unknown; run?: string }> }>
  }

  test('the build job has no condition that skips it', () => {
    expect(workflow.jobs.build).toBeDefined()
    expect(workflow.jobs.build?.if).toBeUndefined()
  })

  test('the build job runs the ratchet test and the base comparison, with no condition on the step', () => {
    const step = workflow.jobs.build?.steps.find((s) => s.name === RATCHET_STEP)
    expect(step).toBeDefined()
    expect(step?.if).toBeUndefined()
    expect(step?.run).toContain('bun test tests/architecture.test.ts')
    expect(step?.run).toContain('bun harness/kernel/tests/architecture-ratchet.ts --compare-base "$BASE_SHA"')
  })
})
