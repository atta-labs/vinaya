import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

/**
 * A CLI test that does not exercise a real vendor sandbox gives the same
 * result on macOS and on Linux. Pre-push runs on a Mac and CI runs only on
 * Linux, so a test that reads the host platform passes in one place and fails
 * in the other; platform-dependent behaviour a test touches is injected, never
 * read from the host.
 *
 * The check reads the TypeScript syntax tree of every file under
 * `apps/cli/tests` (never a regular expression over text) and finds every read
 * of the host platform: `process.platform`, `process['platform']`, a
 * destructured `platform` out of `process`, and a call to `platform()` from
 * `node:os`. A file that reads it must be on `REAL_SANDBOX_FILES` with the
 * real-sandbox reason that justifies it. The list covers the tests that verify
 * or spawn the real confinement path. It may only shrink: a file that no longer reads the platform fails until its entry is deleted, and the list
 * carries a size ceiling that only goes down.
 */

const TESTS_ROOT = import.meta.dir

/** Syntax-tree walk: the host-platform reads in one source text, as 1-based line numbers. */
export function hostPlatformReads(fileName: string, source: string): number[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true)
  const osNamespaces = new Set<string>()
  const osPlatformFns = new Set<string>()
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    if (!['node:os', 'os'].includes(statement.moduleSpecifier.text)) continue
    const clause = statement.importClause
    if (!clause) continue
    if (clause.name) osNamespaces.add(clause.name.text)
    const bindings = clause.namedBindings
    if (bindings && ts.isNamespaceImport(bindings)) osNamespaces.add(bindings.name.text)
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text === 'platform') osPlatformFns.add(element.name.text)
      }
    }
  }

  // `const p = process` (or `globalThis.process`) makes `p` read the host too.
  const processAliases = new Set<string>(['process'])
  const isGlobalProcess = (node: ts.Expression): boolean =>
    (ts.isIdentifier(node) && node.text === 'process') ||
    (ts.isPropertyAccessExpression(node) &&
      node.name.text === 'process' &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'globalThis')
  const collectAliases = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isGlobalProcess(node.initializer)
    )
      processAliases.add(node.name.text)
    ts.forEachChild(node, collectAliases)
  }
  collectAliases(sourceFile)

  const isProcess = (node: ts.Expression): boolean =>
    (ts.isIdentifier(node) && processAliases.has(node.text)) ||
    (ts.isPropertyAccessExpression(node) &&
      node.name.text === 'process' &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'globalThis')

  const lines: number[] = []
  const mark = (node: ts.Node): void => {
    lines.push(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'platform' && isProcess(node.expression)) mark(node)
    else if (
      ts.isElementAccessExpression(node) &&
      isProcess(node.expression) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === 'platform'
    )
      mark(node)
    else if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      isProcess(node.initializer) &&
      node.name.elements.some((e) => (e.propertyName ?? e.name).getText(sourceFile) === 'platform')
    )
      mark(node)
    else if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (ts.isIdentifier(callee) && osPlatformFns.has(callee.text)) mark(node)
      else if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'platform' &&
        ts.isIdentifier(callee.expression) &&
        osNamespaces.has(callee.expression.text)
      )
        mark(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return lines
}

/**
 * The only test files allowed to read the host platform — each one verifies or
 * spawns the real confinement path of the host it runs on, so its answer is per platform by
 * design. The list may only shrink; never add an entry without the real-sandbox
 * reason beside it.
 */
const REAL_SANDBOX_FILES: Readonly<Record<string, string>> = {
  'sandbox-conformance/sandbox-conformance.test.ts':
    "drives each vendor's real sandbox on the host and asserts what it really confines",
  'lib/dispatch/linux-sandbox-probe.test.ts':
    'its live block runs the real Linux sandbox probe, which exists only on a Linux host',
  'lib/dispatch/worker-boundary.test.ts':
    "asserts the host's own Seatbelt boundary and bubblewrap detection against the real host facts",
  'lib/dispatch/unattended.test.ts':
    "spawns the real dispatch command, whose confinement is the host's real sandbox, so its confinement cases are per platform",
  'commands/dispatch-task.test.ts':
    "spawns the real dispatch command, whose confinement is the host's real sandbox, so its cases are per platform",
  'lib/dev-review-loop.test.ts':
    "spawns the real dispatch command, whose confinement is the host's real sandbox, so its cases are per platform"
}

/** The size the list may not exceed. Lower it when an entry is removed. */
const REAL_SANDBOX_FILES_CEILING = 6

function testFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name !== 'fixtures' && name !== 'node_modules') out.push(...testFiles(path))
    } else if (name.endsWith('.ts')) out.push(path)
  }
  return out
}

describe('hostPlatformReads — the syntax-tree classifier', () => {
  it('finds process.platform, its bracket form, a destructure, and node:os platform()', () => {
    const source = [
      "import { platform } from 'node:os'",
      "import * as os from 'node:os'",
      'const a = process.platform',
      "const b = process['platform']",
      'const { platform: c } = process',
      'const d = platform()',
      'const e = os.platform()',
      'const p = process',
      'const f = p.platform',
      'const g = globalThis.process.platform'
    ].join('\n')
    expect(hostPlatformReads('x.ts', source)).toEqual([3, 4, 5, 6, 7, 9, 10])
  })

  it('ignores a platform word in a string, a comment, a deps object, or another receiver', () => {
    const source = [
      '// process.platform',
      "const a = 'process.platform'",
      "const b = { platform: 'darwin' }",
      'const c = deps.platform',
      'const d = other.platform()'
    ].join('\n')
    expect(hostPlatformReads('x.ts', source)).toEqual([])
  })
})

describe('CLI tests do not read the host platform outside the real-sandbox list', () => {
  const readers = new Map<string, number[]>()
  for (const file of testFiles(TESTS_ROOT)) {
    const lines = hostPlatformReads(file, readFileSync(file, 'utf8'))
    if (lines.length > 0) readers.set(relative(TESTS_ROOT, file), lines)
  }

  it('every file that reads the host platform is on the list', () => {
    const unlisted = [...readers]
      .filter(([file]) => !(file in REAL_SANDBOX_FILES))
      .map(([file, lines]) => `${file}:${lines[0]}`)
    expect(
      unlisted,
      'inject the platform instead of reading the host, or list the file with its real-sandbox reason'
    ).toEqual([])
  })

  it('every listed file still reads the host platform, so the list only shrinks', () => {
    const stale = Object.keys(REAL_SANDBOX_FILES).filter((file) => !readers.has(file))
    expect(stale, 'delete the entry: the file no longer reads the host platform').toEqual([])
  })

  it('the list never exceeds its ceiling and every entry states a reason', () => {
    expect(Object.keys(REAL_SANDBOX_FILES).length).toBeLessThanOrEqual(REAL_SANDBOX_FILES_CEILING)
    for (const reason of Object.values(REAL_SANDBOX_FILES)) expect(reason.trim().length).toBeGreaterThan(0)
  })
})
