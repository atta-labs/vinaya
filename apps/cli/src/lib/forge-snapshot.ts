/**
 * The forge snapshot: one read, per CI run, of the pull request, its
 * comments, the task Issue its body closes and that Issue's comments — over
 * REST, never GraphQL — written as files in the shape `gh pr view --json` and
 * `gh issue view --json` return, so a check reads them exactly as it would
 * have read `gh`.
 *
 * Why it exists: every check and workflow step used to read the same pull
 * request and task Issue again through `gh pr view`/`gh issue view`, which
 * spend the token's GraphQL budget, and one CI run could exhaust it. The reads
 * stay live — taken from the forge when the run starts, never from the event
 * payload — and only their count changes.
 *
 * Two halves, one owner:
 *
 * - **Writing.** A generated workflow step reads the pull request and its
 *   comments through `gh api` (REST) into `raw/`, then `vinaya pr snapshot
 *   --dir <dir>` maps them to `gh`'s shape, resolves the task Issue from the
 *   body's `Closes #N` (`extractIssue`, the same resolver every check uses),
 *   and reads that Issue and its comments over REST too.
 * - **Reading.** A check reads the snapshot only when the step running it set
 *   `VINAYA_FORGE_SNAPSHOT_DIR` AND `GITHUB_ACTIONS` is `true`; anywhere else
 *   — a local run, a hook, the review loop's host — every read goes to the
 *   forge exactly as before. A file is served only for the number it was
 *   written for; any other number reads live. A missing file is a failure,
 *   never a silent fallback to the forge and never a pass.
 *
 * Identity fields (the pull request author, comment authors) are as
 * authoritative as the step that wrote them: in the trusted-checkout
 * workflows a default-branch step writes the snapshot, and in
 * `vinaya-checks.yml` the job already runs the pull request's own code, so
 * the snapshot adds no trust that was not already there.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractIssue } from '@attalabs/aeg-core'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../checks/contract'
import {
  type ForgeComment,
  type ForgeRunner,
  ghRunner,
  type RestComment,
  readRestCommentRows,
  runBounded
} from './forge-read'

/** The variable naming the snapshot directory — set only on the step that runs checks. */
export const FORGE_SNAPSHOT_DIR_ENV = 'VINAYA_FORGE_SNAPSHOT_DIR'

/** The REST pull request object the read step writes. */
export const RAW_PULL_FILE = 'raw/pull.json'
/** The REST comment pages the read step writes (`gh api --paginate --slurp`). */
export const RAW_PULL_COMMENTS_FILE = 'raw/pull-comments.json'
/** The pull request, in `gh pr view --json` shape. */
export const PULL_FILE = 'pull.json'
/** The pull request's comments, as `{ number, comments }`. */
export const PULL_COMMENTS_FILE = 'pull-comments.json'
/** The task Issue, in `gh issue view --json` shape; `{ number: null }` when the body closes none. */
export const ISSUE_FILE = 'issue.json'
/** The task Issue's comments, as `{ number, comments }`. */
export const ISSUE_COMMENTS_FILE = 'issue-comments.json'
/** The pull request body, verbatim — what `PR_BODY_FILE` names. */
export const BODY_FILE = 'body.md'

/** An author in `gh`'s shape — `null` for a deleted account. */
export type GhAuthor = { login: string } | null

/** The pull request fields the checks read, in `gh pr view --json` shape. */
export type GhPullRequest = {
  number: number
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  title: string
  body: string
  author: GhAuthor
  headRefName: string
  headRefOid: string
  baseRefName: string
  labels: { name: string }[]
}

/** The task Issue fields the checks read, in `gh issue view --json` shape. */
export type GhIssue = {
  number: number
  state: 'OPEN' | 'CLOSED'
  title: string
  body: string
  author: GhAuthor
  labels: { name: string }[]
}

/** A snapshot comments file: the number it was written for, and its comments in order. */
export type SnapshotComments = { number: number; comments: ForgeComment[] }

/** The task Issue file: no task Issue, a task Issue the forge answered 404 for, or the Issue. */
export type SnapshotIssueFile = { number: null } | { number: number; notFound: true } | GhIssue

type RestUser = { login?: string; type?: string } | null | undefined
type RestLabel = { name?: string }

/** The REST pull request fields the mapping reads (`GET /repos/{owner}/{repo}/pulls/{pull_number}`). */
export type RestPull = {
  number: number
  state: string
  merged?: boolean
  merged_at?: string | null
  title?: string | null
  body?: string | null
  user?: RestUser
  head: { ref: string; sha: string }
  base: { ref: string }
  labels?: RestLabel[]
}

/** The REST Issue fields the mapping reads (`GET /repos/{owner}/{repo}/issues/{issue_number}`). */
export type RestIssue = {
  number: number
  state: string
  title?: string | null
  body?: string | null
  user?: RestUser
  labels?: RestLabel[]
}

function botName(login: string): string {
  return login.replace(/\[bot\]$/, '')
}

/**
 * A pull request's or Issue's author as `gh` prints it: a GitHub App bot is
 * `app/<name>` (REST's `<name>[bot]` with type `Bot`), a user is its login.
 */
export function ghAuthorFromRest(user: RestUser): GhAuthor {
  if (!user?.login) return null
  return user.type === 'Bot' ? { login: `app/${botName(user.login)}` } : { login: user.login }
}

/** A comment's author as `gh` prints it: a bot is its bare `<name>`, a user is its login. */
export function ghCommentAuthorFromRest(user: RestUser): GhAuthor {
  if (!user?.login) return null
  return user.type === 'Bot' ? { login: botName(user.login) } : { login: user.login }
}

function labelsFromRest(labels: RestLabel[] | undefined): { name: string }[] {
  return (labels ?? []).flatMap((l) => (typeof l.name === 'string' ? [{ name: l.name }] : []))
}

/** The REST pull request in `gh pr view --json` shape — `state` uppercase, `MERGED` once merged. */
export function pullRequestFromRest(rest: RestPull): GhPullRequest {
  const merged = rest.merged === true || Boolean(rest.merged_at)
  return {
    number: rest.number,
    state: merged ? 'MERGED' : rest.state.toUpperCase() === 'OPEN' ? 'OPEN' : 'CLOSED',
    title: rest.title ?? '',
    body: rest.body ?? '',
    author: ghAuthorFromRest(rest.user),
    headRefName: rest.head.ref,
    headRefOid: rest.head.sha,
    baseRefName: rest.base.ref,
    labels: labelsFromRest(rest.labels)
  }
}

/** The REST Issue in `gh issue view --json` shape. */
export function issueFromRest(rest: RestIssue): GhIssue {
  return {
    number: rest.number,
    state: rest.state.toUpperCase() === 'OPEN' ? 'OPEN' : 'CLOSED',
    title: rest.title ?? '',
    body: rest.body ?? '',
    author: ghAuthorFromRest(rest.user),
    labels: labelsFromRest(rest.labels)
  }
}

/** REST comment rows in `gh --json comments` shape, order kept. */
export function commentsFromRest(rows: readonly RestComment[]): ForgeComment[] {
  return rows.map((r) => ({ body: r.body ?? '', url: r.html_url ?? '', author: ghCommentAuthorFromRest(r.user) }))
}

/** `gh api --paginate --slurp` wraps each page's array in an outer array; a single unwrapped page reads the same. */
function flattenPages(raw: unknown): RestComment[] {
  if (!Array.isArray(raw)) throw new Error('the comment pages are not a JSON array')
  return raw.flatMap((page) => (Array.isArray(page) ? (page as RestComment[]) : [page as RestComment]))
}

function writeJson(dir: string, name: string, value: unknown): void {
  writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`)
}

function isHttp404(err: unknown): boolean {
  const stderr = (err as { stderr?: Buffer | string } | null)?.stderr
  const text = `${(err as Error | null)?.message ?? ''}\n${typeof stderr === 'string' ? stderr : (stderr?.toString() ?? '')}`
  return /\(HTTP 404\)/.test(text)
}

/** What one write produced: the pull request number and the task Issue it resolved, if any. */
export type ForgeSnapshotWritten = { pullRequest: number; issue: number | null }

/**
 * Writes the snapshot into `dir` from the read step's `raw/` files, reading
 * the task Issue and its comments over REST through `runner`. A 404 on the
 * task Issue is recorded (`notFound`) rather than failing: a check decides
 * for itself what an Issue that does not resolve means, as it does live.
 * Every other failed read throws.
 */
export function writeForgeSnapshot(dir: string, runner: ForgeRunner = ghRunner): ForgeSnapshotWritten {
  const pull = pullRequestFromRest(JSON.parse(readFileSync(join(dir, RAW_PULL_FILE), 'utf8')) as RestPull)
  const comments = commentsFromRest(flattenPages(JSON.parse(readFileSync(join(dir, RAW_PULL_COMMENTS_FILE), 'utf8'))))
  writeJson(dir, PULL_FILE, pull)
  writeJson(dir, PULL_COMMENTS_FILE, { number: pull.number, comments } satisfies SnapshotComments)
  writeFileSync(join(dir, BODY_FILE), pull.body)

  const { issue } = extractIssue(pull.body)
  if (issue === null) {
    writeJson(dir, ISSUE_FILE, { number: null } satisfies SnapshotIssueFile)
    return { pullRequest: pull.number, issue: null }
  }
  let restIssue: RestIssue
  try {
    restIssue = JSON.parse(runBounded(runner, ['api', `repos/{owner}/{repo}/issues/${issue}`], `Issue #${issue}`, 0))
  } catch (err) {
    if (!isHttp404(err)) throw err
    writeJson(dir, ISSUE_FILE, { number: issue, notFound: true } satisfies SnapshotIssueFile)
    return { pullRequest: pull.number, issue }
  }
  const issueComments = commentsFromRest(readRestCommentRows(issue, `Issue #${issue}`, runner))
  writeJson(dir, ISSUE_COMMENTS_FILE, { number: issue, comments: issueComments } satisfies SnapshotComments)
  writeJson(dir, ISSUE_FILE, issueFromRest(restIssue))
  return { pullRequest: pull.number, issue }
}

type RateLimitBudget = { limit: number; remaining: number; reset: number }

/**
 * Both token budgets, named, for a failed read's message: remaining, limit
 * and reset time, and which one is spent when GitHub rate-limited the read.
 */
export function describeTokenBudgets(runner: ForgeRunner = ghRunner): string {
  try {
    const parsed = JSON.parse(runBounded(runner, ['api', 'rate_limit'], 'the token budget', 0)) as {
      resources: Record<'core' | 'graphql', RateLimitBudget>
    }
    return (['core', 'graphql'] as const)
      .map((name) => {
        const b = parsed.resources[name]
        const label = name === 'core' ? 'REST (core)' : 'GraphQL'
        const spent = b.remaining === 0 ? ' — spent, so GitHub rate-limited this read' : ''
        return `${label} budget ${b.remaining} of ${b.limit} left, resets at ${new Date(b.reset * 1000).toISOString()}${spent}`
      })
      .join('; ')
  } catch {
    return 'the token budget could not be read (`gh api rate_limit` failed)'
  }
}

/**
 * `vinaya pr snapshot --dir <dir>` — the CI step that turns the read step's
 * `raw/` files into the snapshot. Exits 1, naming what it could not read and
 * both token budgets, on any failed read; 2 on a usage error.
 */
export function forgeSnapshotCommand(args: string[], runner: ForgeRunner = ghRunner): void {
  const at = args.indexOf('--dir')
  const dir = at === -1 ? undefined : args[at + 1]
  if (!dir) {
    process.stderr.write('Usage: vinaya pr snapshot --dir <dir>\n')
    process.exit(2)
  }
  try {
    const written = writeForgeSnapshot(dir, runner)
    process.stdout.write(
      `pr snapshot: wrote ${dir} for pull request #${written.pullRequest}${written.issue === null ? ' (its body closes no Issue)' : ` and task Issue #${written.issue}`}\n`
    )
  } catch (err) {
    process.stderr.write(
      `::error::pr snapshot: could not write the forge snapshot in ${dir}: ${err instanceof Error ? err.message : String(err)}\n`
    )
    process.stderr.write(`::error::pr snapshot: ${describeTokenBudgets(runner)}\n`)
    process.exit(1)
  }
}

/** The snapshot directory a check reads, or `null`: only in CI, and only where the step running it set the variable. */
export function forgeSnapshotDir(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.GITHUB_ACTIONS !== 'true') return null
  const dir = env[FORGE_SNAPSHOT_DIR_ENV]
  return dir ? dir : null
}

/** A snapshot file the step that runs checks was promised and does not have. */
export class ForgeSnapshotIncompleteError extends Error {
  constructor(dir: string, file: string) {
    super(
      `the forge snapshot ${dir} has no ${file} — the pull request read that writes it did not complete, so this check refuses to read the forge in its place.`
    )
    this.name = 'ForgeSnapshotIncompleteError'
  }
}

/** The task Issue the forge answered 404 for when the snapshot was read — worded so `isIssueNotFoundError` recognizes it, as it does a live 404. */
export class ForgeSnapshotIssueNotFoundError extends Error {
  constructor(issue: number) {
    super(`Issue #${issue} did not resolve (HTTP 404) when this run's forge snapshot was read.`)
    this.name = 'ForgeSnapshotIssueNotFoundError'
  }
}

function readSnapshotFile<T>(dir: string, file: string): T {
  let text: string
  try {
    text = readFileSync(join(dir, file), 'utf8')
  } catch {
    throw new ForgeSnapshotIncompleteError(dir, file)
  }
  return JSON.parse(text) as T
}

function readComments(dir: string, file: string, number: number): ForgeComment[] {
  const parsed = readSnapshotFile<SnapshotComments>(dir, file)
  if (parsed.number !== number) throw new ForgeSnapshotIncompleteError(dir, `${file} for #${number}`)
  return parsed.comments
}

/** The pull request from the snapshot, or `null` (read live) when no snapshot applies or it was written for another number. */
export function snapshotPullRequest(number: number, env: NodeJS.ProcessEnv = process.env): GhPullRequest | null {
  const dir = forgeSnapshotDir(env)
  if (dir === null) return null
  const pull = readSnapshotFile<GhPullRequest>(dir, PULL_FILE)
  return pull.number === number ? pull : null
}

/** The task Issue from the snapshot, or `null` (read live) when no snapshot applies or it is another number. Throws `ForgeSnapshotIssueNotFoundError` for a recorded 404. */
export function snapshotIssue(number: number, env: NodeJS.ProcessEnv = process.env): GhIssue | null {
  const dir = forgeSnapshotDir(env)
  if (dir === null) return null
  const issue = readSnapshotFile<SnapshotIssueFile>(dir, ISSUE_FILE)
  if (issue.number !== number) return null
  if ('notFound' in issue) throw new ForgeSnapshotIssueNotFoundError(number)
  return issue as GhIssue
}

/** The comments of the pull request or task Issue `number` from the snapshot, or `null` (read live) for any other number. */
export function snapshotComments(number: number, env: NodeJS.ProcessEnv = process.env): ForgeComment[] | null {
  const dir = forgeSnapshotDir(env)
  if (dir === null) return null
  if (snapshotPullRequest(number, env) !== null) return readComments(dir, PULL_COMMENTS_FILE, number)
  if (snapshotIssue(number, env) !== null) return readComments(dir, ISSUE_COMMENTS_FILE, number)
  return null
}

/** The body of the pull request or task Issue `number` from the snapshot, or `null` (read live) for any other number. */
export function snapshotBody(number: number, env: NodeJS.ProcessEnv = process.env): string | null {
  const pull = snapshotPullRequest(number, env)
  if (pull !== null) return pull.body
  return snapshotIssue(number, env)?.body ?? null
}

/** Why the snapshot this check was given is incomplete, or `null` when it is complete or none applies. */
export function incompleteForgeSnapshot(env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = forgeSnapshotDir(env)
  if (dir === null) return null
  for (const file of [PULL_FILE, PULL_COMMENTS_FILE, ISSUE_FILE]) {
    if (!existsSync(join(dir, file))) return new ForgeSnapshotIncompleteError(dir, file).message
  }
  try {
    const issue = readSnapshotFile<SnapshotIssueFile>(dir, ISSUE_FILE)
    if (typeof issue.number === 'number' && !('notFound' in issue) && !existsSync(join(dir, ISSUE_COMMENTS_FILE))) {
      return new ForgeSnapshotIncompleteError(dir, ISSUE_COMMENTS_FILE).message
    }
  } catch (err) {
    return `the forge snapshot ${dir} has an unreadable ${ISSUE_FILE}: ${(err as Error).message}`
  }
  return null
}

/**
 * The first thing a check that reads the snapshot does: given an incomplete
 * one, it fails — one error naming the missing file, exit 1 — before any read
 * could fall back to the forge or a swallowed read could count as a pass.
 */
export function exitOnIncompleteForgeSnapshot(checkName: string, env: NodeJS.ProcessEnv = process.env): void {
  const reason = incompleteForgeSnapshot(env)
  if (reason === null) return
  emitCheckError({
    schema: CHECK_SCHEMA_VERSION,
    check: checkName,
    severity: 'error',
    message: `${checkName}: ${reason}`,
    agent_recovery_prompt: `Re-run the whole workflow run so its pull request read step writes the snapshot again (its own log names the failed read), then let \`vinaya check ${checkName}\` re-run.`
  })
  process.exit(1)
}
