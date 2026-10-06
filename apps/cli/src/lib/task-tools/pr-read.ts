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
 * instruction, and it splits in two by whether it has an AUTHOR.
 *
 * - **Authored** — a pull request comment. Filtered through the same
 *   `isPrincipal` allowlist the loop's own forge reads use (the filter
 *   `checkReviewGate` itself applies before either verdict extractor) before
 *   a single byte of it is read for meaning; no body from outside that
 *   allowlist is ever carried out of this module.
 * - **Unauthored** — a check name, a check's own reported output, a failure
 *   annotation, a job log. No allowlist can apply, because there is nobody to
 *   check: anyone who can land a workflow file or a build step on the task's
 *   branch writes these. Every one of them leaves through
 *   `sanitizeForgeText`/`sanitizeForgeLogTail`, which redact secrets through
 *   `redact()` — this codebase's single redaction chokepoint — neutralize the
 *   two grammars that carry authority here (an AEG control comment, a
 *   `VERDICT:` line), and cap what remains.
 *
 * Read-only, structurally: there is no forge-write function imported here,
 * no `--resume`, no re-run, no merge. The only pull request it will read is
 * the one the selected task's own branch carries; a caller-supplied `pr` is
 * a cross-check that refuses on mismatch, never a second way in.
 */

import {
  type TaskPrCheck,
  type TaskPrReadResult,
  TaskPrReadInputSchema,
  type TaskToolError,
  taskToolError,
  type TaskToolRef
} from '@attalabs/aeg-core'
import { markerComments, principalAllowlist } from '../dev-review-loop/developer-dispatch.js'
import { sh } from '../dev-review-loop/gate-reading.js'
import { resolveRowForRef, type TaskToolCallResult } from './handlers.js'
import {
  buildReviewRecord,
  type PrComment,
  type RollupNode,
  readJobLogTail,
  sanitizeForgeText,
  toChecks
} from './pr-facts.js'

/** The runner's own generic epitaph on a failed step: it repeats what `conclusion` already said and names no reason, so it never stands in for the log that does. */
const GENERIC_EXIT_ANNOTATION = /^Process completed with exit code \d+\.?$/

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
 * What a failed check that wrote no output of its own can still say for
 * itself: its failure-level annotations, and failing those the TAIL of its
 * own job log (`readJobLogTail`, the one job-log reader, shared with the review
 * loop's red-CI retry) — the thing a Principal used to paste by hand. `null` when
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
  if (lines.length === 0) return null
  const text = sanitizeForgeText(lines.join('\n'))
  return text === '' ? null : text
}

/** The PR's comments, parsed by the loop's OWN parser (`markerComments`, `developer-dispatch.ts`) rather than a second `author.login` mapping beside it — one parse, so the two cannot drift. */
function fetchCommentsFromForge(pr: number): PrComment[] {
  return markerComments(sh('gh', ['pr', 'view', String(pr), '--json', 'comments']))
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
