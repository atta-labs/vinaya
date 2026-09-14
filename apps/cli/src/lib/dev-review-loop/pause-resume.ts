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
import {
  acquireOwnership,
  appendTransition,
  consumeResolutionOnce,
  defaultControlStoreDeps,
  listStartedEffectKeys,
  markEffectUncertain,
  type EscalationRecord,
  type PauseReason,
  readEscalation,
  readResolution,
  type RequestedAuthority,
  type ResolutionRecord,
  writeEscalation
} from '@attalabs/aeg-core'
import { controlStoreRoot, createEffectExecutor, sha256Hex } from '../effects.js'
import { markedCommentBody, postMarkedComment, reconcileGhComment } from '../forge-write.js'
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

// --- escalation and resolution (#556) ---------------------------------------

/**
 * Per `PauseReason` — who a pause is addressed to, and what the driver
 * already tried before pausing. The single source `task-tools/read.ts`'s
 * `readEscalationPacket` reads for its own live reconstruction of the same
 * facts (moved here, not duplicated, since an escalation record persisted
 * by THIS file is now the durable home for exactly this judgment call —
 * `aeg-root/roles/*.md`'s own routing for each reason, recorded once).
 */
export const PAUSE_REASON_PROFILE: Record<
  PauseReason,
  { requestedAuthority: RequestedAuthority; attemptedRecovery: string; nextActions: string[] }
> = {
  escalation: {
    requestedAuthority: 'principal',
    attemptedRecovery: 'none — an escalation is a decision request, not a retry condition.',
    nextActions: ['Read `detail` for the escalating role’s own reasoning, then rule or redirect the work.']
  },
  max_rounds: {
    requestedAuthority: 'principal',
    attemptedRecovery: 'none — the round cap was reached; the loop stopped rather than looping forever.',
    nextActions: ['Review the round history and either raise the cap, redirect the work, or accept the residual risk.']
  },
  no_progress: {
    requestedAuthority: 'principal',
    attemptedRecovery: 'none — the same findings reappeared across rounds with no forward motion.',
    nextActions: ['Review the repeated findings and either clarify the brief or rule on the disagreement.']
  },
  confidence: {
    requestedAuthority: 'principal',
    attemptedRecovery: 'none — a reviewer asked for a confidence re-ask the loop could not resolve on its own.',
    nextActions: ['Answer the confidence question directly, or rule on the finding it concerns.']
  },
  reappearance: {
    requestedAuthority: 'principal',
    attemptedRecovery: 'none — a previously-resolved finding reappeared, which the loop never auto-dismisses.',
    nextActions: ['Confirm whether the reappearance is a real regression or a reviewer false positive.']
  },
  infrastructure: {
    requestedAuthority: 'operator',
    attemptedRecovery:
      'none — a role or artifact the round needed was missing; this is an environment gap, not a content one.',
    nextActions: ['Fix the missing role/artifact named in `detail`, then resume.']
  },
  no_push: {
    requestedAuthority: 'operator',
    attemptedRecovery:
      'one foreground resume asking the developer to commit and push, which did not produce a new head.',
    nextActions: ['Inspect the worktree named in `detail` for uncommitted or unpushed work, then resume.']
  },
  objectives_changed: {
    requestedAuthority: 'self',
    attemptedRecovery: 'none required — the driver detected the objectives edit itself and paused for safety.',
    nextActions: ['Resume — the round will re-read the current objectives on its own.']
  },
  ruling_posted: {
    requestedAuthority: 'self',
    attemptedRecovery: 'none required — the driver detected a mid-round ruling itself and paused for safety.',
    nextActions: ['Resume — the round will account for the posted ruling on its own.']
  },
  stale_driver: {
    requestedAuthority: 'self',
    attemptedRecovery:
      'a re-exec in place was attempted first; this pause is what the driver falls back to when that fails.',
    nextActions: ['Resume once the driver-owned code on the base branch is stable.']
  },
  brief_superseded: {
    requestedAuthority: 'self',
    attemptedRecovery: 'none required — the driver detected the brief supersession itself and paused for safety.',
    nextActions: ['Resume — the round will re-read the current frozen brief on its own.']
  },
  policy_changed: {
    requestedAuthority: 'self',
    attemptedRecovery: 'none required — the driver detected the policy change itself and paused for safety.',
    nextActions: ['Resume — the round will re-resolve the current review policy on its own.']
  }
}

/** `<task>-<round>-<head>` — the same round+head granularity `postPauseComment`'s own idempotency key already uses to tell two real pauses apart, reused here as the escalation/resolution storage key so a resume/cancel and the pause it targets are always addressing the identical instance. */
export function escalationIdFor(task: number, round: number, head: string): string {
  return `${task}-${round}-${head}`
}

export type EscalationFacts = {
  task: number
  round: number
  head: string
  branch: string
  pr: number | null
  runId: string
  reason: PauseReason
  detail?: string
  evidence?: string
  briefHash: string | null
  objectivesVersion: string | null
  rulingOrdinal: number
  policyDigest: string
}

/**
 * Persists O1's escalation record and its `paused` transition, together,
 * under the SAME freshly-acquired control-store epoch — "one agent holds
 * two records and two transitions" (Issue #556's own sizing note): this is
 * the first of the two record kinds and the first of the two transitions,
 * the pause-time half. `attemptedRecovery`/`recipient` come from
 * `PAUSE_REASON_PROFILE`, never re-typed per call site. Best-effort by
 * design at the call site (every pause path already treats its own forge
 * writes as best-effort) — this function itself still throws on a genuine
 * failure, the caller decides whether to swallow it.
 */
export function writeEscalationRecord(facts: EscalationFacts): EscalationRecord {
  const escalationId = escalationIdFor(facts.task, facts.round, facts.head)
  const deps = defaultControlStoreDeps(controlStoreRoot)
  const acquired = acquireOwnership(deps, facts.task, `dev-review-loop:${facts.task}:escalation:${escalationId}`)
  if (!acquired.acquired) {
    throw new Error(
      `writeEscalationRecord: could not acquire a control-store epoch for task ${facts.task} — epoch ${acquired.currentEpoch} is currently held by ${acquired.currentOwnerId ?? 'unknown'}`
    )
  }
  const profile = PAUSE_REASON_PROFILE[facts.reason]
  const now = new Date().toISOString()
  const record = writeEscalation(deps, facts.task, acquired.epoch, {
    escalationId,
    round: facts.round,
    head: facts.head,
    branch: facts.branch,
    pr: facts.pr,
    runId: facts.runId,
    pid: process.pid,
    host: hostname(),
    reason: facts.reason,
    detail: facts.detail,
    evidence: facts.evidence,
    attemptedRecovery: profile.attemptedRecovery,
    requestedDecision: profile.nextActions[0] ?? 'resume or cancel',
    recipient: profile.requestedAuthority,
    briefHash: facts.briefHash,
    objectivesVersion: facts.objectivesVersion,
    rulingOrdinal: facts.rulingOrdinal,
    policyDigest: facts.policyDigest,
    recordedAt: now
  })
  appendTransition(deps, facts.task, acquired.epoch, { from: 'running', to: 'paused', detail: facts.reason, at: now })
  return record
}

/** The durable escalation record for `(task, round, head)`, or `null` — never thrown; a caller that needs to distinguish absent from corrupt reads `readEscalation` from `@attalabs/aeg-core` directly. */
export function readEscalationRecord(task: number, round: number, head: string): EscalationRecord | null {
  const deps = defaultControlStoreDeps(controlStoreRoot)
  const parsed = readEscalation(deps, task, escalationIdFor(task, round, head))
  return parsed.status === 'ok' ? parsed.value : null
}

/** O2: a resolution attempt whose escalation record cannot be trusted — never written (this pause predates escalation-record adoption), or unparseable. Refused rather than guessed at: a `--resume`/`--cancel` with no durable escalation to bind against is not distinguishable from one targeting a superseded pause. */
export class StaleEscalationError extends Error {
  constructor(
    readonly task: number,
    readonly escalationId: string,
    readonly reason: string
  ) {
    super(`resolution refused — task ${task}'s escalation '${escalationId}' is stale: ${reason}`)
    this.name = 'StaleEscalationError'
  }
}

/** O2: a resolution naming a PR that does not match the escalation's own recorded PR. */
export class WrongTargetResolutionError extends Error {
  constructor(
    readonly task: number,
    readonly escalationId: string,
    readonly escalationPr: number | null,
    readonly attemptedPr: number
  ) {
    super(
      `resolution refused — task ${task}'s escalation '${escalationId}' names PR ${escalationPr ?? '(none)'}, not PR ${attemptedPr}`
    )
    this.name = 'WrongTargetResolutionError'
  }
}

/** O2: a resolution attempt against an escalation that already has a consumed resolution — the storage-level guarantee `consumeResolutionOnce` provides, surfaced here as a named refusal. */
export class ReplayedResolutionError extends Error {
  constructor(
    readonly task: number,
    readonly escalationId: string,
    readonly existing: ResolutionRecord | null
  ) {
    super(
      `resolution refused — task ${task}'s escalation '${escalationId}' already has a consumed resolution (decision: ${existing?.decision ?? 'unknown'}, by ${existing?.authenticatedBy ?? 'unknown'}) — replay refused`
    )
    this.name = 'ReplayedResolutionError'
  }
}

export type ResolveEscalationResult = {
  escalation: EscalationRecord
  resolution: ResolutionRecord
  epoch: number
}

/**
 * O2's single entry point for consuming an authenticated resolution:
 * validates wrong-target (the escalation's own recorded PR must match
 * `expectedPr`) and staleness (the escalation record must actually exist)
 * BEFORE ever attempting consumption, then claims the resolution exclusively
 * (`consumeResolutionOnce`) and appends the SAME epoch's `paused` →
 * `resumed`/`cancelled` transition — the second record and second
 * transition Issue #556's sizing note names. Throws one of
 * `StaleEscalationError`/`WrongTargetResolutionError`/
 * `ReplayedResolutionError` on any of the three refusal conditions O2
 * requires; a caller that wants a non-throwing form wraps this itself.
 */
export function resolveEscalation(
  task: number,
  escalationId: string,
  expectedPr: number,
  decision: 'resume' | 'cancel',
  authenticatedBy: string,
  authenticatedFrom: string
): ResolveEscalationResult {
  const deps = defaultControlStoreDeps(controlStoreRoot)
  const escalation = readEscalation(deps, task, escalationId)
  if (escalation.status !== 'ok') {
    throw new StaleEscalationError(
      task,
      escalationId,
      escalation.status === 'absent' ? 'no escalation record was ever written for it' : escalation.reason
    )
  }
  if (escalation.value.pr !== expectedPr) {
    throw new WrongTargetResolutionError(task, escalationId, escalation.value.pr, expectedPr)
  }
  const acquired = acquireOwnership(deps, task, `dev-review-loop:${task}:resolution:${escalationId}`)
  if (!acquired.acquired) {
    throw new Error(
      `resolveEscalation: could not acquire a control-store epoch for task ${task} — epoch ${acquired.currentEpoch} is currently held by ${acquired.currentOwnerId ?? 'unknown'}`
    )
  }
  const now = new Date().toISOString()
  const outcome = consumeResolutionOnce(deps, task, acquired.epoch, {
    escalationId,
    decision,
    authenticatedBy,
    authenticatedFrom,
    consumedAt: now
  })
  if (outcome.outcome === 'already-consumed') {
    throw new ReplayedResolutionError(task, escalationId, outcome.record)
  }
  appendTransition(deps, task, acquired.epoch, {
    from: 'paused',
    to: decision === 'resume' ? 'resumed' : 'cancelled',
    detail: authenticatedFrom,
    at: now
  })
  return { escalation: escalation.value, resolution: outcome.record, epoch: acquired.epoch }
}

/** The durable resolution record for `(task, escalationId)`, or `null` — never thrown. */
export function readResolutionRecord(task: number, escalationId: string): ResolutionRecord | null {
  const deps = defaultControlStoreDeps(controlStoreRoot)
  const parsed = readResolution(deps, task, escalationId)
  return parsed.status === 'ok' ? parsed.value : null
}

/**
 * O3's "unresolved effects remain explicitly uncertain": every effect
 * record for `task` still `'started'` — a write that was recorded as
 * attempted but never confirmed — is advanced to `'uncertain'`, fenced by
 * the SAME epoch `resolveEscalation`'s cancel path just consumed under.
 * Because that epoch is now current, any OTHER process still trying to
 * complete one of these writes under its own, now-stale epoch is refused by
 * `StaleEpochWriteError` at the moment it tries — a late result is fenced
 * by the epoch mismatch itself, not by this function racing it. Best-effort
 * per key: a key that no longer reads `'started'` by the time this runs is
 * simply skipped, never an error.
 */
export function fenceStartedEffectsAsUncertain(task: number, epoch: number): string[] {
  const deps = defaultControlStoreDeps(controlStoreRoot)
  const fenced: string[] = []
  for (const key of listStartedEffectKeys(deps, task)) {
    if (markEffectUncertain(deps, task, epoch, key)) fenced.push(key)
  }
  return fenced
}
