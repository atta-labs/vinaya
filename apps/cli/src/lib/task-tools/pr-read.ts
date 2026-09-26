/**
 * `task_pr_read`'s handler — the one read that answers "why is my task's
 * pull request red?" without handing the Operator a shell, a token, or
 * anything it could write with.
 *
 * Two halves, deliberately separated:
 *
 * 1. **The forge half** (`defaultPrReadForge`) — every `gh` call this tool
 *    makes, all of them reads, all of them through the driver's OWN read
 *    path (`gate-reading.ts`'s `sh`, with its retry and its output ceiling),
 *    never a credential of the caller's. It resolves the pull request from
 *    the SELECTED TASK's own branch (`handlers.ts`'s `resolveRowForRef`, the
 *    same rows `task_status` reports), reads the forge's own status-check
 *    rollup for that pull request, and reads its comments.
 * 2. **The pure half** (`buildReviewRecord`) — derives the review record from
 *    comment bodies alone, with no `gh` call in it, so the trust boundary
 *    this tool's whole safety rests on is unit-testable against fixtures.
 *
 * The trust boundary: everything read off a pull request is DATA, not
 * instruction. Every comment is filtered through the same `isPrincipal`
 * allowlist the loop's own forge reads use (the filter `checkReviewGate`
 * itself applies before either verdict extractor) before a single byte of it
 * is read for meaning, and no body from outside that allowlist is ever
 * carried out of this module. Every free-text field is capped at the
 * catalog's own `MAX_RETURNED_TEXT_CHARS`.
 *
 * Read-only, structurally: there is no forge-write function imported here,
 * no `--resume`, no re-run, no merge. The only pull request it will read is
 * the one the selected task's own branch carries; a caller-supplied `pr` is
 * a cross-check that refuses on mismatch, never a second way in.
 */

import {
  extractCodeReviewVerdict,
  extractSecurityReviewVerdict,
  isPrincipal,
  isPublishedSummaryComment,
  MAX_RETURNED_TEXT_CHARS,
  parseDeveloperRoundMarker,
  SUMMARY_TABLE_HEADER,
  type TaskPrCheck,
  type TaskPrReadResult,
  type TaskPrReviewRecord,
  type TaskPrVerdict,
  TaskPrReadInputSchema,
  type TaskToolError,
  taskToolError,
  type TaskToolRef
} from '@attalabs/aeg-core'
import { principalAllowlist } from '../dev-review-loop/developer-dispatch.js'
import { sh } from '../dev-review-loop/gate-reading.js'
import { resolveRowForRef, type TaskToolCallResult } from './handlers.js'

/** One comment as the forge reports it — body plus the login that authored it, the only two fields any derivation below reads. */
export type PrComment = { body: string; author: string | null }

/** Exactly `<!-- aeg:loop:paused:<reason> -->`, the marker `pause-resume.ts`'s `pauseMarker` renders — matched, never re-rendered, so the two can only drift by one of them changing the literal. */
const PAUSE_MARKER = /<!--\s*aeg:loop:paused:([a-z_]+)\s*-->/i

/** At most this many failed checks get their failing job's log read — a read tool must stay a read, and a pull request with a dozen red checks has its answer in the first few. */
const MAX_FAILURE_LOG_READS = 3

/** The runner's own generic epitaph on a failed step: it repeats what `conclusion` already said and names no reason, so it never stands in for the log that does. */
const GENERIC_EXIT_ANNOTATION = /^Process completed with exit code \d+\.?$/

/** A conclusion that is not a failure — the same three `gate-reading.ts`'s own `fetchCiConclusion` counts as green, so this tool and the driver never disagree about which checks failed. */
const PASSING_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])

function ok<T>(result: T): TaskToolCallResult<T> {
  return { ok: true, result }
}

function fail<T>(error: TaskToolError): TaskToolCallResult<T> {
  return { ok: false, error }
}

function refDescription(ref: TaskToolRef): string {
  return 'issue' in ref ? `Issue #${ref.issue}` : `[${ref.tranche}] ${ref.id}`
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

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

// --- the pure half: the review record, from comment bodies alone -------------

/**
 * The pull request's review record for the task, derived from
 * PRINCIPAL-AUTHORED comments only. A comment whose author does not resolve
 * against `allowlist` is dropped before anything below reads it — it
 * contributes no verdict, no round marker, no summary table, no pause, and
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

  // The newest published summary wins — a later round republishes the whole
  // table, so an earlier one is never the current record.
  const summaryBody = bodies.filter((body) => isPublishedSummaryComment(body)).at(-1) ?? null
  const summaryTable = summaryBody === null ? null : capText(summaryTableOf(summaryBody))

  const pauseBody = bodies.filter((body) => PAUSE_MARKER.test(body)).at(-1) ?? null
  const pauseReason = pauseBody === null ? null : (pauseBody.match(PAUSE_MARKER)?.[1] ?? null)
  const pause = pauseBody !== null && pauseReason !== null ? { reason: pauseReason, body: capText(pauseBody) } : null

  return { verdicts, roundMarkers, summaryTable, pause }
}

/** The table itself, from its header line on — a summary comment may carry a marker line above it, and the table is what the Operator reads. */
function summaryTableOf(body: string): string {
  const lines = body.split('\n')
  const start = lines.findIndex((line) => line.trim() === SUMMARY_TABLE_HEADER)
  return start === -1 ? body : lines.slice(start).join('\n')
}

// --- the forge half ----------------------------------------------------------

/** Every forge read this tool makes, behind one injectable seam — so the handler's own refusals and its composition are testable with no `gh` on `PATH`. */
export type PrReadForge = {
  /** The selected task's own identity: its Issue, and the pull request on its own branch (`null` when it has none open). */
  resolveTask: (ref: TaskToolRef) => { issue: number; pr: number | null } | null
  fetchChecks: (pr: number) => { head: string | null; checks: TaskPrCheck[] }
  fetchComments: (pr: number) => PrComment[]
  principalAllowlist: () => string[]
}

let cachedRepoSlug: string | null = null

/** `owner/name` for the repository this controller is operating, read once per process — a GraphQL document takes no `{owner}`/`{repo}` placeholder the way a REST path does. */
function repoSlug(): string {
  if (cachedRepoSlug !== null) return cachedRepoSlug
  cachedRepoSlug = sh('gh', ['repo', 'view', '--json', 'owner,name', '--jq', '.owner.login + "/" + .name'])
  return cachedRepoSlug
}

/** One node of the forge's status-check rollup, in either of its two shapes — a check run, or a plain commit status. */
export type RollupNode = {
  __typename?: string
  databaseId?: number | null
  name?: string | null
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

type RollupContexts = { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: RollupNode[] }

const ROLLUP_QUERY = `query($owner: String!, $repo: String!, $pr: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      headRefOid
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          __typename
          ... on CheckRun { databaseId name status conclusion isRequired(pullRequestNumber: $pr) title summary detailsUrl }
          ... on StatusContext { context state isRequired(pullRequestNumber: $pr) description targetUrl }
        }
      } } } } }
    }
  }
}`

/** Generous, not a bound: 100 contexts a page, and a pull request reporting more than a thousand checks has a problem this tool cannot answer anyway. */
const MAX_ROLLUP_PAGES = 10

/**
 * The forge's own status-check rollup for this pull request. `isRequired` is
 * GitHub's answer for THIS pull request (branch protection, rulesets), never
 * inferred from a check's name — which is why this is a GraphQL read and not
 * the REST check-runs list the driver uses for its own green/red conclusion.
 * Reported verbatim, not deduplicated: "what does the forge report on this
 * head" is the question, and collapsing two same-named contexts answers a
 * different one.
 */
function fetchChecksFromForge(pr: number): { head: string | null; checks: TaskPrCheck[] } {
  const [owner, name] = repoSlug().split('/')
  let after: string | null = null
  let head: string | null = null
  const nodes: RollupNode[] = []
  for (let page = 0; page < MAX_ROLLUP_PAGES; page++) {
    const args = [
      'api',
      'graphql',
      '-f',
      `query=${ROLLUP_QUERY}`,
      '-F',
      `owner=${owner}`,
      '-F',
      `repo=${name}`,
      '-F',
      `pr=${pr}`
    ]
    if (after !== null) args.push('-F', `after=${after}`)
    const parsed = JSON.parse(sh('gh', args)) as {
      data?: {
        repository?: {
          pullRequest?: {
            headRefOid?: string | null
            commits?: { nodes?: { commit?: { statusCheckRollup?: { contexts?: RollupContexts } | null } }[] }
          } | null
        } | null
      }
    }
    const request = parsed.data?.repository?.pullRequest
    if (!request) break
    head = request.headRefOid ?? head
    const contexts = request.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts
    if (!contexts) break
    nodes.push(...(contexts.nodes ?? []))
    if (contexts.pageInfo?.hasNextPage !== true || !contexts.pageInfo.endCursor) break
    after = contexts.pageInfo.endCursor
  }
  return { head, checks: toChecks(nodes, fetchFailureDetail) }
}

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
        name: node.context ?? '(unnamed status)',
        required: node.isRequired === true,
        status: 'COMPLETED',
        conclusion,
        detailsUrl: node.targetUrl ?? null,
        failureSummary: isFailed(conclusion) && node.description ? capText(node.description) : null
      })
      continue
    }
    const conclusion = node.conclusion ?? null
    const failed = node.status === 'COMPLETED' && isFailed(conclusion)
    const reported = failed
      ? [node.title, node.summary].filter((text): text is string => typeof text === 'string' && text.trim() !== '')
      : []
    let failureSummary: string | null = null
    if (reported.length > 0) failureSummary = capText(reported.join('\n\n'))
    else if (failed && typeof node.databaseId === 'number' && detailReads < MAX_FAILURE_LOG_READS) {
      detailReads++
      failureSummary = failureDetail(node.databaseId)
    }
    checks.push({
      name: node.name ?? '(unnamed check)',
      required: node.isRequired === true,
      status: node.status ?? 'UNKNOWN',
      conclusion,
      detailsUrl: node.detailsUrl ?? null,
      failureSummary
    })
  }
  return checks
}

function isFailed(conclusion: string | null): boolean {
  return conclusion !== null && !PASSING_CONCLUSIONS.has(conclusion.toUpperCase())
}

/**
 * What a failed check that wrote no output of its own can still say for
 * itself: its failure-level annotations, and failing those the TAIL of its
 * own job log — the thing a Principal used to paste by hand. `null` when
 * neither read answers; a read tool reports what it could not see rather than
 * inventing a reason.
 */
function fetchFailureDetail(checkRunId: number): string | null {
  return readFailureAnnotations(checkRunId) ?? readJobLogTail(checkRunId)
}

/** The check run's own failure-level annotations, minus the runner's generic exit-code line, which names no reason. */
function readFailureAnnotations(checkRunId: number): string | null {
  let raw: string
  try {
    raw = sh('gh', [
      'api',
      `repos/{owner}/{repo}/check-runs/${checkRunId}/annotations`,
      '--jq',
      '.[] | select(.annotation_level == "failure") | .message'
    ])
  } catch {
    return null
  }
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !GENERIC_EXIT_ANNOTATION.test(line))
  return lines.length === 0 ? null : capText(lines.join('\n'))
}

/**
 * For a GitHub Actions check run the check-run id IS the job id, and the job
 * log is the only place its failure is actually written. Read with
 * `--allow-escape-sequences` (a runner colours its own output, and `gh`
 * refuses to print escapes without it), retried without the flag on a `gh`
 * old enough not to carry it.
 */
function readJobLogTail(jobId: number): string | null {
  const endpoint = `repos/{owner}/{repo}/actions/jobs/${jobId}/logs`
  let raw: string
  try {
    raw = sh('gh', ['api', endpoint, '--allow-escape-sequences'])
  } catch {
    try {
      raw = sh('gh', ['api', endpoint])
    } catch {
      return null
    }
  }
  const text = capTail(stripAnsi(raw))
  return text === '' ? null : text
}

function fetchCommentsFromForge(pr: number): PrComment[] {
  const raw = sh('gh', ['pr', 'view', String(pr), '--json', 'comments'])
  const parsed = JSON.parse(raw) as { comments?: { body?: string; author?: { login?: string } | null }[] }
  return (parsed.comments ?? []).map((c) => ({ body: c.body ?? '', author: c.author?.login ?? null }))
}

export const defaultPrReadForge: PrReadForge = {
  resolveTask: (ref) => {
    const row = resolveRowForRef(ref)
    return row === null ? null : { issue: row.issue, pr: row.pr ? row.pr.number : null }
  },
  fetchChecks: fetchChecksFromForge,
  fetchComments: fetchCommentsFromForge,
  principalAllowlist
}

// --- the handler -------------------------------------------------------------

/**
 * The catalog's `task_pr_read` binding. Refuses, in order: a malformed input
 * (`validation`), a ref that names no open task or a task with no open pull
 * request (`precondition`), a caller-supplied `pr` that is not this task's own
 * (`authority` — the whole point of resolving the pull request from the task),
 * and a forge read that failed (`infrastructure`). Nothing below this line
 * writes, posts, re-runs or merges anything.
 */
export function taskPrReadHandler(
  input: unknown,
  forge: PrReadForge = defaultPrReadForge
): TaskToolCallResult<TaskPrReadResult> {
  const parsed = TaskPrReadInputSchema.safeParse(input)
  if (!parsed.success) return fail(taskToolError('validation', parsed.error.issues[0]?.message ?? 'invalid input'))
  const { task, pr: claimedPr } = parsed.data

  let resolved: { issue: number; pr: number | null } | null
  try {
    resolved = forge.resolveTask(task)
  } catch (err) {
    return fail(taskToolError('infrastructure', `could not resolve ${refDescription(task)}: ${messageOf(err)}`))
  }
  if (resolved === null) return fail(taskToolError('precondition', `no open task matches ${refDescription(task)}`))
  if (resolved.pr === null) {
    return fail(
      taskToolError('precondition', `${refDescription(task)} has no open pull request on its own branch to read`)
    )
  }
  const pr = resolved.pr
  if (claimedPr !== undefined && claimedPr !== pr) {
    return fail(
      taskToolError(
        'authority',
        `PR #${claimedPr} is not ${refDescription(task)}'s own pull request`,
        `this tool only ever reads the pull request on the selected task's own branch (PR #${pr}) — it reads no other pull request, whoever asks`
      )
    )
  }

  let head: string | null
  let checks: TaskPrCheck[]
  let comments: PrComment[]
  let allowlist: string[]
  try {
    const rollup = forge.fetchChecks(pr)
    head = rollup.head
    checks = rollup.checks
    comments = forge.fetchComments(pr)
    allowlist = forge.principalAllowlist()
  } catch (err) {
    return fail(taskToolError('infrastructure', `could not read PR #${pr} from the forge: ${messageOf(err)}`))
  }

  return ok({
    task,
    issue: resolved.issue,
    pr,
    head,
    checks,
    review: buildReviewRecord(comments, allowlist),
    observedAt: new Date().toISOString(),
    // The forge IS the record here, so a successful read is current by
    // construction — never a replay of an earlier one.
    freshness: 'fresh' as const
  })
}
