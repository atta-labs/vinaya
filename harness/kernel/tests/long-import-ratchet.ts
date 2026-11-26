import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { join, posix, relative, sep } from 'node:path'
import ts from 'typescript'
import { git, gitShow, renames, REPOSITORY_ROOT } from './architecture-ratchet.js'

export const LONG_IMPORT_EXCEPTIONS = 'harness/kernel/tests/long-import-exceptions.json'
/** The per-file count file the exceptions list replaced; it must not come back. */
export const LONG_IMPORT_BASELINE = 'harness/kernel/tests/long-import-baseline.json'
const COMMAND = 'bun harness/kernel/tests/long-import-ratchet.ts'

const STUDIO_FOLDER = 'apps/vinaya-studio/'
const ALIASED_FOLDERS = ['harness/kernel/', 'harness/processes/vinaya-strict/']

/** One relative specifier that climbs three or more folders and stays relative, with the reason it does. */
export type LongImportException = { file: string; specifier: string; reason: string }

const REPLACEMENT =
  'Use @harness/kernel/<path> for a kernel target or @harness/workflow/<path> for a workflow target. Any other target needs a named exception.'

function unwrapCallTarget(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression)) {
    expression = expression.expression
  }
  return expression
}

function moduleSpecifier(node: ts.Node): ts.Node | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
    return node.moduleReference.expression
  }
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) return node.argument.literal
  if (ts.isModuleDeclaration(node)) return node.name
  if (ts.isCallExpression(node)) {
    const callee = unwrapCallTarget(node.expression)
    const receiver = ts.isPropertyAccessExpression(callee) ? unwrapCallTarget(callee.expression) : undefined
    if (
      callee.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(callee) && callee.text === 'require') ||
      (ts.isPropertyAccessExpression(callee) &&
        receiver &&
        ts.isIdentifier(receiver) &&
        receiver.text === 'mock' &&
        callee.name.text === 'module')
    ) {
      return node.arguments[0]
    }
  }
}

type LongSpecifier = { text: string; spelling: string }

function longSpecifiers(file: string, source: string): LongSpecifier[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest)
  const specifiers: LongSpecifier[] = []
  const visit = (node: ts.Node): void => {
    const specifier = moduleSpecifier(node)
    if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith('../../../')) {
      specifiers.push({ text: specifier.text, spelling: specifier.getText(parsed).slice(1, -1) })
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return specifiers
}

function readTrackedSource(path: string): string | null {
  try {
    if (!lstatSync(path).isFile() || realpathSync(path) !== path) return null
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      return fstatSync(fd).isFile() ? readFileSync(fd, 'utf8') : null
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') return null
    throw error
  }
}

/** Tracked TypeScript files in path order, with their long imports in source order. */
function* scan(root: string, folders: string[] = []): Generator<[string, LongSpecifier[]]> {
  const paths = git(root, ['--literal-pathspecs', 'ls-files', '-z', '--deduplicate', '--', ...folders])
    .split('\0')
    .filter((path) => /\.tsx?$/.test(path))
    .sort()
  const canonicalRoot = realpathSync(root)
  for (const file of paths) {
    const source = readTrackedSource(join(canonicalRoot, file))
    if (source === null) continue
    const specifiers = longSpecifiers(file, source)
    if (specifiers.length > 0) yield [file, specifiers]
  }
}

type Occurrence = { file: string; specifier: string }

/** Every long specifier in the tracked tree, in path and source order. */
function treeOccurrences(root: string): Occurrence[] {
  const occurrences: Occurrence[] = []
  for (const [file, specifiers] of scan(root)) {
    for (const { text } of specifiers) occurrences.push({ file, specifier: text })
  }
  return occurrences
}

function parseExceptions(text: string): LongImportException[] {
  const parsed: unknown = JSON.parse(text)
  const valid =
    Array.isArray(parsed) &&
    parsed.every(
      (entry) =>
        entry &&
        typeof entry === 'object' &&
        ['file', 'specifier', 'reason'].every((key) => typeof entry[key] === 'string' && entry[key] !== '')
    )
  if (!valid) {
    throw new Error(`${LONG_IMPORT_EXCEPTIONS} must be a list of entries with a file, a specifier and a reason.`)
  }
  return parsed as LongImportException[]
}

function readExceptions(root: string): LongImportException[] {
  return parseExceptions(readFileSync(join(root, LONG_IMPORT_EXCEPTIONS), 'utf8'))
}

const LOG_CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u

function displayField(value: string): string {
  if (!LOG_CONTROL.test(value) && !value.startsWith('::') && !value.startsWith('##[')) return value
  return JSON.stringify(value).replace(
    /[\p{Cc}\p{Zl}\p{Zp}]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
}

const keyOf = (file: string, specifier: string): string => JSON.stringify([file, specifier])

function tally(entries: Occurrence[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const { file, specifier } of entries) {
    const key = keyOf(file, specifier)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

function describeKey(key: string): string {
  const [file, specifier] = JSON.parse(key) as [string, string]
  return `${displayField(file)} imports ${displayField(specifier)}`
}

/** Whether a long specifier names a file under the kernel folder or the workflow process folder. */
function namesAliasedFile(file: string, specifier: string): boolean {
  const target = posix.join(posix.dirname(file), specifier)
  return ALIASED_FOLDERS.some((folder) => target.startsWith(folder))
}

function compareWithList(tree: Occurrence[], list: LongImportException[], against: string): string[] {
  const failures: string[] = []
  const found = tally(tree)
  const listed = tally(list)
  for (const key of [...new Set([...found.keys(), ...listed.keys()])].sort()) {
    const count = found.get(key) ?? 0
    const entries = listed.get(key) ?? 0
    if (count > entries) {
      failures.push(`${describeKey(key)} ${count} times, but ${against} names it ${entries} times. ${REPLACEMENT}`)
    }
    if (count < entries) {
      failures.push(
        `${describeKey(key)} ${count} times, but ${against} names it ${entries} times. Remove the stale entry from ${LONG_IMPORT_EXCEPTIONS}.`
      )
    }
  }
  return failures
}

export function checkLongImportExceptions(root: string): string[] {
  const failures: string[] = []
  if (existsSync(join(root, LONG_IMPORT_BASELINE))) {
    failures.push(`${LONG_IMPORT_BASELINE} must not exist: ${LONG_IMPORT_EXCEPTIONS} is the single list.`)
  }
  const list = readExceptions(root)
  failures.push(...compareWithList(treeOccurrences(root), list, 'the exceptions list'))
  for (const { file, specifier } of list) {
    if (!file.startsWith(STUDIO_FOLDER) && namesAliasedFile(file, specifier)) {
      failures.push(
        `${describeKey(keyOf(file, specifier))} names a kernel or workflow file and cannot be an exception. ${REPLACEMENT}`
      )
    }
  }
  return failures
}

export function compareLongImportsToBase(root: string, base: string): { notice: string | null; failures: string[] } {
  const text = gitShow(root, base, LONG_IMPORT_EXCEPTIONS)
  if (text === null)
    return { notice: `long import ratchet: the base ${base} has no exceptions list yet.`, failures: [] }

  const baseList = parseExceptions(text)
  const headList = readExceptions(root)
  const tree = treeOccurrences(root)
  const failures = compareWithList(tree, headList, 'the head exceptions list')
  const { from } = renames(root, base, { sameNameFallback: false })
  const allowed = tally(baseList)
  for (const [key, count] of tally(tree)) {
    const [file, specifier] = JSON.parse(key) as [string, string]
    const baseKey = keyOf(from.get(file) ?? file, specifier)
    if (count > (allowed.get(baseKey) ?? 0)) {
      failures.push(
        `${describeKey(key)} ${count} times, but the base exceptions list does not allow it. ${REPLACEMENT}`
      )
    }
  }
  if (headList.length > baseList.length) {
    failures.push(`the exceptions list grew from ${baseList.length} to ${headList.length} entries. ${REPLACEMENT}`)
  }
  const notice =
    failures.length === 0
      ? `long import ratchet: head ${tree.length} long imports, base list ${baseList.length} entries — no growth.`
      : null
  return { notice, failures }
}

export function listLongImports(root: string, folders: string[] = []): string[] {
  const lines: string[] = []
  const options = { moduleResolution: ts.ModuleResolutionKind.Bundler }
  const cache = ts.createModuleResolutionCache(root, (path) => path, options)
  for (const [file, specifiers] of scan(root, folders)) {
    for (const { text, spelling } of specifiers) {
      const target = ts.resolveModuleName(text, join(root, file), options, ts.sys, cache).resolvedModule
      const path = target
        ? relative(root, target.resolvedFileName).split(sep).join('/')
        : posix.join(posix.dirname(file), text)
      lines.push([file, spelling, path].map(displayField).join('\t'))
    }
  }
  return lines
}

function main(argv: string[]): number {
  const [command, ...folders] = argv
  if (command === '--list') {
    for (const line of listLongImports(REPOSITORY_ROOT, folders)) process.stdout.write(`${line}\n`)
    return 0
  }
  process.stderr.write(`usage: ${COMMAND} --list [folder…]\n`)
  return 2
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
