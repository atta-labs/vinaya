/**
 * Detects a test file's own spawn of the built CLI as a fresh subprocess, so
 * the selector can give it one synthetic edge into the entrypoint's real
 * import graph — the gap `repo-scanner-tests.ts` documents for a different
 * class of invisible test, closed here for this one.
 *
 * ## The gap this closes
 *
 * A test that runs `bun apps/cli/src/index.ts <args>` as a fresh subprocess
 * and reads its stdout/stderr names no import of the code it exercises: it
 * proves CLI behavior by observing the built binary from outside, not by
 * calling anything. No import edge exists for reachability to walk, so a
 * change to any file the entrypoint transitively imports can break such a
 * test while it stays unselected — measured live, a one-file change to
 * `apps/cli/src/lib/log-sink.ts` passed this repository's pre-push hook and
 * failed CI on exactly this class of test.
 *
 * ## A private evaluator, not a shared one
 *
 * `repo-scanner-tests.ts` already statically evaluates a file's own top-level
 * path bindings (`evaluatePath`), in the same style this file needs. It is
 * NOT reused here: extending it to also resolve `dirname(fileURLToPath(
 * import.meta.url))` — the idiom this suite's own `CLI_ROOT`/`INDEX` constants
 * are written with — changes what {@link scannedRootsOf} classifies for any
 * OTHER file that happens to declare a similarly-shaped binding, which is
 * this task's own boundary naming the repo-tree-scanner edge "already correct
 * and unchanged" (confirmed live: two unrelated test files' scanner
 * classification shifted the moment `evaluatePath` gained that support, with
 * this file's own detection turned off). This module's evaluator is
 * therefore a private copy, scoped to this file's own two questions — is an
 * argument the literal `'bun'`, is it the CLI's real entrypoint path — never
 * imported by or exported to `repo-scanner-tests.ts`.
 *
 * ## Callee-agnostic on purpose
 *
 * `repo-scanner-tests.ts`'s own `SPAWN_CALLS` set (fixed callee names:
 * `spawnSync`, `execFileSync`, …) is enough for detecting a `git ls-files`
 * tree read, because that call is always made directly. A CLI-spawning test
 * is not: this suite's own shared fixture (`tests/lib/process-fixture.ts`)
 * wraps the real `spawnSync` call inside `spawnSyncBudgeted`, so the test
 * file's own source reads `spawnSyncBudgeted('bun', [INDEX, ...args], …)` —
 * a callee name no fixed list anticipates, and a new wrapper written tomorrow
 * would name a callee no list update could anticipate either. So detection
 * here looks at every call expression's own ARGUMENTS, never its callee name:
 * the two signals below are just as visible through an indirect wrapper's own
 * call site as through a direct one, provided the wrapper's caller still
 * writes the binary and the path as literals/bindings in its own file.
 *
 * ## The two signals, and why neither alone is precise
 *
 * Each call expression's own arguments — plus one level into an array-literal
 * argument, the `[binary, ...args]` shape every spawn API in this suite uses
 * — are evaluated for two independent facts: does some argument evaluate to
 * the literal binary `'bun'`, and does some argument evaluate to `entrypoint`
 * itself. Neither alone proves the call spawns the built CLI's own
 * entrypoint — `'bun'` alone still spawns *something* named `'bun'` (a
 * different script, a check's own `bin/*.ts`), and the entrypoint path alone
 * could be handed to a binary this file never proves is `bun` (invoked
 * through a shell, or a binary bound to an unprovable expression). Both
 * together, on the SAME call, is the one shape earning the precise edge.
 */
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { TypeScriptApi } from './ts-module-graph.js'

export type CliSpawnClassification = 'entrypoint' | 'fallback'

/**
 * Statically evaluates an expression to the string it provably IS, or `null`
 * when it is not one this can prove — a private copy of
 * `repo-scanner-tests.ts`'s own `evaluatePath`, extended with the two idioms
 * this suite's own `CLI_ROOT`/`INDEX` constants need (`dirname(…)`,
 * `import.meta.url`) without changing that shared module's own behavior. A
 * plain string literal (`'bun'`) evaluates to itself unchanged, so the same
 * evaluator answers both this file's questions: is this a path, is this the
 * literal binary name.
 */
function evaluateExpression(
  ts: TypeScriptApi,
  node: import('typescript').Node,
  file: string,
  fileDir: string,
  repoRoot: string,
  bindings: ReadonlyMap<string, string>
): string | null {
  if (ts.isStringLiteral(node)) return node.text
  // `__dirname` is a plain identifier, so it is answered before the binding
  // lookup below could shadow it with `undefined`.
  if (ts.isIdentifier(node)) return node.text === '__dirname' ? fileDir : (bindings.get(node.text) ?? null)
  // `import.meta.dir` — the file's own directory; `import.meta.url` — the
  // file's own path, evaluated straight to the plain absolute path rather
  // than a real `file://` URL string, so `fileURLToPath` wrapping it below is
  // a no-op pass-through instead of needing real URL parsing.
  if (ts.isPropertyAccessExpression(node)) {
    const text = node.getText()
    if (text === 'import.meta.dir' || text === 'import.meta.dirname') return fileDir
    if (text === 'import.meta.url') return file
    return null
  }
  if (ts.isCallExpression(node)) {
    const callee = ts.isIdentifier(node.expression)
      ? node.expression.text
      : ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : ''
    if (callee === 'cwd') return repoRoot
    if (callee === 'dirname') {
      const arg = node.arguments[0]
      const inner = arg ? evaluateExpression(ts, arg, file, fileDir, repoRoot, bindings) : null
      return inner !== null ? dirname(inner) : null
    }
    if (callee === 'fileURLToPath') {
      const arg = node.arguments[0]
      return arg ? evaluateExpression(ts, arg, file, fileDir, repoRoot, bindings) : null
    }
    if (callee === 'join' || callee === 'resolve') {
      const parts: string[] = []
      for (const arg of node.arguments) {
        const part = evaluateExpression(ts, arg, file, fileDir, repoRoot, bindings)
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
 * Every top-level `const` bound to a provable value, in order, so a later one
 * can refer to an earlier (`const INDEX = join(CLI_ROOT, 'src', 'index.ts')`).
 * Scoped to top-level statements only, by design: a binding introduced inside
 * a function or test body is invisible here — a shape this cannot prove
 * degrades to this file's coarse fallback answer, never to a wrong one.
 */
function collectTopLevelBindings(
  ts: TypeScriptApi,
  sourceFile: import('typescript').SourceFile,
  file: string,
  fileDir: string,
  repoRoot: string
): Map<string, string> {
  const bindings = new Map<string, string>()
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue
      const value = evaluateExpression(ts, declaration.initializer, file, fileDir, repoRoot, bindings)
      if (value !== null) bindings.set(declaration.name.text, value)
    }
  }
  return bindings
}

/**
 * Classifies one test file's own spawn shapes against `entrypoint` (the CLI's
 * real entrypoint file, absolute path).
 *
 * `'entrypoint'` — some call carries BOTH signals together: this file
 * provably spawns `bun <entrypoint>`, so it earns the precise synthetic edge
 * straight into the entrypoint's own already-computed import graph — the
 * entrypoint's real edges do the rest, exactly as they do for a file that
 * imports it directly.
 *
 * `'fallback'` — some call carries ONE signal, but no single call anywhere in
 * the file ever carries both: `'bun'` with no resolvable entrypoint argument
 * (a computed argument list built by a helper, or the entrypoint path
 * threaded through a wrapper's own function PARAMETER rather than a
 * module-level binding — an indirect wrapper no single-file, top-level-only
 * static read can see through), or a resolvable entrypoint argument spawned
 * through a binary this file never proves is `'bun'` (a different, or
 * unprovably computed, binary). Real evidence the file spawns the built CLI
 * somehow, just not provably enough to trust to the entrypoint's own graph —
 * so it earns the coarse whole-package edge over the entrypoint's own source
 * directory, never silence.
 *
 * `null` — neither signal appears anywhere in the file: an ordinary spawn of
 * something else entirely (`git`, `chmod`, a local fixture script), left
 * exactly as reachability already treats it.
 */
export function cliSpawnEdgeOf(
  ts: TypeScriptApi,
  file: string,
  source: string,
  repoRoot: string,
  entrypoint: string
): CliSpawnClassification | null {
  const fileDir = dirname(file)
  let sourceFile: import('typescript').SourceFile
  try {
    sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true)
  } catch {
    return null
  }
  const bindings = collectTopLevelBindings(ts, sourceFile, file, fileDir, repoRoot)

  let classification: CliSpawnClassification | null = null
  const visit = (node: import('typescript').Node): void => {
    if (ts.isCallExpression(node)) {
      // One level into an array-literal argument (`[binary, ...args]`), which
      // is the shape every spawn API in this suite's own use takes for its
      // argv — a spread element (`...args`) carries nothing this evaluator
      // could ever resolve, so it is skipped rather than evaluated for nothing.
      const candidates: import('typescript').Expression[] = []
      for (const arg of node.arguments) {
        candidates.push(arg)
        if (ts.isArrayLiteralExpression(arg)) {
          for (const element of arg.elements) {
            if (!ts.isSpreadElement(element)) candidates.push(element)
          }
        }
      }
      let sawBun = false
      let sawEntrypoint = false
      for (const candidate of candidates) {
        const value = evaluateExpression(ts, candidate, file, fileDir, repoRoot, bindings)
        if (value === 'bun') sawBun = true
        else if (value === entrypoint) sawEntrypoint = true
      }
      if (sawBun && sawEntrypoint) classification = 'entrypoint'
      else if ((sawBun || sawEntrypoint) && classification !== 'entrypoint') classification = 'fallback'
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return classification
}
