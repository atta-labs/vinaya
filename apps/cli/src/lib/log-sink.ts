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
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { hostname as osHostname, homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveRepo as resolveRepoDefault } from '@attalabs/aeg-forge-state'
import { buildHeader, type Host, type LogEvent, LogEventSchema, redact } from '@attalabs/aeg-core'
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

/**
 * Appends `line` to `path`, hardened: `mkdirSync(dir, { recursive: true,
 * mode: 0o700 })`; `lstatSync` refuses (fails open, writes nothing) a
 * symlink or anything not a regular file; rotates to `<name>.1.ndjson`
 * (overwriting an older one) when the live file is already at the cap;
 * `openSync(path, 'a', 0o600)` + one `writeSync` + close. Never throws —
 * every failure funnels into `warn`.
 */
function appendLine(path: string, line: string, warn: (message: string) => void): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    let stat: ReturnType<typeof lstatSync> | undefined
    try {
      stat = lstatSync(path)
    } catch {
      stat = undefined
    }
    if (stat !== undefined) {
      if (stat.isSymbolicLink() || !stat.isFile()) {
        warn(`vinaya: log outbox target is a symlink or not a regular file — refusing to write: ${path}\n`)
        return
      }
      if (stat.size > OUTBOX_MAX_BYTES) {
        renameSync(path, path.replace(/\.ndjson$/, '.1.ndjson'))
      }
    }
    const fd = openSync(path, 'a', 0o600)
    try {
      writeSync(fd, line)
    } finally {
      closeSync(fd)
    }
  } catch (err) {
    warn(`vinaya: log outbox write failed — ${err instanceof Error ? err.message : String(err)}\n`)
  }
}

/** Injectable for tests; the default instance below is wired to the real reads (env, git, the outbox under `GLOBAL_VINAYA_HOME`). */
export function createLogSink(overrides: Partial<LogSinkDeps> = {}): { log: (e: LogEventInput) => void } {
  const deps: LogSinkDeps = { ...defaultDeps(), ...overrides }
  const runId = deps.env().VINAYA_RUN_ID || randomUUID()
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
        .then((repo) => {
          const header = buildHeader({
            now,
            runId,
            seq: mySeq,
            repo: repo ? `${repo.owner}/${repo.repo}` : null,
            vinaya: deps.vinayaVersion(),
            doctrine: doctrine(),
            host,
            hostname: deps.hostname(),
            env: { role: env.VINAYA_ROLE, task: env.VINAYA_TASK, round: env.VINAYA_ROUND }
          })
          const full = { ...header, ...e }
          const parsed = LogEventSchema.safeParse(full)
          if (!parsed.success) {
            warnOnce(
              `vinaya: log() refused an invalid payload — ${parsed.error.issues[0]?.message ?? 'schema violation'}\n`
            )
            return
          }
          const line = `${JSON.stringify(redact(parsed.data, deps.home()))}\n`
          const dirName = repo ? `${repo.owner}-${repo.repo}` : 'unresolved'
          const fileName = `${header.subject.issue ?? 'none'}.ndjson`
          appendLine(join(deps.outboxRoot(), dirName, fileName), line, warnOnce)
        })
        .catch((err) => {
          warnOnce(`vinaya: log() failed — ${err instanceof Error ? err.message : String(err)}\n`)
        })
    } catch (err) {
      warnOnce(`vinaya: log() failed — ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }

  return { log }
}

const defaultSink = createLogSink()

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
