#!/usr/bin/env node
/**
 * A pull request's CI entrypoint into the test selector: what one `test-cli`
 * shard runs, and whether the shared-packages job may narrow to the packages
 * the diff affects. A push to `main` never calls this — it runs everything.
 *
 * The selection is the pre-push hook's own (`prePushSelection`), walked to
 * its full transitive closure instead of the hook's depth one. The selector
 * sees TypeScript imports and declared folder scans only, so the answer
 * narrows nothing unless every changed path is a kind it can see — a path
 * under the portal, under `.changeset/`, or a TypeScript source under a
 * source folder of a workspace member the selector itself models (found from
 * the root manifest's `workspaces`, never a fixed folder list), outside a
 * fixture folder and other than a test preload, which no test imports. Any
 * other changed path, a base commit that does not resolve, a selection that
 * throws, or a selection that saw no changed file while git did means the
 * whole shard and every package.
 *
 *   bun apps/cli/src/lib/ci-test-selection.ts --base <sha> --shard-list <file>
 *     prints the shard's paths to run, relative to `apps/cli`, one per line —
 *     empty when nothing in that shard is selected.
 *   bun apps/cli/src/lib/ci-test-selection.ts --base <sha> --packages
 *     prints `affected` when the shared-packages job may narrow, else `all`.
 *   bun apps/cli/src/lib/ci-test-selection.ts --base <sha> --decision <file>
 *     writes the decision to <file> as JSON, every path repository-relative —
 *     the selected `bun test` files, apart the selected tests another
 *     native runner owns, and the changed paths — for the test schedule
 *     (`scripts/test-suites/schedule.ts`) to place; prints `all` or `selected`.
 *
 * Two optional flags change nothing on STDOUT: `--layout <file>` reads a
 * {@link WorkspaceLayout} JSON a repository's own adapter wrote (the source
 * folders and preloads its inventory declares) in place of the discovered
 * default, and `--explain <file>` writes the decision and, when it narrowed,
 * why each selected test was selected.
 *
 * The reason for the answer goes to STDERR, so the STDOUT a workflow captures
 * holds nothing else. Run from the repository root.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, posix, relative } from 'node:path'
import { prePushSelection } from './pre-push-selection.js'
import { changedFilesSinceRemoteBase, removedFilesSinceRemoteBase } from './remote-base.js'
import { discoverWorkspaceDirs, type SelectionExplanation } from './test-selector.js'

/** The test preload every `apps/cli` test runs under, which no test imports. */
const TEST_PRELOAD = 'apps/cli/tests/lib/test-env-preload.ts'

/** The package folder a shard list's paths are relative to. */
const CLI_DIR = 'apps/cli'

/** The folders of a workspace member whose TypeScript the selector models when a layout names none. */
export const DEFAULT_SOURCE_ROOTS: readonly string[] = ['src', 'tests']

/**
 * Where the selector can see: the workspace members it models and, per
 * member, the folders whose TypeScript its graph covers. Paths are
 * repository-relative.
 */
export type WorkspaceLayout = {
  /**
   * The modeled workspace members' directories (`apps/cli`,
   * `harness/kernel`). A `*` inside a segment matches any one directory name,
   * so a layout can name members by the manifest's own pattern.
   */
  packageDirs: readonly string[]
  /**
   * Per member directory, the folders inside it the selector models;
   * {@link DEFAULT_SOURCE_ROOTS} for a member not named here. `.` is every
   * folder of the member except `bin/` and `scripts/`, never a file at the
   * member's top level (its configuration).
   */
  sourceRoots?: Readonly<Record<string, readonly string[]>>
  /** Test preloads: TypeScript every test of a suite runs under that no test imports. */
  preloads?: readonly string[]
  /**
   * Paths, or folder prefixes ending in `/`, read without an import — a
   * program a test spawns, data a test reads — which keep the conservative
   * answer even under a modeled source folder.
   */
  opaque?: readonly string[]
}

/**
 * The layout of a caller that discovered none: members directly under
 * `apps/` or `packages/`, their `src/` and `tests/` folders, and the CLI's
 * test preload. Every CI run discovers its own ({@link discoveredLayout}).
 */
export const CONVENTIONAL_LAYOUT: WorkspaceLayout = { packageDirs: ['apps/*', 'packages/*'], preloads: [TEST_PRELOAD] }

/** The member directory of `layout` that contains `path` — the longest, so a nested member wins over its parent. */
function memberDirOf(path: string, layout: WorkspaceLayout): string | null {
  const segments = path.split('/')
  for (let n = segments.length - 1; n >= 1; n--) {
    const prefix = segments.slice(0, n)
    const hit = layout.packageDirs.find((dir) => {
      const parts = dir.split('/')
      return (
        parts.length === n &&
        parts.every((part, i) =>
          part.includes('*')
            ? new RegExp(
                `^${part
                  .split('*')
                  .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
                  .join('[^/]*')}$`
              ).test(prefix[i] as string)
            : part === prefix[i]
        )
      )
    })
    if (hit) return prefix.join('/')
  }
  return null
}

/**
 * Whether a changed path, repository-root-relative, is one the selector can
 * judge: a path under the portal or under `.changeset/`, or a `.ts`/`.tsx`
 * file inside a source folder of a member `layout` models (by default
 * `apps/<name>/src/`, `packages/<name>/tests/`, ...) that is neither under a
 * `fixtures/` folder, a test preload, nor a path the layout declares opaque.
 * A script or bin outside those folders is often spawned as a process the
 * import graph cannot see, so it runs everything — as does any path under a
 * folder no modeled member owns, because its dependencies are not modeled.
 */
export function isSelectablePath(path: string, layout: WorkspaceLayout = CONVENTIONAL_LAYOUT): boolean {
  if (path.startsWith('apps/vinaya-portal/') || path.startsWith('.changeset/')) return true
  if (!/\.tsx?$/.test(path)) return false
  if (/(^|\/)fixtures\//.test(path)) return false
  if ((layout.preloads ?? []).includes(path)) return false
  if ((layout.opaque ?? []).some((entry) => (entry.endsWith('/') ? path.startsWith(entry) : path === entry)))
    return false
  const member = memberDirOf(path, layout)
  if (!member) return false
  const inside = path.slice(member.length + 1)
  const roots = layout.sourceRoots?.[member] ?? DEFAULT_SOURCE_ROOTS
  return roots.some((root) =>
    root === '.'
      ? inside.includes('/') && !/^(bin|scripts)\//.test(inside)
      : inside.startsWith(`${posix.normalize(root).replace(/\/$/, '')}/`)
  )
}

/**
 * Every `preload` a `bunfig.toml`'s `[test]` table names, as written — read
 * as text, never executed. An unreadable file names none.
 */
function bunfigPreloads(text: string): string[] {
  const table = /^\[test\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(text)?.[1] ?? ''
  const value = /^\s*preload\s*=\s*(\[[^\]]*\]|"[^"]*"|'[^']*')/m.exec(table)?.[1]
  if (!value) return []
  return [...value.matchAll(/["']([^"']+)["']/g)].map((m) => m[1] as string)
}

/**
 * The layout this repository's selector models: every workspace member its
 * own discovery finds from the root manifest (so a member moved under a new
 * parent is found the moment the manifest names it), each member's default
 * source folders, and every test preload the root's or a member's
 * `bunfig.toml` names.
 */
export function discoveredLayout(repoRoot: string): WorkspaceLayout {
  const packageDirs = discoverWorkspaceDirs(repoRoot)
  const preloads = new Set<string>([TEST_PRELOAD])
  for (const dir of ['', ...packageDirs]) {
    let text: string
    try {
      text = readFileSync(join(repoRoot, dir, 'bunfig.toml'), 'utf8')
    } catch {
      continue
    }
    for (const preload of bunfigPreloads(text)) preloads.add(posix.normalize(posix.join(dir || '.', preload)))
  }
  return { packageDirs, preloads: [...preloads].sort() }
}

/**
 * What a pull request's selection decided: everything, with the reason, or a
 * narrowed run — `selected` the files `bun test` runs and, when the facts
 * report them, `native` the selected tests another native runner owns.
 */
export type CiDecision =
  | { scope: 'all'; reason: string }
  | { scope: 'selected'; selected: readonly string[]; native?: readonly string[]; changed?: readonly string[] }

/** The facts a decision is made from, each read by {@link readCiFacts}. */
export type CiFacts = {
  /** Whether the base commit resolves to a commit (`git cat-file -e <base>^{commit}`). */
  baseResolves: boolean
  /** Every path `git diff --name-only --no-renames <base>...HEAD` lists, both sides of a rename included. */
  gitDiff: readonly string[]
  /** The changed and removed paths the selection itself read. */
  selectionChanged: readonly string[]
  /** The selection, run only when every other fact allows narrowing. Throws on any failure. */
  select: () => readonly string[]
  /** Where the selector can see; {@link CONVENTIONAL_LAYOUT} when absent. */
  layout?: WorkspaceLayout
  /** Why each test the last `select` call picked was picked — a separate output, empty before `select` ran. */
  explanations?: () => readonly SelectionExplanation[]
  /** The tests another native runner owns that the last `select` call picked, empty before it ran. */
  native?: () => readonly string[]
}

/** Decides from the facts whether a pull request may run fewer tests than everything. */
export function decideCiSelection(facts: CiFacts): CiDecision {
  if (!facts.baseResolves) return { scope: 'all', reason: 'the base commit does not resolve' }
  const unseen = facts.gitDiff.filter((path) => !isSelectablePath(path, facts.layout))
  if (unseen.length > 0) {
    return { scope: 'all', reason: `the selector cannot judge ${unseen.length} changed path(s), first ${unseen[0]}` }
  }
  if (facts.selectionChanged.length === 0 && facts.gitDiff.length > 0) {
    return { scope: 'all', reason: 'the selection saw no changed file while git diff lists some' }
  }
  try {
    const selected = facts.select()
    return facts.native ? { scope: 'selected', selected, native: facts.native() } : { scope: 'selected', selected }
  } catch (err) {
    return { scope: 'all', reason: `the selection failed: ${(err as Error).message}` }
  }
}

/**
 * The shard list's entries to run: all of them under a run-everything
 * decision, otherwise only those the selection picked, in the list's order.
 * Shard entries are relative to `apps/cli`; the selection is absolute.
 */
export function shardFilesToRun(repoRoot: string, shardList: readonly string[], decision: CiDecision): string[] {
  if (decision.scope === 'all') return [...shardList]
  const picked = new Set(decision.selected.map((file) => relative(join(repoRoot, CLI_DIR), file)))
  return shardList.filter((entry) => picked.has(entry))
}

/**
 * A decision with every path repository-relative and sorted — what
 * `--decision <file>` writes for the test schedule
 * (`scripts/test-suites/schedule.ts`) to read. A narrowed decision also
 * carries the changed paths, `changed`, so the schedule can run whole a
 * suite whose own changes the selector narrows without modeling (the portal).
 */
export function repositoryDecision(
  repoRoot: string,
  decision: CiDecision,
  changed: readonly string[] = []
): CiDecision {
  if (decision.scope === 'all') return decision
  const rel = (files: readonly string[]) => files.map((file) => relative(repoRoot, file).replace(/\\/g, '/')).sort()
  return {
    scope: 'selected',
    selected: rel(decision.selected),
    native: rel(decision.native ?? []),
    changed: [...new Set(changed)].sort()
  }
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/**
 * Reads the facts for `base` from the repository. Unlike the hook's own git
 * helpers, a git error here is never an empty answer. The layout is the
 * repository's discovered one unless the caller supplies its own.
 */
export function readCiFacts(
  repoRoot: string,
  base: string,
  layout: WorkspaceLayout = discoveredLayout(repoRoot)
): CiFacts {
  let baseResolves = true
  try {
    git(repoRoot, ['cat-file', '-e', `${base}^{commit}`])
  } catch {
    baseResolves = false
  }
  if (!baseResolves) return { baseResolves, gitDiff: [], selectionChanged: [], select: () => [], layout }
  let explanations: readonly SelectionExplanation[] = []
  let native: readonly string[] = []
  return {
    baseResolves,
    gitDiff: lines(git(repoRoot, ['diff', '--name-only', '--no-renames', `${base}...HEAD`])),
    selectionChanged: [...changedFilesSinceRemoteBase(repoRoot, base), ...removedFilesSinceRemoteBase(repoRoot, base)],
    select: () => {
      const result = prePushSelection(repoRoot, base, 'transitive', undefined, 'expose')
      explanations = result.explanations
      native = result.native.map((entry) => entry.test)
      return result.selected
    },
    layout,
    explanations: () => explanations,
    native: () => native
  }
}

/** Reads a {@link WorkspaceLayout} JSON file, refusing one whose shape is not a layout. */
export function readLayoutFile(path: string): WorkspaceLayout {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<WorkspaceLayout>
  const strings = (value: unknown) => Array.isArray(value) && value.every((v) => typeof v === 'string')
  if (!strings(parsed.packageDirs)) throw new Error(`${path}: packageDirs is not a list of directories`)
  if (parsed.preloads !== undefined && !strings(parsed.preloads)) throw new Error(`${path}: preloads is not a list`)
  if (parsed.opaque !== undefined && !strings(parsed.opaque)) throw new Error(`${path}: opaque is not a list`)
  if (parsed.sourceRoots !== undefined && !Object.values(parsed.sourceRoots).every(strings))
    throw new Error(`${path}: sourceRoots is not a map of folder lists`)
  return parsed as WorkspaceLayout
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag)
  return at >= 0 ? argv[at + 1] : undefined
}

function main(argv: readonly string[]): void {
  const repoRoot = process.cwd()
  const base = argValue(argv, '--base')
  const shardListPath = argValue(argv, '--shard-list')
  const packages = argv.includes('--packages')
  const decisionPath = argValue(argv, '--decision')
  if (!base || (!shardListPath && !packages && !decisionPath)) {
    process.stderr.write(
      'usage: ci-test-selection.ts --base <sha> (--shard-list <file> | --packages | --decision <file>)\n'
    )
    process.exit(2)
  }
  const started = performance.now()
  const layoutPath = argValue(argv, '--layout')
  const explainPath = argValue(argv, '--explain')
  const facts = readCiFacts(repoRoot, base, layoutPath ? readLayoutFile(layoutPath) : undefined)
  const decision = decideCiSelection(facts)
  const elapsed = (performance.now() - started).toFixed(0)
  const why = decision.scope === 'all' ? `everything: ${decision.reason}` : 'selected'
  if (explainPath) {
    const explanations = decision.scope === 'selected' ? (facts.explanations?.() ?? []) : []
    writeFileSync(explainPath, `${JSON.stringify({ decision, explanations }, null, 2)}\n`)
  }
  if (decisionPath) {
    writeFileSync(decisionPath, `${JSON.stringify(repositoryDecision(repoRoot, decision, facts.gitDiff), null, 2)}\n`)
    process.stdout.write(`${decision.scope}\n`)
    process.stderr.write(`vinaya ci: the selection runs ${why} [${elapsed} ms]\n`)
    return
  }
  if (packages) {
    process.stdout.write(`${decision.scope === 'all' ? 'all' : 'affected'}\n`)
    process.stderr.write(`vinaya ci: shared packages run ${why} [${elapsed} ms]\n`)
    return
  }
  const shardList = lines(readFileSync(shardListPath as string, 'utf8'))
  const run = shardFilesToRun(repoRoot, shardList, decision)
  for (const file of run) process.stdout.write(`${file}\n`)
  process.stderr.write(`vinaya ci: ${run.length} of ${shardList.length} shard file(s), ${why} [${elapsed} ms]\n`)
}

if (import.meta.main) main(process.argv.slice(2))
