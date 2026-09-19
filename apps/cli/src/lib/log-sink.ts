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
import { GLOBAL_VINAYA_HOME } from './config.js'
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
 * The telemetry outbox's own root, under the machine's Vinaya home.
 *
 * Deliberately NOT under `runtimeDir` (`run-paths.ts`), and named here so
 * that stays a decision rather than an accident: telemetry is the one class
 * of file a task's run writes that did NOT move into the task folder,
 * because where log events are delivered is itself changing and moving the
 * outbox first would mean moving it twice.
 * `apps/cli/tests/run-paths-only.test.ts` names this module as the single
 * exception to "no file outside `run-paths.ts` assembles a run-file path."
 *
 * The driver used to thread ONE root for both this and its own per-task
 * files, so a test redirecting one silently redirected the other; the two
 * are separate deps now (`LoopDeps.telemetryOutboxRoot` vs
 * `LoopDeps.runtimeDir`).
 */
export function telemetryOutboxRoot(): string {
  return join(GLOBAL_VINAYA_HOME, 'outbox')
}

/**
 * The outbox path `log()` writes to and `vinaya log flush` reads from —
 * keyed by repo (or `unresolved`, never a value from an unvalidated
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
    inputVersions: () => undefined
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

/** Injectable for tests; the default instance below is wired to the real reads (env, git, the outbox under `GLOBAL_VINAYA_HOME`). */
export function createLogSink(overrides: Partial<LogSinkDeps> = {}): {
  log: (e: LogEventInput) => void
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
          appendLine(outboxPathFor(deps, repo, header.subject.issue), line, warnOnce)
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

  return { log, runId, warmup }
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
 * `log(e)` — the one call site every future chokepoint (`dispatchRole`,
 * `devReviewLoop`, and later `runChecks`/`forgeWrite`/the CLI wrapper/
 * `collectTokens`) reaches to record an act. Fills `meta`/`subject` from the
 * environment, the remote, the package and the tree; validates against
 * `LogEventSchema`; appends one ndjson line under
 * `~/.vinaya/outbox/<owner>-<repo>/<issue-or-none>.ndjson`. Returns `void`,
 * never throws.
 */
export function log(e: LogEventInput): void {
  defaultSink.log(e)
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
