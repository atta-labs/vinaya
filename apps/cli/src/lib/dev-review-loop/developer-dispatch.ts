/**
 * `dev-review-loop`'s developer-dispatch-and-branch-polling concern
 * (task 8, `#506`, O8) — every forge read that resolves
 * WHAT the loop is working on and WHO said so with authority: the task
 * Issue's title/branch/objectives/rulings, principal-authored markers
 * (rulings, developer stops, objectives edits), and open-PR/branch lookup.
 * Moved out of `apps/cli/src/lib/dev-review-loop.ts` verbatim; `dev-review-loop.ts`
 * stays the composition root, re-exporting every name below under the same
 * path it always had.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { hostname as osHostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultIsPidAlive,
  isPrincipal,
  issueBranchName,
  newestPrincipalRulingOrdinal,
  normalizeOutcome,
  type NormalizedOutcome,
  type Objective,
  objectivesOf,
  objectivesVersion,
  type OutcomeSignals,
  extractSourceRevision,
  resolveNewestFrozenBrief,
  type ReviewPolicy
} from '@attalabs/aeg-core'
import { hasLabel } from '@attalabs/aeg-forge-state'
import { loadTrustAnchorConfig, resolvePrincipalAllowlist, resolveReviewPolicy } from '../config.js'
import { type AgentVendor, type LaunchRecord, type ParsedLaunch, readLaunchRecord } from '../dispatch.js'
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

export type MarkerComment = { body: string; author: string | null }

/**
 * `gh {pr,issue} view --json comments` returns `author.login` on every
 * comment by default — no extra field flag needed (confirmed against
 * `review-post.ts`'s own identical `c.author?.login ?? null` read).
 */
export function markerComments(raw: string): MarkerComment[] {
  const parsed = JSON.parse(raw) as { comments: { body: string; author?: { login?: string } | null }[] }
  return parsed.comments.map((c) => ({ body: c.body, author: c.author?.login ?? null }))
}

/**
 * Security review, PR #445 round 1, HIGH: `fetchRulings`/`fetchFrozenBrief`
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
 * Which severities block is repository policy (task 8,
 * `#506`, O1/O4) — resolved from the SAME default-branch trust-anchor source
 * `principalAllowlist()` already reads, never from the PR's own checkout, so
 * a change cannot lower its own threshold. `resolveReviewPolicy` refuses
 * (throws) on a present-but-unknown severity value; this loop has no
 * sanctioned way to run with an unresolvable policy, so that throw
 * propagates to `dev-review-loop.ts`'s own widened setup-phase `try` (O6),
 * which turns it into a decided `pause(infrastructure)` — never an uncaught
 * exit — the same as any other unrecoverable config defect this loop cannot
 * itself repair.
 */
export function reviewPolicy(): ReviewPolicy {
  return resolveReviewPolicy(loadTrustAnchorConfig())
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
 * `filterPrincipalRulings` (security review, PR #445, HIGH): a non-
 * principal Issue commenter could otherwise post a fake stop marker and
 * end an unattended loop early.
 */
export function filterDeveloperStops(comments: readonly MarkerComment[], allowlist: readonly string[]): string[] {
  return comments
    .filter((c) => isPrincipal(c.author, allowlist as string[]))
    .filter((c) => DEVELOPER_STOP_MARKER.test(c.body.split('\n')[0] ?? ''))
    .map((c) => contentAfterOneLine(c.body).trim())
}

/** The newest developer-stop comment's body on Issue `issueNumber`, or `null` when none exists. */
export function fetchDeveloperStop(issueNumber: number): string | null {
  const stops = filterDeveloperStops(fetchIssueComments(issueNumber, 'fetchDeveloperStop'), principalAllowlist())
  return stops.length > 0 ? (stops[stops.length - 1] ?? null) : null
}

/**
 * Pure: the NEWEST principal-authored `aeg:brief:v<k>` comment among
 * `comments`, or `null` — unit-testable with no `gh` call. task
 * 4 (Issue #483, O3) widened this from a `v1`-only lookup to
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
 * The newest principal ruling ordinal on PR `prNumber` — `0` when none
 * (task 3, `#477`, O1/O3). A separate `gh pr view`
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
 * (`resolveNewestFrozenBrief`'s own `.content`, task 4, Issue
 * #483, O3). Refuses (throws) rather than inventing a brief when none
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
 * The revision the frozen brief's facts were read at (task 4,
 * Issue #483, O2) — read back out of the brief text itself
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
 * Code review, PR #445 round 1, BLOCKER: the reviewer prompt's `OBJECTIVES:`
 * fact was `fetchFrozenBrief`'s ENTIRE brief text (every section — Context,
 * Technical dependencies, stop conditions, all of it), not "objectives from
 * the Issue" as O2 actually says and `renderReviewerPrompt`'s own doc
 * comment claims. This reads the Issue's `## Objectives` section only,
 * directly off its body (never the frozen brief comment) — the current
 * objectives, nothing else, matching the facts-only contract the lint in
 * `renderReviewerDispatchPrompt` exists to enforce.
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

/** The `Objective[]` diff `parseObjectivesEditComment` recorded, kept alongside the resolved text/version so a mid-round change can name what caused it (O3). */
export type ObjectivesEditSource = { previous: Objective[]; now: Objective[]; reason: string }

export type ObjectivesResolution = {
  /** The `## Objectives` section text (`O<n>. <sentence>` lines, no heading) — same shape `extractObjectivesSection` returns. */
  text: string
  /** `null` exactly when `text` is empty — no `## Objectives` section resolvable from either source. */
  version: string | null
  /** Present only when `text`/`version` came from an objectives-edit comment, not the frozen brief. */
  edit: ObjectivesEditSource | null
  /** The parsed `id`/`text` list `text` resolves to — `[]` exactly when `text` is empty. task 4 (`#478`, O4) threads this through to `buildVerdictFromReport`'s own `checkObjectiveIdCoverage` call, the same coverage rule `review post` already applies. */
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
 * Issue body directly (Traps to avoid; PR #445's security round).
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
 * shape applies, never the title (`#548` v3, O3): an Issue with no
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

/**
 * Dispatches the developer through `dispatchRole`, with the brief text read
 * from the Issue's frozen `aeg:brief:v1` comment (O1), waits for the PR the
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
 *   - `pause`    — continuity is required but the session is gone (never
 *                  bound, or the record is corrupt): pause explicitly rather
 *                  than silently starting a fresh session that would lose the
 *                  worker's continuity.
 */
export type LaunchReconciliation =
  | { kind: 'none' }
  | { kind: 'live'; record: LaunchRecord }
  | { kind: 'finished'; record: LaunchRecord; outcome: NormalizedOutcome }
  | { kind: 'resume'; record: LaunchRecord; resumeId: string; outcome: NormalizedOutcome }
  | { kind: 'pause'; reason: 'infrastructure'; detail: string }

export type ReconcileLaunchDeps = {
  /** Is a process with this pid alive on this host? Injected so the pure reconciler stays testable without a real process. */
  isPidAlive: (pid: number) => boolean
  /** This machine's hostname — a launch recorded on a DIFFERENT host can never be probed for liveness here, so it is treated as not-live. */
  hostname: () => string
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
    cancelled: false,
    refused: record.failureReason === 'refused',
    infrastructure: record.failureReason === 'crash',
    artifactsPresent,
    postconditionsMet: artifactsPresent
  }
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

  // Live: the recorded child is still running, on THIS host. A launch recorded
  // on another host cannot be probed and is treated as not-live. This is the
  // "crash between spawn and session binding → child found by identity" case:
  // the launch record, written before spawn and stamped with the child pid the
  // instant spawn returned, is what lets recovery find the still-live child
  // rather than spawning a duplicate.
  if (record.childPid !== null && record.host === deps.hostname() && deps.isPidAlive(record.childPid)) {
    return { kind: 'live', record }
  }

  const outcome = normalizeOutcome(outcomeSignalsFor(record, artifactsPresent))

  if (!opts.requireContinuity) return { kind: 'finished', record, outcome }

  // Continuity required (the developer). Resume the EXACT session when one was
  // bound — even from an interrupted attempt, now that the session survives an
  // interruption (O1). When none was ever bound, the session is genuinely gone
  // and there is nothing to resume: pause explicitly rather than start fresh.
  if (record.resumeId !== null) return { kind: 'resume', record, resumeId: record.resumeId, outcome }
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

/** The real pid-liveness + hostname deps `recoverDeveloperLaunch` uses by default — internal, not part of the module's public surface (a test injects its own). */
function defaultReconcileLaunchDeps(): ReconcileLaunchDeps {
  return { isPidAlive: defaultIsPidAlive, hostname: () => osHostname() }
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
  return reconcileLaunch(parsed, { requireContinuity: true, artifactsPresent: opts.artifactsPresent }, deps)
}
