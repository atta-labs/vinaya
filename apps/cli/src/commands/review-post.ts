/**
 * `vinaya review post` (fix/vinaya-review-post). A Reviewer submits
 * structured data — verdict, findings, role — and this command renders
 * `roles/reviewer.md`/`roles/security.md`'s exact bare-line template,
 * resolves the PR's real head itself, posts the comment, and refuses to
 * exit 0 unless its own post re-parses clean through the SAME
 * `extractCodeReviewVerdict`/`extractSecurityReviewVerdict` functions
 * `checkReviewGate` calls (`@attalabs/aeg-core`'s `verdict-extraction.ts` —
 * reused, never re-implemented, so this command cannot silently drift from
 * what the merge gate actually checks).
 *
 * Why this exists: a Reviewer agent free-typing markdown into
 * `gh pr comment --body-file` can produce any shape, including a decorated
 * heading (`## Security Review — PASS`) the gate's line-anchored regex
 * cannot see at all — measured live, twice, with no pointer back to what was
 * wrong until CI went red minutes later. The fix is to remove the discretion
 * entirely: the caller supplies only per-field CONTENT (conformance prose,
 * a findings list, scan notes); every structural line (`VERDICT:`,
 * `Judged head:`) is rendered by this command's own code from validated
 * enum/sha inputs, never from a caller-supplied string.
 *
 * Before any post reaches the forge, `checkRenderedComment` runs the exact
 * same extractors over the rendered text and refuses (exit `2`) unless
 * exactly the intended verdict comes back and the other role's extractor
 * finds nothing — a zero-network dry run of the same shape check
 * self-verification performs after posting. This check, not the render's
 * construction, is what actually makes free caller text (a finding,
 * `--scope`, `--summary`) safe: `verdict-extraction.ts` reads only a
 * comment's first FIVE lines (round-4 ruling on `#392`, widened from three
 * by a later task, `#412`), and `renderCodeReviewComment`/
 * `renderSecurityComment`'s caller fields never OPEN one of those lines —
 * they only trail a fixed, renderer-owned label already on the line. The
 * one field this does NOT hold for is `renderEscalationComment`'s
 * `--summary`: pre-cutover, it becomes line 5 outright, unprefixed, so a
 * summary whose own first line happened to read `VERDICT: APPROVE` would
 * extract as a real verdict through construction alone. That is exactly
 * the case this check exists to catch, mechanically, before any post — the
 * per-field guard layer that used to sit here is gone, replaced by this one
 * check at the shared boundary, not by a blanket "caller text never reaches
 * the window" guarantee that does not actually hold for every field.
 *
 * `--role code-reviewer` and `--role security` are the only two shapes —
 * mirroring `reviewer.md`/`security.md`'s templates exactly, including each
 * doc's own internal consistency rule (a BLOCKER finding forces
 * REQUEST CHANGES; a CRITICAL/HIGH finding forces FAIL; an unbacked
 * "SECRETS: none found" is refused without `--secrets-evidence-file`) — so
 * this command catches the same category of mistake at the source, not just
 * the shape of the line.
 *
 * Findings file grammar: one finding per line, `SEVERITY|file:line|description`
 * — `|` is the delimiter because `file:line` already contains a colon.
 * Severity vocab is role-specific (`BLOCKER|MAJOR|MINOR` for code-reviewer,
 * `CRITICAL|HIGH|MEDIUM|LOW` for security) and findings are re-sorted by
 * severity regardless of input order, so the rendered "ordered by severity"
 * claim never depends on the caller having gotten the ordering right.
 *
 * Self-verification (the part that actually closes the gap): after posting,
 * this command re-fetches the PR's comments, filters them to the same
 * `PRINCIPAL_ALLOWLIST`/`principals`-derived author set `checkReviewGate`
 * itself filters to (the #806 verdict-author-verification fix — a
 * non-allowlisted "VERDICT:"-shaped comment must never count, in either
 * direction), and runs the survivors through the exact gate-side extractors.
 * A single fetch-and-check, deliberately with no retry loop — a retry here
 * would risk masking a genuine GitHub comment-propagation race as a
 * transient hiccup (`aeg-root/roles/developer.md`'s stop-condition
 * discipline: report a real race precisely, never paper over it). Measured
 * during this task's own end-to-end run: an immediate re-fetch reliably saw
 * the just-posted comment, so no such race was ever observed here.
 *
 * "Self-verified: clean" proves format and head-binding only — `--verdict`
 * and each finding's severity remain caller-asserted, by the brief's explicit
 * scope. This command mechanizes the SHAPE of a verdict, never the judgment
 * behind it.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  extractCodeReviewVerdict,
  extractIssue,
  extractSecurityReviewVerdict,
  hasObjectivesHeading,
  isIssueNotFoundError,
  isPrincipal,
  OBJECTIVES_SINCE_ISSUE,
  type Objective,
  objectivesOf,
  objectivesVersion,
  type ReviewGateComment,
  type VerdictExtraction
} from '@attalabs/aeg-core'
import { loadTrustAnchorConfig, resolvePrincipalAllowlist } from '../lib/config'
import { printJson } from '../lib/envelope'
import { makeCheckError, refuse } from '../lib/forge-write'

// --- shared finding grammar ---------------------------------------------------

export type Finding = { severity: string; location: string; description: string }

export class FindingsParseError extends Error {}

const CODE_REVIEW_SEVERITIES = ['BLOCKER', 'MAJOR', 'MINOR'] as const
const SECURITY_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const

/**
 * Parses the `SEVERITY|file:line|description` findings-file grammar. Throws
 * `FindingsParseError` (never silently drops or reinterprets a malformed
 * line) naming the exact line and what was wrong with it.
 */
export function parseFindingsFile(content: string, allowedSeverities: readonly string[]): Finding[] {
  const lines = content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  return lines.map((line, idx) => {
    const parts = line.split('|')
    if (parts.length !== 3) {
      throw new FindingsParseError(
        `findings file line ${idx + 1}: expected exactly 3 \`|\`-delimited fields (SEVERITY|file:line|description), found ${parts.length}: ${line}`
      )
    }
    const severity = (parts[0] as string).trim().toUpperCase()
    const location = (parts[1] as string).trim()
    const description = (parts[2] as string).trim()
    if (!allowedSeverities.includes(severity)) {
      throw new FindingsParseError(
        `findings file line ${idx + 1}: severity "${parts[0]}" is not one of ${allowedSeverities.join('|')}: ${line}`
      )
    }
    if (!location || !description) {
      throw new FindingsParseError(
        `findings file line ${idx + 1}: file:line and description must both be non-empty: ${line}`
      )
    }
    return { severity, location, description }
  })
}

/** Re-orders by severity rank, stable within a rank — the rendered "ordered by severity" claim never depends on caller-supplied ordering. */
export function sortBySeverity(findings: readonly Finding[], order: readonly string[]): Finding[] {
  return findings
    .map((f, i) => ({ f, i }))
    .sort((a, b) => order.indexOf(a.f.severity) - order.indexOf(b.f.severity) || a.i - b.i)
    .map(({ f }) => f)
}

export function renderFindingsSection(findings: readonly Finding[]): string {
  if (findings.length === 0) return 'None.'
  return findings.map((f, i) => `${i + 1}. [${f.severity}] ${f.location} — ${f.description}`).join('\n')
}

// --- objectives grammar (`#412`, O1/O2) ---------------------------------------

export type ObjectiveStatus = 'MET' | 'NOT MET'
export type ObjectiveResult = { id: string; status: ObjectiveStatus; evidence: string }

export class ObjectivesParseError extends Error {}

const OBJECTIVE_ID_ONLY = /^O\d+$/
const STRUCTURAL_MARKER_PATTERN = /^[ \t]*(?:\*{1,3}|_{1,3})?(?:VERDICT|Judged head|Objectives version):/i

/**
 * `null` when `evidence` is safe to render as one objective's evidence field;
 * otherwise the refusal reason. A raw newline would break the "exactly one
 * line per objective" contract `renderObjectivesBlock` promises even without
 * producing a marker-shaped line; a leading `VERDICT:`/`Judged head:`/
 * `Objectives version:`-shaped prefix is refused too, on its own, as
 * confusing/dangerous content for an evidence field regardless of whether it
 * could actually inject a structural line (this file's `refuse anything that
 * looks structurally dangerous, don't just prove it's safe` discipline).
 */
export function invalidObjectiveEvidenceReason(evidence: string): string | null {
  if (evidence.includes('\n')) {
    return 'evidence contains a newline — each objective renders as exactly one line'
  }
  if (STRUCTURAL_MARKER_PATTERN.test(evidence)) {
    return "evidence looks like a VERDICT:/Judged head:/Objectives version: line, which would corrupt the rendered comment's structural markers"
  }
  return null
}

/**
 * Parses the `O<n>|MET|<evidence>` / `O<n>|NOT MET|<evidence>` objectives-file
 * grammar — `|`-delimited like the findings file, but evidence is the REST of
 * the line after the second `|` (an evidence sentence may itself contain a
 * `|`; only the id and status fields are rigid). Throws `ObjectivesParseError`
 * naming the exact line and what was wrong with it — never silently drops or
 * reinterprets a malformed line.
 */
export function parseObjectivesFile(content: string): ObjectiveResult[] {
  const lines = content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  return lines.map((line, idx) => {
    const first = line.indexOf('|')
    const second = first === -1 ? -1 : line.indexOf('|', first + 1)
    if (first === -1 || second === -1) {
      throw new ObjectivesParseError(
        `objectives file line ${idx + 1}: expected \`O<n>|MET|<evidence>\` or \`O<n>|NOT MET|<evidence>\` (at least 2 \`|\` delimiters): ${line}`
      )
    }
    const id = line.slice(0, first).trim()
    const statusRaw = line
      .slice(first + 1, second)
      .trim()
      .toUpperCase()
      .replace(/\s+/g, ' ')
    const evidence = line.slice(second + 1).trim()
    if (!OBJECTIVE_ID_ONLY.test(id)) {
      throw new ObjectivesParseError(
        `objectives file line ${idx + 1}: "${id}" is not a well-formed objective id — expected \`O<n>\`: ${line}`
      )
    }
    if (statusRaw !== 'MET' && statusRaw !== 'NOT MET') {
      throw new ObjectivesParseError(
        `objectives file line ${idx + 1}: status "${statusRaw}" is not MET or NOT MET: ${line}`
      )
    }
    if (!evidence) {
      throw new ObjectivesParseError(`objectives file line ${idx + 1}: evidence must be non-empty for ${id}: ${line}`)
    }
    const invalidReason = invalidObjectiveEvidenceReason(evidence)
    if (invalidReason) {
      throw new ObjectivesParseError(`objectives file line ${idx + 1}: ${invalidReason} (${id}): ${line}`)
    }
    return { id, status: statusRaw as ObjectiveStatus, evidence }
  })
}

/** Every id in `resolved` not covered by `results`, and every id in `results` not on `resolved` — `null` when the sets match exactly. */
export function checkObjectiveIdCoverage(
  resolved: readonly Objective[],
  results: readonly ObjectiveResult[]
): string | null {
  const resolvedIds = resolved.map((o) => o.id)
  const resultIds = results.map((r) => r.id)
  const missing = resolvedIds.filter((id) => !resultIds.includes(id))
  const extra = resultIds.filter((id) => !resolvedIds.includes(id))
  if (missing.length === 0 && extra.length === 0) return null
  const parts: string[] = []
  if (missing.length > 0) parts.push(`missing ${missing.join(', ')}`)
  if (extra.length > 0) parts.push(`extra ${extra.join(', ')}`)
  return parts.join('; ')
}

/** Renders the `OBJECTIVES:` block — one `O<n>: MET | NOT MET — <evidence>` line per result, in canonical `O1, O2, …` order regardless of file order. */
export function renderObjectivesBlock(results: readonly ObjectiveResult[]): string {
  const sorted = [...results].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))
  return ['OBJECTIVES:', ...sorted.map((r) => `${r.id}: ${r.status} — ${r.evidence}`)].join('\n')
}

function renderTokensLine(role: 'review' | 'security', roleLabel: 'Reviewer' | 'Security', input: TokensInput): string {
  return `Tokens: ${input.taskId}: ${role} — ${roleLabel} — ${input.model} — ${input.tokensIn}/${input.tokensOut}/${input.cost}`
}

/**
 * Records which role and session cast this verdict — a shared local `gh`
 * credential means the forge attributes the comment itself to the
 * Principal regardless (`atta-labs/vinaya#176`), so this line is the only
 * place an agent-authored verdict is visibly agent-authored. It closes
 * nothing on its own; it makes the inheritance auditable.
 */
function renderCastByLine(roleLabel: 'Reviewer' | 'Security', sessionId: string): string {
  return `Cast by: ${roleLabel} (session ${sessionId})`
}

/**
 * `CLAUDE_CODE_SESSION_ID` is the same best-effort session identifier
 * `report-tokens.ts`'s transcript resolver already cross-checks (set in
 * every Claude Code Bash tool call — confirmed empirically, not documented
 * in the public hook schema) — reused here rather than inventing a second
 * identifier scheme. Falls back to a literal marker, never a fabricated
 * value, when unset (a different host, or no session concept at all).
 */
export function resolveSessionId(env: Record<string, string | undefined>): string {
  return env.CLAUDE_CODE_SESSION_ID ?? '(unknown)'
}

type TokensInput = {
  taskId: string
  model: string
  tokensIn: string
  tokensOut: string
  cost: string
  sessionId: string
}

// --- code-reviewer shape ------------------------------------------------------

export type CodeReviewVerdict = 'APPROVE' | 'REQUEST_CHANGES'

export type CodeReviewInput = TokensInput & {
  headSha: string
  verdict: CodeReviewVerdict
  briefConformance: string
  specConformance: string
  findings: readonly Finding[]
  scope: string
  /** Raw `git diff origin/main...HEAD --stat` (or equivalent) output backing the `SCOPE:` claim; null when not supplied. */
  scopeEvidence: string | null
  tests: string
  docs: string
  /** `null` when this PR's Issue predates `OBJECTIVES_SINCE_ISSUE` — no `Objectives version:` line renders at all (`#412`, O2). */
  objectivesVersion: string | null
  /** `null` alongside `objectivesVersion === null` — no `OBJECTIVES:` block renders. Non-null is always non-empty by construction (`objectivesOf` refuses an empty list). */
  objectiveResults: readonly ObjectiveResult[] | null
}

const CODE_REVIEW_VERDICT_TEXT: Record<CodeReviewVerdict, string> = {
  APPROVE: 'APPROVE',
  REQUEST_CHANGES: 'REQUEST CHANGES'
}

const FINDING_DESCRIPTION_ID = /^F(\d+)\s+\S+(?:\s+(open|fix-claimed|reproduced|resolved))?:/

/** `null` when the description carries no `F<n>` id at all (an id-less new finding is never a re-review reference). */
function findingIdState(description: string): { id: string; state: string | null } | null {
  const m = description.match(FINDING_DESCRIPTION_ID)
  if (!m) return null
  return { id: `F${m[1]}`, state: m[2] ?? null }
}

/** True when a finding's description carries the re-review state `resolved` — kept in the record, but never blocking. */
function isResolved(finding: Finding): boolean {
  return findingIdState(finding.description)?.state === 'resolved'
}

/**
 * The command decides, not the caller. `REQUEST_CHANGES` iff a BLOCKER
 * finding is present; the severity vocabulary is caller-asserted (unchanged
 * from before), but once assigned, the verdict it forces is no longer typed
 * by hand — this generalises the BLOCKER-vs-APPROVE contradiction check that
 * used to live only as a post-hoc refusal. A finding whose re-review state is
 * `resolved` keeps its BLOCKER severity for the record but never drives the
 * verdict — a fix-claimed or reproduced BLOCKER still does.
 */
export function deriveCodeReviewVerdict(findings: readonly Finding[]): CodeReviewVerdict {
  return findings.some((f) => f.severity === 'BLOCKER' && !isResolved(f)) ? 'REQUEST_CHANGES' : 'APPROVE'
}

/**
 * Renders `reviewer.md`'s exact bare template. `VERDICT:`/`Judged head:`/
 * `Objectives version:` are built from `input.verdict`/`input.headSha`/
 * `input.objectivesVersion` through this function's own literal strings —
 * there is no code path by which a caller-supplied string can land in any of
 * the three positions. `Objectives version:` renders as line 5 (blank line 6)
 * only when `input.objectivesVersion` is non-null (`#412`, O2) — a pre-cutover
 * PR renders exactly as before this task. The `OBJECTIVES:` block
 * (`renderObjectivesBlock`) renders after `SPEC CONFORMANCE:` (O1), only when
 * `input.objectiveResults` is non-null.
 */
export function renderCodeReviewComment(input: CodeReviewInput): string {
  const sorted = sortBySeverity(input.findings, CODE_REVIEW_SEVERITIES)
  const lines = [`VERDICT: ${CODE_REVIEW_VERDICT_TEXT[input.verdict]}`, '', `Judged head: ${input.headSha}`, '']
  if (input.objectivesVersion !== null) {
    lines.push(`Objectives version: ${input.objectivesVersion}`, '')
  }
  if (input.scopeEvidence !== null) {
    // Directly below the verdict block, per `reviewer.md`'s own evidence
    // rule — safe as free multi-line text now that the gate's extractors
    // read only a comment's first five lines (round-4 ruling, `#392`,
    // widened by `#412`).
    lines.push('```', input.scopeEvidence, '```', '')
  }
  lines.push(`BRIEF CONFORMANCE: ${input.briefConformance}`, `SPEC CONFORMANCE: ${input.specConformance}`)
  if (input.objectiveResults !== null) {
    lines.push('', renderObjectivesBlock(input.objectiveResults))
  }
  lines.push(
    '',
    'FINDINGS (ordered by severity):',
    renderFindingsSection(sorted),
    '',
    `SCOPE: ${input.scope}`,
    `TESTS: ${input.tests}`,
    `DOCS: ${input.docs}`,
    '',
    renderTokensLine('review', 'Reviewer', input),
    renderCastByLine('Reviewer', input.sessionId)
  )
  return lines.join('\n')
}

// --- security shape ------------------------------------------------------------

export type SecurityVerdict = 'PASS' | 'FAIL'

export type SecurityInput = TokensInput & {
  headSha: string
  verdict: SecurityVerdict
  findings: readonly Finding[]
  configScan: string
  /** The `SECRETS:` line's own text, e.g. `none found` or `listed above, redacted`. */
  secrets: string
  /** Raw scanner output backing a `none found` claim; null when not supplied. */
  secretsEvidence: string | null
  /** `null` when this PR's Issue predates `OBJECTIVES_SINCE_ISSUE` — no `Objectives version:` line renders at all (`#412`, O2). */
  objectivesVersion: string | null
  /** `null` alongside `objectivesVersion === null` — no `OBJECTIVES:` block renders. */
  objectiveResults: readonly ObjectiveResult[] | null
}

/**
 * Same derivation for the security shape: `FAIL` iff a CRITICAL or HIGH
 * finding is present. A `resolved` finding keeps its severity for the
 * record but never drives the verdict, same as the code-review shape.
 */
export function deriveSecurityVerdict(findings: readonly Finding[]): SecurityVerdict {
  return findings.some((f) => (f.severity === 'CRITICAL' || f.severity === 'HIGH') && !isResolved(f)) ? 'FAIL' : 'PASS'
}

/** `security.md`'s "none found" claim, tolerant of `none-found`/extra whitespace/case. */
export function isNoneFoundClaim(value: string): boolean {
  return value.trim().toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ') === 'none found'
}

/**
 * Renders `security.md`'s exact bare template. Same no-caller-injection
 * guarantee as `renderCodeReviewComment` for `VERDICT:`/`Judged head:`/
 * `Objectives version:`. The `OBJECTIVES:` block renders BEFORE
 * `CONFIG SCAN:` (O1), only when `input.objectiveResults` is non-null. When
 * `secretsEvidence` is supplied, the scanner's raw output is pasted in a
 * fenced block ABOVE the `SECRETS:` line, per `security.md`'s own rule that
 * the pasted evidence must appear there to back the claim.
 */
export function renderSecurityComment(input: SecurityInput): string {
  const sorted = sortBySeverity(input.findings, SECURITY_SEVERITIES)
  const lines = [`VERDICT: ${input.verdict}`, '', `Judged head: ${input.headSha}`, '']
  if (input.objectivesVersion !== null) {
    lines.push(`Objectives version: ${input.objectivesVersion}`, '')
  }
  lines.push('FINDINGS (ordered by severity):', renderFindingsSection(sorted), '')
  if (input.objectiveResults !== null) {
    lines.push(renderObjectivesBlock(input.objectiveResults), '')
  }
  lines.push(`CONFIG SCAN: ${input.configScan}`, '')
  if (input.secretsEvidence !== null) {
    lines.push('```', input.secretsEvidence, '```', '')
  }
  lines.push(
    `SECRETS: ${input.secrets}`,
    '',
    renderTokensLine('security', 'Security', input),
    renderCastByLine('Security', input.sessionId)
  )
  return lines.join('\n')
}

// --- pre-render check ---------------------------------------------------------

/**
 * Round-4 ruling on `#392`, window later widened from three to five lines
 * by a later task (`#412`): `renderCodeReviewComment`/
 * `renderSecurityComment`'s caller-supplied fields never OPEN one of the
 * first five lines — they only ever trail a fixed, renderer-owned label
 * already on that line. `renderEscalationComment`'s `summary` is the one
 * exception: pre-cutover, it IS line 5 outright, unprefixed. Construction
 * alone does not make every caller field safe, so no per-field injection
 * guard was rebuilt to cover that gap — one check at the render boundary
 * replaces the whole layer instead. Before any `gh` call, this runs the
 * SAME two extractors the merge gate calls over the text this command is
 * about to post, and refuses unless exactly the intended one returns the
 * intended value and the other returns none (an escalation: both return
 * none). A caller-supplied field that somehow still produced a stray
 * structural-looking line — including exactly the escalation-summary case
 * above — is caught here, mechanically, before it ever reaches the forge.
 */
export type RenderCheckResult = { ok: true } | { ok: false; reason: string }

export type RenderExpectation =
  | { kind: 'code-review'; verdict: CodeReviewVerdict }
  | { kind: 'security'; verdict: SecurityVerdict }
  | { kind: 'escalation' }

export function checkRenderedComment(body: string, expectation: RenderExpectation): RenderCheckResult {
  const code = extractCodeReviewVerdict([body])
  const security = extractSecurityReviewVerdict([body])

  if (expectation.kind === 'escalation') {
    if (code.danglingNote === null) {
      return {
        ok: false,
        reason: `the rendered comment re-parses as a code-review VERDICT ("${code.value}") through extractCodeReviewVerdict — an escalation must carry none.`
      }
    }
    if (security.danglingNote === null) {
      return {
        ok: false,
        reason: `the rendered comment re-parses as a security VERDICT ("${security.value}") through extractSecurityReviewVerdict — an escalation must carry none.`
      }
    }
    return { ok: true }
  }

  if (expectation.kind === 'code-review') {
    const expected = CODE_REVIEW_VERDICT_TEXT[expectation.verdict]
    if (code.danglingNote !== null || code.value !== expected) {
      return {
        ok: false,
        reason: `the rendered comment does not re-parse as VERDICT "${expected}" through extractCodeReviewVerdict (got "${code.value}").`
      }
    }
    if (security.danglingNote === null) {
      return {
        ok: false,
        reason: `the rendered comment also re-parses as a security VERDICT ("${security.value}") through extractSecurityReviewVerdict — cross-role contamination.`
      }
    }
    return { ok: true }
  }

  // security
  if (code.danglingNote === null) {
    return {
      ok: false,
      reason: `the rendered comment also re-parses as a code-review VERDICT ("${code.value}") through extractCodeReviewVerdict — cross-role contamination.`
    }
  }
  if (security.danglingNote !== null || security.value !== expectation.verdict) {
    return {
      ok: false,
      reason: `the rendered comment does not re-parse as VERDICT "${expectation.verdict}" through extractSecurityReviewVerdict (got "${security.value}").`
    }
  }
  return { ok: true }
}

/** A hard process guard, not a `CheckError` finding: plain stderr, exit `2`, before the post `gh` call. */
function refusePreRenderCheck(reason: string): never {
  process.stderr.write(`review post: REFUSED — ${reason}\nNothing was posted.\n`)
  process.exit(2)
}

function checkRenderedCommentOrRefuse(body: string, expectation: RenderExpectation): void {
  const result = checkRenderedComment(body, expectation)
  if (!result.ok) refusePreRenderCheck(result.reason)
}

// --- escalation ------------------------------------------------------------

export type EscalationClass = 'authority' | 'strategy' | 'product'

const ESCALATION_CLASSES: readonly EscalationClass[] = ['authority', 'strategy', 'product']

export function isEscalationClass(value: string): value is EscalationClass {
  return (ESCALATION_CLASSES as readonly string[]).includes(value)
}

export type EscalationInput = TokensInput & {
  headSha: string
  escalationClass: EscalationClass
  summary: string
  role: 'review' | 'security'
  roleLabel: 'Reviewer' | 'Security'
  /** Same resolution as the verdict shapes (`#412`, O2) — an escalation carries the version line but never an `OBJECTIVES:` block. */
  objectivesVersion: string | null
}

/**
 * An escalation is its own review outcome, never a finding stuffed inside a
 * REQUEST CHANGES. Renders `ESCALATE: <class>` where a verdict comment
 * renders `VERDICT: <value>` — the merge-verdict workflow fires on the
 * substring `VERDICT` alone (`.github/workflows/vinaya-review-verdict.yml`),
 * and an escalation must never be mistaken for "a pass ran". `input.summary`
 * is free caller text, and it is NOT reliably kept out of the extractors'
 * five-line read window by construction: pre-cutover (no `Objectives
 * version:` line), `input.summary` becomes line 5 itself — no fixed label
 * precedes it here, unlike `renderCodeReviewComment`'s `BRIEF CONFORMANCE:`
 * — so a summary whose own first line happened to read `VERDICT: APPROVE`
 * would extract as a real code-review verdict through this exact render.
 * What actually makes this safe is `reviewPostCommand`'s mechanical
 * self-check, not line position: `checkRenderedComment` runs both
 * extractors over this exact rendered text before any `gh` call and refuses
 * to post an escalation that re-parses as either verdict — the refusal
 * path this collision would hit, not a silent false verdict reaching the
 * forge.
 */
export function renderEscalationComment(input: EscalationInput): string {
  const lines = [`ESCALATE: ${input.escalationClass}`, '', `Judged head: ${input.headSha}`, '']
  if (input.objectivesVersion !== null) {
    lines.push(`Objectives version: ${input.objectivesVersion}`, '')
  }
  lines.push(
    input.summary,
    '',
    renderTokensLine(input.role, input.roleLabel, input),
    renderCastByLine(input.roleLabel, input.sessionId)
  )
  return lines.join('\n')
}

// --- self-verification ---------------------------------------------------------

export type SelfVerifyResult = { ok: boolean; reason: string }

/**
 * True when `extraction.headSha` covers `headSha` — the identical binding
 * rule `review-gate.ts`'s `isBoundToHead` uses, so a comment this command
 * considers "clean" is exactly what the merge gate will also consider clean.
 */
function isBoundToHead(extraction: { headSha: string | null }, headSha: string): boolean {
  if (!extraction.headSha) return false
  return headSha.toLowerCase().startsWith(extraction.headSha.toLowerCase())
}

function checkExtraction(
  extraction: VerdictExtraction,
  expectedValue: string,
  headSha: string,
  expectedObjectivesVersion: string | null
): SelfVerifyResult {
  if (extraction.danglingNote) {
    return {
      ok: false,
      reason: `no clean VERDICT was found on re-fetch (${extraction.danglingNote}) — the posted comment does not match the gate's line-anchored \`VERDICT:\` pattern.`
    }
  }
  if (extraction.value !== expectedValue) {
    return {
      ok: false,
      reason: `re-extraction found VERDICT "${extraction.value}", expected "${expectedValue}" — the posted comment's VERDICT line does not match what this command rendered.`
    }
  }
  if (!extraction.headSha) {
    return { ok: false, reason: 'the winning VERDICT comment carries no `Judged head:` line on re-fetch.' }
  }
  if (!isBoundToHead(extraction, headSha)) {
    return {
      ok: false,
      reason: `re-extraction found \`Judged head: ${extraction.headSha}\`, which does not cover the resolved head ${headSha}.`
    }
  }
  if (extraction.objectivesVersion !== expectedObjectivesVersion) {
    return {
      ok: false,
      reason: `re-extraction found objectives version ${extraction.objectivesVersion ?? 'none'}, expected ${expectedObjectivesVersion ?? 'none'} — the posted comment's Objectives version: line does not match what this command rendered.`
    }
  }
  return { ok: true, reason: 'clean' }
}

/**
 * Same author filter `checkReviewGate` applies before calling either
 * extractor (the #806 verdict-author-verification fix) — a non-allowlisted
 * "VERDICT:"-shaped comment must never count toward self-verification either,
 * or "self-verified: clean" would not be a faithful proxy for what the real
 * merge gate concludes at CI time.
 */
function principalBodies(comments: readonly ReviewGateComment[], principalAllowlist: readonly string[]): string[] {
  return comments.filter((c) => isPrincipal(c.author, principalAllowlist as string[])).map((c) => c.body)
}

/**
 * The OTHER role's extractor must find nothing in THIS specific posted
 * comment — scoped to `postedBody` alone (exact match, same technique
 * `verifyPostedEscalation` uses), never the PR's whole comment history: an
 * earlier round's legitimate opposite-role verdict comment already sitting
 * on the PR must never fail THIS post's self-verification. A security post
 * that also re-parses as a code-review `APPROVE` is the failure this guards
 * — the render function has one structural `VERDICT:` line, but proving that
 * mechanically, through the same extractors the merge gate calls, is what
 * actually closes the gap a future render change could reopen.
 */
function checkNoCrossRoleVerdict(
  postedBody: string,
  crossExtract: (comments: string[]) => VerdictExtraction,
  crossRoleLabel: string
): SelfVerifyResult | null {
  const cross = crossExtract([postedBody])
  if (cross.danglingNote === null) {
    return {
      ok: false,
      reason: `the posted comment also re-parses as a ${crossRoleLabel} VERDICT ("${cross.value}") — cross-role contamination.`
    }
  }
  return null
}

export function verifyPostedCodeReview(
  comments: readonly ReviewGateComment[],
  verdict: CodeReviewVerdict,
  headSha: string,
  principalAllowlist: readonly string[],
  postedBody: string,
  objectivesVersion: string | null
): SelfVerifyResult {
  const own = checkExtraction(
    extractCodeReviewVerdict(principalBodies(comments, principalAllowlist)),
    CODE_REVIEW_VERDICT_TEXT[verdict],
    headSha,
    objectivesVersion
  )
  if (!own.ok) return own
  return checkNoCrossRoleVerdict(postedBody, extractSecurityReviewVerdict, 'security') ?? own
}

export function verifyPostedSecurity(
  comments: readonly ReviewGateComment[],
  verdict: SecurityVerdict,
  headSha: string,
  principalAllowlist: readonly string[],
  postedBody: string,
  objectivesVersion: string | null
): SelfVerifyResult {
  const own = checkExtraction(
    extractSecurityReviewVerdict(principalBodies(comments, principalAllowlist)),
    verdict,
    headSha,
    objectivesVersion
  )
  if (!own.ok) return own
  return checkNoCrossRoleVerdict(postedBody, extractCodeReviewVerdict, 'code-review') ?? own
}

/**
 * The escalation-side mirror of `verifyPostedCodeReview`/`verifyPostedSecurity`:
 * proves the ABSENCE of a verdict rather than the presence of one. Finds the
 * just-posted comment by exact body match (an escalation carries no
 * `VERDICT:` line for `checkExtraction`'s head-binding check to key off), and
 * asserts BOTH gate extractors read it as no verdict at all — the same
 * functions `checkReviewGate` calls, so a drift that made an escalation
 * accidentally parse as a real verdict would be caught here, not in CI.
 */
export function verifyPostedEscalation(comments: readonly ReviewGateComment[], postedBody: string): SelfVerifyResult {
  const match = comments.find((c) => c.body === postedBody)
  if (!match) {
    return { ok: false, reason: 'the posted escalation comment could not be found on re-fetch.' }
  }
  const codeExtraction = extractCodeReviewVerdict([match.body])
  const securityExtraction = extractSecurityReviewVerdict([match.body])
  if (codeExtraction.danglingNote === null || securityExtraction.danglingNote === null) {
    return {
      ok: false,
      reason:
        'the posted escalation re-parses as a real VERDICT through the gate extractors — it must not, or the merge gate could mistake it for a pass.'
    }
  }
  return { ok: true, reason: 'clean — no verdict extracted, as an escalation requires' }
}

// --- round-two (re-review) ---------------------------------------------------

const FINDING_ID_LINE = /^\d+\.\s+\[[A-Z]+\]\s+\S+\s+—\s+F(\d+)\b/gm
const JUDGED_HEAD_LINE = /^[ \t]*Judged head:\s*([0-9a-f]{7,40})\b/im
const OBJECTIVE_ID_LINE = /^O(\d+):\s*(?:MET|NOT MET)\b/gm

/**
 * Reads the prior round's finding ids, objective ids (`#412`, O1), and judged
 * head straight out of a verdict comment's own rendered text — the same text
 * `renderFindingsSection`/`renderObjectivesBlock` and
 * `renderCodeReviewComment`/`renderSecurityComment` produced, so this is
 * reading the format this file itself writes, not a second grammar.
 */
export function parsePriorFindingIds(commentBody: string): {
  ids: string[]
  objectiveIds: string[]
  judgedHead: string | null
} {
  const ids = [...commentBody.matchAll(FINDING_ID_LINE)].map((m) => `F${m[1]}`)
  const objectiveIds = [...commentBody.matchAll(OBJECTIVE_ID_LINE)].map((m) => `O${m[1]}`)
  const headMatch = commentBody.match(JUDGED_HEAD_LINE)
  return {
    ids: [...new Set(ids)],
    objectiveIds: [...new Set(objectiveIds)],
    judgedHead: headMatch ? (headMatch[1] as string).toLowerCase() : null
  }
}

/** Every prior id with no matching `F<n> <class> <state>:` description in the new findings file, in prior-list order. */
export function missingPriorIds(priorIds: readonly string[], findings: readonly Finding[]): string[] {
  const carried = new Set(
    findings
      .map((f) => findingIdState(f.description))
      .filter((p): p is { id: string; state: string } => p !== null && p.state !== null)
      .map((p) => p.id)
  )
  return priorIds.filter((id) => !carried.has(id))
}

/**
 * `git diff <judgedHead>...HEAD -U0`'s own hunk headers bound the changed
 * span exactly — `-U0` means zero context lines, so `@@ -a +c,d @@` already
 * IS the delta, with no need to diff-parse context away.
 */
export function parseChangedLineRanges(diffOutput: string): Record<string, Array<[number, number]>> {
  const result: Record<string, Array<[number, number]>> = {}
  let currentFile: string | null = null
  for (const line of diffOutput.split('\n')) {
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).trim()
      currentFile = path === '/dev/null' ? null : path.replace(/^b\//, '')
      continue
    }
    if (line.startsWith('@@') && currentFile) {
      const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
      if (m) {
        const start = Number(m[1])
        const count = m[2] !== undefined ? Number(m[2]) : 1
        if (count > 0) {
          if (!result[currentFile]) result[currentFile] = []
          ;(result[currentFile] as Array<[number, number]>).push([start, start + count - 1])
        }
      }
    }
  }
  return result
}

/** `location` is `file:line` — the last `:` splits path from line, matching the grammar's own `file:line already contains a colon` rule. */
function parseLocation(location: string): { file: string; line: number } | null {
  const idx = location.lastIndexOf(':')
  if (idx === -1) return null
  const line = Number(location.slice(idx + 1))
  if (!Number.isFinite(line)) return null
  return { file: location.slice(0, idx), line }
}

/**
 * Every finding whose `file:line` falls outside every changed range for that
 * file. A location this cannot parse, or a file with no entry in
 * `changedRanges` at all, is treated as outside the delta — surfaced rather
 * than silently accepted, which is the safe direction for a check whose job
 * is to catch scope creep on a non-blocking finding.
 */
export function findingsOutsideDelta(
  findings: readonly Finding[],
  changedRanges: Readonly<Record<string, ReadonlyArray<readonly [number, number]>>>
): Finding[] {
  return findings.filter((f) => {
    const parsed = parseLocation(f.location)
    if (!parsed) return true
    const ranges = changedRanges[parsed.file]
    if (!ranges) return true
    return !ranges.some(([start, end]) => parsed.line >= start && parsed.line <= end)
  })
}

/**
 * The most recent principal-authored comment that parses clean through
 * `extract` (`extractCodeReviewVerdict`/`extractSecurityReviewVerdict`) — the
 * same selection those extractors already apply (the latest comment carrying
 * any matching line is chosen, then its first matching line is read; not
 * "the last matching line anywhere wins"), re-run here one body at a time so
 * this function also learns WHICH body won, not just what value it carried.
 * `null` when this is round one: no round-two checks apply.
 */
export function findPriorVerdictComment(
  principalBodies: readonly string[],
  extract: (comments: string[]) => VerdictExtraction
): string | null {
  for (let i = principalBodies.length - 1; i >= 0; i--) {
    const body = principalBodies[i] as string
    if (extract([body]).danglingNote === null) return body
  }
  return null
}

// --- CLI plumbing ----------------------------------------------------------

/**
 * Never consumes a token that itself looks like a flag (`--foo`) as the
 * PRECEDING flag's value — a misordered invocation (a nullary flag left
 * un-filtered before this call, or simply a missing value) sets that flag to
 * `''` instead, so a real `requireFlag` refusal fires loudly on the flag that
 * is actually missing, rather than silently swallowing the NEXT flag's name
 * and value (review finding, PR #144: `--role` immediately before a
 * `--json`-like token used to eat the following `--verdict APPROVE` pair
 * whole with no error at all).
 */
export function parseFlags(args: string[]): Map<string, string> {
  const map = new Map<string, string>()
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    // `--` ends the options. `unknownFlags` stops scanning here, so if this did
    // not, an argument past the marker would silently override a real flag —
    // `--verdict X -- --verdict Y` posting `Y` with the refusal blind to it.
    if (a === '--') break
    if (!a.startsWith('--')) continue
    // `--flag=value` keyed on the whole token used to land in the map under a
    // name nothing reads, so the flag was accepted by the refusal check and
    // then silently dropped — `--findings-file=x` rendered `FINDINGS … None.`
    // and the BLOCKER-versus-APPROVE cross-check quietly became a no-op. The
    // `=` spelling is accepted elsewhere in this CLI, so it is parsed, not
    // refused.
    const eq = a.indexOf('=')
    if (eq > 2) {
      map.set(a.slice(0, eq), a.slice(eq + 1))
      continue
    }
    const value = args[i + 1]
    if (value === undefined || value.startsWith('--')) {
      map.set(a, '')
      continue
    }
    map.set(a, value)
    i++
  }
  return map
}

function refuseCmd(message: string, recovery: string): never {
  refuse([makeCheckError('review-post', message, recovery)])
}

function requireFlag(flags: Map<string, string>, name: string): string {
  const v = flags.get(name)
  if (v === undefined || v === '') {
    refuseCmd(`Missing required \`${name}\` flag.`, `Pass \`${name} <value>\`, then re-run \`vinaya review post ...\`.`)
  }
  return v
}

function requireTokenField(flags: Map<string, string>, name: string): string {
  const v = requireFlag(flags, name)
  if (v !== '-' && !/^\d+$/.test(v)) {
    refuseCmd(
      `\`${name} ${v}\` is neither a non-negative integer nor \`-\` (unknown).`,
      `Pass a whole number or \`-\` for ${name}.`
    )
  }
  return v
}

function readFindingsFile(path: string | undefined, allowedSeverities: readonly string[]): Finding[] {
  if (path === undefined) return []
  // `--findings-file=` and `--findings-file` with nothing after it both yield
  // `''`, which used to collapse onto "flag omitted" — so a caller who meant to
  // pass findings silently posted none, and the BLOCKER-versus-APPROVE and
  // CRITICAL/HIGH-versus-PASS cross-checks had nothing to fire on. Naming the
  // flag and passing no path is a mistake, not a choice.
  if (path.trim() === '') {
    refuseCmd(
      '`--findings-file` was given with no path.',
      'Pass the path to the findings file, or omit the flag entirely if there are no findings.'
    )
  }
  if (!path) return []
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    refuseCmd(`Could not read findings file at ${path}.`, 'Check the path and re-run.')
  }
  try {
    return parseFindingsFile(content, allowedSeverities)
  } catch (err) {
    if (err instanceof FindingsParseError) {
      refuseCmd(err.message, 'Fix the malformed line in the findings file, then re-run.')
    }
    throw err
  }
}

function normalizeCodeReviewVerdict(raw: string): CodeReviewVerdict {
  const v = raw
    .trim()
    .toUpperCase()
    .replace(/[-\s]+/g, '_')
  if (v === 'APPROVE') return 'APPROVE'
  if (v === 'REQUEST_CHANGES') return 'REQUEST_CHANGES'
  refuseCmd(
    `\`--verdict ${raw}\` is not APPROVE or REQUEST_CHANGES.`,
    'Pass `--verdict APPROVE` or `--verdict REQUEST_CHANGES`.'
  )
}

function normalizeSecurityVerdict(raw: string): SecurityVerdict {
  const v = raw.trim().toUpperCase()
  if (v === 'PASS') return 'PASS'
  if (v === 'FAIL') return 'FAIL'
  refuseCmd(`\`--verdict ${raw}\` is not PASS or FAIL.`, 'Pass `--verdict PASS` or `--verdict FAIL`.')
}

function gh(args: string[]): string {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (err) {
    const stderr = (err as { stderr?: Buffer | string }).stderr
    throw new Error(String(stderr ?? (err as Error).message).trim() || 'gh command failed')
  }
}

function resolveHeadRefName(pr: string): string {
  let out: string
  try {
    out = gh(['pr', 'view', pr, '--json', 'headRefName', '-q', '.headRefName'])
  } catch (err) {
    refuseCmd(
      `Could not resolve PR ${pr}'s branch name via \`gh pr view --json headRefName\`: ${err instanceof Error ? err.message : String(err)}`,
      'Confirm `gh auth status` passes and the PR number is correct, then re-run.'
    )
  }
  if (!out) {
    refuseCmd(`\`gh pr view ${pr} --json headRefName\` returned no branch name.`, 'Confirm PR exists, then re-run.')
  }
  return out
}

function shaFromLsRemote(branch: string): string | null {
  try {
    const out = execFileSync('git', ['ls-remote', 'origin', `refs/heads/${branch}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
    const sha = out.split(/\s+/)[0] ?? ''
    return sha === '' ? null : sha
  } catch {
    return null
  }
}

function shaFromGhApi(branch: string): string | null {
  try {
    const out = gh(['api', `repos/{owner}/{repo}/git/ref/heads/${branch}`, '--jq', '.object.sha'])
    return out === '' ? null : out
  } catch {
    return null
  }
}

/**
 * The branch's true head — `git ls-remote origin refs/heads/<branch>`,
 * falling back to the forge's own ref API when git is unavailable — never
 * `gh pr view`'s `headRefOid`, which can lag a push (`#371`: after a push
 * was pushed, `gh pr view` still reported the prior sha). `headRefOid` is
 * read only as a cross-check, logged when it disagrees with the resolved
 * true head — never used as the resolved value itself.
 */
function resolveHeadSha(pr: string): string {
  const branch = resolveHeadRefName(pr)
  const trueSha = shaFromLsRemote(branch) ?? shaFromGhApi(branch)
  if (!trueSha) {
    refuseCmd(
      `Could not resolve branch \`${branch}\`'s true head via \`git ls-remote\` or the forge's \`git/ref/heads\` API.`,
      'Confirm the branch exists on origin and `gh auth status` passes, then re-run.'
    )
  }
  let staleOid: string | null = null
  try {
    staleOid = gh(['pr', 'view', pr, '--json', 'headRefOid', '-q', '.headRefOid']) || null
  } catch {
    staleOid = null
  }
  if (staleOid && staleOid !== trueSha) {
    process.stderr.write(
      `Warning: \`gh pr view ${pr}\`'s headRefOid (${staleOid}) disagrees with the true head ${trueSha} resolved from \`${branch}\` — using the true head.\n`
    )
  }
  return trueSha
}

// --- objectives resolution (`#412`, O1/O2) ------------------------------------

function fetchPrBody(pr: string): string {
  try {
    return gh(['pr', 'view', pr, '--json', 'body', '-q', '.body'])
  } catch (err) {
    refuseCmd(
      `Could not resolve PR ${pr}'s body via \`gh pr view --json body\`: ${err instanceof Error ? err.message : String(err)}`,
      'Confirm `gh auth status` passes and the PR number is correct, then re-run.'
    )
  }
}

function fetchIssueBodyForObjectives(issue: number): string {
  return gh(['issue', 'view', String(issue), '--json', 'body', '--jq', '.body'])
}

export type ObjectivesResolution =
  | { kind: 'list'; objectives: readonly Objective[]; version: string }
  | { kind: 'skip' }

/**
 * Mirrors `verify-brief.ts`'s `resolveIssueObjectives`/`check-review-gate.ts`'s
 * `resolveObjectivesVersion`: `Closes #N`'s Issue wins when it resolves and is
 * at/above `OBJECTIVES_SINCE_ISSUE`; the PR body's own `## Objectives` section
 * is the fallback when the PR closes no Issue at all. `{ kind: 'skip' }` is
 * the ONE non-refusing "nothing to judge against" case — an Issue below the
 * cutover — matching the gate's own null-skip rule exactly (a pre-cutover PR
 * must keep passing unchanged). Every OTHER "nothing resolvable" case refuses
 * here, never returns a silently empty list — an Issue that does not resolve,
 * an Issue whose `## Objectives` section does not parse, or a PR closing no
 * Issue with no `## Objectives` section of its own.
 */
function resolveObjectivesForPr(pr: string): ObjectivesResolution {
  const prBody = fetchPrBody(pr)
  const { issue } = extractIssue(prBody)

  if (issue !== null && issue < OBJECTIVES_SINCE_ISSUE) return { kind: 'skip' }

  if (issue !== null) {
    let issueBody: string
    try {
      issueBody = fetchIssueBodyForObjectives(issue)
    } catch (err) {
      if (isIssueNotFoundError(err)) {
        refuseCmd(
          `Issue #${issue} does not resolve via \`gh issue view\` — no objectives to judge against.`,
          'Confirm the Issue exists, or fix `Closes #N` in the PR body, then re-run.'
        )
      }
      refuseCmd(
        `Could not fetch Issue #${issue}'s body via \`gh issue view\` to resolve its objectives — no objectives to judge against: ${err instanceof Error ? err.message : String(err)}`,
        'Confirm `gh auth status` passes, then re-run.'
      )
    }
    const parsed = objectivesOf(issueBody)
    if (!parsed.ok) {
      refuseCmd(
        `Issue #${issue}'s \`## Objectives\` section does not parse (${parsed.errors.join('; ')}) — no objectives to judge against.`,
        'Fix the Issue body, then re-run.'
      )
    }
    return { kind: 'list', objectives: parsed.objectives, version: objectivesVersion(parsed.objectives) }
  }

  if (hasObjectivesHeading(prBody)) {
    const parsed = objectivesOf(prBody)
    if (!parsed.ok) {
      refuseCmd(
        `This PR body's own \`## Objectives\` section does not parse (${parsed.errors.join('; ')}) — no objectives to judge against.`,
        "Fix the PR body's Objectives section, then re-run."
      )
    }
    return { kind: 'list', objectives: parsed.objectives, version: objectivesVersion(parsed.objectives) }
  }

  refuseCmd(
    'no objectives to judge against — this PR closes no Issue and its body carries no `## Objectives` section.',
    'Add `Closes #N` pointing at an Issue with an `## Objectives` list, or add a `## Objectives` section to the PR body, then re-run.'
  )
}

function readObjectivesFile(path: string): ObjectiveResult[] {
  if (path.trim() === '') {
    refuseCmd('`--objectives-file` was given with no path.', 'Pass the path to the objectives file, then re-run.')
  }
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    refuseCmd(`Could not read objectives file at ${path}.`, 'Check the path and re-run.')
  }
  try {
    return parseObjectivesFile(content)
  } catch (err) {
    if (err instanceof ObjectivesParseError) {
      refuseCmd(err.message, 'Fix the malformed line in the objectives file, then re-run.')
    }
    throw err
  }
}

/**
 * Resolves `--objectives-file` against `resolveObjectivesForPr`'s result and
 * runs every O1 refusal: the file required whenever objectives exist, its ids
 * covering the resolved list exactly, and (via the caller, once `verdict` is
 * known) an APPROVE/PASS never coexisting with a NOT MET. Returns the
 * `Objectives version:` string and the parsed results to render — both `null`
 * together on `{ kind: 'skip' }`.
 */
function resolveObjectiveResultsForCommand(
  resolution: ObjectivesResolution,
  objectivesFileRaw: string | undefined
): { objectivesVersion: string | null; objectiveResults: ObjectiveResult[] | null } {
  if (resolution.kind === 'skip') {
    if (objectivesFileRaw !== undefined) {
      refuseCmd(
        '`--objectives-file` was given, but no objectives to judge against exist for this PR (its Issue predates the objectives cutover).',
        'Drop `--objectives-file` for this PR, or judge against a post-cutover Issue.'
      )
    }
    return { objectivesVersion: null, objectiveResults: null }
  }

  if (objectivesFileRaw === undefined) {
    refuseCmd(
      'This PR has an objectives list to judge against, but no `--objectives-file` was given.',
      'Pass `--objectives-file <path>` with one `O<n>|MET|<evidence>` or `O<n>|NOT MET|<evidence>` line per objective, then re-run.'
    )
  }
  const objectiveResults = readObjectivesFile(objectivesFileRaw)
  const coverageProblem = checkObjectiveIdCoverage(resolution.objectives, objectiveResults)
  if (coverageProblem !== null) {
    refuseCmd(
      `\`--objectives-file\` does not cover the resolved objectives list exactly: ${coverageProblem}.`,
      'Add a line for every missing objective, drop any not on the list, then re-run.'
    )
  }
  return { objectivesVersion: resolution.version, objectiveResults }
}

/**
 * True for the clean half of either verdict enum. `CodeReviewVerdict` and
 * `SecurityVerdict` share no member, so one predicate can read either
 * without a caller having to say which enum it is holding — the single
 * "is this clean" check both call sites below share, instead of each
 * re-typing its own `verdict === 'APPROVE'` / `verdict === 'PASS'` literal
 * comparison (code review MINOR — a third clean-verdict label would have
 * needed updating in two places instead of one).
 */
function isCleanVerdict(verdict: CodeReviewVerdict | SecurityVerdict): boolean {
  return verdict === 'APPROVE' || verdict === 'PASS'
}

/** O1: `APPROVE`/`PASS` — a clean verdict — is refused together with any `NOT MET` objective. */
function refuseIfCleanVerdictHasNotMetObjective(
  isCleanVerdict: boolean,
  cleanLabel: string,
  objectiveResults: readonly ObjectiveResult[] | null
): void {
  if (!isCleanVerdict || objectiveResults === null) return
  const notMet = objectiveResults.filter((r) => r.status === 'NOT MET')
  if (notMet.length > 0) {
    refuseCmd(
      `Verdict resolves to ${cleanLabel} but the objectives file lists ${notMet.length > 1 ? 'NOT MET objectives' : 'a NOT MET objective'} (${notMet.map((r) => r.id).join(', ')}) — a clean verdict requires every objective MET.`,
      'Change the verdict to reflect the gap, or fix the objective and mark it MET, then re-run.'
    )
  }
}

/**
 * `--print-only`'s exit (task 6, #397): the rendered, self-checked comment
 * already passed `checkRenderedComment` — the same gate a real post runs —
 * so there is nothing left to verify. Print it and return before
 * `postComment` ever runs; no forge write, no re-fetch to self-verify one.
 */
function printOnlyResult(json: boolean, role: string, headSha: string, body: string): void {
  if (json) {
    printJson({ posted: false, printOnly: true, role, headSha })
  } else {
    process.stdout.write(`${body}\n`)
  }
}

function postComment(pr: string, body: string): string {
  const tmp = join(tmpdir(), `vinaya-review-post-${process.pid}-${Date.now()}.md`)
  writeFileSync(tmp, body)
  try {
    return gh(['pr', 'comment', pr, '--body-file', tmp]).trim()
  } catch (err) {
    refuseCmd(
      `Rendered comment failed to post via \`gh pr comment\`: ${err instanceof Error ? err.message : String(err)}`,
      'Check `gh auth status`/network, then re-run — nothing was posted.'
    )
  } finally {
    rmSync(tmp, { force: true })
  }
}

function fetchComments(pr: string): ReviewGateComment[] {
  const out = gh(['pr', 'view', pr, '--json', 'comments'])
  const parsed = JSON.parse(out) as { comments: { body: string; author?: { login?: string } | null }[] }
  return parsed.comments.map((c) => ({ body: c.body, author: c.author?.login ?? null }))
}

/**
 * `resolvedHead` is the PR's real head (`resolveHeadSha`'s own return value)
 * — never the local checkout's implicit `HEAD`, which can drift from it in
 * any worktree not freshly synced to the PR. Fetches `resolvedHead` from
 * `origin` first (by sha — GitHub serves a reachable commit sha directly, no
 * branch name needed) so the diff has both ends available regardless of
 * whether this worktree's local `HEAD` happens to match, then diffs
 * `judgedHead...resolvedHead`. Refuses, naming whichever sha is the problem,
 * if either end is not resolvable.
 */
function computeChangedRanges(
  pr: string,
  judgedHead: string,
  resolvedHead: string
): Record<string, Array<[number, number]>> {
  try {
    execFileSync('git', ['fetch', 'origin', resolvedHead], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    refuseCmd(
      `Could not compute the round-two diff for PR ${pr}: \`git fetch origin ${resolvedHead}\` failed (${err instanceof Error ? err.message : String(err)}) — the PR's current head is not reachable from this worktree's origin remote.`,
      'Confirm the PR head is pushed to origin and reachable, then re-run.'
    )
  }
  let out: string
  try {
    out = execFileSync('git', ['diff', `${judgedHead}...${resolvedHead}`, '-U0'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    refuseCmd(
      `Could not compute the round-two diff for PR ${pr}: \`git diff ${judgedHead}...${resolvedHead} -U0\` failed (${err instanceof Error ? err.message : String(err)}) — the previously judged head ${judgedHead} is likely not in this worktree's history.`,
      `Fetch the missing commit (e.g. \`git fetch origin ${judgedHead}\`) into this worktree, then re-run.`
    )
  }
  return parseChangedLineRanges(out)
}

/**
 * Every flag this command reads, plus the nullary ones stripped before the
 * pairwise scan. An argument starting with `--` that is not here is refused
 * (`rejectUnknownFlags`) rather than ignored.
 *
 * Silently ignoring was the old behaviour and it cost a real forge write: a
 * reviewer passed `--print-only` — a genuine flag on `vinaya waiver`, and a
 * reasonable guess here — intending a dry run, and this command posted the
 * verdict anyway (atta-labs/vinaya#184). The failure direction is the wrong
 * one: the caller's intent was "do not post", and the outcome was a governance
 * verdict on a real PR, consumed by a blocking merge gate. `--print-only`
 * (task 6, #397) is now a real flag here too, closing that gap: it renders,
 * runs the exact same `checkRenderedComment` self-check a real post would,
 * prints the result, and returns — never calling `postComment`, never
 * re-fetching the forge to self-verify a write that never happened.
 *
 * Declaring the VALUE-taking flags separately also retires the `--json`
 * special case rather than adding a second one beside it. The scan consumes
 * the next token as a value, so a nullary flag left in it is misread as the
 * next flag's value and the flag after that vanishes — found live in PR #144,
 * fixed then for `--json` alone. Knowing which flags take values fixes the
 * class.
 */
const VALUE_FLAGS = [
  '--brief-conformance',
  '--config-scan',
  '--cost',
  '--docs',
  '--escalate',
  '--findings-file',
  '--model',
  '--objectives-file',
  '--pr',
  '--role',
  '--scope',
  '--scope-evidence-file',
  '--secrets',
  '--secrets-evidence-file',
  '--spec-conformance',
  '--summary',
  '--task-id',
  '--tests',
  '--tokens-in',
  '--tokens-out',
  '--verdict'
] as const
const NULLARY_FLAGS = ['--json', '--print-only'] as const

/**
 * Exported so `review-post.test.ts` can re-derive this surface from the source
 * and prove the tables cover it. The first version of this table omitted
 * `--tokens-in`/`--tokens-out`, which made the command refuse the exact
 * invocation `roles/reviewer.md` prescribes AND that `requireTokenField`
 * demands two lines later — a refusal loop with no way out, in the one command
 * whose job is to post an honest verdict. A hand-kept list of a thing the file
 * already states is a second copy, and the second copy is the one that rots.
 */
export const FLAG_TABLES = { value: VALUE_FLAGS, nullary: NULLARY_FLAGS } as const

/**
 * Every unrecognised `--flag` in `args`, in order. PURE — it decides, it does
 * not exit, so the decision is unit-testable without a process boundary.
 */
export function unknownFlags(args: string[], known: readonly string[] = [...VALUE_FLAGS, ...NULLARY_FLAGS]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    // Position first, shape second. A token consumed as the VALUE of a known
    // value flag is never a flag, whatever it looks like — `--scope "- clean"`,
    // `--cost "-$1.20"` and `--tests "-.5% regression"` are all legitimate, and
    // a shape-only heuristic refused every one of them with no way to pass the
    // text at all.
    if (known.includes(a) && !NULLARY_FLAGS.includes(a as (typeof NULLARY_FLAGS)[number])) {
      // Skip the value exactly as `parseFlags` consumes it — and it declines a
      // `--`-prefixed token, so `--pr --bogus 178` still reports `--bogus`
      // rather than swallowing it as a value.
      const next = args[i + 1]
      if (next !== undefined && !next.startsWith('--')) i++
      continue
    }
    // `--` is the POSIX end-of-options marker, not a flag named `--`. Refusing
    // it with a list of valid flags would explain nothing. `parseFlags` stops
    // at the same token, so the two agree about where the options end — an
    // earlier version of this comment asserted that agreement without it
    // holding, which let an argument past the marker override a real flag.
    if (a === '--') break
    // A single dash is the near-miss that motivated this: `-print-only` is one
    // keystroke from the spelling that shipped a verdict nobody asked for.
    const looksLikeFlag = a.startsWith('--') || (a.startsWith('-') && a.length > 1)
    if (!looksLikeFlag) continue
    const name = a.split('=')[0] as string
    if (!known.includes(name)) {
      out.push(name)
      continue
    }
    // `--json=true` reads as known, then `args.includes('--json')` is false and
    // the caller silently gets no JSON. A nullary flag takes no value.
    if (NULLARY_FLAGS.includes(name as (typeof NULLARY_FLAGS)[number]) && a.includes('=')) out.push(name)
  }
  return out
}

/** Refuses when `unknownFlags` finds any, naming all of them. */
export function rejectUnknownFlags(
  args: string[],
  known: readonly string[] = [...VALUE_FLAGS, ...NULLARY_FLAGS]
): void {
  // `unknownFlags` returns names only, never `--flag=value` — a refusal is
  // printed to stderr and lands in CI logs, and an argv value can be a token.
  const unknown = unknownFlags(args, known)
  if (unknown.length === 0) return
  refuseCmd(
    `unrecognised flag${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}.`,
    `\`vinaya review post\` accepts: ${[...known].sort().join(', ')}. If you meant to preview without posting, pass \`--print-only\` — see atta-labs/vinaya#184.`
  )
}

/** Every prior id named with a state, or the invocation is refused before either forge write below it runs. */
function checkRoundTwo(
  pr: string,
  resolvedHead: string,
  comments: readonly ReviewGateComment[],
  principalAllowlist: readonly string[],
  extract: (comments: string[]) => VerdictExtraction,
  findings: readonly Finding[],
  blockingSeverities: readonly string[],
  objectiveResults: readonly ObjectiveResult[] | null
): void {
  const priorBody = findPriorVerdictComment(principalBodies(comments, principalAllowlist), extract)
  if (priorBody === null) return // round one: no round-two checks apply.

  const { ids: priorIds, objectiveIds: priorObjectiveIds, judgedHead } = parsePriorFindingIds(priorBody)
  const missing = missingPriorIds(priorIds, findings)
  if (missing.length > 0) {
    refuseCmd(
      `This findings file drops prior finding${missing.length > 1 ? 's' : ''} ${missing.join(', ')} without a state — a re-review reports the state of every prior id (open, fix-claimed, reproduced, resolved) before listing anything new.`,
      `Add a line whose description begins \`${missing[0] as string} <class> <state>:\` for each id listed, then re-run.`
    )
  }

  // `#412`, O1: every prior objective reappears in a re-review, the same rule
  // `missingPriorIds` already applies to findings — never dropped silently.
  const newObjectiveIds = new Set((objectiveResults ?? []).map((r) => r.id))
  const missingObjectives = priorObjectiveIds.filter((id) => !newObjectiveIds.has(id))
  if (missingObjectives.length > 0) {
    refuseCmd(
      `This objectives file drops prior objective${missingObjectives.length > 1 ? 's' : ''} ${missingObjectives.join(', ')} — a re-review restates every prior objective's MET/NOT MET status.`,
      `Add a line for ${missingObjectives[0] as string} to the objectives file, then re-run.`
    )
  }

  if (judgedHead === null) return // the prior comment carries no `Judged head:` line — cannot bound a delta.
  // A carried-forward id (any state) is the record of a prior finding, never new scope — the
  // delta filter below applies only to newly-raised, id-less non-blocking findings (round 6
  // ruling on #392, F1: missingPriorIds demands every prior id restated, and restating one at
  // its true location must not then be refused by the very filter that demanded it).
  const newlyRaised = findings.filter((f) => {
    const id = findingIdState(f.description)?.id
    return id === undefined || !priorIds.includes(id)
  })
  const nonBlocking = newlyRaised.filter((f) => !blockingSeverities.includes(f.severity))
  const changedRanges = computeChangedRanges(pr, judgedHead, resolvedHead)
  const outside = findingsOutsideDelta(nonBlocking, changedRanges)
  if (outside.length > 0) {
    refuseCmd(
      `Non-blocking finding at ${(outside[0] as Finding).location} is outside the diff since the previously judged head ${judgedHead} — round two is delta-only for non-blocking severities.`,
      'Drop it from this round, or wait for the Principal to move it into scope at the next round; a BLOCKER/CRITICAL/HIGH finding is always accepted regardless of delta.'
    )
  }
}

export async function reviewPostCommand(args: string[]): Promise<void> {
  // Before anything is rendered or resolved: an unknown flag here means the
  // caller asked for something this command does not do, and posting anyway
  // is the one outcome that cannot be taken back.
  rejectUnknownFlags(args)
  const json = args.includes('--json')
  const printOnly = args.includes('--print-only')
  const flags = parseFlags(args.filter((a) => !NULLARY_FLAGS.includes(a as (typeof NULLARY_FLAGS)[number])))

  const role = flags.get('--role')
  if (role !== 'code-reviewer' && role !== 'security') {
    refuseCmd(
      `\`--role ${role ?? '(missing)'}\` is not \`code-reviewer\` or \`security\`.`,
      'Pass `--role code-reviewer` or `--role security`.'
    )
  }

  const pr = requireFlag(flags, '--pr')
  const taskId = requireFlag(flags, '--task-id')
  const model = requireFlag(flags, '--model')
  const tokensIn = requireTokenField(flags, '--tokens-in')
  const tokensOut = requireTokenField(flags, '--tokens-out')
  const cost = requireFlag(flags, '--cost')
  const sessionId = resolveSessionId(process.env)
  const tokens: TokensInput = { taskId, model, tokensIn, tokensOut, cost, sessionId }
  const roleLabel: 'Reviewer' | 'Security' = role === 'code-reviewer' ? 'Reviewer' : 'Security'
  const tokensRole: 'review' | 'security' = role === 'code-reviewer' ? 'review' : 'security'

  const escalateRaw = flags.get('--escalate')
  const verdictRaw = flags.get('--verdict')

  // --- escalation: its own outcome, refused together with a verdict, before
  // any forge contact — never a finding stuffed inside a REQUEST CHANGES.
  if (escalateRaw !== undefined) {
    if (verdictRaw !== undefined) {
      refuseCmd(
        '`--escalate` was given together with `--verdict` — an escalation is its own review outcome, never posted alongside a verdict.',
        'Pass either `--escalate <class> --summary <text>` or `--verdict ...`, not both.'
      )
    }
    if (!isEscalationClass(escalateRaw)) {
      refuseCmd(
        `\`--escalate ${escalateRaw || '(empty)'}\` is not \`authority\`, \`strategy\`, or \`product\`.`,
        'Pass `--escalate authority`, `--escalate strategy`, or `--escalate product`.'
      )
    }
    if (flags.get('--objectives-file') !== undefined) {
      refuseCmd(
        '`--escalate` was given together with `--objectives-file` — an escalation carries no OBJECTIVES: block, only the version line.',
        'Drop `--objectives-file` from an escalation, or post a verdict instead if there are objectives to judge.'
      )
    }
    const summary = requireFlag(flags, '--summary')
    const allowedSeverities = role === 'code-reviewer' ? CODE_REVIEW_SEVERITIES : SECURITY_SEVERITIES
    const blockingSeverities: readonly string[] = role === 'code-reviewer' ? ['BLOCKER'] : ['CRITICAL', 'HIGH']
    const findings = readFindingsFile(flags.get('--findings-file'), allowedSeverities)
    if (findings.some((f) => blockingSeverities.includes(f.severity))) {
      refuseCmd(
        `Findings include a ${blockingSeverities.join('/')} finding — that drives a verdict, not an escalation. An escalation carries no blocking finding.`,
        'Post the verdict instead (`--verdict ...`), or drop the blocking finding from the escalation.'
      )
    }
    const headSha = resolveHeadSha(pr)
    const escalationObjectivesResolution = resolveObjectivesForPr(pr)
    const escalationObjectivesVersion =
      escalationObjectivesResolution.kind === 'list' ? escalationObjectivesResolution.version : null
    const body = renderEscalationComment({
      ...tokens,
      headSha,
      escalationClass: escalateRaw,
      summary,
      role: tokensRole,
      roleLabel,
      objectivesVersion: escalationObjectivesVersion
    })
    checkRenderedCommentOrRefuse(body, { kind: 'escalation' })
    if (printOnly) {
      printOnlyResult(json, role, headSha, body)
      return
    }
    const url = postComment(pr, body)

    let comments: ReviewGateComment[]
    try {
      comments = fetchComments(pr)
    } catch (err) {
      refuseCmd(
        `Posted the escalation (${url}) but could not re-fetch PR ${pr}'s comments to self-verify: ${err instanceof Error ? err.message : String(err)}`,
        'Check `gh auth status`/network and manually confirm the posted comment carries no VERDICT line — this command could not verify it.'
      )
    }
    const result = verifyPostedEscalation(comments, body)
    if (!result.ok) {
      refuseCmd(
        `Posted escalation ${url}, but self-verification FAILED: ${result.reason}`,
        'Do not treat the post as valid — inspect the comment and this command for drift, fix, and re-run.'
      )
    }

    if (json) {
      printJson({ posted: true, url, role, headSha, escalationClass: escalateRaw, selfVerified: true })
    } else {
      process.stdout.write(`${body}\n\nPosted: ${url}\nSelf-verification: clean — no verdict extracted.\n`)
    }
    return
  }

  if (role === 'code-reviewer') {
    const findings = readFindingsFile(flags.get('--findings-file'), CODE_REVIEW_SEVERITIES)
    const derived = deriveCodeReviewVerdict(findings)
    if (verdictRaw !== undefined) {
      const explicit = normalizeCodeReviewVerdict(verdictRaw)
      if (explicit !== derived) {
        refuseCmd(
          `\`--verdict ${verdictRaw}\` disagrees with the derived verdict \`${derived}\` — reviewer.md: the verdict is derived from the findings file, not hand-typed.`,
          `Pass \`--verdict ${derived}\`, omit \`--verdict\` and let it derive, or fix a finding's severity if the derivation is wrong.`
        )
      }
    }
    const verdict = derived

    const briefConformance = requireFlag(flags, '--brief-conformance')
    const specConformance = requireFlag(flags, '--spec-conformance')
    const scope = requireFlag(flags, '--scope')
    const tests = requireFlag(flags, '--tests')
    const docs = requireFlag(flags, '--docs')
    const scopeEvidenceFile = flags.get('--scope-evidence-file')
    let scopeEvidence: string | null = null
    if (scopeEvidenceFile) {
      try {
        scopeEvidence = readFileSync(scopeEvidenceFile, 'utf8')
      } catch {
        refuseCmd(`Could not read scope evidence file at ${scopeEvidenceFile}.`, 'Check the path and re-run.')
      }
    }

    const principalAllowlist = resolvePrincipalAllowlist(loadTrustAnchorConfig())

    const headSha = resolveHeadSha(pr)

    const objectivesResolution = resolveObjectivesForPr(pr)
    const { objectivesVersion: resolvedObjectivesVersion, objectiveResults } = resolveObjectiveResultsForCommand(
      objectivesResolution,
      flags.get('--objectives-file')
    )
    refuseIfCleanVerdictHasNotMetObjective(isCleanVerdict(verdict), 'APPROVE', objectiveResults)

    let comments: ReviewGateComment[]
    try {
      comments = fetchComments(pr)
    } catch (err) {
      refuseCmd(
        `Could not fetch PR ${pr}'s comments to check for a prior review round: ${err instanceof Error ? err.message : String(err)}`,
        'Check `gh auth status`/network, then re-run.'
      )
    }
    checkRoundTwo(
      pr,
      headSha,
      comments,
      principalAllowlist,
      extractCodeReviewVerdict,
      findings,
      ['BLOCKER'],
      objectiveResults
    )

    const input: CodeReviewInput = {
      ...tokens,
      headSha,
      verdict,
      briefConformance,
      specConformance,
      findings,
      scope,
      scopeEvidence,
      tests,
      docs,
      objectivesVersion: resolvedObjectivesVersion,
      objectiveResults
    }
    const body = renderCodeReviewComment(input)
    checkRenderedCommentOrRefuse(body, { kind: 'code-review', verdict })
    if (printOnly) {
      printOnlyResult(json, role, headSha, body)
      return
    }
    const url = postComment(pr, body)

    let postComments: ReviewGateComment[]
    try {
      postComments = fetchComments(pr)
    } catch (err) {
      refuseCmd(
        `Posted the comment (${url}) but could not re-fetch PR ${pr}'s comments to self-verify: ${err instanceof Error ? err.message : String(err)}`,
        'Check `gh auth status`/network and manually confirm the posted comment parses cleanly — this command could not verify it.'
      )
    }
    const result = verifyPostedCodeReview(
      postComments,
      verdict,
      headSha,
      principalAllowlist,
      body,
      resolvedObjectivesVersion
    )
    if (!result.ok) {
      refuseCmd(
        `Posted comment ${url}, but self-verification FAILED on re-parse: ${result.reason}`,
        'The posted comment does not re-parse clean through the same extractCodeReviewVerdict/extractSecurityReviewVerdict functions the merge gate calls. Do not treat the post as valid — inspect the comment and this command for drift, fix, and re-run.'
      )
    }

    if (json) {
      printJson({ posted: true, url, role, headSha, selfVerified: true })
    } else {
      process.stdout.write(
        `${body}\n\nPosted: ${url}\nSelf-verification: clean — re-parsed VERDICT is bound to head ${headSha}.\n`
      )
    }
    return
  }

  // role === 'security'
  const findings = readFindingsFile(flags.get('--findings-file'), SECURITY_SEVERITIES)
  const derived = deriveSecurityVerdict(findings)
  if (verdictRaw !== undefined) {
    const explicit = normalizeSecurityVerdict(verdictRaw)
    if (explicit !== derived) {
      refuseCmd(
        `\`--verdict ${verdictRaw}\` disagrees with the derived verdict \`${derived}\` — security.md: the verdict is derived from the findings file, not hand-typed.`,
        `Pass \`--verdict ${derived}\`, omit \`--verdict\` and let it derive, or fix a finding's severity if the derivation is wrong.`
      )
    }
  }
  const verdict = derived

  const configScan = requireFlag(flags, '--config-scan')
  const secrets = requireFlag(flags, '--secrets')
  const secretsEvidenceFile = flags.get('--secrets-evidence-file')
  if (isNoneFoundClaim(secrets) && !secretsEvidenceFile) {
    refuseCmd(
      '`--secrets` normalizes to "none found" but no `--secrets-evidence-file` was given — security.md: "SECRETS: none found" with no scan output pasted is an unbacked self-attestation.',
      'Pass `--secrets-evidence-file <path>` containing the actual scanner output, or change `--secrets` to describe what was found instead.'
    )
  }
  let secretsEvidence: string | null = null
  if (secretsEvidenceFile) {
    try {
      secretsEvidence = readFileSync(secretsEvidenceFile, 'utf8')
    } catch {
      refuseCmd(`Could not read secrets evidence file at ${secretsEvidenceFile}.`, 'Check the path and re-run.')
    }
  }
  const principalAllowlist = resolvePrincipalAllowlist(loadTrustAnchorConfig())

  const headSha = resolveHeadSha(pr)

  const objectivesResolution = resolveObjectivesForPr(pr)
  const { objectivesVersion: resolvedObjectivesVersion, objectiveResults } = resolveObjectiveResultsForCommand(
    objectivesResolution,
    flags.get('--objectives-file')
  )
  refuseIfCleanVerdictHasNotMetObjective(isCleanVerdict(verdict), 'PASS', objectiveResults)

  let comments: ReviewGateComment[]
  try {
    comments = fetchComments(pr)
  } catch (err) {
    refuseCmd(
      `Could not fetch PR ${pr}'s comments to check for a prior review round: ${err instanceof Error ? err.message : String(err)}`,
      'Check `gh auth status`/network, then re-run.'
    )
  }
  checkRoundTwo(
    pr,
    headSha,
    comments,
    principalAllowlist,
    extractSecurityReviewVerdict,
    findings,
    ['CRITICAL', 'HIGH'],
    objectiveResults
  )

  const input: SecurityInput = {
    ...tokens,
    headSha,
    verdict,
    findings,
    configScan,
    secrets,
    secretsEvidence,
    objectivesVersion: resolvedObjectivesVersion,
    objectiveResults
  }
  const body = renderSecurityComment(input)
  checkRenderedCommentOrRefuse(body, { kind: 'security', verdict })
  if (printOnly) {
    printOnlyResult(json, role, headSha, body)
    return
  }
  const url = postComment(pr, body)

  let postComments: ReviewGateComment[]
  try {
    postComments = fetchComments(pr)
  } catch (err) {
    refuseCmd(
      `Posted the comment (${url}) but could not re-fetch PR ${pr}'s comments to self-verify: ${err instanceof Error ? err.message : String(err)}`,
      'Check `gh auth status`/network and manually confirm the posted comment parses cleanly — this command could not verify it.'
    )
  }
  const result = verifyPostedSecurity(
    postComments,
    verdict,
    headSha,
    principalAllowlist,
    body,
    resolvedObjectivesVersion
  )
  if (!result.ok) {
    refuseCmd(
      `Posted comment ${url}, but self-verification FAILED on re-parse: ${result.reason}`,
      'The posted comment does not re-parse clean through the same extractCodeReviewVerdict/extractSecurityReviewVerdict functions the merge gate calls. Do not treat the post as valid — inspect the comment and this command for drift, fix, and re-run.'
    )
  }

  if (json) {
    printJson({ posted: true, url, role, headSha, selfVerified: true })
  } else {
    process.stdout.write(
      `${body}\n\nPosted: ${url}\nSelf-verification: clean — re-parsed VERDICT is bound to head ${headSha}.\n`
    )
  }
}
