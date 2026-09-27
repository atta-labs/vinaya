/**
 * What a phase typically takes in THIS repository — read off the pull
 * requests of its own recently merged tasks, never predicted.
 *
 * One bounded read per STATUS READ: the most recent merged task branches
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
 * secondary rate limit punishes. That count is the whole cost: the principal
 * allowlist is resolved by the caller and passed in, never re-fetched here.
 *
 * Nothing is read at all until a row actually asks about a phase that HAS a
 * history class AND is where its run currently is: a listing of planned, paused,
 * published or driverless tasks pays no forge call for this.
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
 * All three fields are checked against the parsed JSON rather than trusted from
 * the cast. The number this returns becomes an argument of a `gh pr view`
 * subprocess, and a value that is not a positive integer — a changed `gh`
 * output shape, a wrapper binary of that name on `PATH` — must never reach an
 * argument list, where one beginning with a dash would be read as a flag. The
 * merge timestamp decides WHICH pull requests the cap keeps: one that does not
 * parse would make the comparator return `NaN` and leave the order
 * implementation-defined, so the column would describe an arbitrary handful of
 * the listed rows rather than this repository lately.
 */
export function mergedTaskPrNumbers(raw: string, cap: number = MERGED_TASK_PR_READ_CAP): number[] {
  const parsed = JSON.parse(raw) as MergedPr[]
  return parsed
    .filter((pr) => Number.isInteger(pr.number) && pr.number > 0)
    .filter((pr) => typeof pr.headRefName === 'string' && pr.headRefName.startsWith('task/'))
    .filter((pr) => Number.isFinite(Date.parse(pr.mergedAt)))
    .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt))
    .slice(0, cap)
    .map((pr) => pr.number)
}

/**
 * EVERY field a comment contributes is checked against the parsed JSON rather
 * than trusted from the cast — the same reason `mergedTaskPrNumbers` checks its
 * own: this is forge output, and a changed `gh` shape (or a binary of that name
 * on `PATH`) must not hand a non-string value to a parser that calls
 * `body.match` or `login.toLowerCase()`. Those calls sit OUTSIDE this module's
 * own try, so a throw there would escape the read and take the whole status
 * answer down with it rather than costing one column. An unreadable author is
 * `null`, which the trust boundary already treats as not a principal.
 */
function parseComments(raw: string): HistoryComment[] {
  const parsed = JSON.parse(raw) as {
    comments: { body?: unknown; author?: { login?: unknown } | null; createdAt?: unknown }[]
  }
  return parsed.comments
    .filter((c) => typeof c.body === 'string' && typeof c.createdAt === 'string')
    .map((c) => ({
      body: c.body as string,
      author: typeof c.author?.login === 'string' ? c.author.login : null,
      createdAt: c.createdAt as string
    }))
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
  // Checked HERE, not only where the merged list is parsed: the confidence path
  // arrives with a pull-request number read off an open pull request's own JSON,
  // and the rule is the same wherever a value crosses into an argument list —
  // one beginning with a dash would be read by `gh` as a flag.
  if (!Number.isInteger(pr) || pr <= 0) return null
  try {
    return parseComments(deps.fetchPrComments(pr))
  } catch {
    return null
  }
}

/**
 * The same comment read, REMEMBERED per pull request and bounded per status
 * read — what the published-summary confidence path needs, which asks about one
 * pull request PER ROW rather than a fixed handful.
 *
 * A published run's summary never changes (the run is finished), so a
 * successful read is honoured for `PHASE_HISTORY_CACHE_TTL_MS` and a failed one
 * for `PHASE_HISTORY_FAILURE_BACKOFF_MS`, exactly as the history read's own
 * outcome decides its lifetime. An Operator polling `task_status` therefore
 * re-pays nothing, and one status read is capped at
 * `SUMMARY_CONFIDENCE_READS_PER_STATUS_READ` fresh reads whatever it is handed
 * — past that the confidence column reads as no record for the remaining rows
 * rather than spawning an unbounded number of synchronous subprocesses on the
 * shared task-tool server.
 */
export const SUMMARY_CONFIDENCE_READS_PER_STATUS_READ = 5

type RememberedComments = { comments: HistoryComment[] | null; readAt: number }

/**
 * How many pull requests' comments are remembered at once. The long-lived
 * task-tool server answers a whole Operator session from this one process, and
 * each entry holds a pull request's fully parsed comment bodies, so the memory
 * is bounded by count as well as by time: expired entries are dropped on every
 * read, and the oldest goes when a fresh read would pass this many.
 */
export const REMEMBERED_PR_COMMENTS_MAX = 32

const rememberedComments = new Map<number, RememberedComments>()

function rememberedIsCurrent(entry: RememberedComments, at: number): boolean {
  const lifetime = entry.comments === null ? PHASE_HISTORY_FAILURE_BACKOFF_MS : PHASE_HISTORY_CACHE_TTL_MS
  return at - entry.readAt < lifetime
}

/** Frees what time has already invalidated, then what count no longer allows — `Map` keeps insertion order, so the first key is the oldest read. */
function pruneRememberedComments(at: number): void {
  for (const [pr, entry] of rememberedComments) {
    if (!rememberedIsCurrent(entry, at)) rememberedComments.delete(pr)
  }
  while (rememberedComments.size >= REMEMBERED_PR_COMMENTS_MAX) {
    const oldest = rememberedComments.keys().next()
    if (oldest.done) break
    rememberedComments.delete(oldest.value)
  }
}

/**
 * What one status read's own comment reader answers with. The three cases are
 * deliberately distinct: comments that were read (`read`, whose list can be
 * empty), a read that was ATTEMPTED and failed (`failed`), and a read this
 * status read never made because its budget was already spent (`unread`). A
 * caller must be able to tell an absence it can report from an unknown it
 * cannot — the table renders the last case as "not read", never as the dash
 * that means no record carries this.
 */
export type PrCommentsAnswer = { kind: 'read'; comments: HistoryComment[] } | { kind: 'failed' } | { kind: 'unread' }

export type PrCommentReader = (pr: number) => PrCommentsAnswer

export function prCommentReaderForOneStatusRead(
  deps: HistoryReadDeps = defaultHistoryReadDeps,
  now: () => number = () => Date.now()
): PrCommentReader {
  let freshReads = 0
  return (pr: number) => {
    const at = now()
    const remembered = rememberedComments.get(pr)
    if (remembered !== undefined && rememberedIsCurrent(remembered, at)) {
      return remembered.comments === null ? { kind: 'failed' } : { kind: 'read', comments: remembered.comments }
    }
    if (freshReads >= SUMMARY_CONFIDENCE_READS_PER_STATUS_READ) return { kind: 'unread' }
    freshReads += 1
    pruneRememberedComments(at)
    const comments = readPrComments(pr, deps)
    rememberedComments.set(pr, { comments, readAt: at })
    return comments === null ? { kind: 'failed' } : { kind: 'read', comments }
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

/**
 * Every `gh` read this module makes, so a test can hand it fixtures instead of a
 * forge. The principal allowlist is deliberately NOT one of them: it is resolved
 * once by the status read that owns the request and passed in, because resolving
 * it here would spawn a second trust-anchor read (`gh api …/contents/…`) per
 * status read, carrying neither this module's timeout nor its output ceiling,
 * and would print the fallback warning twice on a failure.
 */
export type HistoryReadDeps = {
  listMergedPrs: () => string
  fetchPrComments: (pr: number) => string
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
  fetchPrComments: (pr: number) => sh('gh', ['pr', 'view', String(pr), '--json', 'comments'])
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

export function readPhaseSamples(
  allowlist: readonly string[],
  deps: HistoryReadDeps = defaultHistoryReadDeps
): PhaseSamplesRead {
  let numbers: number[]
  try {
    numbers = mergedTaskPrNumbers(deps.listMergedPrs())
  } catch {
    return { samples: emptyPhaseSamples(), ok: false }
  }
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
  allowlist: readonly string[],
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
        const read = readPhaseSamples(allowlist, deps)
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
  rememberedComments.clear()
}
