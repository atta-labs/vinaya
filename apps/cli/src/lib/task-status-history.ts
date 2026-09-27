/**
 * What a phase typically takes in THIS repository — read off the pull
 * requests of its own recently merged tasks, never predicted.
 *
 * One bounded read per process: the most recent merged task branches
 * (`MERGED_TASK_PR_READ_CAP` of them), each pull request's comments fetched
 * once, every interval extracted by the pure reader in `@attalabs/aeg-core`
 * (`phaseSamplesFromPrComments`) from PRINCIPAL-AUTHORED comments only — the
 * same trust boundary every other forge read in this loop applies, so a
 * non-principal commenter cannot post a round-marker- or verdict-shaped
 * comment and move what this repository reports as typical.
 *
 * Read lazily, ONCE per status read, and cached with a lifetime that depends on
 * whether it reached the forge. The process answering a status read is not
 * always a short-lived CLI invocation: the task-tool surface is one long-lived
 * stdio server per Operator session (`task-tools/server.ts`), so a cache that
 * lived for the process would let one transient `gh` failure empty the
 * typical-time column for a session's whole life, and a successful first read
 * would still be served hours later as current history.
 *
 * So: a successful read is kept for `PHASE_HISTORY_CACHE_TTL_MS`, and a failed
 * one for the much shorter `PHASE_HISTORY_FAILURE_BACKOFF_MS` — long enough
 * that a failing forge is not asked again row after row, short enough that a
 * transient failure is retried soon. On top of that, one lookup object (one
 * status read) attempts the forge at most once whatever happens, so the
 * `1 + MERGED_TASK_PR_READ_CAP` bound holds for a whole read of any number of
 * rows, failing or healthy — a read that keeps retrying is exactly what a
 * secondary rate limit punishes.
 *
 * Nothing is read at all until a row actually asks about a phase that HAS a
 * history class: a listing in which every task is `no driver`, or a single
 * planned task, pays no forge call for this.
 *
 * A forge failure is never an error here — `task status` and `task_status`
 * still answer, with the typical-time column empty.
 *
 * Nothing here is a forecast. The figures are medians of work that already
 * merged, and the fields carrying them say so (`typicalPhaseMinutes`,
 * `typicalPhaseSamples`).
 */

import { execFileSync } from 'node:child_process'
import {
  emptyPhaseSamples,
  phaseHistoryClassFor,
  phaseSamplesFromPrComments,
  summarizePhaseSamples,
  type HistoryComment,
  type PhaseSamples,
  type TaskPhaseHistory
} from '@attalabs/aeg-core'
import { loadTrustAnchorConfig, resolvePrincipalAllowlist } from './config.js'

/** How many merged task pull requests the history read may open. Bounded on purpose: a status read is a glance, and the newest few merged tasks are what "typical in this repository, lately" means. */
export const MERGED_TASK_PR_READ_CAP = 5

/** How deep the merged-pull-request LIST goes before the task branches in it are capped — merges of non-task branches (a release, a hand-made fix) are filtered out, so the list has to be a little longer than the cap. */
const MERGED_PR_LIST_LIMIT = 30

/** How long a SUCCESSFUL history read stays current. Long enough that one status read, or a burst of them, costs one forge read; short enough that a long-lived server session picks up newly merged tasks. */
export const PHASE_HISTORY_CACHE_TTL_MS = 10 * 60_000

/** How long a FAILED read is remembered before the forge is asked again — a back-off, not a cache: it keeps a refusing forge from being hammered by the next status read while still retrying within a minute. */
export const PHASE_HISTORY_FAILURE_BACKOFF_MS = 60_000

/**
 * The ceiling on one `gh` read. `execFileSync` is synchronous, so a `gh` that
 * hangs — a black-holed connection, a credential helper waiting on a prompt —
 * would otherwise block the calling thread with no bound at all, and the
 * long-lived task-tool server chains every request through one promise, so one
 * wedged read would hold every other task's queued call behind it. An expiry
 * here is just another failed read, which the typical-time column already
 * degrades to.
 */
const GH_READ_TIMEOUT_MS = 20_000

/** Same ceiling every other `gh` comment read in this codebase raises for itself: a task's comment history can pass `execFileSync`'s own 1 MiB default. */
const MAX_GH_OUTPUT_BYTES = 64 * 1024 * 1024

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: MAX_GH_OUTPUT_BYTES,
    timeout: GH_READ_TIMEOUT_MS
  }).trim()
}

type MergedPr = { number: number; headRefName: string; mergedAt: string }

/**
 * The newest merged TASK pull requests, newest first, capped — a merge on any
 * other branch shape carries no round markers and is not a task's history.
 *
 * Both fields are checked against the parsed JSON rather than trusted from the
 * cast: the number this returns becomes an argument of a `gh pr view`
 * subprocess, and a value that is not a positive integer — a changed `gh`
 * output shape, a wrapper binary of that name on `PATH` — must never reach an
 * argument list, where one beginning with a dash would be read as a flag.
 */
export function mergedTaskPrNumbers(raw: string, cap: number = MERGED_TASK_PR_READ_CAP): number[] {
  const parsed = JSON.parse(raw) as MergedPr[]
  return parsed
    .filter((pr) => Number.isInteger(pr.number) && pr.number > 0)
    .filter((pr) => typeof pr.headRefName === 'string' && pr.headRefName.startsWith('task/'))
    .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt))
    .slice(0, cap)
    .map((pr) => pr.number)
}

/**
 * Both fields a comment contributes are checked against the parsed JSON rather
 * than trusted from the cast — the same reason `mergedTaskPrNumbers` checks its
 * own: this is forge output, and a changed `gh` shape (or a binary of that name
 * on `PATH`) must not hand a non-string `body` to a parser that calls
 * `body.match`, which would throw out of the read and take the whole status
 * answer down with it rather than costing one column.
 */
function parseComments(raw: string): HistoryComment[] {
  const parsed = JSON.parse(raw) as {
    comments: { body?: unknown; author?: { login?: string } | null; createdAt?: unknown }[]
  }
  return parsed.comments
    .filter((c) => typeof c.body === 'string' && typeof c.createdAt === 'string')
    .map((c) => ({ body: c.body as string, author: c.author?.login ?? null, createdAt: c.createdAt as string }))
}

/**
 * One pull request's comments, or `null` when the read failed — the single
 * `gh pr view <n> --json comments` read this feature makes, shared by the
 * history read here and the published-summary confidence read in
 * `task-status.ts` rather than copied into both (two copies of one forge read
 * drift the first time the flag or the comment shape changes). A forge hiccup
 * costs whichever column asked, never the row.
 */
export function readPrComments(pr: number, deps: HistoryReadDeps = defaultHistoryReadDeps): HistoryComment[] | null {
  try {
    return parseComments(deps.fetchPrComments(pr))
  } catch {
    return null
  }
}

/** Every interval the given pull requests' comments record, pooled — one entry per interval, so a phase's sample count is the real number of past intervals behind its median. */
export function phaseSamplesFromMergedPrs(
  prComments: readonly (readonly HistoryComment[])[],
  allowlist: readonly string[]
): PhaseSamples {
  const pooled = emptyPhaseSamples()
  for (const comments of prComments) {
    const samples = phaseSamplesFromPrComments(comments, allowlist)
    pooled.developing.push(...samples.developing)
    pooled.reviewing.push(...samples.reviewing)
  }
  return pooled
}

/** The typical time for the phase a run is recorded in, or `null` — no history class for that phase, or too few past intervals to answer. */
export type PhaseHistoryLookup = (recordedPhase: string) => TaskPhaseHistory | null

export function phaseHistoryLookupFor(samples: PhaseSamples): PhaseHistoryLookup {
  return (recordedPhase: string) => {
    const phaseClass = phaseHistoryClassFor(recordedPhase)
    if (phaseClass === null) return null
    return summarizePhaseSamples(samples[phaseClass])
  }
}

/** Every `gh` read this module makes, so a test can hand it fixtures instead of a forge. */
export type HistoryReadDeps = {
  listMergedPrs: () => string
  fetchPrComments: (pr: number) => string
  allowlist: () => string[]
}

export const defaultHistoryReadDeps: HistoryReadDeps = {
  listMergedPrs: () =>
    sh('gh', [
      'pr',
      'list',
      '--state',
      'merged',
      '--json',
      'number,headRefName,mergedAt',
      '--limit',
      String(MERGED_PR_LIST_LIMIT)
    ]),
  fetchPrComments: (pr: number) => sh('gh', ['pr', 'view', String(pr), '--json', 'comments']),
  allowlist: () => resolvePrincipalAllowlist(loadTrustAnchorConfig())
}

/**
 * The whole read, bounded at `1 + MERGED_TASK_PR_READ_CAP` forge calls, with
 * whether it actually reached the forge. A failure anywhere — the list read,
 * one pull request's comments, malformed JSON — costs that source's samples
 * and nothing else: the surviving samples still answer, and a total failure
 * answers "no typical time" rather than raising.
 *
 * `ok` is what keeps a failure out of the cache: it is `false` when the list
 * read itself failed, and when every pull request it named failed to read, so
 * the next status read retries instead of serving an emptiness the forge never
 * actually reported. A partial failure (some pull requests read) is `ok` — the
 * surviving intervals are real history, and their own sample count says how
 * many there were.
 */
export type PhaseSamplesRead = { samples: PhaseSamples; ok: boolean }

export function readPhaseSamples(deps: HistoryReadDeps = defaultHistoryReadDeps): PhaseSamplesRead {
  let numbers: number[]
  try {
    numbers = mergedTaskPrNumbers(deps.listMergedPrs())
  } catch {
    return { samples: emptyPhaseSamples(), ok: false }
  }
  const allowlist = deps.allowlist()
  const perPr: HistoryComment[][] = []
  for (const pr of numbers) {
    const comments = readPrComments(pr, deps)
    // A pull request that could not be read contributes no interval; the
    // others still do.
    if (comments !== null) perPr.push(comments)
  }
  // A list read that named pull requests none of which could be read reached
  // no history at all — not the same fact as a repository whose merged tasks
  // genuinely carry no interval yet.
  const ok = numbers.length === 0 || perPr.length > 0
  return { samples: phaseSamplesFromMergedPrs(perPr, allowlist), ok }
}

/** What the last read produced, when it was made, and whether it reached the forge — `ok` decides how long this entry is honoured. */
type CachedSamples = { samples: PhaseSamples; readAt: number; ok: boolean }

let cached: CachedSamples | null = null

/** A successful read is current for its full lifetime; a failed one only for the back-off, after which the forge is asked again. */
function stillCurrent(entry: CachedSamples, at: number): boolean {
  const lifetime = entry.ok ? PHASE_HISTORY_CACHE_TTL_MS : PHASE_HISTORY_FAILURE_BACKOFF_MS
  return at - entry.readAt < lifetime
}

/**
 * The lookup every row of ONE status read shares. Three properties, each for a
 * caller this module actually has:
 *
 *   - **Lazy.** The forge is read on the first row whose phase has a history
 *     class, so a read in which no row can carry a typical time pays nothing.
 *   - **At most one attempt per read.** The lookup object remembers its own
 *     attempt, successful or not, so ten rows in `developing` cost
 *     `1 + MERGED_TASK_PR_READ_CAP` calls and not ten times that — the bound
 *     holds when the forge is failing, which is precisely when repeating the
 *     read would deepen a rate limit rather than back off.
 *   - **Remembered across reads, for a lifetime that depends on the outcome.**
 *     A success is honoured for `PHASE_HISTORY_CACHE_TTL_MS`, a failure only for
 *     `PHASE_HISTORY_FAILURE_BACKOFF_MS`, so the long-lived task-tool server
 *     neither serves one transient failure for a whole session nor asks a
 *     refusing forge again on every call.
 */
export function phaseHistoryLookup(
  deps: HistoryReadDeps = defaultHistoryReadDeps,
  now: () => number = () => Date.now()
): PhaseHistoryLookup {
  let thisRead: PhaseSamples | null = null
  return (recordedPhase: string) => {
    if (phaseHistoryClassFor(recordedPhase) === null) return null
    if (thisRead === null) {
      const at = now()
      if (cached !== null && stillCurrent(cached, at)) {
        thisRead = cached.samples
      } else {
        const read = readPhaseSamples(deps)
        cached = { samples: read.samples, readAt: at, ok: read.ok }
        thisRead = read.samples
      }
    }
    return phaseHistoryLookupFor(thisRead)(recordedPhase)
  }
}

/** Drops what the last read remembered — for a test that reads history twice with different fixtures; production never calls it. */
export function resetPhaseHistoryCache(): void {
  cached = null
}
