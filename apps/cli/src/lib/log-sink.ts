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
    }
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

  function log(e: LogEventInput): void {
    try {
      const env = deps.env()
      const host = hostFromEnv(env)
      const now = deps.now()
      const mySeq = seq++
      deps
        .resolveRepo()
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
            env: {
              role: env.VINAYA_ROLE,
              task: env.VINAYA_TASK,
              round: env.VINAYA_ROUND,
              // Not yet set by any caller — read now so the envelope carries
              // the slot honestly `null` today, real once a future producer
              // starts setting it.
              run: env.VINAYA_RUN,
              attempt: env.VINAYA_ATTEMPT,
              parent: env.VINAYA_PARENT_EVENT
            },
            eventId: randomUUID(),
            processId
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

  return { log, runId }
}

const defaultSink = createLogSink()

/**
 * The current process's own `run_id` — fixed once, for the process lifetime,
 * at `defaultSink`'s construction (`VINAYA_RUN_ID` or a fresh `randomUUID()`).
 * `vinaya log flush` reads this to tell its OWN fire-and-forget `log()` call
 * apart from a concurrent, unrelated process appending to the same outbox
 * file at the same moment (code review, PR #439) — a bare "did the file
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
