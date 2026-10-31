#!/usr/bin/env bun
/**
 * The base-revision guard of a pull request's CI plan: whether the change may
 * be planned at all, or must run the full correctness path.
 *
 * The workflow runs the copy of this file the BASE commit holds, never the
 * pull request's own (`git show <base>:scripts/ci/base-guard.ts`), so a
 * change cannot grant itself a narrowed run by editing this guard, the
 * planner, the inventory, the selection library, the schedule, a runner
 * configuration or the workflow: every one of those, read from the base, is
 * guarded, and a change to any of them runs everything. When the base holds
 * no guard, or anything here cannot be read, the answer is full.
 *
 * It is standalone on purpose: it imports nothing but the runtime's own
 * modules, so nothing the pull request changes runs inside it. What it
 * guards is the planner's whole runtime and type closure at the base —
 * every file the guarded entrypoints reach through a relative import,
 * followed to the end — plus the manifests, lockfile, compiler and runner
 * configuration every one of them resolves through.
 *
 * A pull-request workflow cannot authenticate itself: the workflow file is the
 * pull request's own. This guard keeps the planner from exempting itself; the
 * backstops for a workflow edit are the independent review, the full run of
 * every default-branch commit, and the review loop's own head-bound read of
 * the `Vinaya CI` check (`apps/cli/specs/self-hosting.md`).
 *
 *   bun base-guard.ts --base <sha> --head <sha>
 *     prints `{ verdict: "plan" | "full", reason, guarded }` as JSON; exits 0
 *     with either verdict, 2 on a usage error.
 */
import { execFileSync } from 'node:child_process'
import { posix } from 'node:path'

/** The planner's entrypoints at the base, each followed through its relative imports. */
export const GUARDED_ENTRYPOINTS: readonly string[] = [
  'scripts/ci/base-guard.ts',
  'scripts/ci/impact-plan.ts',
  'scripts/ci/governance-obligations.ts',
  'scripts/ci/replay.ts',
  'scripts/test-suites/repository-selection.ts',
  'scripts/test-suites/inventory-check.ts',
  'scripts/test-suites/schedule.ts',
  'apps/cli/src/lib/verification/index.ts',
  'apps/cli/src/lib/ci-test-selection.ts',
  'apps/cli/src/lib/pre-push-selection.ts',
  'apps/cli/src/lib/ci-shard-membership.ts'
]

/** Folders whose every file is a planning, routing or workflow input. */
export const GUARDED_FOLDERS: readonly string[] = [
  '.github/workflows/',
  'scripts/ci/',
  'scripts/test-suites/',
  'apps/cli/src/lib/verification/',
  'apps/cli/tests/ci-shards/'
]

/**
 * Files every package resolves through, wherever they sit: manifests,
 * the lockfile, the task graph, compiler, runner and lint configuration, and
 * the repository configuration whose lists the planner reads.
 */
export const GUARDED_ROOT_FILES: readonly string[] = [
  'package.json',
  'bun.lock',
  'turbo.json',
  'biome.json',
  'bunfig.toml',
  'tsconfig.json',
  'vinaya.config.json'
]

/** A file of this name in any folder is a package's manifest, compiler or runner configuration. */
const GUARDED_BASENAME = /^(package\.json|bunfig\.toml|tsconfig(\..+)?\.json|vitest\.config\.[cm]?[jt]s)$/

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)(['"])(\.{1,2}\/[^'"]+)\1/gm

export type GuardVerdict = { verdict: 'plan' | 'full'; reason: string; guarded: string[] }

/** Reads one file at the base: its text, or `null` when the base does not hold it. */
export type BaseReader = (path: string) => string | null

/**
 * The source with its comments blanked, so an example import a comment quotes
 * is not read as one. A `//` or `/*` inside a string literal is kept: only
 * text outside a quote is a comment.
 */
export function withoutComments(text: string): string {
  let out = ''
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string
    if (quote) {
      out += c
      if (c === '\\') out += text[++i] ?? ''
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c
      out += c
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      const body = text.slice(i, end < 0 ? text.length : end + 2)
      out += body.replace(/[^\n]/g, ' ')
      i = end < 0 ? text.length : end + 1
    } else out += c
  }
  return out
}

/** The relative specifiers a source text's code (not its comments) names. */
export function relativeSpecifiers(text: string): string[] {
  return [...withoutComments(text).matchAll(SPECIFIER)].map((m) => m[2] as string)
}

/** The files a relative specifier can resolve to, in the order a TypeScript resolver tries them. */
function candidates(from: string, specifier: string): string[] {
  const target = posix.normalize(posix.join(posix.dirname(from), specifier))
  const stem = target.replace(/\.(m|c)?js$/, '')
  return [target, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}/index.ts`, `${target}.ts`, `${target}/index.ts`]
}

/**
 * Every file the entrypoints reach at the base through relative imports. A
 * specifier that resolves to no file the base holds is reported, never
 * silently dropped: the caller treats it as a reason to run everything.
 */
export function guardedClosure(
  read: BaseReader,
  entrypoints: readonly string[] = GUARDED_ENTRYPOINTS
): { files: string[]; unresolved: string[] } {
  const seen = new Set<string>()
  const unresolved: string[] = []
  const queue = [...entrypoints]
  while (queue.length > 0) {
    const file = queue.shift() as string
    if (seen.has(file)) continue
    const text = read(file)
    if (text === null) {
      // An entrypoint the base does not yet hold has nothing to guard there.
      if (!entrypoints.includes(file)) unresolved.push(file)
      continue
    }
    seen.add(file)
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue
    for (const specifier of relativeSpecifiers(text)) {
      const hit = candidates(file, specifier).find((path) => read(path) !== null)
      if (hit) queue.push(hit)
      else unresolved.push(`${file} → ${specifier}`)
    }
  }
  return { files: [...seen].sort(), unresolved }
}

/** Whether a changed path is a planning input this guard protects. */
export function isGuardedPath(path: string, closure: ReadonlySet<string>): boolean {
  if (closure.has(path)) return true
  if (GUARDED_FOLDERS.some((folder) => path.startsWith(folder))) return true
  if (GUARDED_ROOT_FILES.includes(path)) return true
  return GUARDED_BASENAME.test(posix.basename(path))
}

/** The verdict for a change: full when it touches a guarded input, or when the closure could not be read whole. */
export function guardVerdict(changed: readonly string[], read: BaseReader): GuardVerdict {
  const { files, unresolved } = guardedClosure(read)
  if (unresolved.length > 0)
    return {
      verdict: 'full',
      reason: `the base guard could not resolve ${unresolved.length} planner import(s), first ${unresolved[0]}`,
      guarded: []
    }
  const closure = new Set(files)
  const guarded = changed.filter((path) => isGuardedPath(path, closure)).sort()
  if (guarded.length > 0)
    return {
      verdict: 'full',
      reason: `the change touches ${guarded.length} planning input(s) the base guards, first ${guarded[0]}`,
      guarded
    }
  return { verdict: 'plan', reason: 'no planning input the base guards changed', guarded: [] }
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024
  })
}

/** The verdict for `base`..`head` in `repoRoot`; any git failure is a full run, with its reason. */
export function guardRepository(repoRoot: string, base: string, head: string): GuardVerdict {
  let changed: string[]
  try {
    for (const rev of [base, head]) git(repoRoot, ['cat-file', '-e', `${rev}^{commit}`])
    changed = git(repoRoot, ['diff', '--name-only', '--no-renames', '-z', base, head]).split('\0').filter(Boolean)
  } catch (err) {
    return {
      verdict: 'full',
      reason: `the base guard could not read the change: ${(err as Error).message.split('\n')[0]}`,
      guarded: []
    }
  }
  let listed: Set<string>
  try {
    listed = new Set(git(repoRoot, ['ls-tree', '-r', '-z', '--name-only', base]).split('\0').filter(Boolean))
  } catch (err) {
    return {
      verdict: 'full',
      reason: `the base guard could not list the base: ${(err as Error).message.split('\n')[0]}`,
      guarded: []
    }
  }
  const read: BaseReader = (path) => {
    if (!listed.has(path)) return null
    try {
      return git(repoRoot, ['show', `${base}:${path}`])
    } catch {
      return null
    }
  }
  return guardVerdict(changed, read)
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag)
  return at >= 0 ? argv[at + 1] : undefined
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const base = argValue(argv, '--base')
  const head = argValue(argv, '--head')
  if (!base || !head) {
    process.stderr.write('usage: base-guard.ts --base <sha> --head <sha>\n')
    process.exitCode = 2
  } else {
    const repoRoot = argValue(argv, '--repo') ?? process.cwd()
    const verdict = {
      schema: 'vinaya.ci-base-guard',
      schemaVersion: 1,
      base,
      head,
      ...guardRepository(repoRoot, base, head)
    }
    process.stdout.write(`${JSON.stringify(verdict)}\n`)
  }
}
