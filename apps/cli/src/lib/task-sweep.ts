/**
 * `vinaya task sweep` (`commands/task-sweep.ts`) and the driver's own
 * start-of-run call (`dev-review-loop.ts`) — the one function that decides
 * whether a task's folder under `<runtimeDir>/tasks-execution/` still
 * earns its place on disk, and removes it when it doesn't.
 *
 * A task folder is `finished` — safe to remove — only once the forge itself
 * says so: its Issue is closed, or its pull request is merged or closed.
 * Everything else is kept: an open pull request, a live driver (checked
 * FIRST, and absolutely — nothing overrides it), a pause still awaiting a
 * decision, or a state this process could not read at all. Deleting is
 * irreversible (Traps to avoid), so every branch that cannot prove
 * `finished` falls back to keeping the folder and saying why, never to
 * guessing.
 *
 * `sweepLegacyLayout` is the second half (O3): the eight top-level
 * directories an earlier layout (or, for `drivers`, an operator's own hand)
 * left behind under the machine's Vinaya home (`run-paths.ts`'s
 * `LEGACY_TOP_LEVEL_DIRNAMES` — the only other file allowed to name them,
 * `run-paths-only.test.ts`), plus the one nested exception —
 * `outbox/dev-review-loop/<task>/`, O3's "outbox task folders" — living
 * inside the telemetry outbox root itself
 * (`run-paths.ts`'s `legacyOutboxTaskFoldersRoot`). Most of these carry no
 * repository segment at all, so an entry is attributed to THIS repository
 * only when its own path or its own record content names it — never
 * guessed from a bare task number, which repeats across repositories.
 */

import { execFileSync } from 'node:child_process'
import { lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join, sep, resolve as resolvePath } from 'node:path'
import {
  developerBranchFor as realDeveloperBranchFor,
  fetchPrBody as realFetchPrBody,
  taskFromPrBody as realTaskFromPrBody
} from './dev-review-loop/developer-dispatch.js'
import { isDriverPidAlive as realIsDriverPidAlive } from './dev-review-loop/pause-resume.js'
import { GLOBAL_VINAYA_HOME } from './config.js'
import {
  DRIVER_LOCK_FILENAME,
  LEGACY_CONTROL_STORE,
  LEGACY_DISPATCH_RESUME,
  LEGACY_DRIVERS,
  LEGACY_LOOPS,
  LEGACY_TASK_RESUME,
  LEGACY_TOP_LEVEL_DIRNAMES,
  type LegacyTopLevelDirname,
  legacyOutboxTaskFoldersRoot,
  legacyTopLevelDir,
  repoSegment,
  resolveRepoSync,
  runPath,
  runtimeDirForThisRepo,
  type RunScope,
  scopeFromSegment,
  tasksExecutionRoot
} from './run-paths.js'

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

// --- forge reads (this module's own, scoped to what classification needs) --

export type IssueState = 'OPEN' | 'CLOSED'
export type PrState = 'OPEN' | 'MERGED' | 'CLOSED'
export type PrLookup = { number: number; state: PrState }

/** Throws on any read failure — the caller reads that as "forge unreadable," never as a fabricated state. */
export function fetchIssueState(issue: number): IssueState {
  const out = sh('gh', ['issue', 'view', String(issue), '--json', 'state'])
  return (JSON.parse(out) as { state: IssueState }).state
}

/** `null` when no pull request (of any state) has ever had `branch` as its head — a real, distinguishable answer from a read failure, which throws instead. `--state all` is deliberate: an OPEN-only lookup could never observe MERGED/CLOSED, the two states that decide `finished`. */
export function fetchPrForBranch(branch: string): PrLookup | null {
  const out = sh('gh', ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state,headRefName'])
  const list = JSON.parse(out) as { number: number; state: PrState; headRefName: string }[]
  const found = list.find((p) => p.headRefName === branch)
  return found ? { number: found.number, state: found.state } : null
}

// --- classification ---------------------------------------------------------

export type TaskFolderClass =
  | { kind: 'finished'; reason: string }
  | { kind: 'open'; reason: string }
  | { kind: 'paused'; reason: string }
  | { kind: 'live'; reason: string }
  | { kind: 'unknown'; reason: string }

type DriverLockRecord = { pid: number; startedAt: string }
type PauseStateRecord = { reason: string }

export type TaskSweepDeps = {
  runtimeDir: () => string
  isDriverPidAlive: (pid: number) => boolean
  readDriverLockForScope: (root: string, scope: RunScope) => DriverLockRecord | null
  readPauseStateForScope: (root: string, scope: RunScope) => PauseStateRecord | null
  fetchIssueState: (issue: number) => IssueState
  developerBranchFor: (issue: number) => string
  fetchPrForBranch: (branch: string) => PrLookup | null
  fetchPrBody: (pr: number) => string
  taskFromPrBody: (body: string) => number | null
  rm: (path: string) => void
  resolveRepo: () => { owner: string; repo: string } | null
  /** True iff `sha` resolves to a real commit in THIS repository's own local object database — a pure, local, network-free identity check (`git cat-file -e <sha>^{commit}`) used to attribute a bare-task legacy record that carries a judged head but no branch/PR reference of its own. */
  commitExistsInThisRepo: (sha: string) => boolean
}

function readDriverLockForScope(root: string, scope: RunScope): DriverLockRecord | null {
  const raw = readIfExists(runPath(root, scope, { area: 'task', file: DRIVER_LOCK_FILENAME }))
  if (!raw) return null
  try {
    return JSON.parse(raw) as DriverLockRecord
  } catch {
    return null
  }
}

function readPauseStateForScope(root: string, scope: RunScope): PauseStateRecord | null {
  const raw = readIfExists(runPath(root, scope, { area: 'control', file: 'pause-state.json' }))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { reason?: unknown }
    return typeof parsed.reason === 'string' ? { reason: parsed.reason } : null
  } catch {
    return null
  }
}

function commitExistsInThisRepo(sha: string): boolean {
  try {
    sh('git', ['cat-file', '-e', `${sha}^{commit}`])
    return true
  } catch {
    return false
  }
}

export const defaultTaskSweepDeps: TaskSweepDeps = {
  runtimeDir: runtimeDirForThisRepo,
  isDriverPidAlive: realIsDriverPidAlive,
  readDriverLockForScope,
  readPauseStateForScope,
  fetchIssueState,
  developerBranchFor: realDeveloperBranchFor,
  fetchPrForBranch,
  fetchPrBody: realFetchPrBody,
  taskFromPrBody: realTaskFromPrBody,
  rm: (path) => rmSync(path, { recursive: true, force: true }),
  resolveRepo: resolveRepoSync,
  commitExistsInThisRepo
}

/**
 * The task Issue number this scope's classification runs against — `null`
 * when there genuinely is none to resolve (an `unscoped` dispatch, or a
 * `{pr}` scope whose body carries no `Closes #N`) or when reading it failed
 * (a `{pr}` scope whose body could not be fetched at all). The caller reads
 * `null` alongside the reason it was returned with, since the two failure
 * shapes above both mean "cannot classify," never "finished."
 */
function resolveIssueForScope(scope: RunScope, deps: TaskSweepDeps): { issue: number | null; reason?: string } {
  if (typeof scope === 'number') return { issue: scope }
  if (scope === 'unscoped') {
    return { issue: null, reason: 'unscoped dispatch folder — no Issue or PR to check against the forge' }
  }
  let body: string
  try {
    body = deps.fetchPrBody(scope.pr)
  } catch (err) {
    return { issue: null, reason: `could not read PR #${scope.pr}'s body to resolve its task: ${message(err)}` }
  }
  const issue = deps.taskFromPrBody(body)
  if (issue === null) {
    return {
      issue: null,
      reason: `PR #${scope.pr}'s body carries no \`Closes #N\` reference — cannot resolve its task`
    }
  }
  return { issue }
}

/**
 * O1/O4 — the entire keep-policy. A live driver wins outright, checked
 * before any forge read (Traps to avoid: "never remove a folder whose
 * driver lock names a live process"). Only then does a forge read decide
 * `finished` (Issue closed, or its pull request merged/closed) versus
 * `open`/`paused`; any read failure, or a scope with nothing to check
 * against the forge at all, is `unknown` — kept, and said so, never
 * removed (O1: "removes nothing when the forge cannot be read").
 */
export function classifyTaskFolder(
  scope: RunScope,
  root: string,
  deps: TaskSweepDeps = defaultTaskSweepDeps
): TaskFolderClass {
  const lock = deps.readDriverLockForScope(root, scope)
  if (lock && deps.isDriverPidAlive(lock.pid)) {
    return { kind: 'live', reason: `driver lock names live pid ${lock.pid} (started ${lock.startedAt})` }
  }

  const resolved = resolveIssueForScope(scope, deps)
  if (resolved.issue === null)
    return { kind: 'unknown', reason: resolved.reason ?? 'could not resolve a task to check' }
  const issue = resolved.issue

  let issueState: IssueState
  try {
    issueState = deps.fetchIssueState(issue)
  } catch (err) {
    return { kind: 'unknown', reason: `could not read Issue #${issue}'s state from the forge: ${message(err)}` }
  }
  if (issueState === 'CLOSED') return { kind: 'finished', reason: `Issue #${issue} is closed` }

  let branch: string
  try {
    branch = deps.developerBranchFor(issue)
  } catch (err) {
    return { kind: 'unknown', reason: `could not derive Issue #${issue}'s developer branch: ${message(err)}` }
  }

  let pr: PrLookup | null
  try {
    pr = deps.fetchPrForBranch(branch)
  } catch (err) {
    return { kind: 'unknown', reason: `could not read the pull request for branch \`${branch}\`: ${message(err)}` }
  }

  if (pr && pr.state !== 'OPEN') {
    return { kind: 'finished', reason: `Issue #${issue} is open but PR #${pr.number} is ${pr.state.toLowerCase()}` }
  }

  const pause = deps.readPauseStateForScope(root, scope)
  if (pause) {
    return {
      kind: 'paused',
      reason: `paused (${pause.reason})${pr ? `, PR #${pr.number} open` : ', no pull request yet'}`
    }
  }

  return pr
    ? { kind: 'open', reason: `Issue #${issue} open, PR #${pr.number} open` }
    : { kind: 'open', reason: `Issue #${issue} open, no pull request yet` }
}

// --- removal safety (Traps to avoid) ----------------------------------------

/** Refuses a path outside `root`, and a path that is itself a symlink — the two guards the Traps demand ("refuse anything that resolves outside the run directory and never follow a symlink"). `path.resolve` is lexical only (it never dereferences the filesystem), so this check is safe to run before ever touching the real path. */
function assertSafeToRemove(target: string, root: string): void {
  const resolvedRoot = resolvePath(root)
  const resolvedTarget = resolvePath(target)
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`refusing to remove ${target} — it does not resolve inside ${root}`)
  }
  try {
    if (lstatSync(target).isSymbolicLink()) {
      throw new Error(`refusing to remove ${target} — it is a symlink, never followed or removed as a directory`)
    }
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
}

// --- modern-layout sweep (Part 1/2, O1) -------------------------------------

export type SweepEntry = { folder: string; reason: string }
export type SweepReport = { removed: SweepEntry[]; kept: SweepEntry[] }

function describeScope(scope: RunScope): string {
  if (scope === 'unscoped') return 'unscoped'
  if (typeof scope === 'number') return `Issue #${scope}`
  return `PR #${scope.pr}`
}

/** O1/O2 — the entire sweep of the current, unified layout: every folder under `tasksExecutionRoot`, classified and removed iff `finished`. `excludeScope` is the driver's own guard against sweeping the very task it is about to run (`dev-review-loop.ts`) — never dropped by a standalone `task sweep` invocation, which has none. */
export function sweepModernTasks(deps: TaskSweepDeps = defaultTaskSweepDeps, excludeScope?: RunScope): SweepReport {
  const root = deps.runtimeDir()
  let names: string[]
  try {
    names = readdirSync(tasksExecutionRoot(root))
  } catch {
    return { removed: [], kept: [] }
  }

  const removed: SweepEntry[] = []
  const kept: SweepEntry[] = []
  for (const name of names) {
    const scope = scopeFromSegment(name)
    const label = describeScope(scope)
    if (excludeScope !== undefined && scopesEqual(scope, excludeScope)) {
      kept.push({ folder: label, reason: 'this run’s own task — never swept by its own driver' })
      continue
    }
    const folderPath = runPath(root, scope, { area: 'task' })
    const cls = classifyTaskFolder(scope, root, deps)
    if (cls.kind === 'finished') {
      try {
        assertSafeToRemove(folderPath, root)
        deps.rm(folderPath)
        removed.push({ folder: label, reason: cls.reason })
      } catch (err) {
        kept.push({ folder: label, reason: `finished (${cls.reason}) but could not be removed: ${message(err)}` })
      }
    } else {
      kept.push({ folder: label, reason: `${cls.kind} — ${cls.reason}` })
    }
  }
  return { removed, kept }
}

function scopesEqual(a: RunScope, b: RunScope): boolean {
  if (a === 'unscoped' || b === 'unscoped') return a === b
  if (typeof a === 'number' || typeof b === 'number') return a === b
  return a.pr === b.pr
}

// --- earlier-layout listing and attribution (Part 4, O3) -------------------

export type LegacyAttribution =
  | { kind: 'this-repo'; scope: RunScope }
  | { kind: 'other-repo' }
  | { kind: 'unattributable'; reason: string }

export type LegacyEntry = {
  /** One of `LEGACY_TOP_LEVEL_DIRNAMES`, or `LEGACY_OUTBOX_TASK_FOLDERS_LABEL` for O3's own "outbox task folders" category — the one tree nested inside `outbox/` rather than sitting directly under the home. */
  dirname: LegacyTopLevelDirname | typeof LEGACY_OUTBOX_TASK_FOLDERS_LABEL
  path: string
  attribution: LegacyAttribution
  class?: TaskFolderClass
  removed: boolean
}

export type LegacyReport = { entries: LegacyEntry[] }

/** A `manifest/*.json` record under a legacy task folder is the one place a bare, repository-less task folder ever stated its own repository OUTRIGHT (`ManifestRecordIdentity.repository`, `owner/repo`) — checked first, and authoritative when present: this is a fact the record itself asserts, never a match this function goes on to infer. */
function manifestRepositoryFor(taskDir: string): string | null {
  let files: string[]
  try {
    files = readdirSync(join(taskDir, 'manifest'))
  } catch {
    return null
  }
  for (const file of files) {
    const raw = readIfExists(join(taskDir, 'manifest', file))
    if (!raw) continue
    try {
      const parsed = JSON.parse(raw) as { repository?: unknown }
      if (typeof parsed.repository === 'string') return parsed.repository
    } catch {
      // Not a record this reads — keep looking at the rest.
    }
  }
  return null
}

/** `pause-state.json`'s own `branch`/`prNumber` (the `outbox/dev-review-loop/<task>/` shape), or `escalation/*.json`'s own `branch`/`pr` (the `control-store/<task>/` shape) — the two record shapes this codebase's history actually wrote a branch+PR reference into, read the same way. */
function branchAndPrFrom(raw: string): { branch: string; pr: number } | null {
  try {
    const parsed = JSON.parse(raw) as { branch?: unknown; prNumber?: unknown; pr?: unknown }
    const branch = typeof parsed.branch === 'string' ? parsed.branch : null
    const pr = typeof parsed.prNumber === 'number' ? parsed.prNumber : typeof parsed.pr === 'number' ? parsed.pr : null
    return branch && pr !== null && pr > 0 ? { branch, pr } : null
  } catch {
    return null
  }
}

const JUDGED_HEAD_RE = /^Judged head: ([0-9a-f]{7,40})$/m

function unattributable(reason: string): LegacyAttribution {
  return { kind: 'unattributable', reason }
}

/**
 * A bare, repository-less task folder — `control-store/<task>/` or
 * `outbox/dev-review-loop/<task>/` — is attributed to this repository only
 * through its own records naming it, tried in order from strongest to
 * weakest: a manifest's explicit `repository` field (authoritative, both
 * directions); failing that, a `branch`+PR pair (`pause-state.json`, or any
 * `escalation/*.json`) verified against a REAL pull request this repository
 * itself has on that exact branch and number; failing that, a held round
 * verdict's own `Judged head:` sha, verified as a real commit in this
 * repository's own local history. The last two are positive-only signals —
 * absence never asserts `other-repo`, only `unattributable` — since a
 * missing PR or an unresolvable sha could equally mean "gone", not
 * "elsewhere."
 */
function attributeBareTaskFolder(
  taskDir: string,
  task: number,
  currentRepo: string | null,
  deps: TaskSweepDeps
): LegacyAttribution {
  if (currentRepo === null) {
    return unattributable('this repository could not be resolved to compare against')
  }

  const manifestRepo = manifestRepositoryFor(taskDir)
  if (manifestRepo !== null) {
    return manifestRepo === currentRepo ? { kind: 'this-repo', scope: task } : { kind: 'other-repo' }
  }

  const candidateRecords: string[] = []
  const pauseState = readIfExists(join(taskDir, 'pause-state.json'))
  if (pauseState) candidateRecords.push(pauseState)
  try {
    for (const name of readdirSync(join(taskDir, 'escalation'))) {
      const raw = readIfExists(join(taskDir, 'escalation', name))
      if (raw) candidateRecords.push(raw)
    }
  } catch {
    // No escalation/ subdirectory here — nothing more to add.
  }
  for (const raw of candidateRecords) {
    const found = branchAndPrFrom(raw)
    if (!found) continue
    try {
      const pr = deps.fetchPrForBranch(found.branch)
      if (pr && pr.number === found.pr) return { kind: 'this-repo', scope: task }
    } catch {
      // Forge unreadable for this record — try the next one, or the round-verdict fallback below.
    }
  }

  let entries: string[]
  try {
    entries = readdirSync(taskDir)
  } catch {
    entries = []
  }
  for (const name of entries) {
    if (!/^round-\d+-(?:reviewer|security)\.md$/.test(name)) continue
    const text = readIfExists(join(taskDir, name))
    const headMatch = text ? JUDGED_HEAD_RE.exec(text) : null
    if (headMatch?.[1] && deps.commitExistsInThisRepo(headMatch[1])) return { kind: 'this-repo', scope: task }
  }

  return unattributable('no manifest record, pause/escalation record, or round verdict names a repository')
}

const LOOPS_LOG_RE = /^(\d+)\.log$/
const DISPATCH_RESUME_RE = /-(issue(\d+)|pr(\d+)|unscoped)\.json$/
const TASK_RESUME_ESCALATION_RE = /^(\d+)-\d+-.+\.json$/

function currentRepoSegment(deps: TaskSweepDeps): { full: string | null; segment: string } {
  const repo = deps.resolveRepo()
  return { full: repo ? `${repo.owner}/${repo.repo}` : null, segment: repoSegment(repo) }
}

/**
 * O3 — every earlier-layout entry, attributed where its own path or its own
 * records name this repository, `unattributable` everywhere else (never
 * guessed). `removeAttributed` (`--include-legacy`) removes only the
 * entries this pass could both attribute to this repository AND classify
 * `finished` — every other entry, attributable or not, is only ever
 * reported.
 */
export function sweepLegacyLayout(
  removeAttributed: boolean,
  deps: TaskSweepDeps = defaultTaskSweepDeps,
  home: string = GLOBAL_VINAYA_HOME
): LegacyReport {
  const root = deps.runtimeDir()
  const repo = currentRepoSegment(deps)
  const entries: LegacyEntry[] = []

  for (const dirname of LEGACY_TOP_LEVEL_DIRNAMES) {
    const dir = legacyTopLevelDir(home, dirname)
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    if (dirname === LEGACY_CONTROL_STORE) {
      for (const name of names) {
        if (!/^\d+$/.test(name)) continue
        const task = Number(name)
        const attribution = attributeBareTaskFolder(join(dir, name), task, repo.full, deps)
        entries.push(buildLegacyEntry(dirname, join(dir, name), attribution, root, deps, removeAttributed, home))
      }
    } else if (dirname === LEGACY_LOOPS) {
      for (const repoDirName of names) {
        const repoDir = join(dir, repoDirName)
        let logNames: string[]
        try {
          logNames = readdirSync(repoDir)
        } catch {
          continue
        }
        for (const logName of logNames) {
          const m = LOOPS_LOG_RE.exec(logName)
          const attribution: LegacyAttribution =
            m && repoDirName === repo.segment
              ? { kind: 'this-repo', scope: Number(m[1]) }
              : m
                ? { kind: 'other-repo' }
                : { kind: 'unattributable', reason: 'filename does not carry a bare Issue number' }
          entries.push(
            buildLegacyEntry(dirname, join(repoDir, logName), attribution, root, deps, removeAttributed, home)
          )
        }
      }
    } else if (dirname === LEGACY_DISPATCH_RESUME) {
      for (const repoDirName of names) {
        const repoDir = join(dir, repoDirName)
        let recordNames: string[]
        try {
          recordNames = readdirSync(repoDir)
        } catch {
          continue
        }
        for (const recordName of recordNames) {
          const m = DISPATCH_RESUME_RE.exec(recordName)
          const attribution = attributeDispatchResumeRecord(m, repoDirName, repo.segment)
          entries.push(
            buildLegacyEntry(dirname, join(repoDir, recordName), attribution, root, deps, removeAttributed, home)
          )
        }
      }
    } else if (dirname === LEGACY_TASK_RESUME) {
      for (const name of names) {
        const m = TASK_RESUME_ESCALATION_RE.exec(name)
        // Cross-referenced against the SAME task's control-store folder
        // (never this file's own content, which is just a resume claim
        // marker) — the one place this bare task number's repository can
        // still be verified from, since a task-resume record carries no
        // folder of its own to inspect.
        const attribution = m
          ? attributeBareTaskFolder(
              join(legacyTopLevelDir(home, LEGACY_CONTROL_STORE), m[1] as string),
              Number(m[1]),
              repo.full,
              deps
            )
          : unattributableNoTask()
        entries.push(buildLegacyEntry(dirname, join(dir, name), attribution, root, deps, removeAttributed, home))
      }
    } else if (dirname === LEGACY_DRIVERS) {
      // An operator's own ad hoc `> ~/.vinaya/drivers/<name>.out` redirect —
      // never written by this repository's own code at any point in its
      // history, and named inconsistently by hand rather than by any path
      // convention this module could parse a task number out of safely.
      // Listed the same as any other legacy entry; never attributed, since
      // guessing a task number out of an arbitrary hand-picked filename is
      // exactly the guess the Traps forbid.
      for (const name of names) {
        entries.push(
          buildLegacyEntry(dirname, join(dir, name), unattributableNoTask(), root, deps, removeAttributed, home)
        )
      }
    } else {
      // 'dispatch-output' (keyed by an opaque effect id) and 'task-start'
      // (keyed by an opaque request id) carry no repository or task marker
      // anywhere in their own path or content (verified against both real
      // record shapes) — every entry here is unattributable by
      // construction, never a guess.
      for (const name of names) {
        entries.push(
          buildLegacyEntry(dirname, join(dir, name), unattributableNoTask(), root, deps, removeAttributed, home)
        )
      }
    }
  }

  // O3's "outbox task folders" — the even-older `outbox/dev-review-loop/<task>/`
  // tree, nested inside the SAME root the telemetry outbox still actively
  // delivers ndjson event files under today (O4's own protected root).
  // Scanned separately from the loop above because it is not a top-level
  // folder under the home at all — never through `LEGACY_TOP_LEVEL_DIRNAMES`,
  // and never by descending into `outbox/` generally (which would also walk
  // the live `<owner>-<repo>`/`unresolved` ndjson directories O4 protects).
  const outboxTaskFoldersRoot = legacyOutboxTaskFoldersRoot(home)
  let outboxTaskNames: string[]
  try {
    outboxTaskNames = readdirSync(outboxTaskFoldersRoot)
  } catch {
    outboxTaskNames = []
  }
  for (const name of outboxTaskNames) {
    if (!/^\d+$/.test(name)) continue
    const task = Number(name)
    const taskDir = join(outboxTaskFoldersRoot, name)
    const attribution = attributeBareTaskFolder(taskDir, task, repo.full, deps)
    entries.push(buildLegacyOutboxTaskEntry(taskDir, attribution, root, deps, removeAttributed, outboxTaskFoldersRoot))
  }

  return { entries }
}

function unattributableNoTask(): LegacyAttribution {
  return { kind: 'unattributable', reason: 'carries no repository or task marker in its own path or content' }
}

function attributeDispatchResumeRecord(
  match: RegExpExecArray | null,
  repoDirName: string,
  currentSegment: string
): LegacyAttribution {
  if (!match) return unattributableNoTask()
  if (repoDirName !== currentSegment) return { kind: 'other-repo' }
  if (match[2]) return { kind: 'this-repo', scope: Number(match[2]) }
  if (match[3]) return { kind: 'this-repo', scope: { pr: Number(match[3]) } }
  return { kind: 'unattributable', reason: 'unscoped dispatch record — no task to verify finished' }
}

function buildLegacyEntry(
  dirname: LegacyTopLevelDirname,
  path: string,
  attribution: LegacyAttribution,
  root: string,
  deps: TaskSweepDeps,
  removeAttributed: boolean,
  home: string
): LegacyEntry {
  return buildLegacyEntryUnder(
    dirname,
    path,
    attribution,
    root,
    deps,
    removeAttributed,
    legacyTopLevelDir(home, dirname)
  )
}

/** The label O3's own "outbox task folders" category renders under — not one of `LEGACY_TOP_LEVEL_DIRNAMES`, since this tree is nested inside `outbox/` rather than sitting directly under the home (see `legacyOutboxTaskFoldersRoot`'s own doc comment). */
export const LEGACY_OUTBOX_TASK_FOLDERS_LABEL = 'outbox task folders'

function buildLegacyOutboxTaskEntry(
  taskDir: string,
  attribution: LegacyAttribution,
  root: string,
  deps: TaskSweepDeps,
  removeAttributed: boolean,
  safeRoot: string
): LegacyEntry {
  return buildLegacyEntryUnder(
    LEGACY_OUTBOX_TASK_FOLDERS_LABEL,
    taskDir,
    attribution,
    root,
    deps,
    removeAttributed,
    safeRoot
  )
}

function buildLegacyEntryUnder(
  dirname: LegacyEntry['dirname'],
  path: string,
  attribution: LegacyAttribution,
  root: string,
  deps: TaskSweepDeps,
  removeAttributed: boolean,
  safeRoot: string
): LegacyEntry {
  if (attribution.kind !== 'this-repo') return { dirname, path, attribution, removed: false }

  const cls = classifyTaskFolder(attribution.scope, root, deps)
  if (!removeAttributed || cls.kind !== 'finished') {
    return { dirname, path, attribution, class: cls, removed: false }
  }
  try {
    assertSafeToRemove(path, safeRoot)
    deps.rm(path)
    return { dirname, path, attribution, class: cls, removed: true }
  } catch {
    return { dirname, path, attribution, class: cls, removed: false }
  }
}

// --- the single entry point every caller uses (surface.md's one-call rule) -

export type TaskSweepResult = { modern: SweepReport; legacy: LegacyReport }

/** The ONE function `commands/task-sweep.ts` calls, and the ONE function the driver calls at the start of every run (`dev-review-loop.ts`) — never both halves reached separately by a caller composing them itself. */
export function runTaskSweep(
  options: { includeLegacy: boolean },
  deps: TaskSweepDeps = defaultTaskSweepDeps,
  excludeScope?: RunScope,
  home: string = GLOBAL_VINAYA_HOME
): TaskSweepResult {
  const modern = sweepModernTasks(deps, excludeScope)
  const legacy = sweepLegacyLayout(options.includeLegacy, deps, home)
  return { modern, legacy }
}
