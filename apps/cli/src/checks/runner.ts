import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { cpus } from 'node:os'
import { globToRegex, type GateOutcome } from '@attalabs/aeg-core'
import { log as defaultLog, warmupLogSink, type LogEventInput } from '../lib/log-sink.js'
import { CHECK_SCHEMA_VERSION, type CheckError, type CheckOutcome, type CheckSpec, type CheckStatus } from './contract'

export type RunOptions = {
  /** Concurrency cap; excess checks queue. */
  parallel: number
  /** ring-1 default is diff-scoped. */
  diffOnly: boolean
  /** null = full scope (no skip logic applies, regardless of `diffOnly`). */
  changedFiles: string[] | null
  defaultTimeoutMs: number
  /**
   * Caller environment used both for the pre-spawn required-env check and
   * `buildCheckEnv`'s construction. Defaults to `process.env` — overridable
   * so tests can assert against a synthetic environment instead of the real
   * one the test process happens to be running under.
   */
  callerEnv?: NodeJS.ProcessEnv
  /**
   * Set by the generated `pre-commit`/`pre-push` hooks — never by CI, which
   * always runs after a PR is open. Skips every `requiresOpenPr` check
   * (`skipped`, not run) instead of letting them fail against a PR that
   * cannot exist yet at commit/push time. See `CheckSpec.requiresOpenPr`.
   */
  localOnly?: boolean
  /**
   * Post-tranche hygiene item 2, #397 round 2. Set by the generated
   * `pre-commit` hook only — never pre-push, never CI, both of which need
   * every `scope: 'full'` check to genuinely run. `--diff-only` cannot be
   * that switch: CI passes it too (`vinaya check --all --diff-only`), and
   * `shouldSkip` already runs every `scope: 'full'` check regardless of it
   * (see that function's own doc comment) — a `scope: 'full'` check has no
   * `changedFiles` list to test an `include` glob against in the first
   * place. `skipFull` is the first flag scoped narrowly enough to
   * distinguish "pre-commit, where a full-scope check is deferred to
   * pre-push/CI" from every other caller.
   */
  skipFull?: boolean
  /**
   * Injectable for tests — defaults to the process-wide Vinaya Log sink
   * (`../lib/log-sink.js`'s `log`), the same singleton every check attempt
   * in a real `vinaya check`/hook/CI invocation shares one `run_id` through
   * (one process, one correlated run). A test passes its
   * own capturing function instead of exercising the real outbox on disk.
   */
  log?: (e: LogEventInput) => void
}

/** A sane cpu-derived default — callers may override via `--parallel`. */
export function defaultParallelism(): number {
  return Math.max(1, cpus().length)
}

function isCheckError(value: unknown): value is CheckError {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    v.schema === CHECK_SCHEMA_VERSION &&
    typeof v.check === 'string' &&
    (v.severity === 'error' || v.severity === 'warning') &&
    typeof v.message === 'string' &&
    typeof v.agent_recovery_prompt === 'string'
  )
}

/**
 * `Vinaya Log`'s `gate` family chokepoint (`apps/cli/specs/log.md` "Six more
 * families") — the ONE place this runner records an attempted check's
 * observable outcome, for every terminal state `runOne`/`runChecks` can
 * reach (pass, fail-as-rejected, fail-as-waiting, skip, timeout, and the two
 * flavors of `error` this file distinguishes below), plus `cancelled` from
 * the SIGINT/SIGTERM path. Called exactly once per (spec, attempt) — there is
 * no retry inside this file, so there is nothing here that could double-emit
 * for one check.
 *
 * `check_version` is this contract's own schema version (`CHECK_SCHEMA_VERSION`
 * — every `CheckError` a check emits is validated against it); `policy_version`
 * is honestly `null` — no per-check policy-version concept exists in the
 * registry today (`CheckSpec` carries no version field, and a resolved
 * check's `core`/`overridden`/`additive` state never reaches this file) —
 * left for a later task to set for real, the same "declared, not yet real"
 * pattern `apps/cli/specs/log.md` already documents for `input_versions`/
 * `lineage`. `input_fingerprint` hashes the check's own real, constructed
 * input (its allowlisted env plus, for a diff-scoped check, its sorted
 * changed-file list) rather than transmitting it — a fingerprint identifies
 * the input without leaking a forwarded secret value. `reason` is always a
 * short structured code, never a check's own free-text message — the
 * message may itself echo PR/Issue body content the check was validating,
 * and a structured code is enough to distinguish one rejection shape from
 * another without repeating that content into the log.
 */
function logGateChecked(params: {
  spec: CheckSpec
  outcome: GateOutcome
  reason?: string
  durationMs: number
  fingerprint: string
  logFn: (e: LogEventInput) => void
}): void {
  params.logFn({
    kind: 'gate',
    event: 'checked',
    check: params.spec.name,
    check_version: String(CHECK_SCHEMA_VERSION),
    policy_version: null,
    input_fingerprint: params.fingerprint,
    outcome: params.outcome,
    ...(params.reason !== undefined ? { reason: params.reason } : {}),
    duration_ms: params.durationMs,
    payload: {}
  })
}

/**
 * Hashes exactly what `buildCheckEnv` actually constructs for this check's
 * child process, plus (for a `scope: 'diff'` check genuinely narrowed by
 * `--diff-only`) its sorted changed-file list — the two things that vary the
 * check's real input from one attempt to the next. A `sha256` digest, never
 * the values themselves: `env` may carry a forwarded token
 * (`{ anyOf: [...] }`/`true` declarations pull real caller secrets), and O2
 * forbids leaking one into the log.
 */
function inputFingerprintFor(spec: CheckSpec, opts: RunOptions, callerEnv: NodeJS.ProcessEnv): string {
  const env = buildCheckEnv(spec.env, callerEnv)
  const diffScope =
    spec.scope === 'diff' && opts.diffOnly && opts.changedFiles !== null ? [...opts.changedFiles].sort() : null
  const canonical = JSON.stringify({ env, diffScope })
  return createHash('sha256').update(canonical).digest('hex')
}

/**
 * A `scope: 'diff'` check is skipped when `--diff-only` is active, changed
 * files are known, the check declares `include` globs, and none match. A
 * check with no `include` globs declares no scoping preference and is never
 * skipped on that basis alone. `scope: 'full'` checks always run — UNLESS
 * `opts.skipFull` is set (pre-commit only, #397 round 2), which skips every
 * `scope: 'full'` check unconditionally, independent of `include`: a
 * full-scope check's own `include` (where declared) stays exactly what it
 * was before this flag existed — pinning/documentation only, never consulted
 * here — because `skipFull` is a blanket "defer every full-scope check to
 * pre-push/CI" switch, not a per-check scoping decision.
 *
 * Independently, a `requiresOpenPr` check is skipped whenever `opts.localOnly`
 * is set, regardless of scope/diff — see `RunOptions.localOnly`.
 */
function shouldSkip(spec: CheckSpec, opts: RunOptions): { skip: boolean; reason?: string } {
  if (opts.localOnly && spec.requiresOpenPr) return { skip: true, reason: 'requires-open-pr, local-only' }
  if (opts.skipFull && spec.scope === 'full') return { skip: true, reason: 'full-scope, pre-commit' }
  if (spec.scope !== 'diff') return { skip: false }
  if (!opts.diffOnly) return { skip: false }
  if (opts.changedFiles === null) return { skip: false }
  if (!spec.include || spec.include.length === 0) return { skip: false }
  const regexes = spec.include.map(globToRegex)
  const matched = opts.changedFiles.some((f) => regexes.some((re) => re.test(f)))
  return matched ? { skip: false } : { skip: true, reason: 'no-matching-include-glob' }
}

/** Grace period between SIGTERM and SIGKILL for a timed-out check. */
const KILL_GRACE_MS = 2000

/**
 * One entry per check currently spawned (registered right after `spawn`,
 * removed right before `runOne` returns) — the SIGINT/SIGTERM handler below
 * reads this to both kill every in-flight check's whole process tree AND
 * also emit its `gate` observation as `cancelled` before this
 * process exits, since a check killed this way never reaches one of
 * `runOne`'s own `return` statements to log itself.
 */
type ActiveCheck = {
  spec: CheckSpec
  start: number
  fingerprint: string
  logFn: (e: LogEventInput) => void
  kill: (signal: NodeJS.Signals) => void
  /** Set by the signal handler right before it logs `cancelled` for this
   * entry — `runOne` reads it back to suppress its OWN normal-completion
   * log call for the same attempt (see `installSignalForwarding`). */
  cancelled: boolean
}
const activeChecks = new Map<number, ActiveCheck>()
let activeCheckSeq = 0
let signalForwardingInstalled = false

/**
 * Installed once per process (guarded, so repeated `runChecks` calls in a
 * long-lived host — or in this file's own test suite — never pile up
 * duplicate listeners). On SIGINT/SIGTERM: log every in-flight check as
 * `cancelled`, SIGTERM every active check's group, grace period, SIGKILL
 * whatever's still alive, then exit with the conventional 128+signal code —
 * mirroring the per-check escalation below at the whole-CLI level.
 */
function installSignalForwarding(): void {
  if (signalForwardingInstalled) return
  signalForwardingInstalled = true
  const forward = (signal: NodeJS.Signals, exitCode: number): void => {
    for (const entry of activeChecks.values()) {
      // A second SIGINT/SIGTERM arriving before the first one's
      // `KILL_GRACE_MS` timer fires `process.exit` (a double Ctrl+C, or a
      // supervisor sending TERM then INT/KILL) re-enters this loop while an
      // entry from the FIRST call is still in `activeChecks` — skip it
      // rather than logging the same attempt as `cancelled` twice.
      if (entry.cancelled) continue
      // Marked BEFORE the kill below: `killTree('SIGTERM')` can make the
      // child's own `proc.on('close', …)` in `runOne` resolve before this
      // process actually exits, and `runOne` would otherwise carry on to
      // its own normal-completion `logGateChecked` call for the SAME
      // attempt — a real double-emission this flag exists to prevent.
      // `runOne` checks it right before every one of its own remaining log
      // calls and skips when it's already set.
      entry.cancelled = true
      logGateChecked({
        spec: entry.spec,
        outcome: 'cancelled',
        reason: `signal:${signal}`,
        durationMs: performance.now() - entry.start,
        fingerprint: entry.fingerprint,
        logFn: entry.logFn
      })
    }
    for (const entry of activeChecks.values()) entry.kill('SIGTERM')
    setTimeout(() => {
      for (const entry of activeChecks.values()) entry.kill('SIGKILL')
      process.exit(exitCode)
    }, KILL_GRACE_MS)
  }
  process.on('SIGINT', () => forward('SIGINT', 130))
  process.on('SIGTERM', () => forward('SIGTERM', 143))
}

/**
 * The fixed baseline every constructed env starts from — always forwarded
 * from the caller's env when present, and never removed by a declared
 * entry (an entry may only override a baseline key's VALUE).
 */
const ENV_BASELINE_KEYS = ['PATH', 'LANG', 'HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'TMPDIR'] as const

/**
 * Builds the env object a check's child process actually receives —
 * `runOne` below passes this as `spawn()`'s `env` option, the spawn default
 * since the flip (task 3, #776). Exported and unit-tested independently of
 * the spawn path itself.
 *
 * Expansion, never spread: the baseline keys above are forwarded from
 * `callerEnv` when set, then each declared entry in `spec.env` layers on
 * top, per its own form:
 *   - `true` / `{ optional: true }` — forward `callerEnv[key]` if set;
 *     both forms behave identically here (the difference between them is a
 *     documentation-time contract — "this check hard-needs it" vs "this
 *     check tolerates its absence" — not a construction-time one).
 *   - `{ anyOf: [...] }` — for each member, forward `callerEnv[member]`
 *     under ITS OWN name if the caller has it set — never renamed to `key`.
 *   - a literal string — set `key` to that exact string, ignoring
 *     `callerEnv` entirely (never interpolated: `"$PATH"` is four literal
 *     characters, not an expansion).
 */
export function buildCheckEnv(
  env: CheckSpec['env'],
  callerEnv: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const out: Record<string, string> = {}

  for (const key of ENV_BASELINE_KEYS) {
    const value = callerEnv[key]
    if (value !== undefined) out[key] = value
  }

  if (!env) return out

  for (const [key, decl] of Object.entries(env)) {
    if (decl === true || (typeof decl === 'object' && 'optional' in decl)) {
      const value = callerEnv[key]
      if (value !== undefined) out[key] = value
    } else if (typeof decl === 'object' && 'anyOf' in decl) {
      for (const member of decl.anyOf) {
        const value = callerEnv[member]
        if (value !== undefined) out[member] = value
      }
    } else if (typeof decl === 'string') {
      out[key] = decl
    }
  }

  return out
}

/**
 * Pre-spawn required-env check, run before a check's process ever exists. A
 * `true` declaration absent from `callerEnv`, or an `anyOf` group with no
 * member set, synthesizes a `CheckError` — same shape as the
 * missing-executable error below, since both are "the check could not run
 * at all" outcomes. `{ optional: true }` and a literal string never
 * synthesize: optional-by-declaration means absence is tolerated by
 * contract, and a literal never depends on the caller's environment.
 *
 * `keys` names every offending declared key or `anyOf` group (joined with
 * `|`) alongside the synthesized errors — never a value, only the
 * declaration's own key name(s) — so the gate observation below can name
 * `unavailable_dependency`'s reason without re-deriving it from `errors[].message`.
 */
function missingEnvErrors(spec: CheckSpec, callerEnv: NodeJS.ProcessEnv): { errors: CheckError[]; keys: string[] } {
  if (!spec.env) return { errors: [], keys: [] }
  const errors: CheckError[] = []
  const keys: string[] = []
  for (const [key, decl] of Object.entries(spec.env)) {
    if (decl === true) {
      if (callerEnv[key] === undefined) {
        keys.push(key)
        errors.push({
          schema: CHECK_SCHEMA_VERSION,
          check: spec.name,
          severity: 'error',
          message: `Could not run check "${spec.name}": required environment variable \`${key}\` is not set.`,
          agent_recovery_prompt: `Set \`${key}\` in the environment before re-running \`vinaya check ${spec.name}\`, or relax its declaration to \`{ optional: true }\` in its \`env\` registration if the check can tolerate absence.`
        })
      }
    } else if (typeof decl === 'object' && decl !== null && 'anyOf' in decl) {
      const satisfied = decl.anyOf.some((member) => callerEnv[member] !== undefined)
      if (!satisfied) {
        keys.push(decl.anyOf.join('|'))
        errors.push({
          schema: CHECK_SCHEMA_VERSION,
          check: spec.name,
          severity: 'error',
          message: `Could not run check "${spec.name}": none of its required environment variables (${decl.anyOf.join(', ')}) are set.`,
          agent_recovery_prompt: `Set one of ${decl.anyOf.join(', ')} in the environment before re-running \`vinaya check ${spec.name}\`.`
        })
      }
    }
  }
  return { errors, keys }
}

async function runOne(
  spec: CheckSpec,
  timeoutMs: number,
  callerEnv: NodeJS.ProcessEnv,
  fingerprint: string,
  logFn: (e: LogEventInput) => void
): Promise<CheckOutcome> {
  const start = performance.now()

  const { errors: envErrors, keys: missingKeys } = missingEnvErrors(spec, callerEnv)
  if (envErrors.length > 0) {
    const durationMs = performance.now() - start
    logGateChecked({
      spec,
      outcome: 'unavailable_dependency',
      reason: `missing_env:${missingKeys.join(',')}`,
      durationMs,
      fingerprint,
      logFn
    })
    return {
      name: spec.name,
      status: 'error',
      exitCode: null,
      errors: envErrors,
      durationMs
    }
  }

  // `env` is the constructed baseline+allowlist object (`buildCheckEnv`),
  // the spawn default since the flip (task 3, #776) — the child no longer
  // inherits the full parent environment. `detached: true` puts the child
  // in its OWN process group (pid becomes the group's pgid on POSIX) so the
  // timeout handler below can kill the whole tree, not just this direct
  // child.
  const proc = spawn(spec.run, spec.args ?? [], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: buildCheckEnv(spec.env, callerEnv)
  })

  // Best-effort process-GROUP kill: negative pid targets every process in
  // the child's group, reaching a grandchild the check itself shelled out
  // to (previously survived the timeout entirely — the direct-child-only
  // `proc.kill()` never reached it). Falls back to the single-pid form if
  // the group kill throws (e.g. the group already exited, or a platform
  // where negative-pid signaling isn't supported) — never left as the ONLY
  // attempt, since a thrown group-kill must not mean "gave up."
  function killTree(signal: NodeJS.Signals): void {
    const pid = proc.pid
    if (pid === undefined) return
    try {
      process.kill(-pid, signal)
    } catch {
      try {
        proc.kill(signal)
      } catch {
        // Already gone — nothing left to signal.
      }
    }
  }

  installSignalForwarding()
  const activeKey = activeCheckSeq++
  activeChecks.set(activeKey, { spec, start, fingerprint, logFn, kill: killTree, cancelled: false })

  /**
   * True once the child's own PID is confirmed gone — but a process GROUP
   * can outlive its own leader (a grandchild the check spawned before
   * dying). `process.kill(-pid, 0)` sends no real signal, it only probes
   * whether the group still has a live member; ESRCH means it doesn't.
   */
  function groupStillAlive(pid: number): boolean {
    try {
      process.kill(-pid, 0)
      return true
    } catch {
      return false
    }
  }

  let timedOut = false
  // Resolves once the escalation decision is actually made (grace period
  // elapsed, group-liveness probed, SIGKILL sent if still needed) — awaited
  // below before `runOne` returns, so the caller (and therefore the CLI
  // process, which exits right after `runChecks` resolves) cannot exit out
  // from under a still-pending escalation. A bare `setTimeout` with no
  // await on it was the earlier bug's other half: the direct child's own
  // 'close' let `runOne` return, and the CLI exited, before the scheduled
  // SIGKILL ever got to fire — the escalation existed but nothing waited
  // for it.
  let escalationDone: Promise<void> = Promise.resolve()
  // Lets the post-exitCode fast path (below) skip the rest of the grace
  // period once it can already SEE the whole group is dead, instead of
  // blocking every timed-out check for a full `KILL_GRACE_MS` regardless —
  // the common case (nothing traps SIGTERM, direct child and every
  // grandchild all die on the first group-wide signal).
  let cancelEscalation: (() => void) | undefined
  const timer = setTimeout(() => {
    timedOut = true
    // SIGTERM first; a check that traps/ignores it would otherwise run
    // forever past its declared timeout — escalate to SIGKILL after a
    // grace period so "the runner enforces the timeout" is actually true.
    killTree('SIGTERM')
    escalationDone = new Promise((resolve) => {
      // NOT cancelled merely because the DIRECT child's own 'close' fires
      // (a group-wide SIGTERM commonly kills the direct child fast, well
      // inside this grace period, while a grandchild that traps SIGTERM is
      // still alive) — the group-liveness probe is the actual cancellation
      // condition, applied by the caller via `cancelEscalation` once it can
      // confirm the group's really gone. Gating on "direct child closed"
      // alone (the previous shape) left a SIGTERM-trapping grandchild
      // unreaped even though its group DID receive the escalation window.
      const graceTimer = setTimeout(() => {
        const pid = proc.pid
        // Only signal if the group still has a live member. Sending
        // SIGKILL to a group that has already fully exited risks hitting
        // an OS-recycled, unrelated pgid instead — the group-liveness
        // probe is the guard against that, not a correctness guarantee
        // against every possible recycling race (POSIX gives no atomic
        // "is this still MY group" check), but it closes the window from
        // KILL_GRACE_MS down to this callback's own execution.
        if (pid !== undefined && groupStillAlive(pid)) killTree('SIGKILL')
        resolve()
      }, KILL_GRACE_MS)
      cancelEscalation = () => {
        clearTimeout(graceTimer)
        resolve()
      }
    })
  }, timeoutMs)

  let stderrText = ''
  proc.stderr.setEncoding('utf-8')
  proc.stderr.on('data', (chunk: string) => {
    stderrText += chunk
  })
  // Drain stdout so the child never blocks on a full pipe buffer; the
  // runner never prints stdout (Part 6's command owns human output).
  proc.stdout.resume()

  // Retained so the failure can be reported. Resolving `null` alone tells the
  // caller THAT the spawn failed but never why, which reads identically to a
  // check that exited non-zero in silence.
  let spawnError: Error | undefined
  let eventSettled = false
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  const exitCode = await Promise.race([
    new Promise<number | null>((resolve) => {
      // 'close', not 'exit' — it fires after the stdio pipes have drained, so
      // stderr is complete before parsing.
      proc.on('close', (code) => {
        eventSettled = true
        resolve(code)
      })
      // A spawn failure (e.g. the executable does not exist) must surface as a
      // loud `status: 'error'` outcome, never an unhandled 'error' crash.
      proc.on('error', (err: Error) => {
        eventSettled = true
        spawnError = err
        resolve(null)
      })
    }),
    // Absolute safety net, independent of `proc`'s own events: observed
    // live, a check that exits near-instantly (`process.exit(0)` before its
    // own output even matters) can have its 'close' event never delivered
    // at all — no error, no signal, the child genuinely gone (confirmed
    // `<defunct>` in the process table) but this promise waiting forever
    // regardless, since neither 'close' nor 'error' ever fires again. The
    // per-check timeout above only sets `timedOut` and signals a process
    // that, in this exact failure, is already dead — it never by itself
    // unblocks a promise with nothing left to resolve it. This second race
    // arm is the one thing that does: past the full escalation window
    // (timeout, SIGTERM, `KILL_GRACE_MS` for SIGKILL) plus a real margin,
    // resolve `null` unconditionally rather than hang the whole run on one
    // check's undelivered event. Cleared the moment the real race arm wins
    // (the overwhelmingly common case) — an uncleared timer would otherwise
    // hold the whole CLI process alive for its full duration after every
    // single healthy check.
    new Promise<number | null>((resolve) => {
      deadlineTimer = setTimeout(
        () => {
          if (!eventSettled) timedOut = true
          resolve(null)
        },
        timeoutMs + KILL_GRACE_MS * 2 + 5000
      )
    })
  ])
  if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
  clearTimeout(timer)
  if (timedOut) {
    // Fast path: the direct child's own close/error just fired — if the
    // WHOLE group is already confirmed dead, skip the rest of the grace
    // period instead of blocking this check for a full `KILL_GRACE_MS` for
    // nothing. If anything in the group is still alive (a SIGTERM-trapping
    // grandchild), leave the already-scheduled grace timer to run to its
    // full duration — `escalationDone` below then blocks on ITS resolution.
    const pid = proc.pid
    if (pid === undefined || !groupStillAlive(pid)) cancelEscalation?.()
    // Blocks until the escalation decision is actually made, not just
    // scheduled — see the comment on `escalationDone` above.
    await escalationDone
  }
  // Read BEFORE deleting — set by the SIGINT/SIGTERM handler
  // (`installSignalForwarding`) when it already logged this exact attempt as
  // `cancelled`. `runOne` reaching this point after that is expected (the
  // handler's kill can make `proc`'s own `close` resolve before the process
  // actually exits) — `maybeLog` below is what stops that race from
  // double-emitting the same check under two different outcomes.
  const wasCancelled = activeChecks.get(activeKey)?.cancelled === true
  activeChecks.delete(activeKey)
  const durationMs = performance.now() - start
  const maybeLog = (params: { outcome: GateOutcome; reason?: string }): void => {
    if (wasCancelled) return
    logGateChecked({ spec, durationMs, fingerprint, logFn, ...params })
  }

  if (timedOut) {
    maybeLog({ outcome: 'timeout', reason: `timeout_ms:${timeoutMs}` })
    return { name: spec.name, status: 'timeout', exitCode: null, errors: [], durationMs }
  }

  // The executable never ran. Synthesize the finding the check itself could
  // not emit — an empty `errors: []` here would leave `--json` consumers with
  // a bare `error` status and nothing to act on.
  if (spawnError) {
    const code = (spawnError as NodeJS.ErrnoException).code
    maybeLog({ outcome: 'unavailable_dependency', reason: `spawn_failed:${code ?? 'unknown'}` })
    return {
      name: spec.name,
      status: 'error',
      exitCode: null,
      errors: [
        {
          schema: 1,
          check: spec.name,
          severity: 'error',
          message:
            code === 'ENOENT'
              ? `Could not run check "${spec.name}": executable \`${spec.run}\` was not found on PATH.`
              : `Could not run check "${spec.name}": ${spawnError.message}`,
          agent_recovery_prompt:
            code === 'ENOENT'
              ? `Install \`${spec.run}\` or correct the \`run\` field for check "${spec.name}" in vinaya.config.json, then re-run.`
              : `Inspect the \`run\` and \`args\` fields for check "${spec.name}" in vinaya.config.json, then re-run.`
        }
      ],
      durationMs
    }
  }

  const lines = stderrText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  const errors: CheckError[] = []
  let malformed = false
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line)
      if (isCheckError(parsed)) {
        errors.push(parsed)
      } else {
        malformed = true
      }
    } catch {
      malformed = true
    }
  }

  // A check that emits garbage must be loud (`status: 'error'`), never a
  // silent pass — regardless of its own exit code.
  let status: CheckStatus
  if (malformed) {
    status = 'error'
  } else if (exitCode === 0) {
    status = 'pass'
  } else if (exitCode === 1) {
    status = 'fail'
  } else {
    status = 'error'
  }

  if (status === 'error') {
    maybeLog({ outcome: 'invalid_input', reason: malformed ? 'malformed_output' : `unexpected_exit_code:${exitCode}` })
  } else if (status === 'pass') {
    maybeLog({ outcome: 'pass' })
  } else {
    // `status === 'fail'` — a `pending: true` error is "has not happened
    // YET" (contract.ts), never "is wrong": every reported error pending
    // means this attempt is waiting on a step outside the diff (the
    // Principal ticking a Test Plan box, most often), not a rejection of it.
    const waiting = errors.length > 0 && errors.every((e) => e.pending === true)
    maybeLog({
      outcome: waiting ? 'wait' : 'fail',
      reason: waiting ? 'pending_principal_action' : `errors:${errors.length}`
    })
  }

  return { name: spec.name, status, exitCode, errors, durationMs }
}

/**
 * Runs every spec through exactly one spawn path — this IS the no-privileged-
 * API invariant. `runChecks` never branches on whether a
 * `CheckSpec` came from the built-in registry or from `vinaya.config.json`;
 * see `tests/checks/no-privileged-api.test.ts` for the mechanical proof.
 *
 * The runner enforces the per-check timeout itself (spawn, SIGTERM, escalate
 * to SIGKILL after `KILL_GRACE_MS`, both targeting the check's whole process
 * GROUP via `detached: true` + negative-pid signaling — closed live, this
 * task) — a check trusted to time itself out cannot be trusted at all, and a
 * check trusted to kill its own children on the way out cannot be trusted
 * at that either. The SIGKILL escalation is awaited (`escalationDone`), not
 * fire-and-forget: `runOne` does not return until the grace period has
 * elapsed AND a group-liveness probe (`process.kill(-pid, 0)`) has run —
 * cancelling it merely because the DIRECT child's own `'close'` fired left a
 * SIGTERM-trapping grandchild unreaped, and not awaiting it at all let the
 * CLI exit (right after `runChecks` resolves) before the scheduled SIGKILL
 * ever got to fire. `detached: true`'s other side effect — removing every
 * check from the terminal's foreground process group, so Ctrl+C no longer
 * reaches them — is closed by `installSignalForwarding`: every in-flight
 * check is registered in `activeChecks`, and a SIGINT/SIGTERM to the CLI
 * itself logs each as a `gate` `cancelled` observation and forwards the
 * signal to all of them before the CLI exits.
 *
 * Env allowlist, live since the flip (task 3, #776): a spawned check's
 * child process sees only the fixed baseline plus its own declared `env`
 * keys (`buildCheckEnv`), never the full parent environment. A `true` or
 * unsatisfied `anyOf` declaration missing from the caller's environment
 * synthesizes a `CheckError` and the check never spawns at all
 * (`missingEnvErrors`, above) — the contract's no-privileged-API invariant
 * extended to the check's own process environment, not just its spawn path.
 * The skip decision above (`shouldSkip`) runs before any of this: a
 * `scope: 'diff'` check skipped by `--diff-only` never reaches `runOne`, so
 * it can never fail over an env var it was never going to read.
 *
 * Every outcome this function or `runOne` reaches — skip, pass, fail
 * (rejected or waiting), timeout, and the two `error` flavors
 * (`unavailable_dependency`/`invalid_input`) — is recorded as one `gate`
 * `checked` observation (`logGateChecked`) at the exact point the outcome
 * is decided, so the recorded reason always matches real local context
 * rather than being re-derived from the returned `CheckOutcome` after the
 * fact. This never changes what `runChecks` returns or what `isRunFailed`
 * reads from it, and never modifies a gate decision while adding an
 * observation — the log call is strictly additional to every existing
 * return statement.
 */
export async function runChecks(specs: CheckSpec[], opts: RunOptions): Promise<CheckOutcome[]> {
  const callerEnv = opts.callerEnv ?? process.env
  const logFn = opts.log ?? defaultLog
  // Only for the real default sink — an injected test logger has no
  // doctrine/repo resolution to warm, and calling this before a burst of
  // concurrent check completions is precisely what closes the race
  // `warmupLogSink`'s own doc comment describes.
  if (opts.log === undefined) warmupLogSink()
  const results: CheckOutcome[] = new Array(specs.length)
  const fingerprints: string[] = new Array(specs.length)
  const toRun: number[] = []

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i] as CheckSpec
    const fingerprint = inputFingerprintFor(spec, opts, callerEnv)
    fingerprints[i] = fingerprint
    const skip = shouldSkip(spec, opts)
    if (skip.skip) {
      logGateChecked({ spec, outcome: 'skip', reason: skip.reason, durationMs: 0, fingerprint, logFn })
      results[i] = {
        name: spec.name,
        status: 'skipped',
        exitCode: null,
        errors: [],
        durationMs: 0,
        ...(skip.reason ? { skipReason: skip.reason } : {})
      }
    } else {
      toRun.push(i)
    }
  }

  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < toRun.length) {
      const idx = toRun[cursor] as number
      cursor += 1
      const spec = specs[idx] as CheckSpec
      results[idx] = await runOne(
        spec,
        spec.timeoutMs ?? opts.defaultTimeoutMs,
        callerEnv,
        fingerprints[idx] as string,
        logFn
      )
    }
  }

  const workerCount = Math.max(1, Math.min(opts.parallel, toRun.length))
  await Promise.all(Array.from({ length: workerCount }, worker))

  return results
}
