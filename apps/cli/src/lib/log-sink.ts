/**
 * The one write for the Vinaya Log (Linear "Tech spec — The Vinaya Log" rev
 * 4, §8 layer 2, §9). Every environment read, remote read, package read,
 * hostname and git call lives here; `packages/aeg-core/src/log/` stays pure
 * (schema, envelope, redaction) and never writes.
 *
 * `log()` never throws. Every failure path returns; at most one
 * `process.stderr.write` per process, guarded by a module-level flag.
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync
} from 'node:fs'
import { hostname as osHostname, homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { resolveRepo as resolveRepoDefault, resolveTaskIssueRef } from '@attalabs/aeg-forge-state'
import {
  buildHeader,
  type Host,
  type LogEvent,
  LogEventSchema,
  type OverflowDiagnostic,
  recordIdentity,
  redact
} from '@attalabs/aeg-core'
import {
  GLOBAL_VINAYA_HOME,
  loadConfig,
  loadTrustAnchorConfigAsync,
  resolveLogsHeaderValues,
  resolveLogsSetting,
  resolveTrustAnchorLogsDestination,
  type LogsDestination,
  type VinayaConfig
} from './config.js'
import { isInsideRepo, isUnattendedProcess, repoRootSync, runtimeDirForRepoAsync } from './run-paths.js'
import { drainOutboxToWebhook } from './log-webhook-drain.js'
import { packageRoot } from './package-root.js'

/** Rotation cap (§9: "rotation and a size cap ship with the first write") — one `.1.ndjson` slot, overwritten each time the live file crosses this. */
export const OUTBOX_MAX_BYTES = 8 * 1024 * 1024

type Envelope = { meta: unknown; subject: unknown }
/** Distributes over `LogEvent`'s member events so each keeps its own extra fields after `meta`/`subject` are stripped — the sink fills those, a caller never passes them. */
type StripEnvelope<T> = T extends Envelope ? Omit<T, 'meta' | 'subject'> : never
export type LogEventInput = StripEnvelope<LogEvent>

type RepoRef = { owner: string; repo: string }

/** Mirrors `envelope.ts`'s `HeaderInput.inputVersions` — read once per sink instance, applied to every line it logs. */
export type LogSinkInputVersions = {
  objectivesVersion?: string | null
  briefHash?: string | null
  rulingOrdinal?: number | null
  policyDigest?: string | null
}

/**
 * Where THIS process's `log()` calls land, resolved once per sink instance
 * (the sink's shared context, below) — a folder the sink appends directly to,
 * a server drained from the local retry queue after every append
 * (`apps/cli/specs/log.md` § The destination), or `none` (O3): a CI run with
 * no server configured, or holding no delivery credential for one that is —
 * an ephemeral runner's own folder is never a real destination for CI, so
 * `log()` records nothing rather than writing somewhere nobody reads before
 * the runner is torn down, and `reason` is what a job-output line names.
 */
export type ResolvedLogDestination =
  | { kind: 'folder'; folder: string }
  | { kind: 'server'; url: string; headers?: Record<string, string> }
  | { kind: 'none'; reason: string }

export type LogSinkDeps = {
  outboxRoot: () => string
  home: () => string
  hostname: () => string
  cwd: () => string
  now: () => Date
  env: () => NodeJS.ProcessEnv
  resolveRepo: () => Promise<RepoRef | null>
  vinayaVersion: () => string
  stderr: (message: string) => void
  /**
   * A caller that structurally knows which
   * objectives/brief/ruling/policy identity this sink's own dispatch was
   * judged against (`dispatch.ts`, given a `DispatchOpts.inputVersions`) —
   * `undefined` when the caller has none, the honest default every prior
   * caller already gets (`buildHeader` itself already reads all four sub-
   * fields as optional, `null` for whichever it isn't given).
   */
  inputVersions: () => LogSinkInputVersions | undefined
  /**
   * The Issue the checked-out branch names, for an event whose process
   * carries no `VINAYA_TASK` — the real default is `resolveBranchIssue`
   * (one `git` read, and one `gh` read to confirm what it named, asked of the
   * `<owner>/<repo>` handed in: the repository the event will be FILED
   * under, never whatever the directory's git remote happens to name).
   * Called at most once per process per working directory and repository,
   * lazily: a process whose events already name their task never calls it at
   * all, and a second sink reading the same pair reuses the first answer.
   */
  resolveBranchIssue: (repo: string | null) => Promise<number | null>
  /**
   * The `logs` setting's resolved destination for this process (O1/O4) —
   * `vinaya.config.json`'s `logs`, trust-anchor-gated for an unattended
   * caller exactly as `runtimeDir` already is, falling back to a folder
   * under this repository's own `runtimeDir` when unset. Called at most
   * once per sink instance (the sink's shared context) — a `url`
   * destination can require a network read (`loadTrustAnchorConfigAsync`)
   * an unattended caller must not repeat on every event. May answer
   * synchronously or asynchronously; the sink awaits either.
   */
  resolveLogDestination: (
    repo: RepoRef | null,
    env: NodeJS.ProcessEnv
  ) => ResolvedLogDestination | Promise<ResolvedLogDestination>
}

// Quiet: the fallback warning goes to stdout, and every process that logs —
// `vinaya dispatch --json`, a check binary — owns its stdout; telemetry
// resolving its destination must never write into it.
/**
 * The longest any one lookup behind a sink's shared context (the repo, the
 * doctrine, the default branch's `logs` read) may hold `log()` back. Every
 * line a process logs waits on that one context, so a lookup whose child
 * process never reports its exit — the lost-exit defect of the pinned Bun —
 * would otherwise stop the whole process's telemetry for good, and any
 * caller waiting for its own line to land waits with it. Past the deadline
 * the lookup falls back to exactly what an unreadable source already yields.
 */
export const LOG_CONTEXT_LOOKUP_DEADLINE_MS = 3000

/** `work`'s value, or `fallback` once `ms` has passed or `work` rejects — the timer never holds a process open. */
export function withDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    timer.unref?.()
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(fallback)
      }
    )
  })
}

async function safeLoadTrustAnchorConfig(): Promise<VinayaConfig | null> {
  return withDeadline(loadTrustAnchorConfigAsync(undefined, { quiet: true }), LOG_CONTEXT_LOOKUP_DEADLINE_MS, null)
}

/**
 * The pure decision behind `LogSinkDeps.resolveLogDestination` — a `url`
 * destination is honoured only when the repository's default branch
 * declares the identical one for an unattended caller (round-2 security
 * review, HIGH, the same rule `runtimeDir` already
 * carries: a pull request under review cannot redirect where an unattended
 * run's telemetry is delivered by editing its own diff). An attended caller
 * — a human running `vinaya`, choosing to trust their own working tree —
 * honours the local value unchecked, the same trust level running
 * `vinaya.config.json`'s own `dispatch.agent` already carries.
 *
 * An unattended caller whose LOCAL config declares no `logs` setting at all
 * still honours the default branch's own declared destination (round-3
 * security review, HIGH) — a working tree that OMITS the setting is exactly
 * as untrustworthy as one that redirects it: a pull request diff can delete
 * a line as easily as it can edit one, and an unattended run whose telemetry
 * silently reverted to the local default folder the moment `logs` went
 * missing from a diff would let the very branch under review switch off the
 * org's independent monitoring destination with nobody warned. Only when the
 * default branch ITSELF declares nothing does this fall back to
 * `defaultFolder` — never "no destination," since O1 declares a folder the
 * default, not an opt-in.
 *
 * No `logs` setting resolved at all (the ordinary default, and every
 * refused/ungated case above) falls back to `defaultLogsFolder`. Pure —
 * takes the already-resolved local/trust-anchor config and the
 * per-repository default folder, so it is directly unit-testable with plain
 * objects, mirroring `run-paths.ts`'s own `resolveRuntimeDir`.
 *
 * A `folder` naming the repository itself, or anything inside it, is refused
 * outright — for either caller, attended or unattended — exactly
 * `resolveRuntimeDir`'s own `isInsideRepo` rule (round-2 security review,
 * HIGH): a confined role granted write access to a path under the working
 * tree (a worktree checkout included) must never also be able to forge or
 * tamper with the append-only log recording its own task's events by writing
 * into a `logs.folder` that happens to resolve there. Falls back to
 * `defaultFolder`, the same as "no `logs` setting at all."
 */
/**
 * O3: a `logs.url` header referencing `${VAR_NAME}` whose named variable is
 * absent or empty in `env` — GitHub Actions sets a secret-backed env var to
 * an empty string for a fork pull request (the secret is withheld, never the
 * variable), so "empty" and "unset" are the same signal here: this job holds
 * no real delivery credential. A destination with no headers at all (no
 * credential concept) never trips this — there is nothing to be missing.
 */
function logsCredentialMissing(headers: Record<string, string> | undefined, env: NodeJS.ProcessEnv): boolean {
  if (!headers) return false
  const varPattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g
  for (const value of Object.values(headers)) {
    for (const match of value.matchAll(varPattern)) {
      if (!env[match[1] as string]) return true
    }
  }
  return false
}

export function resolveLogDestinationFrom(input: {
  localConfig: VinayaConfig | null
  trustAnchorConfig: VinayaConfig | null
  unattended: boolean
  env: NodeJS.ProcessEnv
  defaultFolder: string
  repoRoot?: string | null
}): ResolvedLogDestination {
  const local = resolveLogsSetting(input.localConfig)
  let effective: LogsDestination | null = null
  if (input.unattended) {
    effective = local
      ? resolveTrustAnchorLogsDestination(local, input.trustAnchorConfig)
      : resolveLogsSetting(input.trustAnchorConfig)
  } else {
    effective = local
  }
  // O3: a CI job never falls back to a folder — an ephemeral runner's own
  // disk dies with the job, so a folder there is not a real destination, it
  // is a silent no-op wearing delivery's clothes. CI delivers to a
  // configured server or it records nothing and says so (Linear "Tech
  // spec — The Vinaya Log" rev 8, § 4, Diagram K); it is never told apart
  // from an ordinary unattended caller by anything but this host check,
  // since the trust-anchor gate above already applies identically to both.
  if (hostFromEnv(input.env) === 'ci') {
    if (effective && 'url' in effective) {
      if (logsCredentialMissing(effective.headers, input.env)) {
        return {
          kind: 'none',
          reason:
            'a logs.url server destination is configured, but this job holds no delivery credential (a fork pull request, or a missing repository secret)'
        }
      }
      return { kind: 'server', url: effective.url, headers: resolveLogsHeaderValues(effective.headers, input.env) }
    }
    return {
      kind: 'none',
      reason: 'no server destination is configured for CI delivery (vinaya.config.json logs.url)'
    }
  }
  if (effective && 'url' in effective) {
    return { kind: 'server', url: effective.url, headers: resolveLogsHeaderValues(effective.headers, input.env) }
  }
  if (effective && 'folder' in effective && isInsideRepo(effective.folder, input.repoRoot)) {
    effective = null
  }
  const folder = effective && 'folder' in effective ? effective.folder : input.defaultFolder
  return { kind: 'folder', folder }
}

/**
 * The real resolution behind `LogSinkDeps.resolveLogDestination` — the
 * real-IO wrapper `resolveLogDestinationFrom` above needs (config reads, the
 * trust-anchor network read, the per-repository default folder).
 *
 * Unlike `run-paths.ts`'s own `resolveRuntimeDirUncached`, the trust-anchor
 * read here cannot be gated on whether `logs` is configured LOCALLY: a
 * working tree that OMITS the setting is precisely the case this destination
 * must still catch (round-3 security review, HIGH — see
 * `resolveLogDestinationFrom`'s own doc comment), so the anchor is read for
 * every unattended caller regardless of what the local config says. Already
 * bounded to one read per process either way — `createLogSink`'s own
 * `context()` calls this function once, into its memoized `contextCache`, so
 * the round trip this function's caller can no longer skip still happens at
 * most once per sink instance.
 */
// The default branch's config cannot change within one process, so it is read
// once per process, not once per sink: the loop driver alone holds several
// sinks (its own, one per dispatched role, the module default), and each
// extra read is one more child process whose exit the pinned Bun can lose.
let processTrustAnchorOnce: Promise<VinayaConfig | null> | undefined
function processTrustAnchor(): Promise<VinayaConfig | null> {
  if (processTrustAnchorOnce === undefined) processTrustAnchorOnce = safeLoadTrustAnchorConfig()
  return processTrustAnchorOnce
}

async function defaultResolveLogDestination(
  repo: RepoRef | null,
  env: NodeJS.ProcessEnv
): Promise<ResolvedLogDestination> {
  const localConfig = loadConfig()
  // THIS process's own classification, never the event env's: `dispatchRole`
  // hands its sink a synthetic env carrying the CHILD's `VINAYA_ROLE` for
  // attribution, and reading trust from that would treat an attended parent
  // as unattended — a forge read on every dispatch the parent logs.
  const unattended = isUnattendedProcess(process.env)
  return resolveLogDestinationFrom({
    localConfig,
    trustAnchorConfig: unattended ? await processTrustAnchor() : null,
    unattended,
    env,
    defaultFolder: join(await runtimeDirForRepoAsync(repo), 'logs'),
    repoRoot: repoRootSync()
  })
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT'
}

const execFileAsync = promisify(execFile)

/** `git -C <root> rev-parse HEAD:aeg-root` for a tree checkout; the CLI's own package version for a bundle; `'unknown'` when `git` itself is unreachable. Called once per sink instance, never per line, and only ever as an async child (see `createLogSink`'s context). */
async function resolveDoctrine(cwd: string, vinayaVersion: string): Promise<string> {
  let toplevel: string
  try {
    toplevel = (
      await execFileAsync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' })
    ).stdout.trim()
  } catch (err) {
    return isEnoent(err) ? 'unknown' : vinayaVersion
  }
  if (!existsSync(join(toplevel, 'aeg-root', 'roles'))) return vinayaVersion
  try {
    const sha = (
      await execFileAsync('git', ['-C', toplevel, 'rev-parse', 'HEAD:aeg-root'], { encoding: 'utf8' })
    ).stdout.trim()
    return `aeg-root@${sha}`
  } catch {
    return vinayaVersion
  }
}

/**
 * The two branch shapes this doctrine addresses a task by — `task/issue-<n>`
 * for a tranche-less backlog Issue, `task/<tranche>/<n>` for a tranche task
 * (`apps/cli/src/lib/task-status.ts`'s `branchForRef`, the same two shapes
 * `developerBranchFor` derives). Pure: a branch name in, a claim about what
 * it names out — no I/O, so the shape rule itself is testable without a
 * checkout or a forge.
 */
export type TaskBranchRef = { kind: 'issue'; issue: number } | { kind: 'tranche'; tranche: string; taskId: string }

/** Only these characters may reach `gh`'s argv as a label segment — a branch name is not a trusted value, and a tranche slug is always this shape. */
const TRANCHE_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function taskRefFromBranch(branch: string): TaskBranchRef | null {
  const backlog = /^task\/issue-(\d+)$/.exec(branch)
  if (backlog) {
    // A branch name is a value a role types, not a bounded number: ~310
    // digits parse to `Infinity` and 20 digits to a non-integer float, and
    // `LogEventSchema`'s `subject.issue: z.number().int()` refuses both —
    // which drops the WHOLE event, for every event this process logs, since
    // the resolved value is cached. So an unbounded parse here would let a
    // branch name silence a process's entire audit trail. The environment
    // path guards exactly this on the same field (`issueFromTask`'s
    // `Number.isInteger`, `envelope.ts`); this is that guard, on this path.
    const issue = Number(backlog[1])
    return Number.isSafeInteger(issue) && issue > 0 ? { kind: 'issue', issue } : null
  }
  const tranche = /^task\/([^/]+)\/([^/]+)$/.exec(branch)
  if (tranche && TRANCHE_SLUG_PATTERN.test(tranche[1] ?? '')) {
    return { kind: 'tranche', tranche: tranche[1] as string, taskId: tranche[2] as string }
  }
  return null
}

/** Generous, not a bound — the same limit `task-status.ts` reads open task Issues with; one tranche has never held more. */
const TRANCHE_ISSUE_LIST_LIMIT = 200

/**
 * The Issue a `task/<tranche>/<n>` branch names, read from the forge the one
 * way this doctrine derives it anywhere else: the `vinaya/tranche:<slug>`
 * label plus the `[<slug>] <n> — …` title, parsed by the SAME
 * `resolveTaskIssueRef` the task list and the task tools already share
 * rather than a second, drifting copy of the title rule here. `--state all`,
 * not `open`: a branch stays checked out after its Issue closes, and an
 * event emitted there still belongs to that task.
 *
 * Run IN the sink's own working directory, never the process's: `gh`
 * resolves which repository to ask from the git remote of the directory it
 * runs in, and a sink configured with a `cwd` of its own (the shape the loop
 * harness and the log fixtures use) must not read one checkout's branch and
 * another checkout's Issues.
 */
async function issueForTrancheTask(
  tranche: string,
  taskId: string,
  cwd: string,
  repo: string | null
): Promise<number | null> {
  let stdout: string
  try {
    ;({ stdout } = await execFileAsync(
      'gh',
      [
        'issue',
        'list',
        '--state',
        'all',
        '--label',
        `vinaya/tranche:${tranche}`,
        '--json',
        'number,title,labels',
        '--limit',
        String(TRANCHE_ISSUE_LIST_LIMIT),
        // From the already-resolved repository, never the directory's remote
        // — the same reason `confirmBacklogIssue` passes it.
        ...(repo === null ? [] : ['--repo', repo])
      ],
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        // The child dies WITH the deadline, not just the promise the caller
        // is waiting on: `withDeadline` answers `null` at the call site, but
        // a hanging, proxied or unauthenticated `gh` left running holds the
        // event loop open and delays this process's own exit long past it —
        // on the pre-push-hook path, the very path this feature exists for
        // (round 3 security review, LOW).
        timeout: LOG_CONTEXT_LOOKUP_DEADLINE_MS,
        killSignal: 'SIGKILL'
      }
    ))
  } catch {
    return null
  }
  let issues: Array<{ number: number; title: string; labels: Array<{ name: string }> }>
  try {
    issues = JSON.parse(stdout)
  } catch {
    return null
  }
  for (const issue of issues) {
    const ref = resolveTaskIssueRef(
      issue.title,
      issue.labels.map((l) => l.name)
    )
    if (ref && ref.trancheSlug === tranche && ref.taskId === taskId) return issue.number
  }
  return null
}

/**
 * A branch-named Issue, answered on the forge's terms: `'confirmed'` when the
 * Issue exists in the repository the event will be FILED under, `'denied'`
 * when that repository says it does not, and `'unknown'` when the forge could
 * not be asked at all.
 *
 * The three-way answer is the whole point. A branch name is caller-supplied
 * (a pushed branch, a fork's, a reviewer's checkout), so a number the forge
 * DENIES must never be filed — that is the attribution harm the confirmation
 * exists to prevent. But a `gh` that is missing, unauthenticated, offline or
 * rate-limited has said nothing about the number, and treating its silence as
 * denial would throw away exactly what this fallback is for: a local pre-push
 * run, on a task branch, on a machine with no forge access, whose branch
 * names its task unambiguously (the objective's own words: a `task/issue-<n>`
 * branch gives `<n>`). Silence therefore leaves the branch's own claim
 * standing, and `meta.provenance` stays `'unavailable'` either way — the
 * event never claims the forge agreed.
 *
 * `--repo` is passed from the ALREADY-RESOLVED repository, never left to the
 * directory's git remote: `meta.repo` and the outbox file come from
 * `resolveRepo()`, whose first source is `AEG_REPO`, so asking a different
 * repository would confirm a number in one place and file it in another
 * (round 5 review, MINOR). With no resolved repository to name, `gh`'s own
 * directory-derived default is all there is.
 */
type BacklogConfirmation = 'confirmed' | 'denied' | 'unknown'

async function confirmBacklogIssue(issue: number, cwd: string, repo: string | null): Promise<BacklogConfirmation> {
  let stdout: string
  try {
    ;({ stdout } = await execFileAsync(
      'gh',
      ['issue', 'view', String(issue), '--json', 'number', ...(repo === null ? [] : ['--repo', repo])],
      {
        cwd,
        encoding: 'utf8',
        timeout: LOG_CONTEXT_LOOKUP_DEADLINE_MS,
        killSignal: 'SIGKILL'
      }
    ))
  } catch (err) {
    // `gh` exits non-zero for both "no such Issue" and "I could not ask" —
    // only its own message tells them apart, and only the first is a denial.
    const stderr = typeof (err as { stderr?: unknown }).stderr === 'string' ? (err as { stderr: string }).stderr : ''
    return /could not resolve|not found|no such|does not exist/i.test(stderr) ? 'denied' : 'unknown'
  }
  try {
    return (JSON.parse(stdout) as { number?: unknown }).number === issue ? 'confirmed' : 'denied'
  } catch {
    return 'unknown'
  }
}

/**
 * The Issue the CHECKED-OUT branch names, or `null` when it names none —
 * what fills `subject.issue` for an event whose process carries no
 * `VINAYA_TASK` (the pre-push hook's and CI's own `vinaya check` runs, which
 * is most of what a log server actually holds). `null` is the honest answer
 * for a branch that is not a task branch, a checkout `git` cannot read, and
 * a tranche task whose Issue the forge will not name — never a guessed
 * number.
 *
 * Called at most ONCE per process per working-directory-and-repository pair
 * (memoised in `branchIssueByCwd`, `null` included) and only when an event's
 * own `VINAYA_TASK` is absent, so a process that
 * already knows its task makes no forge call at all; the one call it can
 * make is bounded by `LOG_CONTEXT_LOOKUP_DEADLINE_MS` at the call site, so a
 * slow or unauthenticated `gh` delays no event past that deadline and drops
 * none. Async throughout (`execFileAsync`, never `execFileSync`) — the same
 * no-synchronous-spawn rule the sink's shared context already holds
 * (`tests/lib/log-sink-no-sync-spawn.test.ts`).
 */
export async function resolveBranchIssue(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  repo: string | null = null
): Promise<number | null> {
  let branch: string
  try {
    branch = (
      await execFileAsync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        encoding: 'utf8',
        // Same rule as the `gh` read below: the child dies with the
        // deadline rather than outliving the answer.
        timeout: LOG_CONTEXT_LOOKUP_DEADLINE_MS,
        killSignal: 'SIGKILL'
      })
    ).stdout.trim()
  } catch {
    return null
  }
  // A CI job triggered by a pull request checks out the merge commit in
  // DETACHED HEAD, where `rev-parse --abbrev-ref HEAD` answers the literal
  // string `HEAD` and no branch is checked out at all — so CI, named
  // alongside the pre-push hook as the reason this fallback exists, would
  // record `issue: null` forever without this line. The head ref the CI
  // system itself reports for the pull request is the branch that checkout
  // came from (`GITHUB_HEAD_REF`, set on a `pull_request` event and empty on
  // every other), and it goes through the IDENTICAL shape rules and the
  // identical verification below. It is not a stronger claim than a local
  // branch name — both are caller-supplied, both leave
  // `meta.provenance: 'unavailable'` — it is the same claim, read where git
  // cannot make it.
  const named = branch === 'HEAD' ? (env.GITHUB_HEAD_REF ?? '') : branch
  const ref = taskRefFromBranch(named)
  if (ref === null) return null
  if (ref.kind === 'tranche') return await issueForTrancheTask(ref.tranche, ref.taskId, cwd, repo)
  // `'unknown'` keeps the branch's own number: see `confirmBacklogIssue`.
  return (await confirmBacklogIssue(ref.issue, cwd, repo)) === 'denied' ? null : ref.issue
}

function readVinayaVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot(import.meta.url), 'package.json'), 'utf8')) as {
      version?: string
    }
    return pkg.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

// `owner`/`repo` reach here from `AEG_REPO` or a parsed git remote URL —
// neither is re-validated upstream (`@attalabs/aeg-forge-state`'s parser
// permits `/` and `..`) before landing in a path this sink joins straight
// into `mkdirSync`/`openSync`. A crafted `AEG_REPO=owner/../../../../tmp/evil`
// must not steer the outbox outside itself, so a segment failing this check
// is treated exactly like a null `resolveRepo()` — the same "unresolved"
// fallback, never a value spliced unchecked into a filesystem path.
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/

function isSafeRepoSegment(segment: string): boolean {
  return SAFE_PATH_SEGMENT.test(segment) && !segment.includes('..')
}

/** `<owner>/<repo>` for a `--repo` argv element, or `null` when either segment is one this module refuses to pass anywhere (the same guard `meta.repo` already applies). */
function safeRepoSlug(repo: RepoRef | null): string | null {
  if (repo === null) return null
  return isSafeRepoSegment(repo.owner) && isSafeRepoSegment(repo.repo) ? `${repo.owner}/${repo.repo}` : null
}

/**
 * The local retry-queue outbox's own root, under the machine's Vinaya home —
 * no longer where `log()` delivers by default (that moved to a folder under
 * this repository's own `runtimeDir`, `defaultResolveLogDestination` above),
 * but still where `log()` itself appends first for a configured `logs.url`
 * server destination before draining (O2).
 *
 * Deliberately NOT under `runtimeDir` (`run-paths.ts`) even so: a retry
 * queue is machine-local plumbing, not one task's own run file, and two
 * repositories' identically-numbered tasks already share this same
 * `<owner>-<repo>` segmenting scheme without collision.
 * `apps/cli/tests/run-paths-only.test.ts` names this module as the single
 * exception to "no file outside `run-paths.ts` assembles a run-file path."
 */
export function telemetryOutboxRoot(): string {
  return join(GLOBAL_VINAYA_HOME, 'outbox')
}

/**
 * The retry-queue outbox path `log()` itself appends to first for a
 * `logs.url` server destination (O2) — keyed by repo (or `unresolved`, never
 * a value from an unvalidated `resolveRepo()` result) and by Issue (or
 * `none`), never by PR (task 2, `apps/cli/specs/log.md`).
 */
export function outboxPathFor(
  deps: Pick<LogSinkDeps, 'outboxRoot'>,
  repo: { owner: string; repo: string } | null,
  issue: number | null
): string {
  const dirName = repo ? `${repo.owner}-${repo.repo}` : 'unresolved'
  const fileName = `${issue ?? 'none'}.ndjson`
  return join(deps.outboxRoot(), dirName, fileName)
}

/**
 * The exact path THIS process's `log()` will append a `repo`/`issue` event
 * to — a folder destination's own `<repository>/<task>.ndjson`, or (a `url`
 * destination) the local retry queue it appends to before every drain.
 * Mirrors `log()`'s own destination resolution exactly, so a caller that
 * needs to poll for its own line landing (`dispatch.ts`'s `dispatchRole`,
 * `dev-review-loop.ts`'s `logEvents`) watches the SAME file `log()` actually
 * writes to, whichever destination is configured. Not memoized — callers
 * that need this call it once per process, not once per event.
 */
export async function resolveLogAppendPath(
  repo: { owner: string; repo: string } | null,
  issue: number | null,
  overrides: Partial<
    Pick<LogSinkDeps, 'resolveLogDestination' | 'outboxRoot' | 'env' | 'cwd' | 'resolveBranchIssue'>
  > = {}
): Promise<string> {
  const deps = { ...defaultDeps(), ...overrides }
  const destination = await deps.resolveLogDestination(repo, deps.env())
  const root = destination.kind === 'folder' ? destination.folder : deps.outboxRoot()
  // Nothing is recorded for this process, so nothing is attributed either:
  // the same rule `log()` applies one step earlier, and the reason a job
  // deliberately holding no delivery credential spends no `git` read and no
  // credentialed `gh` call here (round 5 review, MINOR — the ordering fix
  // had been applied in `log()` alone).
  if (destination.kind === 'none') return outboxPathFor({ outboxRoot: () => root }, repo, issue)
  // The branch fallback decides which FILE an event lands in, so this
  // mirror has to make the same decision or it stops naming the file
  // `log()` writes — a caller polling for its own line would watch
  // `none.ndjson` while the sink wrote `<branch issue>.ndjson`, and a
  // confined caller would grant the sandbox one exact file while its child
  // appended to another (round 3 review, MAJOR). Same condition `log()`
  // applies: only when the caller named no issue AND the environment names
  // no task, and only for a process where the fallback is on at all.
  const branchIssue =
    issue === null && !deps.env().VINAYA_TASK && branchIssueFallbackEnabled
      ? await branchIssueRead(
          `${deps.cwd()}\u0000${safeRepoSlug(repo) ?? ''}`,
          () =>
            overrides.resolveBranchIssue !== undefined
              ? overrides.resolveBranchIssue(safeRepoSlug(repo))
              : resolveBranchIssue(deps.cwd(), deps.env(), safeRepoSlug(repo)),
          overrides.resolveBranchIssue === undefined
        )
      : null
  return outboxPathFor({ outboxRoot: () => root }, repo, issue ?? branchIssue)
}

function hostFromEnv(env: NodeJS.ProcessEnv): Host {
  if (env.GITHUB_ACTIONS) return 'ci'
  if (env.VINAYA_HOST === 'hook') return 'hook'
  if (env.VINAYA_HOST === 'loop') return 'loop'
  return 'cli'
}

// One visible warning per PROCESS, not per sink: `warnOnce`'s own flag lives
// in each `createLogSink` closure, and `dispatchRole` and the loop driver
// build a fresh sink per call inside one long-running process, so a
// persistently broken destination would otherwise warn once per dispatch.
// Gated here, on the real stderr write every default-deps sink shares; a test
// that injects its own `stderr` gets an isolated writer this never touches.
let warnedThisProcess = false
function defaultStderr(message: string): void {
  if (warnedThisProcess) return
  warnedThisProcess = true
  process.stderr.write(message)
}

/**
 * Whether ANY sink in this process may fall back to the checked-out branch
 * for an event that names no task.
 *
 * On by default: the process this feature exists for is a one-task one — a
 * `vinaya check` run by the pre-push hook or by CI, on a task's branch, with
 * no `VINAYA_TASK` anywhere. A process that serves SEVERAL tasks in one
 * lifetime is the opposite case and turns it off (`setBranchIssueFallback(
 * false)`): `vinaya task-tools serve` holds calls for different tasks in
 * flight, runs in the MAIN checkout, and emits events that carry no task by
 * design (the broker's own Operator-channel `authenticate-invocation`
 * lines, including its refusals of forged invocations). Letting those fall
 * back would file them under whatever unrelated task the main checkout
 * happens to be on — and the answer is memoised, so one early lookup would
 * fix that wrong Issue for the life of the server, surviving every branch
 * switch. `issue: null` is the honest record there (round 3 security
 * review, HIGH).
 */
let branchIssueFallbackEnabled = true

/**
 * The branch answer, memoised for the PROCESS rather than for one sink, keyed
 * by the directory it was read from.
 *
 * Per-sink was the earlier bound, and it was one lookup short of the claim
 * this doctrine makes: a process builds several sinks — the module-level
 * default one, the loop driver's, a cancel's, one per `dispatchRole` call
 * whose own synthetic env drops `VINAYA_TASK` — so a process dispatching N
 * task-less roles paid N+1 `git rev-parse` reads and, on a tranche branch,
 * N+1 `gh` round trips, each against its own deadline (round 4 review,
 * MINOR; round 4 security review, LOW). Keyed by `cwd` because that is the
 * only input the read has: two sinks reading the same directory cannot
 * honestly disagree, and two reading different worktrees must not share.
 *
 * A branch switch inside one process's lifetime is therefore not observed —
 * which is exactly why a process that serves several tasks turns the whole
 * fallback off (`setBranchIssueFallback`) instead of relying on a re-read.
 */
const branchIssueByCwd = new Map<string, Promise<number | null>>()

/**
 * The bounded read, shared across this process when it is the REAL one and
 * kept private when a caller injected its own.
 *
 * The distinction is not a test affordance: "what branch is checked out in
 * this directory" is a process-wide FACT, so the real read is shared, while
 * an injected reader is a caller's own seam whose answer is that caller's
 * alone — sharing it under a directory key would let one caller's stub decide
 * another's attribution (this is exactly how a shared key crossed two callers
 * in one test process and resolved a real Issue for a caller that had asked
 * for none).
 */
function branchIssueRead(key: string, read: () => Promise<number | null>, shared: boolean): Promise<number | null> {
  if (!shared) return withDeadline(Promise.resolve().then(read), LOG_CONTEXT_LOOKUP_DEADLINE_MS, null)
  const cached = branchIssueByCwd.get(key)
  if (cached !== undefined) return cached
  const reading = withDeadline(Promise.resolve().then(read), LOG_CONTEXT_LOOKUP_DEADLINE_MS, null)
  branchIssueByCwd.set(key, reading)
  return reading
}

/** Set once, at a process's own entry point, before it builds any sink. */
export function setBranchIssueFallback(enabled: boolean): void {
  branchIssueFallbackEnabled = enabled
}

/**
 * `resolveBranchIssue` is deliberately NOT one of these: its real default
 * has to follow the SINK's own `cwd`, which only exists once the overrides
 * are merged, so `createLogSink` binds it there (and `resolveLogAppendPath`
 * binds its own, below, against the same `cwd`).
 */
function defaultDeps(): Omit<LogSinkDeps, 'resolveBranchIssue'> {
  return {
    outboxRoot: () => join(GLOBAL_VINAYA_HOME, 'outbox'),
    home: () => homedir(),
    hostname: () => osHostname(),
    cwd: () => process.cwd(),
    now: () => new Date(),
    env: () => process.env,
    resolveRepo: () => resolveRepoDefault(),
    vinayaVersion: () => readVinayaVersion(),
    stderr: defaultStderr,
    inputVersions: () => undefined,
    resolveLogDestination: defaultResolveLogDestination
  }
}

// `O_NOFOLLOW` makes the kernel refuse an open through a symlink outright
// (`ELOOP`) instead of trusting a separate `lstatSync` taken a moment
// earlier — the same TOCTOU class `metering-io-guard.ts` closes on the read
// side (open-then-`fstat`, never stat-then-open). `O_NONBLOCK` is defensive
// against a planted FIFO: opening one for writing in blocking mode waits for
// a reader that may never come.
const APPEND_OPEN_FLAGS =
  fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK

function guardedAppendOpen(path: string): number | undefined {
  try {
    return openSync(path, APPEND_OPEN_FLAGS, 0o600)
  } catch {
    return undefined
  }
}

/**
 * One hardened append, with no rotation: the `0o700` directory, the
 * `O_NOFOLLOW`/`O_NONBLOCK` open, the `fstat` of the already-open descriptor
 * and the `0o600` mode `appendLine` below uses, minus the rotation only a
 * queue file wants. Returns `null` on success, or the reason it could not
 * write — never throws, and never decides for its caller what a failure
 * means. `log-webhook-drain.ts` writes the rejected file beside the queue
 * through this, so a line the storage contract cannot vouch for is kept with
 * exactly the hardening the queue itself carries rather than a second,
 * drifting copy of these flags.
 */
export function appendHardenedLine(path: string, line: string): string | null {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const fd = guardedAppendOpen(path)
    if (fd === undefined) return `target could not be opened (symlink, FIFO, or unwritable): ${path}`
    try {
      if (!fstatSync(fd).isFile()) return `target is not a regular file: ${path}`
      writeSync(fd, line)
    } finally {
      closeSync(fd)
    }
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/**
 * Before a rotation overwrites `<name>.1.ndjson`, reads whatever that backup
 * currently holds and reports the identities about to be permanently
 * destroyed — an `OverflowDiagnostic` (the typed storage contract's own
 * shape, `packages/aeg-core/src/log/store.ts`) computed via that module's
 * `recordIdentity()`, the same identity function the fixture backend and the
 * flush's read-back share (O1). This is what O2's "retention and overflow
 * expose observable loss diagnostics" closes: the prior rotation overwrote
 * this slot with no record of what it held. No existing backup (the first
 * rotation ever, or one already reported and since re-rotated with nothing
 * new in between) reports nothing — there is nothing to lose. Identities are
 * capped in the printed message to keep one `warn` call bounded; `dropped`
 * itself is always the true, uncapped count.
 */
function reportRotationOverflow(backupPath: string, warn: (message: string) => void): void {
  let raw: string
  try {
    raw = readFileSync(backupPath, 'utf8')
  } catch {
    return
  }
  const lines = raw.split('\n').filter((l) => l.length > 0)
  if (lines.length === 0) return
  const droppedIdentities: string[] = lines.map((line, i) => {
    try {
      return recordIdentity(JSON.parse(line)) ?? `unreadable:${i}`
    } catch {
      return `unreadable:${i}`
    }
  })
  const diagnostic: OverflowDiagnostic = { reason: 'capacity', dropped: droppedIdentities.length, droppedIdentities }
  const shown = diagnostic.droppedIdentities.slice(0, 20)
  const more = diagnostic.dropped > shown.length ? `, +${diagnostic.dropped - shown.length} more` : ''
  warn(
    `vinaya: log outbox rotation is overwriting ${backupPath} — ${diagnostic.dropped} record(s) permanently lost: ${shown.join(', ')}${more}\n`
  )
}

/**
 * Appends `line` to `path`, hardened: `mkdirSync(dir, { recursive: true,
 * mode: 0o700 })`; opens with `O_NOFOLLOW` (refuses a symlink target
 * atomically, no separate stat-then-open race) and `fstat`s the already-open
 * descriptor — never re-resolves the path — to confirm a regular file and
 * read its live size for rotation. Rotates to `<name>.1.ndjson` (overwriting
 * an older one, reported first via `reportRotationOverflow`) when the live
 * file is already at the cap, then reopens fresh, still `O_NOFOLLOW`-guarded.
 * One `writeSync` + close. Never throws — every failure funnels into `warn`.
 */
function appendLine(path: string, line: string, warn: (message: string) => void): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    let fd = guardedAppendOpen(path)
    if (fd === undefined) {
      warn(`vinaya: log outbox target could not be opened (symlink, FIFO, or unwritable) — refusing: ${path}\n`)
      return
    }
    let closed = false
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile()) {
        warn(`vinaya: log outbox target is not a regular file — refusing to write: ${path}\n`)
        return
      }
      if (stat.size > OUTBOX_MAX_BYTES) {
        closeSync(fd)
        closed = true
        const backupPath = path.replace(/\.ndjson$/, '.1.ndjson')
        reportRotationOverflow(backupPath, warn)
        renameSync(path, backupPath)
        const rotated = guardedAppendOpen(path)
        if (rotated === undefined) {
          warn(`vinaya: log outbox target could not be reopened after rotation — refusing: ${path}\n`)
          return
        }
        fd = rotated
        closed = false
      }
      writeSync(fd, line)
    } finally {
      if (!closed) closeSync(fd)
    }
  } catch (err) {
    warn(`vinaya: log outbox write failed — ${err instanceof Error ? err.message : String(err)}\n`)
  }
}

/** Injectable for tests; the default instance below is wired to the real reads (env, git, the resolved `logs` destination). */
export function createLogSink(overrides: Partial<LogSinkDeps> = {}): {
  log: (e: LogEventInput) => void
  runId: string
  warmup: () => void
  drain: () => Promise<void>
} {
  const deps: LogSinkDeps = {
    ...defaultDeps(),
    // Bound here, not in `defaultDeps`, so the branch and the repository an
    // event is attributed to are read from the SAME directory every other
    // read this sink makes uses (`resolveDoctrine(deps.cwd(), …)`) — a sink
    // given a `cwd` of its own never reports its own `meta.repo` from one
    // checkout and its branch-derived `subject.issue` from another.
    resolveBranchIssue: (repo) => resolveBranchIssue(deps.cwd(), deps.env(), repo),
    ...overrides
  }
  const runId = deps.env().VINAYA_RUN_ID || randomUUID()
  // Opaque per-process identifier (O1) — one per sink instance, same
  // lifetime as `runId`, but a distinct concept: `runId` correlates a
  // dispatch chain across processes, `processId` names exactly this one.
  const processId = randomUUID()
  let seq = 0
  let warned = false
  const warnOnce = (message: string): void => {
    if (warned) return
    warned = true
    try {
      deps.stderr(message)
    } catch {
      // never throw out of the warn path either
    }
  }
  let doctrineCache: Promise<string> | undefined
  const doctrine = (): Promise<string> => {
    if (doctrineCache === undefined) {
      doctrineCache = withDeadline(
        resolveDoctrine(deps.cwd(), deps.vinayaVersion()),
        LOG_CONTEXT_LOOKUP_DEADLINE_MS,
        deps.vinayaVersion()
      )
    }
    return doctrineCache
  }

  // The Issue the checked-out branch names — the REAL read resolved at most
  // ONCE per process per working directory (`branchIssueByCwd`), its result
  // (a `null` "this branch names none" included) reused by every later event
  // and by every other sink this process builds, and only ever reached for by
  // an event whose own `VINAYA_TASK` is absent. A sink given a reader of its
  // own keeps that answer to itself — see `branchIssueRead`. Bounded here, at the one call site, by the same
  // deadline the shared context's own lookups carry: a `gh` that is slow,
  // unauthenticated, or missing altogether costs one deadline for the whole
  // process and then answers `null` for good — never a per-event forge call,
  // never a dropped event.
  const readerIsReal = overrides.resolveBranchIssue === undefined
  let ownBranchIssue: Promise<number | null> | undefined
  const branchIssueOnce = (repo: RepoRef | null): Promise<number | null> => {
    // A process that serves several tasks answers `null` here without ever
    // reading a branch — see `setBranchIssueFallback`.
    if (!branchIssueFallbackEnabled) return Promise.resolve(null)
    const slug = safeRepoSlug(repo)
    const read = (): Promise<number | null> => deps.resolveBranchIssue(slug)
    if (readerIsReal) return branchIssueRead(`${deps.cwd()}\u0000${slug ?? ''}`, read, true)
    if (ownBranchIssue === undefined) ownBranchIssue = branchIssueRead(deps.cwd(), read, false)
    return ownBranchIssue
  }

  // `deps.resolveRepo()` (the real default is `@attalabs/aeg-forge-state`'s
  // `resolveRepo`) is called at most ONCE per sink, its result — including a
  // failed `null` — cached for every later `log()` call in this process.
  // `resolveRepo` itself deliberately does NOT cache a failure (a transient
  // git-remote lookup error should retry on the NEXT call, in ITS docs'
  // words) — correct for its own callers, wrong for a chokepoint every
  // check attempt now reaches once each: a process running `vinaya check
  // --all` calls `log()` once per check (dozens, `runChecks`'s own
  // per-check chokepoint), and a `cwd` outside any git repository makes
  // every one of those spawn its own `git remote get-url origin` subprocess
  // with its own 5s timeout — measured live, running many such processes
  // concurrently (the shape a CI matrix or a parallel test suite both take)
  // stalls indefinitely under the resulting fork/exec pressure, where the
  // otherwise-identical run without this per-check chokepoint completes in
  // seconds. A repo identity cannot change mid-process, so caching the
  // failure here is exactly as safe as caching the success already was.
  let resolveRepoCache: ReturnType<LogSinkDeps['resolveRepo']> | undefined
  const resolveRepoOnce = (): ReturnType<LogSinkDeps['resolveRepo']> => {
    if (resolveRepoCache === undefined) resolveRepoCache = deps.resolveRepo()
    return resolveRepoCache
  }

  // Resolved at most once per sink instance, from the FIRST resolved repo —
  // a `url` destination can cost a network read (`loadTrustAnchorConfigAsync`),
  // which an unattended run must not repeat on every single event (O4: "a
  // destination that cannot accept an event never … slows a run").
  //
  // Everything a line needs beyond its own event — the repo, the doctrine,
  // the destination — is resolved ONCE into this one shared context, and
  // every resolution step is asynchronous: nothing on `log()`'s path ever
  // blocks the event loop. That is load-bearing, not style. The first event
  // commonly lands while a batch of async children is still running
  // (`runChecks` logs each check as it finishes; the loop logs while its
  // roles run), and a synchronous spawn at that moment can swallow those
  // children's exit — neither 'close' nor 'exit' is delivered, and the
  // runner records a finished check as a timeout.
  // `tests/lib/log-sink-no-sync-spawn.test.ts` holds this: it makes every
  // synchronous spawn throw and requires a real line to land anyway.
  //
  // Every `log()` call awaits this SAME promise and then writes
  // synchronously, so lines land in call order.
  type SinkContext = { repo: RepoRef | null; doctrine: string; destination: ResolvedLogDestination }
  let contextCache: Promise<SinkContext> | undefined
  const context = (): Promise<SinkContext> => {
    if (contextCache === undefined) {
      const env = deps.env()
      contextCache = Promise.all([
        withDeadline(resolveRepoOnce(), LOG_CONTEXT_LOOKUP_DEADLINE_MS, null),
        doctrine()
      ]).then(async ([resolved, doctrineValue]) => {
        const repo = resolved && isSafeRepoSegment(resolved.owner) && isSafeRepoSegment(resolved.repo) ? resolved : null
        return { repo, doctrine: doctrineValue, destination: await deps.resolveLogDestination(repo, env) }
      })
    }
    return contextCache
  }

  // Every `url`-destination append schedules a drain of the local retry
  // queue right after it — chained onto this SAME promise, never fired
  // concurrently with a prior drain, so two drains can never race each
  // other's read-then-truncate of the identical queue file (Traps: "serialize
  // drains so order is preserved"). A failed drain leaves the queue holding
  // exactly what the server never acknowledged — whole, when the server was
  // unreachable from the first chunk; minus the chunks it did accept, when a
  // backlog was part-way delivered — and the NEXT event's own drain resumes
  // from that same head, so delivery catches back up in order once the server
  // is back, with no separate retry timer of this sink's own.
  let drainChain: Promise<void> = Promise.resolve()

  // O3: the set of `log()` calls whose write has not yet landed — `context()`
  // is asynchronous (the shared repo/doctrine/destination resolution above),
  // so an abrupt `process.exit()` between a `log()` call and its own
  // `.then()` continuation running would otherwise drop that event's write
  // entirely: `process.exit` tears the process down immediately, with no
  // microtask draining, unlike a normal fall-off-the-end-of-main exit (which
  // lets the event loop finish everything already scheduled). `drain()`
  // below is the loop's own answer — awaited ONCE at an abrupt exit, never
  // per event, so `log()` itself stays exactly as fire-and-forget as it was.
  const pendingWrites = new Set<Promise<void>>()

  /** The tail of this sink's serialized writes — see `log()`'s own comment on why order is held here rather than by the shared context. */
  let writeChain: Promise<void> = Promise.resolve()

  const scheduleWebhookDrain = (
    issue: number | null,
    url: string,
    headers: Record<string, string> | undefined
  ): void => {
    drainChain = drainChain
      .then(() => drainOutboxToWebhook(issue, url, headers))
      .then(() => undefined)
      .catch((err) => {
        warnOnce(
          `vinaya: log delivery to ${url} failed — queued in the local outbox, retried on the next event: ${err instanceof Error ? err.message : String(err)}\n`
        )
      })
  }

  function log(e: LogEventInput): void {
    try {
      const env = deps.env()
      const host = hostFromEnv(env)
      const now = deps.now()
      const mySeq = seq++
      // Captured synchronously, as plain values, at the moment `log()` is
      // called — never a live reference into `env` read later inside the
      // `.then()` below. The real `deps.env()` IS `process.env` itself (one
      // shared, mutable object across the whole process), and this module's
      // own callers set VINAYA_TASK/VINAYA_RUN for the duration of a single
      // `log()` call, then restore them (`dev-review-loop.ts`'s
      // `cancelDevReviewLoop`) — safe in a one-task-
      // per-process CLI, but the multi-tenant `vinaya task-tools serve` MCP
      // server (`task-tools/server.ts`) dispatches calls for DIFFERENT tasks
      // without awaiting each to completion before the next. Reading `env.*`
      // lazily inside the `.then()` would race: this call's own header could
      // pick up a CONCURRENT caller's task/run value if that caller's own
      // mutation lands between this synchronous call and the microtask
      // below. Snapshotting here closes that race regardless of what
      // `process.env` does afterward (round 2 security review, HIGH).
      const envFields = {
        role: env.VINAYA_ROLE,
        task: env.VINAYA_TASK,
        round: env.VINAYA_ROUND,
        // "Linked to the current run" —
        // a producer that structurally knows a broader run identity
        // (the dev-review-loop driver sets `VINAYA_RUN` to its own
        // `loop_id` once one exists) still wins; absent that, this
        // process's own `runId` — already the identity every event
        // this process emits shares via `meta.run_id` — is a truthful,
        // non-invented default rather than leaving the slot `null`
        // forever for want of a caller that never opts in.
        run: env.VINAYA_RUN || runId,
        attempt: env.VINAYA_ATTEMPT,
        parent: env.VINAYA_PARENT_EVENT
      }
      const write = async (): Promise<void> => {
        const { repo, doctrine: doctrineValue, destination: resolvedDestination } = await context()
        if (resolvedDestination.kind === 'none') {
          // O3: one visible line per process — never per event, which would
          // spam a CI job's output once per check — naming exactly why
          // nothing is being recorded (no server configured, or this job
          // holds no delivery credential). Never a failure: recording
          // nothing is the sanctioned outcome here, not a degraded one.
          //
          // Checked BEFORE the branch lookup below, never after: a process
          // recording nothing must spend no `git rev-parse`, and above all
          // no credentialed `gh issue list`, resolving an attribution no
          // event will ever carry (round 1 security review, LOW) — the CI
          // job deliberately built to hold no delivery credential is
          // exactly the one that would otherwise pay that forge call on
          // every check it runs.
          warnOnce(`vinaya: not recording — ${resolvedDestination.reason}\n`)
          return
        }
        // Only an event whose own snapshot carries no task asks the branch
        // what task this is; every `log()` call that does await the SAME
        // memoised promise. Call order is held by the write chain below,
        // not by this await, so an event that skips the lookup can never
        // overtake an earlier one that waited for it.
        const branchIssue = envFields.task ? null : await branchIssueOnce(repo)
        const header = buildHeader({
          now,
          runId,
          seq: mySeq,
          repo: repo ? `${repo.owner}/${repo.repo}` : null,
          vinaya: deps.vinayaVersion(),
          doctrine: doctrineValue,
          host,
          hostname: deps.hostname(),
          env: envFields,
          branchIssue,
          eventId: randomUUID(),
          processId,
          inputVersions: deps.inputVersions()
        })
        // `header` spreads LAST: it carries the only trusted `meta`/`subject`
        // values (environment/remote/package/tree-derived), and `e`'s type
        // excludes those keys but a caller passing a wider-typed or `as any`
        // value could still smuggle a `meta`/`subject` property through —
        // TS's excess-property check only fires on a fresh object literal,
        // never on a variable. Spreading `header` second means a forged
        // field in `e` is always overwritten, never honored.
        const full = { ...e, ...header }
        const parsed = LogEventSchema.safeParse(full)
        if (!parsed.success) {
          warnOnce(
            `vinaya: log() refused an invalid payload — ${parsed.error.issues[0]?.message ?? 'schema violation'}\n`
          )
          return
        }
        const line = `${JSON.stringify(redact(parsed.data, deps.home()))}\n`
        const destination = resolvedDestination
        if (destination.kind === 'server') {
          // The local outbox is the retry queue for a server destination
          // (O2) — appended first, synchronously with every other
          // destination, THEN drained: the append itself never waits on
          // the network (Traps: "append locally first, drain
          // asynchronously").
          appendLine(outboxPathFor(deps, repo, header.subject.issue), line, warnOnce)
          scheduleWebhookDrain(header.subject.issue, destination.url, destination.headers)
        } else {
          appendLine(
            outboxPathFor({ outboxRoot: () => destination.folder }, repo, header.subject.issue),
            line,
            warnOnce
          )
        }
      }
      // Every event's write is queued behind the one before it, so the
      // outbox holds them in `log()` call order — the order `meta.seq`
      // already numbers them in. The shared `context()` promise used to
      // give that for free (one promise, continuations run in subscription
      // order), but it no longer can on its own: an event that names its
      // own task skips the branch lookup and would otherwise run a
      // microtask ahead of an earlier event that awaited it, landing its
      // line first with the higher `seq`. `log()` itself stays
      // fire-and-forget — nothing here is awaited by the caller — and one
      // failing write never stalls the chain, because each link catches
      // its own error before the next begins.
      const written: Promise<void> = writeChain.then(write).catch((err) => {
        warnOnce(`vinaya: log() failed — ${err instanceof Error ? err.message : String(err)}\n`)
      })
      writeChain = written
      pendingWrites.add(written)
      written.finally(() => pendingWrites.delete(written))
    } catch (err) {
      warnOnce(`vinaya: log() failed — ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }

  // Starts the shared context's resolution now instead of on this sink's
  // first `log()` call, so it is usually already settled by the time the
  // first event arrives. An optimisation only: every step of that
  // resolution is asynchronous, so starting it late never blocks anything.
  const warmup = (): void => {
    // `resolveRepo` (`@attalabs/aeg-forge-state`) prints its own
    // `console.warn` straight to this process's real stderr when the
    // lookup fails (no git repo, or a repo with no configured `origin`) —
    // reasonable for its own pre-existing callers, but this warmup call is
    // background telemetry setup, not a user-facing action, and the noise
    // lands on the SAME stream a caller like `runIssueChecks`/`vinaya check`
    // routes a check's own findings through. Suppressed only around this
    // ONE call: it is the very first thing `runChecks` does, before any
    // check has even spawned, so nothing else could legitimately want to
    // warn during this exact window — restored the moment the promise
    // settles, success or failure, never left off.
    const originalWarn = console.warn
    console.warn = () => {}
    resolveRepoOnce().finally(() => {
      console.warn = originalWarn
    })
    context().catch(() => undefined)
  }

  /**
   * O3: waits for every `log()` call still in flight — `pendingWrites` — to
   * finish landing (the synchronous `appendLine` a settled `context()`
   * triggers), then for the webhook retry-queue drain chain those writes may
   * have just scheduled to settle too. A single pass suffices: each
   * `pendingWrites` entry only resolves AFTER its own `.then()` body (which
   * calls `scheduleWebhookDrain` synchronously, when the destination is a
   * server) has already run, so by the time every entry has settled,
   * `drainChain` already reflects every drain this batch of writes
   * scheduled — no further writes are produced once a caller starts
   * draining, since `drain()` is only ever called on the way out. Never
   * called per event (Traps to avoid) — only once, from an abrupt exit path.
   */
  const drain = async (): Promise<void> => {
    if (pendingWrites.size > 0) await Promise.allSettled(Array.from(pendingWrites))
    await drainChain.catch(() => undefined)
  }

  return { log, runId, warmup, drain }
}

const defaultSink = createLogSink()

/**
 * The current process's own `run_id` — fixed once, for the process lifetime,
 * at `defaultSink`'s construction (`VINAYA_RUN_ID` or a fresh `randomUUID()`).
 * `dev-review-loop.ts`'s `cancelDevReviewLoop` reads this to tell its OWN
 * fire-and-forget `log()` call apart from a concurrent, unrelated process
 * appending to the same outbox file at the same moment (a code-review
 * finding) — a bare "did the file grow" signal cannot make that distinction
 * on its own.
 */
export function currentRunId(): string {
  return defaultSink.runId
}

/**
 * `log(e)` — the one call site every chokepoint (`dispatchRole`,
 * `devReviewLoop`, `runChecks`, `forgeWrite`, `collectTokens`) reaches to
 * record an act. Fills `meta`/`subject` from the environment, the remote,
 * the package and the tree; validates against `LogEventSchema`; appends one
 * ndjson line to the configured `logs` destination — a folder's own
 * `<repository>/<task>.ndjson` (the default, under this repository's own
 * `runtimeDir`), or the local retry queue ahead of a `logs.url` server drain
 * (`apps/cli/specs/log.md` § The destination). Returns `void`, never throws.
 */
export function log(e: LogEventInput): void {
  defaultSink.log(e)
}

/**
 * Starts the default sink's one-time context resolution (repo, doctrine,
 * destination) now rather than on its first `log()` call, so it is usually
 * settled before a batch of checks starts finishing (`runChecks` calls this
 * first). An optimisation only — that resolution never blocks the event
 * loop, so calling it late, or not at all, is still correct. A no-op on
 * every subsequent call in the same process.
 */
export function warmupLogSink(): void {
  defaultSink.warmup()
}

/**
 * Waits for every `log()` call the default sink has in flight to land on
 * its destination, then for any webhook drain those writes scheduled to
 * settle — O3, "no pending write is dropped because the process ended
 * first." `log()` itself stays fire-and-forget for every caller; this is
 * the ONE place a caller about to end the process (`process.exit`, never a
 * normal fall-off-the-end-of-main exit, which already lets pending
 * microtasks run) awaits the difference. Called once per abrupt exit, never
 * per event.
 */
export async function drainLogSink(): Promise<void> {
  await defaultSink.drain()
}
