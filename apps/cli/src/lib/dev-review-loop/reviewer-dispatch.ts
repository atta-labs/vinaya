/**
 * `dev-review-loop`'s reviewer-dispatch-and-report-parsing concern
 * — the reviewer's own prompt,
 * the held-verdict outbox, the `findings.txt`/`objectives.txt`/`report.txt`
 * grammar, and turning a reviewer's own report into a rendered verdict via
 * `buildVerdictFromReport` (which calls `@attalabs/aeg-core`'s pure
 * evaluator through `deriveCodeReviewVerdict`/`deriveSecurityVerdict` —
 * which severities block is repository policy, never a literal here).
 * Moved out of `apps/cli/src/lib/dev-review-loop.ts` verbatim;
 * `dev-review-loop.ts` stays the composition root, re-exporting every name
 * below under the same path it always had.
 */

import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CODE_REVIEW_SEVERITY_ORDER,
  codeReviewBlockingSeverities,
  defaultControlStoreDeps,
  extractCodeReviewVerdict,
  extractSecurityReviewVerdict,
  isProseLocation,
  type ManifestInput,
  type ManifestRecord,
  type Objective,
  PROSE_CAP_SEVERITY,
  type ReviewInputManifest,
  SECURITY_SEVERITY_ORDER,
  securityBlockingSeverities,
  type ReviewPolicy,
  type VerdictObservation,
  writeManifest
} from '@attalabs/aeg-core'
import {
  checkObjectiveIdCoverage,
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
import { ensureRunDir, runPath, runtimeDirForThisRepo, tasksExecutionRoot } from '../run-paths.js'

// --- reviewer prompt (facts only) -----------------------------------------

export type ReviewerPromptFacts = {
  objectives: string
  /** The `objectives` text, parsed — `[]` exactly when `objectives` is empty. Threaded into `buildVerdictFromReport`'s own `checkObjectiveIdCoverage` call, the same coverage rule `review post` already applies. */
  resolvedObjectives: readonly Objective[]
  rulings: string[]
  ciConclusion: 'green' | 'red' | 'pending'
  /** The frozen brief's own `**Revision:**` fact — `fetchSourceRevision`. */
  revision: string
  /**
   * The one review-input manifest — head, the frozen brief's own hash, objectives version, ruling
   * ordinal, and the effective review policy's digest, built by the driver
   * BEFORE this dispatch. The only source of `HEAD:` in the rendered prompt
   * below and of every structural line `buildVerdictFromReport` renders —
   * `objectivesVersion`/`rulingOrdinal` are no longer separate fields here.
   */
  manifest: ReviewInputManifest
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
    `HEAD: ${facts.manifest.headSha}`,
    `CI: ${facts.ciConclusion}`,
    `BRIEF REVISION: ${facts.revision}`
  ].join('\n')
}

// --- held-verdict outbox ---------------------------------------------------

/**
 * The runtime directory every file this task's run writes lives under
 * (`run-paths.ts`). Threaded through the driver as `d.runtimeDir()` so a
 * test points the whole loop at a temporary tree with one dep, exactly as
 * it used to point `d.outboxRoot()` at one.
 *
 * This replaces an `outboxRoot()` that meant two different things at once:
 * the telemetry outbox `log-sink.ts` writes to, AND a `dev-review-loop/<task>/`
 * tree of driver files that had no business living inside it. The telemetry
 * outbox keeps its own home and its own resolution; only the driver files
 * moved.
 */
export function runtimeDir(): string {
  return runtimeDirForThisRepo()
}

// --- parent-built manifest record (task 5, O1) ---

/**
 * The control-store root, derived from the same runtime directory the
 * driver already threads for its held verdicts and effect records
 * (`d.runtimeDir()`), never a global constant a test cannot redirect.
 *
 * This and `effects.ts`'s own `controlStoreRoot()` used to resolve two
 * DIFFERENT directories — a manifest record and an ownership epoch for one
 * task landed in separate trees. Both now resolve the one directory holding
 * that task's folder, and the store puts its records in the folder's own
 * `control/` subdirectory.
 */
export function controlStoreRootFor(runtime: string): string {
  return tasksExecutionRoot(runtime)
}

/** What the parent must supply beyond the manifest itself to persist a record — the repository and work identity a manifest snapshot carries but the `ReviewInputManifest` binding type does not (O1). */
export type ManifestRecordIdentity = {
  /** Repository identity — `owner/repo`. */
  repository: string
  /** Work identity — the PR this round's candidate lives on. */
  pr: number
  /** Work identity — the branch under review. */
  branch: string
  round: number
  recordedAt: string
}

/**
 * Assembles the durable manifest record the parent persists before dispatching
 * reviewers (O1) — the binding manifest (`baseSha`/`headSha`/
 * `briefHash`/`objectivesVersion`/`rulingOrdinal`/`policyDigest`) plus the
 * repository and work identity the store record keys on. Pure — no I/O, no
 * clock; `recordedAt` is supplied by the caller (the driver's own injected
 * `now`), never read here, so this stays testable without a real clock.
 */
export function buildManifestRecord(manifest: ReviewInputManifest, identity: ManifestRecordIdentity): ManifestInput {
  return {
    round: identity.round,
    repository: identity.repository,
    pr: identity.pr,
    branch: identity.branch,
    baseSha: manifest.baseSha,
    headSha: manifest.headSha,
    briefHash: manifest.briefHash,
    objectivesVersion: manifest.objectivesVersion,
    rulingOrdinal: manifest.rulingOrdinal,
    policyDigest: manifest.policyDigest,
    recordedAt: identity.recordedAt
  }
}

/**
 * Persists the round's manifest snapshot to the control store (O1),
 * built by the parent from the manifest it dispatched reviewers against.
 * `runtime` is the driver's own `d.runtimeDir()`; the record lands under
 * `controlStoreRootFor(runtime)`. Best-effort by design: a failed write is
 * returned as `null`, never thrown — the loop's own binding (`compareManifest`
 * over the echoed comment) is what actually gates a verdict, and a durable
 * snapshot that could not be written must never be able to fail a round the
 * way the paperwork-must-not-cost-a-round rule the evidence report already
 * follows.
 */
export function persistManifestRecord(
  runtime: string,
  task: number,
  manifest: ReviewInputManifest,
  identity: ManifestRecordIdentity
): ManifestRecord | null {
  try {
    return writeManifest(
      defaultControlStoreDeps(() => controlStoreRootFor(runtime)),
      task,
      identity.round,
      buildManifestRecord(manifest, identity)
    )
  } catch {
    return null
  }
}

export function heldVerdictPath(root: string, task: number, round: number, role: 'reviewer' | 'security'): string {
  return runPath(root, task, { area: 'round', round, file: `${role}.md` })
}

/** One file per verdict, in that round's own folder: `<runtimeDir>/tasks-execution/<task>/rounds/<round>/<role>.md`. Real `fs.writeFileSync`, never `gh pr comment` — the held verdict lives here until publication (`publishRound`, below) posts it. */
export function writeHeldVerdict(
  root: string,
  task: number,
  round: number,
  role: 'reviewer' | 'security',
  renderedComment: string
): void {
  ensureRunDir(runPath(root, task, { area: 'round', round }))
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

export type HeldRequestChanges = { round: number; head: string; rendered: string }

/**
 * O4: the HIGHEST round number with any held
 * verdict file at all, read ONLY if its own reviewer AND security pair are
 * both still on disk and re-parse as REQUEST CHANGES — the durable,
 * machine-local record of "round k sent the developer back" a fresh attach
 * needs to recover from, since a restarted driver's in-memory `LoopState`
 * carries no round history at all. Never falls back to an OLDER round: a
 * clean highest pair means a later round already superseded whatever an
 * older REQUEST-CHANGES pair still sitting on disk once meant (round k+1
 * published, or is mid-publish, in the SAME process run that wrote it) —
 * treated as "nothing to recover," the same as no held state existing at
 * all, never as license to act on round k's now-stale findings instead.
 * `null` also when the highest round's two files disagree on which head
 * they judged, or when either fails to re-parse through the same
 * extractors `publishRound` itself trusts — an attach never guesses past
 * state that doesn't read clean.
 */
export function latestHeldRequestChanges(root: string, task: number): HeldRequestChanges | null {
  let entries: string[]
  try {
    entries = readdirSync(runPath(root, task, { area: 'rounds' }))
  } catch {
    return null
  }
  let highest = -1
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue
    const round = Number(name)
    if (existsSync(heldVerdictPath(root, task, round, 'reviewer'))) highest = Math.max(highest, round)
  }
  if (highest < 0) return null

  const reviewerBody = readIfExists(heldVerdictPath(root, task, highest, 'reviewer'))
  const securityBody = readIfExists(heldVerdictPath(root, task, highest, 'security'))
  if (!reviewerBody || !securityBody) return null
  const reviewer = extractCodeReviewVerdict([reviewerBody])
  const security = extractSecurityReviewVerdict([securityBody])
  if (reviewer.danglingNote || security.danglingNote) return null
  if (!reviewer.headSha || !security.headSha || reviewer.headSha !== security.headSha) return null
  if (reviewer.value === 'APPROVE' && security.value === 'PASS') return null
  return { round: highest, head: reviewer.headSha, rendered: `${reviewerBody}\n\n---\n\n${securityBody}` }
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
  return runPath(root, task, { area: 'round', round, file: `${role}-work${suffix}` })
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
 * a required artifact after its one fresh retry — caught by the loop
 * and turned into `{ type: 'pause', reason: 'infrastructure' }`, never read
 * as a clean verdict on any path.
 */
export class ReviewerInfrastructureFailure extends Error {
  constructor(
    public readonly role: 'reviewer' | 'security',
    public readonly missing: readonly string[],
    /**
     * Round 2 review, MAJOR: the last attempt's own `effect_id`/`durationMs`
     * (from its real `DispatchHandle`), so the caller's own failure
     * observation can carry this attempt's real evidence identity and
     * timing instead of a freshly generated id and the whole round's
     * elapsed time. `null` only when no attempt ever produced a handle
     * (never reachable today — `dispatchReviewer` always has one by the
     * time this throws — kept `null`-safe rather than assumed).
     */
    public readonly attemptEffectId: string | null = null,
    public readonly attemptDurationMs: number | null = null
  ) {
    super(`${role}'s work directory carried no ${missing.join(' and no ')} after a fresh dispatch and one fresh retry.`)
  }
}

/**
 * Thrown by `buildVerdictFromReport` when `findings.txt`/`objectives.txt`
 * still does not parse — the file
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
    public readonly parseError: Error,
    /** Round 2 review, MAJOR: this exact attempt's own `effect_id`/`durationMs`, from `buildVerdictFromReport`'s own `handle` parameter — see `ReviewerInfrastructureFailure`'s identical fields for why. */
    public readonly attemptEffectId: string | null = null,
    public readonly attemptDurationMs: number | null = null
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

/**
 * Prose never decides a round: a `NOT MET` whose evidence
 * names only a PR body section, a comment, or a role file — reused from
 * `@attalabs/aeg-core`'s `isProseLocation`, the SAME predicate
 * `evaluateReviewFindings`'s body-located `MINOR` cap already applies to a
 * finding's `location` field (that cap is untouched by this task; this is a
 * separate use of the same predicate, over an objective's `evidence` field
 * instead) — is reclassified `MET`, evidence annotated `(prose note)`,
 * before either the rendered verdict comment or `assessRound`'s own
 * `objectives` observation ever sees it. `aeg-root/roles/reviewer.md` and
 * `aeg-root/roles/security.md` tell the reviewer why: `NOT MET` requires a
 * code or test location now. A `NOT MET` naming a real source or test file
 * is untouched (`isProseLocation`'s own `FILE_SHAPED_LOCATION` gate) — this
 * never downgrades a real objective failure, only a prose-only citation of
 * one.
 */
export function reclassifyProseOnlyNotMet(results: readonly ObjectiveResult[]): ObjectiveResult[] {
  return results.map((r) =>
    r.status === 'NOT MET' && isProseLocation(r.evidence)
      ? { ...r, status: 'MET' as const, evidence: `${r.evidence} (prose note)` }
      : r
  )
}

/**
 * The SAME `isProseLocation`/threshold rule
 * `evaluateReviewFindings` applies internally (`@attalabs/aeg-core`) to
 * decide `outcome`/`blockingFindings` — recomputed here, over the SAME
 * finding, only to attach the resulting fact onto the finding's own
 * observation record, which that evaluator's return value has no room for
 * (`PolicyEvaluation.blockingFindings` is a filtered array, not an annotated
 * one — see this task's PR Decisions). `severity` itself is never
 * overwritten: this only ever changes how the finding COUNTS toward this
 * threshold, not what it reports (Traps to avoid: "retain reported severity
 * separately from the incoming prose cap").
 */
function policyTreatmentFor(finding: Finding, blockingSeverities: readonly string[]): 'blocking' | 'non_blocking' {
  const effectiveSeverity = isProseLocation(finding.location) ? PROSE_CAP_SEVERITY : finding.severity
  return blockingSeverities.includes(effectiveSeverity) ? 'blocking' : 'non_blocking'
}

export type RoundVerdictParse = { observation: VerdictObservation; rendered: string }

export function buildVerdictFromReport(
  role: 'reviewer' | 'security',
  workDir: string,
  agent: AgentVendor,
  taskId: number,
  handle: DispatchHandle,
  manifest: ReviewInputManifest,
  policy: ReviewPolicy,
  resolvedObjectives: readonly Objective[]
): RoundVerdictParse {
  const headSha = manifest.headSha
  const objectivesVersionAtDispatch = manifest.objectivesVersion
  const rulingOrdinalAtDispatch = manifest.rulingOrdinal
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
      briefHash: manifest.briefHash,
      policyDigest: manifest.policyDigest,
      baseSha: manifest.baseSha,
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
      throw new ReviewerReportParseFailure(
        role,
        'findings.txt',
        sessionId,
        err,
        handle.effectId ?? null,
        handle.durationMs
      )
    }
    throw err
  }

  const objectivesRaw = readIfExists(join(workDir, 'objectives.txt'))
  let objectiveResults: ObjectiveResult[]
  try {
    objectiveResults = objectivesRaw?.trim() ? parseObjectivesFile(objectivesRaw) : []
  } catch (err) {
    if (err instanceof ObjectivesParseError) {
      throw new ReviewerReportParseFailure(
        role,
        'objectives.txt',
        sessionId,
        err,
        handle.effectId ?? null,
        handle.durationMs
      )
    }
    throw err
  }
  // O4: the SAME coverage rule `review post`'s own
  // `resolveObjectiveResultsForCommand` already applies to a human-posted
  // verdict — an under-reporting reviewer (one that wrote fewer, or extra,
  // `O<n>|...` lines than the resolved objectives list) never yields a
  // version-bound verdict here either. Same one-fresh-retry treatment as a
  // missing or malformed artifact (`ReviewerReportParseFailure`), never a
  // silently-accepted partial report.
  if (resolvedObjectives.length > 0) {
    const coverageProblem = checkObjectiveIdCoverage(resolvedObjectives, objectiveResults)
    if (coverageProblem !== null) {
      throw new ReviewerReportParseFailure(
        role,
        'objectives.txt',
        sessionId,
        new Error(`objectives.txt does not cover the resolved objectives list exactly: ${coverageProblem}`),
        handle.effectId ?? null,
        handle.durationMs
      )
    }
  }
  // After coverage is checked against the reviewer's own
  // reported ids — reclassification only ever changes a result's `status`/
  // `evidence`, never drops or adds an id, so it cannot affect coverage
  // either way; checking coverage first just keeps that fact obviously true
  // by construction rather than by reasoning about ordering.
  objectiveResults = reclassifyProseOnlyNotMet(objectiveResults)
  const objectives = objectiveResults.map((o) => ({ id: o.id, met: o.status === 'MET' }))
  // O2: a version renders alongside its `OBJECTIVES:` block, or neither
  // renders — `review-post.ts`'s `CodeReviewInput`/`SecurityInput` contract
  // (`objectiveResults` non-null iff `objectivesVersion` non-null).
  const renderedObjectiveResults = objectivesVersionAtDispatch !== null ? objectiveResults : null

  // `severityScale`/`policyTreatment` populated
  // from real policy/finding data, never fabricated; `confidence` and its
  // siblings stay unset — no reviewer grammar reports one yet (optional,
  // self-reported: absent is honest, not a gap this task's own grammar
  // needs to close).
  const blockingSet = role === 'reviewer' ? codeReviewBlockingSeverities(policy) : securityBlockingSeverities(policy)
  const findingObservations = findings.map((f, i) => ({
    id: `F${i + 1}`,
    severity: f.severity,
    state: null,
    severityScale: role === 'reviewer' ? 'code-review' : 'security',
    policyTreatment: policyTreatmentFor(f, blockingSet)
  }))

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
      briefHash: manifest.briefHash,
      policyDigest: manifest.policyDigest,
      baseSha: manifest.baseSha,
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
      new Error('missing required `SECRETS:` line — a security reviewer must always report one'),
      handle.effectId ?? null,
      handle.durationMs
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
    briefHash: manifest.briefHash,
    policyDigest: manifest.policyDigest,
    baseSha: manifest.baseSha,
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
    // Named so a reviewer never under-reports a body/comment/
    // role-file finding's real severity to pre-empt this — the cap is
    // applied by the policy evaluator, not something to guess around.
    'A finding whose own location is the PR body, a comment, or a role file is capped to MINOR before it counts toward the threshold, regardless of the severity you assign it — write its real severity anyway.',
    ...(hasObjectivesFacts(facts)
      ? [
          `Write one line per objective listed above to ${join(workDir, 'objectives.txt')}: O<n>|MET|<evidence> or O<n>|NOT MET|<evidence> — the status is read by its bare leading word (MET or NOT MET); write nothing else before it on that field.`,
          "NOT MET means you verified the objective is not met — never a decline. An objective outside your own lens is MET, citing the other reviewer's evidence or verifying it yourself directly — never NOT MET with an out-of-scope note."
        ]
      : []),
    `Write a short report to ${join(workDir, 'report.txt')} as one \`KEY: value\` line per field:`,
    role === 'reviewer' ? '  BRIEF_CONFORMANCE, SPEC_CONFORMANCE, SCOPE, TESTS, DOCS' : '  CONFIG_SCAN, SECRETS',
    // A round's own findings are compared to the NEXT round's by
    // id — never by writing order, which is not stable across two separate
    // dispatches. Skipped only when findings.txt is empty (nothing to cite).
    '  If findings.txt is non-empty, also write `FINDING_IDS: <id>,<id>,...` — one id per findings.txt line, in the SAME order, e.g. `F1,F2,F3`. A report with findings but no matching `FINDING_IDS:` line is sent back once for this alone.',
    ...(role === 'security'
      ? [
          '`SECRETS:` is required — never leave it blank or omit it, even when you found nothing: write `SECRETS: none found` only after you actually checked.'
        ]
      : []),
    'To escalate instead of casting a verdict, write only `ESCALATE: authority|strategy|product` and `SUMMARY: <text>` to report.txt.'
  ].join('\n')
  return `${base}\n\n${instructions}`
}
