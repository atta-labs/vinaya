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
import { join } from 'node:path'
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
  control: 'control',
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
  /** The control store's root for this task — the store nests its own record kinds below this. */
  | { area: 'control' }
  | { area: 'sessions'; file?: string }
  | { area: 'hooks'; file?: string }
  | { area: 'output'; file?: string }
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
 */
export function resolveRuntimeDir(input: {
  repo: RunPathsRepo
  localConfig: VinayaConfig | null
  trustAnchorConfig?: VinayaConfig | null
  unattended: boolean
  home?: string
}): string {
  const local = resolveRuntimeDirSetting(input.localConfig)
  if (local === null) return defaultRuntimeDir(input.repo, input.home)
  if (!input.unattended) return local
  const anchored = resolveTrustAnchorRuntimeDir(local, input.trustAnchorConfig ?? null)
  return anchored ?? defaultRuntimeDir(input.repo, input.home)
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
    case 'control':
      return join(dir, RUN_AREA_DIRNAMES.control)
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
 * Is this process one no human is watching? An unattended caller reads
 * `runtimeDir` from the default branch only (`resolveRuntimeDir`).
 *
 * Two signals, both already set by the time any run file is written: the
 * driver marks itself before it dispatches anything, and every dispatched
 * role's child carries `VINAYA_ROLE` from `dispatchRole`'s own attribution
 * environment. A human typing `vinaya task status` in their own shell
 * carries neither.
 */
export function isUnattendedProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VINAYA_UNATTENDED === '1' || (env.VINAYA_ROLE ?? '') !== ''
}

/** Set by the driver on itself, and threaded to every child it dispatches, so both sides of a dispatch resolve the identical runtime directory. */
export const UNATTENDED_ENV_KEY = 'VINAYA_UNATTENDED'

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
  const localConfig = loadConfig()
  const unattended = isUnattendedProcess()
  const needsAnchor = unattended && resolveRuntimeDirSetting(localConfig) !== null
  const value = resolveRuntimeDir({
    repo,
    localConfig,
    trustAnchorConfig: needsAnchor ? loadTrustAnchorConfig() : null,
    unattended
  })
  memoized = { key, value }
  return value
}

/** Test-only: drops the memoized resolution so a test can change the environment and resolve again. */
export function resetRuntimeDirCache(): void {
  memoized = null
}
