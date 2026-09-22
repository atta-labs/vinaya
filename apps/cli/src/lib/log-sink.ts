/**
 * The one write for the Vinaya Log (Linear "Tech spec — The Vinaya Log" rev
 * 4, §8 layer 2, §9). Every environment read, remote read, package read,
 * hostname and git call lives here; `packages/aeg-core/src/log/` stays pure
 * (schema, envelope, redaction) and never writes.
 *
 * `log()` never throws. Every failure path returns; at most one
 * `process.stderr.write` per process, guarded by a module-level flag.
 */

import { execFileSync } from 'node:child_process'
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
import { resolveRepo as resolveRepoDefault } from '@attalabs/aeg-forge-state'
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
  loadTrustAnchorConfig,
  resolveLogsHeaderValues,
  resolveLogsSetting,
  resolveTrustAnchorLogsDestination,
  type LogsDestination,
  type VinayaConfig
} from './config.js'
import { isUnattendedProcess, runtimeDirForRepo } from './run-paths.js'
import { flushOutboxToWebhook } from './log-webhook-flush.js'
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
 * (`resolveDestinationOnce`, below) — a folder the sink appends directly to,
 * or a server drained from the local retry queue after every append
 * (`apps/cli/specs/log.md` § The destination).
 */
export type ResolvedLogDestination =
  | { kind: 'folder'; folder: string }
  | { kind: 'server'; url: string; headers?: Record<string, string> }

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
   * The `logs` setting's resolved destination for this process (O1/O4) —
   * `vinaya.config.json`'s `logs`, trust-anchor-gated for an unattended
   * caller exactly as `runtimeDir` already is, falling back to a folder
   * under this repository's own `runtimeDir` when unset. Called at most
   * once per sink instance (`resolveDestinationOnce`) — a `url` destination
   * can require a network read (`loadTrustAnchorConfig`) an unattended
   * caller must not repeat on every event.
   */
  resolveLogDestination: (repo: RepoRef | null, env: NodeJS.ProcessEnv) => ResolvedLogDestination
}

function safeLoadTrustAnchorConfig(): VinayaConfig | null {
  try {
    return loadTrustAnchorConfig()
  } catch {
    return null
  }
}

/**
 * The pure decision behind `LogSinkDeps.resolveLogDestination` — a `url`
 * destination is honoured only when the repository's default branch
 * declares the identical one for an unattended caller (round-2 security
 * review, HIGH, the same rule `runtimeDir`/`logPublish.webhookUrl` already
 * carry: a pull request under review cannot redirect where an unattended
 * run's telemetry is delivered by editing its own diff). An attended caller
 * — a human running `vinaya`, choosing to trust their own working tree —
 * honours the local value unchecked, the same trust level running
 * `vinaya.config.json`'s own `dispatch.agent` already carries.
 *
 * No `logs` setting resolved at all (the ordinary default, and every
 * refused/ungated case above) falls back to `defaultLogsFolder` — never "no
 * destination," since O1 declares a folder the default, not an opt-in.
 * Pure — takes the already-resolved local/trust-anchor config and the
 * per-repository default folder, so it is directly unit-testable with plain
 * objects, mirroring `run-paths.ts`'s own `resolveRuntimeDir`.
 */
export function resolveLogDestinationFrom(input: {
  localConfig: VinayaConfig | null
  trustAnchorConfig: VinayaConfig | null
  unattended: boolean
  env: NodeJS.ProcessEnv
  defaultFolder: string
}): ResolvedLogDestination {
  const local = resolveLogsSetting(input.localConfig)
  let effective: LogsDestination | null = null
  if (local) {
    effective = input.unattended ? resolveTrustAnchorLogsDestination(local, input.trustAnchorConfig) : local
  }
  if (effective && 'url' in effective) {
    return { kind: 'server', url: effective.url, headers: resolveLogsHeaderValues(effective.headers, input.env) }
  }
  const folder = effective && 'folder' in effective ? effective.folder : input.defaultFolder
  return { kind: 'folder', folder }
}

/**
 * The real resolution behind `LogSinkDeps.resolveLogDestination` — the
 * real-IO wrapper `resolveLogDestinationFrom` above needs (config reads, the
 * trust-anchor network read, the per-repository default folder).
 *
 * The trust-anchor read only ever runs when a `logs` setting is actually
 * configured LOCALLY — mirrors `run-paths.ts`'s own `resolveRuntimeDirUncached`
 * (`needsAnchor`): every dispatched role's child is unattended by
 * `isUnattendedProcess`'s own definition (`VINAYA_ROLE` is always set), so
 * without this guard every single dispatch would cost a `gh api` round trip
 * for a setting that, in the overwhelmingly common unconfigured case, was
 * never going to change the answer.
 */
function defaultResolveLogDestination(repo: RepoRef | null, env: NodeJS.ProcessEnv): ResolvedLogDestination {
  const localConfig = loadConfig()
  const unattended = isUnattendedProcess(env)
  const needsAnchor = unattended && resolveLogsSetting(localConfig) !== null
  return resolveLogDestinationFrom({
    localConfig,
    trustAnchorConfig: needsAnchor ? safeLoadTrustAnchorConfig() : null,
    unattended,
    env,
    defaultFolder: join(runtimeDirForRepo(repo), 'logs')
  })
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT'
}

/** `git -C <root> rev-parse HEAD:aeg-root` for a tree checkout; the CLI's own package version for a bundle; `'unknown'` when `git` itself is unreachable. Called once per sink instance, never per line. */
function resolveDoctrine(cwd: string, vinayaVersion: string): string {
  let toplevel: string
  try {
    toplevel = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  } catch (err) {
    return isEnoent(err) ? 'unknown' : vinayaVersion
  }
  if (!existsSync(join(toplevel, 'aeg-root', 'roles'))) return vinayaVersion
  try {
    const sha = execFileSync('git', ['-C', toplevel, 'rev-parse', 'HEAD:aeg-root'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
    return `aeg-root@${sha}`
  } catch {
    return vinayaVersion
  }
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

/**
 * The local retry-queue outbox's own root, under the machine's Vinaya home —
 * no longer where `log()` delivers by default (that moved to a folder under
 * this repository's own `runtimeDir`, `defaultResolveLogDestination` above),
 * but still the machine-local home `vinaya log flush` reads, and still where
 * `log()` itself appends first for a configured `logs.url` server
 * destination before draining (O2).
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
 * The retry-queue outbox path `vinaya log flush` reads from, and `log()`
 * itself appends to first for a `logs.url` server destination (O2) — keyed
 * by repo (or `unresolved`, never a value from an unvalidated
 * `resolveRepo()` result) and by Issue (or `none`), never by PR (task 2,
 * `apps/cli/specs/log.md`).
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
export function resolveLogAppendPath(
  repo: { owner: string; repo: string } | null,
  issue: number | null,
  overrides: Partial<Pick<LogSinkDeps, 'resolveLogDestination' | 'outboxRoot' | 'env'>> = {}
): string {
  const deps = { ...defaultDeps(), ...overrides }
  const destination = deps.resolveLogDestination(repo, deps.env())
  const root = destination.kind === 'server' ? deps.outboxRoot() : destination.folder
  return outboxPathFor({ outboxRoot: () => root }, repo, issue)
}

function hostFromEnv(env: NodeJS.ProcessEnv): Host {
  if (env.GITHUB_ACTIONS) return 'ci'
  if (env.VINAYA_HOST === 'hook') return 'hook'
  if (env.VINAYA_HOST === 'loop') return 'loop'
  return 'cli'
}

function defaultDeps(): LogSinkDeps {
  return {
    outboxRoot: () => join(GLOBAL_VINAYA_HOME, 'outbox'),
    home: () => homedir(),
    hostname: () => osHostname(),
    cwd: () => process.cwd(),
    now: () => new Date(),
    env: () => process.env,
    resolveRepo: () => resolveRepoDefault(),
    vinayaVersion: () => readVinayaVersion(),
    stderr: (message: string) => {
      process.stderr.write(message)
    },
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
  logToOutboxQueue: (e: LogEventInput) => void
  runId: string
  warmup: () => void
} {
  const deps: LogSinkDeps = { ...defaultDeps(), ...overrides }
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
  let doctrineCache: string | undefined
  const doctrine = (): string => {
    if (doctrineCache === undefined) doctrineCache = resolveDoctrine(deps.cwd(), deps.vinayaVersion())
    return doctrineCache
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
  // a `url` destination can cost a network read (`loadTrustAnchorConfig`),
  // which an unattended run must not repeat on every single event (O4: "a
  // destination that cannot accept an event never … slows a run").
  let destinationCache: ResolvedLogDestination | undefined
  const resolveDestinationOnce = (repo: RepoRef | null, env: NodeJS.ProcessEnv): ResolvedLogDestination => {
    if (destinationCache === undefined) destinationCache = deps.resolveLogDestination(repo, env)
    return destinationCache
  }

  // Every `url`-destination append schedules a drain of the local retry
  // queue right after it — chained onto this SAME promise, never fired
  // concurrently with a prior drain, so two drains can never race each
  // other's read-then-truncate of the identical queue file (Traps: "serialize
  // drains so order is preserved"). A failed drain (the server unreachable)
  // leaves the queue exactly as `flushOutboxToWebhook` already guarantees —
  // untouched, picked up whole by the NEXT event's own drain — so delivery
  // catches back up in order once the server is back, with no separate
  // retry timer of this sink's own.
  let drainChain: Promise<void> = Promise.resolve()
  const scheduleWebhookDrain = (
    issue: number | null,
    url: string,
    headers: Record<string, string> | undefined
  ): void => {
    drainChain = drainChain
      .then(() => flushOutboxToWebhook(issue, url, headers))
      .then(() => undefined)
      .catch((err) => {
        warnOnce(
          `vinaya: log delivery to ${url} failed — queued in the local outbox, retried on the next event: ${err instanceof Error ? err.message : String(err)}\n`
        )
      })
  }

  // `forcedDestination`, when given, bypasses `resolveDestinationOnce`
  // entirely for this one call — the retry-queue bookkeeping lines
  // `log-flush.ts`'s `logForFlush` writes (`forge_write` `validated`/
  // `written`/`refused`) must always land in the SAME queue file that
  // caller is about to read and truncate, never wherever a configured
  // `logs` destination happens to point. Sharing this instance's `runId`/
  // `seq`/doctrine/repo cache (rather than a second, independent sink) is
  // what keeps `(run_id, seq)` a genuinely unique pair — two sinks sharing
  // one `runId` would each start `seq` at 0 and collide.
  function log(e: LogEventInput, forcedDestination?: ResolvedLogDestination): void {
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
      // `log()` call, then restore them (`log-flush.ts`'s `logForFlush`,
      // `dev-review-loop.ts`'s `cancelDevReviewLoop`) — safe in a one-task-
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
      resolveRepoOnce()
        .then((resolved) => {
          const repo =
            resolved && isSafeRepoSegment(resolved.owner) && isSafeRepoSegment(resolved.repo) ? resolved : null
          const header = buildHeader({
            now,
            runId,
            seq: mySeq,
            repo: repo ? `${repo.owner}/${repo.repo}` : null,
            vinaya: deps.vinayaVersion(),
            doctrine: doctrine(),
            host,
            hostname: deps.hostname(),
            env: envFields,
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
          const destination = forcedDestination ?? resolveDestinationOnce(repo, env)
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
        })
        .catch((err) => {
          warnOnce(`vinaya: log() failed — ${err instanceof Error ? err.message : String(err)}\n`)
        })
    } catch (err) {
      warnOnce(`vinaya: log() failed — ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }

  // Forces `doctrine()`'s memoized resolution now, on demand, instead of
  // lazily on this sink's first `log()` call. `resolveDoctrine` is a
  // synchronous, blocking `execFileSync` — cheap once, but measured live:
  // when its FIRST run lands during a burst of several child processes
  // exiting at once (`runChecks` dispatching many checks concurrently, each
  // calling `log()` on completion), the resulting event-loop stall can
  // coincide with another child's own 'close' event delivery closely enough
  // that the event is never delivered at all — the check's own process
  // confirmed dead, but nothing left to resolve the `runOne` promise
  // waiting on it (see `apps/cli/src/checks/runner.ts`'s own safety-net
  // timeout, added for the case this call site cannot prevent). Calling
  // this once, deliberately, BEFORE that burst begins — `runChecks`'s own
  // job — means the blocking work is already done and cached by the time
  // any check's process has even been spawned, let alone exited. Harmless
  // to call from elsewhere or not at all: every other caller keeps the
  // existing lazy-on-first-log behavior this never changes.
  const warmup = (): void => {
    doctrine()
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
  }

  // Always the machine-local retry queue (`deps.outboxRoot()`), never the
  // configured `logs` destination — `log-flush.ts`'s own audit-trail lines
  // about a flush call must land beside the file that flush is reading and
  // about to truncate, regardless of where ordinary telemetry goes.
  const logToOutboxQueue = (e: LogEventInput): void => {
    log(e, { kind: 'folder', folder: deps.outboxRoot() })
  }

  return { log, logToOutboxQueue, runId, warmup }
}

const defaultSink = createLogSink()

/**
 * The current process's own `run_id` — fixed once, for the process lifetime,
 * at `defaultSink`'s construction (`VINAYA_RUN_ID` or a fresh `randomUUID()`).
 * `vinaya log flush` reads this to tell its OWN fire-and-forget `log()` call
 * apart from a concurrent, unrelated process appending to the same outbox
 * file at the same moment (a code-review finding) — a bare "did the file
 * grow" signal cannot make that distinction on its own.
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
 * `log-flush.ts`'s own chokepoint for a flush call's audit-trail lines
 * (`forge_write` `validated`/`written`/`refused`) — always the local retry
 * queue (`telemetryOutboxRoot()`), never a configured `logs` folder/server
 * destination, since these lines document the flush of THAT queue file and
 * must land beside it regardless of where ordinary telemetry is delivered.
 */
export function logToOutboxQueue(e: LogEventInput): void {
  defaultSink.logToOutboxQueue(e)
}

/**
 * Forces the default sink's one-time doctrine/repo resolution now rather
 * than on its first `log()` call — see `createLogSink`'s own `warmup` for
 * why this matters and when to call it (`runChecks`, before dispatching a
 * batch of checks whose completions could otherwise cluster around that
 * first call). A no-op on every subsequent call in the same process.
 */
export function warmupLogSink(): void {
  defaultSink.warmup()
}
