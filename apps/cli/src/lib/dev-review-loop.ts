/**
 * `devReviewLoop` — the driver half of the loop spec (`#415`; Linear
 * "Tech spec — Developer Review Loop" rev 4, §16).
 * `assessRound` (`@attalabs/aeg-core`, task 4) is the ENTIRE policy; this
 * file never re-implements a stop condition, a confidence rule, or a
 * round-outcome decision. It only turns real forge/dispatch facts into
 * `Observations`, calls `assessRound`, and acts on the returned `Decision`.
 *
 * Content never travels through `dispatchRole`'s return value —
 * `DispatchHandle` carries only `resumeId`/`usage`/exit status by design
 * (`dispatch.ts`'s own doc comment; confirmed by reading its source, not
 * guessed). Every piece of SUBSTANTIVE content a round needs — the
 * developer's confidence line, a reviewer's findings — travels through a
 * filesystem side channel the dispatched agent is instructed (in its own
 * prompt) to write to, exactly the same way a real Developer's actual
 * output is a PR, not a return value. This is why `resolveHead`,
 * `fetchCiConclusion`, `fetchRulings`, `fetchFrozenBrief` and the two
 * findings/objectives-file readers all exist: everything this driver learns
 * about a round comes from the forge or from a file, never from a vendor's
 * raw stdout read out-of-band (Section 10 stop condition; the one thing
 * this file must never do).
 *
 * Two invariants, load-bearing for O1/O2's "nothing posted before publish":
 * this file imports no forge-WRITE function (`postMarkedComment`,
 * `gh pr comment`, `gh pr review` never appear below) and calls
 * `dispatchRole` fresh, every round, for every reviewer (never resumes a
 * reviewer session) — only the developer's session is ever resumed.
 */

import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  assessRound,
  extractCodeReviewVerdict,
  extractSecurityReviewVerdict,
  extractSourceRevision,
  initialLoopState,
  isPrincipal,
  type Objective,
  objectivesOf,
  objectivesVersion,
  renderSummary,
  resolveNewestFrozenBrief,
  type Confidence,
  type Decision,
  type DevReviewLoopEventInput,
  type Journal,
  type LoopConfig,
  type LoopState,
  type Observations,
  type PauseReason,
  type RoundStats,
  type VerdictObservation
} from '@attalabs/aeg-core'
import {
  deriveCodeReviewVerdict,
  deriveSecurityVerdict,
  type EscalationClass,
  type Finding,
  isEscalationClass,
  parseFindingsFile,
  parseObjectivesFile,
  principalBodies,
  renderCodeReviewComment,
  renderEscalationComment,
  renderSecurityComment
} from '../commands/review-post.js'
import {
  AGENT_VENDOR_NAMES,
  type AgentVendor,
  dispatchRole as realDispatchRole,
  type DispatchHandle,
  readResumeRecord as realReadResumeRecord,
  type ResumeRecord
} from './dispatch.js'
import { GLOBAL_VINAYA_HOME, loadTrustAnchorConfig, resolvePrincipalAllowlist } from './config.js'
import { postMarkedComment } from './forge-write.js'
import { createLogSink, outboxPathFor } from './log-sink.js'
import { packageRoot } from './package-root.js'
import { REVIEW_GATE_CHECK_RUN_NAME } from './review-gate-check-name.js'
import { resolveRepo } from '@attalabs/aeg-forge-state'

// --- forge reads ---------------------------------------------------------

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/**
 * The branch's true head via `git ls-remote` only — `gh pr view
 * headRefOid` is refused by name (Traps to avoid; `#403` moved both gates
 * off it because it can lag a push). Throws, never returns a placeholder,
 * on a genuine resolution failure — a caller with nothing to fall back to
 * should not be handed an empty string.
 */
export function resolveHead(branch: string): string {
  let out: string
  try {
    out = sh('git', ['ls-remote', 'origin', `refs/heads/${branch}`])
  } catch (err) {
    throw new Error(
      `resolveHead: \`git ls-remote origin refs/heads/${branch}\` failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  const sha = out.split(/\s+/)[0] ?? ''
  if (!sha) throw new Error(`resolveHead: branch \`${branch}\` has no head on \`origin\` (empty ls-remote output).`)
  return sha
}

type RestCheckRun = { id: number; name: string; status: string; conclusion: string | null }

/**
 * Every mechanical check-run GitHub reports for `headSha`, deduped to the
 * latest run per name, EXCLUDING `REVIEW_GATE_CHECK_RUN_NAME` — the same
 * exclusion `check-review-gate.ts` already applies to itself, imported from
 * the one shared constant rather than a second hardcoded name
 * (task `#488`, O1, Traps to avoid). Excluded
 * entirely, in every status: a review gate that hasn't posted a verdict yet
 * (no check-run conclusion, or one still `in_progress`) must never read as
 * pending CI either — it is not CI at all. `null` on a genuine fetch
 * failure, read by both callers below as `'pending'` (a transient hiccup
 * reads the same as "not resolved yet", never as red).
 */
function fetchMechanicalCheckRuns(headSha: string): RestCheckRun[] | null {
  let out: string
  try {
    out = sh('gh', [
      'api',
      `repos/{owner}/{repo}/commits/${headSha}/check-runs`,
      '--paginate',
      '--jq',
      '.check_runs[] | {id, name, status, conclusion}'
    ])
  } catch {
    return null
  }
  const runs: RestCheckRun[] = out
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as RestCheckRun)

  const latestByName = new Map<string, RestCheckRun>()
  for (const run of runs) {
    const seen = latestByName.get(run.name)
    if (!seen || run.id > seen.id) latestByName.set(run.name, run)
  }
  return Array.from(latestByName.values()).filter((r) => r.name !== REVIEW_GATE_CHECK_RUN_NAME)
}

/**
 * The mechanical gate's own conclusion for `headSha` — never the review
 * gate's own check-run (excluded by `fetchMechanicalCheckRuns`), so a head
 * with green CI and no verdicts yet reads as green, never red (O1).
 * `'pending'` when any latest-per-name mechanical run has not completed, the
 * fetch fails, or no mechanical check-run exists at all yet — the driver is
 * expected to poll this, not treat one `'pending'` read as final.
 */
export function fetchCiConclusion(headSha: string): 'green' | 'red' | 'pending' {
  const latest = fetchMechanicalCheckRuns(headSha)
  if (latest === null || latest.length === 0) return 'pending'
  if (latest.some((r) => r.status !== 'completed')) return 'pending'
  if (latest.every((r) => r.conclusion === 'success' || r.conclusion === 'neutral' || r.conclusion === 'skipped')) {
    return 'green'
  }
  return 'red'
}

/**
 * The names of every completed, non-passing mechanical check-run for
 * `headSha` — never the review gate's own (same exclusion as
 * `fetchCiConclusion`). Used to tell the developer exactly what to fix (O3)
 * instead of a bare "CI is red." Empty when the fetch fails or nothing has
 * failed yet (a still-`pending` run names nothing — there is nothing to fix
 * until it resolves).
 */
export function fetchFailingCheckNames(headSha: string): string[] {
  const latest = fetchMechanicalCheckRuns(headSha)
  if (latest === null) return []
  return latest
    .filter((r) => r.status === 'completed')
    .filter((r) => r.conclusion !== 'success' && r.conclusion !== 'neutral' && r.conclusion !== 'skipped')
    .map((r) => r.name)
}

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
function markerComments(raw: string): MarkerComment[] {
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
function principalAllowlist(): string[] {
  return resolvePrincipalAllowlist(loadTrustAnchorConfig())
}

/** Pure: every ruling body (after its marker line), from principal-authored comments only — unit-testable with no `gh` call. */
export function filterPrincipalRulings(comments: readonly MarkerComment[], allowlist: readonly string[]): string[] {
  return comments
    .filter((c) => isPrincipal(c.author, allowlist as string[]))
    .filter((c) => RULING_MARKER.test(c.body.split('\n')[0] ?? ''))
    .map((c) => contentAfterOneLine(c.body).trim())
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
        edit: { previous: parsed.previous, now: parsed.now, reason: parsed.reason }
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
  if (text.length === 0) return { text: '', version: null, edit: null }
  const parsedObjectives = objectivesOf(['## Objectives', '', text].join('\n'))
  return { text, version: parsedObjectives.ok ? objectivesVersion(parsedObjectives.objectives) : null, edit: null }
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

/** `task/<tranche>/<n>`, derived from the Issue's own `[<tranche>] <n> — …` title — never guessed or configured separately. */
export function developerBranchFor(issueNumber: number, fetchTitle: (n: number) => string = fetchIssueTitle): string {
  const title = fetchTitle(issueNumber)
  const m = ISSUE_TITLE_SHAPE.exec(title)
  if (!m) {
    throw new Error(
      `developerBranchFor: Issue #${issueNumber}'s title \`${title}\` does not match the \`[<tranche>] <n> — …\` shape — cannot derive the developer's branch.`
    )
  }
  return `task/${m[1]}/${m[2]}`
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

// --- reviewer prompt (facts only) -----------------------------------------

export type ReviewerPromptFacts = {
  objectives: string
  /** `resolveIssueObjectives`'s version for `objectives`, captured at dispatch time — threaded into the held verdict (O2) and re-checked at assessment time (O3). `null` alongside an empty `objectives`. */
  objectivesVersion: string | null
  rulings: string[]
  head: string
  ciConclusion: 'green' | 'red' | 'pending'
  /** The frozen brief's own `**Revision:**` fact (task 4, Issue #483, O2) — `fetchSourceRevision`. */
  revision: string
}

/**
 * Phrasing that would smuggle a conclusion, rather than a fact, into a
 * reviewer's prompt. Facts (objectives text, ruling bodies) are Principal-
 * or Planner-authored prose the driver does not control — this lint exists
 * to catch that prose leaking framing into the rendered prompt, not to
 * police this renderer's own fixed strings (which never use any of these
 * phrases — Section 10: a lint failure here is fixed in the renderer only
 * when the renderer's OWN fixed text is at fault, never by loosening the
 * lint).
 */
const BANNED_FRAMING: readonly RegExp[] = [
  /\bthe developer says\b/i,
  /\baccording to the developer\b/i,
  /\bin my opinion\b/i,
  /\bI think\b/,
  /\bthe pr body says\b/i,
  /\bclearly\b/i
]

/** Non-empty when `rendered` carries banned framing — each entry names the phrase that matched. */
export function lintReviewerPrompt(rendered: string): string[] {
  return BANNED_FRAMING.filter((re) => re.test(rendered)).map((re) => `banned framing matched: ${re.source}`)
}

/** Facts only — no developer-authored text, no PR-body prose (Traps to avoid). */
export function renderReviewerPrompt(facts: ReviewerPromptFacts): string {
  return [
    'OBJECTIVES:',
    facts.objectives.trim() || '(none found on the Issue)',
    '',
    'RULINGS ON THIS PR:',
    facts.rulings.length > 0 ? facts.rulings.map((r, i) => `${i + 1}. ${r}`).join('\n') : '(none)',
    '',
    `HEAD: ${facts.head}`,
    `CI: ${facts.ciConclusion}`,
    `BRIEF REVISION: ${facts.revision}`
  ].join('\n')
}

// --- held-verdict outbox ---------------------------------------------------

/** `join(GLOBAL_VINAYA_HOME, 'outbox')` — the same root `log-sink.ts`'s own `outboxPathFor` resolves, never a second hardcoded path. */
export function outboxRoot(): string {
  return join(GLOBAL_VINAYA_HOME, 'outbox')
}

function heldVerdictPath(root: string, task: number, round: number, role: 'reviewer' | 'security'): string {
  return join(root, 'dev-review-loop', String(task), `round-${round}-${role}.md`)
}

/** One file per verdict: `<outboxRoot>/dev-review-loop/<task>/round-<round>-<role>.md`. Real `fs.writeFileSync`, never `gh pr comment` — the held verdict lives here until publication (`publishRound`, below) posts it. */
export function writeHeldVerdict(
  root: string,
  task: number,
  round: number,
  role: 'reviewer' | 'security',
  renderedComment: string
): void {
  const dir = join(root, 'dev-review-loop', String(task))
  mkdirSync(dir, { recursive: true })
  writeFileSync(heldVerdictPath(root, task, round, role), renderedComment, 'utf8')
}

/**
 * `attempt` 1 is the round's normal work directory (unchanged path, so an
 * existing fixture/fake that never retries keeps working unmodified);
 * `attempt` 2 is a genuinely fresh directory for O2's one retry — never the
 * same directory a failed first attempt already touched, per the loop
 * spec's collect rule (Traps to avoid: never resume a crashed reviewer).
 */
function reviewerWorkDir(
  root: string,
  task: number,
  round: number,
  role: 'reviewer' | 'security',
  attempt = 1
): string {
  const suffix = attempt > 1 ? `-retry${attempt - 1}` : ''
  return join(root, 'dev-review-loop', String(task), `round-${round}-${role}-work${suffix}`)
}

/**
 * O1/O3: `findings.txt` and `report.txt` are always required; `objectives.txt`
 * is required only when the task carries objectives (`hasObjectives`) AND the
 * report is a real verdict rather than an escalation — `buildVerdictFromReport`
 * never reads objectives (or findings) for an `ESCALATE:` report at all
 * (`objectives: []` unconditionally on that path), so a reviewer that
 * deliberately escalates instead of judging objectives has not "written
 * nothing"; requiring `objectives.txt` there would misfile a real,
 * contract-sanctioned escalation as an infrastructure failure. On a task with
 * no `## Objectives` section, `objectives.txt`'s absence is the existing,
 * sanctioned optional case (Traps to avoid: empty is clean, absent is
 * failure — checked by existence here, never by a `readFileSync(...) ?? ''`
 * default that would make a missing file indistinguishable from an empty one).
 */
function missingReviewerArtifacts(workDir: string, hasObjectives: boolean): string[] {
  const missing: string[] = []
  const reportRaw = readIfExists(join(workDir, 'report.txt'))
  if (reportRaw === null) missing.push('report.txt')
  if (!existsSync(join(workDir, 'findings.txt'))) missing.push('findings.txt')
  const isEscalation = reportRaw !== null && parseReport(reportRaw).ESCALATE !== undefined
  if (hasObjectives && !isEscalation && !existsSync(join(workDir, 'objectives.txt'))) missing.push('objectives.txt')
  return missing
}

/**
 * Thrown by `dispatchReviewer` when a role's work directory is still missing
 * a required artifact after its one fresh retry (O2) — caught by the loop
 * and turned into `{ type: 'pause', reason: 'infrastructure' }`, never read
 * as a clean verdict on any path.
 */
export class ReviewerInfrastructureFailure extends Error {
  constructor(
    public readonly role: 'reviewer' | 'security',
    public readonly missing: readonly string[]
  ) {
    super(`${role}'s work directory carried no ${missing.join(' and no ')} after a fresh dispatch and one fresh retry.`)
  }
}

// --- publication (O1) -------------------------------------------------------

type ForgeEffectRecord = { effectId: string; status: 'started' | 'posted'; url?: string }

function forgeEffectPath(root: string, task: number, key: string): string {
  return join(root, 'dev-review-loop', String(task), `effect-${key}.json`)
}

function readForgeEffect(path: string): ForgeEffectRecord | null {
  const raw = readIfExists(path)
  if (!raw) return null
  try {
    return JSON.parse(raw) as ForgeEffectRecord
  } catch {
    return null
  }
}

function writeForgeEffect(path: string, record: ForgeEffectRecord): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(record), 'utf8')
}

/**
 * Posts through `poster` at most once per `key`: an effect id is recorded in
 * the outbox as `started` before `poster` runs, then overwritten as `posted`
 * (with the URL `poster` returned) right after — mirroring `dispatch.ts`'s
 * own effect-id-before/checked-after discipline (its doc comment,
 * `hasOwnDispatchLine`), adapted here to a comment post rather than a
 * process spawn since `DevReviewLoopEvent` carries no `effect_id` field to
 * key on (`hasOwnLoopLine`'s own doc comment, above). A rerun that finds an
 * already-`posted` record returns its recorded URL without calling `poster`
 * again — O1's "nothing is posted twice on a rerun."
 */
function postForgeEffectOnce(root: string, task: number, key: string, poster: () => string): string {
  const path = forgeEffectPath(root, task, key)
  const existing = readForgeEffect(path)
  if (existing?.status === 'posted' && existing.url) return existing.url
  const effectId = existing?.effectId ?? randomUUID()
  writeForgeEffect(path, { effectId, status: 'started' })
  const url = poster()
  writeForgeEffect(path, { effectId, status: 'posted', url })
  return url
}

/**
 * Raw `gh pr comment`, no marker line — deliberately NOT `postMarkedComment`
 * (`./forge-write.js`): that function forces a marker onto line 1, which
 * shifts every line of a rendered verdict down by one and pushes a present
 * `Objectives version:` line outside `extractCodeReviewVerdict`/
 * `extractSecurityReviewVerdict`'s five-line read window
 * (`verdict-extraction.ts`'s own `firstFiveLines`). Same temp-file-then-`gh
 * comment` shape `postMarkedComment` and `review-post.ts`'s own (unexported)
 * `postComment` both use.
 */
function postPrComment(pr: number, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-dev-review-loop-comment-'))
  const tmp = join(dir, 'comment.md')
  writeFileSync(tmp, body, 'utf8')
  try {
    return execFileSync('gh', ['pr', 'comment', String(pr), '--body-file', tmp], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Attributed bodies only — a comment whose author does not resolve as a
 * principal is not evidence that THIS run's own post landed (security
 * review, PR #459: this is the same untrusted-comment class PR #445 closed
 * for `fetchRulings`/`fetchFrozenBrief`, reintroduced here). Reuses
 * `review-post.ts`'s `principalBodies` — the exact filter `checkReviewGate`
 * itself applies before calling either extractor — rather than a second,
 * parallel derivation.
 */
function fetchAllPrCommentBodies(pr: number): string[] {
  const out = sh('gh', ['pr', 'view', String(pr), '--json', 'comments'])
  return principalBodies(markerComments(out), principalAllowlist())
}

export type PublishInput = {
  task: number
  round: number
  prNumber: number
  /** The round's judged head — every posted verdict is expected to bind to this, re-verified after each post. */
  expectedHead: string
  journal: Journal
}

/**
 * O1: at green, posts the two verdicts `writeHeldVerdict` already wrote for
 * `round`, then one summary comment from `renderSummary` — each through
 * `postForgeEffectOnce`'s idempotent forge-write, each re-read afterward
 * through the SAME extractors the merge gate calls (`extractCodeReviewVerdict`/
 * `extractSecurityReviewVerdict`), confirming the posted comment resolves
 * cleanly to `expectedHead`. The summary is checked BEFORE it is posted,
 * never after: `renderSummary`'s own doc comment guarantees no `VERDICT:`/
 * `Judged head:`/`Objectives version:` line, but this is re-verified live
 * against the two real extractors rather than trusted from that comment
 * alone (Traps to avoid) — a summary that parses as a verdict is refused,
 * not posted.
 */
export function publishRound(root: string, input: PublishInput): void {
  const { task, round, prNumber, expectedHead } = input
  const reviewerBody = readIfExists(heldVerdictPath(root, task, round, 'reviewer'))
  const securityBody = readIfExists(heldVerdictPath(root, task, round, 'security'))
  if (!reviewerBody || !securityBody) {
    throw new Error(
      `publishRound: missing held verdict file(s) for task ${task} round ${round} — writeHeldVerdict should have written both before assessRound ever returned 'publish'.`
    )
  }

  postForgeEffectOnce(root, task, `${round}-reviewer-verdict`, () => postPrComment(prNumber, reviewerBody))
  const postedReviewer = extractCodeReviewVerdict(fetchAllPrCommentBodies(prNumber))
  if (postedReviewer.danglingNote || postedReviewer.headSha !== expectedHead) {
    throw new Error(
      `publishRound: posted reviewer verdict does not re-parse clean through extractCodeReviewVerdict bound to ${expectedHead}: ${postedReviewer.danglingNote ?? `headSha read back as ${String(postedReviewer.headSha)}`}`
    )
  }

  postForgeEffectOnce(root, task, `${round}-security-verdict`, () => postPrComment(prNumber, securityBody))
  const postedSecurity = extractSecurityReviewVerdict(fetchAllPrCommentBodies(prNumber))
  if (postedSecurity.danglingNote || postedSecurity.headSha !== expectedHead) {
    throw new Error(
      `publishRound: posted security verdict does not re-parse clean through extractSecurityReviewVerdict bound to ${expectedHead}: ${postedSecurity.danglingNote ?? `headSha read back as ${String(postedSecurity.headSha)}`}`
    )
  }

  const summary = renderSummary(input.journal)
  const summaryAsCodeReview = extractCodeReviewVerdict([summary])
  const summaryAsSecurity = extractSecurityReviewVerdict([summary])
  if (summaryAsCodeReview.danglingNote === null || summaryAsSecurity.danglingNote === null) {
    throw new Error(
      "publishRound: the rendered summary re-parses as a real verdict through the gate's own extractors — refusing to post it (a summary mistaken for a verdict decides a merge)."
    )
  }
  postForgeEffectOnce(root, task, `${round}-summary`, () => postPrComment(prNumber, summary))
}

// --- pause (O2) --------------------------------------------------------------

/** Exactly `<!-- aeg:loop:paused:<reason> -->` — carries no verdict grammar (Traps to avoid). */
function pauseMarker(reason: PauseReason): string {
  return `<!-- aeg:loop:paused:${reason} -->`
}

/**
 * The pause comment's body — the reason and the exact resume command,
 * nothing verdict-shaped. `detail` is set only for `reason: 'infrastructure'`
 * (O2) — the role and missing artifact(s) the driver observed on both
 * dispatch attempts — and is appended to the first line; every other reason
 * carries no detail and renders exactly as before.
 */
export function renderPauseComment(prNumber: number, reason: PauseReason, detail?: string): string {
  return [
    `The dev-review-loop paused: ${reason}${detail ? ` — ${detail}` : ''}.`,
    '',
    'A Principal ruling is needed before this can continue. Once one is posted on this PR, resume with:',
    '',
    '```',
    `vinaya dev-review-loop --resume ${prNumber}`,
    '```'
  ].join('\n')
}

/**
 * Keyed by `round-head`, the pause INSTANCE — not the fixed literal `'pause'`
 * a prior version used, which keyed the idempotency record by task alone
 * (code review, PR #459, BLOCKER): a task pauses, resumes, and pauses again
 * with a resumed loop still at the same `round` but a new `head` (the
 * resumed developer pushes fixes before pausing a second time), so `head`
 * is what tells two real pauses apart. A genuine rerun of the SAME pause —
 * same round, same head, nothing changed — still resolves to the same key
 * and so still posts only once, preserving the original idempotency
 * requirement; only the key changed, not the once-only guarantee.
 */
function postPauseComment(
  root: string,
  task: number,
  round: number,
  head: string,
  prNumber: number,
  reason: PauseReason,
  detail?: string
): void {
  postForgeEffectOnce(root, task, `pause-${round}-${head}`, () =>
    postMarkedComment('pr', String(prNumber), pauseMarker(reason), renderPauseComment(prNumber, reason, detail))
  )
}

type PauseState = {
  task: number
  round: number
  head: string
  branch: string
  prNumber: number
  reason: PauseReason
  detail?: string
  pausedAt: string
}

function pauseStatePath(root: string, task: number): string {
  return join(root, 'dev-review-loop', String(task), 'pause-state.json')
}

function writePauseState(root: string, state: PauseState): void {
  const path = pauseStatePath(root, state.task)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(state), 'utf8')
}

function readPauseState(root: string, task: number): PauseState | null {
  const raw = readIfExists(pauseStatePath(root, task))
  if (!raw) return null
  try {
    return JSON.parse(raw) as PauseState
  } catch {
    return null
  }
}

// --- confidence -------------------------------------------------------------

/**
 * Fixed text, appended to the developer's resume prompt on every round ≥ 2
 * (Part 3). The file path is a fixed, well-known relative convention — the
 * worktree root every Developer already works in
 * (`aeg-root/roles/developer.md`'s own `.worktrees/task/<tranche>/<n>/`) —
 * so this constant needs no per-round interpolation to stay fixed.
 */
export const CONFIDENCE_PROMPT_LINE =
  "Before ending this turn, write your confidence in this round's changes to a file named `.vinaya-confidence` at the root of your worktree, containing exactly one line: `CONFIDENCE: <0-100> — <one-sentence reason>` (a whole number from 0 to 100, an em dash, then your reason in one sentence). This is read by the review loop before it decides the next step — do not skip it."

const CONFIDENCE_LINE = /^CONFIDENCE:\s*(\d{1,3})\s*(?:—|-)\s*(.+)$/m

/** `'absent'` for a missing or malformed reply — never guessed into a number. */
export function parseConfidenceReply(replyText: string): Confidence {
  const m = CONFIDENCE_LINE.exec(replyText)
  if (!m) return 'absent'
  const value = Number(m[1])
  if (!Number.isFinite(value) || value < 0 || value > 100) return 'absent'
  const reason = (m[2] ?? '').trim()
  return reason ? { value, reason } : { value }
}

const CONFIDENCE_FILE_NAME = '.vinaya-confidence'

// --- reviewer report grammar (this task's own design; see PR Decisions) ---

/**
 * A reviewer/security dispatch is instructed to write three files to an
 * absolute, driver-chosen work directory: `findings.txt`
 * (`review-post.ts`'s existing `SEVERITY|file:line|description` grammar),
 * `objectives.txt` (existing `O<n>|MET|evidence` grammar, optional), and
 * `report.txt` — this task's own new `KEY: value` grammar for the
 * remaining prose fields `renderCodeReviewComment`/`renderSecurityComment`
 * need (brief conformance, scope, tests, docs, config scan, secrets), plus
 * an optional `ESCALATE: <class>` / `SUMMARY:` pair. Only `findings.txt`
 * and `objectives.txt` are reused grammars per the brief; `report.txt` is
 * new because neither existing parser covers free-text prose fields.
 */
type ReviewerReport = Record<string, string>

function parseReport(content: string): ReviewerReport {
  const report: ReviewerReport = {}
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const idx = line.indexOf(':')
    if (idx === -1) continue
    report[line.slice(0, idx).trim().toUpperCase()] = line.slice(idx + 1).trim()
  }
  return report
}

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

// --- dispatch plumbing -------------------------------------------------------

function withPromptFile<T>(prompt: string, fn: (promptFile: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-dev-review-loop-prompt-'))
  const promptFile = join(dir, 'prompt.md')
  writeFileSync(promptFile, prompt, 'utf8')
  try {
    return fn(promptFile)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Thrown when a round's resume attempt fails for a vendor whose previous round succeeded — Section 10's own stop-and-escalate, never a fallback to a fresh session. */
export class DevReviewLoopResumeError extends Error {}

// --- deps (injectable; every field defaults to the real implementation) -----

export type LoopDeps = {
  dispatchRole: typeof realDispatchRole
  resolveHead: typeof resolveHead
  fetchCiConclusion: typeof fetchCiConclusion
  /** O3: named check-runs, never the review gate's own (excluded upstream). */
  fetchFailingCheckNames: typeof fetchFailingCheckNames
  fetchRulings: typeof fetchRulings
  fetchFrozenBrief: typeof fetchFrozenBrief
  resolveIssueObjectives: typeof resolveIssueObjectives
  /** O2 (task 4, Issue #483): the frozen brief's own source revision, named to the reviewer as a fact. */
  fetchSourceRevision: typeof fetchSourceRevision
  developerBranchFor: (issueNumber: number) => string
  findOpenPrForBranch: typeof findOpenPrForBranch
  /** O4: the durable session id `dispatch.ts` last recorded for this repo+role+vendor+task, or `null`. */
  readResumeRecord: (
    task: number,
    agent: AgentVendor,
    repo: { owner: string; repo: string } | null
  ) => ResumeRecord | null
  outboxRoot: () => string
  repoRoot: () => string
  gitRevParseOriginMain: () => string
  gitFetch: (sha: string) => void
  gitDiffShortstat: (base: string, head: string) => string
  flushOutbox: (task: number) => void
  sleep: (ms: number) => Promise<void>
  now: () => number
  prPollMaxAttempts: number
  prPollIntervalMs: number
  gatePollMaxAttempts: number
  gatePollIntervalMs: number
}

function defaultRepoRoot(): string {
  return sh('git', ['rev-parse', '--show-toplevel'])
}

function defaultGitRevParseOriginMain(): string {
  return sh('git', ['rev-parse', 'origin/main'])
}

function defaultGitFetch(sha: string): void {
  try {
    execFileSync('git', ['fetch', '--quiet', 'origin', sha], { stdio: ['ignore', 'ignore', 'ignore'] })
  } catch {
    // Non-fatal — the object may already be local; the diff below is the real test.
  }
}

function defaultGitDiffShortstat(base: string, head: string): string {
  try {
    return sh('git', ['diff', `${base}...${head}`, '--shortstat'])
  } catch {
    return ''
  }
}

/**
 * Spawns `vinaya log flush --issue <task>` as a SUBPROCESS rather than
 * importing `logFlushCommand` and calling it in-process. `logFlushCommand`
 * calls `process.exit()` directly on its own terminal paths (`0` for
 * "nothing to flush", `2` for a refusal) — calling that in-process inside
 * this driver's long-running, multi-round loop would kill the whole
 * `dev-review-loop` process on the very first such edge case, abandoning
 * every round still to come. A subprocess boundary contains that exit to
 * the child; a non-zero child exit is logged to stderr and never fatal to
 * the loop (flush failures don't undo a dispatch's own already-durable
 * outbox lines — `dispatch.ts`'s own doc comment).
 */
function defaultFlushOutbox(task: number): void {
  try {
    const cliEntry = join(packageRoot(import.meta.url), 'src', 'index.ts')
    execFileSync('bun', [cliEntry, 'log', 'flush', '--issue', String(task)], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    process.stderr.write(
      `vinaya dev-review-loop: round-end flush failed (non-fatal, lines stay in the outbox for a later flush): ${
        err instanceof Error ? err.message : String(err)
      }\n`
    )
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * The gate poll budget is otherwise a fixed production constant (120 ×
 * 15s) — this env var pair exists only so a real subprocess test (never an
 * in-process call — see this file's test's own `GLOBAL_VINAYA_HOME`
 * contamination warning) can exercise O2's head-change-wait/bounded-stall
 * path in test time instead of the ~30 real minutes the production budget
 * would otherwise take. Unset in every real invocation, so production
 * behavior is unchanged.
 */
function gatePollEnvOverride(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function defaultDeps(): LoopDeps {
  return {
    dispatchRole: realDispatchRole,
    resolveHead,
    fetchCiConclusion,
    fetchFailingCheckNames,
    fetchRulings,
    fetchFrozenBrief,
    resolveIssueObjectives,
    fetchSourceRevision,
    developerBranchFor: (n) => developerBranchFor(n),
    findOpenPrForBranch,
    readResumeRecord: (task, agent, repo) => realReadResumeRecord('developer', agent, repo, task),
    outboxRoot,
    repoRoot: defaultRepoRoot,
    gitRevParseOriginMain: defaultGitRevParseOriginMain,
    gitFetch: defaultGitFetch,
    gitDiffShortstat: defaultGitDiffShortstat,
    flushOutbox: defaultFlushOutbox,
    sleep: defaultSleep,
    now: () => Date.now(),
    prPollMaxAttempts: 120,
    prPollIntervalMs: 15_000,
    gatePollMaxAttempts: gatePollEnvOverride('VINAYA_DEV_REVIEW_LOOP_GATE_POLL_MAX_ATTEMPTS', 120),
    gatePollIntervalMs: gatePollEnvOverride('VINAYA_DEV_REVIEW_LOOP_GATE_POLL_INTERVAL_MS', 15_000)
  }
}

// --- the loop -----------------------------------------------------------------

export type LoopInput = { agent: AgentVendor } & ({ task: number } | { resumePr: number })
export type LoopResult = { finalDecision: Decision; prNumber: number; task: number }

function parseShortstat(stat: string): { filesChanged: number; insertions: number; deletions: number } {
  const m = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(stat)
  if (!m) return { filesChanged: 0, insertions: 0, deletions: 0 }
  return { filesChanged: Number(m[1] ?? 0), insertions: Number(m[2] ?? 0), deletions: Number(m[3] ?? 0) }
}

async function assertDispatchOrEscalate(
  handle: DispatchHandle,
  vendor: AgentVendor,
  isResume: boolean,
  previousRoundSucceededForVendor: boolean
): Promise<void> {
  if (!handle.failureReason) return
  if (isResume && previousRoundSucceededForVendor) {
    throw new DevReviewLoopResumeError(
      `devReviewLoop: ${vendor}'s resume failed this round (${handle.failureReason}) after succeeding last round — ` +
        `stop-and-escalate severity:product, vendor: ${vendor}. Never falling back to a fresh developer session (Principal ruling, 2026-09-04).`
    )
  }
  throw new Error(`devReviewLoop: dispatching ${vendor} failed (${handle.failureReason}).`)
}

async function pollUntil<T>(
  fn: () => T | null,
  maxAttempts: number,
  intervalMs: number,
  sleep: (ms: number) => Promise<void>,
  timeoutMessage: string
): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = fn()
    if (result !== null) return result
    await sleep(intervalMs)
  }
  throw new Error(timeoutMessage)
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const aKeys = Object.keys(a as Record<string, unknown>)
  const bKeys = Object.keys(b as Record<string, unknown>)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

function sizeOfSafe(path: string): number {
  try {
    return readFileSync(path).byteLength
  } catch {
    return 0
  }
}

/**
 * True when a line APPENDED SINCE `priorSize` (never the whole file — a
 * prior round can log the identical shape, e.g. another `round_started`)
 * carries `meta.run_id === runId` and, stripped of `meta`/`subject`, deep-
 * equals `event`. Mirrors `dispatch.ts`'s private `hasOwnDispatchLine`,
 * matched on the event's own shape instead of an `effect_id` — `DevReviewLoopEvent`
 * carries none.
 */
function hasOwnLoopLine(path: string, priorSize: number, runId: string, event: DevReviewLoopEventInput): boolean {
  let buf: Buffer
  try {
    buf = readFileSync(path)
  } catch {
    return false
  }
  if (buf.byteLength <= priorSize) return false
  for (const raw of buf.subarray(priorSize).toString('utf8').split('\n')) {
    if (!raw) continue
    try {
      const obj = JSON.parse(raw) as { meta?: { run_id?: unknown }; [k: string]: unknown }
      if (obj.meta?.run_id !== runId) continue
      const { meta: _meta, subject: _subject, ...rest } = obj
      if (deepEqual(rest, event)) return true
    } catch {
      // not a JSON line — never trusted blindly
    }
  }
  return false
}

/**
 * `log()` is fire-and-forget (`log-sink.ts`'s own `.then()` chain, no
 * returned promise) — a caller that fires the next `log()` call right after
 * can race a still-pending write, exactly `dispatch.ts`'s own
 * `waitForDispatchLine` doc comment describes for its equivalent hazard, and
 * this driver logs SEVERAL events per round, back to back. Not merely
 * theoretical: observed live authoring this task, two `log()` calls in the
 * same synchronous loop landed OUT OF ORDER in the outbox — `resolveRepo()`
 * only caches a DETERMINISTIC outcome (`resolve-repo.ts`'s own doc comment);
 * on an unresolvable repo (this task's own test fixtures; no git remote) it
 * caches NOTHING, so every `log()` call races an independent, uncached async
 * resolution. Waiting for a raw line COUNT to reach N after firing N calls
 * does not fix this — it can be satisfied by N lines in the WRONG order.
 * `logEvents` (below) awaits THIS, per event, before firing the next
 * `log()` call, so no two of this driver's own writes are ever in flight at
 * once — order follows call order because nothing races.
 */
async function waitForOwnLoopLine(
  path: string,
  priorSize: number,
  runId: string,
  event: DevReviewLoopEventInput,
  sleep: (ms: number) => Promise<void>,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (hasOwnLoopLine(path, priorSize, runId, event)) return
    await sleep(5)
  }
  // Best-effort durability wait, not a correctness gate — `log()` itself
  // never throws, and a timeout here is already `log()`'s own silently-
  // warned failure mode (an unwritable outbox, an unresolvable repo, or a
  // schema violation `log()` refused and warned about instead of writing).
}

type RoundVerdictParse = { observation: VerdictObservation; rendered: string }

function buildVerdictFromReport(
  role: 'reviewer' | 'security',
  workDir: string,
  headSha: string,
  agent: AgentVendor,
  taskId: number,
  handle: DispatchHandle,
  objectivesVersionAtDispatch: string | null
): RoundVerdictParse {
  const reportRaw = readIfExists(join(workDir, 'report.txt')) ?? ''
  const report = parseReport(reportRaw)
  const sessionId = handle.resumeId ?? '(unknown)'
  const tokensIn = handle.usage ? String(handle.usage.input) : '—'
  const tokensOut = handle.usage ? String(handle.usage.output) : '—'
  const roleLabel = role === 'reviewer' ? ('Reviewer' as const) : ('Security' as const)

  const escalateClass = report.ESCALATE
  if (escalateClass !== undefined) {
    if (!isEscalationClass(escalateClass)) {
      throw new Error(
        `devReviewLoop: ${role}'s report.txt carries \`ESCALATE: ${escalateClass}\`, not one of authority|strategy|product.`
      )
    }
    const rendered = renderEscalationComment({
      headSha,
      escalationClass: escalateClass as EscalationClass,
      summary: report.SUMMARY ?? '(no summary given)',
      role: role === 'reviewer' ? 'review' : 'security',
      roleLabel,
      objectivesVersion: objectivesVersionAtDispatch,
      taskId: String(taskId),
      model: agent,
      tokensIn,
      tokensOut,
      cost: '—',
      sessionId
    })
    return { observation: { role, verdict: 'ESCALATE', objectives: [], findings: [] }, rendered }
  }

  const findingsRaw = readIfExists(join(workDir, 'findings.txt')) ?? ''
  const allowedSeverities =
    role === 'reviewer' ? (['BLOCKER', 'MAJOR', 'MINOR'] as const) : (['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const)
  const findings: Finding[] = findingsRaw.trim() ? parseFindingsFile(findingsRaw, allowedSeverities) : []

  const objectivesRaw = readIfExists(join(workDir, 'objectives.txt'))
  const objectiveResults = objectivesRaw?.trim() ? parseObjectivesFile(objectivesRaw) : []
  const objectives = objectiveResults.map((o) => ({ id: o.id, met: o.status === 'MET' }))
  // O2: a version renders alongside its `OBJECTIVES:` block, or neither
  // renders — `review-post.ts`'s `CodeReviewInput`/`SecurityInput` contract
  // (`objectiveResults` non-null iff `objectivesVersion` non-null).
  const renderedObjectiveResults = objectivesVersionAtDispatch !== null ? objectiveResults : null

  const findingObservations = findings.map((f, i) => ({ id: `F${i + 1}`, severity: f.severity, state: null }))

  if (role === 'reviewer') {
    const verdict = deriveCodeReviewVerdict(findings)
    const rendered = renderCodeReviewComment({
      headSha,
      verdict,
      briefConformance: report.BRIEF_CONFORMANCE ?? '(not reported)',
      specConformance: report.SPEC_CONFORMANCE ?? '(not reported)',
      findings,
      scope: report.SCOPE ?? '(not reported)',
      scopeEvidence: null,
      tests: report.TESTS ?? '(not reported)',
      docs: report.DOCS ?? '(not reported)',
      objectivesVersion: objectivesVersionAtDispatch,
      objectiveResults: renderedObjectiveResults,
      taskId: String(taskId),
      model: agent,
      tokensIn,
      tokensOut,
      cost: '—',
      sessionId
    })
    return {
      observation: {
        role,
        verdict: verdict === 'APPROVE' ? 'APPROVE' : 'REQUEST CHANGES',
        objectives,
        findings: findingObservations
      },
      rendered
    }
  }

  const verdict = deriveSecurityVerdict(findings)
  const rendered = renderSecurityComment({
    headSha,
    verdict,
    findings,
    configScan: report.CONFIG_SCAN ?? '(not reported)',
    secrets: report.SECRETS ?? 'none found',
    secretsEvidence: null,
    objectivesVersion: objectivesVersionAtDispatch,
    objectiveResults: renderedObjectiveResults,
    taskId: String(taskId),
    model: agent,
    tokensIn,
    tokensOut,
    cost: '—',
    sessionId
  })
  return { observation: { role, verdict, objectives, findings: findingObservations }, rendered }
}

/** Whether `facts.objectives` (the Issue's `## Objectives` section text, O3) carries anything at all. */
function hasObjectivesFacts(facts: ReviewerPromptFacts): boolean {
  return facts.objectives.trim().length > 0
}

function renderReviewerDispatchPrompt(
  role: 'reviewer' | 'security',
  facts: ReviewerPromptFacts,
  workDir: string
): string {
  const base = renderReviewerPrompt(facts)
  const lint = lintReviewerPrompt(base)
  if (lint.length > 0) {
    throw new Error(
      `devReviewLoop: renderReviewerPrompt produced banned framing: ${lint.join('; ')} — fix the renderer, never the lint.`
    )
  }
  const roleLine =
    role === 'reviewer' ? 'You are the code-reviewer for this round.' : 'You are the security reviewer for this round.'
  const instructions = [
    roleLine,
    'Review the PR at the HEAD above against the OBJECTIVES and RULINGS above.',
    `Write your findings to ${join(workDir, 'findings.txt')}, one per line: SEVERITY|file:line|description`,
    role === 'reviewer'
      ? '(severities: BLOCKER, MAJOR, MINOR — leave the file empty if there are none).'
      : '(severities: CRITICAL, HIGH, MEDIUM, LOW — leave the file empty if there are none).',
    ...(hasObjectivesFacts(facts)
      ? [
          `Write one line per objective listed above to ${join(workDir, 'objectives.txt')}: O<n>|MET|<evidence> or O<n>|NOT MET|<evidence>.`
        ]
      : []),
    `Write a short report to ${join(workDir, 'report.txt')} as one \`KEY: value\` line per field:`,
    role === 'reviewer' ? '  BRIEF_CONFORMANCE, SPEC_CONFORMANCE, SCOPE, TESTS, DOCS' : '  CONFIG_SCAN, SECRETS',
    'To escalate instead of casting a verdict, write only `ESCALATE: authority|strategy|product` and `SUMMARY: <text>` to report.txt.'
  ].join('\n')
  return `${base}\n\n${instructions}`
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

function fetchPrBody(pr: number): string {
  const out = sh('gh', ['pr', 'view', String(pr), '--json', 'body'])
  return (JSON.parse(out) as { body: string }).body
}

/**
 * Splits an `assessRound` result's events into what logs immediately and
 * what waits for `publishRound` to actually succeed. Only a `publish`
 * decision (`assess-round.ts`'s `merged_ready` site) has a real publish step
 * worth waiting on — a crash between the verdict posts and the summary post
 * must not leave the durable log claiming a run that never finished. Every
 * OTHER decision that carries a `journal_finalized` event — the two
 * confidence-pause sites in `assessGate`, and `reappearance`/`no_progress`/
 * `max_rounds` in `assessVerdicts` — already IS the run's completed outcome
 * the moment `assessRound` returns it: there is no later confirmation step
 * for those to wait on, so their `journal_finalized` logs immediately, same
 * as every other event that round produced.
 *
 * Regression (PR #459, MAJOR): the prior fix filtered `journal_finalized`
 * out of every `dispatch_reviewers`-branch call regardless of decision type,
 * and only the `publish` branch ever flushed the held-back copy — so a
 * `pause` decision's completion event was captured into
 * `pendingCompletionEvents` and then never logged, permanently, on every
 * successful pause. This function makes the one case that legitimately
 * defers explicit, rather than an unconditional filter two branches away
 * from the only code that un-defers it.
 */
export function routeCompletionEvents(
  events: readonly DevReviewLoopEventInput[],
  decisionType: Decision['type']
): { toLogNow: DevReviewLoopEventInput[]; toDeferUntilPublish: DevReviewLoopEventInput[] } {
  if (decisionType !== 'publish') return { toLogNow: [...events], toDeferUntilPublish: [] }
  return {
    toLogNow: events.filter((e) => e.event !== 'journal_finalized'),
    toDeferUntilPublish: events.filter((e) => e.event === 'journal_finalized')
  }
}

/**
 * Task `#488`, O2: the bound on consecutive
 * gate-red developer turns that produce no push on one head — small and
 * strict, since the failure mode this bounds (`#479`: five re-dispatches in
 * two minutes on one head) is a developer making no progress at all, not
 * one that needs several genuine attempts. Driver-owned rather than a
 * `packages/aeg-core` constant: this task's own Surface (Issue #488 §4)
 * declares `packages` out of scope.
 */
const MAX_GATE_STALLED_TURNS = 2

/**
 * `stop_condition_met`/`paused`/`round_ended`/`journal_finalized` for a
 * pause the DRIVER decides itself — O2's gate-stalled bound and O5's
 * reviewer-infrastructure failure, neither of which corresponds to an
 * `Observations` kind `assessRound` accepts (adding one would edit
 * `packages/aeg-core`, out of this task's declared Surface, Issue #488 §4;
 * `Decision`/`PauseReason` themselves are unchanged). Reuses
 * `stop_condition_met`'s existing, otherwise-unused `'principal_stop'`
 * condition and `paused`'s existing generic `'principal_item'` reason —
 * the SAME schema enum members every policy-decided bounded pause already
 * reuses for confidence/reappearance/no_progress/max_rounds — never a new
 * schema value, so these events validate and land in the outbox exactly
 * like a policy-decided pause's do (regression, PR #489 round 2, MAJOR:
 * this pause used to skip the log entirely). `state` is read only for its
 * running totals; it is never written back, since the loop returns
 * immediately after this — a resume starts a fresh `LoopState` regardless
 * (`initialLoopState`, called fresh in the `--resume` path above).
 */
function driverDecidedPauseEvents(
  loopId: string,
  state: LoopState,
  round: number,
  stats: RoundStats
): DevReviewLoopEventInput[] {
  const envelope = { kind: 'dev_review_loop' as const, payload: {} }
  return [
    { ...envelope, loop_id: loopId, event: 'stop_condition_met', round, condition: 'principal_stop' },
    { ...envelope, loop_id: loopId, event: 'paused', round, reason: 'principal_item' },
    {
      ...envelope,
      loop_id: loopId,
      event: 'round_ended',
      round,
      base_head: stats.baseHead,
      head: stats.head,
      files_changed: stats.filesChanged,
      insertions: stats.insertions,
      deletions: stats.deletions,
      wall_ms: stats.wallMs,
      outcome: 'changes_requested'
    },
    {
      ...envelope,
      loop_id: loopId,
      event: 'journal_finalized',
      rounds: state.rounds.length + 1,
      total_wall_ms: state.totalWallMs + stats.wallMs,
      time_to_green_ms: null,
      files_changed_total: state.totalFilesChanged + stats.filesChanged,
      final_head: stats.head,
      result: 'stopped'
    }
  ]
}

export async function devReviewLoop(input: LoopInput, deps: Partial<LoopDeps> = {}): Promise<LoopResult> {
  const d: LoopDeps = { ...defaultDeps(), ...deps }
  const root = d.outboxRoot()

  let task: number
  let branch: string
  let prNumber = -1 // resolved below, before any use — never read while -1
  let resumeFrom: PauseState | null = null

  if ('resumePr' in input) {
    const resumePr = input.resumePr
    const closesTask = taskFromPrBody(fetchPrBody(resumePr))
    if (closesTask === null) {
      throw new Error(
        `devReviewLoop --resume: PR #${resumePr}'s body carries no \`Closes #N\` reference — cannot derive its task.`
      )
    }
    const held = readPauseState(root, closesTask)
    if (!held) {
      throw new Error(
        `devReviewLoop --resume: no held pause state found for task ${closesTask} (PR #${resumePr}) — nothing to resume.`
      )
    }
    if (held.prNumber !== resumePr) {
      throw new Error(
        `devReviewLoop --resume: task ${closesTask}'s held pause state names PR #${held.prNumber}, not PR #${resumePr}.`
      )
    }
    const rulings = d.fetchRulings(resumePr)
    if (rulings.length === 0) {
      throw new Error(
        `devReviewLoop --resume: PR #${resumePr} carries no Principal ruling comment yet — nothing to resume from.`
      )
    }
    const currentHead = d.resolveHead(held.branch)
    if (currentHead !== held.head) {
      throw new Error(
        `devReviewLoop --resume: PR #${resumePr}'s head has moved since it paused (paused at ${held.head}, now ${currentHead}) — restart from round ${held.round} against the new head; resume never silently replays from round 1.`
      )
    }
    task = held.task
    branch = held.branch
    prNumber = held.prNumber
    resumeFrom = held
  } else {
    task = input.task
    branch = d.developerBranchFor(task)
  }

  const { log, runId } = createLogSink()
  if (!process.env.VINAYA_RUN_ID) process.env.VINAYA_RUN_ID = runId
  // `buildHeader` derives `subject.issue` (and thus the outbox file this
  // loop's OWN `log()` calls land in) purely from `env.VINAYA_TASK`
  // (`envelope.ts`'s `issueFromTask`) — never self-declared. `dispatchRole`
  // sets it on each CHILD's env already; this driver's own top-level events
  // (`loop_started`, `round_started`, …) need it on THIS process's env too,
  // or they land under the `none` bucket instead of this task's.
  process.env.VINAYA_TASK = String(task)

  // Primes `resolveRepo()`'s process-lifetime cache BEFORE this loop's own
  // `log()` calls start racing each other on it (see `waitForLoopLineCount`'s
  // doc comment) — every later call in this process, including the ones
  // inside `log()` itself, resolves the identical value instantly.
  const repo = await resolveRepo().catch(() => null)
  const repoRoot = d.repoRoot()
  const confidenceFilePath = join(repoRoot, '.worktrees', branch, CONFIDENCE_FILE_NAME)
  const loopOutboxPath = outboxPathFor({ outboxRoot: () => root }, repo, task)
  /**
   * Awaits EACH event's own landing before firing the next `log()` call —
   * not just the batch's last one. `resolveRepo()` only caches a
   * DETERMINISTIC outcome (a parsed `AEG_REPO`, or a successful git-remote
   * lookup); on an unresolvable repo (no remote, or the lookup itself
   * throws) it caches nothing (`resolve-repo.ts`'s own doc comment) — every
   * `log()` call in that case races an independent, uncached async
   * resolution, and two calls fired back-to-back can land out of order
   * (observed live: `gate_result_read` beat `round_started` to the file).
   * Sequencing each write removes the race outright rather than merely
   * waiting for the LAST one and hoping the rest arrived in order.
   */
  async function logEvents(events: readonly DevReviewLoopEventInput[]): Promise<void> {
    for (const e of events) {
      const priorSize = sizeOfSafe(loopOutboxPath)
      log(e)
      await waitForOwnLoopLine(loopOutboxPath, priorSize, runId, e, d.sleep)
    }
  }

  const config: LoopConfig = {
    loopId: randomUUID(),
    task: task,
    // `loop_started`'s own schema constrains `policy.reviewers`/`policy.models`
    // keys to `RoleSchema` (`schema.ts`) — the DOCTRINE role vocabulary
    // (`code-reviewer`), not `VerdictObservation.role`'s separate
    // `'reviewer' | 'security'` vocabulary this driver uses everywhere else
    // for the policy's own findings/verdict shape. Using `'reviewer'` here
    // fails schema validation silently (`log()` never throws — `loop_started`
    // just never lands in the outbox; found live authoring this task).
    reviewers: ['code-reviewer', 'security'],
    models: { developer: input.agent, 'code-reviewer': input.agent, security: input.agent }
  }
  let state: LoopState = initialLoopState(config)

  let round = resumeFrom ? resumeFrom.round : 1
  let devResumeId: string | null = null
  let devDispatchSucceededBefore = false
  let lastReviewContext: string | null = null
  let resumedDispatch = resumeFrom !== null
  /** O3: the last red gate's failing check-run names, for the next gate-red dispatch prompt and, if it stalls, the pause detail. */
  let lastFailingChecks: string[] = []
  /** O2: true iff the current `dispatch_developer` decision came from a red gate (never inferred from `decision` itself — see this branch's own comment, below). Reset to `false` by every genuine `gate` observation. */
  let pendingGateRedRetry = false
  /** O2: consecutive gate-red developer turns that produced no push on one head — reset to 0 by every genuine `gate` observation. */
  let gateStalledStreak = 0

  async function dispatchDeveloper(prompt: string, roundNum: number): Promise<DispatchHandle> {
    const isResume = devResumeId !== null
    const handle = await withPromptFile(prompt, (promptFile) =>
      d.dispatchRole('developer', input.agent, prompt, {
        task: task,
        round: roundNum,
        resumeId: devResumeId ?? undefined,
        promptFile
      })
    )
    await assertDispatchOrEscalate(handle, input.agent, isResume, devDispatchSucceededBefore)
    if (!handle.failureReason) {
      devDispatchSucceededBefore = true
      if (handle.resumeId) devResumeId = handle.resumeId
    }
    return handle
  }

  /**
   * O1/O2: a dispatch whose work directory is still missing a required
   * artifact is an infrastructure outcome, never a clean verdict — retried
   * once with a fresh dispatch into a fresh work directory (`attempt` 2,
   * never the first attempt's own directory); a second miss throws
   * `ReviewerInfrastructureFailure`, which the caller turns into a pause
   * rather than a held or published verdict for this round.
   *
   * Deliberately does NOT call `writeHeldVerdict` itself (round 1 review
   * finding, BLOCKER, PR #489): both roles run inside one `Promise.all` in
   * the caller, so a role that finishes clean can resolve before its
   * sibling's own retry exhausts and throws — writing the held verdict file
   * here would leave one on disk for a round that pauses as infrastructure,
   * violating O2's "nothing is held … for that round" the moment the two
   * roles finish in that order. The caller writes both held verdicts only
   * after `Promise.all` itself resolves — i.e. only once it knows neither
   * role failed.
   */
  async function dispatchReviewer(
    role: 'reviewer' | 'security',
    roundNum: number,
    facts: ReviewerPromptFacts
  ): Promise<RoundVerdictParse> {
    const hasObjectives = hasObjectivesFacts(facts)
    const dispatchRoleName = role === 'reviewer' ? ('code-reviewer' as const) : ('security' as const)
    let lastMissing: string[] = []
    for (let attempt = 1; attempt <= 2; attempt++) {
      const workDir = reviewerWorkDir(root, task, roundNum, role, attempt)
      mkdirSync(workDir, { recursive: true })
      const prompt = renderReviewerDispatchPrompt(role, facts, workDir)
      const handle = await withPromptFile(prompt, (promptFile) =>
        d.dispatchRole(dispatchRoleName, input.agent, prompt, { task: task, round: roundNum, promptFile })
      )
      await assertDispatchOrEscalate(handle, input.agent, false, false)
      const missing = missingReviewerArtifacts(workDir, hasObjectives)
      if (missing.length > 0) {
        lastMissing = missing
        continue
      }
      return buildVerdictFromReport(role, workDir, facts.head, input.agent, task, handle, facts.objectivesVersion)
    }
    throw new ReviewerInfrastructureFailure(role, lastMissing)
  }

  function computeStats(head: string, roundStartMs: number): RoundStats {
    const baseHead = d.gitRevParseOriginMain()
    d.gitFetch(head)
    const { filesChanged, insertions, deletions } = parseShortstat(d.gitDiffShortstat(baseHead, head))
    return { baseHead, head, filesChanged, insertions, deletions, wallMs: d.now() - roundStartMs }
  }

  async function waitForGreenGate(roundStartMs: number): Promise<{
    green: boolean
    stats: RoundStats
    ciConclusion: 'green' | 'red' | 'pending'
    /** O3: the mechanical check-runs that actually failed, never the review gate's own — empty unless `ciConclusion === 'red'`. */
    failingChecks: string[]
  }> {
    const head = d.resolveHead(branch)
    const conclusion = await pollUntil(
      () => {
        const c = d.fetchCiConclusion(head)
        return c === 'pending' ? null : c
      },
      d.gatePollMaxAttempts,
      d.gatePollIntervalMs,
      d.sleep,
      `devReviewLoop: CI never resolved off 'pending' for head ${head} within the poll budget.`
    ).catch(() => 'red' as const)
    const failingChecks = conclusion === 'red' ? d.fetchFailingCheckNames(head) : []
    return {
      green: conclusion === 'green',
      stats: computeStats(head, roundStartMs),
      ciConclusion: conclusion,
      failingChecks
    }
  }

  function readAndClearConfidence(): Confidence {
    const content = readIfExists(confidenceFilePath)
    try {
      unlinkSync(confidenceFilePath)
    } catch {
      // Never written, or already gone — nothing to clean up.
    }
    return content ? parseConfidenceReply(content) : 'absent'
  }

  let roundStartMs = d.now()
  if (resumeFrom) {
    // O2: resuming — the PR and branch are already known (`resumeFrom`), so
    // there is no round-1 dispatch and no PR to poll for. `lastReviewContext`
    // carries the Principal's ruling(s) instead of a reviewer's findings;
    // `resumedDispatch` (below) labels the prompt accordingly, once.
    const rulings = d.fetchRulings(prNumber)
    lastReviewContext = rulings.map((r, i) => `${i + 1}. ${r}`).join('\n')
  } else {
    // O4: round-1 entry — attach to an existing open PR, resume once to open
    // one on a remote branch that has none, or dispatch fresh. Checked in
    // that order: an open PR on the exact branch `developerBranchFor`
    // derives is the strongest signal (Traps: never attach to a closed or
    // merged one — `findOpenPrForBranch`'s own `--state open` filter already
    // guarantees that); only then does a remote-branch-with-no-PR check make
    // sense, since a branch with an open PR obviously also exists remotely.
    const existingPr = d.findOpenPrForBranch(branch)
    if (existingPr) {
      // Attach: no developer dispatch here at all — the recorded session is
      // read now so a LATER round's resume (if one is ever needed) resumes
      // the SAME session rather than starting fresh; round 1's own gate runs
      // next, unmodified, straight off `firstPass`.
      prNumber = existingPr.number
      const rec = d.readResumeRecord(task, input.agent, repo)
      if (rec) devResumeId = rec.resumeId
    } else {
      let branchExists = true
      try {
        d.resolveHead(branch)
      } catch {
        branchExists = false
      }
      if (branchExists) {
        // Remote branch, no open PR yet: resume the recorded developer
        // session ONCE, instructed to open the PR through the validated
        // path, and wait for it — never a fresh developer (Traps).
        const rec = d.readResumeRecord(task, input.agent, repo)
        if (rec) devResumeId = rec.resumeId
        const openPrPrompt = [
          'This branch already exists with no open pull request for it.',
          'Open the pull request through the validated path per aeg-root/roles/developer.md:',
          '`bun apps/cli/src/index.ts pr create --body-file <path> --title "<title>"`.'
        ].join('\n\n')
        await dispatchDeveloper(openPrPrompt, round)
        prNumber = await pollUntil(
          () => d.findOpenPrForBranch(branch),
          d.prPollMaxAttempts,
          d.prPollIntervalMs,
          d.sleep,
          `devReviewLoop: no open PR appeared for branch \`${branch}\` within the poll budget after resuming to open one.`
        ).then((pr) => pr.number)
      } else {
        // Round 1: fresh dispatch, brief read from the frozen Issue comment (O1).
        const brief = d.fetchFrozenBrief(task)
        await dispatchDeveloper(brief, round)

        prNumber = await pollUntil(
          () => d.findOpenPrForBranch(branch),
          d.prPollMaxAttempts,
          d.prPollIntervalMs,
          d.sleep,
          `devReviewLoop: no open PR appeared for branch \`${branch}\` within the poll budget.`
        ).then((pr) => pr.number)
      }
    }
  }

  let decision: Decision = { type: 'dispatch_developer' }
  let firstPass = !resumeFrom
  // Held back from `logEvents` until `publishRound` (below) actually
  // succeeds — `assessRound`'s one `journal_finalized`/`merged_ready` event
  // (`assess-round.ts`) always arrives bundled with a `publish` decision in
  // the SAME `result.events`, and logging it immediately, before the posts
  // it claims are done, is what let a crash mid-publish leave the durable
  // log asserting a completion the pull request never got (code review, PR
  // #459, MAJOR). Every other event in that same `result.events` — the
  // round's own `stop_condition_met`/`round_ended` — is true regardless of
  // whether publication later fails, so only this one event is deferred.
  let pendingCompletionEvents: DevReviewLoopEventInput[] = []

  /**
   * Round-number discipline: `round` increments ONLY when a genuine review
   * round (`dispatch_reviewers` → `verdicts`) concludes `changes_requested`
   * and hands back `dispatch_developer` for the next real round. A
   * mechanical-gate-red retry and a confidence-collapse "extra turn" (spec
   * §6.7: "may repeat once, for the same round") both resubmit the SAME
   * round number — `assessGate` itself is built for exactly this (`pending`
   * clears on both paths, and `state.extraTurnUsed` is a flat, round-
   * independent flag, so reusing the round number changes nothing about
   * whether the confidence rule's one-extra-turn bound is honored).
   * Advancing `round` on every `dispatch_developer` instead would make a
   * mechanical CI hiccup on round 1 silently start asking the round-1-never-
   * asks confidence question — a real behavioral bug, not a style choice.
   */
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (decision.type === 'dispatch_developer') {
      // O2: `pendingGateRedRetry` (set below, at this round's own two `gate`
      // observation call sites — never inferred from `decision` itself,
      // since `assessGate`'s red branch returns a bare `dispatch_developer`
      // with no reason tag: `Decision`/`PauseReason` live in
      // `packages/aeg-core`, out of this task's declared Surface, Issue
      // #488 §4) is true exactly when THIS dispatch is the driver sending
      // the developer back for a red mechanical gate — the one case that
      // needs the head-change wait (Traps: never re-read the gate in a
      // tight loop on an unchanged head — `#479`'s own five-re-dispatches-
      // in-two-minutes failure).
      const isGateRedRetry = pendingGateRedRetry
      if (!firstPass) {
        const prompt = [
          resumedDispatch
            ? `Principal ruling on this pause:\n\n${lastReviewContext}\n`
            : isGateRedRetry
              ? `CI is red on the last head. Failing check-run(s): ${
                  lastFailingChecks.length > 0 ? lastFailingChecks.join(', ') : '(unknown)'
                }. Fix and push.`
              : // `isGateRedRetry` is false here only when this dispatch came from
                // `assessVerdicts`' review-findings fallback, which requires
                // `dispatch_reviewers` to have already run and set `lastReviewContext`
                // — so it is never null in this branch (code review, round 1, MINOR:
                // the prior 'CI was red...' fallback below this was unreachable).
                `Round ${round} review findings:\n\n${lastReviewContext}\n`,
          'Address the findings above per aeg-root/roles/developer.md. Push fixes as new commits on the SAME branch; do not open a new PR.',
          round >= 2 ? CONFIDENCE_PROMPT_LINE : ''
        ]
          .filter(Boolean)
          .join('\n\n')
        const headBeforeDispatch = isGateRedRetry ? d.resolveHead(branch) : null
        roundStartMs = d.now()
        await dispatchDeveloper(prompt, round)
        resumedDispatch = false

        if (headBeforeDispatch !== null) {
          const changedHead = await pollUntil(
            () => {
              const h = d.resolveHead(branch)
              return h !== headBeforeDispatch ? h : null
            },
            d.gatePollMaxAttempts,
            d.gatePollIntervalMs,
            d.sleep,
            'devReviewLoop: head-change wait timed out'
          ).catch(() => null)

          if (changedHead === null) {
            // The developer returned without pushing — not a fresh gate
            // read (the head never moved), so this feeds the DRIVER's own
            // bounded stall counter instead of `fetchCiConclusion` again.
            gateStalledStreak += 1
            const stats = computeStats(headBeforeDispatch, roundStartMs)
            const detail = `head ${headBeforeDispatch} unchanged after dispatch; failing check-run(s): ${
              lastFailingChecks.length > 0 ? lastFailingChecks.join(', ') : '(unknown)'
            }`
            if (gateStalledStreak < MAX_GATE_STALLED_TURNS) {
              d.flushOutbox(task)
              continue
            }
            await logEvents(driverDecidedPauseEvents(config.loopId, state, round, stats))
            decision = { type: 'pause', reason: 'infrastructure', detail }
            d.flushOutbox(task)
            continue
          }
        }
      }
      firstPass = false

      const gate = await waitForGreenGate(roundStartMs)
      lastFailingChecks = gate.failingChecks
      pendingGateRedRetry = !gate.green
      gateStalledStreak = 0
      const confidence = round >= 2 && gate.green ? readAndClearConfidence() : undefined
      const obs: Observations = { kind: 'gate', round, green: gate.green, confidence, stats: gate.stats }
      const result = assessRound(state, obs)
      state = result.state
      decision = result.decision
      await logEvents(result.events)
      d.flushOutbox(task)
    } else if (decision.type === 'ask_confidence') {
      const reaskPrompt = `Your last reply did not include a valid confidence line.\n\n${CONFIDENCE_PROMPT_LINE}`
      await dispatchDeveloper(reaskPrompt, round)
      const head = d.resolveHead(branch)
      const stats = computeStats(head, roundStartMs)
      const confidence = readAndClearConfidence()
      const obs: Observations = { kind: 'gate', round, green: true, confidence, stats }
      const result = assessRound(state, obs)
      state = result.state
      decision = result.decision
      pendingGateRedRetry = false
      gateStalledStreak = 0
      await logEvents(result.events)
      d.flushOutbox(task)
    } else if (decision.type === 'dispatch_reviewers') {
      const head = d.resolveHead(branch)
      const ciConclusion = d.fetchCiConclusion(head)
      const resolvedObjectives = d.resolveIssueObjectives(task)
      const rulings = d.fetchRulings(prNumber)
      const revision = d.fetchSourceRevision(task)
      const facts: ReviewerPromptFacts = {
        objectives: resolvedObjectives.text,
        objectivesVersion: resolvedObjectives.version,
        rulings,
        head,
        ciConclusion,
        revision
      }

      // O5: an infrastructure outcome from either role (after its own
      // one-retry inside `dispatchReviewer`) is a driver-decided pause —
      // there is no `Observations` kind for it (adding one would edit
      // `packages/aeg-core`, out of this task's declared Surface, Issue
      // #488 §4) — but `driverDecidedPauseEvents` logs the same
      // `stop_condition_met`/`paused`/`round_ended`/`journal_finalized`
      // events every policy-decided pause gets (code review, PR #489 round
      // 2, MAJOR: the driver used to build this `pause` decision by hand
      // and skip the log entirely). No verdict is held or published for
      // this round, and the round number does not advance.
      let verdicts: [RoundVerdictParse, RoundVerdictParse] | null = null
      try {
        verdicts = await Promise.all([
          dispatchReviewer('reviewer', round, facts),
          dispatchReviewer('security', round, facts)
        ])
      } catch (err) {
        if (!(err instanceof ReviewerInfrastructureFailure)) throw err
        const stats = computeStats(head, roundStartMs)
        await logEvents(driverDecidedPauseEvents(config.loopId, state, round, stats))
        decision = { type: 'pause', reason: 'infrastructure', detail: err.message }
      }

      if (verdicts) {
        // O3: objectives may have moved between the dispatch above (`facts`,
        // captured before either reviewer ran) and now, right after both
        // finished — a principal's `issue objectives edit` can land mid-round.
        // Re-resolved BEFORE either verdict is held: neither `verdicts` value
        // (still in-memory only) is ever written to disk on the mismatch path,
        // so "the held verdicts … are discarded" holds by never holding them.
        const reassessed = d.resolveIssueObjectives(task)
        if (reassessed.version !== facts.objectivesVersion) {
          const command = reassessed.edit
            ? describeObjectivesEdit(task, reassessed.edit)
            : `vinaya issue objectives edit ${task} ... (edit comment not found on re-read)`
          const detail = `objectives moved from ${facts.objectivesVersion ?? 'none'} to ${
            reassessed.version ?? 'none'
          } between reviewer dispatch and assessment — superseded by \`${command}\``
          const stats = computeStats(head, roundStartMs)
          await logEvents(driverDecidedPauseEvents(config.loopId, state, round, stats))
          decision = { type: 'pause', reason: 'objectives_changed', detail }
          d.flushOutbox(task)
        } else {
          const [reviewer, security] = verdicts
          // Both roles genuinely finished (`Promise.all` did not reject) —
          // only now is it safe to hold either verdict on disk (O2's "nothing
          // is held … for that round" invariant; see `dispatchReviewer`'s doc
          // comment, above).
          writeHeldVerdict(root, task, round, 'reviewer', reviewer.rendered)
          writeHeldVerdict(root, task, round, 'security', security.rendered)
          lastReviewContext = `${reviewer.rendered}\n\n---\n\n${security.rendered}`

          const obs: Observations = { kind: 'verdicts', round, verdicts: [reviewer.observation, security.observation] }
          const result = assessRound(state, obs)
          state = result.state
          decision = result.decision
          const routed = routeCompletionEvents(result.events, decision.type)
          pendingCompletionEvents = routed.toDeferUntilPublish
          await logEvents(routed.toLogNow)
          d.flushOutbox(task)
          if (decision.type === 'dispatch_developer') round += 1
        }
      } else {
        d.flushOutbox(task)
      }
    }

    if (decision.type === 'publish') {
      publishRound(root, {
        task,
        round,
        prNumber,
        expectedHead: d.resolveHead(branch),
        journal: { rounds: state.rounds }
      })
      // Only now — posts confirmed, not merely attempted — does the durable
      // log get to say this run completed. A throw above (a post that
      // failed, or re-parsed dirty) skips this entirely, so the log never
      // claims `merged_ready` for a run that did not actually finish.
      await logEvents(pendingCompletionEvents)
      d.flushOutbox(task)
      return { finalDecision: decision, prNumber, task }
    }

    if (decision.type === 'pause') {
      const pauseHead = d.resolveHead(branch)
      writePauseState(root, {
        task,
        round,
        head: pauseHead,
        branch,
        prNumber,
        reason: decision.reason,
        detail: decision.detail,
        pausedAt: new Date().toISOString()
      })
      postPauseComment(root, task, round, pauseHead, prNumber, decision.reason, decision.detail)
      d.flushOutbox(task)
      return { finalDecision: decision, prNumber, task }
    }
  }
}

export const DEV_REVIEW_LOOP_AGENTS = AGENT_VENDOR_NAMES
