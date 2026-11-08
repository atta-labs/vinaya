/**
 * Live progress of the pushes, test runs and CI wait a version-2 run waits on: the one module that defines the
 * progress record, the reserved progress directory under the task's run directory, the closed-block rule for Bun's
 * test output, the runner-group lines that limit a native run's count to its scheduled files, and the wording of
 * every progress line the driver log receives.
 *
 * Progress is narration, never authority. Nothing reads a record as evidence that a check, a test or a push passed:
 * no grant, skip, success, Evidence entry or test-run receipt is derived from it. Every writer is best-effort and
 * every failure discards progress without touching the check, push or decision it narrates.
 *
 * **Writers** — the check command (one `check` record per finished check), the pre-push hook's helper (`lint` and
 * `typecheck` records, and a byte copy of the hook's own test-output capture with its start and end records), and the
 * driver's explicit-command run (one `command` record per command, and a copy of a Bun test command's output). Each
 * writer resolves the task's run directory itself: the driver marks the worktree for one push with the task it runs
 * and its own process identity (`PROGRESS_MARKER`, under the worktree's git directory), and a writer accepts that
 * mark only while that driver is alive, then resolves the runtime directory the way every run file does and accepts
 * only `<runtimeDir>/engine-runs/<task>/progress` with no symlinked component. No path is ever read from the
 * environment or from the marker.
 *
 * **Reader** — the progress observer (`push-progress-observer.ts`), a separate process the driver starts before each
 * push or explicit-command run, which tails the directory into the driver log.
 */
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { gitPath } from './pre-push-failed-tests.js'
import {
  identityOf,
  type ProcessIdentity,
  registerProcess,
  stopRegistered
} from '../../../conformance/unit/process-registry.js'
import { runtimeDirForThisRepo } from '../../../run-paths.js'

/** The reserved progress directory's name under the task's run directory. */
export const PROGRESS_DIRNAME = 'progress'

/** The Engine run directories' parent under the runtime directory (`engineRunDirectory`'s own segment). */
export const ENGINE_RUNS_DIRNAME = 'engine-runs'

/** The driver's mark for one push or explicit-command run, under the worktree's git directory. */
export const PROGRESS_MARKER = 'vinaya/push-progress'

/** How long a mark stays valid: longer than the ready push's default deadline. */
export const PROGRESS_MARKER_TTL_MS = 60 * 60 * 1000

/** How often a test run or the CI wait writes its summary line. */
export const PROGRESS_SUMMARY_INTERVAL_MS = 60_000

/** One record, one line of a writer's `.ndjson` file. */
export type ProgressRecord =
  | { v: 1; kind: 'check'; name: string; outcome: CheckProgressOutcome; ms: number }
  | { v: 1; kind: 'tests-start'; stream: string; total: number | null; label: string }
  | { v: 1; kind: 'tests-end'; stream: string }
  | { v: 1; kind: 'commands-start'; count: number }
  | { v: 1; kind: 'command'; command: string; outcome: CommandProgressOutcome; ms: number }

export type CheckProgressOutcome = 'pass' | 'fail' | 'skip' | 'error' | 'timeout'
export type CommandProgressOutcome = 'pass' | 'fail' | 'timeout' | 'reused'

/** The driver's mark: which task the push belongs to, and which live driver asked. */
export type ProgressMarker = { version: 1; task: number; driver: ProcessIdentity; expiresAt: string }

export const progressMarkerText = (marker: Omit<ProgressMarker, 'version'>): string =>
  `${JSON.stringify({ version: 1, ...marker })}\n`

/** A mark of the right shape, or null. */
export function parseProgressMarker(text: string | null): ProgressMarker | null {
  if (!text) return null
  try {
    const value = JSON.parse(text) as Partial<ProgressMarker>
    if (value.version !== 1 || !Number.isInteger(value.task) || (value.task as number) <= 0) return null
    const driver = value.driver
    if (!driver || !Number.isInteger(driver.pid) || driver.pid <= 0 || typeof driver.startTime !== 'string') return null
    if (typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))) return null
    return value as ProgressMarker
  } catch {
    return null
  }
}

/** The reserved progress directory of `task`'s run under `runtimeDir`. */
export function progressDirFor(runtimeDir: string, task: number): string {
  return join(runtimeDir, ENGINE_RUNS_DIRNAME, String(task), PROGRESS_DIRNAME)
}

/** True when `path` exists as a real directory owned by this user, never through a symbolic link. */
function isPlainOwnDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false
    return typeof process.getuid !== 'function' || stat.uid === process.getuid()
  } catch {
    return false
  }
}

/**
 * The reserved progress directory for `task` under `runtimeDir`, or null. The runtime directory is canonicalized
 * (the writer resolved it itself); every component beneath it — the Engine runs folder, the task's run directory and
 * the progress directory — must be a real directory, so a symlinked parent is refused exactly like a symlinked leaf.
 */
export function containedProgressDir(runtimeDir: string, task: number): string | null {
  if (!Number.isInteger(task) || task <= 0) return null
  let root: string
  try {
    root = realpathSync(runtimeDir)
  } catch {
    return null
  }
  const runs = join(root, ENGINE_RUNS_DIRNAME)
  const run = join(runs, String(task))
  const dir = join(run, PROGRESS_DIRNAME)
  return [runs, run, dir].every(isPlainOwnDirectory) ? dir : null
}

export type ResolveProgressDeps = {
  /** The driver's mark under the worktree's git directory. */
  readMarker: () => string | null
  /** The runtime directory, resolved the way every run file resolves it. */
  runtimeDir: () => string
  isDriverAlive: (driver: ProcessIdentity) => boolean
  now: () => number
}

/** The progress directory a writer may write into, or null: no live driver's mark, or no contained directory. */
export function resolveProgressDir(deps: ResolveProgressDeps): string | null {
  try {
    const marker = parseProgressMarker(deps.readMarker())
    if (marker === null) return null
    if (Date.parse(marker.expiresAt) <= deps.now()) return null
    if (!deps.isDriverAlive(marker.driver)) return null
    return containedProgressDir(deps.runtimeDir(), marker.task)
  } catch {
    return null
  }
}

/** The live resolution for a writer running in `cwd` (the hook's worktree). */
export function resolveProgressDirLive(cwd: string): string | null {
  try {
    const markerPath = gitPath(cwd, PROGRESS_MARKER)
    // A push with no driver behind it stops here: it resolves nothing else.
    if (!markerPath || !existsSync(markerPath)) return null
    return resolveProgressDir({
      readMarker: () => readFileSync(markerPath, 'utf8'),
      runtimeDir: () => runtimeDirForThisRepo(),
      isDriverAlive: (driver) => identityOf(driver.pid)?.startTime === driver.startTime,
      now: () => Date.now()
    })
  } catch {
    return null
  }
}

/** Opens `name` in `dir` for appending without following a link; null when it cannot. */
function openForAppend(dir: string, name: string): number | null {
  if (name.includes('/') || name.startsWith('.')) return null
  try {
    const fd = openSync(
      join(dir, name),
      fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
      0o600
    )
    if (!fstatSync(fd).isFile()) {
      closeSync(fd)
      return null
    }
    return fd
  } catch {
    return null
  }
}

/** Appends raw bytes to `name` in `dir`. Never throws; false when nothing was written. */
export function appendProgressBytes(dir: string, name: string, bytes: Uint8Array | string): boolean {
  const fd = openForAppend(dir, name)
  if (fd === null) return false
  try {
    writeSync(fd, typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes)
    return true
  } catch {
    return false
  } finally {
    closeSync(fd)
  }
}

/** Appends one record to `name` (an `.ndjson` file) in `dir`. Never throws. */
export function appendProgressRecord(dir: string, name: string, record: ProgressRecord): boolean {
  return appendProgressBytes(dir, name, `${JSON.stringify(record)}\n`)
}

/** How long the hook's final drain of its test-output capture may take before it stops copying. */
export const FINAL_DRAIN_BOUND_MS = 5000

/** A progress copy's stream name: a plain lowercase word, never a path. */
export const isProgressStreamName = (stream: string): boolean => /^[a-z0-9][a-z0-9-]{0,63}$/.test(stream)

/**
 * Appends the capture's bytes, from the progress copy's current size (the copy is a byte-for-byte prefix of the
 * capture, so its size is the offset) up to the capture's size now, in chunks, until `deadline`. The capture is only
 * read. Returns false once the capture or the copy cannot be read or written.
 */
export function copyCaptureTail(input: {
  capture: string
  dir: string
  stream: string
  deadline: number
  now?: () => number
}): boolean {
  if (!isProgressStreamName(input.stream)) return false
  const now = input.now ?? (() => Date.now())
  let fd: number
  try {
    fd = openSync(input.capture, 'r')
  } catch {
    return false
  }
  try {
    const end = fstatSync(fd).size
    let offset = 0
    try {
      offset = statSync(join(input.dir, `${input.stream}.out`)).size
    } catch {
      offset = 0
    }
    const chunk = Buffer.alloc(64 * 1024)
    while (offset < end && now() < input.deadline) {
      const read = readSync(fd, chunk, 0, Math.min(chunk.length, end - offset), offset)
      if (read <= 0) break
      if (!appendProgressBytes(input.dir, `${input.stream}.out`, chunk.subarray(0, read))) return false
      offset += read
    }
    return true
  } catch {
    return false
  } finally {
    closeSync(fd)
  }
}

/** The record of one finished check, from the runner's outcome. */
export function checkProgressRecord(outcome: { name: string; status: string; durationMs?: number }): ProgressRecord {
  const mapped: CheckProgressOutcome =
    outcome.status === 'pass'
      ? 'pass'
      : outcome.status === 'skipped'
        ? 'skip'
        : outcome.status === 'timeout'
          ? 'timeout'
          : outcome.status === 'error'
            ? 'error'
            : 'fail'
  return { v: 1, kind: 'check', name: outcome.name, outcome: mapped, ms: Math.round(outcome.durationMs ?? 0) }
}

/**
 * The check command's progress writer: for a hook's run (`host` is `hook`) behind a live driver, a function that
 * records each finished check into the reserved directory; null otherwise. Call it before any check starts — the
 * resolution spawns `git` and `ps`.
 */
export function checkProgressWriter(
  host: string | undefined,
  cwd: string
): ((outcome: { name: string; status: string; durationMs?: number }) => void) | null {
  if (host !== 'hook') return null
  const dir = resolveProgressDirLive(cwd)
  if (dir === null) return null
  const file = `checks-${process.pid}.ndjson`
  return (outcome) => {
    appendProgressRecord(dir, file, checkProgressRecord(outcome))
  }
}

/** A record of the right shape, or null. */
export function parseProgressRecord(line: string): ProgressRecord | null {
  try {
    const value = JSON.parse(line) as Partial<ProgressRecord> & Record<string, unknown>
    if (value.v !== 1) return null
    switch (value.kind) {
      case 'check':
        return typeof value.name === 'string' && typeof value.outcome === 'string' && typeof value.ms === 'number'
          ? (value as ProgressRecord)
          : null
      case 'tests-start':
        return typeof value.stream === 'string' && (value.total === null || typeof value.total === 'number')
          ? (value as ProgressRecord)
          : null
      case 'tests-end':
        return typeof value.stream === 'string' ? (value as ProgressRecord) : null
      case 'commands-start':
        return typeof value.count === 'number' ? (value as ProgressRecord) : null
      case 'command':
        return typeof value.command === 'string' && typeof value.outcome === 'string' && typeof value.ms === 'number'
          ? (value as ProgressRecord)
          : null
      default:
        return null
    }
  } catch {
    return null
  }
}

/**
 * The driver's side, before one push or explicit-command run: the progress directory exists empty under the run
 * directory, and the worktree carries the mark naming the task and this driver. Returns the directory, or null when
 * either could not be set up (progress is then off for this push; nothing else changes).
 */
export function beginProgress(input: {
  runDir: string
  task: number
  worktreePath: string
  now?: () => number
}): string | null {
  try {
    const driver = identityOf(process.pid)
    if (driver === null) return null
    mkdirSync(input.runDir, { recursive: true, mode: 0o700 })
    const dir = join(input.runDir, PROGRESS_DIRNAME)
    if (existsSync(dir) || lstatExists(dir)) {
      if (!isPlainOwnDirectory(dir)) return null
      for (const entry of readdirSync(dir)) rmSync(join(dir, entry), { force: true, recursive: true })
    } else {
      mkdirSync(dir, { mode: 0o700 })
    }
    const markerPath = gitPath(input.worktreePath, PROGRESS_MARKER)
    if (!markerPath) return null
    mkdirSync(dirname(markerPath), { recursive: true })
    const now = input.now ?? (() => Date.now())
    writeFileSync(
      markerPath,
      progressMarkerText({
        task: input.task,
        driver,
        expiresAt: new Date(now() + PROGRESS_MARKER_TTL_MS).toISOString()
      }),
      { mode: 0o600 }
    )
    return dir
  } catch {
    return null
  }
}

/** Removes the worktree's mark. Never throws. */
export function endProgress(worktreePath: string): void {
  try {
    const markerPath = gitPath(worktreePath, PROGRESS_MARKER)
    if (markerPath) rmSync(markerPath, { force: true })
  } catch {
    // Progress cleanup never changes the push it narrates.
  }
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Bun output: the closed-block rule
// ---------------------------------------------------------------------------

/** A test file's header line in Bun's output: `<path>.test.<ext>:`. */
const FILE_HEADER = /^(\S.*\.test\.[a-zA-Z]+):$/

/** A line of the batch's closing summary: ` 3 pass`, ` 1 fail`, `Ran 4 tests across 2 files.`. */
const SUMMARY_LINE =
  /^(?:\s*\d+ (?:pass|fail|skip|todo|snapshots?|expect\(\) calls?)\b|Ran \d+ tests? across \d+ files?\.)/

/** The head of Bun's end-of-run failure recap, the same line `pre-push-failed-tests.ts` resets on. */
const FAILURE_RECAP = /^\s*\d+ tests? failed:/

/** A test's result line, with its duration in brackets when Bun printed one. */
const RESULT_LINE = /^\((pass|fail|skip|todo)\) (.*?)(?: \[(\d+(?:\.\d+)?)(ms|s)\])?$/

/** One test file whose block closed, or the open file the stream ended in. */
export type FileProgress =
  | { file: string; outcome: 'pass' | 'fail'; firstFailure: string | null; ms: number }
  | { file: string; outcome: 'interrupted' }

/**
 * Incremental parser of Bun's test output. A file header opens a file's block; the block closes — and only then is
 * the file complete — when the next file header or the batch's summary line arrives. A header followed by a
 * long-running test is therefore not complete, and the end of the stream with a block still open is an interrupted
 * file whose outcome is unknown.
 */
export class BunProgressParser {
  private buffered = ''
  private open: { file: string; failures: string[]; ms: number; unhandled: boolean } | null = null
  private inRecap = false

  /**
   * When set, a header opens a block only when this names it — the scheduled file it names, as the block's file — and
   * any other header-shaped line (one a test prints from an inner fixture run) is skipped: it neither opens nor
   * closes a block.
   */
  accept: ((header: string) => string | null) | null = null

  /** Feeds a chunk; returns every file whose block it closed. */
  feed(chunk: string): FileProgress[] {
    this.buffered += chunk
    const lines = this.buffered.split('\n')
    this.buffered = lines.pop() ?? ''
    const closed: FileProgress[] = []
    for (const raw of lines) this.line(raw.replace(/\r$/, ''), closed)
    return closed
  }

  /** The stream ended: a partial last line is read, and a block still open is interrupted. */
  end(): FileProgress[] {
    const closed: FileProgress[] = []
    if (this.buffered !== '') this.line(this.buffered, closed)
    this.buffered = ''
    if (this.open) closed.push({ file: this.open.file, outcome: 'interrupted' })
    this.open = null
    return closed
  }

  /** Reads one whole line; returns every file whose block it closed. */
  readLine(line: string): FileProgress[] {
    const closed: FileProgress[] = []
    this.line(line, closed)
    return closed
  }

  /** The runner of the open block exited: the block closes as complete. */
  closeOpen(): FileProgress[] {
    const closed: FileProgress[] = []
    this.close(closed)
    this.inRecap = false
    return closed
  }

  private line(line: string, closed: FileProgress[]): void {
    const header = FILE_HEADER.exec(line)
    const file = header?.[1] ? (this.accept ? this.accept(header[1]) : header[1]) : null
    if (file) {
      this.close(closed)
      this.inRecap = false
      this.open = { file, failures: [], ms: 0, unhandled: false }
      return
    }
    if (header?.[1]) return
    // The end-of-run recap (`N tests failed:` then every failing test again) belongs to no file: it closes the open
    // block, and its repeated lines are never counted against the last file.
    if (FAILURE_RECAP.test(line)) {
      this.close(closed)
      this.inRecap = true
      return
    }
    if (SUMMARY_LINE.test(line)) {
      this.close(closed)
      this.inRecap = false
      return
    }
    if (!this.open || this.inRecap) return
    const result = RESULT_LINE.exec(line)
    if (result) {
      if (result[1] === 'fail') this.open.failures.push(result[2] ?? '')
      if (result[3]) this.open.ms += Number(result[3]) * (result[4] === 's' ? 1000 : 1)
      return
    }
    if (/^# Unhandled error between tests/.test(line)) this.open.unhandled = true
  }

  private close(closed: FileProgress[]): void {
    if (!this.open) return
    const failed = this.open.failures.length > 0 || this.open.unhandled
    closed.push({
      file: this.open.file,
      outcome: failed ? 'fail' : 'pass',
      firstFailure: this.open.failures[0] ?? (this.open.unhandled ? 'an unhandled error between tests' : null),
      ms: Math.round(this.open.ms)
    })
    this.open = null
  }
}

/**
 * What a test run has done so far: the 60-second line's inputs. A file of a runner group counts once, by name, and
 * when the group ends its count becomes exactly what the group's report says executed and failed; a file outside any
 * group (an explicit command's output, a stream with no group lines) simply counts.
 */
export class TestRunTally {
  private loose = 0
  private looseFailed = 0
  private readonly groups = new Map<string, { done: Set<string>; failed: Set<string> }>()
  private msSum = 0
  private timed = 0
  constructor(public total: number | null) {}

  /** Adds a closed file; false when it was not counted (interrupted, or a file its group already counted). */
  add(file: FileProgress, group: string | null = null): boolean {
    if (file.outcome === 'interrupted') return false
    if (group !== null) {
      const counted = this.group(group)
      if (counted.done.has(file.file)) return false
      counted.done.add(file.file)
      if (file.outcome === 'fail') counted.failed.add(file.file)
    } else {
      this.loose += 1
      if (file.outcome === 'fail') this.looseFailed += 1
    }
    this.msSum += file.ms
    this.timed += 1
    return true
  }

  /** A group ended: its count is its report's executed and failing files, whatever its output showed. */
  reconcile(group: string, executed: readonly string[], failed: readonly string[]): void {
    this.groups.set(group, { done: new Set(executed), failed: new Set(failed.filter((f) => executed.includes(f))) })
  }

  get done(): number {
    let done = this.loose
    for (const counted of this.groups.values()) done += counted.done.size
    return done
  }

  get failed(): number {
    let failed = this.looseFailed
    for (const counted of this.groups.values()) failed += counted.failed.size
    return failed
  }

  /** The position of the file just added: `N/M` with a known total, `N` otherwise. */
  get position(): string {
    return this.total !== null ? `${this.done}/${this.total}` : `${this.done}`
  }

  get averageMs(): number | null {
    return this.timed === 0 ? null : this.msSum / this.timed
  }

  private group(group: string): { done: Set<string>; failed: Set<string> } {
    let counted = this.groups.get(group)
    if (!counted) {
      counted = { done: new Set(), failed: new Set() }
      this.groups.set(group, counted)
    }
    return counted
  }
}

// ---------------------------------------------------------------------------
// Runner groups: the lines the native group runner prints around each group
// ---------------------------------------------------------------------------

/** The prefix of the line the native group runner prints, when its caller asks, as a runner group starts. */
export const TEST_GROUP_START = 'vinaya-test-group-start '

/** The prefix of the line it prints once that group's report is read. */
export const TEST_GROUP_END = 'vinaya-test-group-end '

/** A group's start: its runner, its working directory and the repository-relative files it was scheduled to run. */
export type TestGroupStart = { group: string; runner: 'bun' | 'vitest'; cwd: string; tests: string[] }

/** A group's end: the scheduled files its report lists as executed, and those it names failing. */
export type TestGroupEnd = { group: string; executed: string[]; failed: string[] }

export const testGroupStartLine = (start: TestGroupStart): string => `${TEST_GROUP_START}${JSON.stringify(start)}`
export const testGroupEndLine = (end: TestGroupEnd): string => `${TEST_GROUP_END}${JSON.stringify(end)}`

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

/** A group line of the right shape, or null. */
export function parseTestGroupLine(
  line: string
): { kind: 'start'; start: TestGroupStart } | { kind: 'end'; end: TestGroupEnd } | null {
  const start = line.startsWith(TEST_GROUP_START)
  if (!start && !line.startsWith(TEST_GROUP_END)) return null
  try {
    const value = JSON.parse(line.slice((start ? TEST_GROUP_START : TEST_GROUP_END).length)) as Record<string, unknown>
    if (typeof value.group !== 'string') return null
    if (start) {
      if ((value.runner !== 'bun' && value.runner !== 'vitest') || typeof value.cwd !== 'string') return null
      return isStrings(value.tests) ? { kind: 'start', start: value as TestGroupStart } : null
    }
    return isStrings(value.executed) && isStrings(value.failed) ? { kind: 'end', end: value as TestGroupEnd } : null
  } catch {
    return null
  }
}

/**
 * The scheduled file of `start` a runner's output line names, as its repository-relative identity, or null: the
 * name as the runner prints it (relative to the group's folder, with or without `./`), the identity itself, or an
 * absolute path ending in it. A name that matches no scheduled file — a header an inner fixture run prints — is null.
 */
export function scheduledFileNamed(start: TestGroupStart, written: string): string | null {
  const slashed = written.replace(/\\/g, '/').replace(/^\.\//, '')
  for (const id of start.tests) {
    const relative = start.cwd === '.' ? id : id.startsWith(`${start.cwd}/`) ? id.slice(start.cwd.length + 1) : null
    if (slashed === id || slashed === relative) return id
    if (slashed.startsWith('/') && slashed.endsWith(`/${id}`)) return id
  }
  return null
}

/** A Vitest default-reporter file line: ` ✓ src/a.test.ts (3 tests) 12ms`, ` ❯ src/b.test.ts (2 tests | 1 failed)`. */
const VITEST_FILE_LINE = /^\s*([✓×❯✗])\s+(?:\|[^|]*\|\s+)?(\S+\.(?:test|spec)\.[a-zA-Z]+)(?=\s|$)(.*)$/

/** One event of a test run's output: a file closed, or a runner group's report reconciled its files. */
export type TestOutputEvent =
  | { kind: 'file'; file: FileProgress; group: string | null }
  | { kind: 'group-end'; end: TestGroupEnd }

/**
 * Incremental parser of a test run's whole output. Without group lines it is the closed-block rule of
 * {@link BunProgressParser}. Once the native group runner prints a group's start, only that group's scheduled files
 * count: a Bun header opens a block only for a scheduled file, and a Vitest file line is a finished file only for
 * one; every other header-shaped line is skipped, and a header outside every group is skipped too. A group's end
 * closes its last block and hands on its report's files.
 */
export class TestOutputParser {
  private readonly bun = new BunProgressParser()
  private buffered = ''
  private group: TestGroupStart | null = null
  private grouped = false

  feed(chunk: string): TestOutputEvent[] {
    this.buffered += chunk
    const lines = this.buffered.split('\n')
    this.buffered = lines.pop() ?? ''
    const events: TestOutputEvent[] = []
    for (const raw of lines) this.line(raw.replace(/\r$/, ''), events)
    return events
  }

  end(): TestOutputEvent[] {
    const events: TestOutputEvent[] = []
    if (this.buffered !== '') this.line(this.buffered, events)
    this.buffered = ''
    for (const file of this.bun.end()) events.push(this.fileEvent(file))
    return events
  }

  private fileEvent(file: FileProgress): TestOutputEvent {
    return { kind: 'file', file, group: this.group?.group ?? null }
  }

  private line(line: string, events: TestOutputEvent[]): void {
    const marker = parseTestGroupLine(line)
    if (marker?.kind === 'start') {
      for (const file of this.bun.closeOpen()) events.push(this.fileEvent(file))
      this.group = marker.start
      this.grouped = true
      const start = marker.start
      this.bun.accept = start.runner === 'bun' ? (header) => scheduledFileNamed(start, header) : () => null
      return
    }
    if (marker?.kind === 'end') {
      for (const file of this.bun.closeOpen()) events.push(this.fileEvent(file))
      events.push({ kind: 'group-end', end: marker.end })
      this.group = null
      this.bun.accept = () => null
      return
    }
    if (this.group?.runner === 'vitest') {
      const vitest = VITEST_FILE_LINE.exec(line)
      const file = vitest?.[2] ? scheduledFileNamed(this.group, vitest[2]) : null
      if (vitest && file) {
        const ms = /(\d+(?:\.\d+)?)\s*ms\s*$/.exec(vitest[3] ?? '')
        const failed = vitest[1] !== '✓'
        events.push(
          this.fileEvent({
            file,
            outcome: failed ? 'fail' : 'pass',
            firstFailure: null,
            ms: ms ? Math.round(Number(ms[1])) : 0
          })
        )
      }
      return
    }
    if (this.grouped && this.group === null) return
    for (const file of this.bun.readLine(line)) events.push(this.fileEvent(file))
  }
}

// ---------------------------------------------------------------------------
// Wording: every progress line the driver log receives
// ---------------------------------------------------------------------------

/**
 * A name from a test run, a check or a command as one plain line: every C0 and C1 control character (an escape
 * sequence's introducer, a carriage return, a newline) becomes a space, so nothing a test or a check names can drive
 * the terminal that follows the driver log or split one record into two.
 */
export function plainText(text: string): string {
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? ' ' : char
  }
  return out
}

/** `850 ms`, `12.3 s`, `4 min 05 s`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)} min ${String(total % 60).padStart(2, '0')} s`
}

const CHECK_MARK: Record<CheckProgressOutcome, string> = {
  pass: '✓',
  fail: '✗',
  skip: 'skipped',
  error: '✗ error',
  timeout: '✗ timed out'
}

/** One local check finished. */
export function checkLine(name: string, outcome: CheckProgressOutcome, ms: number): string {
  return `push progress: check ${plainText(name)} ${CHECK_MARK[outcome] ?? plainText(outcome)}, ${formatDuration(ms)}`
}

/** One test file closed (or the stream ended inside it). */
export function testFileLine(file: FileProgress, position: string | null): string {
  const name = plainText(file.file)
  if (file.outcome === 'interrupted') return `test progress: ${name} interrupted — outcome unknown`
  const at = position !== null ? `${position} ` : ''
  const failure =
    file.outcome === 'fail' && file.firstFailure ? ` — first failing test: ${plainText(file.firstFailure)}` : ''
  return `test progress: ${at}${name} ${file.outcome === 'pass' ? '✓' : '✗'}, ${formatDuration(file.ms)}${failure}`
}

/**
 * The 60-second line of a test run: files done (of the total when known), failures so far, the average per file and,
 * only with a known total, the estimated time left for the files left. It never names a current file.
 */
export function testSummaryLine(tally: TestRunTally): string {
  const done = tally.total !== null ? `${tally.done}/${tally.total} files done` : `${tally.done} files done`
  const average = tally.averageMs
  const avg = average === null ? 'no file finished yet' : `${(average / 1000).toFixed(1)} s per file`
  let left = ''
  if (tally.total !== null) {
    const remaining = Math.max(0, tally.total - tally.done)
    left =
      average === null
        ? `, ${remaining} files left`
        : `, about ${formatDuration(average * remaining)} left for ${remaining} files`
  }
  return `test progress: ${done}, ${tally.failed} failing, ${avg}${left}`
}

/** The explicit-command run starts. */
export function commandsStartLine(count: number): string {
  return `ready push: running ${count} explicit Test Plan command${count === 1 ? '' : 's'}`
}

const COMMAND_MARK: Record<CommandProgressOutcome, string> = {
  pass: '✓',
  fail: '✗',
  timeout: '✗ timed out',
  reused: '✓ receipt reused'
}

/** One explicit command finished. */
export function commandLine(command: string, outcome: CommandProgressOutcome, ms: number): string {
  return `command progress: ${COMMAND_MARK[outcome] ?? plainText(outcome)}, ${formatDuration(ms)}: ${plainText(command)}`
}

/** One CI job completed. */
export function ciJobLine(job: {
  name: string
  ok: boolean
  ms: number | null
  firstFailure?: { file: string | null; test: string } | null
}): string {
  const failure =
    !job.ok && job.firstFailure
      ? ` — first failing test: ${job.firstFailure.file ? `${plainText(job.firstFailure.file)}: ` : ''}${plainText(job.firstFailure.test)}`
      : ''
  return `CI progress: ${plainText(job.name)} ${job.ok ? '✓' : '✗'}, ${job.ms === null ? 'duration unknown' : formatDuration(job.ms)}${failure}`
}

/** A state the strict CI read reached. */
export function ciStateLine(
  state:
    | { kind: 'queued-without-runner'; job: string; minutes: number }
    | { kind: 'first-red'; job: string }
    | { kind: 'infrastructure-pause'; detail: string }
    | { kind: 'poll-budget'; detail: string }
    | { kind: 'execution-ceiling'; detail: string }
): string {
  switch (state.kind) {
    case 'queued-without-runner':
      return `CI progress: ${plainText(state.job)} queued ${state.minutes} min without a runner`
    case 'first-red':
      return `CI progress: first red job: ${plainText(state.job)}`
    case 'infrastructure-pause':
      return `CI progress: paused for an infrastructure failure: ${plainText(state.detail)}`
    case 'poll-budget':
      return `CI progress: still pending when the poll budget ran out: ${plainText(state.detail)}`
    case 'execution-ceiling':
      return `CI progress: execution ceiling reached: ${plainText(state.detail)}`
  }
}

/** The CI wait's 60-second line. */
export function ciSummaryLine(input: { done: number; total: number; failed: number; elapsedMs: number }): string {
  return `CI progress: ${input.done}/${input.total} jobs done, ${input.failed} failing, ${formatDuration(input.elapsedMs)} elapsed`
}

/** The first failing test in a Bun output excerpt (`<file>.test.<ext>:` … `(fail) <name>`), or null. */
export function firstFailingTest(excerpt: string): { file: string | null; test: string } | null {
  let file: string | null = null
  for (const line of excerpt.split('\n')) {
    const stripped = line.replace(/^\S+T\d\d:\d\d:\d\d(?:\.\d+)?Z /, '').trim()
    const header = FILE_HEADER.exec(stripped)
    if (header?.[1]) {
      file = header[1]
      continue
    }
    const fail = /^\(fail\) (.*?)(?: \[\d+(?:\.\d+)?m?s\])?$/.exec(stripped)
    if (fail?.[1]) return { file, test: fail[1] }
  }
  return null
}

/** True for a command that runs Bun's test runner: its output is read per file under the closed-block rule. */
export const isBunTestCommand = (command: string): boolean => /(?:^|[\s;&|(])bun\s+test(?:\s|$)/.test(command)

// ---------------------------------------------------------------------------
// The observer process: started and stopped by the driver
// ---------------------------------------------------------------------------

/** How long the observer may take to start and be registered before progress is given up for the push. */
export const OBSERVER_STARTUP_BOUND_MS = 5000

/** How long the observer gets between TERM (its final drain) and KILL. */
export const OBSERVER_SHUTDOWN_GRACE_MS = 2000

/** The longest the whole stop may take, KILL included; past it the driver goes on without waiting. */
export const OBSERVER_SHUTDOWN_BOUND_MS = 6000

export type ProgressObserverHandle = { stop: () => Promise<void> }

const NO_OBSERVER: ProgressObserverHandle = { stop: async () => {} }

function withinBound<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms)
  })
  return Promise.race([work, bound]).finally(() => clearTimeout(timer))
}

/**
 * Starts the progress observer for one push or explicit-command run: a separate process, in its own process group,
 * registered under a registry token of its own (never the ready gate's), which tails `dir` into the driver log at
 * `logPath` and exits by itself once this driver is gone. Startup and registration are bounded; any failure kills
 * what started (after checking it is still the same process) and returns a handle that does nothing — progress is
 * off for the push, and nothing else changes. `stop` ends only the observer's own token, bounded, and never throws.
 */
export async function startProgressObserver(input: {
  dir: string
  logPath: string
  /** How to start the observer program — the caller names it; the kernel names no program of its own. */
  entry: { command: string; args: string[] }
  registryDir?: string
  register?: typeof registerProcess
  stopRegistered?: typeof stopRegistered
  startupBoundMs?: number
  shutdownGraceMs?: number
  shutdownBoundMs?: number
}): Promise<ProgressObserverHandle> {
  let pid: number | undefined
  try {
    const entry = input.entry
    const child = spawn(entry.command, [...entry.args, input.dir, input.logPath, String(process.pid)], {
      detached: true,
      stdio: 'ignore'
    })
    child.on('error', () => {})
    child.unref()
    pid = child.pid
  } catch {
    return NO_OBSERVER
  }
  if (pid === undefined) return NO_OBSERVER
  const registry = input.registryDir ? { dir: input.registryDir } : {}
  const runToken = `push-progress-${randomUUID()}`
  const identity = identityOf(pid)
  try {
    if (identity === null) throw new Error('the progress observer exited before it was registered')
    await withinBound(
      (input.register ?? registerProcess)(
        { ...identity, runToken, label: 'push progress observer', processGroup: true },
        registry
      ),
      input.startupBoundMs ?? OBSERVER_STARTUP_BOUND_MS,
      'registering the progress observer'
    )
  } catch {
    if (identity !== null && identityOf(identity.pid)?.startTime === identity.startTime) {
      try {
        process.kill(-identity.pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
    return NO_OBSERVER
  }
  return {
    stop: async () => {
      try {
        await withinBound(
          (input.stopRegistered ?? stopRegistered)(runToken, {
            graceMs: input.shutdownGraceMs ?? OBSERVER_SHUTDOWN_GRACE_MS,
            ...registry
          }),
          input.shutdownBoundMs ?? OBSERVER_SHUTDOWN_BOUND_MS,
          'stopping the progress observer'
        )
      } catch {
        // Stopping progress never changes the push it narrated.
      }
    }
  }
}

/**
 * The driver's whole progress session around one push or explicit-command run: the directory and the worktree's
 * mark, then the observer. `end` stops the observer and removes the mark; neither ever throws. With no usable
 * directory nothing starts.
 */
export async function beginProgressSession(input: {
  runDir: string
  task: number
  worktreePath: string
  logPath: string
  observer: Omit<Parameters<typeof startProgressObserver>[0], 'dir' | 'logPath'>
}): Promise<{ dir: string | null; end: () => Promise<void> }> {
  const dir = beginProgress(input)
  if (dir === null) return { dir: null, end: async () => endProgress(input.worktreePath) }
  const observer = await startProgressObserver({ dir, logPath: input.logPath, ...input.observer })
  return {
    dir,
    end: async () => {
      await observer.stop()
      endProgress(input.worktreePath)
    }
  }
}

// ---------------------------------------------------------------------------
// The reader: the progress directory into driver-log lines
// ---------------------------------------------------------------------------

type StreamState = {
  parser: TestOutputParser
  tally: TestRunTally
  ended: boolean
  lastSummaryAt: number
}

/**
 * Reads the progress directory into lines: each finished check, command and closed test file once, as it appears,
 * and a test run's 60-second line while the run is open. Files are read without following a link, from the offset
 * already read; a stream's end record reads its copy (`.out`) to the end before it ends the stream, so no closed file
 * is lost to the order of two writes.
 */
export class ProgressReader {
  private readonly offsets = new Map<string, number>()
  private readonly partial = new Map<string, string>()
  private readonly streams = new Map<string, StreamState>()

  constructor(
    private readonly dir: string,
    private readonly write: (line: string) => void,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** One pass over the directory. */
  scan(): void {
    let names: string[]
    try {
      names = readdirSync(this.dir).sort()
    } catch {
      return
    }
    // Records first, so a copy's start (its total) is known before its first file; an end record reads its copy to
    // the end itself.
    for (const name of names) if (name.endsWith('.ndjson')) this.readRecords(name)
    for (const name of names) if (name.endsWith('.out')) this.readCopy(name.slice(0, -'.out'.length))
  }

  /** The 60-second line of every open test run whose last line is a minute old. */
  tick(): void {
    const now = this.now()
    for (const state of this.streams.values()) {
      if (state.ended || now - state.lastSummaryAt < PROGRESS_SUMMARY_INTERVAL_MS) continue
      state.lastSummaryAt = now
      this.emit(testSummaryLine(state.tally))
    }
  }

  /** The reader stops: a last scan, and every copy still open ends with its open file interrupted. */
  close(): void {
    this.scan()
    for (const stream of this.streams.keys()) this.endStream(stream)
  }

  private emit(line: string): void {
    try {
      this.write(line)
    } catch {
      // A line that cannot be written is dropped.
    }
  }

  private stream(stream: string, total: number | null = null): StreamState {
    let state = this.streams.get(stream)
    if (!state) {
      state = {
        parser: new TestOutputParser(),
        tally: new TestRunTally(total),
        ended: false,
        lastSummaryAt: this.now()
      }
      this.streams.set(stream, state)
    }
    return state
  }

  private readNew(name: string): string {
    const offset = this.offsets.get(name) ?? 0
    let fd: number
    try {
      fd = openSync(join(this.dir, name), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    } catch {
      return ''
    }
    try {
      if (!fstatSync(fd).isFile()) return ''
      const size = fstatSync(fd).size
      if (size <= offset) return ''
      const buffer = Buffer.alloc(size - offset)
      const read = readSync(fd, buffer, 0, buffer.length, offset)
      this.offsets.set(name, offset + read)
      return buffer.subarray(0, read).toString('utf8')
    } catch {
      return ''
    } finally {
      closeSync(fd)
    }
  }

  private readCopy(stream: string): void {
    if (!isProgressStreamName(stream)) return
    const state = this.stream(stream)
    if (state.ended) return
    const text = this.readNew(`${stream}.out`)
    if (text === '') return
    for (const event of state.parser.feed(text)) this.outputEvent(state, event)
  }

  private outputEvent(state: StreamState, event: TestOutputEvent): void {
    if (event.kind === 'group-end') {
      state.tally.reconcile(event.end.group, event.end.executed, event.end.failed)
      return
    }
    const { file, group } = event
    if (file.outcome === 'interrupted') this.emit(testFileLine(file, null))
    else if (state.tally.add(file, group)) this.emit(testFileLine(file, state.tally.position))
  }

  private endStream(stream: string): void {
    const state = this.stream(stream)
    if (state.ended) return
    this.readCopy(stream)
    for (const event of state.parser.end()) this.outputEvent(state, event)
    state.ended = true
  }

  private readRecords(name: string): void {
    const text = (this.partial.get(name) ?? '') + this.readNew(name)
    const lines = text.split('\n')
    this.partial.set(name, lines.pop() ?? '')
    for (const line of lines) {
      const record = line.trim() === '' ? null : parseProgressRecord(line)
      if (record) this.record(record)
    }
  }

  private record(record: ProgressRecord): void {
    switch (record.kind) {
      case 'check':
        this.emit(checkLine(record.name, record.outcome, record.ms))
        return
      case 'tests-start': {
        if (!isProgressStreamName(record.stream)) return
        const state = this.stream(record.stream, record.total)
        if (state.tally.total === null) state.tally.total = record.total
        return
      }
      case 'tests-end':
        if (isProgressStreamName(record.stream)) this.endStream(record.stream)
        return
      case 'commands-start':
        this.emit(commandsStartLine(record.count))
        return
      case 'command':
        this.emit(commandLine(record.command, record.outcome, record.ms))
        return
    }
  }
}
