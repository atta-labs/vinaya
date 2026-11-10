#!/usr/bin/env bun
/**
 * A one-time repository-maintenance program: it rewrites the retired marker
 * spellings on every OPEN Issue and OPEN pull request of one repository —
 * their bodies and their conversation comments — to the current spelling.
 *
 * The old-to-new mapping is never restated here: every spelling comes from
 * the legacy-spelling module (`harness/processes/vinaya-strict/tools/legacy-markers.ts`),
 * the same module every reader takes its accepted spellings from, so this
 * program and the readers can never disagree. Four marker families are
 * rewritten:
 *
 *   - body regions:            `<!-- <old>:<FIELD>:START -->` / `:END -->`
 *   - the provenance heading:  a line that starts with the old heading
 *   - documentation anchors:   the claim, quotes-file and vendor-example anchors
 *                              in their `<!-- … -->` form
 *   - forge comment markers:   `<!-- <old>:<family>… -->` for every comment-marker
 *                              family the module names
 *
 * Only the old spelling itself is replaced; every other byte of the body or
 * comment stays as it was. A marker quoted inside fenced, indented or inline
 * code is not a marker — every reader masks code before matching — so code
 * is left unchanged.
 *
 * It reads and writes through `gh api` over REST only (never the GraphQL
 * subcommands): `GET /repos/{owner}/{repo}/issues?state=open` with
 * `--paginate` lists open Issues and pull requests (a pull request carries the
 * `pull_request` key), `GET /repos/{owner}/{repo}/issues/{n}/comments` lists a
 * thread's conversation comments, `PATCH /repos/{owner}/{repo}/issues/{n}`
 * edits a body and `PATCH /repos/{owner}/{repo}/issues/comments/{id}` edits a
 * comment in place, so its author, link and order stay. Closed Issues and
 * closed or merged pull requests are never listed, never read and never
 * changed.
 *
 *   bun scripts/marker-rewrite/rewrite-open-threads.ts --dry-run [--repo owner/name]
 *   bun scripts/marker-rewrite/rewrite-open-threads.ts [--repo owner/name]
 *
 * Exit codes: 0 — every pending rewrite was made (or, with `--dry-run`,
 * listed); 1 — at least one body or comment the token may not edit was
 * skipped, each reported by its link; 2 — the run stopped: a rate limit, a
 * read failure or a usage error.
 */
import { spawnSync } from 'node:child_process'
import { maskCode } from '../../harness/kernel/adapters/code-host/github/strip-code'
import {
  CLAIM_ANCHOR,
  COMMENT_MARKER_PREFIX,
  MARKER_FAMILIES,
  type MarkerSpelling,
  PROVENANCE_HEADING,
  QUOTES_FILE_ANCHOR,
  REGION_PREFIX,
  VENDOR_EXAMPLE_ANCHOR
} from '../../harness/processes/vinaya-strict/tools/legacy-markers'

/** One open Issue or open pull request, as the REST issues list returns it. */
export type OpenThread = {
  number: number
  state: string
  isPullRequest: boolean
  htmlUrl: string
  body: string
}

/** One conversation comment on a thread. */
export type ThreadComment = { id: number; htmlUrl: string; body: string }

/** Why an edit did not land. */
export type EditRefusal = { kind: 'forbidden'; detail: string } | { kind: 'rate-limited'; detail: string }

/** The forge as this program uses it. Every call is one REST request (or one paginated listing). */
export type Forge = {
  listOpenThreads(): OpenThread[]
  listComments(threadNumber: number): ThreadComment[]
  updateThreadBody(threadNumber: number, body: string): EditRefusal | null
  updateComment(commentId: number, body: string): EditRefusal | null
}

/** A forge answer that stops the run: the REST rate limit, or a read that failed. */
export class StopRun extends Error {}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** One located old spelling: where it starts in the body and what replaces it. */
type Replacement = { start: number; family: MarkerSpelling }

/**
 * A pattern run over the code-masked body, and which group-free leading part
 * of each match sits before the old spelling (so the replaced range is the
 * old spelling only).
 */
type Matcher = { pattern: RegExp; family: MarkerSpelling; lead: (match: RegExpExecArray) => number }

const COMMENT_FAMILIES: MarkerSpelling[] = Object.values(MARKER_FAMILIES).filter(
  (family) => family !== COMMENT_MARKER_PREFIX && family.old.startsWith(`${COMMENT_MARKER_PREFIX.old}:`)
)

function openingLead(match: RegExpExecArray): number {
  return (match[1] ?? '').length
}

const MATCHERS: Matcher[] = [
  {
    family: REGION_PREFIX,
    pattern: new RegExp(`(<!--\\s*)${escapeRegExp(REGION_PREFIX.old)}:[A-Z][A-Z0-9-]*:(?:START|END)\\s*-->`, 'g'),
    lead: openingLead
  },
  ...[CLAIM_ANCHOR, QUOTES_FILE_ANCHOR, VENDOR_EXAMPLE_ANCHOR].map((family) => ({
    family,
    pattern: new RegExp(`(<!--\\s*)${escapeRegExp(family.old)}:[^\\n]*?-->`, 'g'),
    lead: openingLead
  })),
  {
    family: PROVENANCE_HEADING,
    pattern: new RegExp(`^()${escapeRegExp(PROVENANCE_HEADING.old)}(?![A-Za-z0-9_])`, 'gm'),
    lead: openingLead
  },
  ...COMMENT_FAMILIES.map((family) => ({
    family,
    pattern: new RegExp(`(<!--\\s*)${escapeRegExp(family.old)}(?![A-Za-z0-9_])[^\\n]*?-->`, 'g'),
    lead: openingLead
  }))
]

/** Every old-spelling marker in `body` outside code, in body order, one per position. */
function findReplacements(body: string): Replacement[] {
  const masked = maskCode(body)
  const byStart = new Map<number, Replacement>()
  for (const { pattern, family, lead } of MATCHERS) {
    pattern.lastIndex = 0
    for (let match = pattern.exec(masked); match !== null; match = pattern.exec(masked)) {
      const start = match.index + lead(match)
      // The masked view equals the body outside code, so the old spelling is
      // really there in the body; a family whose spelling begins another's
      // (a region and the vendor-example anchor share their start) is kept once,
      // the longer spelling winning.
      if (body.slice(start, start + family.old.length) !== family.old) continue
      const known = byStart.get(start)
      if (known === undefined || known.family.old.length < family.old.length) byStart.set(start, { start, family })
    }
  }
  return [...byStart.values()].sort((a, b) => a.start - b.start)
}

/** The rewritten body and how many markers it moved; `count` 0 means the body is unchanged. */
export function rewriteMarkers(body: string): { body: string; count: number } {
  const replacements = findReplacements(body)
  if (replacements.length === 0) return { body, count: 0 }
  let out = ''
  let cursor = 0
  for (const { start, family } of replacements) {
    out += body.slice(cursor, start) + family.current
    cursor = start + family.old.length
  }
  return { body: out + body.slice(cursor), count: replacements.length }
}

/** One body or comment with markers to rewrite. */
export type PendingRewrite = {
  thread: OpenThread
  target: { kind: 'body' } | { kind: 'comment'; id: number }
  htmlUrl: string
  count: number
  rewritten: string
}

export type RunResult = {
  pending: PendingRewrite[]
  rewritten: PendingRewrite[]
  skipped: { rewrite: PendingRewrite; detail: string }[]
  /** Set when a rate limit stopped the run before every pending rewrite was tried. */
  stopped: string | null
}

/** Reads every open thread and its comments, and lists each body or comment with old markers. */
export function findPendingRewrites(forge: Forge): PendingRewrite[] {
  const pending: PendingRewrite[] = []
  for (const thread of forge.listOpenThreads()) {
    // The listing asks for open threads only; one that is not open is never read further.
    if (thread.state !== 'open') continue
    const body = rewriteMarkers(thread.body)
    if (body.count > 0) {
      pending.push({
        thread,
        target: { kind: 'body' },
        htmlUrl: thread.htmlUrl,
        count: body.count,
        rewritten: body.body
      })
    }
    for (const comment of forge.listComments(thread.number)) {
      const rewrite = rewriteMarkers(comment.body)
      if (rewrite.count === 0) continue
      pending.push({
        thread,
        target: { kind: 'comment', id: comment.id },
        htmlUrl: comment.htmlUrl,
        count: rewrite.count,
        rewritten: rewrite.body
      })
    }
  }
  return pending
}

/** The whole run: find, then (unless a dry run) edit each pending body or comment in place. */
export function run(forge: Forge, options: { dryRun: boolean }): RunResult {
  const pending = findPendingRewrites(forge)
  const result: RunResult = { pending, rewritten: [], skipped: [], stopped: null }
  if (options.dryRun) return result
  for (const rewrite of pending) {
    const refusal =
      rewrite.target.kind === 'body'
        ? forge.updateThreadBody(rewrite.thread.number, rewrite.rewritten)
        : forge.updateComment(rewrite.target.id, rewrite.rewritten)
    if (refusal === null) {
      result.rewritten.push(rewrite)
    } else if (refusal.kind === 'rate-limited') {
      result.stopped = refusal.detail
      return result
    } else {
      result.skipped.push({ rewrite, detail: refusal.detail })
    }
  }
  return result
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

/** The printed report: per thread, each body or comment and its marker count. */
export function formatReport(result: RunResult, options: { dryRun: boolean }): string {
  const lines: string[] = []
  const verb = options.dryRun ? 'would rewrite' : 'rewrote'
  const done = options.dryRun ? result.pending : result.rewritten
  const byThread = new Map<number, PendingRewrite[]>()
  for (const rewrite of done)
    byThread.set(rewrite.thread.number, [...(byThread.get(rewrite.thread.number) ?? []), rewrite])
  for (const rewrites of byThread.values()) {
    const thread = (rewrites[0] as PendingRewrite).thread
    lines.push(`#${thread.number} (${thread.isPullRequest ? 'pull request' : 'Issue'}) ${thread.htmlUrl}`)
    for (const rewrite of rewrites) {
      const what = rewrite.target.kind === 'body' ? 'body' : `comment ${rewrite.htmlUrl}`
      lines.push(`  ${verb} ${what}: ${plural(rewrite.count, 'marker')}`)
    }
  }
  for (const { rewrite, detail } of result.skipped) {
    lines.push(`skipped ${rewrite.htmlUrl}: the token may not edit it (${detail})`)
  }
  if (result.stopped !== null) lines.push(`stopped: ${result.stopped}`)
  const total = done.reduce((sum, rewrite) => sum + rewrite.count, 0)
  lines.push(
    done.length === 0 && result.skipped.length === 0 && result.stopped === null
      ? 'nothing to rewrite on open Issues and pull requests'
      : `${verb} ${plural(total, 'marker')} in ${plural(done.length, 'body or comment')}` +
          (result.skipped.length > 0 ? `; skipped ${result.skipped.length}` : '')
  )
  return lines.join('\n')
}

/** Runs one `gh` command; `input` goes to stdin. */
export type GhRunner = (args: string[], input?: string) => { status: number; stdout: string; stderr: string }

const spawnGh: GhRunner = (args, input) => {
  const child = spawnSync('gh', args, { encoding: 'utf8', input, maxBuffer: 512 * 1024 * 1024 })
  return { status: child.status ?? 1, stdout: child.stdout ?? '', stderr: child.stderr ?? String(child.error ?? '') }
}

function isRateLimit(stderr: string): boolean {
  return /rate limit|HTTP 429/i.test(stderr)
}

/** The forge over `gh api` REST calls for one `owner/name` repository. */
export function ghForge(repo: string, gh: GhRunner = spawnGh): Forge {
  const read = (path: string, jq: string): string[] => {
    const answer = gh(['api', '--paginate', '-H', 'Accept: application/vnd.github+json', path, '--jq', jq])
    if (answer.status !== 0) {
      const reason = answer.stderr.trim()
      throw new StopRun(
        isRateLimit(reason) ? `REST rate limit reached reading ${path}: ${reason}` : `reading ${path} failed: ${reason}`
      )
    }
    return answer.stdout.split('\n').filter((line) => line.trim() !== '')
  }
  const patch = (path: string, body: string): EditRefusal | null => {
    const answer = gh(
      ['api', '-X', 'PATCH', '-H', 'Accept: application/vnd.github+json', path, '--input', '-'],
      JSON.stringify({ body })
    )
    if (answer.status === 0) return null
    const reason = answer.stderr.trim()
    return isRateLimit(reason)
      ? { kind: 'rate-limited', detail: `REST rate limit reached editing ${path}: ${reason}` }
      : { kind: 'forbidden', detail: reason }
  }
  return {
    listOpenThreads: () =>
      read(
        `repos/${repo}/issues?state=open&per_page=100`,
        '.[] | {number, state, html_url, body, is_pull_request: has("pull_request")} | tojson'
      ).map((line) => {
        const item = JSON.parse(line) as {
          number: number
          state: string
          html_url: string
          body: string | null
          is_pull_request: boolean
        }
        return {
          number: item.number,
          state: item.state,
          isPullRequest: item.is_pull_request,
          htmlUrl: item.html_url,
          body: item.body ?? ''
        }
      }),
    listComments: (threadNumber) =>
      read(`repos/${repo}/issues/${threadNumber}/comments?per_page=100`, '.[] | {id, html_url, body} | tojson').map(
        (line) => {
          const item = JSON.parse(line) as { id: number; html_url: string; body: string | null }
          return { id: item.id, htmlUrl: item.html_url, body: item.body ?? '' }
        }
      ),
    updateThreadBody: (threadNumber, body) => patch(`repos/${repo}/issues/${threadNumber}`, body),
    updateComment: (commentId, body) => patch(`repos/${repo}/issues/comments/${commentId}`, body)
  }
}

/** `owner/name` from an `origin` remote URL (`git@github.com:o/n.git` or `https://github.com/o/n`). */
export function repoFromRemoteUrl(url: string): string | null {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim())
  return match ? `${match[1]}/${match[2]}` : null
}

const USAGE = 'usage: bun scripts/marker-rewrite/rewrite-open-threads.ts [--dry-run] [--repo owner/name]'

/** Parses argv, runs, prints, and returns the exit code. */
export function main(
  argv: string[],
  forgeFor: (repo: string) => Forge = (repo) => ghForge(repo),
  out = console.log,
  err = console.error
): number {
  let dryRun = false
  let repo: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') dryRun = true
    else if (arg === '--repo' && argv[i + 1] !== undefined) repo = argv[++i] as string
    else {
      err(USAGE)
      return 2
    }
  }
  if (repo === null) {
    const remote = spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' })
    repo = remote.status === 0 ? repoFromRemoteUrl(remote.stdout) : null
  }
  if (repo === null || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    err(`no repository: pass --repo owner/name (the origin remote did not name a GitHub repository)\n${USAGE}`)
    return 2
  }
  let result: RunResult
  try {
    result = run(forgeFor(repo), { dryRun })
  } catch (error) {
    if (error instanceof StopRun) {
      err(`stopped: ${error.message}`)
      return 2
    }
    throw error
  }
  out(formatReport(result, { dryRun }))
  if (result.stopped !== null) return 2
  return result.skipped.length > 0 ? 1 : 0
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
