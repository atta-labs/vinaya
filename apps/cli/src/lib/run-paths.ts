/**
 * One directory holds every file a task's run writes, and `runPath` below is
 * the only function that names a location inside it.
 *
 * Before this module, twenty-four source files each assembled their own path
 * under the machine's Vinaya home — `dispatch-output/`, `dispatch-resume/`,
 * `dispatch-settings/`, `loops/`, `task-start/`, `task-resume/`, a
 * `dev-review-loop/<task>/` tree inside the telemetry outbox, and two
 * separate control-store roots that disagreed with each other about where a
 * record lived. Nothing named an owner for any of them, nothing swept them,
 * and a raw-agent-output folder reached 738 MB unnoticed. The layout below
 * replaces all of it: one root, one folder per task, and the folder's own
 * subdirectories classify its files by nature rather than by which module
 * happened to write them.
 *
 * ```
 * <runtimeDir>/tasks-execution/<task>/
 *   driver.pid.json          the one-driver-per-task lock, at the folder root
 *   control/                 the control store: ownership, transitions, loop
 *                            state, effects, resolutions, escalations and
 *                            review-input manifests
 *   sessions/                vendor session ids, one record per role+agent
 *   hooks/                   the per-run documentation-check files and the
 *                            dispatch settings that wire them
 *   output/                  raw agent output, the loop trace, and the
 *                            driver's own narration log
 *   rounds/<n>/              that round's reviewer and security hand-off
 *                            files, with its read-only candidate and each
 *                            reviewer's scratch copy
 * ```
 *
 * **The telemetry outbox is not here, and is the one exception.** Telemetry
 * (`log-sink.ts`'s `<outbox>/<repo>/<task>.ndjson` and its rotation) keeps
 * its own home under the Vinaya home; moving it belongs to the log tasks,
 * which change where log events are delivered at the same time.
 * `apps/cli/tests/run-paths-only.test.ts` refuses any OTHER file that
 * assembles a run-file path for itself.
 *
 * **Everything here is pure.** `runPath` takes the runtime directory as an
 * argument rather than reading it, so a test can point a whole driver at a
 * temporary tree the same way it already injects an outbox root — the
 * production resolution (`runtimeDirForRepo`) is a separate, memoized
 * function callers reach for once, at the seam where they already resolve
 * the repo.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { CONTROL_AREA_DIRNAME, mkdirNoSymlinks } from '@attalabs/aeg-core'
import {
  GLOBAL_VINAYA_HOME,
  loadConfig,
  loadTrustAnchorConfig,
  resolveRuntimeDirSetting,
  resolveTrustAnchorRuntimeDir,
  type VinayaConfig
} from './config.js'

/** The repository a run belongs to, or `null` when it could not be resolved. */
export type RunPathsRepo = { owner: string; repo: string } | null

/**
 * The single directory name under `runtimeDir` that holds every task folder.
 * Named rather than inlined so `run-paths-only.test.ts` can assert against
 * the same string this module builds with.
 */
export const TASKS_EXECUTION_DIRNAME = 'tasks-execution'

/** The four classified subdirectories of a task folder, plus the per-round tree. `driver.pid.json` deliberately has none — the lock is the task folder's own, not a member of any class. */
export const RUN_AREA_DIRNAMES = {
  // Imported, never repeated: the control store appends this same segment
  // itself (`packages/aeg-core/src/control-store/local.ts`'s `taskRoot`), so
  // a change on either side moves both.
  control: CONTROL_AREA_DIRNAME,
  sessions: 'sessions',
  hooks: 'hooks',
  output: 'output',
  rounds: 'rounds'
} as const

/** The driver lock's own filename, at the task folder's root. */
export const DRIVER_LOCK_FILENAME = 'driver.pid.json'

/**
 * Which run a path belongs to. A forge Issue number for the ordinary case;
 * the two fallbacks exist because `vinaya dispatch` can be run by hand
 * against a pull request, or against neither — a dispatch with no task still
 * writes a session record and raw output somewhere, and that somewhere must
 * be a real, non-colliding folder rather than a special case each caller
 * invents for itself.
 */
export type RunScope = number | { pr: number } | 'unscoped'

/** A location inside a task folder. Every run file this repository writes is one of these. */
export type RunFileLocation =
  /** The task folder itself, or a file sitting at its root (today, only the driver lock). */
  | { area: 'task'; file?: string }
  /** The control store's root for this task — the store nests its own record kinds below this — or a control-plane side file sitting directly in it. */
  | { area: 'control'; file?: string }
  | { area: 'sessions'; file?: string }
  | { area: 'hooks'; file?: string }
  | { area: 'output'; file?: string }
  /** The directory holding one folder per round — what a caller lists to find which rounds this task has on disk. */
  | { area: 'rounds' }
  | { area: 'round'; round: number; file?: string }

/**
 * Same guard every path builder in this repository already applies before
 * splicing a resolved repo into a filesystem path: `resolveRepo()` can
 * return an `AEG_REPO` env value parsed by `parseOwnerRepo`, which accepts
 * anything shaped `owner/repo` — including a `repo` half containing `../`.
 */
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/

export function isSafeRepoSegment(segment: string): boolean {
  return SAFE_PATH_SEGMENT.test(segment) && !segment.includes('..')
}

/**
 * `<owner>-<repo>`, or `unresolved` — the same convention and the same
 * fallback every other per-repository directory in this codebase uses. A
 * segment failing the guard is treated exactly like an unresolved repo,
 * never spliced through unchecked.
 */
export function repoSegment(repo: RunPathsRepo): string {
  if (!repo || !isSafeRepoSegment(repo.owner) || !isSafeRepoSegment(repo.repo)) return 'unresolved'
  return `${repo.owner}-${repo.repo}`
}

/**
 * The per-repository default when no `runtimeDir` is configured:
 * `~/.vinaya/runtime/<owner>-<repo>`.
 *
 * The repository segment is load-bearing, not decoration. Task numbers
 * repeat across repositories — one repo's Issue 12 and another's Issue 12
 * are different tasks — so a default that dropped it would give two
 * concurrent runs the same folder, the same driver lock and the same
 * control records. A CONFIGURED `runtimeDir` carries no such segment,
 * because it is already declared by one repository's own config file.
 */
export function defaultRuntimeDir(repo: RunPathsRepo, home: string = GLOBAL_VINAYA_HOME): string {
  return join(home, 'runtime', repoSegment(repo))
}

/**
 * The effective runtime directory, as a pure function of facts a caller has
 * already gathered. `unattended` decides which configuration is allowed to
 * name it:
 *
 *   - **Attended** — the working tree's value wins, unchecked. A human ran
 *     this command; that is the same trust level running `vinaya check`
 *     with the repo's own `checks.*.run` commands already carries.
 *   - **Unattended** — the working tree's value is honoured ONLY when the
 *     default branch declares the identical one
 *     (`resolveTrustAnchorRuntimeDir`). Anything else falls back to the
 *     per-repository default rather than to the working tree, so a pull
 *     request cannot redirect the driver's own files by editing its own
 *     diff.
 *
 * An unattended caller that passes no `trustAnchorConfig` at all gets the
 * default — fail-closed, never "trust the local file because the anchor was
 * unavailable."
 *
 * **A value inside the repository is refused outright, for either caller.**
 * An absolute path can still name a directory in the working tree, and the
 * run files this directory holds — the driver lock, the ownership epochs,
 * the held verdicts — must never sit somewhere a confined role is granted
 * write access to. `repoRoot` is passed in rather than resolved here so this
 * stays pure; omitting it skips the check, which is what a caller with no
 * repository to compare against wants.
 */
export function resolveRuntimeDir(input: {
  repo: RunPathsRepo
  localConfig: VinayaConfig | null
  trustAnchorConfig?: VinayaConfig | null
  unattended: boolean
  home?: string
  repoRoot?: string | null
}): string {
  const local = resolveRuntimeDirSetting(input.localConfig)
  if (local === null) return defaultRuntimeDir(input.repo, input.home)
  if (isInsideRepo(local, input.repoRoot)) return defaultRuntimeDir(input.repo, input.home)
  if (!input.unattended) return local
  const anchored = resolveTrustAnchorRuntimeDir(local, input.trustAnchorConfig ?? null)
  return anchored ?? defaultRuntimeDir(input.repo, input.home)
}

/**
 * Does `candidate` name the repository itself, or anything inside it?
 * Compared on resolved, separator-terminated paths, so a sibling directory
 * whose name merely starts with the repo root's (`/w/repo-backup` beside
 * `/w/repo`) is not mistaken for one inside it.
 */
export function isInsideRepo(candidate: string, repoRoot: string | null | undefined): boolean {
  if (!repoRoot) return false
  const root = resolvePath(repoRoot)
  const target = resolvePath(candidate)
  return target === root || target.startsWith(`${root}/`)
}

/**
 * The directory holding one folder per task — `<runtimeDir>/tasks-execution`.
 * This is what the control store takes as its own root: it appends the task
 * and its own `control/` segment itself
 * (`packages/aeg-core/src/control-store/local.ts`'s `taskRoot`), so the two
 * roots that used to disagree about where a record lived are now the same
 * directory every other run file resolves under.
 */
export function tasksExecutionRoot(runtimeDir: string): string {
  return join(runtimeDir, TASKS_EXECUTION_DIRNAME)
}

/**
 * The one function that names a location under a task's folder. Nothing
 * else in this repository joins a run-file path — `run-paths-only.test.ts`
 * fails the build if anything does.
 */
export function runPath(runtimeDir: string, scope: RunScope, location: RunFileLocation): string {
  const dir = join(runtimeDir, TASKS_EXECUTION_DIRNAME, scopeSegment(scope))
  switch (location.area) {
    case 'task':
      return location.file ? join(dir, location.file) : dir
    case 'control': {
      const controlDir = join(dir, RUN_AREA_DIRNAMES.control)
      return location.file ? join(controlDir, location.file) : controlDir
    }
    case 'rounds':
      return join(dir, RUN_AREA_DIRNAMES.rounds)
    case 'round': {
      const roundDir = join(dir, RUN_AREA_DIRNAMES.rounds, String(location.round))
      return location.file ? join(roundDir, location.file) : roundDir
    }
    default: {
      const areaDir = join(dir, RUN_AREA_DIRNAMES[location.area])
      return location.file ? join(areaDir, location.file) : areaDir
    }
  }
}

/**
 * `<task>` for a forge Issue, `pr-<n>` for a dispatch anchored only to a
 * pull request, `unscoped` for one anchored to neither. The two fallbacks
 * can never collide with a real Issue number, since neither is all digits.
 */
function scopeSegment(scope: RunScope): string {
  if (scope === 'unscoped') return 'unscoped'
  if (typeof scope === 'number') return String(scope)
  return `pr-${scope.pr}`
}

/**
 * `scopeSegment`'s inverse — for the one caller that walks the tasks
 * directory and has only folder names to go on. Kept here, beside the
 * grammar it reverses, so the two can never disagree about what `pr-12`
 * means. Anything neither all-digits nor `pr-<digits>` reads as
 * `'unscoped'`, which is also the folder such a segment would have been
 * written under.
 */
export function scopeFromSegment(segment: string): RunScope {
  if (/^\d+$/.test(segment)) return Number(segment)
  const pr = /^pr-(\d+)$/.exec(segment)
  if (pr) return { pr: Number(pr[1]) }
  return 'unscoped'
}

/**
 * Set by every driver on ITSELF, first thing, before it resolves a single
 * path — `markProcessUnattended` below is the one writer, and
 * `devReviewLoop`/`cancelDevReviewLoop`/`runTask`/`startBackgroundRun` are
 * its callers. Round 2 review (MAJOR) and security review (MEDIUM) both
 * found this key exported with no writer at all, which left the driver —
 * the one caller the default-branch rule exists to protect — classified
 * ATTENDED and honouring the working tree's `runtimeDir` unchecked.
 */
export const UNATTENDED_ENV_KEY = 'VINAYA_UNATTENDED'

/**
 * The runtime directory a TRUSTED controller already resolved, handed to a
 * dispatched child so the child never resolves one of its own.
 *
 * Without it, a child re-ran the whole resolution and could legitimately
 * reach a DIFFERENT answer than the parent that created its files — most
 * obviously when `loadTrustAnchorConfig()` returns null because `gh` is
 * offline or unauthenticated, where the child falls back to the default
 * while the parent honoured a configured value. The child then reads a tree
 * nobody wrote to. Passing the resolved value removes the disagreement by
 * construction, and costs the child its own network read.
 *
 * Trusted because the CONTROLLER put it there: the value came from the
 * controller's own gated resolution, never from the working tree the child
 * can edit.
 */
export const RUNTIME_DIR_ENV_KEY = 'VINAYA_RUNTIME_DIR'

/**
 * Marks this process unattended, for itself and for every child it later
 * spawns with an inherited environment. Idempotent; safe to call more than
 * once.
 */
export function markProcessUnattended(env: NodeJS.ProcessEnv = process.env): void {
  env[UNATTENDED_ENV_KEY] = '1'
  memoized = null
}

/**
 * Is this process one no human is watching? An unattended caller reads
 * `runtimeDir` from the default branch only (`resolveRuntimeDir`).
 *
 * Two signals, both genuinely set by the time any run file is written: a
 * driver marks itself (`markProcessUnattended`) before it resolves
 * anything, and every dispatched role's child carries `VINAYA_ROLE` from
 * `dispatchRole`'s own attribution environment. A human typing `vinaya task
 * status` in their own shell carries neither.
 *
 * **What this does not defend against.** A confined role can strip either
 * variable from a `vinaya` subprocess it runs itself, reclassifying that
 * subprocess as attended. That buys it nothing: the resolution only decides
 * where that subprocess LOOKS, never where the driver writes, and the
 * OS-level boundary (`apps/cli/specs/isolation.md`) grants write access to
 * this dispatch's own files by absolute path — a subprocess that resolves
 * somewhere else is denied by the profile, not by this function.
 */
export function isUnattendedProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[UNATTENDED_ENV_KEY] === '1' || (env.VINAYA_ROLE ?? '') !== ''
}

let memoized: { key: string; value: string } | null = null

/**
 * The production resolution: the effective runtime directory for `repo`,
 * computed once per process and reused.
 *
 * Memoized because the unattended branch reads the default branch's own
 * config over the network (`loadTrustAnchorConfig`) — a per-path-join fetch
 * would put a `gh api` call behind every file the driver writes. The cache
 * key is the repo segment, so a process that legitimately resolves two
 * repositories still gets two answers. The trust-anchor read happens ONLY
 * when a `runtimeDir` is configured locally at all; the overwhelmingly
 * common case (no key set) never touches the network.
 */
export function runtimeDirForRepo(repo: RunPathsRepo): string {
  const key = repoSegment(repo)
  if (memoized?.key === key) return memoized.value
  const value = resolveRuntimeDirUncached(repo)
  memoized = { key, value }
  return value
}

function resolveRuntimeDirUncached(repo: RunPathsRepo): string {
  // A trusted controller already decided this — use it verbatim rather than
  // re-deriving an answer that could differ from the one that created the
  // files this process is about to read.
  const handedDown = process.env[RUNTIME_DIR_ENV_KEY]
  if (handedDown) return handedDown

  const localConfig = loadConfig()
  const unattended = isUnattendedProcess()
  const needsAnchor = unattended && resolveRuntimeDirSetting(localConfig) !== null
  return resolveRuntimeDir({
    repo,
    localConfig,
    trustAnchorConfig: needsAnchor ? loadTrustAnchorConfig() : null,
    unattended,
    repoRoot: repoRootSync()
  })
}

/** The enclosing repository's root, or `null` outside one — used only to refuse a `runtimeDir` that points inside the working tree. */
function repoRootSync(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  } catch {
    return null
  }
}

/**
 * The repository this process is running against, resolved synchronously.
 *
 * `@attalabs/aeg-forge-state`'s own `resolveRepo` is `async`, and the
 * production seams that resolve a run path are synchronous all the way down
 * to a `writeFileSync` — making them `async` would ripple into the command
 * files this task's Surface excludes. Same resolution order and the same
 * URL shapes that resolver parses: `AEG_REPO` first, then `git remote
 * get-url origin`.
 */
export function resolveRepoSync(): RunPathsRepo {
  const fromEnv = process.env.AEG_REPO
  if (fromEnv) {
    const m = /^([^/]+)\/(.+)$/.exec(fromEnv)
    if (m?.[1] && m[2]) return { owner: m[1], repo: m[2] }
  }
  let url: string
  try {
    url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  } catch {
    return null
  }
  const ssh = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(url)
  if (ssh?.[1] && ssh[2]) return { owner: ssh[1], repo: ssh[2] }
  const https = /^https?:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url)
  if (https?.[1] && https[2]) return { owner: https[1], repo: https[2] }
  return null
}

let memoizedThisRepo: string | null = null

/**
 * The effective runtime directory for the repository this process is running
 * against — the production entry point every seam that has no repo in hand
 * already reaches for.
 *
 * Memoized in its OWN right, not just through `runtimeDirForRepo` (round 2
 * review, MAJOR). Resolving the repo is itself a `git` fork, and this
 * function is handed to `defaultControlStoreDeps` as a CALLBACK: the control
 * store invokes `deps.root()` at twenty separate sites — twice per
 * `writeEffect`, twice per `acquireOwnership` attempt — so evaluating the
 * repo before reaching the cache turned what used to be a pure string join
 * into several subprocess forks per control-store operation, and hundreds
 * per loop round. Worse, a transient fork failure yields the `unresolved`
 * segment, so an epoch check and the write it guards could resolve two
 * different trees inside one `writeEffect`. Caching the answer removes both:
 * the fork happens at most once per process, and every later call returns
 * the identical string.
 */
export function runtimeDirForThisRepo(): string {
  if (memoizedThisRepo !== null) return memoizedThisRepo
  memoizedThisRepo = runtimeDirForRepo(resolveRepoSync())
  return memoizedThisRepo
}

/**
 * Creates a run-file directory owner-only, and re-asserts the mode on one
 * that already exists.
 *
 * Every run-file directory goes through here rather than a bare
 * `mkdirSync(..., { recursive: true })` (security review, MEDIUM). While
 * these paths all sat under `~/.vinaya/outbox` — itself `0700` — a lax mode
 * on a child was moot; under a configurable `runtimeDir` whose documented
 * example is `/var/lib/vinaya/runs` it is not. With a `umask` of `002` a
 * no-mode `mkdirSync` produces `0775`, which would let any other local
 * account read an unpublished security `findings.txt`, replace a
 * `rounds/<n>/reviewer.md` that `publishRound` later posts verbatim, or
 * plant a `driver.pid.json`. `recursive: true` applies `mode` only to
 * directories it CREATES, so which writer got there first decided the
 * ancestors' mode — the explicit `chmodSync` is what makes the result
 * independent of writer order.
 *
 * `mkdirNoSymlinks` (`@attalabs/aeg-core`, shared with that package's own
 * control-store writers) is what actually creates the tree — the SAME
 * co-tenant able to plant a low-mode child under a shared `runtimeDir` can
 * instead pre-plant a symlink at any missing ancestor, which a bare
 * `mkdirSync(..., { recursive: true })` treats as already-present and
 * silently follows (security review, CRITICAL); every writer that reaches
 * this directory next then operates inside whatever real directory that
 * symlink resolves to. `mkdirNoSymlinks` refuses instead of following.
 *
 * `runtimeDir` is the boundary `mkdirNoSymlinks` refuses a symlink at or
 * below — this call's own `dir` is always `runtimeDir` or a path nested
 * under it (every caller builds `dir` from `runPath(runtimeDir, ...)`).
 * Above `runtimeDir`, an operating-system-owned ancestor may legitimately be
 * a symlink (macOS's default temp root, `/var` -> `/private/var`) and is
 * tolerated once its real target passes the same ownership/mode check —
 * `mkdirNoSymlinks` draws that line, this call just names it.
 */
export function ensureRunDir(dir: string, runtimeDir: string): void {
  mkdirNoSymlinks(dir, 0o700, runtimeDir)
  chmodSync(dir, 0o700)
}

/** Test-only: drops the memoized resolution so a test can change the environment and resolve again. */
export function resetRuntimeDirCache(): void {
  memoized = null
  memoizedThisRepo = null
}
