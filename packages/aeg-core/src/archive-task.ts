/**
 * Post-merge Archivist provenance assembly. Pure — no `fs`, no `fetch`, no `process.env`. The CLI shim
 * (`bin/archive-task.ts`) resolves the merged PR via `gh`, gathers
 * `MergedPrFacts`, and calls these functions.
 *
 * The cardinal constraint (`aeg-root/roles/archivist.md`): ASSEMBLE, never
 * author. Every provenance field is copied from a fact the merge already
 * froze — the PR body, PR metadata, or PR comments. A field whose source
 * fact is absent becomes a DANGLING entry, never an inferred or defaulted
 * value. Field/heading shapes below mirror the live provenance comments
 * posted by hand on real PRs.
 */

import { hasLabel } from '@attalabs/aeg-forge-state'
import { type AnchorField, anchoredRegion, stripCode } from './anchored-region'
import { headerRegion } from './brief-validation'
import { readTierFromPrBody } from './pr-tier'
import { parseTaskBranchIdentity } from './task-branch-identity'
import { extractCodeReviewVerdict, extractSecurityReviewVerdict } from './verdict-extraction'

export type MergedPrFacts = {
  number: number
  headRefName: string
  body: string
  mergedAt: string
  mergeSha: string
  comments: string[]
  /**
   * The task Issue's frozen `aeg:brief:v1` comment URL (`dispatchTask`) —
   * the brief's permanent home now that it no
   * longer lives in this PR body at all. `null` when the CLI shim
   * (`bin/archive-task.ts`) could not resolve one — no Issue to close, no
   * `aeg:brief:v1` comment on it (a pre-cutover task, or one dispatched by
   * hand), or the lookup itself failed — never defaulted to a guess.
   * Optional so a caller assembling `MergedPrFacts` without this task's
   * change still type-checks; `buildProvenanceBlock` treats an absent field
   * exactly like an explicit `null`.
   */
  briefCommentUrl?: string | null
}

/**
 * null when headRefName is not task/<tranche>/<taskId> or task/issue-<n>.
 *
 * This is ONE of two independent eligibility signals for provenance —
 * the branch-name pattern — not the only one. A PR that closes a
 * tranche-labeled Issue from a non-`task/*` branch (e.g. a small ad-hoc
 * `fix/*` cleanup that finally attaches `Closes #N` to a task whose real
 * work already shipped elsewhere) is EQUALLY eligible: the CLI shim
 * (`bin/archive-task.ts`) additionally checks the closed Issue's own
 * `vinaya/tranche:*` label via `gh issue view --json labels` and proceeds if
 * either signal is present. `buildProvenanceBlock` already tolerates a
 * `null` ref (falls back to a branch-name task label), so this function's
 * only remaining job is the branch-name half of that OR — it is no longer
 * the sole gate. (Confirmed gap: a task whose Issue carried a
 * `vinaya/tranche:*` label was closed by a `fix/*`-branch PR;
 * branch-name-only detection silently skipped provenance forever.)
 *
 * `tranche: null` for a backlog Issue's `task/issue-<n>` branch —
 * `taskId` is the Issue number itself, so this signal alone
 * makes a backlog task's PR eligible for provenance, with no
 * `vinaya/tranche:*` label needed at all.
 */
export function taskRefFromBranch(branch: string): { tranche: string | null; taskId: string } | null {
  const ref = parseTaskBranchIdentity(branch)
  if (!ref) return null
  return ref.kind === 'issue'
    ? { tranche: null, taskId: String(ref.issueNumber) }
    : { tranche: ref.tranche, taskId: ref.taskId }
}

/**
 * The eligibility decision itself, pulled out as a pure function so it's
 * testable without mocking `gh` — the CLI shim (`bin/archive-task.ts`) does
 * only the I/O (resolve `ref`, fetch the closed Issue's labels) and hands
 * both facts here. True when EITHER signal holds: a real task-branch `ref`,
 * or the closed Issue's own labels carry an `vinaya/tranche:*` tag.
 */
export function isEligibleForProvenance(
  ref: { tranche: string | null; taskId: string } | null,
  issueLabels: string[]
): boolean {
  if (ref !== null) return true
  return hasLabel('tranche', issueLabels)
}

const PROVENANCE_HEADING = '### AEG provenance'

/** true when any comment already carries the provenance heading (idempotency, scoped to this PR). */
export function hasProvenance(comments: string[]): boolean {
  return comments.some((c) => c.includes(PROVENANCE_HEADING))
}

/**
 * Tolerant field reader: accepts `Field:` and `**Field:**`, line-anchored,
 * searched ONLY in the header region (shared with `brief-validation.ts`'s
 * gate — gate and archivist read the same region, so a body that passes the
 * gate can't produce a DANGLING field here). Whole-body scanning is the
 * regression from a real first live run, where a prose sentence *about* the
 * `Ticket:` field in a later section was extracted as the field's value.
 *
 * When `anchor` is given and the body carries that anchor pair
 * (`anchored-region.ts`, task 30), the pair replaces the header region as the
 * one place the field is read from — same recognition the gate side
 * (`checkProjectField`) uses, preserving gate/archivist parity.
 */
function extractField(body: string, labelPattern: string, anchor?: AnchorField): string | null {
  const anchored = anchor !== undefined ? anchoredRegion(body, anchor) : null
  const region = anchored ?? headerRegion(body)
  const re = new RegExp(`^(?:\\*\\*)?\\s*${labelPattern}\\s*(?:\\*\\*)?\\s*:\\s*(?:\\*\\*)?\\s*([^\\n·]+)`, 'im')
  const m = region.match(re)
  if (!m) return null
  const value = (m[1] as string).trim()
  return value.length > 0 ? value : null
}

function closesRefs(text: string): number[] {
  return [...new Set([...text.matchAll(/Closes #(\d+)/gi)].map((m) => Number(m[1] as string)))]
}

/**
 * Primary Issue = first `Closes #N` in the header block (canonical placement),
 * falling back to the first anywhere in the body (flagged, not lost). Extras
 * are scanned body-wide so a real second closing reference in prose is still
 * flagged — but always fence-stripped, so example text like a Test Plan's
 * `Closes #NNN` fixture never counts (a real regression).
 *
 * When the body carries an `AEG:CLOSES` anchor pair (`anchored-region.ts`,
 * task 30), the pair replaces the header block as the canonical placement:
 * the primary Issue is the first `Closes #N` inside the pair (never flagged
 * `outsideHeader` — anchored IS canonical), and extras are still scanned
 * body-wide so stray closing references stay flagged. Bodies without the
 * pair parse exactly as before.
 */
export function extractIssue(body: string): { issue: number | null; extraIssues: number[]; outsideHeader: boolean } {
  // Strip ONCE over the whole body, then slice — never strip a slice. The
  // strip's block rules read context a fragment no longer carries: an anchor
  // indented inside a list item is list content in the full body (kept, and
  // GitHub *does* auto-close it) but looks like a bare 4-space indented code
  // block once sliced, so stripping the region blanked the reference and
  // returned `issue: null` — the Issue then goes unclosed on merge, the exact
  // stranding this exists to eliminate, reintroduced along the over-strip
  // axis (a MAJOR review finding). Stripping first also subsumes the decoy
  // protection rather than trading against it: `AEG:*` markers are HTML
  // comments and survive the strip, while a decoy anchor inside code does not
  // survive to be sliced in the first place.
  const stripped = stripCode(body)
  const bodyNums = closesRefs(stripped)
  const anchored = anchoredRegion(stripped, 'CLOSES')
  if (anchored !== null) {
    const anchorNums = closesRefs(anchored)
    if (anchorNums.length === 0) return { issue: null, extraIssues: bodyNums, outsideHeader: false }
    const issue = anchorNums[0] as number
    return { issue, extraIssues: bodyNums.filter((n) => n !== issue), outsideHeader: false }
  }
  const headerNums = closesRefs(headerRegion(stripped))
  if (bodyNums.length === 0) return { issue: null, extraIssues: [], outsideHeader: false }
  const issue = headerNums.length > 0 ? (headerNums[0] as number) : (bodyNums[0] as number)
  return { issue, extraIssues: bodyNums.filter((n) => n !== issue), outsideHeader: headerNums.length === 0 }
}

/** Assemble the block purely from frozen facts; absent facts become DANGLING entries. */
export function buildProvenanceBlock(facts: MergedPrFacts): {
  block: string
  issue: number | null
  dangling: string[]
} {
  const ref = taskRefFromBranch(facts.headRefName)
  const dangling: string[] = []

  const { issue, extraIssues, outsideHeader } = extractIssue(facts.body)
  if (issue === null) {
    dangling.push('no `Closes #N` found in PR body — Issue field is DANGLING, no Issue will be closed')
  }
  if (outsideHeader) {
    dangling.push(
      `\`Closes #${issue}\` was found outside the PR body's header block — the canonical form places it before the first \`##\` heading`
    )
  }
  if (extraIssues.length > 0) {
    dangling.push(
      `PR body references additional Issues (${extraIssues.map((n) => `#${n}`).join(', ')}) beyond the first — closing only #${issue}, the rest are flagged, not closed`
    )
  }

  const tier = readTierFromPrBody(facts.body)
  if (tier === null) dangling.push('no `Tier:` field found in PR body — Tier field is DANGLING')

  if (issue !== null && (facts.briefCommentUrl ?? null) === null) {
    dangling.push(`no \`aeg:brief:v1\` comment resolved for Issue #${issue} — Brief field is DANGLING`)
  }

  const project = extractField(facts.body, 'Project(?:\\(s\\))?', 'PROJECT')
  if (!project) dangling.push('no `Project:` field found in PR body — Project(s) field is DANGLING')

  const forField = extractField(facts.body, 'For')
  if (!forField) dangling.push('no `For:` field found in PR body — Model/agent field is DANGLING')

  const codeReview = extractCodeReviewVerdict(facts.comments)
  if (codeReview.danglingNote) dangling.push(codeReview.danglingNote)

  const security = extractSecurityReviewVerdict(facts.comments)
  if (security.danglingNote) dangling.push(security.danglingNote)

  const ticket = extractField(facts.body, 'Ticket') ?? 'none'

  const taskLabel = ref
    ? ref.tranche !== null
      ? `task ${ref.taskId} (tranche ${ref.tranche})`
      : `task (backlog Issue #${ref.taskId})`
    : `task (branch ${facts.headRefName})`

  const lines = [
    `${PROVENANCE_HEADING} — ${taskLabel}`,
    `- Issue:        ${issue !== null ? `#${issue}  (closed by merge)` : 'DANGLING — no Closes #N in PR body'}`,
    `- Tier:         ${tier !== null ? tier : 'DANGLING — no Tier field in PR body'}`,
    `- Brief:        ${facts.briefCommentUrl ?? 'DANGLING — no aeg:brief:v1 comment resolved for this task'}`,
    `- Project(s):   ${project ?? 'DANGLING — no Project field in PR body'}`,
    `- Model/agent:  ${forField ?? 'DANGLING — no For field in PR body'}`,
    `- Code review:  ${codeReview.value}`,
    `- Security:     ${security.value}`,
    `- Ticket:       ${ticket}`,
    `- Merged:       ${facts.mergeSha} at ${facts.mergedAt}`
  ]

  if (dangling.length > 0) {
    lines.push('', `DANGLING: ${dangling.join('; ')}`)
  }

  return { block: lines.join('\n'), issue, dangling }
}
