#!/usr/bin/env bun
/**
 * Breaks every changed line of a change: between a base and a head revision, every changed TypeScript file is
 * rewritten in place, inside a worktree of the head, so that each function holding a changed line throws on entry.
 * A test run against the mutated tree that still passes never exercised the change — the mutation half of the
 * safety check that tells whether a test selection kept the tests a change needs. This tool runs no test.
 *
 *   bun scripts/ci/mutate-changes.ts --base <rev> --head <rev> --worktree <dir>
 *
 * ## Which lines, which functions
 *
 * Each changed file's changed lines come from the selection package's `lineDiffRanges` between the file's base and
 * head blobs — every line of every hunk, not a hunk's first. A changed line is placed in the innermost function
 * (declaration, expression, arrow, method, accessor or constructor) whose text holds the whole line; when no function
 * holds the whole line (`const f = () => 1` at module scope), it is placed in each outermost function the line
 * reaches into. A hunk that only deletes lines (`+N,0`, N the line before the deletion) is placed in the innermost
 * function whose text runs across the point between line N and line N + 1, the function that held the deletion. A
 * line that falls in no function — module-scope code, a class field initialiser, a type — or whose innermost
 * function has no body (an overload, an abstract or `declare` member) is unplaceable and listed as such.
 *
 * ## The mutation
 *
 * Each placed function, however many changed lines it holds, gets one
 * `throw new Error("mutate-changes: <path>:<line> <function>")` at the start of its body, naming the file, the first
 * changed line placed in it and the function, so a failing test's output points back to the line. In a block body
 * the throw goes after the directive prologue and, in a constructor, after a top-level `super(…)` call, since a
 * throw before it is a type error. An arrow function with an expression body has it turned into
 * `{ throw …; return (<body>) }`, so what it returns when it does not throw is unchanged. In an async function the
 * throw rejects the returned promise, and in a generator it throws on the first `next()`. Every insertion stays on
 * the line it is inserted into, so line numbers in the mutated file are the head's.
 *
 * Every edit is a text insertion computed against the original text and applied from the end of the file, so no
 * edit shifts the position another was computed at. Nested functions' insertions never overlap: an inner function's
 * throw sits inside its own body, and where an outer arrow's expression body ends at the same point as an inner one
 * the closing insertions are ordered inner-first, the opening ones outer-first. The mutated text is parsed before
 * it is written; a file whose mutation does not parse is listed and left unmutated.
 *
 * ## Output
 *
 * One JSON object on stdout ({@link MutationReport}): the functions mutated per file, every unplaceable changed
 * line per file, every file left unmutated because its mutation would not parse, and every changed file not
 * mutated at all because it is not TypeScript or was deleted — so a documentation-only change reads as no mutation
 * rather than as a pass. The tool refuses, writing nothing, when a changed file in the worktree differs from the
 * head revision's.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type LineRange, lineDiffRanges } from '@attalabs/test-selection'
import ts from 'typescript'

/** Extensions mutated as TypeScript. */
const TYPESCRIPT = ['.ts', '.tsx', '.mts', '.cts']

/** One function a file's mutation made throw. */
export type MutatedFunction = {
  /** The function's name, `Class.method` for a class member, `<anonymous>` when it has none. */
  name: string
  /** The first changed line placed in it — the line its throw names. */
  line: number
  /** The line the function itself starts on. */
  functionLine: number
}

/** The outcome of mutating one file's text. */
export type FileMutation = {
  /** The mutated text, or `null` when nothing was placed or the mutation would not parse. */
  text: string | null
  functions: MutatedFunction[]
  /** Changed lines placed in no function; a deletion is named by the line before it (`0` at the top of the file). */
  unplaceable: number[]
  /** Why the mutated text was refused, when it would not parse. */
  parseError: string | null
}

export type MutationReport = {
  base: string
  head: string
  mutated: Array<{ file: string; functions: MutatedFunction[] }>
  unplaceable: Array<{ file: string; lines: number[] }>
  unparsed: Array<{ file: string; error: string }>
  skipped: Array<{ file: string; reason: 'not TypeScript' | 'deleted' }>
}

type FunctionNode =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration

type FunctionSpan = { node: FunctionNode; start: number; end: number; depth: number }

function isFunctionNode(node: ts.Node): node is FunctionNode {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  )
}

function scriptKindOf(file: string): ts.ScriptKind {
  return file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
}

/** Whether `file` is mutated as TypeScript. */
export function isTypeScriptFile(file: string): boolean {
  return TYPESCRIPT.some((ext) => file.endsWith(ext))
}

/** The changed lines of `after` against `before`, every line of every hunk, and the deletion points (`+N,0` hunks). */
export function changedLines(before: string, after: string): { lines: number[]; deletions: number[] } {
  const { afterRanges } = lineDiffRanges(before, after)
  const lines: number[] = []
  const deletions: number[] = []
  for (const range of afterRanges as readonly LineRange[]) {
    if (range.end < range.start) deletions.push(range.start)
    else for (let line = range.start; line <= range.end; line++) lines.push(line)
  }
  return { lines, deletions }
}

function propertyNameText(name: ts.PropertyName | ts.BindingName | undefined, sf: ts.SourceFile): string | null {
  if (name === undefined) return null
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text
  }
  return name.getText(sf)
}

/** A readable name for a function: its own, the binding or property it is assigned to, prefixed by its class. */
function functionName(node: FunctionNode, sf: ts.SourceFile): string {
  const owner = (n: ts.Node): string | null => {
    const parent = n.parent
    if (parent && (ts.isClassDeclaration(parent) || ts.isClassExpression(parent))) {
      return parent.name?.text ?? '<class>'
    }
    return null
  }
  const qualify = (n: ts.Node, name: string): string => {
    const cls = owner(n)
    return cls === null ? name : `${cls}.${name}`
  }
  if (ts.isConstructorDeclaration(node)) return qualify(node, 'constructor')
  if (ts.isGetAccessorDeclaration(node)) return qualify(node, `get ${propertyNameText(node.name, sf)}`)
  if (ts.isSetAccessorDeclaration(node)) return qualify(node, `set ${propertyNameText(node.name, sf)}`)
  if (ts.isMethodDeclaration(node)) return qualify(node, propertyNameText(node.name, sf) ?? '<anonymous>')
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) {
    if (node.name) return node.name.text
  }
  const parent = node.parent
  if (parent) {
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text
    if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
      const name = propertyNameText(parent.name, sf) ?? '<anonymous>'
      return ts.isPropertyDeclaration(parent) ? qualify(parent, name) : name
    }
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return parent.left.getText(sf)
    }
  }
  return '<anonymous>'
}

/**
 * Where the throw goes in a block body: after the directive prologue and a constructor's top-level `super(…)`, and
 * whether that is after a statement, which may lack its semicolon.
 */
function blockInsertionPoint(
  node: FunctionNode,
  body: ts.Block,
  sf: ts.SourceFile
): { position: number; afterStatement: boolean } {
  const opening = body.getStart(sf) + 1
  let position = opening
  const statements = body.statements
  let index = 0
  while (index < statements.length) {
    const statement = statements[index] as ts.Statement
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break
    position = statement.getEnd()
    index++
  }
  if (ts.isConstructorDeclaration(node)) {
    const superCall = statements.find(
      (s) =>
        ts.isExpressionStatement(s) &&
        ts.isCallExpression(s.expression) &&
        s.expression.expression.kind === ts.SyntaxKind.SuperKeyword
    )
    if (superCall) position = Math.max(position, superCall.getEnd())
  }
  return { position, afterStatement: position !== opening }
}

type Insertion = { position: number; text: string; closing: boolean; depth: number }

/**
 * Applies insertions computed against `text` from the end of the file. At one position closing insertions come
 * before opening ones, closings deepest-first and openings outermost-first, so nested arrows' wrappers nest.
 */
export function applyInsertions(text: string, insertions: readonly Insertion[]): string {
  const textual = [...insertions].sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position
    if (a.closing !== b.closing) return a.closing ? -1 : 1
    return a.closing ? b.depth - a.depth : a.depth - b.depth
  })
  let out = text
  // Apply from the end: the last insertion first, so every earlier position still points into unchanged text, and
  // at one position the textually later insertion first, so the earlier one lands in front of it.
  for (let i = textual.length - 1; i >= 0; i--) {
    const insertion = textual[i] as Insertion
    out = out.slice(0, insertion.position) + insertion.text + out.slice(insertion.position)
  }
  return out
}

/** The syntax errors of `text` parsed as the TypeScript of `file`, or `null` when it parses. */
export function parseErrorOf(file: string, text: string): string | null {
  const result = ts.transpileModule(text, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ESNext }
  })
  const diagnostics = result.diagnostics ?? []
  if (diagnostics.length === 0) return null
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, scriptKindOf(file))
  return diagnostics
    .map((d) => {
      const where = d.start === undefined ? '' : `${sf.getLineAndCharacterOfPosition(d.start).line + 1}: `
      return `${where}${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`
    })
    .join('; ')
}

/**
 * Mutates one file's head text so every function holding one of `lines`, or one of the `deletions` points, throws
 * on entry. `file` is the repository-relative path the throw names.
 */
export function mutateSource(
  file: string,
  text: string,
  changes: { lines: readonly number[]; deletions: readonly number[] }
): FileMutation {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, scriptKindOf(file))
  const spans: FunctionSpan[] = []
  const visit = (node: ts.Node, depth: number): void => {
    let childDepth = depth
    if (isFunctionNode(node)) {
      spans.push({ node, start: node.getStart(sf), end: node.getEnd(), depth })
      childDepth = depth + 1
    }
    ts.forEachChild(node, (child) => visit(child, childDepth))
  }
  visit(sf, 0)

  const lineCount = sf.getLineStarts().length
  const lineContent = (line: number): { start: number; end: number } | null => {
    if (line < 1 || line > lineCount) return null
    const lineStart = sf.getPositionOfLineAndCharacter(line - 1, 0)
    const lineEnd = line < lineCount ? sf.getPositionOfLineAndCharacter(line, 0) : text.length
    const raw = text.slice(lineStart, lineEnd)
    const leading = raw.length - raw.trimStart().length
    const trimmed = raw.trim()
    if (trimmed.length === 0) return { start: lineStart, end: lineStart }
    return { start: lineStart + leading, end: lineStart + leading + trimmed.length }
  }
  const innermost = (candidates: FunctionSpan[]): FunctionSpan | null =>
    candidates.reduce<FunctionSpan | null>((best, s) => (best === null || s.depth > best.depth ? s : best), null)

  /** The functions a changed line is placed in, or `null` when it is unplaceable. */
  const placeLine = (line: number): FunctionSpan[] | null => {
    const content = lineContent(line)
    if (content === null) return null
    const holding = innermost(spans.filter((s) => s.start <= content.start && content.end <= s.end))
    if (holding !== null) return holding.node.body === undefined ? null : [holding]
    const reached = spans.filter((s) => s.start < content.end && content.start < s.end)
    const outermost = reached.filter((s) => !reached.some((o) => o !== s && o.start <= s.start && s.end <= o.end))
    const withBody = outermost.filter((s) => s.node.body !== undefined)
    return withBody.length > 0 ? withBody : null
  }
  /** The function a `+N,0` deletion is placed in: the innermost one running across the end of line N. */
  const placeDeletion = (line: number): FunctionSpan[] | null => {
    if (line < 1 || line > lineCount) return null
    const content = lineContent(line)
    const lineStart = sf.getPositionOfLineAndCharacter(line - 1, 0)
    const point = content === null || content.end === content.start ? lineStart : content.end
    const holding = innermost(spans.filter((s) => s.start < point && point < s.end))
    if (holding === null || holding.node.body === undefined) return null
    return [holding]
  }

  const firstLine = new Map<FunctionSpan, number>()
  const unplaceable = new Set<number>()
  const place = (line: number, placed: FunctionSpan[] | null): void => {
    if (placed === null) {
      unplaceable.add(line)
      return
    }
    for (const span of placed) firstLine.set(span, Math.min(firstLine.get(span) ?? line, line))
  }
  for (const line of changes.lines) place(line, placeLine(line))
  for (const line of changes.deletions) place(line, placeDeletion(line))

  const placed = [...firstLine.entries()].sort(([a], [b]) => a.start - b.start)
  const functions: MutatedFunction[] = placed.map(([span, line]) => ({
    name: functionName(span.node, sf),
    line,
    functionLine: sf.getLineAndCharacterOfPosition(span.start).line + 1
  }))
  const unplaceableLines = [...unplaceable].sort((a, b) => a - b)
  if (placed.length === 0) return { text: null, functions, unplaceable: unplaceableLines, parseError: null }

  const insertions: Insertion[] = []
  for (const [index, [span]] of placed.entries()) {
    const fn = functions[index] as MutatedFunction
    const body = span.node.body as ts.ConciseBody
    const thrown = `throw new Error(${JSON.stringify(`mutate-changes: ${file}:${fn.line} ${fn.name}`)});`
    if (ts.isBlock(body)) {
      const point = blockInsertionPoint(span.node, body, sf)
      insertions.push({
        position: point.position,
        text: point.afterStatement ? `; ${thrown}` : ` ${thrown}`,
        closing: false,
        depth: span.depth
      })
    } else {
      insertions.push({ position: body.getStart(sf), text: `{ ${thrown} return (`, closing: false, depth: span.depth })
      insertions.push({ position: body.getEnd(), text: ') }', closing: true, depth: span.depth })
    }
  }
  const mutated = applyInsertions(text, insertions)
  const parseError = parseErrorOf(file, mutated)
  if (parseError !== null) return { text: null, functions, unplaceable: unplaceableLines, parseError }
  return { text: mutated, functions, unplaceable: unplaceableLines, parseError: null }
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 30 })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.error?.message}`)
  return result.stdout
}

/**
 * Mutates, in place inside `worktree` (a checkout of `head`), every TypeScript file changed between `base` and
 * `head`, and reports what it did. Refuses, writing nothing, when a changed file in the worktree differs from the
 * head revision's.
 */
export function mutateChanges(options: { base: string; head: string; worktree: string }): MutationReport {
  const { worktree } = options
  const base = git(worktree, ['rev-parse', '--verify', `${options.base}^{commit}`]).trim()
  const head = git(worktree, ['rev-parse', '--verify', `${options.head}^{commit}`]).trim()
  const fields = git(worktree, ['diff', '--name-status', '-z', '--no-renames', base, head]).split('\0')
  const changed: Array<{ status: string; file: string }> = []
  for (let i = 0; i + 1 < fields.length; i += 2) {
    changed.push({ status: fields[i] as string, file: fields[i + 1] as string })
  }
  changed.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))

  const report: MutationReport = { base, head, mutated: [], unplaceable: [], unparsed: [], skipped: [] }
  const writes: Array<{ path: string; text: string }> = []
  for (const { status, file } of changed) {
    if (!isTypeScriptFile(file)) {
      report.skipped.push({ file, reason: 'not TypeScript' })
      continue
    }
    if (status.startsWith('D')) {
      report.skipped.push({ file, reason: 'deleted' })
      continue
    }
    const after = git(worktree, ['show', `${head}:${file}`])
    const before = status.startsWith('A') ? '' : git(worktree, ['show', `${base}:${file}`])
    const path = join(worktree, file)
    if (readFileSync(path, 'utf8') !== after) {
      throw new Error(`${file} in the worktree differs from ${head}; the worktree must be a clean checkout of the head`)
    }
    const result = mutateSource(file, after, changedLines(before, after))
    if (result.unplaceable.length > 0) report.unplaceable.push({ file, lines: result.unplaceable })
    if (result.parseError !== null) report.unparsed.push({ file, error: result.parseError })
    else if (result.text !== null) {
      report.mutated.push({ file, functions: result.functions })
      writes.push({ path, text: result.text })
    }
  }
  for (const { path, text } of writes) writeFileSync(path, text)
  return report
}

const USAGE = 'usage: mutate-changes.ts --base <rev> --head <rev> --worktree <dir>\n'

/** Parses the command line; `null` when it is not a complete, known set of flags. */
export function parseArgs(argv: readonly string[]): { base: string; head: string; worktree: string } | null {
  const values: Record<string, string> = {}
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] as string
    const value = argv[i + 1]
    if (!['--base', '--head', '--worktree'].includes(flag) || value === undefined || flag in values) return null
    values[flag] = value
  }
  const { '--base': base, '--head': head, '--worktree': worktree } = values
  if (base === undefined || head === undefined || worktree === undefined) return null
  return { base, head, worktree }
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2))
  if (options === null) {
    process.stderr.write(USAGE)
    process.exitCode = 2
  } else {
    try {
      process.stdout.write(`${JSON.stringify(mutateChanges(options), null, 2)}\n`)
    } catch (error) {
      process.stderr.write(`mutate-changes: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    }
  }
}
