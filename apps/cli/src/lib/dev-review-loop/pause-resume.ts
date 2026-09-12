/**
 * `dev-review-loop`'s pause-and-resume concern (task 8,
 * `#506`, O8) — rendering and idempotently posting the pause comment,
 * durable pause state for `--resume`, and the one-driver-per-task pid lock.
 * Moved out of `apps/cli/src/lib/dev-review-loop.ts` verbatim;
 * `dev-review-loop.ts` stays the composition root, re-exporting every name
 * below under the same path it always had.
 */

import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { PauseReason } from '@attalabs/aeg-core'
import { postMarkedComment } from '../forge-write.js'
import { postForgeEffectOnce } from './publication.js'
import { readIfExists } from './reviewer-dispatch.js'

// --- pause (O2) --------------------------------------------------------------

/** Exactly `<!-- aeg:loop:paused:<reason> -->` — carries no verdict grammar (Traps to avoid). */
export function pauseMarker(reason: PauseReason): string {
  return `<!-- aeg:loop:paused:${reason} -->`
}

/**
 * The pause comment's body — the reason and the exact resume command,
 * nothing verdict-shaped. `detail` is set for `reason: 'infrastructure'`
 * (O2, the role and missing artifact(s) the driver observed on both dispatch
 * attempts) and for `reason: 'no_push'` (`#543` O2, the branch and dirty
 * file(s) the driver observed) — appended to the first line either way;
 * every other reason carries no detail and renders exactly as before.
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
 * O9: the round-1-entry variant of the pause
 * comment — no PR exists yet to carry it (posted on the Issue instead) and
 * no PR number exists for a `--resume` command, so the resume path named is
 * `vinaya task run`, the same one command this task's own O10 makes work
 * with no `--agent` to remember.
 */
export function renderNoPushStopComment(task: number, detail: string): string {
  return [
    `The dev-review-loop paused: escalation — ${detail}.`,
    '',
    'No branch was ever pushed for this task, so there is no pull request to resume against yet.',
    'A Principal ruling is needed before this can continue. Once one is posted on this Issue, resume with:',
    '',
    '```',
    `vinaya task run <tranche> ${task}`,
    '```'
  ].join('\n')
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
  root: string,
  task: number,
  round: number,
  head: string,
  prNumber: number,
  reason: PauseReason,
  detail?: string
): void {
  postForgeEffectOnce(root, task, `pause-${round}-${head}`, () =>
    postMarkedComment('pr', String(prNumber), pauseMarker(reason), renderPauseComment(prNumber, reason, detail))
  )
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
