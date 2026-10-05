/**
 * `dev-review-loop`'s developer-dispatch-and-branch-polling concern
 * — every forge read that resolves
 * WHAT the loop is working on and WHO said so with authority: the task
 * Issue's title/branch/objectives/rulings, principal-authored markers
 * (rulings, developer stops, objectives edits), and open-PR/branch lookup.
 * Moved out of `apps/cli/src/lib/dev-review-loop.ts` verbatim; `dev-review-loop.ts`
 * stays the composition root, re-exporting every name below under the same
 * path it always had.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname as osHostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  defaultIsPidAlive,
  isPrincipal,
  issueBranchName,
  newestPrincipalRulingAuthor,
  newestPrincipalRulingOrdinal,
  normalizeOutcome,
  type NormalizedOutcome,
  type Objective,
  objectivesOf,
  objectivesVersion,
  type OutcomeSignals,
  extractSourceRevision,
  parseTaskBranchIdentity,
  resolveNewestFrozenBrief,
  type ReviewPolicy
} from '@attalabs/aeg-core'
import { extractShortVersion } from '@attalabs/aeg-core/docs'
import { hasLabel } from '@attalabs/aeg-forge-state'
import { resolveDoctrineRoot } from '../../commands/doctrine.js'
import { buildRolePlan } from '../../roles/plan.js'
import {
  configPath,
  loadConfigChecked,
  loadTrustAnchorConfig,
  loadTrustAnchorConfigOrThrow,
  resolvePrincipalAllowlist,
  resolveReviewPolicy,
  type VinayaConfig
} from '../config.js'
import {
  type AgentVendor,
  getProcessSnapshot,
  type LaunchRecord,
  matchesCapturedIdentity,
  type ParsedLaunch,
  type ProcessSnapshot,
  readLaunchRecord,
  terminateChildWithGrace
} from '../dispatch.js'
import { sh } from './gate-reading.js'

const RULING_MARKER = /^<!-- aeg:principal:ruling:\d+-\d+ -->$/

/**
 * `postMarkedComment('pr', ...)` composes a ruling comment as exactly
 * `${marker}\n${body}\n` (`forge-write.ts`) — ONE header line, not two. This
 * is deliberately its own one-line split, not `dispatch-task.ts`'s
 * `contentAfterTwoLines`: that function skips the marker line AND a second
 * `Brief hash:` header line that only the frozen-brief comment shape has
 * (`dispatchTask` composes `Brief hash: <hash>\n<brief>` as the body it
 * hands to `postMarkedComment`). Applying `contentAfterTwoLines` here would
 * silently drop every ruling's own first content line. See this PR's
 * Decisions section.
 */
function contentAfterOneLine(body: string): string {
  const idx = body.indexOf('\n')
  return idx === -1 ? '' : body.slice(idx + 1)
}

export type MarkerComment = {
  body: string
  author: string | null
  /** The comment's own address on the forge, when the read carried one — optional, so a hand-built fixture never has to invent a url it does not need. */
  url?: string | null
}

/**
 * `gh {pr,issue} view --json comments` returns `author.login` and `url` on
 * every comment by default — no extra field flag needed (confirmed against
 * `review-post.ts`'s own identical `c.author?.login ?? null` read, and
 * against `gh pr view --json comments`'s own key list).
 */
export function markerComments(raw: string): MarkerComment[] {
  const parsed = JSON.parse(raw) as {
    comments: { body: string; author?: { login?: string } | null; url?: string | null }[]
  }
  return parsed.comments.map((c) => ({ body: c.body, author: c.author?.login ?? null, url: c.url ?? null }))
}

/**
 * A security-review HIGH finding: `fetchRulings`/`fetchFrozenBrief`
 * trusted ANY comment matching their marker regex, author unchecked — a
 * non-principal PR/Issue commenter could post a fake `aeg:principal:ruling`-
 * or `aeg:brief:v1`-shaped comment and have its content concatenated
 * straight into the resumed developer's prompt every round, in this fully
 * unattended, commit-pushing loop. Both now require the matching comment's
 * author to resolve as a principal — the SAME `isPrincipal`/
 * `resolvePrincipalAllowlist` machinery `review-post.ts`'s own
 * `principalBodies` already uses for exactly this kind of forge-read trust
 * boundary, reused rather than re-derived.
 */
export function principalAllowlist(): string[] {
  return resolvePrincipalAllowlist(loadTrustAnchorConfig())
}

/**
 * Which severities block is repository policy — resolved from the SAME
 * default-branch trust-anchor source `principalAllowlist()` already reads,
 * never from the PR's own checkout, so a change cannot lower its own threshold.
 * `resolveReviewPolicy` refuses (throws) on a present-but-unknown severity
 * value; a FAILED read falls back to the built-in defaults (the historic
 * `loadTrustAnchorConfig` behaviour every other caller still relies on —
 * `review status`, for one). The one caller that must NOT default on a failed
 * read is the dev-review-loop, which would then cast a verdict the gate
 * rejects; it uses `reviewPolicyForLoop` below instead.
 */
export function reviewPolicy(): ReviewPolicy {
  return resolveReviewPolicy(loadTrustAnchorConfig())
}

/**
 * The policy read is retried once (two attempts total) before the loop gives
 * up — a transient forge hiccup (a rate-limit window, a brief outage) often
 * clears on the very next attempt, and an in-process retry is cheaper than the
 * whole pause-and-resume cycle. The durable backoff past this is the
 * infrastructure pause itself, which `task run --issue <n>` resumes.
 */
const POLICY_READ_ATTEMPTS = 2

/**
 * `reviewPolicy` for the dev-review-loop ONLY: a FAILED read of the
 * default-branch trust-anchor source (the forge read threw or timed out) must
 * never resolve to the built-in defaults here. On `2026-10-01` a loop cast
 * APPROVE/PASS under the `BLOCKER` default after a GitHub API limit broke the
 * read, while this repository's `reviewPolicy` sets `MAJOR`; the merge gate,
 * which read the real policy, refused both verdicts on a policy-digest
 * mismatch, and a clean review could not merge. So a failed read is retried
 * (`POLICY_READ_ATTEMPTS`) and, if it still fails, this THROWS naming the
 * read's own error — the throw propagates to `dev-review-loop.ts`'s widened
 * setup-phase `try` (O6), which turns it into a decided `pause(infrastructure)`
 * naming that error, never an uncaught exit and never a dispatched reviewer, so
 * a later resume casts verdicts under the repository's real policy. A missing
 * config file, or one present without a `reviewPolicy`, is NOT a failed read:
 * `loadTrustAnchorConfigOrThrow` returns `null` for it and the loop runs under
 * the built-in defaults exactly as before. `resolveReviewPolicy` still refuses
 * (throws) a present-but-unknown severity value — a config defect, not a read
 * failure, so it is never retried: that throw propagates to the same setup
 * `try` on the first attempt. This is the ONLY caller with the fail-loud
 * behaviour; `reviewPolicy` above keeps the shared fail-to-defaults contract.
 *
 * `load` is injectable for tests only; production callers pass nothing.
 */
export function reviewPolicyForLoop(load: () => VinayaConfig | null = loadTrustAnchorConfigOrThrow): ReviewPolicy {
  return resolveReviewPolicy(readTrustAnchorConfigWithRetry(load))
}

/**
 * The retried read behind `reviewPolicyForLoop`. Only the READ is retried; a
 * config that resolves to a value `resolveReviewPolicy` later rejects is a
 * defect, not a hiccup, and is handled by that function's caller, not here.
 * Throws naming the last read error once every attempt has failed.
 */
function readTrustAnchorConfigWithRetry(load: () => VinayaConfig | null): VinayaConfig | null {
  let lastErr: unknown
  for (let attempt = 1; attempt <= POLICY_READ_ATTEMPTS; attempt++) {
    try {
      return load()
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error(
    `reviewPolicyForLoop: could not read the repository's review policy from the default branch after ${POLICY_READ_ATTEMPTS} attempts — not casting a verdict under the built-in default policy: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
  )
}

/** Pure: every ruling body (after its marker line), from principal-authored comments only — unit-testable with no `gh` call. */
export function filterPrincipalRulings(comments: readonly MarkerComment[], allowlist: readonly string[]): string[] {
  return comments
    .filter((c) => isPrincipal(c.author, allowlist as string[]))
    .filter((c) => RULING_MARKER.test(c.body.split('\n')[0] ?? ''))
    .map((c) => contentAfterOneLine(c.body).trim())
}

const DEVELOPER_STOP_MARKER = /^<!-- aeg:developer:stop -->$/

/**
 * O9: a developer that refuses to start (entry
 * gate) or hits a stop condition before ever pushing has nowhere to post
 * but the task Issue — no PR exists yet. `aeg-root/roles/developer.md`
 * names this exact marker for that one case. Same trust boundary as
 * `filterPrincipalRulings` (that same security-review HIGH finding): a non-
 * principal Issue commenter could otherwise post a fake stop marker and
 * end an unattended loop early.
 */
export function filterDeveloperStops(comments: readonly MarkerComment[], allowlist: readonly string[]): string[] {
  return comments
    .filter((c) => isPrincipal(c.author, allowlist as string[]))
    .filter((c) => DEVELOPER_STOP_MARKER.test(c.body.split('\n')[0] ?? ''))
    .map((c) => contentAfterOneLine(c.body).trim())
}

/** The newest developer-stop comment and its stable identity on the task Issue. */
export function fetchDeveloperStop(issueNumber: number): { body: string; identity: string } | null {
  const allowlist = principalAllowlist()
  const stops = fetchIssueComments(issueNumber, 'fetchDeveloperStop').flatMap((comment, index) => {
    if (!isPrincipal(comment.author, allowlist as string[])) return []
    if (!DEVELOPER_STOP_MARKER.test(comment.body.split('\n')[0] ?? '')) return []
    return [
      {
        body: contentAfterOneLine(comment.body).trim(),
        identity: comment.url && comment.url.length > 0 ? comment.url : `comment-index:${index}`
      }
    ]
  })
  return stops.at(-1) ?? null
}

/**
 * Pure: the NEWEST principal-authored `aeg:brief:v<k>` comment among
 * `comments`, or `null` — unit-testable with no `gh` call. task
 * 4 widened this from a `v1`-only lookup to
 * `@attalabs/aeg-core`'s `resolveNewestFrozenBrief`, the single resolver
 * every frozen-brief reader (this loop, `resolveIssueObjectives` below, and
 * `check-brief-shape.ts`'s own Issue-comment read) now shares — a
 * supersession is an APPENDED comment, never an edit to the one it
 * replaces, so "the frozen brief" is always the highest version found here.
 */
export function findPrincipalFrozenBrief(
  comments: readonly MarkerComment[],
  allowlist: readonly string[]
): (MarkerComment & { version: number; content: string }) | null {
  return resolveNewestFrozenBrief(comments, allowlist)
}

/** Every ruling comment's body (after its marker line) on PR `prNumber`, in the forge's own comment order — principal-authored only. */
export function fetchRulings(prNumber: number): string[] {
  let out: string
  try {
    out = sh('gh', ['pr', 'view', String(prNumber), '--json', 'comments'])
  } catch (err) {
    throw new Error(
      `fetchRulings: could not fetch PR #${prNumber}'s comments: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  return filterPrincipalRulings(markerComments(out), principalAllowlist())
}

/**
 * The newest principal ruling ordinal on PR `prNumber` — `0` when none.
 * A separate `gh pr view`
 * call from `fetchRulings`' own, the same tolerated-redundancy shape this
 * file's `fetchFrozenBrief`/`resolveIssueObjectives` pair already uses for
 * Issue comments — never a shared cache, so each call reflects the forge at
 * the moment it runs, which is exactly what O3's mid-round re-check needs.
 */
export function fetchNewestRulingOrdinal(prNumber: number): number {
  let out: string
  try {
    out = sh('gh', ['pr', 'view', String(prNumber), '--json', 'comments'])
  } catch (err) {
    throw new Error(
      `fetchNewestRulingOrdinal: could not fetch PR #${prNumber}'s comments: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  return newestPrincipalRulingOrdinal(markerComments(out), principalAllowlist())
}

/**
 * The GitHub login that authored PR `prNumber`'s newest principal ruling, or
 * `null` when none exists — O2's own need: a resolution record's
 * `authenticatedBy` field names WHO authorized a `--resume`/`--cancel`,
 * distinct from `fetchNewestRulingOrdinal`'s WHICH.
 */
export function fetchNewestRulingAuthor(prNumber: number): string | null {
  let out: string
  try {
    out = sh('gh', ['pr', 'view', String(prNumber), '--json', 'comments'])
  } catch (err) {
    throw new Error(
      `fetchNewestRulingAuthor: could not fetch PR #${prNumber}'s comments: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  return newestPrincipalRulingAuthor(markerComments(out), principalAllowlist())
}

/**
 * The Issue-target counterparts of the three readers above — for the one pause
 * that has no pull request to read a ruling from (the before-any-push
 * escalation, whose pause comment goes on the task Issue). Each reads the
 * SAME `fetchIssueComments` this file's frozen-brief/objectives/developer-stop
 * readers already use, and hands it to the IDENTICAL pure parser and the
 * IDENTICAL `principalAllowlist()` its pull-request sibling uses — never a
 * second parser and never a wider trust boundary, so an Issue comment
 * authenticates a resume or a cancel on exactly the terms a pull-request one
 * does: principal-authored, and carrying the `aeg:principal:ruling:<k>-<n>`
 * marker on its own first line. A non-principal Issue commenter is refused
 * here for the same reason `filterDeveloperStops` refuses one.
 */
export function fetchIssueRulings(issueNumber: number): string[] {
  return filterPrincipalRulings(fetchIssueComments(issueNumber, 'fetchIssueRulings'), principalAllowlist())
}

/** The newest principal ruling ordinal on Issue `issueNumber` — `0` when none. `fetchNewestRulingOrdinal`'s Issue-target counterpart; see `fetchIssueRulings`. */
export function fetchNewestIssueRulingOrdinal(issueNumber: number): number {
  return newestPrincipalRulingOrdinal(
    fetchIssueComments(issueNumber, 'fetchNewestIssueRulingOrdinal'),
    principalAllowlist()
  )
}

/** The GitHub login that authored Issue `issueNumber`'s newest principal ruling, or `null`. `fetchNewestRulingAuthor`'s Issue-target counterpart; see `fetchIssueRulings`. */
export function fetchNewestIssueRulingAuthor(issueNumber: number): string | null {
  return newestPrincipalRulingAuthor(
    fetchIssueComments(issueNumber, 'fetchNewestIssueRulingAuthor'),
    principalAllowlist()
  )
}

function fetchIssueComments(issueNumber: number, caller: string): MarkerComment[] {
  let out: string
  try {
    out = sh('gh', ['issue', 'view', String(issueNumber), '--json', 'comments'])
  } catch (err) {
    throw new Error(
      `${caller}: could not fetch Issue #${issueNumber}'s comments: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  return markerComments(out)
}

/**
 * The Issue's frozen brief comment's text — the NEWEST principal-authored
 * `aeg:brief:v<k>` version, content already stripped of its header lines
 * (`resolveNewestFrozenBrief`'s own `.content`). Refuses (throws) rather
 * than inventing a brief when none
 * exists yet.
 */
export function fetchFrozenBrief(issueNumber: number): string {
  const found = resolveNewestFrozenBrief(fetchIssueComments(issueNumber, 'fetchFrozenBrief'), principalAllowlist())
  if (!found) {
    throw new Error(
      `fetchFrozenBrief: Issue #${issueNumber} carries no principal-authored, frozen \`aeg:brief:v<k>\` comment — \`vinaya task brief\` must post the brief before this loop can start.`
    )
  }
  return found.content
}

/** The sentinel `fetchSourceRevision` returns for a frozen brief posted before task 4 ever rendered a `**Revision:**` line — a real fact ("this brief predates the guarantee"), never a thrown refusal: an in-flight task's loop dispatched against an older brief must keep running after this task merges, not break on its very next reviewer round. */
export const NO_SOURCE_REVISION = '(none — pre-task-4 frozen brief)'

/**
 * The revision the frozen brief's facts were read at — read back out of
 * the brief text itself
 * (`extractSourceRevision`), never re-derived fresh from `git`: the loop
 * judges the developer's work against the facts the brief actually stated,
 * not a revision the tree has since moved past. `NO_SOURCE_REVISION` on a
 * pre-task-4 brief with no such line — every brief frozen from here on
 * always carries one (`renderBrief`'s own missing-fact refusal), so this is
 * a migration window, not a permanent case.
 */
export function fetchSourceRevision(issueNumber: number): string {
  return extractSourceRevision(fetchFrozenBrief(issueNumber)) ?? NO_SOURCE_REVISION
}

export function fetchIssueTitle(issueNumber: number): string {
  const out = sh('gh', ['issue', 'view', String(issueNumber), '--json', 'title'])
  return (JSON.parse(out) as { title: string }).title
}

export function fetchIssueLabels(issueNumber: number): string[] {
  const out = sh('gh', ['issue', 'view', String(issueNumber), '--json', 'labels'])
  return (JSON.parse(out) as { labels: { name: string }[] }).labels.map((l) => l.name)
}

/**
 * A code-review BLOCKER finding: the reviewer prompt's `OBJECTIVES:`
 * fact was `fetchFrozenBrief`'s ENTIRE brief text (every section — Context,
 * Technical dependencies, stop conditions, all of it), not "objectives from
 * the Issue" as O2 actually says and `renderReviewerPrompt`'s own doc
 * comment claims. This reads the Issue's `## Objectives` section only,
 * directly off its body (never the frozen brief comment) — the current
 * objectives, nothing else, matching the facts-only contract
 * `renderReviewerDispatchPrompt` keeps by construction: the only prose that
 * reaches a reviewer is the facts it interpolates, and the banned-framing
 * lint it runs reads the driver's own fixed text, never those facts.
 */
/** Pure: the `## Objectives` section text out of a body, or `''` when there is none — unit-testable with no `gh` call. */
export function extractObjectivesSection(body: string): string {
  const lines = body.split('\n')
  const start = lines.findIndex((l) => /^##\s*objectives\s*$/i.test(l.trim()))
  if (start === -1) return ''
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => /^##\s/.test(l))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim()
}

/**
 * `<!-- aeg:objectives:v<k> -->` — the marker `issue-objectives.ts`'s
 * `issueObjectivesEditCommand` posts on every edit-audit comment (`MARKER_PREFIX`
 * there). Duplicated here as a literal, not imported, the same way that
 * file's own `HEADING_RE` duplicates `objectives.ts`'s internal heading
 * regex (its own doc comment): the marker string is this module's public
 * surface (the shape every edit comment carries), never the command's
 * internals.
 */
const OBJECTIVES_EDIT_MARKER_RE = /^<!--\s*aeg:objectives:v(\d+)\s*-->$/

/** Pure: the newest principal-authored `<!-- aeg:objectives:v<k> -->` comment among `comments` — "newest" by marker index `k`, which `issueObjectivesEditCommand` assigns strictly increasing — or `null` when none exists. */
export function findLatestPrincipalObjectivesEdit(
  comments: readonly MarkerComment[],
  allowlist: readonly string[]
): MarkerComment | null {
  let best: { k: number; comment: MarkerComment } | null = null
  for (const c of comments) {
    if (!isPrincipal(c.author, allowlist as string[])) continue
    const m = OBJECTIVES_EDIT_MARKER_RE.exec((c.body.split('\n')[0] ?? '').trim())
    if (!m) continue
    const k = Number.parseInt(m[1] as string, 10)
    if (best === null || k > best.k) best = { k, comment: c }
  }
  return best?.comment ?? null
}

function parseObjectiveLines(raw: string): Objective[] | null {
  const parsed = objectivesOf(['## Objectives', '', raw].join('\n'))
  return parsed.ok ? parsed.objectives : null
}

export type ObjectivesEditParse = { previous: Objective[]; now: Objective[]; reason: string; version: string }

/**
 * Pure: parses an objectives-edit comment's body (the `Previous:`/`Now:`/
 * `Reason:`/`Version:` shape `issueObjectivesEditCommand` composes) into its
 * post-edit objectives list and the version it recorded — or `null` when the
 * body doesn't have that shape (defensive; every comment this driver ever
 * matches via `findLatestPrincipalObjectivesEdit` was posted by that command,
 * so this should not happen in practice).
 */
export function parseObjectivesEditComment(body: string): ObjectivesEditParse | null {
  const lines = body.split('\n')
  const previousIdx = lines.findIndex((l) => l.trim() === 'Previous:')
  const nowIdx = lines.findIndex((l) => l.trim() === 'Now:')
  const reasonLine = lines.find((l) => l.startsWith('Reason:'))
  const versionLine = lines.find((l) => l.startsWith('Version:'))
  if (previousIdx === -1 || nowIdx === -1 || nowIdx < previousIdx || !reasonLine || !versionLine) return null

  const previousBlock = lines
    .slice(previousIdx + 1, nowIdx)
    .join('\n')
    .trim()
  const nowRest = lines.slice(nowIdx + 1)
  const nowEnd = nowRest.findIndex((l) => l.trim() === '')
  const nowBlock = (nowEnd === -1 ? nowRest : nowRest.slice(0, nowEnd)).join('\n').trim()

  const previous = parseObjectiveLines(previousBlock)
  const now = parseObjectiveLines(nowBlock)
  if (!previous || !now) return null

  return {
    previous,
    now,
    reason: reasonLine.slice('Reason:'.length).trim(),
    version: versionLine.slice('Version:'.length).trim()
  }
}

/** The `Objective[]` diff `parseObjectivesEditComment` recorded, kept alongside the resolved text/version so a mid-round change can name what caused it. */
export type ObjectivesEditSource = { previous: Objective[]; now: Objective[]; reason: string }

export type ObjectivesResolution = {
  /** The `## Objectives` section text (`O<n>. <sentence>` lines, no heading) — same shape `extractObjectivesSection` returns. */
  text: string
  /** `null` exactly when `text` is empty — no `## Objectives` section resolvable from either source. */
  version: string | null
  /** Present only when `text`/`version` came from an objectives-edit comment, not the frozen brief. */
  edit: ObjectivesEditSource | null
  /** The parsed `id`/`text` list `text` resolves to — `[]` exactly when `text` is empty. task 4 threads this through to `buildVerdictFromReport`'s own `checkObjectiveIdCoverage` call, the same coverage rule `review post` already applies. */
  objectives: readonly Objective[]
}

/**
 * O1: the loop's one source of objectives, principal-gated end to end. The
 * newest principal-authored objectives-edit comment wins when one exists —
 * its `Version:` line is the authority (never recomputed here: it was
 * written by `issueObjectivesEditCommand` from the exact post-edit list it
 * had just spliced into the Issue body, the same input the merge gate's own
 * live-body re-read parses, so the two are identical by construction).
 * Otherwise, the principal-authored frozen brief's verbatim copy of the
 * Issue's `## Objectives` section (same trust boundary `fetchFrozenBrief`
 * already enforces), with the version computed from it via the same
 * `objectivesOf`/`objectivesVersion` pair the gate calls. Never the live
 * Issue body directly (Traps to avoid; that same security-review finding).
 *
 * One `gh issue view --json comments` call serves both sources.
 */
export function resolveIssueObjectives(issueNumber: number): ObjectivesResolution {
  let out: string
  try {
    out = sh('gh', ['issue', 'view', String(issueNumber), '--json', 'comments'])
  } catch (err) {
    throw new Error(
      `resolveIssueObjectives: could not fetch Issue #${issueNumber}'s comments: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  const comments = markerComments(out)
  const allowlist = principalAllowlist()

  const latestEdit = findLatestPrincipalObjectivesEdit(comments, allowlist)
  if (latestEdit) {
    const parsed = parseObjectivesEditComment(latestEdit.body)
    if (parsed) {
      return {
        text: parsed.now.map((o) => `${o.id}. ${o.text}`).join('\n'),
        version: parsed.version,
        edit: { previous: parsed.previous, now: parsed.now, reason: parsed.reason },
        objectives: parsed.now
      }
    }
  }

  const brief = findPrincipalFrozenBrief(comments, allowlist)
  if (!brief) {
    throw new Error(
      `resolveIssueObjectives: Issue #${issueNumber} carries no principal-authored, frozen \`aeg:brief:v1\` comment — \`vinaya task dispatch\` must post the brief before this loop can start.`
    )
  }
  const text = extractObjectivesSection(brief.content)
  if (text.length === 0) return { text: '', version: null, edit: null, objectives: [] }
  const parsedObjectives = objectivesOf(['## Objectives', '', text].join('\n'))
  return {
    text,
    version: parsedObjectives.ok ? objectivesVersion(parsedObjectives.objectives) : null,
    edit: null,
    objectives: parsedObjectives.ok ? parsedObjectives.objectives : []
  }
}

/**
 * O3: reconstructs the exact `vinaya issue objectives edit` invocation an
 * edit-audit comment records, from the `previous`/`now` lists
 * `parseObjectivesEditComment` already parsed — one of `--add`/`--drop`/
 * `--replace`, matching `applyOp`'s own three cases exactly
 * (`issue-objectives.ts`). Used only to name, in a pause detail, the command
 * that superseded a round's dispatch-time objectives — never executed.
 */
export function describeObjectivesEdit(issueNumber: number, edit: ObjectivesEditSource): string {
  const { previous, now, reason } = edit
  const base = `vinaya issue objectives edit ${issueNumber}`
  const sameThrough = (n: number) =>
    previous.slice(0, n).every((o, i) => o.id === now[i]?.id && o.text === now[i]?.text)

  if (now.length === previous.length + 1 && sameThrough(previous.length)) {
    const added = now[now.length - 1] as Objective
    return `${base} --add "${added.text}" --reason "${reason}"`
  }
  if (now.length === previous.length - 1) {
    const missing = previous.find((p) => !now.some((n) => n.id === p.id))
    if (missing && now.every((n, i) => n.id === previous.filter((p) => p.id !== missing.id)[i]?.id)) {
      return `${base} --drop ${missing.id} --reason "${reason}"`
    }
  }
  if (now.length === previous.length) {
    const changed = now.find((n, i) => previous[i]?.id === n.id && previous[i]?.text !== n.text)
    if (changed && now.every((n, i) => n.id === previous[i]?.id)) {
      return `${base} --replace ${changed.id} "${changed.text}" --reason "${reason}"`
    }
  }
  return `${base} — could not reconstruct the exact flags from the edit comment's Previous:/Now: diff; Reason: ${reason}`
}

const ISSUE_TITLE_SHAPE = /^\[([^\]]+)\]\s+(\d+)\s+[—-]/

/**
 * `task/<tranche>/<n>`, derived from the Issue's own `[<tranche>] <n> — …`
 * title — never guessed or configured separately. The LABEL decides which
 * shape applies, never the title: an Issue with no
 * `vinaya/tranche:*` label is a backlog Issue and derives `task/issue-<n>`
 * regardless of what its title happens to look like — a backlog Issue
 * titled coincidentally (or by copy-paste) like a tranche task's must never
 * be mistaken for one and polled on the wrong branch (found live: exactly
 * this shape of title on an unlabeled Issue). Only once the label is present
 * does the title's own shape matter: it must match, or this is a real defect
 * (a malformed tranche-task title on a labeled Issue), not a backlog Issue,
 * and still throws.
 */
export function developerBranchFor(
  issueNumber: number,
  fetchTitle: (n: number) => string = fetchIssueTitle,
  fetchLabels: (n: number) => string[] = fetchIssueLabels
): string {
  const labels = fetchLabels(issueNumber)
  if (!hasLabel('tranche', labels)) return issueBranchName(issueNumber)
  const title = fetchTitle(issueNumber)
  const m = ISSUE_TITLE_SHAPE.exec(title)
  if (m) return `task/${m[1]}/${m[2]}`
  throw new Error(
    `developerBranchFor: Issue #${issueNumber}'s title \`${title}\` does not match the \`[<tranche>] <n> — …\` shape, but it carries a vinaya/tranche:* label — cannot derive the developer's branch.`
  )
}

/**
 * O1: creates the task's own worktree at `.worktrees/<branch>`, on `<branch>`,
 * cut from `origin/main`'s tip — the loop's round-1 fresh-dispatch path calls
 * it once, before the first Developer dispatch, so the brief's own Step 0 can
 * simply ENTER the worktree rather than create it (`brief-render.ts`). Reuses
 * an existing worktree untouched rather than recreating it (Traps to avoid) —
 * a worktree another host or a crashed prior run already created for this
 * branch is left alone, and only the push/upstream step below still runs.
 *
 * Then creates the remote branch with a commit-free REF push —
 * `origin/main:refs/heads/<branch>`, `--no-verify` — never `git -C
 * <worktree> push -u origin HEAD` (Principal ruling 1): a freshly created
 * worktree carries no `apps/cli/dist`, which the managed pre-push hook's own
 * dispatch-readiness/typecheck/test gate requires, so that push failed
 * outright on the Principal's own Mac. The ref push moves no commits (the
 * ref already equals `origin/main`) and `--no-verify` is safe precisely
 * because of that — there is no task-branch content yet for the gate to
 * judge; the Developer's own first later push still runs it for real.
 * `git branch -u` then sets the worktree's own upstream, so GitHub shows the
 * task in flight from its first minute rather than only after the
 * Developer's own first later push. Never force-pushed.
 *
 * Throws on any git failure (worktree creation, ref push, or upstream set);
 * the one caller catches it, logs, and continues — a failed push here is
 * never fatal, since the Developer's own first push creates the same branch
 * later; a failed worktree creation surfaces instead at the Developer's own
 * Step 0, which can no longer silently fall back to creating one itself.
 * Paired with `developerBranchFor` above — that names the branch, this is
 * what first makes the worktree and the remote branch exist.
 */
export function createTaskWorktree(branch: string): void {
  const worktreeDir = join('.worktrees', branch)
  if (!existsSync(worktreeDir)) {
    sh('git', ['worktree', 'add', worktreeDir, '-b', branch, '--no-track', 'origin/main'])
  }
  sh('git', ['config', 'push.autoSetupRemote', 'true'])
  sh('git', ['push', '--no-verify', 'origin', `origin/main:refs/heads/${branch}`])
  sh('git', ['-C', worktreeDir, 'branch', '-u', `origin/${branch}`])
}

export type DispatchReadinessCheckResult = { ready: boolean; output: string }

function gateRunOutput(err: unknown): string {
  const stdout =
    typeof err === 'object' && err !== null && 'stdout' in err ? String((err as { stdout?: unknown }).stdout ?? '') : ''
  const stderr =
    typeof err === 'object' && err !== null && 'stderr' in err ? String((err as { stderr?: unknown }).stderr ?? '') : ''
  const combined = `${stdout}${stderr}`.trim()
  return combined.length > 0 ? combined : err instanceof Error ? err.message : String(err)
}

/**
 * Runs the task's dispatch-readiness gate from the driver's own unsandboxed
 * process, before the Developer's turn ever starts — never inside the
 * Developer's own sandbox, where a `gh` call either script makes (spawned by
 * a `bun` process, never typed directly, so `CLAUDE_SANDBOX_EXCLUDED_COMMANDS`'s
 * plain-`gh *` escape hatch never covers it) hits the denied forge-token file
 * (`isolation.md` §4a; found live, CI, Linux: `gh issue list --repo … --label
 * vinaya/tranche:…` and `gh-issue-view` both exit 1 under Claude's sandbox).
 * Runs both the portable `check-dispatch-readiness` bin and this repository's
 * own unabridged `verify-dispatch.ts` derivation (closing the shipped check's
 * prior-tranche-archival parity gap, `roles/developer.md`'s own "Known gap"
 * line) against the SAME `<tranche> <n>`/`--issue <n>` identity
 * `parseTaskBranchIdentity` reads off `branch` — the one parser every other
 * branch-keyed check in this repo already shares, never a second regex.
 *
 * `ready` is `false` the moment either command exits non-zero; `output`
 * concatenates both commands' own stdout+stderr, unredacted — staged to a
 * file only the driver and the Developer's own (already read-anywhere-but-
 * named-credentials) sandbox ever see, never posted to the forge. `runGate`
 * is `sh('bun', [script, ...args])` for a real run, injectable so a test can
 * assert the pass/fail/output composition without a live forge or `bun`.
 */
export function checkTaskDispatchReadiness(
  branch: string,
  runGate: (script: string, args: readonly string[]) => string = (script, args) => sh('bun', [script, ...args])
): DispatchReadinessCheckResult {
  const identity = parseTaskBranchIdentity(branch)
  if (identity === null) {
    return {
      ready: false,
      output: `branch '${branch}' matches neither task/<tranche>/<n> nor task/issue-<n> — cannot resolve this task's dispatch-readiness gate.`
    }
  }
  const gateArgs =
    identity.kind === 'tranche' ? [identity.tranche, identity.taskId] : ['--issue', String(identity.issueNumber)]
  const sections: string[] = []
  let ready = true
  const run = (script: string, extraArgs: readonly string[] = []): void => {
    const args = [...gateArgs, ...extraArgs]
    const label = `$ bun ${script} ${args.join(' ')}`
    try {
      sections.push(`${label}\n${runGate(script, args)}`.trim())
    } catch (err) {
      ready = false
      sections.push(`${label}\n${gateRunOutput(err)}`.trim())
    }
  }
  run('apps/cli/src/checks/bin/check-dispatch-readiness.ts')
  // `--existing-work`: the driver created this worktree itself and runs this
  // gate before every Developer turn, so from the second turn on the branch
  // always carries commits ahead of main — expected work, never a leftover.
  run('packages/aeg-core/bin/verify-dispatch.ts', ['--existing-work'])
  return { ready, output: sections.join('\n\n') }
}

type PrRef = { number: number; branch: string }

/** `null` when no open PR carries `branch` as its head yet — polled, never treated as a final answer on one read. */
export function findOpenPrForBranch(branch: string): PrRef | null {
  try {
    const out = sh('gh', ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,headRefName'])
    const list = JSON.parse(out) as { number: number; headRefName: string }[]
    const found = list.find((p) => p.headRefName === branch)
    return found ? { number: found.number, branch } : null
  } catch {
    return null
  }
}

/**
 * O9: thrown by the round-1-entry check when the
 * developer's very first turn ends with no branch on the remote AND a
 * refusal/escalation posted on the task Issue (`fetchDeveloperStop`) — the
 * caller catches this and ends the loop at once, never entering the
 * pull-request poll (there is nothing to poll for: no push ever happened).
 */
export class DeveloperStopSignal extends Error {
  constructor(public readonly detail: string) {
    super(`devReviewLoop: developer posted a stop before any push: ${detail}`)
  }
}

export function withPromptFile<T>(prompt: string, fn: (promptFile: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-dev-review-loop-prompt-'))
  const promptFile = join(dir, 'prompt.md')
  writeFileSync(promptFile, prompt, 'utf8')
  try {
    return fn(promptFile)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// --- developer role doctrine, prepended to a fresh dispatch -------------------

/**
 * O1: the two `## …` sections of the developer role's REFERENCE document that
 * the Principal ruled are the developer's checklist — honoured on every fresh
 * (non-resumed) developer session. Unlike the reviewer's `## What you check`,
 * these live in `roles/developer/reference.md`, not in the role file the role
 * plan resolves (`roles/developer.md`), so `resolveDeveloperDoctrineText` reads
 * that reference document for the core role; an override carries them inline.
 */
export const DEVELOPER_CHECKLIST_HEADINGS = ['Stop conditions', 'Verification before reporting done'] as const

/**
 * Pure: the body of a `## <heading>` section of `body` — everything up to the
 * next `## ` heading, trimmed — or `''` when the heading is absent. Same shape
 * as `extractObjectivesSection`, but heading-parameterised for the two
 * developer checklist sections.
 */
export function extractDeveloperSection(body: string, heading: string): string {
  const lines = body.split('\n')
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`)
  if (start === -1) return ''
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => /^##\s/.test(l))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim()
}

/**
 * O1, pure: the developer doctrine a fresh dispatch is prepended — the short
 * version (its trailing `---` rule stripped, exactly as the reviewer injection
 * does) followed by whichever of the two `DEVELOPER_CHECKLIST_HEADINGS`
 * sections `checklistSource` actually carries. A section absent from
 * `checklistSource` is dropped, never fabricated — the same graceful degrade
 * `extractShortVersionAndChecklist` makes for the reviewer; a missing override
 * section is a Planner-level escalation, never an invented one. Returns `null`
 * when there is no short version at all (a body no validated role contract can
 * have — `validateRoleContract` requires that section), so `null` here only
 * ever names an unresolved role.
 */
export function assembleDeveloperDoctrine(shortVersion: string | null, checklistSource: string): string | null {
  if (shortVersion === null) return null
  const short = shortVersion.replace(/\n*-{3,}[ \t]*$/, '').trimEnd()
  if (short.trim().length === 0) return null
  const sections = DEVELOPER_CHECKLIST_HEADINGS.map((heading) => {
    const body = extractDeveloperSection(checklistSource, heading)
    return body.length === 0 ? null : `## ${heading}\n\n${body}`
  }).filter((section): section is string => section !== null)
  return sections.length === 0 ? short : `${short}\n\n${sections.join('\n\n')}`
}

/** The developer role's reference document (`roles/developer/reference.md`) under the resolved doctrine root, or `null` when no bundled doctrine can be found or the file is unreadable — the same install-aware root `resolveDeveloperDoctrineText`'s own `buildRolePlan` resolves the short version through. */
function readDeveloperReferenceDoc(): string | null {
  const root = resolveDoctrineRoot()
  if (root === null) return null
  try {
    return readFileSync(join(root, 'roles', 'developer', 'reference.md'), 'utf8')
  } catch {
    return null
  }
}

/**
 * O1: the developer's published doctrine — its short version plus its
 * `## Stop conditions` and `## Verification before reporting done` sections —
 * resolved through the SAME override-aware role plan `vinaya check --plan`
 * renders (`buildRolePlan`), so an adopter's `roles.developer` override supplies
 * its own body. The short version is the developer role file's own; the two
 * checklist sections live in the role's REFERENCE document for the core role (a
 * separate file the role plan does not carry) and in the override's own body
 * for an override. Returns `null` when no doctrine can be resolved (no bundled
 * doctrine, or the developer role absent from the plan) — the caller then
 * dispatches with the frozen brief alone, exactly the pre-task behaviour.
 */
export async function resolveDeveloperDoctrineText(): Promise<string | null> {
  const configResult = loadConfigChecked()
  const configFilePath = configResult.ok ? configPath() : configResult.path
  const plan = await buildRolePlan(
    configFilePath ? dirname(configFilePath) : null,
    configResult.ok ? configResult.config?.roles : undefined
  )
  if (!plan.available) return null
  const resolved = plan.resolved.find((entry) => entry.renderId === 'developer')
  if (resolved === undefined) return null
  // Core role: the two checklist sections live in the reference document, not
  // the role file the plan resolves. An override replaces the whole contract,
  // so its own body is the only place its sections can live.
  const checklistSource =
    resolved.state === 'default' ? (readDeveloperReferenceDoc() ?? resolved.contract.body) : resolved.contract.body
  return assembleDeveloperDoctrine(extractShortVersion(resolved.contract.body), checklistSource)
}

/**
 * O1/O2: wraps the resolved developer doctrine in a block prepended, OUTSIDE
 * the frozen brief, to a fresh (non-resumed) developer session. Names the
 * doctrine command — never a repository path an adopter's checkout lacks — for
 * the full reference beyond these two checklist sections.
 */
export function renderDeveloperDoctrineBlock(doctrine: string): string {
  return [
    "YOUR ROLE DOCTRINE — the developer role's short version and its checklist (its Stop conditions and its Verification before reporting done), the same doctrine an interactive developer reads. Run `bun apps/cli/src/index.ts doctrine --role developer --print` for its full reference. This is your operating instruction; the frozen brief for this task follows it.",
    doctrine.trim()
  ].join('\n\n')
}

/**
 * Dispatches the developer through `dispatchRole`, with the brief text read
 * from the Issue's frozen `aeg:brief:v1` comment, waits for the PR the
 * developer opens, then runs rounds by calling `assessRound` with
 * observations read from the forge and from held reviewer outcomes, until
 * a `publish` or `pause` decision.
 */
/** `Closes #(\d+)` off a PR body — the same reference every dispatched PR body already carries (`roles/developer.md`) — the only way `--resume <pr>` can find the task a bare PR number belongs to. */
export function taskFromPrBody(body: string): number | null {
  const m = /Closes #(\d+)/i.exec(body)
  return m ? Number(m[1]) : null
}

export function fetchPrBody(pr: number): string {
  const out = sh('gh', ['pr', 'view', String(pr), '--json', 'body'])
  return (JSON.parse(out) as { body: string }).body
}

// --- launch recovery (O3) --------------------------------------------------

/**
 * O3: the disposition recovery reaches for a prior launch, BEFORE the loop
 * continues.
 *
 *   - `none`     — no launch record exists (or it is corrupt and continuity is
 *                  not required): nothing to reconcile, dispatch fresh.
 *   - `live`     — a prior launch's own child process is still alive on this
 *                  host: it is still running, so the caller must NOT spawn a
 *                  second worker onto the same task — reconcile, never race.
 *   - `finished` — the launch is over and this worker's continuity is not
 *                  required (a reviewer, always dispatched fresh): proceed,
 *                  carrying the normalized outcome for the record.
 *   - `resume`   — the launch is over, this worker's continuity IS required,
 *                  and its exact vendor session is available: resume THAT
 *                  session, never a fresh one.
 *   - `fresh`    — the launch was refused before any vendor process was ever
 *                  spawned, so no session, and no turn state, ever existed to
 *                  lose: dispatch fresh, exactly like `none`, but carrying the
 *                  refused record so the caller can narrate what it recovered
 *                  from.
 *   - `pause`    — continuity is required, the launch DID spawn, and its
 *                  session is gone (never bound, or the record is corrupt):
 *                  pause explicitly rather than silently starting a fresh
 *                  session that would lose the worker's continuity.
 */
export type LaunchReconciliation =
  | { kind: 'none' }
  | { kind: 'live'; record: LaunchRecord }
  | { kind: 'finished'; record: LaunchRecord; outcome: NormalizedOutcome }
  | { kind: 'resume'; record: LaunchRecord; resumeId: string; outcome: NormalizedOutcome }
  | { kind: 'fresh'; record: LaunchRecord; outcome: NormalizedOutcome }
  | { kind: 'pause'; reason: 'infrastructure'; detail: string }

export type ReconcileLaunchDeps = {
  /** Is a process with this pid alive on this host? Injected so the pure reconciler stays testable without a real process. */
  isPidAlive: (pid: number) => boolean
  /** This machine's hostname — a launch recorded on a DIFFERENT host can never be probed for liveness here, so it is treated as not-live. */
  hostname: () => string
  /** O3: a live snapshot of `pid`'s current identity (parent pid, start time, command), or `null` when no process answers there at all. Injected so the pure reconciler stays testable without a real process — `classifyChildLiveness` is the pure logic that reads it. */
  getProcessSnapshot: (pid: number) => ProcessSnapshot | null
  /** O2 (found by code review, MAJOR): terminates an abandoned child by pid — `recoverDeveloperLaunch`'s reap step calls THIS, never `dispatch.ts`'s `terminateChildWithGrace` directly, so the reap step itself has a test seam: a test can inject a spy here and assert the orphan was actually reaped, without sending a real OS signal. */
  terminateChild: (pid: number) => void
}

/**
 * O2/O3, pure: is `record.childPid` genuinely still this
 * launch's own child — and, if so, still parented to the driver that
 * spawned it?
 *
 *   - `'not-ours'`   — no process answers at that pid on this host, or one
 *                       does but its own identity (start time and/or
 *                       command, snapshotted the instant `spawn` returned
 *                       it) does not match the record's, OR a field the
 *                       record DID capture can no longer be read back at
 *                       all (a transient `ps` failure is never treated as
 *                       proof of identity, round 3 security review, MEDIUM):
 *                       a pid the OS has since recycled for an unrelated
 *                       process is never treated as this launch's child,
 *                       and is never touched (O3 — Traps: never rely on a
 *                       pid number alone).
 *   - `'orphaned'`    — the SAME process, confirmed by identity, is still
 *                       alive but no longer parented to the dispatcher that
 *                       spawned it (reparented to init, or that dispatcher
 *                       pid itself no longer answers): abandoned by a
 *                       driver that died without reaching its own shutdown
 *                       path (O1's gap) — ours to reap and take over, never
 *                       returned as `'live'` (O2).
 *   - `'live'`        — the same process, still parented to a dispatcher
 *                       that is itself still alive: a genuinely live
 *                       worker. The duplicate-worker guard's contract is
 *                       unchanged here — this is the one case a second
 *                       worker must still never race.
 */
export function classifyChildLiveness(
  record: LaunchRecord,
  deps: ReconcileLaunchDeps
): 'live' | 'orphaned' | 'not-ours' {
  if (record.childPid === null || record.host !== deps.hostname()) return 'not-ours'
  const snapshot = deps.getProcessSnapshot(record.childPid)
  if (snapshot === null) return 'not-ours'
  // Round 3 security review, MEDIUM (round 4: factored into `dispatch.ts`'s
  // `matchesCapturedIdentity`, the ONE identity guard this and the driver's
  // own shutdown path now share): a field this record DID capture at spawn
  // time must be re-confirmed now, not silently skipped, when the live
  // snapshot can't read it back — a transient `ps` read failure (a
  // permissions hiccup, a race) is not proof of identity and must never be
  // treated as one. A record that never captured identity at all (every
  // record written before this task) has nothing to re-confirm and falls
  // through to the ppid+liveness check below exactly as before.
  if (!matchesCapturedIdentity(record, snapshot)) return 'not-ours'
  if (snapshot.ppid === record.dispatcherPid && deps.isPidAlive(record.dispatcherPid)) return 'live'
  return 'orphaned'
}

export type ReconcileOpts = {
  /** Whether this worker's continuity is required — the developer's is; a reviewer's is NEVER (a reviewer is always dispatched fresh, never resumed because the developer resumes — Traps to avoid). */
  requireContinuity: boolean
  /** Whether the launch's required artifacts are observable now (its branch/PR exists) — fed to the outcome normalizer so a finished launch is classified truthfully rather than assumed incomplete. Defaults to `false` (unproven → not done). */
  artifactsPresent?: boolean
}

/**
 * The manner-of-death signals a launch record carries, mapped onto the
 * outcome normalizer's input (O2 ↔ O3). The launch record does not persist the
 * raw exit code (the manner-of-death flag is what the parent acts on), so
 * `exitCode` is `null` here — and the normalizer treats it as input only in
 * any case. `postconditionsMet` is folded onto the same coarse
 * `artifactsPresent` signal recovery has: recovery observes whether the work
 * left an artifact, not each declared postcondition separately.
 */
function outcomeSignalsFor(record: LaunchRecord, artifactsPresent: boolean): OutcomeSignals {
  return {
    exitCode: null,
    timedOut: record.failureReason === 'timeout',
    // O1: a driver-terminated child (`'signal'`) is a cancelled
    // attempt, never an infrastructure failure of its own making — the same
    // distinction `'crash'` (the child's own doing) already draws.
    cancelled: record.failureReason === 'signal',
    refused: record.failureReason === 'refused',
    infrastructure: record.failureReason === 'crash',
    artifactsPresent,
    postconditionsMet: artifactsPresent
  }
}

/**
 * Pure: did this launch end without ever spawning a vendor process at all?
 *
 * Decided from the record's own lifecycle facts, never from which
 * `DispatchFailureReason` it carries — every pre-spawn refusal
 * `dispatchRole` can raise (an authentication refusal, a sandbox/boundary
 * start-up refusal, a hook-setup refusal, a capability refusal, a `spawn`
 * that threw) already writes this same shape, and a future one will too,
 * with no new case to add here:
 *
 *   - `childPid === null` — the child pid is stamped the instant `spawn`
 *     returns, so no pid on record means no spawn identity was ever
 *     captured.
 *   - `status === 'interrupted'` with a `failureReason` — the dispatcher
 *     itself stayed alive long enough to reach its own failure path and
 *     write a terminal record. Together with the missing pid that is proof
 *     of "refused before spawn", not merely "we cannot tell": a dispatcher
 *     killed in the window between `spawn` returning and the pid being
 *     stamped leaves a non-terminal `'launched'` record instead, which is
 *     read here as possibly-spawned and keeps the continuity pause.
 *
 * A record with a bound session is never asked this question (a session
 * exists only after a spawn), and a launch that DID spawn is never treated
 * as having nothing to lose — its turn state is exactly what the continuity
 * pause protects.
 */
export function launchNeverSpawned(record: LaunchRecord): boolean {
  return record.childPid === null && record.status === 'interrupted' && record.failureReason !== null
}

/**
 * Pure (O3): reconcile a prior launch — live, finished, or uncertain — into
 * one disposition, from its parsed record plus injected pid-liveness. Never
 * reads disk or probes a process itself; `recoverDeveloperLaunch` below is the
 * disk-and-pid-reading wrapper. See `LaunchReconciliation` for the five
 * dispositions and when each is reached.
 */
export function reconcileLaunch(
  parsed: ParsedLaunch,
  opts: ReconcileOpts,
  deps: ReconcileLaunchDeps
): LaunchReconciliation {
  if (parsed.status === 'absent') return { kind: 'none' }
  if (parsed.status === 'corrupt') {
    // A corrupt record means a launch happened but its identity is unreadable
    // — for a continuity-required worker that is an explicit pause (we cannot
    // safely resume nor safely re-dispatch), never a silent fresh start.
    return opts.requireContinuity
      ? { kind: 'pause', reason: 'infrastructure', detail: `the prior launch record is corrupt (${parsed.reason})` }
      : { kind: 'none' }
  }

  const record = parsed.record
  const artifactsPresent = opts.artifactsPresent ?? false

  // Live: the recorded child is still running, on THIS host, confirmed by
  // identity, and still parented to the dispatcher that spawned it (O2/O3
  // — `classifyChildLiveness`). This is the "crash between spawn and
  // session binding → child found by identity" case: the launch record,
  // written before spawn and stamped with the child pid the instant spawn
  // returned, is what lets recovery find the still-live child rather than
  // spawning a duplicate. An `'orphaned'` child — alive, but reparented to
  // init because its own driver died without reaching its shutdown path —
  // falls through to the SAME finished/resume/pause path below as a `null`
  // childPid always did; `recoverDeveloperLaunch` reaps it before this
  // function is ever called, so by the time execution reaches here an
  // orphan already reads as gone.
  if (classifyChildLiveness(record, deps) === 'live') {
    return { kind: 'live', record }
  }

  const outcome = normalizeOutcome(outcomeSignalsFor(record, artifactsPresent))

  if (!opts.requireContinuity) return { kind: 'finished', record, outcome }

  // Continuity required (the developer). Resume the EXACT session when one was
  // bound — even from an interrupted attempt, now that the session survives an
  // interruption (O1). When none was ever bound, the session is genuinely gone
  // and there is nothing to resume: pause explicitly rather than start fresh.
  if (record.resumeId !== null) return { kind: 'resume', record, resumeId: record.resumeId, outcome }
  // Refused before any vendor process started (`launchNeverSpawned`): there
  // is no session AND no turn state — nothing a fresh dispatch could lose —
  // so this is dispatched fresh rather than paused. Without this, a launch
  // that never ran blocked its task forever behind a continuity rule with no
  // continuity to protect.
  if (launchNeverSpawned(record)) return { kind: 'fresh', record, outcome }
  return {
    kind: 'pause',
    reason: 'infrastructure',
    detail:
      `the developer's prior launch (attempt ${record.attempt}) ended ${outcome.status} ` +
      `(${record.failureReason ?? 'no failure recorded'}) before its vendor session was ever bound — ` +
      'cannot resume the exact session, and starting a fresh one would lose worker continuity'
  }
}

/** Thrown by the driver's resume seam when `recoverDeveloperLaunch` returns a `pause` (a required session is gone) or a `live` prior launch (a second worker must never race the first) — caught by the loop's own outer handler and turned into the decided `pause{reason:'infrastructure'}` every thrown driver-path failure already becomes (`apps/cli/specs/loop.md`), so no new pause plumbing is added. */
export class LaunchContinuityLost extends Error {
  constructor(public readonly detail: string) {
    super(`devReviewLoop: cannot continue the developer's launch: ${detail}`)
    this.name = 'LaunchContinuityLost'
  }
}

/** The real pid-liveness + hostname + process-snapshot deps `recoverDeveloperLaunch` uses by default — internal, not part of the module's public surface (a test injects its own). */
function defaultReconcileLaunchDeps(): ReconcileLaunchDeps {
  return {
    isPidAlive: defaultIsPidAlive,
    hostname: () => osHostname(),
    getProcessSnapshot,
    terminateChild: terminateChildWithGrace
  }
}

/**
 * O3: reconcile the developer's prior launch for `task` before the loop
 * continues — the disk-and-pid-reading wrapper over `reconcileLaunch`, always
 * with `requireContinuity: true` (the developer's session continuity is
 * required; a reviewer's is not, and no reviewer path calls this). Reads the
 * launch record `dispatch.ts` durably wrote, keyed by the same
 * repo+role+vendor+task scope the resume record already used.
 */
export function recoverDeveloperLaunch(
  task: number,
  agent: AgentVendor,
  repo: { owner: string; repo: string } | null,
  opts: { artifactsPresent?: boolean } = {},
  deps: ReconcileLaunchDeps = defaultReconcileLaunchDeps()
): LaunchReconciliation {
  const parsed = readLaunchRecord('developer', agent, repo, task)
  // O2: an abandoned child — still alive, confirmed by
  // identity, but no longer parented to the driver that spawned it — is
  // reaped HERE, before the disposition below is computed, so it never
  // survives to race whatever worker this reconciliation is about to hand
  // continuity to (the duplicate-worker guard's entire point — Traps to
  // avoid). Once reaped, `reconcileLaunch`'s own liveness check reads it as
  // gone, exactly like any other finished launch; a genuinely `'live'` or
  // `'not-ours'` child is left untouched here.
  if (parsed.status === 'ok' && parsed.record.childPid !== null) {
    if (classifyChildLiveness(parsed.record, deps) === 'orphaned') {
      deps.terminateChild(parsed.record.childPid)
    }
  }
  return reconcileLaunch(parsed, { requireContinuity: true, artifactsPresent: opts.artifactsPresent }, deps)
}
