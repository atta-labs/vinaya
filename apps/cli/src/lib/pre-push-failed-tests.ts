/**
 * Re-run only what failed. When the pre-push hook refuses a push because some
 * selected tests fail, it records which test files failed and at which commit.
 * The next push from the same branch does not re-run the whole selection: it
 * runs those failed files plus the test files affected by the files changed
 * since that refused commit. CI still runs everything once on the pull
 * request, so nothing is skipped overall. A verified passing run leaves a
 * passing record in the same file, and the next push on the branch then runs
 * only the hook's own selection for what changed since that pass, never the
 * full selection; every record that does not fit gives the full selection.
 *
 * The record lives in the worktree's own git directory
 * (`git rev-parse --git-path`), never in the tree: it is a fact about this
 * checkout's last refused push, not something to commit or share.
 *
 * Every decision here is a pure function of its inputs so it is unit-tested
 * without git; the IO wrappers at the bottom are thin.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import type { NativeGroup } from './verification/index.js'

/** File name of the record under the worktree's git directory. */
export const FAILED_TESTS_RECORD = 'vinaya/pre-push-failed-tests.json'
/** File name of the last push's selection and result summary, read by the loop for its Log events. */
export const LAST_PUSH_RESULT = 'vinaya/pre-push-last-result.json'
/** File name the selector writes so the result recorder knows whether the run it records was a re-run. */
export const SELECTION_NOTE = 'vinaya/pre-push-selection.json'

/** What a refused push leaves behind for the next one. */
export type FailedTestsRecord = {
  version: 1
  /** The commit the refused push tried to publish. */
  head: string
  /** The branch it was on, so a record never leaks across branches in one worktree. */
  branch: string
  /**
   * Absolute paths of the failing test files, or `'all'` when the run failed
   * without naming any file (a crash, an unhandled error outside a file) —
   * the next push then runs its full selection, never nothing.
   */
  failed: string[] | 'all'
  recordedAt: string
  /** Only a supervised, fully completed selection permits a narrow rerun. */
  selectionCompleted?: boolean
  /** The native verification context ({@link NativeSelection.context}) the refused run executed under, when it was a native run. */
  context?: string
}

/**
 * The plan a repository's native local-run adapter froze for one push: the shared selector's answer for the base the
 * push chose, plus the push's own obligations, grouped once per native runner start. Version 1; a reader that does
 * not know `native` reads the note exactly as before.
 */
export type NativeSelection = {
  version: 1
  /** The selector's base commit: the merge base with the remote base, a verified passing head, or a refused head. */
  base: string
  baseKind: 'merge-base' | 'since-green' | 'rerun'
  /** The selection plan's own identity. */
  plan: string
  /** The head inventory's semantic context identity (its schema, declarations and runner facts). */
  inventory: string
  /** The verification context the plan executes under: the context digest, {@link inventory} and the engine. */
  context: string
  /** Every expected `<test>@<configuration>`, sorted. */
  identities: string[]
  /** The unresolved failed tests the push added on top of the selection, repository-relative. */
  obligations: string[]
  /** One runner start per group, in run order, exactly as the run step starts it. */
  groups: NativeGroup[]
  /** Suites the push runs whole because their runner cannot be narrowed to the selected files, with why. */
  expanded: { suite: string; reason: string }[]
  /** The aggregate native command (`nativeRunCommand`), or null when nothing was selected. */
  command: string | null
}

/** What the native run of a {@link NativeSelection} completed. Version 1. */
export type NativeCompletion = {
  version: 1
  /** True only when every group's runner exited, left a readable report, and executed exactly its tests. */
  completed: boolean
  /** Every `<test>@<configuration>` the reports confirm executed once. */
  executed: string[]
  failedRunners: string[]
  problems: { code: string; path: string; group?: string; detail: string }[]
}

/**
 * What a verified passing run leaves for the next push: the commit whose whole
 * selection passed, on which branch, and the digest of the selection policy and
 * execution context it passed under. It shares the failed-files record's file,
 * so a refusal replaces it and a later verified pass replaces a refusal; its
 * version differs, so a reader of the failed-files shape never takes it for one.
 */
export type PassingRecord = {
  version: 2
  kind: 'passed'
  head: string
  branch: string
  /** The test files that ran and completed. */
  selection: string[]
  /** Only a run whose whole expected selection completed leaves a record, and the record says so. */
  selectionCompleted: true
  /** {@link VerificationContext.digest} the run executed under. */
  context: string
  recordedAt: string
}

/** The fields every selection note carries, whatever mode chose the tests. */
type SelectionNoteBase = {
  version: 1
  head: string
  selected: string[]
  /** The verification context digest the selection was made under; absent when it was unreadable or an input was dirty, so no passing record can follow. */
  context?: string
  /** The frozen native plan, when a repository's native local-run adapter made the selection. */
  native?: NativeSelection
}

/** How the selector chose this push's tests. */
export type SelectionNote = SelectionNoteBase &
  (
    | { mode: 'full'; fullCount: number }
    | {
        mode: 'rerun'
        /** The refused commit this re-run continues from. */
        rerunOf?: string
        /** The recorded head the mode builds on (the refused commit). */
        recordedHead?: string
        /** Failed files carried over from that refused push. */
        rerunFailed?: string[]
        /** Files affected by the changes since the refused commit. */
        affectedSince?: string[]
        /** Size of the full selection this push would otherwise have run. */
        fullCount: number
      }
    | {
        mode: 'since-green'
        /** The passing head this selection builds on. */
        recordedHead: string
        /** Files affected by the changes since that head, without the always-run files that run regardless. */
        affectedSince: string[]
        /** The full selection is not computed on this path, so its size is unavailable rather than invented. */
        fullCount: null
      }
  )

/** The last push's summary: what ran and what failed. */
export type LastPushResult = {
  version: 1
  head: string
  branch: string
  /** `storage` (cheap checks only), `ready` (after approval), or `default` (today's push). */
  mode: 'storage' | 'ready' | 'default'
  outcome: 'passed' | 'failed'
  selection: SelectionNote | null
  failed: string[] | 'all'
  selectionCompleted?: boolean
  elapsedSeconds: number | null
  recordedAt: string
  /** What the native run completed, when `selection.native` planned it. */
  native?: NativeCompletion
}

/** Emitted by the supervisor only after Bun exits normally, never after a signal or native crash. */
export const TEST_SELECTION_COMPLETE = 'vinaya-test-selection-complete '

/** The whole expected selection completed normally, with a terminal Bun summary for every batch. */
export function completedTestSelection(log: string, cwd: string, expected?: readonly string[]): boolean {
  const completed = new Set<string>()
  let batch: string[] = []
  let markers = 0
  const absolute = (path: string) => (isAbsolute(path) ? path : join(cwd, path))
  for (const line of log.split('\n')) {
    if (!line.startsWith(TEST_SELECTION_COMPLETE)) {
      batch.push(line)
      continue
    }
    try {
      const result = JSON.parse(line.slice(TEST_SELECTION_COMPLETE.length)) as { files: string[]; exitCode: number }
      if (
        ![0, 1].includes(result.exitCode) ||
        !Array.isArray(result.files) ||
        !result.files.every((file) => typeof file === 'string')
      )
        return false
      const text = batch.join('\n')
      const summary = [...text.matchAll(/^Ran \d+ tests? across (\d+) files?\.(?:.*)$/gm)].at(-1)
      const headers = new Set([...text.matchAll(/^(\S.*\.test\.[a-zA-Z]+):$/gm)].map((match) => absolute(match[1]!)))
      const files = new Set(result.files.map(absolute))
      if (
        !summary ||
        Number(summary[1]) !== files.size ||
        headers.size !== files.size ||
        [...files].some((file) => !headers.has(file))
      )
        return false
      for (const file of files) completed.add(file)
      markers++
      batch = []
    } catch {
      return false
    }
  }
  if (markers === 0 || batch.join('\n').trim() !== '') return false
  return (
    expected === undefined ||
    (new Set(expected.map(absolute)).size === completed.size && expected.every((file) => completed.has(absolute(file))))
  )
}

/**
 * The test files that failed in one captured `bun test` run. A file counts
 * as failed when its own block (from its `<path>.test.<ext>:` header to the
 * next header) holds a `(fail)` line or an unhandled error. Relative headers
 * resolve against `cwd`. Returns `'all'` when `exitedNonZero` but no file
 * could be named, so a crash never turns into an empty re-run.
 */
export function parseFailedTestFiles(
  log: string,
  cwd: string,
  exitedNonZero: boolean,
  selected?: readonly string[]
): string[] | 'all' {
  if (exitedNonZero && !completedTestSelection(log, cwd, selected)) return 'all'
  const failed = new Set<string>()
  let current: string | null = null
  for (const raw of log.split('\n')) {
    const line = raw.trimEnd()
    if (/^\d+ tests? failed:/.test(line)) {
      current = null
      continue
    }
    const header = /^(\S.*\.test\.[a-zA-Z]+):$/.exec(line)
    if (header?.[1]) {
      current = isAbsolute(header[1]) ? header[1] : join(cwd, header[1])
      continue
    }
    if (current && (/^\(fail\) /.test(line) || line.startsWith('# Unhandled error'))) failed.add(current)
  }
  if (failed.size === 0) return exitedNonZero ? 'all' : []
  return [...failed].sort()
}

export type RerunInputs = {
  record: FailedTestsRecord | null
  head: string
  branch: string
  /** Whether `record.head` is an ancestor of (or equal to) `head`. */
  recordIsAncestor: boolean
  /** The full selection for this push (what today's hook would run). */
  fullSelection: string[]
  /** Test files selected for the files changed between `record.head` and `head` alone. */
  affectedSince: string[]
  /** Whether a path still exists — a failed test file deleted since sends the push back to its full selection. */
  exists: (path: string) => boolean
}

/**
 * The tests this push runs. A usable record (same branch, its commit still in
 * this branch's history, a named file list) gives the failed files plus the
 * files affected since; anything else gives the full selection — the wider,
 * safe answer.
 */
export function chooseTests(inputs: RerunInputs): SelectionNote {
  const { record, head, branch, fullSelection } = inputs
  const full: SelectionNote & { mode: 'full' } = {
    version: 1,
    mode: 'full',
    head,
    fullCount: fullSelection.length,
    selected: fullSelection
  }
  if (!record || record.failed === 'all' || record.selectionCompleted !== true) return full
  if (record.branch !== branch || !inputs.recordIsAncestor) return full
  // A refusal was recorded, so this push must run something: a failed file deleted since (which would let the push
  // pass having run nothing it refused for), or a re-run that comes out empty, takes the full selection instead.
  if (!record.failed.every(inputs.exists)) return full
  const rerunFailed = [...record.failed]
  // Deletions count as changes (they widen what is affected), but a deleted test file is never itself run.
  const affectedSince = inputs.affectedSince.filter(inputs.exists).sort()
  const selected = [...new Set([...rerunFailed, ...affectedSince])].sort()
  if (selected.length === 0) return full
  return {
    version: 1,
    mode: 'rerun',
    head,
    rerunOf: record.head,
    recordedHead: record.head,
    rerunFailed,
    affectedSince,
    fullCount: fullSelection.length,
    selected
  }
}

/** The record a refused run leaves, or `null` for a green run (which clears it). */
export function recordFromRun(
  outcome: 'passed' | 'failed',
  failed: string[] | 'all',
  head: string,
  branch: string,
  now: Date
): FailedTestsRecord | null {
  if (outcome === 'passed') return null
  return { version: 1, head, branch, failed, recordedAt: now.toISOString(), selectionCompleted: failed !== 'all' }
}

/** Reads a JSON record, or `null` when missing, unreadable or of another shape. */
export function parseRecord(text: string | null): FailedTestsRecord | null {
  if (!text) return null
  try {
    const value = JSON.parse(text) as Partial<FailedTestsRecord>
    if (value.version !== 1 || typeof value.head !== 'string' || typeof value.branch !== 'string') return null
    if (value.failed !== 'all' && !Array.isArray(value.failed)) return null
    return value as FailedTestsRecord
  } catch {
    return null
  }
}

// ── Passing record and the since-green selection ────────────────────────────

/** The version a passing record carries; anything else (the failed-files record's `1`, an older shape) refuses reuse. */
export const PASSING_RECORD_VERSION = 2

/**
 * What a passing record is only valid under. Changing any of it makes an older
 * pass say nothing about this checkout, so a changed policy or an incompatible
 * recorded policy always gives the full selection.
 */
export const SELECTION_POLICY = {
  name: 'pre-push-since-green',
  version: 1,
  depth: 'one',
  testTimeoutMs: 30000,
  /** The repository-root configuration file whose change always gives the full selection (the test selector's `ROOT_CONFIG_FILENAME`). */
  rootConfigFile: 'vinaya.config.json'
} as const

/**
 * Identifies the semantic selection policy, the declarations of what a test
 * depends on, and the execution context a pass ran in — never the changed
 * subject sources or any per-commit graph, which the incremental selection
 * itself accounts for.
 */
export type VerificationContext = {
  digest: string
  parts: { policy: string; inputs: string; lockfile: string; runner: string; environment: string }
}

/** Files whose uncommitted edits make a recorded or reused pass unverifiable. */
export const VERIFICATION_LOCKFILES = ['bun.lock', 'bun.lockb', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']
const VERIFICATION_INPUT_FILES = ['vinaya.config.json', 'package.json', 'bunfig.toml', ...VERIFICATION_LOCKFILES]
/** The environment variables that change how a test run behaves. */
export const VERIFICATION_ENV_KEYS = ['BUN_ENV', 'CI', 'NODE_ENV', 'NODE_OPTIONS', 'TZ']

/** Reads a passing record, or `null` when missing, of another version or of another shape. */
export function parsePassingRecord(text: string | null): PassingRecord | null {
  if (!text) return null
  try {
    const value = JSON.parse(text) as Partial<PassingRecord>
    if (value.version !== PASSING_RECORD_VERSION || value.kind !== 'passed') return null
    if (typeof value.head !== 'string' || typeof value.branch !== 'string' || typeof value.context !== 'string')
      return null
    if (!Array.isArray(value.selection) || !value.selection.every((file) => typeof file === 'string')) return null
    return value as PassingRecord
  } catch {
    return null
  }
}

/** The selector's note when it parses, describes `head` and names its selected files; otherwise `null`. */
export function parseSelectionNote(text: string | null, head: string): SelectionNote | null {
  if (!text) return null
  try {
    const value = JSON.parse(text) as Partial<SelectionNote> & { selected?: unknown }
    if (value.head !== head || !Array.isArray(value.selected)) return null
    if (!value.selected.every((file) => typeof file === 'string')) return null
    return { mode: 'full', ...value } as SelectionNote
  } catch {
    return null
  }
}

export type PassingRunInputs = {
  /** What the hook reported for the run. */
  outcome: 'passed' | 'failed'
  /** The selection note for the current head, already checked by {@link parseSelectionNote}. */
  selection: SelectionNote | null
  log: string
  repoRoot: string
  /** The head and branch now, read after the run. */
  head: string
  branch: string
  /** The verification context now, read after the run (`null` when unreadable). */
  context: string | null
  /** Whether the verification inputs are clean now (`null` when git could not say). */
  inputsClean: boolean | null
  now: Date
}

/**
 * The record a verified passing run leaves, or `null`. Verified means: the
 * note for this very head parses and names a non-empty selection, the log
 * shows every file of that selection completed (read WITH the expected list —
 * without it a one-file log counts as complete), and the head, the context
 * and the clean inputs the selection was made under are the ones still in
 * place after the run.
 */
export function passingRecordFromRun(inputs: PassingRunInputs): PassingRecord | null {
  const { selection, head, branch } = inputs
  if (inputs.outcome !== 'passed' || !selection || selection.head !== head) return null
  if (selection.selected.length === 0 || !head || !branch || branch === 'HEAD') return null
  if (!selection.context || inputs.context !== selection.context || inputs.inputsClean !== true) return null
  if (!completedTestSelection(inputs.log, inputs.repoRoot, selection.selected)) return null
  return {
    version: PASSING_RECORD_VERSION,
    kind: 'passed',
    head,
    branch,
    selection: [...selection.selected],
    selectionCompleted: true,
    context: selection.context,
    recordedAt: inputs.now.toISOString()
  }
}

// ── The native push: its base, its obligations and its proof ────────────────

export type NativeBaseInputs = {
  repoRoot: string
  head: string
  branch: string
  /** The merge base of the head with the push's remote base: the initial base. */
  mergeBase: string
  failed: FailedTestsRecord | null
  passing: PassingRecord | null
  /** The native verification context now; `null` when unreadable. */
  context: string | null
  /** Whether the verification inputs are clean; `null` when git could not say. */
  inputsClean: boolean | null
  isAncestor: (ancestor: string) => boolean
  exists: (path: string) => boolean
  /** Absolute paths changed between `from` and the head, or `null` when git could not read them. */
  changedBetween: (from: string) => string[] | null
}

export type NativeBaseChoice = {
  /** The base the shared selector compares the head with. */
  base: string
  kind: NativeSelection['baseKind']
  /** Absolute paths of the unresolved failed tests the push runs on top of the selection. */
  obligations: string[]
  reason: string
}

/**
 * The base a native push hands the shared selector, and the failed tests it adds outside it. A refusal on this
 * branch, still in its history, leaves its named failed files as obligations whatever base is chosen; it narrows the
 * base to the refused head only when that run completed under this very context. Otherwise a verified passing head
 * under this context narrows the base to it. Anything else — another branch, a rewritten history, an unnamed failure,
 * another or unreadable context, dirty inputs, an unreadable diff, a changed root configuration — compares with the
 * merge base: the wider answer.
 */
export function chooseNativeBase(inputs: NativeBaseInputs): NativeBaseChoice {
  const context = inputs.context !== null && inputs.inputsClean === true ? inputs.context : null
  const full = (reason: string, obligations: string[] = []): NativeBaseChoice => ({
    base: inputs.mergeBase,
    kind: 'merge-base',
    obligations,
    reason
  })
  const narrowable = (from: string): boolean => {
    const changed = inputs.changedBetween(from)
    return changed !== null && !changed.includes(join(inputs.repoRoot, SELECTION_POLICY.rootConfigFile))
  }
  const record = inputs.failed
  if (record && record.branch === inputs.branch && inputs.isAncestor(record.head)) {
    if (record.failed === 'all') return full('the last refused push named no failing file')
    const obligations = record.failed.filter(inputs.exists).sort()
    if (obligations.length !== record.failed.length)
      return full('a failed test file of the last refused push no longer exists', obligations)
    if (record.selectionCompleted !== true || context === null || record.context !== context)
      return full('the last refused push ran under another or unreadable verification context', obligations)
    if (!narrowable(record.head)) return full('the changes since the refused push could not be narrowed', obligations)
    return { base: record.head, kind: 'rerun', obligations, reason: `re-running what failed at ${record.head}` }
  }
  const passing = inputs.passing
  if (!passing || passing.selectionCompleted !== true || passing.branch !== inputs.branch)
    return full('no passing run on this branch to build on')
  if (context === null || passing.context !== context) return full('the passing run had another verification context')
  if (!inputs.isAncestor(passing.head)) return full('the passing head is not in this branch history')
  if (!narrowable(passing.head)) return full('the changes since the passing run could not be narrowed')
  return { base: passing.head, kind: 'since-green', obligations: [], reason: `building on the pass at ${passing.head}` }
}

/**
 * The passing record a completed native run leaves, or `null`: the note froze a non-empty native plan for this very
 * head, every runner completed and executed exactly its tests with no failure, the tracked tree held exactly that
 * head, and the head, the context and the clean inputs it was planned under are still in place.
 */
export function nativePassingRecord(input: {
  note: SelectionNote | null
  completion: NativeCompletion
  head: string
  branch: string
  context: string | null
  inputsClean: boolean | null
  /** Whether the tracked tree matches the head (no tracked change, staged or not); `null` when git could not say. */
  treeClean: boolean | null
  now: Date
}): PassingRecord | null {
  const { note, completion } = input
  const native = note?.native
  if (!note || !native || note.head !== input.head || native.identities.length === 0) return null
  if (!input.branch || input.branch === 'HEAD' || input.treeClean !== true) return null
  if (!completion.completed || completion.failedRunners.length > 0 || completion.problems.length > 0) return null
  if (input.context === null || native.context !== input.context || input.inputsClean !== true) return null
  const expected = [...native.identities].sort()
  const executed = [...completion.executed].sort()
  if (expected.length !== executed.length || expected.some((id, i) => id !== executed[i])) return null
  return {
    version: PASSING_RECORD_VERSION,
    kind: 'passed',
    head: input.head,
    branch: input.branch,
    selection: [...note.selected],
    selectionCompleted: true,
    context: native.context,
    recordedAt: input.now.toISOString()
  }
}

/** What the since-green selection read: the hook's own selection for the changes since a base, and whether any git read behind it failed. */
export type SinceGreenRead = { selected: string[]; readFailed: boolean }

export type SelectionDeps<Full extends { selected: string[] }> = {
  repoRoot: string
  head: string
  branch: string
  failed: FailedTestsRecord | null
  passing: PassingRecord | null
  /** The verification context now; `null` when unreadable. */
  context: string | null
  /** Whether the verification inputs are clean; `null` when git could not say. */
  inputsClean: boolean | null
  /** Whether `ancestor` is an ancestor of (or equal to) the current head. */
  isAncestor: (ancestor: string) => boolean
  exists: (path: string) => boolean
  /** Absolute paths changed between `from` and the head, or `null` when git could not read them. */
  changedBetween: (from: string) => string[] | null
  /** Whether the always-run configuration names this absolute path. */
  isAlwaysRun: (path: string) => boolean
  /** The hook's own selection with `from` as its base. */
  sinceGreen: (from: string) => SinceGreenRead
  /** Test files affected by the given changes alone — the rerun path's own selector call. */
  affectedSince: (changed: string[]) => string[]
  /** The full branch selection — computed only when no passing record can answer. */
  full: () => Full
}

/**
 * Chooses this push's tests. A usable passing record answers from the
 * incremental selection alone and never computes the full one; anything else —
 * including every unreadable diff — takes the full selection (or, after a
 * refusal, the failed-files rerun), the wider, safe answer.
 */
export function decideSelection<Full extends { selected: string[] }>(
  deps: SelectionDeps<Full>
): { note: SelectionNote; full: Full | null } {
  const context = deps.context !== null && deps.inputsClean === true ? deps.context : null
  const withContext = (note: SelectionNote): SelectionNote => (context === null ? note : { ...note, context })
  const sinceGreen = deps.failed === null ? sinceGreenNote(deps, context) : null
  if (sinceGreen) return { note: withContext(sinceGreen), full: null }

  const full = deps.full()
  const record = deps.failed
  const recordIsAncestor = record ? deps.isAncestor(record.head) : false
  let usable = record
  let affectedSince: string[] = []
  if (record && record.failed !== 'all' && recordIsAncestor && record.branch === deps.branch) {
    const changed = deps.changedBetween(record.head)
    if (changed === null) usable = null
    else affectedSince = deps.affectedSince(changed)
  }
  const note = chooseTests({
    record: usable,
    head: deps.head,
    branch: deps.branch,
    recordIsAncestor,
    fullSelection: full.selected,
    affectedSince,
    exists: deps.exists
  })
  return { note: withContext(note), full }
}

function sinceGreenNote<Full extends { selected: string[] }>(
  deps: SelectionDeps<Full>,
  context: string | null
): SelectionNote | null {
  const passing = deps.passing
  if (!passing || passing.selectionCompleted !== true || passing.selection.length === 0) return null
  if (passing.branch !== deps.branch || context === null || passing.context !== context) return null
  if (!deps.isAncestor(passing.head)) return null
  const changed = deps.changedBetween(passing.head)
  if (changed === null || changed.includes(join(deps.repoRoot, SELECTION_POLICY.rootConfigFile))) return null
  const read = deps.sinceGreen(passing.head)
  if (read.readFailed) return null
  const selected = [...new Set(read.selected)].filter(deps.exists).sort()
  // A change the selector cannot trace to any test selects only the always-run files; running those alone
  // proves nothing about it, so the full selection runs instead.
  const affectedSince = selected.filter((file) => !deps.isAlwaysRun(file) || changed.includes(file))
  if (changed.length > 0 && affectedSince.length === 0) return null
  return {
    version: 1,
    mode: 'since-green',
    head: deps.head,
    recordedHead: passing.head,
    affectedSince,
    fullCount: null,
    selected
  }
}

// ── IO ──────────────────────────────────────────────────────────────────────

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
  return env
}

function git(repoRoot: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: cleanGitEnv()
    }).trim()
  } catch {
    return null
  }
}

/** Absolute path of `name` under this worktree's git directory, or `null` outside a repository. */
export function gitPath(repoRoot: string, name: string): string | null {
  const out = git(repoRoot, ['rev-parse', '--git-path', name])
  if (!out) return null
  return isAbsolute(out) ? out : join(repoRoot, out)
}

export function currentHead(repoRoot: string): string {
  return git(repoRoot, ['rev-parse', 'HEAD']) ?? ''
}

export function currentBranch(repoRoot: string): string {
  return git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']) ?? ''
}

export function isAncestor(repoRoot: string, ancestor: string, head: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, head], {
      cwd: repoRoot,
      stdio: 'ignore',
      env: cleanGitEnv()
    })
    return true
  } catch {
    return false
  }
}

/**
 * Absolute paths of files added, copied, modified, renamed or deleted between
 * two commits, or `null` when git could not read the difference — never an
 * empty list, which says nothing changed.
 */
export function changedBetween(repoRoot: string, from: string, to: string): string[] | null {
  const read = git(repoRoot, ['diff', '--name-only', '--diff-filter=ACMRD', from, to])
  if (read === null) return null
  return read
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((f) => join(repoRoot, f))
}

export function readJsonUnderGit(repoRoot: string, name: string): string | null {
  const path = gitPath(repoRoot, name)
  if (!path || !existsSync(path)) return null
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

export function writeJsonUnderGit(repoRoot: string, name: string, value: unknown): void {
  const path = gitPath(repoRoot, name)
  if (!path) return
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

export function removeUnderGit(repoRoot: string, name: string): void {
  const path = gitPath(repoRoot, name)
  if (path) rmSync(path, { force: true })
}

/** The record left by this worktree's last refused push, if any. */
export function readFailedTestsRecord(repoRoot: string): FailedTestsRecord | null {
  return parseRecord(readJsonUnderGit(repoRoot, FAILED_TESTS_RECORD))
}

/** The passing record left by this worktree's last verified passing run, if any. */
export function readPassingRecord(repoRoot: string): PassingRecord | null {
  return parsePassingRecord(readJsonUnderGit(repoRoot, FAILED_TESTS_RECORD))
}

/** Removes the record file only when it holds `kind` (or nothing readable), leaving the other kind in place. */
export function clearRecordOfKind(repoRoot: string, kind: 'failed' | 'passed'): void {
  const text = readJsonUnderGit(repoRoot, FAILED_TESTS_RECORD)
  const other = kind === 'failed' ? parsePassingRecord(text) : parseRecord(text)
  if (text !== null && other !== null) return
  removeUnderGit(repoRoot, FAILED_TESTS_RECORD)
}

/**
 * The digest of the selection policy, input declarations, lockfiles, runner
 * configuration and relevant environment a run executes under, or `null` when
 * any of them cannot be read — an unreadable context refuses reuse.
 */
export function computeVerificationContext(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env
): VerificationContext | null {
  try {
    const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
    const read = (name: string): Buffer | null => {
      const path = join(repoRoot, name)
      return existsSync(path) ? readFileSync(path) : null
    }
    const json = (name: string): Record<string, unknown> | null => {
      const bytes = read(name)
      return bytes === null ? null : (JSON.parse(bytes.toString('utf8')) as Record<string, unknown>)
    }
    const config = json('vinaya.config.json')
    const pkg = json('package.json')
    const scripts = pkg?.scripts as Record<string, unknown> | undefined
    const bunfig = read('bunfig.toml')
    const parts = {
      policy: sha(JSON.stringify(SELECTION_POLICY)),
      inputs: sha(JSON.stringify({ prePush: config?.prePush ?? null, workspaces: pkg?.workspaces ?? null })),
      lockfile: sha(
        VERIFICATION_LOCKFILES.map((name) => {
          const bytes = read(name)
          return `${name}:${bytes === null ? 'absent' : sha(bytes)}`
        }).join('\n')
      ),
      runner: sha(
        JSON.stringify({
          bunfig: bunfig === null ? null : sha(bunfig),
          testScript: scripts?.test ?? null,
          bun: process.versions.bun ?? null
        })
      ),
      environment: sha(VERIFICATION_ENV_KEYS.map((key) => `${key}=${env[key] ?? '\u0000unset'}`).join('\n'))
    }
    return { digest: sha(JSON.stringify(parts)), parts }
  } catch {
    return null
  }
}

/** Whether any verification input has an uncommitted change; `null` when git could not say. */
export function verificationInputsDirty(repoRoot: string): boolean | null {
  const out = git(repoRoot, ['status', '--porcelain', '--', ...VERIFICATION_INPUT_FILES])
  return out === null ? null : out !== ''
}

/** The last push's summary, if any — the loop's source for its ready-push and re-run Log events. */
export function readLastPushResult(repoRoot: string): LastPushResult | null {
  const text = readJsonUnderGit(repoRoot, LAST_PUSH_RESULT)
  if (!text) return null
  try {
    const value = JSON.parse(text) as LastPushResult
    return value.version === 1 ? value : null
  } catch {
    return null
  }
}
