/**
 * `dev-review-loop`'s reviewer-dispatch-and-report-parsing concern
 * (task 8, `#506`, O8) — the reviewer's own prompt,
 * the held-verdict outbox, the `findings.txt`/`objectives.txt`/`report.txt`
 * grammar, and turning a reviewer's own report into a rendered verdict via
 * `buildVerdictFromReport` (which calls `@attalabs/aeg-core`'s pure
 * evaluator through `deriveCodeReviewVerdict`/`deriveSecurityVerdict` —
 * which severities block is repository policy, never a literal here).
 * Moved out of `apps/cli/src/lib/dev-review-loop.ts` verbatim;
 * `dev-review-loop.ts` stays the composition root, re-exporting every name
 * below under the same path it always had.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CODE_REVIEW_SEVERITY_ORDER,
  SECURITY_SEVERITY_ORDER,
  type ReviewPolicy,
  type VerdictObservation
} from '@attalabs/aeg-core'
import {
  deriveCodeReviewVerdict,
  deriveSecurityVerdict,
  type EscalationClass,
  type Finding,
  FindingsParseError,
  isEscalationClass,
  type ObjectiveResult,
  ObjectivesParseError,
  parseFindingsFile,
  parseObjectivesFile,
  renderCodeReviewComment,
  renderEscalationComment,
  renderSecurityComment
} from '../../commands/review-post.js'
import type { AgentVendor, DispatchHandle } from '../dispatch.js'
import { GLOBAL_VINAYA_HOME } from '../config.js'

// --- reviewer prompt (facts only) -----------------------------------------

export type ReviewerPromptFacts = {
  objectives: string
  /** `resolveIssueObjectives`'s version for `objectives`, captured at dispatch time — threaded into the held verdict (O2) and re-checked at assessment time (O3). `null` alongside an empty `objectives`. */
  objectivesVersion: string | null
  rulings: string[]
  /** The newest principal ruling ordinal on this PR, captured at dispatch time (task 3, `#477`, O1) — `0` when `rulings` is empty. Threaded into the held verdict and re-checked at assessment time (O3), same shape as `objectivesVersion`. */
  rulingOrdinal: number
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

export function heldVerdictPath(root: string, task: number, round: number, role: 'reviewer' | 'security'): string {
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

/** O5: removes both held-verdict files for a round whose head fell into conflict after reviewers judged it — nothing is published against a head that cannot merge. Missing files are not an error (a round can hold only one role's verdict, or none). */
export function discardHeldVerdicts(root: string, task: number, round: number): void {
  for (const role of ['reviewer', 'security'] as const) {
    try {
      unlinkSync(heldVerdictPath(root, task, round, role))
    } catch {
      // Not held for this round — nothing to discard.
    }
  }
}

/**
 * `attempt` 1 is the round's normal work directory (unchanged path, so an
 * existing fixture/fake that never retries keeps working unmodified);
 * `attempt` 2 is a genuinely fresh directory for O2's one retry — never the
 * same directory a failed first attempt already touched, per the loop
 * spec's collect rule (Traps to avoid: never resume a crashed reviewer).
 */
export function reviewerWorkDir(
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
export function missingReviewerArtifacts(workDir: string, hasObjectives: boolean): string[] {
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

/**
 * Thrown by `buildVerdictFromReport` when `findings.txt`/`objectives.txt`
 * still does not parse (task 8, `#506`, O6) — the file
 * exists (`missingReviewerArtifacts` already passed), but a line inside it
 * is malformed beyond `parseFindingsFile`/`parseObjectivesFile`'s own
 * tolerance (a status that starts with neither `MET` nor `NOT MET`, a
 * findings line with fewer than two `|` delimiters). `dispatchReviewer`
 * gives this the SAME one-fresh-retry treatment as a missing artifact; a
 * second miss propagates here and the loop turns it into `{ type: 'pause',
 * reason: 'infrastructure' }` — naming the file, the line (already inside
 * `parseError.message`), and the reviewer's session id — never an uncaught
 * throw that crashes the driver.
 */
export class ReviewerReportParseFailure extends Error {
  constructor(
    public readonly role: 'reviewer' | 'security',
    public readonly file: 'findings.txt' | 'objectives.txt' | 'report.txt',
    public readonly sessionId: string,
    public readonly parseError: Error
  ) {
    super(`${role}'s ${file} did not parse (session ${sessionId}): ${parseError.message}`)
  }
}
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

export function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

export type RoundVerdictParse = { observation: VerdictObservation; rendered: string }

export function buildVerdictFromReport(
  role: 'reviewer' | 'security',
  workDir: string,
  headSha: string,
  agent: AgentVendor,
  taskId: number,
  handle: DispatchHandle,
  objectivesVersionAtDispatch: string | null,
  rulingOrdinalAtDispatch: number,
  policy: ReviewPolicy
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
      rulingOrdinal: rulingOrdinalAtDispatch,
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
  const allowedSeverities = role === 'reviewer' ? CODE_REVIEW_SEVERITY_ORDER : SECURITY_SEVERITY_ORDER
  // O6: a line that still does not parse — tolerant of a qualified status
  // and a `|` in a description, but still not a valid line — is an
  // infrastructure pause, never an uncaught throw that crashes the driver.
  let findings: Finding[]
  try {
    findings = findingsRaw.trim() ? parseFindingsFile(findingsRaw, allowedSeverities) : []
  } catch (err) {
    if (err instanceof FindingsParseError) {
      throw new ReviewerReportParseFailure(role, 'findings.txt', sessionId, err)
    }
    throw err
  }

  const objectivesRaw = readIfExists(join(workDir, 'objectives.txt'))
  let objectiveResults: ObjectiveResult[]
  try {
    objectiveResults = objectivesRaw?.trim() ? parseObjectivesFile(objectivesRaw) : []
  } catch (err) {
    if (err instanceof ObjectivesParseError) {
      throw new ReviewerReportParseFailure(role, 'objectives.txt', sessionId, err)
    }
    throw err
  }
  const objectives = objectiveResults.map((o) => ({ id: o.id, met: o.status === 'MET' }))
  // O2: a version renders alongside its `OBJECTIVES:` block, or neither
  // renders — `review-post.ts`'s `CodeReviewInput`/`SecurityInput` contract
  // (`objectiveResults` non-null iff `objectivesVersion` non-null).
  const renderedObjectiveResults = objectivesVersionAtDispatch !== null ? objectiveResults : null

  const findingObservations = findings.map((f, i) => ({ id: `F${i + 1}`, severity: f.severity, state: null }))

  if (role === 'reviewer') {
    const verdict = deriveCodeReviewVerdict(findings, policy)
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
      rulingOrdinal: rulingOrdinalAtDispatch,
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

  // O3: `report.SECRETS` is required output, not an optional prose field
  // like `CONFIG_SCAN` — unlike those, `security.md`'s own "none found" is a
  // CLEAN self-attestation, so a missing or blank key can never fall back to
  // it the way `CONFIG_SCAN` falls back to the honestly-absent
  // `'(not reported)'`. Defaulting a missing key to "none found" would
  // fabricate a clean claim for a reviewer session that crashed or forgot
  // the line — the exact `findings.txt`/`objectives.txt` failure mode this
  // module already turns into an infrastructure pause, extended to this key.
  if (!report.SECRETS?.trim()) {
    throw new ReviewerReportParseFailure(
      role,
      'report.txt',
      sessionId,
      new Error('missing required `SECRETS:` line — a security reviewer must always report one')
    )
  }

  const verdict = deriveSecurityVerdict(findings, policy)
  const rendered = renderSecurityComment({
    headSha,
    verdict,
    findings,
    configScan: report.CONFIG_SCAN ?? '(not reported)',
    secrets: report.SECRETS,
    secretsEvidence: null,
    objectivesVersion: objectivesVersionAtDispatch,
    objectiveResults: renderedObjectiveResults,
    rulingOrdinal: rulingOrdinalAtDispatch,
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
export function hasObjectivesFacts(facts: ReviewerPromptFacts): boolean {
  return facts.objectives.trim().length > 0
}

export function renderReviewerDispatchPrompt(
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
    '`|` never appears in a description — write the finding without one, even inside a quoted or piped example.',
    ...(hasObjectivesFacts(facts)
      ? [
          `Write one line per objective listed above to ${join(workDir, 'objectives.txt')}: O<n>|MET|<evidence> or O<n>|NOT MET|<evidence> — the status is read by its bare leading word (MET or NOT MET); write nothing else before it on that field.`
        ]
      : []),
    `Write a short report to ${join(workDir, 'report.txt')} as one \`KEY: value\` line per field:`,
    role === 'reviewer' ? '  BRIEF_CONFORMANCE, SPEC_CONFORMANCE, SCOPE, TESTS, DOCS' : '  CONFIG_SCAN, SECRETS',
    ...(role === 'security'
      ? [
          '`SECRETS:` is required — never leave it blank or omit it, even when you found nothing: write `SECRETS: none found` only after you actually checked.'
        ]
      : []),
    'To escalate instead of casting a verdict, write only `ESCALATE: authority|strategy|product` and `SUMMARY: <text>` to report.txt.'
  ].join('\n')
  return `${base}\n\n${instructions}`
}
