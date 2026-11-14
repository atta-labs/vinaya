import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

/**
 * A test that does not exercise a real vendor sandbox gives the same result on
 * macOS and on Linux. Pre-push runs on a Mac and CI runs only on Linux, so a
 * test that reads the host platform passes in one place and fails in the
 * other; platform-dependent behaviour a test touches is injected, never read
 * from the host.
 *
 * The check reads the TypeScript syntax tree (never a regular expression over
 * text) of every tracked test file in the repository — `*.test.ts`,
 * `*.test.tsx` and `*.spec.ts`, outside any `fixtures` folder — and of every
 * `.ts` file under the CLI and process test folders it has always walked, and
 * finds every read of the host platform: `process.platform`,
 * `process['platform']`, a destructured `platform` out of `process`, and a call
 * to `platform()` from `node:os`. A file that reads it must be on the
 * `real-sandbox` list of `scripts/test-suites/file-level-tests.json` with the
 * real-sandbox reason that justifies it. The list covers the tests that verify
 * or spawn the real confinement path. It may only shrink: a file that no
 * longer reads the platform fails until its entry is deleted, and the list
 * carries a size ceiling, kept here beside the walk, that only goes down.
 */

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')

/** The tests selection must keep at file level: one named list each, every entry a repository-relative path and its reason. */
const FILE_LEVEL_TESTS_PATH = join(REPO_ROOT, 'scripts', 'test-suites', 'file-level-tests.json')

/** The folders whose every `.ts` file is read, helpers included: the CLI's tests and the process tests moved from it. */
const WHOLE_FOLDERS = [
  'apps/cli/tests/',
  'harness/processes/vinaya-strict/tests/standalone/',
  'harness/processes/vinaya-strict/tests/commands/',
  'harness/processes/vinaya-strict/tests/lib/'
]
/** A helper outside those folders that launches a real sandbox, read like a test. */
const HELPER_FILES = ['harness/processes/vinaya-strict/integration/isolation/sandbox-conformance/sandbox-launch.ts']
/** A test-shaped file anywhere in the repository. */
const TEST_FILE = /\.(test\.tsx?|spec\.ts)$/
/** Folders never read: fixture data, installed packages, other worktrees and build output. */
const SKIPPED_SEGMENTS = new Set(['fixtures', 'node_modules', '.worktrees', 'dist', 'build', 'out', '.next', '.turbo'])

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
 * The only files allowed to read the host platform — each one verifies or
 * spawns the real confinement path of the host it runs on, so its answer is per
 * platform by design. The list may only shrink; never add an entry without the
 * real-sandbox reason beside it.
 */
function realSandboxFiles(): Readonly<Record<string, unknown>> {
  const lists = JSON.parse(readFileSync(FILE_LEVEL_TESTS_PATH, 'utf8')) as Record<string, unknown>
  const list = lists['real-sandbox']
  if (typeof list !== 'object' || list === null || Array.isArray(list))
    throw new Error(`${FILE_LEVEL_TESTS_PATH} has no "real-sandbox" object`)
  return list as Record<string, unknown>
}

const REAL_SANDBOX_FILES = realSandboxFiles()

/** The size the list may not exceed. Lower it when an entry is removed. */
const REAL_SANDBOX_FILES_CEILING = 7

/** Every tracked file the check reads, repository-relative, from `git ls-files`: never an untracked or ignored one. */
function checkedFiles(): string[] {
  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' })
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`)
  return listed.stdout
    .split('\0')
    .filter((file) => file.length > 0)
    .filter((file) => !file.split('/').some((segment) => SKIPPED_SEGMENTS.has(segment)))
    .filter(
      (file) =>
        TEST_FILE.test(file) ||
        HELPER_FILES.includes(file) ||
        (file.endsWith('.ts') && WHOLE_FOLDERS.some((folder) => file.startsWith(folder)))
    )
    .filter((file) => existsSync(join(REPO_ROOT, file)))
    .sort()
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

describe('tests do not read the host platform outside the real-sandbox list', () => {
  const files = checkedFiles()
  const readers = new Map<string, number[]>()
  for (const file of files) {
    const lines = hostPlatformReads(file, readFileSync(join(REPO_ROOT, file), 'utf8'))
    if (lines.length > 0) readers.set(file, lines)
  }

  it('reads every tracked test file in the repository, outside fixtures', () => {
    expect(files).toContain('apps/cli/tests/platform-independence.test.ts')
    for (const top of ['apps/cli/src/', 'packages/', 'harness/kernel/', 'harness/processes/', 'scripts/'])
      expect(files.some((file) => file.startsWith(top) && TEST_FILE.test(file))).toBe(true)
    expect(files.filter((file) => file.split('/').includes('fixtures'))).toEqual([])
  })

  it('every file that reads the host platform is on the list', () => {
    const unlisted = [...readers]
      .filter(([file]) => !(file in REAL_SANDBOX_FILES))
      .map(([file, lines]) => `${file}:${lines[0]}`)
    expect(
      unlisted,
      'inject the platform instead of reading the host, or list the file with its real-sandbox reason in scripts/test-suites/file-level-tests.json'
    ).toEqual([])
  })

  it('every listed file still reads the host platform, so the list only shrinks', () => {
    const stale = Object.keys(REAL_SANDBOX_FILES).filter((file) => !readers.has(file))
    expect(stale, 'delete the entry: the file no longer reads the host platform').toEqual([])
  })

  it('the list never exceeds its ceiling and every entry states a reason', () => {
    expect(Object.keys(REAL_SANDBOX_FILES).length).toBeLessThanOrEqual(REAL_SANDBOX_FILES_CEILING)
    for (const reason of Object.values(REAL_SANDBOX_FILES)) {
      expect(typeof reason).toBe('string')
      expect(String(reason).trim().length).toBeGreaterThan(0)
    }
  })
})
