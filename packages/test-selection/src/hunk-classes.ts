/**
 * Classifies each hunk of a change to one TypeScript file by its structure, so
 * a later rule can decide whether a test that never ran the changed code still
 * needs to run. It decides no selection itself: it reads two texts and returns
 * a classification.
 *
 * ## The three classes
 *
 * - **body-only** — the hunk lies strictly inside one function's block body,
 *   on both sides of the diff, and that function's signature text and the
 *   chain of declarations around it are unchanged. The hunk names the function
 *   and reports its body span and the spans of the functions nested in it on
 *   each side, so a caller can map line coverage onto the function's own
 *   lines.
 * - **inert-addition** — the hunk only adds top-level declarations that do
 *   nothing when the module loads and that no unchanged code can see: not
 *   exported, a type-only import, a type alias or interface, a function
 *   declaration, a plain class, or a `const` bound to a function or a
 *   primitive literal, under a name the old text never wrote.
 * - **unclassified** — anything else. A caller treats an unclassified change
 *   as reaching every reader of the file.
 *
 * ## Err strict
 *
 * An unclassified change keeps a test selected; a wrongly permissive class
 * drops a test that would have caught a bug. So everything this module is
 * unsure of is unclassified, and one unclassified hunk makes the whole file
 * unclassified: every hunk of it is then reported unclassified. The file is
 * classified only when it is a modified `.ts` file (not a declaration file,
 * not a test file), the TypeScript API is available, and both texts parse with
 * none of the load-time errors the compiler's own checks can see (an `await`
 * outside an async function, a duplicate `let`, a name used before its
 * declaration at load). Hunks are compared by structure only, never by
 * matching names in the changed text.
 */
import { type LineRange, lineDiffRanges } from './changed-names.js'
import type { TypeScriptApi } from './compiler-graph.js'

type Node = import('typescript').Node
type SourceFile = import('typescript').SourceFile
type FunctionLike = import('typescript').FunctionLikeDeclaration
type Statement = import('typescript').Statement

/** How the file changed between the two texts; only `modified` can be classified. */
export type ChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed'

export type HunkClassInput = {
  /** The changed file's path; its extension and name decide whether it can be classified. */
  path: string
  status: ChangeStatus
  /** The file's text before the change, or `null` when there was none. */
  before: string | null
  /** The file's text after the change, or `null` when there is none. */
  after: string | null
  /** The TypeScript compiler API (`loadTypeScript`), or `null`: without it every hunk is unclassified. */
  ts: TypeScriptApi | null
}

/**
 * One hunk: its 1-based, inclusive line range on each side, in the shape
 * `lineDiffRanges` returns. A side with no lines is an empty range
 * (`end < start`) whose `start` is the line the gap follows.
 */
export type Hunk = { before: LineRange; after: LineRange }

/** A function's lines on one side of the diff. */
export type FunctionLines = {
  /** The whole function: its first line (a decorator, modifier or signature) to its last. */
  span: LineRange
  /** Its block body, from the line of the opening brace to the line of the closing one. */
  body: LineRange
  /** The span of each function written directly inside it; its own lines are `body` less these. */
  nested: LineRange[]
}

export type BodyOnlyHunk = {
  kind: 'body-only'
  hunk: Hunk
  function: {
    /** Dot-joined names of the enclosing classes, namespaces and functions, then the function's own; `<anonymous>` for an unnamed one. */
    name: string
    before: FunctionLines
    after: FunctionLines
  }
}

export type InertAdditionHunk = {
  kind: 'inert-addition'
  hunk: Hunk
  /** Every name the added declarations and type-only imports bind. */
  names: string[]
  /** The module specifier of each added type-only import, in order. */
  importSpecifiers: string[]
}

/** Why a hunk, or the whole file, is unclassified. */
export type UnclassifiedReason =
  | 'not-modified'
  | 'not-ts'
  | 'test-file'
  | 'typescript-unavailable'
  | 'unparseable'
  | 'load-error'
  | 'signature-or-enclosing-changed'
  | 'outside-function-bodies'
  | 'not-inert'
  | 'exported'
  | 'runtime-import'
  | 'name-collision'
  | 'structure-changed'
  | 'other-hunk-unclassified'

export type UnclassifiedHunk = { kind: 'unclassified'; hunk: Hunk; reason: UnclassifiedReason }

export type HunkClass = BodyOnlyHunk | InertAdditionHunk | UnclassifiedHunk

export type FileHunkClasses = {
  path: string
  /** `true` only when every hunk is body-only or an inert addition. */
  classified: boolean
  /** Why the file is unclassified — its own reason, or the first unclassified hunk's — or `null`. */
  reason: UnclassifiedReason | null
  /** One entry per hunk of the line diff between the two texts, in order. */
  hunks: HunkClass[]
}

/**
 * Diagnostic codes from the compiler's checks that are errors when the module
 * loads: redeclarations, and names used before their declaration. Every code
 * below 2000 (a grammar error) counts as well.
 */
const LOAD_ERROR_CODES = new Set([2300, 2392, 2393, 2440, 2448, 2449, 2450, 2451])

/** Classifies every hunk of one file's change. Pure: reads nothing but its input. */
export function classifyHunks(input: HunkClassInput): FileHunkClasses {
  const { beforeRanges, afterRanges } = lineDiffRanges(input.before ?? '', input.after ?? '')
  const hunks: Hunk[] = beforeRanges.map((before, k) => ({ before, after: afterRanges[k] as LineRange }))
  const whole = (reason: UnclassifiedReason): FileHunkClasses => ({
    path: input.path,
    classified: false,
    reason,
    hunks: hunks.map((hunk) => ({ kind: 'unclassified', hunk, reason }))
  })
  if (input.status !== 'modified' || input.before === null || input.after === null) return whole('not-modified')
  if (!input.path.endsWith('.ts') || input.path.endsWith('.d.ts')) return whole('not-ts')
  if (/\.(?:test|spec)\.ts$/.test(input.path)) return whole('test-file')
  const ts = input.ts
  if (ts === null) return whole('typescript-unavailable')
  const before = parse(ts, input.path, input.before)
  const after = parse(ts, input.path, input.after)
  if (before.problem !== null) return whole(before.problem)
  if (after.problem !== null) return whole(after.problem)

  const mapLine = afterToBeforeLine(hunks)
  const old = sideOf(ts, before.file)
  const now = sideOf(ts, after.file)
  const classes = hunks.map(
    (hunk): HunkClass => bodyOnly(ts, hunk, old, now, mapLine) ?? inertAddition(ts, hunk, old, now)
  )
  const firstUnclassified = classes.find((c): c is UnclassifiedHunk => c.kind === 'unclassified')
  const reason = firstUnclassified?.reason ?? topLevelCorrespondence(classes, before.file, after.file, mapLine)
  if (reason === null) return { path: input.path, classified: true, reason: null, hunks: classes }
  return {
    path: input.path,
    classified: false,
    reason,
    hunks: classes.map((c) =>
      c.kind === 'unclassified'
        ? c
        : { kind: 'unclassified', hunk: c.hunk, reason: firstUnclassified ? 'other-hunk-unclassified' : reason }
    )
  }
}

// ── Parsing and load-time errors ────────────────────────────────────────────

type Parsed = { file: SourceFile; problem: 'unparseable' | 'load-error' | null }

/**
 * Parses one text and runs the compiler's checks on it alone — no library, no
 * imports resolved — keeping only the errors that stop a module from loading:
 * any syntax error, any grammar error, and the redeclaration and
 * use-before-declaration codes. Unresolved names and type errors, which every
 * file has without its library and imports, are not load errors and are
 * ignored.
 */
function parse(ts: TypeScriptApi, path: string, text: string): Parsed {
  const fileName = `/${path.replace(/^\/+/, '')}`
  const file = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
  const host: import('typescript').CompilerHost = {
    getSourceFile: (name) => (name === fileName ? file : undefined),
    getDefaultLibFileName: () => '/lib.d.ts',
    writeFile: () => {},
    getCurrentDirectory: () => '/',
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (name) => name === fileName,
    readFile: (name) => (name === fileName ? text : undefined)
  }
  const program = ts.createProgram({
    rootNames: [fileName],
    host,
    options: {
      noLib: true,
      noResolve: true,
      types: [],
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleDetection: ts.ModuleDetectionKind.Force,
      strict: true
    }
  })
  if (program.getSyntacticDiagnostics(file).length > 0) return { file, problem: 'unparseable' }
  const loadErrors = program
    .getSemanticDiagnostics(file)
    .filter((diagnostic) => diagnostic.code < 2000 || LOAD_ERROR_CODES.has(diagnostic.code))
  return { file, problem: loadErrors.length > 0 ? 'load-error' : null }
}

/** A function-like node with a body (a block or an expression), as opposed to a signature or a function type. */
function hasBody(ts: TypeScriptApi, node: Node): node is FunctionLike {
  return ts.isFunctionLike(node) && (node as { body?: Node }).body !== undefined
}

const lineOf = (file: SourceFile, pos: number): number => file.getLineAndCharacterOfPosition(pos).line + 1

const isEmpty = (range: LineRange): boolean => range.end < range.start

/** One side of the change, parsed once: its functions and the lines its tokens and comments occupy. */
type Side = { file: SourceFile; functions: FunctionAt[]; occupied: Set<number>; written?: Set<string> }

function sideOf(ts: TypeScriptApi, file: SourceFile): Side {
  return { file, functions: functionsOf(ts, file), occupied: occupiedLines(ts, file) }
}

/**
 * Every line some token or comment of the file covers, a multi-line string,
 * template or comment on each of its lines. A blank line outside this set is
 * whitespace between tokens, where adding or removing it changes nothing.
 */
function occupiedLines(ts: TypeScriptApi, file: SourceFile): Set<number> {
  const lines = new Set<number>()
  const mark = (from: number, to: number): void => {
    for (let line = lineOf(file, from); line <= lineOf(file, to); line++) lines.add(line)
  }
  const visit = (node: Node): void => {
    if (ts.isJSDoc(node)) return
    const children = node.getChildren(file)
    if (children.length === 0) {
      for (const comment of ts.getLeadingCommentRanges(file.text, node.getFullStart()) ?? [])
        mark(comment.pos, comment.end)
      if (node.getEnd() > node.getStart(file)) mark(node.getStart(file), node.getEnd())
      return
    }
    for (const child of children) visit(child)
  }
  visit(file)
  return lines
}

/**
 * Maps a line of the new text that lies outside every hunk to the line it
 * matches in the old text, or `null` for a line inside a hunk.
 */
function afterToBeforeLine(hunks: readonly Hunk[]): (line: number) => number | null {
  return (line) => {
    let shift = 0
    for (const { before, after } of hunks) {
      if (!isEmpty(after) && line >= after.start && line <= after.end) return null
      const afterLast = isEmpty(after) ? after.start : after.end
      if (afterLast >= line) break
      shift +=
        (isEmpty(after) ? 0 : after.end - after.start + 1) - (isEmpty(before) ? 0 : before.end - before.start + 1)
    }
    return line - shift
  }
}

// ── Body-only ───────────────────────────────────────────────────────────────

type FunctionAt = {
  node: FunctionLike
  depth: number
  span: LineRange
  body: LineRange
}

/** Every function-like node with a block body, and how deeply each is nested in other function-likes. */
function functionsOf(ts: TypeScriptApi, file: SourceFile): FunctionAt[] {
  const out: FunctionAt[] = []
  const visit = (node: Node, depth: number): void => {
    let inner = depth
    if (hasBody(ts, node)) {
      inner = depth + 1
      const body = node.body as Node
      if (ts.isBlock(body)) {
        out.push({
          node,
          depth: inner,
          span: { start: lineOf(file, node.getStart(file)), end: lineOf(file, node.getEnd()) },
          body: { start: lineOf(file, body.getStart(file)), end: lineOf(file, body.getEnd()) }
        })
      }
    }
    ts.forEachChild(node, (child) => visit(child, inner))
  }
  visit(file, 0)
  return out
}

/**
 * Whether a range lies strictly inside a body: below its opening brace's line
 * and above its closing brace's line. An empty range is the gap after its
 * `start` line, inside when that gap falls between the two brace lines.
 */
function strictlyInside(range: LineRange, body: LineRange): boolean {
  if (isEmpty(range)) return range.start >= body.start && range.start + 1 <= body.end
  return range.start > body.start && range.end < body.end
}

/** The deepest function whose body strictly holds the range, or `null`. */
function innermost(functions: readonly FunctionAt[], range: LineRange): FunctionAt | null {
  let best: FunctionAt | null = null
  for (const f of functions) if (strictlyInside(range, f.body) && (best === null || f.depth > best.depth)) best = f
  return best
}

/** The function's header: everything from its first decorator or modifier to its body's opening brace. */
function signatureOf(file: SourceFile, f: FunctionLike): string {
  return file.text.slice(f.getStart(file), (f.body as Node).getStart(file))
}

/**
 * Every enclosing node from the function outwards, each as its kind and its
 * own header text: a function's signature, a class's text up to its members, a
 * namespace's up to its body, a variable or property up to its initializer.
 * Siblings are never included, so a change in another function's body does
 * not alter this chain.
 */
function enclosingChain(ts: TypeScriptApi, file: SourceFile, f: FunctionLike): string[] {
  const chain: string[] = []
  for (let node: Node | undefined = f.parent; node !== undefined && !ts.isSourceFile(node); node = node.parent) {
    let header = ''
    if (hasBody(ts, node)) header = file.text.slice(node.getStart(file), (node.body as Node).getStart(file))
    else if (ts.isClassLike(node)) header = file.text.slice(node.getStart(file), node.members.pos)
    else if (ts.isModuleDeclaration(node) && node.body !== undefined)
      header = file.text.slice(node.getStart(file), node.body.getStart(file))
    else if (
      (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) &&
      node.initializer !== undefined
    )
      header = file.text.slice(node.getStart(file), node.initializer.getStart(file))
    else if (ts.isVariableDeclarationList(node) && node.declarations.length > 0)
      header = file.text.slice(node.getStart(file), (node.declarations[0] as Node).getStart(file))
    chain.push(`${ts.SyntaxKind[node.kind]}:${header}`)
  }
  return chain
}

/** The function's own name, or the name it is assigned to, or `<anonymous>`. */
function ownName(ts: TypeScriptApi, file: SourceFile, node: Node): string | null {
  const named = (node as { name?: Node }).name
  if (named !== undefined) return named.getText(file)
  if (ts.isConstructorDeclaration(node)) return 'constructor'
  const parent = node.parent
  if (
    parent !== undefined &&
    (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) &&
    parent.initializer === node
  )
    return parent.name.getText(file)
  return null
}

function qualifiedName(ts: TypeScriptApi, file: SourceFile, f: FunctionLike): string {
  const parts = [ownName(ts, file, f) ?? '<anonymous>']
  for (let node: Node | undefined = f.parent; node !== undefined && !ts.isSourceFile(node); node = node.parent) {
    if (hasBody(ts, node)) parts.unshift(ownName(ts, file, node) ?? '<anonymous>')
    else if (ts.isClassLike(node) || ts.isModuleDeclaration(node))
      parts.unshift(ownName(ts, file, node) ?? '<anonymous>')
  }
  return parts.join('.')
}

function linesOf(ts: TypeScriptApi, file: SourceFile, f: FunctionAt): FunctionLines {
  const nested: LineRange[] = []
  const visit = (node: Node): void => {
    if (hasBody(ts, node)) {
      nested.push({ start: lineOf(file, node.getStart(file)), end: lineOf(file, node.getEnd()) })
      return
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(f.node.body as Node, visit)
  return { span: f.span, body: f.body, nested }
}

/**
 * The hunk as body-only, an unclassified hunk when it lies inside a body whose
 * signature or enclosing chain differs, or `null` when it lies inside no body
 * on one side or the other.
 */
function bodyOnly(
  ts: TypeScriptApi,
  hunk: Hunk,
  old: Side,
  now: Side,
  mapLine: (line: number) => number | null
): HunkClass | null {
  const a = innermost(now.functions, hunk.after)
  const b = innermost(old.functions, hunk.before)
  if (a === null || b === null) return null
  const same =
    mapLine(a.span.start) === b.span.start &&
    mapLine(a.span.end) === b.span.end &&
    mapLine(a.body.start) === b.body.start &&
    mapLine(a.body.end) === b.body.end &&
    a.node.kind === b.node.kind &&
    signatureOf(now.file, a.node) === signatureOf(old.file, b.node) &&
    enclosingChain(ts, now.file, a.node).join('\n') === enclosingChain(ts, old.file, b.node).join('\n')
  if (!same) return { kind: 'unclassified', hunk, reason: 'signature-or-enclosing-changed' }
  return {
    kind: 'body-only',
    hunk,
    function: {
      name: qualifiedName(ts, now.file, a.node),
      before: linesOf(ts, old.file, b),
      after: linesOf(ts, now.file, a)
    }
  }
}

// ── Inert additions ─────────────────────────────────────────────────────────

/** An added top-level statement's verdict: the names it binds and its import specifier, or why it is not inert. */
type Inertness = { names: string[]; importSpecifier: string | null } | 'exported' | 'runtime-import' | 'not-inert'

function inertness(ts: TypeScriptApi, statement: Statement): Inertness {
  const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : []
  if (modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword || m.kind === ts.SyntaxKind.DefaultKeyword))
    return 'exported'
  if (ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) return 'exported'
  const onlyModifiers = (...allowed: import('typescript').SyntaxKind[]): boolean =>
    modifiers.every((m) => allowed.includes(m.kind))

  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause
    if (clause === undefined || !clause.isTypeOnly || !ts.isStringLiteral(statement.moduleSpecifier))
      return 'runtime-import'
    const names: string[] = []
    if (clause.name) names.push(clause.name.text)
    const bindings = clause.namedBindings
    if (bindings && ts.isNamespaceImport(bindings)) names.push(bindings.name.text)
    if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) names.push(element.name.text)
    return { names, importSpecifier: statement.moduleSpecifier.text }
  }
  if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
    if (!onlyModifiers()) return 'not-inert'
    return { names: [statement.name.text], importSpecifier: null }
  }
  if (ts.isFunctionDeclaration(statement)) {
    if (statement.name === undefined || !onlyModifiers(ts.SyntaxKind.AsyncKeyword)) return 'not-inert'
    return { names: [statement.name.text], importSpecifier: null }
  }
  if (ts.isClassDeclaration(statement)) {
    if (statement.name === undefined || !onlyModifiers(ts.SyntaxKind.AbstractKeyword)) return 'not-inert'
    if (statement.heritageClauses !== undefined && statement.heritageClauses.length > 0) return 'not-inert'
    let plain = true
    const visit = (node: Node): void => {
      if (ts.isDecorator(node)) plain = false
      ts.forEachChild(node, visit)
    }
    visit(statement)
    for (const member of statement.members) {
      if (ts.isClassStaticBlockDeclaration(member)) plain = false
      const memberModifiers = ts.canHaveModifiers(member) ? (ts.getModifiers(member) ?? []) : []
      if (memberModifiers.some((m) => m.kind === ts.SyntaxKind.StaticKeyword)) plain = false
      if (member.name !== undefined && ts.isComputedPropertyName(member.name)) plain = false
    }
    return plain ? { names: [statement.name.text], importSpecifier: null } : 'not-inert'
  }
  if (ts.isVariableStatement(statement)) {
    const list = statement.declarationList
    if (!onlyModifiers() || (list.flags & ts.NodeFlags.BlockScoped) !== ts.NodeFlags.Const) return 'not-inert'
    const names: string[] = []
    for (const declaration of list.declarations) {
      if (!ts.isIdentifier(declaration.name) || !inertInitializer(ts, declaration.initializer)) return 'not-inert'
      names.push(declaration.name.text)
    }
    return { names, importSpecifier: null }
  }
  return 'not-inert'
}

/** A function or arrow expression, or a primitive literal: a plain string, a number, a boolean or `null`. */
function inertInitializer(ts: TypeScriptApi, node: Node | undefined): boolean {
  if (node === undefined) return false
  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return true
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return true
  if (ts.isPrefixUnaryExpression(node))
    return node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)
  return (
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  )
}

/**
 * Every identifier the old text writes, as a binding or a reference, except
 * where it can only be a property or member name. An added name in this set
 * either redeclares something or shadows a name unchanged code reads.
 */
function writtenNames(ts: TypeScriptApi, file: SourceFile): Set<string> {
  const names = new Set<string>()
  const visit = (node: Node): void => {
    if (ts.isIdentifier(node)) {
      const parent = node.parent
      const memberName =
        parent !== undefined &&
        (((ts.isPropertyAccessExpression(parent) ||
          ts.isPropertyAssignment(parent) ||
          ts.isPropertySignature(parent) ||
          ts.isPropertyDeclaration(parent) ||
          ts.isMethodDeclaration(parent) ||
          ts.isMethodSignature(parent) ||
          ts.isGetAccessorDeclaration(parent) ||
          ts.isSetAccessorDeclaration(parent) ||
          ts.isEnumMember(parent)) &&
          parent.name === node) ||
          (ts.isQualifiedName(parent) && parent.right === node))
      if (!memberName) names.add(node.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return names
}

const isBlank = (line: string): boolean => line.trim().length === 0

/**
 * The hunk as an inert addition, or unclassified: its old side holds only
 * blank lines, and its new side holds only blank lines and whole top-level
 * statements (with their leading comments), each one inert under a name the
 * old text never wrote.
 */
function inertAddition(ts: TypeScriptApi, hunk: Hunk, old: Side, now: Side): HunkClass {
  const outside: UnclassifiedHunk = { kind: 'unclassified', hunk, reason: 'outside-function-bodies' }
  // A blank line counts only as whitespace between tokens: one inside a
  // multi-line string, template or comment is part of that token.
  const oldLines = old.file.text.split('\n')
  for (let line = hunk.before.start; line <= hunk.before.end; line++)
    if (!isBlank(oldLines[line - 1] ?? '') || old.occupied.has(line)) return outside
  // Only blank lines removed: nothing was added, and nothing changed.
  if (isEmpty(hunk.after)) return { kind: 'inert-addition', hunk, names: [], importSpecifiers: [] }

  const after = now.file
  const newLines = after.text.split('\n')
  const covered = new Set<number>()
  const added: Statement[] = []
  for (const statement of after.statements) {
    const start = lineOf(after, statement.getStart(after))
    const end = lineOf(after, statement.getEnd())
    if (end < hunk.after.start || start > hunk.after.end) continue
    if (start < hunk.after.start || end > hunk.after.end) return outside
    added.push(statement)
    for (let line = start; line <= end; line++) covered.add(line)
    for (const comment of ts.getLeadingCommentRanges(after.text, statement.getFullStart()) ?? []) {
      const first = lineOf(after, comment.pos)
      const last = lineOf(after, comment.end)
      if (first < hunk.after.start) continue
      for (let line = first; line <= last; line++) covered.add(line)
    }
  }
  for (let line = hunk.after.start; line <= hunk.after.end; line++)
    if (!covered.has(line) && (!isBlank(newLines[line - 1] ?? '') || now.occupied.has(line))) return outside

  old.written ??= writtenNames(ts, old.file)
  const written = old.written
  const names: string[] = []
  const importSpecifiers: string[] = []
  for (const statement of added) {
    const verdict = inertness(ts, statement)
    if (verdict === 'exported' || verdict === 'runtime-import' || verdict === 'not-inert')
      return { kind: 'unclassified', hunk, reason: verdict }
    if (verdict.names.some((name) => written.has(name))) return { kind: 'unclassified', hunk, reason: 'name-collision' }
    names.push(...verdict.names)
    if (verdict.importSpecifier !== null) importSpecifiers.push(verdict.importSpecifier)
  }
  return { kind: 'inert-addition', hunk, names, importSpecifiers }
}

// ── Whole-file structure ────────────────────────────────────────────────────

/**
 * With every hunk classified, the old top-level statements must be the new
 * ones less the added ones, each of the same kind and starting and ending on
 * matching lines — so no hunk changed how the unchanged text around it parses.
 * Returns `null` when they correspond, otherwise `'structure-changed'`.
 */
function topLevelCorrespondence(
  classes: readonly HunkClass[],
  before: SourceFile,
  after: SourceFile,
  mapLine: (line: number) => number | null
): UnclassifiedReason | null {
  const addedRanges = classes.filter((c) => c.kind === 'inert-addition').map((c) => c.hunk.after)
  const isAdded = (statement: Statement): boolean => {
    const line = lineOf(after, statement.getStart(after))
    return addedRanges.some((range) => line >= range.start && line <= range.end)
  }
  const kept = after.statements.filter((statement) => !isAdded(statement))
  if (kept.length !== before.statements.length) return 'structure-changed'
  for (let k = 0; k < kept.length; k++) {
    const a = kept[k] as Statement
    const b = before.statements[k] as Statement
    if (
      a.kind !== b.kind ||
      mapLine(lineOf(after, a.getStart(after))) !== lineOf(before, b.getStart(before)) ||
      mapLine(lineOf(after, a.getEnd())) !== lineOf(before, b.getEnd())
    )
      return 'structure-changed'
  }
  return null
}
