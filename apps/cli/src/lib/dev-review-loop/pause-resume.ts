/**
 * `dev-review-loop`'s pause-and-resume concern (task 8,
 * `#506`, O8) — rendering and idempotently posting the pause comment,
 * durable pause state for `--resume`, and the one-driver-per-task pid lock.
 * Moved out of `apps/cli/src/lib/dev-review-loop.ts` verbatim;
 * `dev-review-loop.ts` stays the composition root, re-exporting every name
 * below under the same path it always had.
 */

import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { defaultControlStoreDeps, type LoopBudgets, type PauseReason, type RoundHeadIdentity } from '@attalabs/aeg-core'
import { controlStoreRoot, createEffectExecutor, sha256Hex } from '../effects.js'
import { markedCommentBody, postMarkedComment, reconcileGhComment } from '../forge-write.js'
import { loadLoopState } from './round-assess.js'
import { readIfExists } from './reviewer-dispatch.js'

/** `sanitizePublicPauseDetail` truncates to this — long enough to stay informative, short enough that a runaway stack trace or subprocess dump never balloons a public PR comment. */
const PUBLIC_PAUSE_DETAIL_MAX_LENGTH = 300

/** Any `/Users/<name>` or `/home/<name>` prefix, this machine's own `$HOME` included — not only the exact `$HOME` string, since a leaked path can name a DIFFERENT local user (a subprocess run as another account, a path baked into a dependency's own error string). */
const HOME_LIKE_PATH = /\/(?:Users|home)\/[^/\s]+/g

/** A userinfo segment embedded in a URL (`https://<token>@host/...`, the shape a leaked git remote or API endpoint takes when it carries a credential inline). */
const URL_CREDENTIAL = /:\/\/[^\s@/]+@/g

/** A well-known credential shape (a GitHub token prefix, an AWS access key, a `Bearer` header, a `token=`/`secret=`/`password=`/`api_key=` assignment) embedded in otherwise-ordinary text — the shape a subprocess's raw stderr commonly carries. */
const CREDENTIAL_LIKE =
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._-]+|(?:token|secret|password|api[_-]?key)\s*[:=]\s*\S+)/gi

/**
 * The single chokepoint every pause `detail` destined for a PUBLIC PR
 * comment must pass through — applied INSIDE `postPauseComment`, below, so
 * no call site (the
 * outer crash catch, `stale_driver`'s failed `git pull` stderr, a reviewer
 * infrastructure failure's echoed findings-file line, any future pause
 * reason) can forget it. Before this, only the top-level catch's own detail
 * was sanitized by hand; every other `decision.detail` reached the forge
 * raw, carrying whatever a subprocess's stderr or a reviewer-authored file
 * happened to contain. First line only (a multi-line dump collapses to its
 * own headline), this machine's own `$HOME` and any other `/Users/`or
 * `/home/`-rooted path redacted to `~`, a URL-embedded credential and known
 * credential shapes redacted, this machine's hostname redacted, and capped
 * to a bounded length.
 */
export function sanitizePublicPauseDetail(raw: string): string {
  const firstLine = (raw.split('\n')[0] ?? raw).trim()
  const home = process.env.HOME
  let redacted = home && home.length > 0 ? firstLine.split(home).join('~') : firstLine
  redacted = redacted.replace(HOME_LIKE_PATH, '~')
  redacted = redacted.replace(URL_CREDENTIAL, '://<redacted>@')
  redacted = redacted.replace(CREDENTIAL_LIKE, '<redacted>')
  const host = hostname()
  if (host && host.length > 0) redacted = redacted.split(host).join('<host>')
  return redacted.length > PUBLIC_PAUSE_DETAIL_MAX_LENGTH
    ? `${redacted.slice(0, PUBLIC_PAUSE_DETAIL_MAX_LENGTH)}…`
    : redacted
}

// --- pause (O2) --------------------------------------------------------------

/** Exactly `<!-- aeg:loop:paused:<reason> -->` — carries no verdict grammar (Traps to avoid). */
export function pauseMarker(reason: PauseReason): string {
  return `<!-- aeg:loop:paused:${reason} -->`
}

/**
 * The pause comment's body — the reason and the exact resume command,
 * nothing verdict-shaped. `detail` is set for `reason: 'infrastructure'`
 * (O2, the role and missing artifact(s) the driver observed on both dispatch
 * attempts), for `reason: 'no_push'` (`#543` O2, the branch and dirty
 * file(s) the driver observed), and for `reason: 'max_rounds'` (`#543` O4,
 * the configured round cap) — appended to the first line either way; every
 * other reason carries no detail and renders exactly as before.
 */
export function renderPauseComment(prNumber: number, reason: PauseReason, detail?: string): string {
  return [
    `The dev-review-loop paused: ${reason}${detail ? ` — ${detail}` : ''}.`,
    '',
    'A Principal ruling is needed before this can continue. Once one is posted on this PR, resume with:',
    '',
    '```',
    `vinaya dev-review-loop --resume ${prNumber}`,
    '```'
  ].join('\n')
}

/**
 * O9: the no-PR-yet variant of the pause comment — posted on the task Issue
 * instead of a pull request, because none is known to exist: the round-1
 * refusal/escalation before any push, or a setup failure that never got as
 * far as resolving one. Carries no PR number for a `--resume` command, so
 * the resume path named is `vinaya task run`, the same one command this
 * task's own O10 makes work with no `--agent` to remember.
 */
export function renderNoPushStopComment(task: number, reason: PauseReason, detail?: string): string {
  return [
    `The dev-review-loop paused: ${reason}${detail ? ` — ${detail}` : ''}.`,
    '',
    'No pull request exists yet for this task, so the pause is recorded on this Issue instead.',
    'A Principal ruling is needed before this can continue. Once one is posted on this Issue, resume with:',
    '',
    '```',
    `vinaya task run <tranche> ${task}`,
    '```'
  ].join('\n')
}

/**
 * The Issue-posted counterpart to `postPauseComment` — for a pause recorded
 * before any pull request is known to exist. Sanitizes `detail` HERE,
 * unconditionally, the same chokepoint discipline `postPauseComment` applies
 * for the PR case, so a call site never posts a raw `detail` un-redacted
 * either way. Posts through the shared `EffectExecutor` (Issue #552), the
 * same replacement `postPauseComment` gets below — neither writer takes a
 * root-relative outbox path any more, since both store through the
 * control-store's own root (`controlStoreRoot`), not a caller-supplied one.
 */
export function postIssuePauseComment(task: number, round: number, reason: PauseReason, detail?: string): void {
  const publicDetail = detail === undefined ? undefined : sanitizePublicPauseDetail(detail)
  const marker = pauseMarker(reason)
  const body = renderNoPushStopComment(task, reason, publicDetail)
  const key = `pause-issue-${round}-${reason}`
  const deps = defaultControlStoreDeps(controlStoreRoot)
  const executor = createEffectExecutor(deps, task, `dev-review-loop:${task}:${key}`)
  executor.execute({
    key,
    identity: {
      operation: 'issue-comment',
      target: `issue:${task}`,
      inputVersion: round,
      payloadDigest: sha256Hex(markedCommentBody(marker, body))
    },
    poster: () => postMarkedComment('issue', String(task), marker, body),
    reconcile: reconcileGhComment('issue', String(task))
  })
}

/**
 * Keyed by `round-head`, the pause INSTANCE — not the fixed literal `'pause'`
 * a prior version used, which keyed the idempotency record by task alone
 * (code review, PR #459, BLOCKER): a task pauses, resumes, and pauses again
 * with a resumed loop still at the same `round` but a new `head` (the
 * resumed developer pushes fixes before pausing a second time), so `head`
 * is what tells two real pauses apart. A genuine rerun of the SAME pause —
 * same round, same head, nothing changed — still resolves to the same key
 * and so still posts only once, preserving the original idempotency
 * requirement; only the key changed, not the once-only guarantee.
 */
export function postPauseComment(
  task: number,
  round: number,
  head: string,
  prNumber: number,
  reason: PauseReason,
  detail?: string
): void {
  // Sanitized HERE, unconditionally — the caller's `detail` may be the raw machine-local
  // string a `decision.detail` field carries (a subprocess's stderr, a
  // reviewer-authored file's own text), never pre-sanitized by convention.
  // See `sanitizePublicPauseDetail`'s own doc comment for what this closes.
  const publicDetail = detail === undefined ? undefined : sanitizePublicPauseDetail(detail)
  const marker = pauseMarker(reason)
  const body = renderPauseComment(prNumber, reason, publicDetail)
  const key = `pause-${round}-${head}`
  const deps = defaultControlStoreDeps(controlStoreRoot)
  const executor = createEffectExecutor(deps, task, `dev-review-loop:${task}:${key}`)
  executor.execute({
    key,
    identity: {
      operation: 'pr-comment',
      target: `pr:${prNumber}`,
      inputVersion: round,
      payloadDigest: sha256Hex(markedCommentBody(marker, body))
    },
    poster: () => postMarkedComment('pr', String(prNumber), marker, body),
    reconcile: reconcileGhComment('pr', String(prNumber))
  })
}

export type PauseState = {
  task: number
  round: number
  head: string
  branch: string
  prNumber: number
  reason: PauseReason
  detail?: string
  pausedAt: string
  /**
   * The in-memory `infrastructureRetries` count at the moment of this pause
   * (round 2 review, security HIGH) — a second, independent source for
   * `--resume`'s bound check, alongside `recoverLoopState`'s control-store
   * read. `writePauseState` is a plain `writeFileSync`, not the control
   * store's own effect-executor machinery `persistLoopState` swallows
   * failures from, so a control-store write that silently fails at the SAME
   * pause this field is written from still leaves this count recoverable —
   * the control store reading `'absent'` (or a stale lower count) after a
   * swallowed write can no longer, by itself, reset the bound to zero.
   * `undefined` on a record written before this field existed; treated as
   * `0` by the reader, same as a genuinely fresh task.
   */
  infrastructureRetries?: number
}

function pauseStatePath(root: string, task: number): string {
  return join(root, 'dev-review-loop', String(task), 'pause-state.json')
}

export function writePauseState(root: string, state: PauseState): void {
  const path = pauseStatePath(root, state.task)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(state), 'utf8')
}

export function readPauseState(root: string, task: number): PauseState | null {
  const raw = readIfExists(pauseStatePath(root, task))
  if (!raw) return null
  try {
    return JSON.parse(raw) as PauseState
  } catch {
    return null
  }
}

// --- authoritative loop-state recovery --------------------------------------

export type RecoveredLoopState = {
  round: number
  budgets: LoopBudgets
  heldResult: RoundHeadIdentity | null
  deliveredFindings: RoundHeadIdentity | null
}

/**
 * The authoritative recovery read for attach and `--resume` alike — the
 * control-store `loop_state` record `persistLoopState` (`round-assess.ts`)
 * writes on every transition. `'absent'` is not an error and never resets
 * anything: it means no record exists yet (a fresh task, or one that
 * predates this mechanism), so the caller falls back to whatever recovery
 * it already had — this is what keeps O3's "missing telemetry cannot reset
 * budgets or authorize progression" true even here, since absence is read
 * as "nothing to recover FROM CONTROL STORE," never as license to zero a
 * value some other mechanism already recovered. `'corrupt'` is surfaced,
 * never silently downgraded to `'absent'` — the caller (`dev-review-loop.ts`)
 * refuses to guess past it rather than risk resetting real budgets.
 */
export function recoverLoopState(
  task: number
): { status: 'ok'; value: RecoveredLoopState } | { status: 'absent' } | { status: 'corrupt'; reason: string } {
  const parsed = loadLoopState(task)
  if (parsed.status !== 'ok') return parsed
  return {
    status: 'ok',
    value: {
      round: parsed.value.round,
      budgets: parsed.value.budgets,
      heldResult: parsed.value.heldResult,
      deliveredFindings: parsed.value.deliveredFindings
    }
  }
}

// --- driver lock (one driver per task) --------------------------------------

/**
 * `#498`: one guard at the driver's entry, so a double-paste of
 * `dev-review-loop --task <n>` doesn't start a second developer/reviewer
 * pair against the same outbox. Deliberately NOT a lease or a timestamp
 * expiry — those are for a future cross-machine design, not this guard's —
 * liveness is a plain `process.kill(pid, 0)` probe, so a crashed driver's
 * stale record is taken over rather than blocking forever.
 */
type DriverLock = { pid: number; startedAt: string }

function driverLockPath(root: string, task: number): string {
  return join(root, 'dev-review-loop', String(task), 'driver.pid.json')
}

export function readDriverLock(root: string, task: number): DriverLock | null {
  const raw = readIfExists(driverLockPath(root, task))
  if (!raw) return null
  try {
    return JSON.parse(raw) as DriverLock
  } catch {
    return null
  }
}

export function writeDriverLock(root: string, task: number, lock: DriverLock): void {
  const path = driverLockPath(root, task)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(lock), 'utf8')
}

export function clearDriverLock(root: string, task: number): void {
  try {
    unlinkSync(driverLockPath(root, task))
  } catch {
    // Already gone — nothing to clean up.
  }
}

/** Same signal-0 liveness idiom `checks/runner.ts`'s group probe uses, on a single pid rather than a process group: sends no real signal, throws iff the pid is gone. */
export function isDriverPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** O3: one loop-prefixed stderr line, the same `vinaya dev-review-loop: ` prefix the CLI shim's own argv-validation messages use — no new Vinaya Log event kind (`packages/aeg-core` is out of this task's Surface; Issue #498 objectives revision). */
export function printDriverLockLine(message: string): void {
  process.stderr.write(`vinaya dev-review-loop: ${message}\n`)
}
