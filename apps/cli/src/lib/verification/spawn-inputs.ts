/**
 * Detects a test file's own spawn of a program entrypoint as a fresh
 * subprocess, so the selector can give it one synthetic edge into that
 * entrypoint's real import graph.
 *
 * ## The gap this closes
 *
 * A test that runs `<binary> <entrypoint> <args>` as a fresh subprocess and
 * reads its stdout/stderr names no import of the code it exercises: it proves
 * behaviour by observing the program from outside, not by calling anything. No
 * import edge exists for reachability to walk, so a change to any file the
 * entrypoint transitively imports can break such a test while it stays
 * unselected.
 *
 * ## A private evaluator, not a shared one
 *
 * `scanner-inputs.ts` statically evaluates a file's own top-level path
 * bindings in the same style this file needs. It is NOT reused here:
 * extending it to also resolve `dirname(fileURLToPath(import.meta.url))` —
 * the idiom an entrypoint constant is usually written with — changes what the
 * tree-scanner classifier answers for any OTHER file that declares a
 * similarly-shaped binding. This module's evaluator is therefore a private
 * copy, scoped to this file's own two questions — is an argument the literal
 * binary, is it the entrypoint path — never imported by or exported to
 * `scanner-inputs.ts`.
 *
 * ## Callee-agnostic on purpose
 *
 * A spawn is often made through a wrapper (`spawnSyncBudgeted('bun', [INDEX,
 * ...args])`) whose name no fixed callee list anticipates. So detection looks
 * at every call expression's own ARGUMENTS, never its callee name: the two
 * signals below are just as visible through a wrapper's call site as through a
 * direct one, provided the caller still writes the binary and the path as
 * literals or bindings in its own file.
 *
 * ## The two signals, and why neither alone is precise
 *
 * Each call expression's own arguments — plus one level into an array-literal
 * argument, the `[binary, ...args]` shape spawn APIs take — are evaluated for
 * two independent facts: does some argument evaluate to the literal binary,
 * and does some argument evaluate to the entrypoint itself. Neither alone
 * proves the call spawns that entrypoint — the binary alone still spawns
 * *something* (a different script), and the entrypoint path alone could be
 * handed to a binary this file never proves is the expected one. Both
 * together, on the SAME call, is the one shape earning the precise edge.
 */
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { TypeScriptApi } from './compiler-graph.js'

export type SpawnClassification = 'entrypoint' | 'fallback'

/** One program a test may spawn: the binary that runs it and its entrypoint file, both as the test writes them (the entrypoint absolute). */
export type SpawnProgram = { binary: string; entrypoint: string }

/**
 * Statically evaluates an expression to the string it provably IS, or `null`
 * when it is not one this can prove — a private copy of the tree-scanner
 * classifier's own path evaluator, extended with `dirname(…)` and
 * `import.meta.url`. A plain string literal evaluates to itself unchanged, so
 * the same evaluator answers both this file's questions: is this a path, is
 * this the literal binary name.
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
 * Classifies one test file's own spawn shapes against `program`.
 *
 * `'entrypoint'` — some call carries BOTH signals together: this file
 * provably spawns `<binary> <entrypoint>`, so it earns the precise synthetic
 * edge straight into the entrypoint's own already-computed import graph — the
 * entrypoint's real edges do the rest, exactly as they do for a file that
 * imports it directly.
 *
 * `'fallback'` — some call carries ONE signal, but no single call anywhere in
 * the file ever carries both: the binary with no resolvable entrypoint
 * argument (a computed argument list, or the entrypoint threaded through a
 * wrapper's own PARAMETER — a shape no single-file, top-level-only static read
 * can see through), or a resolvable entrypoint argument spawned through a
 * binary this file never proves is the expected one. Real evidence the file
 * spawns the program somehow, just not provably enough to trust to the
 * entrypoint's own graph — so it earns the coarse edge over the entrypoint's
 * own source directory, never silence.
 *
 * `null` — neither signal appears anywhere in the file: an ordinary spawn of
 * something else entirely, left exactly as reachability already treats it.
 */
export function spawnEdgeOf(
  ts: TypeScriptApi,
  file: string,
  source: string,
  repoRoot: string,
  program: SpawnProgram
): SpawnClassification | null {
  const fileDir = dirname(file)
  let sourceFile: import('typescript').SourceFile
  try {
    sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true)
  } catch {
    return null
  }
  const bindings = collectTopLevelBindings(ts, sourceFile, file, fileDir, repoRoot)

  let classification: SpawnClassification | null = null
  const visit = (node: import('typescript').Node): void => {
    if (ts.isCallExpression(node)) {
      // One level into an array-literal argument (`[binary, ...args]`), which
      // is the shape spawn APIs take for their argv — a spread element
      // (`...args`) carries nothing this evaluator could ever resolve, so it
      // is skipped rather than evaluated for nothing.
      const candidates: import('typescript').Expression[] = []
      for (const arg of node.arguments) {
        candidates.push(arg)
        if (ts.isArrayLiteralExpression(arg)) {
          for (const element of arg.elements) {
            if (!ts.isSpreadElement(element)) candidates.push(element)
          }
        }
      }
      let sawBinary = false
      let sawEntrypoint = false
      for (const candidate of candidates) {
        const value = evaluateExpression(ts, candidate, file, fileDir, repoRoot, bindings)
        if (value === program.binary) sawBinary = true
        else if (value === program.entrypoint) sawEntrypoint = true
      }
      if (sawBinary && sawEntrypoint) classification = 'entrypoint'
      else if ((sawBinary || sawEntrypoint) && classification !== 'entrypoint') classification = 'fallback'
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return classification
}
