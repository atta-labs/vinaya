/**
 * Everything the `task_pr_read` tool and the status table BOTH derive from a
 * pull request, with no handler in it — the module both readers import, and a
 * leaf on purpose.
 *
 * Three layers, in the order the readers use them:
 *
 * 1. **The exit every byte of unauthored forge text takes** (`sanitizeForgeText`
 *    and its tail-capped twin). A check name, a check's own reported output, an
 *    annotation, a job log, a forge label — none has an author to filter through
 *    an allowlist, so each is stripped of terminal colouring, redacted through
 *    `redact()` (this codebase's single redaction chokepoint), stripped of the two
 *    grammars that carry authority here, and capped.
 *    The one job-log reader (`readJobLogTail`) sits beside it, so the Operator's
 *    read and the review loop's red-CI retry tail a failed job's log identically.
 * 2. **The forge's rollup, flattened** (`RollupNode`, `toChecks`) — one shape both
 *    readers judge checks by.
 * 3. **The derivations each reader needs**: the principal-authored review record
 *    (`buildReviewRecord`), and the status table's own five pull-request columns
 *    (`taskPrFactsFrom`) plus the one bounded forge read behind them
 *    (`readTaskPrFacts`).
 *
 * **Why it is a module of its own.** `pr-read.ts` resolves its pull request through
 * `handlers.ts`, which reads the status rows from `task-status.ts` — so anything
 * `task-status.ts` imports from `pr-read.ts` closes a module cycle. It initialized
 * only because every binding crossing it was a hoisted `export function`;
 * converting one to a const arrow would have broken module init at import time
 * with no test to catch it. Nothing here imports a handler or the status reader,
 * so the cycle is gone rather than merely dormant.
 *
 * Nothing here writes: no forge-write function is imported, and the two `gh`
 * calls it makes — the status read and the job-log read — are bounded reads.
 */

import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import {
  extractCodeReviewVerdict,
  extractSecurityReviewVerdict,
  isPrincipal,
  MAX_RETURNED_TEXT_CHARS,
  parseDeveloperRoundMarker,
  redact,
  type TaskPrCheck,
  type TaskPrReviewRecord,
  type TaskPrVerdict
} from '@attalabs/aeg-core'
import { markerComments } from '../dev-review-loop/developer-dispatch.js'
import { sh } from '../dev-review-loop/gate-reading.js'
import { PRINCIPAL_TEST_PLAN_WAIT_CHECK_RUN_NAME } from '../principal-test-plan-wait-check-name.js'
import { REVIEW_GATE_CHECK_RUN_NAME, REVIEW_GATE_WORKFLOW_NAME } from '../review-gate-check-name.js'

/**
 * The ceiling on one `gh` read made for a status row, in time and in output.
 *
 * Declared here because this is where the read is, and imported by
 * `task-status.ts` for its own reads rather than copied there: these reads are
 * synchronous and the long-lived task-tool server chains every request through
 * one promise, so a `gh` that never returns holds every other task's queued call
 * behind it. A retry would multiply that hold, which is why the read below has
 * none — a read that expires empties its own columns and raises nothing.
 *
 * The output ceiling is raised past `execFileSync`'s own 1 MiB default for the
 * same reason every other `gh`-reading call in this codebase raises it: a pull
 * request's comment payload is adopter-influenced content and has passed that
 * default in practice.
 */
export const GH_STATUS_READ_TIMEOUT_MS = 20_000
export const MAX_GH_STATUS_OUTPUT_BYTES = 64 * 1024 * 1024

/** One comment as the forge reports it — body plus the login that authored it, the only two fields any derivation below reads. */
export type PrComment = { body: string; author: string | null }
/** Exactly `<!-- aeg:loop:paused:<reason> -->`, the marker `pause-resume.ts`'s `pauseMarker` renders — matched, never re-rendered, so the two can only drift by one of them changing the literal. */
const PAUSE_MARKER = /<!--\s*aeg:loop:paused:([a-z_]+)\s*-->/i
/** A check name, a status and a conclusion are labels, not prose — bounded far below the free-text ceiling so a workflow file cannot spend a whole result on one. */
const MAX_CHECK_NAME_CHARS = 200
/** At most this many failed checks get their failing job's log read — a read tool must stay a read, and a pull request with a dozen red checks has its answer in the first few. */
const MAX_FAILURE_LOG_READS = 3
/** A conclusion that is not a failure — the same three `gate-reading.ts`'s own `fetchCiConclusion` counts as green, so this tool and the driver never disagree about which checks failed. */
const PASSING_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
/** Every free-text field this tool returns goes through here — adopter-influenced content never leaves this module unbounded. */
export function capText(raw: string, max: number = MAX_RETURNED_TEXT_CHARS): string {
  const text = raw.trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** The tail, not the head: a job log's last lines are where the failure is, and its first lines are setup noise. */
export function capTail(raw: string, max: number = MAX_RETURNED_TEXT_CHARS): string {
  const text = raw.trimEnd()
  return text.length > max ? `…${text.slice(text.length - max)}` : text
}

/**
 * Terminal colouring a runner writes into its own log — stripped before the
 * text is carried into a tool result. Built through `RegExp` from the escape
 * byte's own code point rather than written as a literal, so this source file
 * carries no raw control character of its own.
 */
const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g')

export function stripAnsi(raw: string): string {
  return raw.replace(ANSI_SEQUENCE, '')
}

/**
 * An HTML comment opener, the syntax every AEG control marker is written in
 * (`<!-- aeg:principal:ruling … -->`, `<!-- aeg:loop:paused:… -->`,
 * `<!-- aeg:developer:round-N -->`). Neutralized in forge text by escaping
 * the opening angle bracket: the text still reads as itself, and no reader
 * — this module's own marker regexes, the loop's, or a human scanning the
 * result — can mistake it for a real marker.
 */
const HTML_COMMENT_OPENER = /<!--/g

/**
 * A line-anchored `VERDICT:` label, the one grammar the merge gate's own
 * extractors read as a cast verdict. Defanged by separating the label from
 * its colon: every extractor pattern requires the colon immediately after
 * the word, so the text survives legibly while parsing as prose.
 */
const VERDICT_LABEL = /^([ \t]*(?:\*{1,3}|_{1,3})?)VERDICT:/gim

/**
 * The one exit every byte of forge-controlled text takes before it becomes
 * part of a tool result. Four steps, in this order:
 *
 * 1. **Strip terminal colouring** — a runner colours its own log, and the
 *    escape bytes are noise at best.
 * 2. **Redact secrets** through `redact()` (`packages/aeg-core/src/log/redact.ts`),
 *    this codebase's single redaction chokepoint — the same one the Vinaya
 *    Log applies before an event leaves the machine. A CI step that prints a
 *    token, an environment dump or a credential during a failing run must not
 *    hand it to a caller just because the run was red.
 * 3. **Neutralize control grammar** — this text is UNATTRIBUTABLE. A pull
 *    request comment has an author, which is what lets `buildReviewRecord`
 *    filter it through the principal allowlist; a check name, a check's own
 *    reported output, an annotation and a job log have no author at all, and
 *    anyone who can land a workflow file or a build step on the task's branch
 *    can write them. So the two grammars that carry authority in this system
 *    — an AEG control comment and a `VERDICT:` line — are defanged here,
 *    leaving text that reads as itself and parses as nothing.
 * 4. **Cap** at the catalog's own ceiling, so no single field is unbounded.
 *
 * What this is NOT: a guarantee that the text is safe to ACT on. It is
 * untrusted CI output, and the Operator's own doctrine says so — the seat
 * quotes what a failed check said, it never follows it.
 */
export function sanitizeForgeText(raw: string, max: number = MAX_RETURNED_TEXT_CHARS): string {
  return capText(scrubForgeText(raw), max)
}

/** `sanitizeForgeText`'s steps 1–3 with step 4 taken from the TAIL instead of the head — where a job log's failure actually is. */
export function sanitizeForgeLogTail(raw: string, max: number = MAX_RETURNED_TEXT_CHARS): string {
  return capTail(scrubForgeText(raw), max)
}

/** Steps 1–3 of `sanitizeForgeText`, uncapped — the one place the strip/redact/defang order is written, so the head-capped and tail-capped exits can never diverge on it. */
function scrubForgeText(raw: string): string {
  return redact(stripAnsi(raw), homedir()).replace(HTML_COMMENT_OPENER, '&lt;!--').replace(VERDICT_LABEL, '$1VERDICT :')
}

// --- the one job-log reader ---------------------------------------------------

/** One `gh` invocation, by argument list — the driver's own retrying read by default, a fake in a test. */
export type GhRead = (args: string[]) => string

const ghRead: GhRead = (args) => sh('gh', args)

/**
 * The sanitized TAIL of a GitHub Actions job's own log — the ONE job-log reader
 * in this codebase. The Operator's `task_pr_read` falls back to it for a failed
 * check that wrote no output of its own, and the review loop reads it for every
 * failed check it sends a Developer back on, so the redaction, the authority
 * stripping and the size cap are the same for both callers.
 *
 * For a GitHub Actions check run the check-run id IS the job id, and the job
 * log is the only place its failure is actually written. Read with
 * `--allow-escape-sequences` (a runner colours its own output, and `gh`
 * refuses to print escapes without it), retried without the flag on a `gh`
 * old enough not to carry it. `null` when neither read answers or the log is
 * empty — a reader reports what it could not see rather than inventing a
 * reason.
 */
export function readJobLogTail(jobId: number, read: GhRead = ghRead): string | null {
  const endpoint = `repos/{owner}/{repo}/actions/jobs/${jobId}/logs`
  let raw: string
  try {
    raw = read(['api', endpoint, '--allow-escape-sequences'])
  } catch {
    try {
      raw = read(['api', endpoint])
    } catch {
      return null
    }
  }
  const text = sanitizeForgeLogTail(raw)
  return text === '' ? null : text
}

/** One failed check run on a head, with its own sanitized job-log tail — `null` when the log could not be read. */
export type FailedCheckLog = { check: string; runId: number; logTail: string | null }

/**
 * Each failed check run's log tail, one `readJobLogTail` per run handed in —
 * never a read for a check that did not fail, so the forge cost is bounded by
 * the failures on the head the caller read them from. The check name is forge
 * text with no author, so it leaves through `sanitizeForgeText` like every
 * other one.
 */
export function readFailedCheckLogs(
  runs: readonly { name: string; id: number }[],
  readTail: (jobId: number) => string | null = readJobLogTail
): FailedCheckLog[] {
  return runs.map((run) => ({
    check: sanitizeForgeText(run.name, MAX_CHECK_NAME_CHARS),
    runId: run.id,
    logTail: readTail(run.id)
  }))
}
// --- the pure half: the review record, from comment bodies alone -------------

/**
 * The pull request's review record for the task, derived from
 * PRINCIPAL-AUTHORED comments only. A comment whose author does not resolve
 * against `allowlist` is dropped before anything below reads it — it
 * contributes no verdict, no round marker, no pause, and
 * its body is never returned.
 *
 * The verdicts come from the merge gate's OWN extractors
 * (`extractCodeReviewVerdict`/`extractSecurityReviewVerdict`), which already
 * pick the newest comment that cast one and read its `Judged head:` binding —
 * so this tool can never disagree with the gate about which comment cast a
 * verdict or what head it judged. There is no second verdict regex here.
 */
export function buildReviewRecord(comments: readonly PrComment[], allowlist: readonly string[]): TaskPrReviewRecord {
  const bodies = comments.filter((c) => isPrincipal(c.author, allowlist as string[])).map((c) => c.body)

  const verdicts: TaskPrVerdict[] = []
  const code = extractCodeReviewVerdict(bodies)
  if (code.danglingNote === null) {
    verdicts.push({
      role: 'code-review',
      value: code.value,
      judgedHead: code.headSha,
      objectivesVersion: code.objectivesVersion
    })
  }
  const security = extractSecurityReviewVerdict(bodies)
  if (security.danglingNote === null) {
    verdicts.push({
      role: 'security',
      value: security.value,
      judgedHead: security.headSha,
      objectivesVersion: security.objectivesVersion
    })
  }

  const roundMarkers = [
    ...new Set(bodies.map((body) => parseDeveloperRoundMarker(body)).filter((n): n is number => n !== null))
  ].sort((a, b) => a - b)

  const pauseBody = bodies.filter((body) => PAUSE_MARKER.test(body)).at(-1) ?? null
  const pauseReason = pauseBody === null ? null : (pauseBody.match(PAUSE_MARKER)?.[1] ?? null)
  const pause = pauseBody !== null && pauseReason !== null ? { reason: pauseReason, body: capText(pauseBody) } : null

  return { verdicts, roundMarkers, pause }
}

// --- the status table's own pull-request columns ------------------------------

/**
 * A head's check runs as ONE word. The same three-value reading
 * `gate-reading.ts`'s `fetchCiConclusion` gives the driver, over the same
 * population and in the same order of precedence:
 *
 *   - **The same population.** CHECK RUNS only. A plain commit status
 *     (`StatusContext`) is not counted at all, because the driver's own read
 *     is the REST check-runs list and never sees one — counting them here let
 *     a third-party commit status move this word while the driver's stayed put,
 *     and told a reader a divergence could not exist while one could.
 *   - **The same precedence.** Anything not yet completed wins over a failure,
 *     because a head whose suite has not finished has not failed yet; then every
 *     completed run must conclude `SUCCESS`/`NEUTRAL`/`SKIPPED` for green, and
 *     anything else — a `FAILURE`, a `TIMED_OUT`, or a completed run carrying no
 *     conclusion at all — is red, exactly as the driver reads it.
 */
export type TaskPrCheckSummary = 'green' | 'red' | 'running'

/**
 * Everything a status row shows about its own pull request, from ONE forge
 * read of that pull request — never one read per column.
 *
 * `ci` is the MECHANICAL suite only: the review gate's own check-run and the
 * principal-test-plan wait are excluded, the same two `fetchCiConclusion`
 * excludes and for the same reasons — the gate is not CI, and the wait's red
 * is the Principal's own hold rather than a failure anyone can push a fix
 * for. `gate` is the review gate's own CHECK RUN, read as the same three
 * words, and `null` when the forge reports no such check run on this head.
 *
 * Both read CHECK RUNS only, never a commit status — see
 * {@link TaskPrCheckSummary} for the `ci` half, and
 * {@link taskPrFactsFrom} for why the gate half matters more.
 *
 * `codeReview`/`security` are the newest verdict values the merge gate's own
 * extractors read, and ONLY when the verdict is bound to `head`: a verdict
 * that judged an earlier head is not a verdict on this one, and reporting it
 * as if it were is how a stale approval reads as a current one.
 */
export type TaskPrFacts = {
  /** The head the columns below were read against — `null` when the forge reported none. */
  head: string | null
  ci: TaskPrCheckSummary
  gate: TaskPrCheckSummary | null
  /** The newest code-review verdict value on this head — `APPROVE`, `REQUEST CHANGES` or `LGTM` — else `null`. Only `APPROVE` counts as clean where merge-readiness is decided (`task-status.ts`'s own `CLEAN_CODE_REVIEW`), the same one value the merge gate accepts. */
  codeReview: string | null
  /** `PASS` or `FAIL` on this head, else `null`. */
  security: string | null
}

/**
 * Is this rollup node a CHECK RUN, rather than a plain commit status?
 *
 * Every column the status table derives from the rollup reads check runs only,
 * and the reason is not tidiness. A commit status is posted by anything holding
 * `statuses:write` on the repository, its `context` is a free string, and
 * `toChecks` flattens it to `status: 'COMPLETED'` with its own `state` as the
 * conclusion — so a status whose context is spelled exactly like the review
 * gate's check-run name read as a GREEN GATE, and with the two principal
 * verdicts already on the head, the table then named `merge` for a head the
 * real gate was refusing. Excluding them also removes the `ci` divergence that
 * came with them (see {@link TaskPrCheckSummary}).
 *
 * This is a narrowing, not an authentication: a check run still comes from
 * whatever app holds `checks:write`. Attributing one to the app that should
 * have posted it needs a field this read does not carry, and the Operator's own
 * doctrine already says a check's own output is evidence to quote rather than
 * instruction to follow.
 */
function isCheckRun(node: RollupNode): boolean {
  return node.__typename === 'CheckRun'
}

/**
 * Is this the review gate's OWN check run — its check name AND the workflow that
 * posts it?
 *
 * The name alone is a free string. Anything able to create a check run on the
 * head can carry it, and `latestNodeRunPerName` hands the newest run under a name
 * the cell, so a later-started run named `vinaya review gate` concluding
 * `SUCCESS` read as a green gate — and with both clean verdicts already on that
 * head, the table then named `merge` for a head the real gate was refusing. That
 * is a merge instruction a Principal acts on, which is why a name match is not
 * enough here even though it is enough for the mechanical set (where a run
 * merely NAMED like the gate is excluded either way).
 *
 * The workflow name is read from the same payload — no extra forge call — and a
 * run created through the checks API outside Actions carries none at all. It is
 * attribution by what the forge reports, not authentication: see
 * `REVIEW_GATE_WORKFLOW_NAME`'s own note for what closing that would cost and
 * why the merge gate re-evaluating before any merge is what actually decides.
 *
 * The gate run is selected from the gate-shaped runs FIRST and only then deduped
 * to the newest of them, so a run that claims the name without the workflow
 * cannot suppress the real gate's own conclusion either.
 */
function isReviewGateRun(node: RollupNode): boolean {
  return node.name === REVIEW_GATE_CHECK_RUN_NAME && node.workflowName === REVIEW_GATE_WORKFLOW_NAME
}

/**
 * One node per check name — the newest run by `startedAt`, so a check re-run
 * after a failure is judged by the run that superseded it rather than by both.
 * The same dedupe rule `gate-reading.ts` applies to the driver's own check-run
 * read (newest start wins, never the highest id, ties keeping the first seen),
 * applied here at the NODE level because `toChecks` deliberately does not
 * dedupe: `task_pr_read` answers "what does the forge report on this head",
 * and collapsing two same-named contexts answers a different question.
 *
 * A node with no name at all cannot be grouped by one and is kept as itself.
 */
export function latestNodeRunPerName(nodes: readonly RollupNode[]): RollupNode[] {
  const latest = new Map<string, RollupNode>()
  const unnamed: RollupNode[] = []
  for (const node of nodes) {
    const name = node.name ?? node.context ?? null
    if (name === null) {
      unnamed.push(node)
      continue
    }
    const seen = latest.get(name)
    if (seen === undefined) {
      latest.set(name, node)
      continue
    }
    const at = Date.parse(node.startedAt ?? '')
    const seenAt = Date.parse(seen.startedAt ?? '')
    // An unparseable or absent start time never outranks one that reads: a
    // comparison that cannot be made is not evidence for replacing what is
    // already held.
    if (Number.isFinite(at) && (!Number.isFinite(seenAt) || at > seenAt)) latest.set(name, node)
  }
  return [...latest.values(), ...unnamed]
}

/**
 * One check run's own outcome, by exactly the rule `fetchCiConclusion` applies
 * to the same run: not completed is still running, and a COMPLETED run is a pass
 * only when it concluded `SUCCESS`, `NEUTRAL` or `SKIPPED`.
 *
 * A completed run carrying NO conclusion is therefore a failure, not a wait —
 * reading it as still running (as this did until a review caught it) is the one
 * direction that disagrees with the driver, and it disagrees in the unsafe
 * direction: the driver stops polling and calls that head red while the table
 * still says the suite has not finished.
 */
function checkOutcome(check: TaskPrCheck): 'pass' | 'fail' | 'running' {
  if (check.status.toUpperCase() !== 'COMPLETED') return 'running'
  const conclusion = check.conclusion === null ? null : check.conclusion.toUpperCase()
  return conclusion !== null && PASSING_CONCLUSIONS.has(conclusion) ? 'pass' : 'fail'
}

/** The one word a set of check runs reads as — see {@link TaskPrCheckSummary} for the population and the precedence. A head with no check run reported at all is `running`: nothing has concluded on it yet. */
export function summarizeChecks(checks: readonly TaskPrCheck[]): TaskPrCheckSummary {
  if (checks.length === 0) return 'running'
  const outcomes = checks.map(checkOutcome)
  if (outcomes.includes('running')) return 'running'
  return outcomes.every((outcome) => outcome === 'pass') ? 'green' : 'red'
}

/** A verdict this pull request cast on THIS head, or `null` — a verdict bound to another head (or to none) says nothing about the head a reader is looking at. */
function verdictOnHead(
  verdicts: readonly TaskPrVerdict[],
  role: TaskPrVerdict['role'],
  head: string | null
): string | null {
  if (head === null) return null
  const found = verdicts.find((verdict) => verdict.role === role && verdict.judgedHead === head)
  return found ? found.value : null
}

/**
 * The pure half of the status table's pull-request columns: the same
 * `toChecks` flattening and the same `buildReviewRecord` derivation
 * `task_pr_read` already uses, read for a summary rather than for a
 * diagnosis. No `gh` call in it, so every column is unit-testable against
 * fixtures.
 *
 * `toChecks` is handed a failure-detail reader that answers nothing: a
 * failure summary is what `task_pr_read` exists to give, and reading a job
 * log per red check would turn one status read into many forge calls for a
 * cell that only ever shows one word.
 */
export function taskPrFactsFrom(
  head: string | null,
  nodes: readonly RollupNode[],
  comments: readonly PrComment[],
  allowlist: readonly string[]
): TaskPrFacts {
  // Check runs only, before anything else reads a name or a conclusion — see
  // `isCheckRun` for the green gate a commit status could otherwise claim.
  const runs = nodes.filter(isCheckRun)
  // The gate's own run, chosen among the runs that carry BOTH its check name and
  // its workflow (`isReviewGateRun`) and only then deduped to the newest of
  // those — never the newest run that merely claims the name.
  const gate = latestNodeRunPerName(runs.filter(isReviewGateRun)).at(0) ?? null
  // The mechanical set still excludes both the gate's name and the
  // principal-test-plan wait's by NAME: neither is CI, and a run merely named
  // like one of them must not move this word either.
  const mechanical = toChecks(
    latestNodeRunPerName(runs).filter(
      (node) => node.name !== REVIEW_GATE_CHECK_RUN_NAME && node.name !== PRINCIPAL_TEST_PLAN_WAIT_CHECK_RUN_NAME
    ),
    () => null
  )
  const review = buildReviewRecord(comments, allowlist)
  return {
    head,
    ci: summarizeChecks(mechanical),
    gate: gate === null ? null : summarizeChecks(toChecks([gate], () => null)),
    codeReview: verdictOnHead(review.verdicts, 'code-review', head),
    security: verdictOnHead(review.verdicts, 'security', head)
  }
}

/**
 * The facts a pull request's own read produced, WITH the comments it read them
 * from. The comments ride along so a caller that needs them for a second column
 * spends no second forge call on the same pull request — the confidence column
 * asks the same question of the same payload for a published row
 * (`task-status.ts`'s own `buildRow`).
 */
export type TaskPrRead = { facts: TaskPrFacts; comments: PrComment[] }

/**
 * ONE forge read per pull request — `gh pr view` asked for the head, the
 * status-check rollup and the comments together, because every column above
 * comes out of that one payload and a read per column would multiply a status
 * listing's forge cost by the number of columns.
 *
 * Deliberately NOT remembered between status reads, unlike the confidence
 * column's own comment read: a check that was green on the last read is not
 * green now, and the Operator doctrine's reporting rule turns on exactly that
 * — a cached CI word would be an earlier reading served as current. It IS
 * bounded per status read, by the caller that owns the budget
 * (`task-status.ts`'s `prFactsReaderFor`).
 *
 * `null` when the read or the parse failed. That is an UNKNOWN, not an
 * absence, and a caller must render it as one: reporting a forge read that
 * never answered as "no record carries this" is the one invented fact this
 * table avoids everywhere else.
 *
 * The HEAD it reports is `headRefOid`, which this repository documents as able
 * to lag a push (`gate-reading.ts`'s `resolveHead` refuses it by name and reads
 * `git ls-remote` instead). Every column here is read against that one head and
 * says so, so the set is internally consistent; what it cannot promise is that
 * the head is the branch's tip this instant. Resolving the true tip is a network
 * call per row, which is the unbounded fan-out the budget above exists to
 * prevent, and the merge gate re-checks the real head before any merge lands.
 */
/**
 * The one `gh` call this read makes, behind a parameter — so the guard, the page
 * bound and every parse failure are testable with no `gh` on `PATH`.
 *
 * Bounded in time and in output ({@link GH_STATUS_READ_TIMEOUT_MS}), and
 * deliberately NOT through the driver's own retrying read: a retry inside a
 * synchronous read on the shared task-tool server multiplies exactly the hold
 * the budget above exists to bound. A read that expires empties its own columns
 * — `not read`, the unknown the table already has a word for.
 */
export function fetchPrFactsPayload(pr: number): string {
  return execFileSync('gh', ['pr', 'view', String(pr), '--json', 'headRefOid,statusCheckRollup,comments'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: MAX_GH_STATUS_OUTPUT_BYTES,
    timeout: GH_STATUS_READ_TIMEOUT_MS
  }).trim()
}

export function readTaskPrFacts(
  pr: number,
  allowlist: readonly string[],
  fetchPayload: (pr: number) => string = fetchPrFactsPayload
): TaskPrRead | null {
  // Checked HERE, before the number reaches an argument list — the same guard
  // `readPrComments` (`task-status-history.ts`) states at the identical
  // boundary: a number beginning with a dash would be read by `gh` as a flag.
  if (!Number.isInteger(pr) || pr <= 0) return null
  let raw: string
  try {
    raw = fetchPayload(pr)
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as { headRefOid?: string | null; statusCheckRollup?: RollupNode[] | null }
    const nodes = parsed.statusCheckRollup ?? []
    // `gh pr view` returns ONE unpaginated rollup page, unlike both readers this
    // function keeps parity with (`task_pr_read`'s own rollup read walks
    // `pageInfo`/`endCursor`; the driver's `fetchMechanicalCheckRuns` passes
    // `--paginate`). A head that fills the page may carry checks outside it, and
    // a `ci` word summarized over a partial set could read green beside a red
    // check this read never saw, or report the gate absent for a gate that ran.
    // Neither is something to guess at, so a full page is reported as a read that
    // could not answer — `not read` in every column — and the whole answer stays
    // one forge call. `task_pr_read` is the paginated read for such a head.
    if (nodes.length >= ROLLUP_SINGLE_PAGE_MAX) return null
    // The comments are parsed by the loop's OWN parser, out of the same raw
    // payload — one parser for a comment's author, never a second
    // `author.login` mapping beside it.
    const comments = markerComments(raw)
    return {
      facts: taskPrFactsFrom(parsed.headRefOid ?? null, nodes, comments, allowlist),
      comments
    }
  } catch {
    return null
  }
}
/** One node of the forge's status-check rollup, in either of its two shapes — a check run, or a plain commit status. */
export type RollupNode = {
  __typename?: string
  databaseId?: number | null
  name?: string | null
  /** When this run started, as the forge reports it — read only by `latestNodeRunPerName`, which needs it to tell a re-run from the run it superseded. Absent on a `StatusContext`, and on a read that never asked for it. */
  startedAt?: string | null
  /** The workflow a check run belongs to, as the forge reports it — `null`/absent for a check run created outside Actions, and for a `StatusContext`, which has no workflow at all. Read only by `isReviewGateRun`. */
  workflowName?: string | null
  status?: string | null
  conclusion?: string | null
  isRequired?: boolean | null
  title?: string | null
  summary?: string | null
  detailsUrl?: string | null
  context?: string | null
  state?: string | null
  description?: string | null
  targetUrl?: string | null
}
/**
 * The size of `gh pr view --json statusCheckRollup`'s own single rollup page —
 * its query asks for one page of contexts and exposes no cursor, so a payload
 * carrying this many nodes is a page that may be full rather than a head that
 * happens to report exactly this many checks. `readTaskPrFacts` treats that as a
 * read it cannot answer; nothing else reads it.
 */
const ROLLUP_SINGLE_PAGE_MAX = 100
/**
 * A rollup node flattened to the one `TaskPrCheck` shape the catalog
 * declares. `failureDetail` is only ever consulted for a COMPLETED check that
 * failed and wrote no output of its own, and only for the first
 * `MAX_FAILURE_LOG_READS` of them — injectable so the flattening itself is a
 * pure unit test.
 */
export function toChecks(
  nodes: readonly RollupNode[],
  failureDetail: (checkRunId: number) => string | null
): TaskPrCheck[] {
  const checks: TaskPrCheck[] = []
  let detailReads = 0
  for (const node of nodes) {
    if (node.__typename === 'StatusContext') {
      const conclusion = node.state ?? null
      checks.push({
        name: sanitizeForgeText(node.context ?? '(unnamed status)', MAX_CHECK_NAME_CHARS),
        required: node.isRequired === true,
        status: 'COMPLETED',
        conclusion,
        detailsUrl: node.targetUrl === undefined || node.targetUrl === null ? null : sanitizeForgeText(node.targetUrl),
        failureSummary: isFailed(conclusion) && node.description ? sanitizeForgeText(node.description) : null
      })
      continue
    }
    const conclusion = node.conclusion ?? null
    const failed = node.status === 'COMPLETED' && isFailed(conclusion)
    const reported = failed
      ? [node.title, node.summary].filter((text): text is string => typeof text === 'string' && text.trim() !== '')
      : []
    let failureSummary: string | null = null
    if (reported.length > 0) failureSummary = sanitizeForgeText(reported.join('\n\n'))
    else if (failed && typeof node.databaseId === 'number' && detailReads < MAX_FAILURE_LOG_READS) {
      detailReads++
      failureSummary = failureDetail(node.databaseId)
    }
    checks.push({
      name: sanitizeForgeText(node.name ?? '(unnamed check)', MAX_CHECK_NAME_CHARS),
      required: node.isRequired === true,
      status: sanitizeForgeText(node.status ?? 'UNKNOWN', MAX_CHECK_NAME_CHARS),
      conclusion: conclusion === null ? null : sanitizeForgeText(conclusion, MAX_CHECK_NAME_CHARS),
      detailsUrl: node.detailsUrl === undefined || node.detailsUrl === null ? null : sanitizeForgeText(node.detailsUrl),
      failureSummary
    })
  }
  return checks
}

function isFailed(conclusion: string | null): boolean {
  return conclusion !== null && !PASSING_CONCLUSIONS.has(conclusion.toUpperCase())
}
