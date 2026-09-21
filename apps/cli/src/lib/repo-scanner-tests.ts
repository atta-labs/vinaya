/**
 * Finds the test files whose INPUT is the repository tree itself, so the
 * selector can select them from what they scan rather than from what they
 * import.
 *
 * ## The gap this closes
 *
 * Import-graph reachability can only select a test that imports the file that
 * changed. A test that instead WALKS the tree from disk — reading every source
 * file under a directory and asserting something about all of them — names none
 * of its inputs in any import, so no edge exists for reachability to follow. A
 * change to any file it scans can break it while it stays unselected, and that
 * is not hypothetical: a one-file test change passed this repository's pre-push
 * hook and failed CI on exactly such a test, the one that audits every
 * real-process call site under `apps/cli/tests`.
 *
 * ## Scanning the real tree versus walking a fixture
 *
 * Most tests that call a directory walker walk a temporary directory they just
 * created, which is not this class at all — selecting those would be pure cost.
 * The distinguishing fact is where the walked path is ANCHORED: a real-tree
 * scanner derives its root from its own module location (`import.meta.url`,
 * `import.meta.dir`, `__dirname`) or from the process's working directory,
 * while a fixture walker derives it from `tmpdir()`/`mkdtemp`. So the root
 * expressions a file declares are evaluated statically, and only a file that
 * both declares a real-tree root AND calls a tree-reading API is classified.
 *
 * The scanned root is reported as specifically as the file declares it —
 * `apps/cli/tests` rather than the repository root, when that is what the file
 * actually walks — so the edge this produces stays as narrow as the test's own
 * input is. A file whose root cannot be narrowed falls back to the repository
 * root, which selects it on any change: wider, and never wrong.
 */
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { TypeScriptApi } from './ts-module-graph.js'

/** Functions whose call means "read a directory tree from disk", by the name the call site uses. */
const TREE_READERS = new Set([
  'readdirSync',
  'readdir',
  'opendirSync',
  'opendir',
  'globSync',
  'globIterateSync',
  'readdirp'
])

/** A `git` invocation that lists tracked files is a tree read whose root is the repository. */
const GIT_TREE_SUBCOMMAND = 'ls-files'

/** Process-spawning calls, checked for {@link GIT_TREE_SUBCOMMAND}. */
const SPAWN_CALLS = new Set(['execFileSync', 'execSync', 'spawnSync', 'spawn', 'exec', 'execFile'])

export type RepoScannerTest = {
  /** Absolute path of the test file. */
  file: string
  /** Absolute directory prefixes it reads from disk — a change under any of them can break it. */
  scannedRoots: string[]
}

/**
 * Statically evaluates a path expression to an absolute path, or `null` when it
 * is not one this can prove. Understands the shapes a real-tree root is written
 * with — `import.meta.dir`, `fileURLToPath(new URL('.', import.meta.url))`,
 * `process.cwd()`, `join`/`resolve` over those and string literals, and an
 * identifier bound to any of them earlier in the file.
 */
function evaluatePath(
  ts: TypeScriptApi,
  node: import('typescript').Node,
  fileDir: string,
  repoRoot: string,
  bindings: ReadonlyMap<string, string>
): string | null {
  if (ts.isStringLiteral(node)) return node.text
  // `__dirname` is a plain identifier, so it is answered before the binding
  // lookup below could shadow it with `undefined`.
  if (ts.isIdentifier(node)) return node.text === '__dirname' ? fileDir : (bindings.get(node.text) ?? null)
  // `import.meta.dir` — the file's own location.
  if (ts.isPropertyAccessExpression(node)) {
    const text = node.getText()
    return text === 'import.meta.dir' || text === 'import.meta.dirname' ? fileDir : null
  }
  if (ts.isCallExpression(node)) {
    const callee = ts.isIdentifier(node.expression)
      ? node.expression.text
      : ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : ''
    if (callee === 'cwd') return repoRoot
    if (callee === 'fileURLToPath') {
      const arg = node.arguments[0]
      return arg ? evaluatePath(ts, arg, fileDir, repoRoot, bindings) : null
    }
    if (callee === 'join' || callee === 'resolve') {
      const parts: string[] = []
      for (const arg of node.arguments) {
        const part = evaluatePath(ts, arg, fileDir, repoRoot, bindings)
        if (part === null) return null
        parts.push(part)
      }
      if (parts.length === 0) return null
      const first = parts[0] as string
      if (!isAbsolute(first)) return null
      return callee === 'join' ? join(...parts) : resolve(...parts)
    }
    return null
  }
  // `new URL('.', import.meta.url)` — a directory URL relative to this module.
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL') {
    const base = node.arguments?.[1]
    if (base?.getText() !== 'import.meta.url') return null
    const relativeArg = node.arguments?.[0]
    if (!relativeArg || !ts.isStringLiteral(relativeArg)) return null
    return join(fileDir, relativeArg.text)
  }
  return null
}

/**
 * Classifies one test file: the directory prefixes it reads from the REAL tree,
 * or an empty list when it reads none (it imports its inputs, or it only walks
 * a temporary fixture it made itself).
 */
export function scannedRootsOf(ts: TypeScriptApi, file: string, source: string, repoRoot: string): string[] {
  const fileDir = dirname(file)
  let sourceFile: import('typescript').SourceFile
  try {
    sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true)
  } catch {
    return []
  }

  // Every top-level `const` bound to a provable absolute path, in order, so a
  // later one can refer to an earlier (`const TESTS = join(REPO_ROOT, '...')`).
  const bindings = new Map<string, string>()
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue
      const value = evaluatePath(ts, declaration.initializer, fileDir, repoRoot, bindings)
      if (value !== null) bindings.set(declaration.name.text, value)
    }
  }

  // Roots inside the repository, and never a temporary directory: a fixture
  // walker anchors on `tmpdir()`, which never evaluates to a path under the
  // repository root, so it drops out here on its own.
  const declaredRoots = [...bindings.values()].filter((p) => p === repoRoot || p.startsWith(`${repoRoot}/`))

  /** The paths actually handed to a tree-reading call — the narrowest honest answer. */
  const walked = new Set<string>()
  let readsTreeSomehow = false
  const visit = (node: import('typescript').Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : ''
      if (TREE_READERS.has(callee)) {
        readsTreeSomehow = true
        const arg = node.arguments[0]
        const target = arg ? evaluatePath(ts, arg, fileDir, repoRoot, bindings) : null
        if (target && (target === repoRoot || target.startsWith(`${repoRoot}/`))) walked.add(target)
      } else if (SPAWN_CALLS.has(callee)) {
        // `git ls-files` lists the whole tracked tree. Its root is wherever the
        // child runs, which is not statically known, so it is taken as the
        // repository — the widest and therefore safe reading. A fixture that
        // runs it inside a temporary repository is over-selected by this, which
        // is the direction that costs a little time rather than correctness.
        if (node.arguments.some((a) => a.getText().includes(GIT_TREE_SUBCOMMAND))) {
          readsTreeSomehow = true
          walked.add(repoRoot)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sourceFile, visit)
  if (!readsTreeSomehow) return []

  // A walk whose argument could not be evaluated (a path threaded through a
  // recursive helper as a parameter, which is the common shape) falls back to
  // every real root the file declared — wider than the one directory it walks,
  // never narrower. A file that declared none reads no real tree.
  const roots = walked.size > 0 ? [...walked] : declaredRoots
  if (roots.length === 0) return []
  // Drop a root that already lies INSIDE another one: the shallower prefix
  // subsumes it, and keeping both would only duplicate the same edge.
  return roots.filter((r) => !roots.some((other) => other !== r && r.startsWith(`${other}/`))).sort()
}
