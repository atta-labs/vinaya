import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, relative, sep } from 'node:path'
import ts from 'typescript'
import {
  type Baseline,
  git,
  gitShow,
  renames,
  REPOSITORY_ROOT,
  serializeBaseline,
  total
} from './architecture-ratchet.js'

export const LONG_IMPORT_BASELINE = 'harness/kernel/tests/long-import-baseline.json'
const COMMAND = 'bun harness/kernel/tests/long-import-ratchet.ts'
export const WRITE_COMMAND = `${COMMAND} --write`

const REPLACEMENT =
  'Use @harness/kernel/<path> for a kernel target or @harness/workflow/<path> for a workflow target. Any other target needs a named exception.'

function moduleSpecifier(node: ts.Node): ts.Node | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
    return node.moduleReference.expression
  }
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) return node.argument.literal
  if (ts.isModuleDeclaration(node)) return node.name
  if (ts.isCallExpression(node)) {
    const callee = node.expression
    if (
      callee.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(callee) && callee.text === 'require') ||
      (ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'mock' &&
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

/** Tracked TypeScript files in path order, with their long imports in source order. */
function* scan(root: string, folders: string[] = []): Generator<[string, LongSpecifier[]]> {
  const paths = git(root, ['--literal-pathspecs', 'ls-files', '-z', '--deduplicate', '--', ...folders])
    .split('\0')
    .filter((path) => /\.tsx?$/.test(path))
    .sort()
  for (const file of paths) {
    const path = join(root, file)
    if (!existsSync(path)) continue
    const specifiers = longSpecifiers(file, readFileSync(path, 'utf8'))
    if (specifiers.length > 0) yield [file, specifiers]
  }
}

/** Zero counts are implicit in the baseline. */
function countTree(root: string): Baseline {
  return Object.fromEntries(Array.from(scan(root), ([file, specifiers]) => [file, specifiers.length]))
}

export function writeLongImportBaseline(root: string): Baseline {
  const counts = countTree(root)
  const destination = join(root, LONG_IMPORT_BASELINE)
  const scratch = mkdtempSync(join(dirname(destination), '.long-import-baseline-'))
  try {
    const temporary = join(scratch, 'baseline.json')
    writeFileSync(temporary, serializeBaseline(counts))
    // Rename replaces the destination directory entry itself, even if it is a symlink.
    renameSync(temporary, destination)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  return counts
}

function parseBaseline(text: string): Baseline {
  const baseline = JSON.parse(text) as Baseline
  if (
    !baseline ||
    typeof baseline !== 'object' ||
    Array.isArray(baseline) ||
    Object.values(baseline).some((count) => !Number.isSafeInteger(count) || count <= 0)
  ) {
    throw new Error(
      `${LONG_IMPORT_BASELINE} must map file paths to positive integer counts. Regenerate it with \`${WRITE_COMMAND}\`.`
    )
  }
  return baseline
}

function readBaseline(root: string): Baseline {
  return parseBaseline(readFileSync(join(root, LONG_IMPORT_BASELINE), 'utf8'))
}

function growth(file: string, count: number, entry: number, against: string): string {
  return `${file}: ${count} long imports exceed ${against} (${entry}). ${REPLACEMENT}`
}

function compareWithBaseline(counts: Baseline, baseline: Baseline): string[] {
  const failures: string[] = []
  for (const file of [...new Set([...Object.keys(counts), ...Object.keys(baseline)])].sort()) {
    const count = counts[file] ?? 0
    const entry = baseline[file] ?? 0
    if (count > entry) failures.push(growth(file, count, entry, 'its baseline entry'))
    if (count < entry) {
      failures.push(
        `${file}: ${count} long imports fell below its baseline entry (${entry}). Lower it with \`${WRITE_COMMAND}\`.`
      )
    }
  }
  return failures
}

export function checkLongImportBaseline(root: string): string[] {
  return compareWithBaseline(countTree(root), readBaseline(root))
}

export function compareLongImportsToBase(root: string, base: string): { notice: string | null; failures: string[] } {
  const text = gitShow(root, base, LONG_IMPORT_BASELINE)
  if (text === null) return { notice: `long import ratchet: the base ${base} has no baseline yet.`, failures: [] }

  const baseBaseline = parseBaseline(text)
  const counts = countTree(root)
  const failures = compareWithBaseline(counts, readBaseline(root))
  const { from } = renames(root, base, { sameNameFallback: false })
  for (const [file, count] of Object.entries(counts)) {
    const baseFile = from.get(file) ?? file
    const entry = baseBaseline[baseFile] ?? 0
    if (count > entry) {
      const against = baseFile === file ? 'its base entry' : `the base entry for ${baseFile}`
      failures.push(growth(file, count, entry, against))
    }
  }
  const notice =
    failures.length === 0
      ? `long import ratchet: head total ${total(counts)}, base total ${total(baseBaseline)} — no growth.`
      : null
  return { notice, failures }
}

export function listLongImports(root: string, folders: string[] = []): string[] {
  const lines: string[] = []
  const options = { moduleResolution: ts.ModuleResolutionKind.Bundler }
  const cache = ts.createModuleResolutionCache(root, (path) => path, options)
  const field = (value: string): string => (/[\t\r\n]/.test(value) ? JSON.stringify(value) : value)
  for (const [file, specifiers] of scan(root, folders)) {
    for (const { text, spelling } of specifiers) {
      const target = ts.resolveModuleName(text, join(root, file), options, ts.sys, cache).resolvedModule
      const path = target
        ? relative(root, target.resolvedFileName).split(sep).join('/')
        : posix.join(posix.dirname(file), text)
      lines.push([file, spelling, path].map(field).join('\t'))
    }
  }
  return lines
}

function main(argv: string[]): number {
  const [command, ...folders] = argv
  if (command === '--write' && folders.length === 0) {
    const counts = writeLongImportBaseline(REPOSITORY_ROOT)
    process.stdout.write(
      `long import ratchet: wrote ${total(counts)} long imports across ${Object.keys(counts).length} files.\n`
    )
    return 0
  }
  if (command === '--list') {
    for (const line of listLongImports(REPOSITORY_ROOT, folders)) process.stdout.write(`${line}\n`)
    return 0
  }
  process.stderr.write(`usage: ${WRITE_COMMAND}\n       ${COMMAND} --list [folder…]\n`)
  return 2
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
