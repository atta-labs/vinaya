import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, posix, relative, sep } from 'node:path'

// The counted ratchet. The kernel side of the repository — every scope root
// below, outside any process — is meant to name no process and no role. Today
// it still does; this module counts each such name, and each import of a
// process or of a package the target tree retires, file by file, so a
// committed baseline can hold the count to what it is and let it only shrink.
//
// Run as a command:
//   bun harness/tests/architecture-ratchet.ts --write              rewrites the baseline from the current tree
//   bun harness/tests/architecture-ratchet.ts --compare-base <rev>  refuses growth against the base commit's baseline

export const REPOSITORY_ROOT = join(import.meta.dir, '..', '..')
const toRepositoryPath = (absolute: string, root: string): string => relative(root, absolute).split(sep).join('/')

/** Where the baseline lives, repository-relative; a base without it is read from the fallback path. */
export const BASELINE_PATH = toRepositoryPath(join(import.meta.dir, 'architecture-baseline.json'), REPOSITORY_ROOT)
export const BASELINE_FALLBACK_PATH = 'harness/tests/architecture-baseline.json'
/** Old path → new owner path, for each ownership transfer that keeps a forwarding entry at the old path. */
export const OWNERSHIP_MAP_PATH = toRepositoryPath(join(import.meta.dir, 'ownership-map.json'), REPOSITORY_ROOT)

export const WRITE_COMMAND = 'bun harness/tests/architecture-ratchet.ts --write'
export const COMPARE_COMMAND = 'bun harness/tests/architecture-ratchet.ts --compare-base <base>'
const REMEDY = `Rewrite the baseline with \`${WRITE_COMMAND}\`; check it against the base with \`${COMPARE_COMMAND}\`.`

// ── The scope walk ──────────────────────────────────────────────────────────

export const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/
const SKIPPED_FOLDERS = new Set(['node_modules', 'dist', '.turbo'])

export function* sourceFiles(folder: string): Generator<string> {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_FOLDERS.has(entry.name)) yield* sourceFiles(join(folder, entry.name))
    } else if (SOURCE_FILE.test(entry.name)) {
      yield join(folder, entry.name)
    }
  }
}

/** The roots the ratchet scans. A root that no longer exists is skipped. */
export const SCOPE_ROOTS = [
  'harness',
  'packages/aeg-core',
  'packages/aeg-forge-state',
  'packages/aeg-types',
  'packages/sources',
  'apps/cli/src'
]
const EXCLUDED_ROOTS = ['harness/processes']

/** Whether a repository-relative source file is counted: inside a scope root, outside a process, and not a test or fixture. */
export function isScanned(path: string): boolean {
  if (!SOURCE_FILE.test(path) || path.endsWith('.test.ts')) return false
  if (!SCOPE_ROOTS.some((root) => path.startsWith(`${root}/`))) return false
  if (EXCLUDED_ROOTS.some((root) => path.startsWith(`${root}/`))) return false
  const folders = path.split('/').slice(0, -1)
  return !folders.includes('tests') && !folders.includes('fixtures')
}

/** Every scanned file under `root`, repository-relative and sorted. */
export function scannedFiles(root: string): string[] {
  const files: string[] = []
  for (const scope of SCOPE_ROOTS) {
    const folder = join(root, scope)
    if (!existsSync(folder) || !statSync(folder).isDirectory()) continue
    for (const file of sourceFiles(folder)) {
      const path = toRepositoryPath(file, root)
      if (isScanned(path)) files.push(path)
    }
  }
  return files.sort()
}

// ── The token list and the matching rule ───────────────────────────────────

/** Process names: each matches as a plain substring; overlapping matches count once. */
export const PROCESS_TOKENS = ['processes/vinaya', 'process-vinaya', 'vinaya-strict', 'aeg-root']

/** Role names: each matches case-insensitively, as a whole word, optionally plural. */
export const ROLE_TOKENS = [
  'developer',
  'code-reviewer',
  'security-reviewer',
  'reviewer',
  'operator',
  'planner',
  'architect',
  'archivist',
  'tranche-archivist',
  'principal',
  'controller',
  'execution-planner'
]

/** Package scopes the target tree retires: an import of one counts in every scanned file. */
export const RETIRED_PACKAGES = ['@attalabs/aeg-core', '@attalabs/aeg-forge-state']

const caseless = (token: string): string =>
  [...token]
    .map((c) => (/[a-z]/.test(c) ? `[${c}${c.toUpperCase()}]` : c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')))
    .join('')

// The character before is not a letter, digit, `_` or `-`; the token, optionally
// followed by one `s`, is followed by a character that is not a lowercase letter,
// digit, `_` or `-`. So `code-reviewer` is one match, never also `reviewer`;
// `developers`, `developerTurn` and `DeveloperTurnResult` match; `developed` does not.
export const ROLE_PATTERN = new RegExp(
  `(?<![A-Za-z0-9_-])(?:${[...ROLE_TOKENS]
    .sort((a, b) => b.length - a.length)
    .map(caseless)
    .join('|')})s?(?![a-z0-9_-])`,
  'g'
)

// A module specifier inside `from '…'`, `import '…'`, `import('…')` or `require('…')`.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"`])([^'"`\n]+)\1/g

const namesAProcess = (specifier: string): boolean =>
  specifier.startsWith('@attalabs/process-') || specifier.split('/').includes('processes')

export function importsOfAProcess(source: string): string[] {
  const offending: string[] = []
  for (const match of source.matchAll(SPECIFIER)) {
    const specifier = match[2] ?? ''
    if (namesAProcess(specifier)) offending.push(specifier)
  }
  return offending
}

const isCountedImport = (specifier: string): boolean =>
  namesAProcess(specifier) || RETIRED_PACKAGES.some((scope) => specifier === scope || specifier.startsWith(`${scope}/`))

type Span = { start: number; end: number }
type Unit = Span & { kind: 'import' | 'process' | 'role' }
const within = (inner: Span, outer: Span): boolean => inner.start >= outer.start && inner.end <= outer.end
const overlaps = (a: Span, b: Span): boolean => a.start < b.end && b.start < a.end

/**
 * Every counted occurrence in `source`, with its span. An import counts once per
 * specifier, and the names inside a counted specifier are not counted again.
 * Text inside an `excluded` span (a pure forwarding statement) counts nothing.
 */
export function countedUnits(source: string, excluded: Span[] = []): Unit[] {
  const units: Unit[] = []
  const importSpans: Span[] = []
  for (const match of source.matchAll(SPECIFIER)) {
    const specifier = match[2] ?? ''
    if (!isCountedImport(specifier)) continue
    const end = (match.index ?? 0) + match[0].length - 1
    const span = { start: end - specifier.length, end }
    if (excluded.some((e) => within(span, e))) continue
    importSpans.push(span)
    units.push({ ...span, kind: 'import' })
  }
  const skipped = (span: Span): boolean => [...importSpans, ...excluded].some((s) => overlaps(span, s))

  const processMatches: Span[] = []
  for (const token of PROCESS_TOKENS) {
    for (let at = source.indexOf(token); at !== -1; at = source.indexOf(token, at + 1)) {
      processMatches.push({ start: at, end: at + token.length })
    }
  }
  processMatches.sort((a, b) => a.start - b.start || b.end - a.end)
  const groups: Span[] = []
  for (const m of processMatches) {
    const group = groups.at(-1)
    if (group && m.start < group.end) group.end = Math.max(group.end, m.end)
    else groups.push({ ...m })
  }
  for (const g of groups) if (!skipped(g)) units.push({ ...g, kind: 'process' })

  for (const match of source.matchAll(ROLE_PATTERN)) {
    const span = { start: match.index ?? 0, end: (match.index ?? 0) + match[0].length }
    if (!skipped(span)) units.push({ ...span, kind: 'role' })
  }
  return units.sort((a, b) => a.start - b.start)
}

export const countSource = (source: string, excluded: Span[] = []): number => countedUnits(source, excluded).length

// ── Paths: resolving a specifier or path string to a file in a tree ─────────

/** What a tree holds, so both the head working tree and a base commit can be asked the same question. */
export type Tree = { isFile(path: string): boolean; isDirectory(path: string): boolean }

export function workingTree(root: string): Tree {
  return {
    isFile: (path) => existsSync(join(root, path)) && statSync(join(root, path)).isFile(),
    isDirectory: (path) => existsSync(join(root, path)) && statSync(join(root, path)).isDirectory()
  }
}

function committedTree(root: string, rev: string): Tree {
  const files = new Set(git(root, ['ls-tree', '-r', '--name-only', rev]).split('\n').filter(Boolean))
  const folders = new Set<string>()
  for (const file of files) {
    const parts = file.split('/')
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'))
  }
  return { isFile: (path) => files.has(path), isDirectory: (path) => folders.has(path) }
}

const PATH_LIKE = /^[\w@.\-/]+$/

/**
 * The file or folder a path string names, read from `file`'s folder or the
 * nearest ancestor folder where it exists — a path joined to a package root
 * resolves as well as a relative import does. Unresolved strings give `null`.
 */
export function resolvePath(text: string, file: string, tree: Tree, nearestOnly = false): string | null {
  if (!text.includes('/') || !PATH_LIKE.test(text) || text.startsWith('@') || text.startsWith('node:')) return null
  const folders = file.split('/').slice(0, -1)
  const last = nearestOnly ? folders.length : 0
  for (let depth = folders.length; depth >= last; depth--) {
    const joined = posix.normalize(posix.join(folders.slice(0, depth).join('/') || '.', text))
    if (joined.startsWith('..')) continue
    const candidates = [joined, joined.replace(/\.(m|c)?js$/, '.$1ts'), `${joined}.ts`, `${joined}/index.ts`]
    for (const candidate of candidates) {
      if (tree.isFile(candidate) || tree.isDirectory(candidate)) return candidate
    }
  }
  return null
}

type Located = { target: string; contribution: number }

/** Each string literal that names a file or a package, with how many counted units it carries. */
function locatedStrings(source: string, file: string, tree: Tree, units: Unit[]): Located[] {
  const located: Located[] = []
  for (const match of source.matchAll(/(['"`])([^'"`\n]*)\1/g)) {
    const text = match[2] ?? ''
    const span = { start: (match.index ?? 0) + 1, end: (match.index ?? 0) + 1 + text.length }
    const target = isCountedImport(text) && !text.startsWith('.') ? text : resolvePath(text, file, tree)
    if (target === null) continue
    located.push({ target, contribution: units.filter((u) => within(u, span)).length })
  }
  return located
}

// ── The ownership map and pure forwarding ───────────────────────────────────

export type OwnershipMap = Record<string, string>

export function readOwnershipMap(root: string): OwnershipMap {
  const path = join(root, OWNERSHIP_MAP_PATH)
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as OwnershipMap) : {}
}

/** `source` with every comment blanked to spaces, so offsets still line up; strings are left intact. */
function withoutComments(source: string): string {
  let out = ''
  let i = 0
  while (i < source.length) {
    const c = source[i] ?? ''
    const next = source[i + 1] ?? ''
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < source.length && source[j] !== c) j += source[j] === '\\' ? 2 : 1
      out += source.slice(i, j + 1)
      i = j + 1
    } else if (c === '/' && next === '/') {
      const j = source.indexOf('\n', i)
      const end = j === -1 ? source.length : j
      out += ' '.repeat(end - i)
      i = end
    } else if (c === '/' && next === '*') {
      const j = source.indexOf('*/', i + 2)
      const end = j === -1 ? source.length : j + 2
      out += source.slice(i, end).replace(/[^\n]/g, ' ')
      i = end
    } else {
      out += c
      i++
    }
  }
  return out
}

const FORWARDING = /export\s*(?:\*(?:\s*as\s+[\w$]+)?|(?:type\s+)?\{[^}]*\})\s*from\s*(['"])([^'"\n]+)\1\s*;?/g

/**
 * The forwarding statements of a file that is only `export * from` or
 * `export { … } from` statements of its mapped owner, or a refusal naming why it is not.
 */
export function forwardingSpans(
  source: string,
  file: string,
  owner: string,
  tree: Tree
): { spans: Span[] } | { refusal: string } {
  const code = withoutComments(source)
  const spans: Span[] = []
  let rest = code
  for (const match of code.matchAll(FORWARDING)) {
    const target = resolvePath(match[2] ?? '', file, tree)
    if (target !== owner) {
      return { refusal: `${file} forwards to ${match[2]}, not to its mapped owner ${owner}` }
    }
    const start = match.index ?? 0
    spans.push({ start, end: start + match[0].length })
    rest = rest.slice(0, start) + ' '.repeat(match[0].length) + rest.slice(start + match[0].length)
  }
  if (spans.length === 0) return { refusal: `${file} holds no forwarding statement to its mapped owner ${owner}` }
  if (rest.trim() !== '')
    return { refusal: `${file} holds code beyond forwarding statements to its mapped owner ${owner}` }
  return { spans }
}

/** A map entry whose old file exists but is not pure forwarding of its owner is refused. */
export function ownershipRefusals(map: OwnershipMap, read: (path: string) => string | null, tree: Tree): string[] {
  const refusals: string[] = []
  for (const [old, owner] of Object.entries(map)) {
    const source = read(old)
    if (source === null) continue
    const result = forwardingSpans(source, old, owner, tree)
    if ('refusal' in result) refusals.push(`ownership map entry refused: ${result.refusal}. ${REMEDY}`)
  }
  return refusals
}

function excludedSpans(path: string, source: string, map: OwnershipMap, tree: Tree): Span[] {
  const owner = map[path]
  if (owner === undefined) return []
  const result = forwardingSpans(source, path, owner, tree)
  return 'spans' in result ? result.spans : []
}

const isProcessPath = (path: string): boolean => path.startsWith('processes/') || path.startsWith('harness/processes/')

/**
 * Imports by a file under `harness/`, outside a process, that reach a process
 * through an old path the ownership map forwards to its owner: the boundary the
 * import check guards still holds when a dependency moves behind a forwarding entry.
 */
export function importsThroughForwarding(root: string, map: OwnershipMap = readOwnershipMap(root)): string[] {
  const tree = workingTree(root)
  const offending: string[] = []
  const harness = join(root, 'harness')
  if (!existsSync(harness)) return offending
  for (const absolute of sourceFiles(harness)) {
    const file = toRepositoryPath(absolute, root)
    if (isProcessPath(file)) continue
    for (const match of readFileSync(absolute, 'utf8').matchAll(SPECIFIER)) {
      const specifier = match[2] ?? ''
      if (!specifier.startsWith('.')) continue
      let target = resolvePath(specifier, file, tree, true)
      const seen = new Set<string>()
      while (target !== null && map[target] !== undefined && !seen.has(target)) {
        seen.add(target)
        target = map[target] ?? null
      }
      if (target !== null && seen.size > 0 && isProcessPath(target)) {
        offending.push(`${file} imports ${specifier}, which forwards to ${target}`)
      }
    }
  }
  return offending
}

// ── Counting a tree and the baseline ────────────────────────────────────────

export type Baseline = Record<string, number>

/** Each scanned file's count, for files that count above zero, keyed by repository-relative path. */
export function countTree(root: string, map: OwnershipMap = readOwnershipMap(root)): Baseline {
  const tree = workingTree(root)
  const counts: Baseline = {}
  for (const path of scannedFiles(root)) {
    const source = readFileSync(join(root, path), 'utf8')
    const count = countSource(source, excludedSpans(path, source, map, tree))
    if (count > 0) counts[path] = count
  }
  return counts
}

export const total = (baseline: Baseline): number => Object.values(baseline).reduce((sum, n) => sum + n, 0)

export function serializeBaseline(baseline: Baseline): string {
  const sorted: Baseline = {}
  for (const path of Object.keys(baseline).sort()) sorted[path] = baseline[path] ?? 0
  return `${JSON.stringify(sorted, null, 2)}\n`
}

export function writeBaseline(root: string = REPOSITORY_ROOT): Baseline {
  const counts = countTree(root)
  writeFileSync(join(root, BASELINE_PATH), serializeBaseline(counts))
  return counts
}

export function readBaseline(root: string = REPOSITORY_ROOT): Baseline {
  const path = join(root, BASELINE_PATH)
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Baseline) : {}
}

/** Each file whose count differs from its baseline entry, above or below; an absent entry is zero. */
export function compareWithBaseline(counts: Baseline, baseline: Baseline): string[] {
  const failures: string[] = []
  for (const path of [...new Set([...Object.keys(counts), ...Object.keys(baseline)])].sort()) {
    const count = counts[path] ?? 0
    const entry = baseline[path] ?? 0
    if (count > entry) {
      const why = path in baseline ? 'above its baseline entry' : 'and has no baseline entry'
      failures.push(`${path}: counts ${count}, baseline ${entry} — ${why}. ${REMEDY}`)
    } else if (count < entry) {
      failures.push(
        `${path}: counts ${count}, baseline ${entry} — below its baseline entry; lower the entry in this change. ${REMEDY}`
      )
    }
  }
  return failures
}

// ── The base comparison ─────────────────────────────────────────────────────

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1 << 28
  })
}

function gitShow(root: string, rev: string, path: string): string | null {
  try {
    return git(root, ['show', `${rev}:${path}`])
  } catch {
    return null
  }
}

/** New path → old path, and old path → new path, from git's rename detection between the base and HEAD. */
function renames(root: string, base: string): { from: Map<string, string>; to: Map<string, string> } {
  const from = new Map<string, string>()
  const to = new Map<string, string>()
  for (const line of git(root, ['diff', '--find-renames', '--name-status', base, 'HEAD']).split('\n')) {
    const [status, old, renamed] = line.split('\t')
    if (status?.startsWith('R') && old && renamed) {
      from.set(renamed, old)
      to.set(old, renamed)
    }
  }
  return { from, to }
}

/** A base-side target, carried through the renames to where it lives at the head. */
function mapTarget(target: string, to: Map<string, string>): string {
  const renamed = to.get(target)
  if (renamed !== undefined) return renamed
  for (const [old, now] of to) {
    if (!old.startsWith(`${target}/`)) continue
    const suffix = old.slice(target.length)
    if (now.endsWith(suffix)) return now.slice(0, now.length - suffix.length)
  }
  return target
}

export type BaseComparison = { notice: string | null; failures: string[]; baseTotal: number; headTotal: number }

/**
 * Compares the head tree's counts with the base commit's committed baseline.
 * Fails when a file counts above the base entry of the same file or of the file
 * it was renamed from, when a file with no base entry counts above zero, or when
 * the head total is above the base total. A relocated import or path string
 * keeps its base count, and an owner inherits the base entry of each old path
 * the ownership map forwards to it. A base with no baseline passes with a notice.
 */
export function compareBase(root: string, base: string): BaseComparison {
  const baseBaselineText = gitShow(root, base, BASELINE_PATH) ?? gitShow(root, base, BASELINE_FALLBACK_PATH)
  if (baseBaselineText === null) {
    return {
      notice: `architecture ratchet: the base ${base} has no baseline at ${[...new Set([BASELINE_PATH, BASELINE_FALLBACK_PATH])].join(' or ')} — nothing to compare; this change's baseline becomes the first.`,
      failures: [],
      baseTotal: 0,
      headTotal: 0
    }
  }
  const baseBaseline = JSON.parse(baseBaselineText) as Baseline
  const headTree = workingTree(root)
  const baseTree = committedTree(root, base)
  const map = readOwnershipMap(root)
  const baseMapText = gitShow(root, base, OWNERSHIP_MAP_PATH)
  const baseMap = baseMapText === null ? {} : (JSON.parse(baseMapText) as OwnershipMap)
  const { from, to } = renames(root, base)
  const readHead = (path: string): string | null =>
    existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : null

  const failures = ownershipRefusals(map, readHead, headTree)
  if (failures.length > 0) return { notice: null, failures, baseTotal: total(baseBaseline), headTotal: 0 }

  const inherited = new Map<string, number>()
  for (const [old, owner] of Object.entries(map)) {
    inherited.set(owner, (inherited.get(owner) ?? 0) + (baseBaseline[from.get(old) ?? old] ?? 0))
  }

  let headTotal = 0
  for (const path of scannedFiles(root)) {
    const source = readHead(path) ?? ''
    const units = countedUnits(source, excludedSpans(path, source, map, headTree))
    const basePath = baseTree.isFile(path) ? path : from.get(path)
    let effective = units.length
    if (basePath !== undefined && units.length > 0) {
      const baseSource = gitShow(root, base, basePath) ?? ''
      const baseUnits = countedUnits(baseSource, excludedSpans(basePath, baseSource, baseMap, baseTree))
      const pending = locatedStrings(baseSource, basePath, baseTree, baseUnits).map((l) => ({
        ...l,
        target: mapTarget(l.target, to)
      }))
      for (const located of locatedStrings(source, path, headTree, units)) {
        const index = pending.findIndex((p) => p.target === located.target)
        if (index === -1) continue
        effective += (pending[index]?.contribution ?? 0) - located.contribution
        pending.splice(index, 1)
      }
    }
    headTotal += effective
    const allowance = (basePath === undefined ? 0 : (baseBaseline[basePath] ?? 0)) + (inherited.get(path) ?? 0)
    if (effective > allowance) {
      const why =
        basePath === undefined
          ? 'a file with no base entry counts above zero'
          : basePath === path
            ? 'above its base entry'
            : `above the base entry of ${basePath}, which it was renamed from`
      failures.push(`${path}: counts ${effective}, base ${allowance} — ${why}. ${REMEDY}`)
    }
  }
  const baseTotal = total(baseBaseline)
  if (headTotal > baseTotal) {
    failures.push(`total: counts ${headTotal}, base ${baseTotal} — the head total is above the base total. ${REMEDY}`)
  }
  return { notice: null, failures, baseTotal, headTotal }
}

// ── The command ─────────────────────────────────────────────────────────────

const say = (line: string): void => void process.stdout.write(`${line}\n`)
const complain = (line: string): void => void process.stderr.write(`${line}\n`)

function main(argv: string[]): number {
  if (argv[0] === '--write') {
    const counts = writeBaseline()
    say(
      `architecture ratchet: wrote ${BASELINE_PATH} — total ${total(counts)} across ${Object.keys(counts).length} files.`
    )
    return 0
  }
  if (argv[0] === '--compare-base' && argv[1]) {
    const base = argv[1]
    try {
      git(REPOSITORY_ROOT, ['rev-parse', '--verify', `${base}^{commit}`])
    } catch {
      complain(`architecture ratchet: the base cannot be read — \`git rev-parse --verify ${base}^{commit}\` failed.`)
      return 2
    }
    const result = compareBase(REPOSITORY_ROOT, base)
    if (result.notice) say(result.notice)
    for (const failure of result.failures) complain(failure)
    if (result.failures.length > 0) return 1
    if (!result.notice)
      say(`architecture ratchet: head total ${result.headTotal}, base total ${result.baseTotal} — no growth.`)
    return 0
  }
  complain(`usage: ${WRITE_COMMAND}\n       ${COMPARE_COMMAND}`)
  return 2
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
