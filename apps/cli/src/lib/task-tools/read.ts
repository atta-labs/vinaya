/**
 * The task-operator read interface (O2) — one place `task_status` and
 * `task_escalation_read` (`handlers.ts`) both read from. Every function here
 * takes an explicit `root` and a bare task/Issue number, reads only the
 * outbox and the reader `task-status.ts` already exports (`deriveLoopState`,
 * `lastRoundVerdictLines`) — never `ps` (Traps to avoid: `task_status` must
 * not shell to `ps`; the driver lock file is the liveness record `
 * deriveLoopState` already reads), never a forge call, never a write. A
 * `TaskToolRef` naming `{ tranche, id }` rather than a bare Issue number is
 * resolved to one by `handlers.ts` before it reaches this module — the same
 * split `task-status.ts` itself keeps between its forge-touching entry
 * points and its pure, `root`-parameterized outbox reads (its own file
 * header, and `apps/cli/tests/lib/task-status.test.ts`'s), so every read
 * here stays a fixture-driven unit test with no `gh` call anywhere in it.
 *
 * "Stale" is never a wall-clock judgment (a record is not stale merely for
 * being old) — it means the record predates the run's own last transition:
 * a pause record naming a round the outbox's effect markers show already
 * published, or a driver-lock pid that is no longer alive. "Unknown" means
 * no record exists to read at all, or it failed to parse. Every value this
 * module returns is wrapped in `Observed<T>`, timestamped at the moment of
 * THIS read (`observedAt`) — never the record's own internal timestamp,
 * which stays inside the value for a caller that wants it.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Freshness, TaskEscalationPacket } from '@attalabs/aeg-core'
import { PAUSE_REASON_PROFILE, readPauseState, type PauseState } from '../dev-review-loop/pause-resume.js'
import {
  deriveLoopState,
  lastRoundVerdictLines,
  resumeCommandFor,
  type RoundVerdictLines,
  type TaskLoopState
} from '../task-status.js'

// --- Observed<T> -------------------------------------------------------------

export type Observed<T> = { value: T; observedAt: string; freshness: Freshness }

function observedNow<T>(value: T, freshness: Freshness): Observed<T> {
  return { value, observedAt: new Date().toISOString(), freshness }
}

// --- bounded pagination ------------------------------------------------------

export type Page<T> = { items: T[]; nextCursor: string | null }

/**
 * An offset encoded as a decimal string — opaque to the caller (it is never
 * documented as an index, only ever round-tripped), bounded by `limit` on
 * every call so a caller cannot request an unbounded page by omitting it.
 */
export function paginate<T>(items: readonly T[], cursor: string | undefined, limit: number): Page<T> {
  const requested = cursor === undefined ? 0 : Number.parseInt(cursor, 10)
  const start = Number.isInteger(requested) && requested >= 0 ? requested : 0
  const slice = items.slice(start, start + limit)
  const next = start + slice.length
  return { items: slice, nextCursor: next < items.length ? String(next) : null }
}

// --- outbox primitives (private — task-status.ts's own duplicated-reader
// convention: publication.ts's effect-marker shape is not exported, and
// widening its Surface for one more reader is out of this task's Surface) --

function taskOutboxDir(root: string, task: number): string {
  return join(root, 'dev-review-loop', String(task))
}

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

type ForgeEffectRecord = { effectId: string; status: 'started' | 'posted'; url?: string }

function readEffectMarker(root: string, task: number, key: string): ForgeEffectRecord | null {
  const raw = readIfExists(join(taskOutboxDir(root, task), `effect-${key}.json`))
  if (!raw) return null
  try {
    return JSON.parse(raw) as ForgeEffectRecord
  } catch {
    return null
  }
}

/** The highest round both verdict effect markers read `posted` for — `null` when no round has published cleanly. Same derivation as `task-status.ts`'s own private `newestPublishedRound`, duplicated for the same reason that function is not exported. */
function newestPublishedRound(root: string, task: number): number | null {
  let entries: string[]
  try {
    entries = readdirSync(taskOutboxDir(root, task))
  } catch {
    return null
  }
  const rounds = new Set<number>()
  for (const name of entries) {
    const m = /^effect-(\d+)-reviewer-verdict\.json$/.exec(name)
    if (m) rounds.add(Number(m[1]))
  }
  let newest: number | null = null
  for (const round of rounds) {
    const reviewer = readEffectMarker(root, task, `${round}-reviewer-verdict`)
    const security = readEffectMarker(root, task, `${round}-security-verdict`)
    if (reviewer?.status === 'posted' && security?.status === 'posted' && (newest === null || round > newest)) {
      newest = round
    }
  }
  return newest
}

// --- task_status's own observation ------------------------------------------

/**
 * `deriveLoopState` already resolves a stale pause record internally (it
 * prefers `published` over a pause naming a round the outbox shows already
 * published past) — so by the time it returns `paused`, that pause is
 * necessarily current. `no_driver` is the one case with no record of any
 * kind to observe; every other `TaskLoopState` kind is this read's current,
 * fresh answer.
 */
export function readTaskLoopStateObserved(root: string, task: number): Observed<TaskLoopState> {
  const state = deriveLoopState(root, task)
  return observedNow(state, classifyStateFreshness(state))
}

/** `no_driver` is the only `TaskLoopState` kind backed by no record at all; every other kind is `deriveLoopState`'s current, fresh answer (see the doc comment above). Exported so `handlers.ts` can classify a `TaskStatusRow.state` it already has in hand — computed by `gatherTaskStatusList`/`gatherSingleTaskStatus` against the same outbox — without a second, redundant outbox read. */
export function classifyStateFreshness(state: TaskLoopState): Freshness {
  return state.kind === 'no_driver' ? 'unknown' : 'fresh'
}

/** One short phrase per `TaskLoopState` kind — the same vocabulary `task-status.ts`'s own private `renderStateText` renders into its one-line row, duplicated here (that function is not exported, and widening `task-status.ts`'s Surface for one more reader is out of this task's Surface) so `handlers.ts` can put the state into `TaskStatusItemSchema`'s plain `state: string` field. */
export function describeTaskLoopState(state: TaskLoopState): string {
  switch (state.kind) {
    case 'running':
      return `running (pid ${state.pid})`
    case 'paused':
      return `paused (${state.reason})`
    case 'published':
      return 'published'
    case 'exited':
      return `exited (${state.reason}) — last decision: ${state.lastDecision}`
    case 'no_driver':
      return 'no driver'
  }
}

// --- task_escalation_read's own observation ---------------------------------

/**
 * Read straight from `pause-state.json` — never through `deriveLoopState`
 * (which only ever returns `paused` for the CURRENT pause and collapses a
 * superseded one into `published`) — so a caller can tell "no pause ever
 * recorded" apart from "a pause is on disk but the run has since moved past
 * it" (`freshness: 'stale'`) apart from "this is the live pause"
 * (`freshness: 'fresh'`). `null` when the outbox never wrote a pause record
 * for this task at all — `handlers.ts` renders that as an empty page, per
 * the catalog's own boundary note, never as an error.
 *
 * `TaskEscalationPacket` (`@attalabs/aeg-core`) already carries its own
 * `observedAt`/`freshness` fields (`ObservedSchema`, merged into the
 * schema directly) — they are set here, once, rather than through the
 * generic `Observed<T>` wrapper above, which would double them.
 */
export function readEscalationPacket(root: string, task: number): TaskEscalationPacket | null {
  const pause: PauseState | null = readPauseState(root, task)
  if (!pause) return null

  const published = newestPublishedRound(root, task)
  const freshness: Freshness = published !== null && pause.round <= published ? 'stale' : 'fresh'

  const verdictLines: RoundVerdictLines | null = lastRoundVerdictLines(root, task)
  const profile = PAUSE_REASON_PROFILE[pause.reason]

  return {
    reason: pause.reason,
    detail: pause.detail ?? null,
    inputs: {
      task: pause.task,
      round: pause.round,
      head: pause.head,
      branch: pause.branch,
      prNumber: pause.prNumber
    },
    evidence:
      verdictLines === null
        ? null
        : { round: verdictLines.round, reviewer: verdictLines.reviewer, security: verdictLines.security },
    attemptedRecovery: profile.attemptedRecovery,
    requestedAuthority: profile.requestedAuthority,
    permittedNextActions: [...profile.nextActions, `Or run: ${resumeCommandFor(pause.prNumber)}`],
    observedAt: new Date().toISOString(),
    freshness
  }
}
