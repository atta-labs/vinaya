/**
 * `dev-review-loop`'s reviewer-dispatch-and-verdict concern — the reviewer's
 * own prompt, the held-verdict outbox, and turning a reviewer's accepted
 * structured ReviewResult (`review-result.ts`) into a rendered verdict via
 * `buildVerdictFromReview` (which calls `@attalabs/aeg-core`'s pure
 * evaluator through `deriveCodeReviewVerdict`/`deriveSecurityVerdict` —
 * which severities block is repository policy, never a literal here).
 * Moved out of `apps/cli/src/lib/dev-review-loop.ts` verbatim;
 * `dev-review-loop.ts` stays the composition root, re-exporting every name
 * below under the same path it always had.
 */

import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import {
  blockingSeverities,
  CODE_REVIEW_SEVERITY_ORDER,
  classifyFinding,
  defaultControlStoreDeps,
  type DeferralReason,
  extractCodeReviewVerdict,
  extractSecurityReviewVerdict,
  type FindingDeferralContext,
  globCoversPath,
  isProseLocation,
  type IssueSurface,
  type ManifestInput,
  type ManifestRecord,
  type Objective,
  type ReviewInputManifest,
  redact,
  REVIEW_FINDING_DESCRIPTION_MAX_LENGTH,
  SECURITY_SEVERITY_ORDER,
  type ReviewPolicy,
  type VerdictObservation,
  writeManifest
} from '@attalabs/aeg-core'
import {
  checkDocCorrectnessSearch,
  checkObjectiveIdCoverage,
  deriveCodeReviewVerdict,
  deriveSecurityVerdict,
  type Finding,
  FindingsParseError,
  invalidObjectiveEvidenceReason,
  noneFoundClaimCitesScanCheck,
  type ObjectiveResult,
  renderCodeReviewComment,
  renderEscalationComment,
  renderSecurityComment,
  SECRET_SCAN_CHECK
} from '../../commands/review-post.js'
import type { AgentVendor, DispatchHandle } from '../dispatch.js'
import { manifestDigest as reviewManifestDigest, type ReviewResult } from '../review-result.js'
import { isStagedPrBodyFile, type ReviewerCandidateInputPaths } from './reviewer-isolation.js'
import { ensureRunDir, runPath, runtimeDirForThisRepo, tasksExecutionRoot } from '../run-paths.js'

// --- reviewer prompt (facts only) -----------------------------------------

export type ReviewerPromptFacts = {
  objectives: string
  /** The `objectives` text, parsed — `[]` exactly when `objectives` is empty. Threaded into `buildVerdictFromReview`'s own `checkObjectiveIdCoverage` call, the same coverage rule `review post` already applies. */
  resolvedObjectives: readonly Objective[]
  rulings: string[]
  /** `not_run`: review locally, push once — no pull request and so no CI yet; CI runs once after both approve. */
  ciConclusion: 'green' | 'red' | 'pending' | 'not_run'
  /** The frozen brief's own `**Revision:**` fact — `fetchSourceRevision`. */
  revision: string
  /**
   * The one review-input manifest — head, the frozen brief's own hash, objectives version, ruling
   * ordinal, and the effective review policy's digest, built by the driver
   * BEFORE this dispatch. The only source of `HEAD:` in the rendered prompt
   * below and of every structural line `buildVerdictFromReview` renders —
   * `objectivesVersion`/`rulingOrdinal` are no longer separate fields here.
   */
  manifest: ReviewInputManifest
  /** The effective policy whose digest is bound by `manifest.policyDigest`. */
  policy: ReviewPolicy
  /**
   * O2/O3: the round's deferral rules, built by the driver from the previous
   * round's head and the task's `## Surface` (`buildRoundDeferralContext`).
   * Threaded to `buildVerdictFromReview`, never into the reviewer prompt —
   * the renderer ignores it. Absent (or `{}`) leaves both rules inactive.
   */
  deferralContext?: FindingDeferralContext
  /**
   * The round's agent-configuration scan outcome,
   * decided once by the driver (`decideSecurityScan`) before either reviewer
   * dispatches. Rendered into the SECURITY prompt only (`renderReviewerDispatchPrompt`),
   * never the code-reviewer's — the scan is a fact piece the security pass reads
   * as input to its judgement, never the verdict. `undefined` (the default,
   * and every fixture that wires no scan dep) injects no scan block at all — the
   * dispatch's pre-task shape.
   */
  configScan?: SecurityScanOutcome
  /**
   * The round's required sources and the Developer's citations of them,
   * rendered into both reviewers' prompts (`requiredSourcePieces`).
   * `undefined`, or a manifest with no sources, adds nothing — the prompt of
   * a task whose brief names no required source.
   */
  requiredSources?: ReviewerSourceFacts
}

/**
 * What the reviewers are told about the round's required sources: the
 * identity of the manifest the Developer was given, each source's identity
 * and pinned digest — readable in full through `read_source` — and the
 * Developer's own `sourceUses`, which are claims to check, never evidence.
 */
export type ReviewerSourceFacts = {
  /** The digest of the required-source manifest the round's Developer was given. */
  manifestDigest: string
  sources: readonly { sourceId: string; governs: string; digest: string | null; finalUrl: string | null }[]
  /** The `sourceUses` of the round's newest accepted `completed` turn result; `null` when it has none. */
  citations: readonly { source: string; use: string }[] | null
}

/** The reviewers' source facts from a prepared manifest and the Developer's citations. */
export function reviewerSourceFacts(
  manifest: {
    digest: string
    sources: readonly { sourceId: string; governs: string; contentDigest: string | null; finalUrl?: string }[]
  },
  citations: readonly { source: string; use: string }[] | null
): ReviewerSourceFacts {
  return {
    manifestDigest: manifest.digest,
    sources: manifest.sources.map((s) => ({
      sourceId: s.sourceId,
      governs: s.governs,
      digest: s.contentDigest,
      finalUrl: s.finalUrl ?? null
    })),
    citations
  }
}

/**
 * Phrasing that would smuggle a conclusion, rather than a fact, into a
 * reviewer's prompt — the framing THIS renderer must never author itself.
 *
 * The lint's subject is the renderer's own fixed text (labels, fallbacks,
 * numbering prefixes), never the facts interpolated between them: objectives
 * text, ruling bodies and the brief's revision are Principal- or
 * Planner-authored prose the driver does not control and must never censor,
 * so a ruling that happens to say "clearly" is carried through verbatim
 * rather than ending the round. A match therefore always names text written
 * here, in this file — Section 10: it is fixed in the renderer, never by
 * loosening the lint.
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

/**
 * One piece of a reviewer prompt: either `driver` text this renderer authored
 * itself, or a `fact` interpolated verbatim from prose the driver does not
 * control. Splitting the prompt this way is what lets the banned-framing lint
 * read the renderer's own words without ever reading a Principal's.
 */
export type ReviewerPromptPiece = { readonly driver: string } | { readonly fact: string }

const driverPiece = (text: string): ReviewerPromptPiece => ({ driver: text })
const factPiece = (text: string): ReviewerPromptPiece => ({ fact: text })

// --- the agent-configuration security scan -----------

/**
 * The fixed agent-configuration path list the scan applies to (Boundary: fixed
 * in code, never configurable). A pull request whose diff touches any of these
 * is scanned; one that touches none is `not_applicable`.
 */
export const AGENT_CONFIG_GLOBS: readonly string[] = ['.claude/**', '.mcp.json', '.agents/**']

/** Whether any of the pull request's changed paths is agent configuration, by `AGENT_CONFIG_GLOBS` — the same `globCoversPath` matcher the Issue's own Surface checks use, never a second matcher. */
export function touchesAgentConfig(changedPaths: readonly string[]): boolean {
  return changedPaths.some((p) => AGENT_CONFIG_GLOBS.some((g) => globCoversPath(g, p)))
}

/**
 * The cap on how much of a scanner's output reaches the security prompt —
 * a runaway or verbose scanner never floods the prompt. The TAIL is kept
 * (a scanner's summary/verdict lands last), with a one-line note of how much
 * was dropped — the same shape `pr-report-engine.ts`'s own agent-output cap uses.
 */
export const SECURITY_SCAN_OUTPUT_MAX_CHARS = 16_000

export function capSecurityScanOutput(output: string): string {
  if (output.length <= SECURITY_SCAN_OUTPUT_MAX_CHARS) return output
  const dropped = output.length - SECURITY_SCAN_OUTPUT_MAX_CHARS
  return `[... ${dropped} earlier characters truncated ...]\n${output.slice(-SECURITY_SCAN_OUTPUT_MAX_CHARS)}`
}

/**
 * The round's agent-config scan outcome, one of four states the
 * security pass is told about and the Log records:
 *   - `ran` — the scanner ran on the head-verified copy; `output` is its
 *     (capped) stdout+stderr, a fact piece the security pass reads.
 *   - `not_applicable` — the pull request touches no agent configuration.
 *   - `not_configured` — no `securityScan.command` is set for this repository.
 *   - `failed` — a scanner was configured and the change was in scope, but the
 *     scan could not run (a non-zero exit, a timeout, an output overflow, or no
 *     head-verified candidate copy to scan); `reason` names which. Never a
 *     pause — the round proceeds on the reviewer's own read of the diff.
 */
export type SecurityScanOutcome =
  | { readonly kind: 'ran'; readonly output: string }
  | { readonly kind: 'not_applicable' }
  | { readonly kind: 'not_configured' }
  | { readonly kind: 'failed'; readonly reason: string }

/** The scanner subprocess result the driver's runner dep returns — `ok` with captured output, or a named failure reason (a non-zero exit, a timeout, an overflow). */
export type SecurityScanRun =
  | { readonly ok: true; readonly output: string }
  | { readonly ok: false; readonly reason: string }

/**
 * Decides the round's scan outcome from the configured command, the
 * pull request's changed paths, the head-verified candidate copy, and a runner
 * that actually spawns the scanner. Pure but for the injected `runScan`, so the
 * whole decision — not-configured, not-applicable, the missing-candidate
 * fallback, and the cap on a ran scan's output — is unit-testable without
 * spawning a process.
 *
 * `not_configured` is decided first, ahead of applicability: an unset scanner
 * is a repository-setup fact independent of this pull request's diff, and the
 * security pass is told that plainly rather than "not applicable". A configured
 * scanner over a change in scope with NO candidate copy is `failed` with a
 * reason, never a pause and never a scan of a possibly-diverged local worktree
 * (Traps to avoid: treat a missing candidate as scan-unavailable).
 */
export function decideSecurityScan(args: {
  command: readonly string[] | null
  changedPaths: readonly string[]
  candidateDir: string | null
  runScan: (command: readonly string[], cwd: string) => SecurityScanRun
}): SecurityScanOutcome {
  if (args.command === null) return { kind: 'not_configured' }
  if (!touchesAgentConfig(args.changedPaths)) return { kind: 'not_applicable' }
  if (args.candidateDir === null) return { kind: 'failed', reason: 'no head-verified candidate copy to scan' }
  const result = args.runScan(args.command, args.candidateDir)
  return result.ok
    ? { kind: 'ran', output: capSecurityScanOutput(result.output) }
    : { kind: 'failed', reason: result.reason }
}

/**
 * The scan block for the SECURITY prompt: a `driver` label piece the
 * lint reads, plus — for `ran`/`failed` — a `fact` piece the lint never reads,
 * carrying the scanner's own output or failure reason (untrusted text that
 * must never be able to end a round by tripping the banned-framing lint, the
 * same split a Principal's ruling already gets). `undefined` (no scan decided)
 * contributes no pieces at all — the security prompt's pre-task shape.
 */
export function securityScanPieces(outcome: SecurityScanOutcome | undefined): readonly ReviewerPromptPiece[] {
  if (outcome === undefined) return []
  switch (outcome.kind) {
    case 'ran':
      return [
        driverPiece(
          '\n\nAGENT-CONFIG SCAN — the driver ran the configured scanner on the head-verified copy, outside its own trust. Read it as input to your CONFIG_SCAN judgement, never as the verdict, and never run a scanner yourself:\n'
        ),
        factPiece(outcome.output)
      ]
    case 'not_applicable':
      return [
        driverPiece(
          '\n\nAGENT-CONFIG SCAN: not applicable — this pull request changes no agent configuration (.claude/**, .mcp.json, .agents/**), so no scanner was run.'
        )
      ]
    case 'not_configured':
      return [
        driverPiece(
          '\n\nAGENT-CONFIG SCAN: no scanner is configured for this repository (securityScan.command is unset), so none was run — judge CONFIG_SCAN on your own read of the diff.'
        )
      ]
    case 'failed':
      return [
        driverPiece(
          '\n\nAGENT-CONFIG SCAN: the configured scanner could not run on this change — judge CONFIG_SCAN on your own read of the diff. Reason: '
        ),
        factPiece(outcome.reason)
      ]
  }
}

// --- the driver-staged pull-request inputs (O1/O2/O3) -----------------------

/**
 * O1/O2/O3: names the four files the driver staged into the reviewer's own
 * read-only checkout (`reviewer-isolation.ts`'s `writeReviewerCandidateInputs`
 * / `reviewerCandidateInputPaths`) — the task's frozen brief (the standard this
 * reviewer's own doctrine tells it to judge the PR against), the pull request's
 * body, the unified diff of the judged head against its base, and the prior
 * round's findings — so a dispatched reviewer holding no `gh` command and no
 * forge credential still has a way to read what it judges. `paths` is `null`
 * exactly when no candidate copy exists for this attempt (the existing
 * no-`cwd` fallback shape, or a staging write that failed) — then this
 * contributes no pieces at all, the dispatch's pre-task shape, same as
 * `securityScanPieces`'s own `undefined` case.
 */
export function candidateInputPieces(paths: ReviewerCandidateInputPaths | null): readonly ReviewerPromptPiece[] {
  if (paths === null) return []
  return [
    driverPiece(
      '\n\nYou hold no GitHub credential for this dispatch, and your tool grant carries no `gh` command — read the pull request only through the four files below, inside your own checkout, never through `gh`.\n\nTASK BRIEF (the frozen brief this task was dispatched against — judge the PR against it): '
    ),
    factPiece(paths.brief),
    driverPiece('\nPULL REQUEST BODY: '),
    factPiece(paths.prBody),
    driverPiece('\nDIFF (base...head): '),
    factPiece(paths.diff),
    driverPiece('\nPRIOR ROUND FINDINGS: '),
    factPiece(paths.priorFindings)
  ]
}

/**
 * The round's required sources, for both reviewers: the manifest identity,
 * each source's identity and pinned digest, and the Developer's citations
 * of them. A citation is the Developer's own text, so it is a `fact` piece
 * labelled as the Developer's claim; the driver's own wording says what a
 * receipt does and does not prove, so a delivered but irrelevant citation is
 * the reviewer's to reject. Empty when the round has no required source.
 */
export function requiredSourcePieces(sources: ReviewerSourceFacts | undefined): readonly ReviewerPromptPiece[] {
  if (sources === undefined || sources.sources.length === 0) return []
  const pieces: ReviewerPromptPiece[] = [
    driverPiece('\n\nREQUIRED SOURCES (controller manifest '),
    factPiece(sources.manifestDigest),
    driverPiece(
      '): read any of them with the `read_source` tool by its identity below; it serves exactly the content the controller pinned for the Developer, at the digest shown, never a fresh fetch.'
    )
  ]
  for (const source of sources.sources) {
    pieces.push(
      driverPiece('\n- '),
      factPiece(source.sourceId),
      driverPiece(' — governs: '),
      factPiece(source.governs),
      driverPiece(' — pinned: '),
      factPiece(source.digest ?? '(no pinned content)'),
      ...(source.finalUrl !== null && source.finalUrl !== source.sourceId
        ? [driverPiece(' — served from: '), factPiece(source.finalUrl)]
        : [])
    )
  }
  pieces.push(
    driverPiece(
      "\nDEVELOPER'S SOURCE CITATIONS (the `sourceUses` of the round's accepted turn result — the Developer's own claims):"
    )
  )
  if (sources.citations === null || sources.citations.length === 0) {
    pieces.push(driverPiece('\n(none recorded)'))
  } else {
    for (const citation of sources.citations) {
      pieces.push(
        driverPiece('\n- '),
        factPiece(citation.source),
        driverPiece(' — informed: '),
        factPiece(citation.use)
      )
    }
  }
  pieces.push(
    driverPiece(
      '\nThe controller accepted these citations only because each source has a delivery receipt; a receipt proves the source was delivered, never that it was used correctly. A change that contradicts a required source, or a citation the source does not support, is a finding like any other, at the severity its effect warrants.'
    )
  )
  return pieces
}

/**
 * The reviewer prompt's facts block, piece by piece — the one place its shape
 * lives. Facts only: no developer-authored text, no PR-body prose (Traps to
 * avoid).
 */
export function buildReviewerPromptPieces(facts: ReviewerPromptFacts): readonly ReviewerPromptPiece[] {
  const objectives = facts.objectives.trim()
  const rulings: ReviewerPromptPiece[] = []
  if (facts.rulings.length === 0) rulings.push(driverPiece('(none)'))
  else
    for (const [i, ruling] of facts.rulings.entries()) {
      rulings.push(driverPiece(`${i > 0 ? '\n' : ''}${i + 1}. `), factPiece(ruling))
    }
  return [
    driverPiece('OBJECTIVES:\n'),
    objectives ? factPiece(objectives) : driverPiece('(none found on the Issue)'),
    driverPiece('\n\nRULINGS ON THIS PR:\n'),
    ...rulings,
    driverPiece('\n\nHEAD: '),
    factPiece(facts.manifest.headSha),
    driverPiece('\nCI: '),
    ...(facts.ciConclusion === 'not_run'
      ? [
          driverPiece(
            'not run. This run reviews locally: no pull request exists yet, so no CI has run. CI runs once on the head both reviewers approve, and a red CI sends the work back. Judge the local commit and its diff.'
          )
        ]
      : [factPiece(facts.ciConclusion)]),
    driverPiece('\nBRIEF REVISION: '),
    factPiece(facts.revision)
  ]
}

/** The prompt as the reviewer reads it — every piece, driver text and fact alike. */
export function joinReviewerPromptPieces(pieces: readonly ReviewerPromptPiece[]): string {
  return pieces.map((piece) => ('driver' in piece ? piece.driver : piece.fact)).join('')
}

/**
 * Only the text the driver itself wrote — the lint's subject. Joined with
 * newlines rather than concatenated, so two fixed strings sitting either side
 * of a held-out fact can never read as one banned phrase.
 */
export function driverAuthoredPromptText(pieces: readonly ReviewerPromptPiece[]): string {
  return pieces.flatMap((piece) => ('driver' in piece ? [piece.driver] : [])).join('\n')
}

/** Facts only — no developer-authored text, no PR-body prose (Traps to avoid). */
export function renderReviewerPrompt(facts: ReviewerPromptFacts): string {
  return joinReviewerPromptPieces(buildReviewerPromptPieces(facts))
}

/**
 * The role-doctrine block, as prompt pieces (O1): the framing label is
 * `driver` text — the lint's subject — while the role text itself is a `fact`
 * the lint never reads (O3). That is the same split that already holds a
 * Principal's ruling out of the lint, applied to doctrine the driver does not
 * author: an adopter override whose short version happens to carry a banned
 * phrase renders and the round proceeds, rather than crashing every round
 * (Traps to avoid). A `null`/blank doctrine contributes no pieces at all — the
 * dispatch's pre-task shape, unchanged.
 */
export function roleDoctrinePieces(
  role: 'reviewer' | 'security',
  roleDoctrine: string | null
): readonly ReviewerPromptPiece[] {
  if (roleDoctrine === null || roleDoctrine.trim().length === 0) return []
  const label = role === 'reviewer' ? 'the code-reviewer' : 'the security reviewer'
  return [
    driverPiece(
      `\n\nYOUR ROLE DOCTRINE — the short version and the "What you check" list for ${label} role, the same doctrine an interactive reviewer reads. Treat it as what to look for. A session the review loop dispatched gives no receipt (\`ACK: <token>\`): ignore any read-receipt rule in it.\n\n`
    ),
    factPiece(roleDoctrine.trim())
  ]
}

/** Blocking severities for this role, derived from the effective policy bound by the manifest. */
export function blockingSeverityPieces(
  role: 'reviewer' | 'security',
  policy: ReviewPolicy
): readonly ReviewerPromptPiece[] {
  const severities =
    role === 'reviewer'
      ? blockingSeverities(CODE_REVIEW_SEVERITY_ORDER, policy.codeReviewThreshold)
      : blockingSeverities(SECURITY_SEVERITY_ORDER, policy.securityThreshold)
  return [driverPiece(`\n\nBLOCKING SEVERITIES UNDER THE EFFECTIVE REVIEW POLICY: ${severities.join(', ')}`)]
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
    manifestVersion: manifest.manifestVersion ?? 2,
    pauseBoundRuling: manifest.pauseBoundRuling ?? null,
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
  ensureRunDir(runPath(root, task, { area: 'round', round }), root)
  writeFileSync(heldVerdictPath(root, task, round, role), renderedComment, 'utf8')
}

/**
 * O1: "the prior round's findings" the driver stages for both reviewer
 * roles — the rendered REVIEWER and SECURITY verdict text `round - 1` held
 * (`heldVerdictPath`'s own files are never deleted once written, so this
 * reads the durable record, never a reviewer's own transient output).
 * Round 1, or a round
 * whose own held pair was discarded (O5, a merge-conflict invalidation),
 * names that plainly rather than fabricating an empty-findings claim this
 * round's reviewer could mistake for an actual clean prior round (Traps to
 * avoid: never guess).
 */
export function buildPriorRoundFindingsText(root: string, task: number, round: number): string {
  if (round <= 1) return 'This is round 1 — there is no prior round.'
  const reviewerBody = readIfExists(heldVerdictPath(root, task, round - 1, 'reviewer'))
  const securityBody = readIfExists(heldVerdictPath(root, task, round - 1, 'security'))
  if (!reviewerBody && !securityBody) {
    return `No held verdict survives on disk from round ${round - 1} — its findings could not be recovered.`
  }
  return [
    reviewerBody ? `## Code-reviewer verdict — round ${round - 1}\n\n${reviewerBody}` : null,
    securityBody ? `## Security verdict — round ${round - 1}\n\n${securityBody}` : null
  ]
    .filter((s): s is string => s !== null)
    .join('\n\n---\n\n')
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

export type HeldCleanVerdict = { round: number; head: string; rendered: string; manifest: ReviewInputManifest }

/**
 * issue-711 O1 — the held-clean counterpart to `latestHeldRequestChanges`,
 * above: the HIGHEST round with any held verdict file at all, read only if
 * its own reviewer AND security pair are both still on disk, re-parse
 * clean, agree on every manifest field, and cast APPROVE/PASS (the
 * inverse of `latestHeldRequestChanges`'s own exclusion). A verdict judges
 * a patch, not a head — this is what lets the driver recognize a held
 * (or, since these files are never deleted after posting, already
 * published — `publishRound`'s own posting is idempotent per round)
 * clean verdict as still covering a head that moved only by a
 * patch-identical rebase or a merge from the base, rather than discarding
 * it and dispatching a whole fresh review round. Never falls back to an
 * OLDER round, for the identical reason `latestHeldRequestChanges` never
 * does: a later round's own held pair already supersedes it.
 *
 * `rulingOrdinal`/`policyDigest` are required non-null here (stricter than
 * `latestHeldRequestChanges`, which never reads them) — `ReviewInputManifest`
 * itself has no null case for either field, and every verdict this
 * codebase renders carries both unconditionally, so a `null` here only
 * ever means legacy pre-cutover stock; returning `null` for that case
 * costs a fresh review round, never a wrong publish.
 */
export function latestHeldCleanVerdict(root: string, task: number): HeldCleanVerdict | null {
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
  if (reviewer.value !== 'APPROVE' || security.value !== 'PASS') return null
  if (!reviewer.headSha || !security.headSha || reviewer.headSha !== security.headSha) return null
  if (reviewer.baseSha !== security.baseSha) return null
  if (reviewer.briefHash !== security.briefHash) return null
  if (reviewer.objectivesVersion !== security.objectivesVersion) return null
  if (reviewer.rulingOrdinal === null || reviewer.rulingOrdinal !== security.rulingOrdinal) return null
  if (reviewer.policyDigest === null || reviewer.policyDigest !== security.policyDigest) return null
  return {
    round: highest,
    head: reviewer.headSha,
    rendered: `${reviewerBody}\n\n---\n\n${securityBody}`,
    manifest: {
      headSha: reviewer.headSha,
      baseSha: reviewer.baseSha,
      briefHash: reviewer.briefHash,
      objectivesVersion: reviewer.objectivesVersion,
      rulingOrdinal: reviewer.rulingOrdinal,
      policyDigest: reviewer.policyDigest
    }
  }
}

/**
 * Thrown by `dispatchReviewer` when a role delivered no review on its fresh
 * dispatch nor on its one fresh retry — its structured ReviewResult missing,
 * malformed, stale, crossed with another role, or the run cancelled,
 * context-exhausted or failed at the provider — caught by the loop and
 * turned into `{ type: 'pause', reason: 'infrastructure' }`, never read as a
 * clean verdict on any path. `missing` names why each attempt was no review.
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
    super(`${role} delivered no review after a fresh dispatch and one fresh retry: ${missing.join('; ')}.`)
  }
}

/**
 * Thrown by `buildVerdictFromReview` when a schema-valid, bound result still
 * breaks a rule every review is held to — a `doc-correctness` finding with no
 * repository-wide `Search:` pattern, an objective result that does not cover
 * the brief's objectives exactly or whose evidence cannot render, or a clean
 * secrets claim that cites no passing scan. Like any other invalid result it
 * is no review: `dispatchReviewer` gives it the same one fresh retry, and a
 * second rejection becomes `{ type: 'pause', reason: 'infrastructure' }` —
 * naming the field, the reason, and the reviewer's session id — never an
 * uncaught throw that crashes the driver.
 */
export class ReviewerResultRejected extends Error {
  constructor(
    public readonly role: 'reviewer' | 'security',
    public readonly field: 'findings' | 'objectiveResults' | 'summary',
    public readonly sessionId: string,
    public readonly reason: Error,
    /** This exact attempt's own `effect_id`/`durationMs`, from `buildVerdictFromReview`'s own `handle` parameter — see `ReviewerInfrastructureFailure`'s identical fields for why. */
    public readonly attemptEffectId: string | null = null,
    public readonly attemptDurationMs: number | null = null
  ) {
    super(`${role}'s ReviewResult ${field} was rejected (session ${sessionId}): ${reason.message}`)
  }
}

/**
 * The description fingerprint the repeat-finding stop compares: lower-cased,
 * every run of whitespace and punctuation collapsed to one space, trimmed.
 */
export function findingFingerprint(description: string): string {
  return description
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, ' ')
    .trim()
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
 * The SAME rule `evaluateReviewFindings` applies internally
 * (`@attalabs/aeg-core`) to decide `outcome`/`blockingFindings` — no longer a
 * second copy of the prose cap and threshold check here, but the one shared
 * `classifyFinding` (O1), called over the SAME finding only to attach the
 * resulting fact onto the finding's own observation record, which that
 * evaluator's return value has no room for
 * (`PolicyEvaluation.blockingFindings` is a filtered array, not an annotated
 * one — see this task's PR Decisions). `context` threads the round's
 * deferral rules (O2/O3) when the driver supplied them; a `'deferred'`
 * classification records the reason so the summary can name it, and never
 * counts the finding as blocking. `severity` itself is never overwritten:
 * this only ever changes how the finding COUNTS toward this threshold, not
 * what it reports (Traps to avoid: "retain reported severity separately from
 * the incoming prose cap").
 */
function policyTreatmentFor(
  finding: Finding,
  scale: readonly string[],
  threshold: string,
  context: FindingDeferralContext
): { treatment: 'blocking' | 'non_blocking'; deferred: DeferralReason | null } {
  const c = classifyFinding(finding, scale, threshold, context)
  return { treatment: c.outcome === 'blocking' ? 'blocking' : 'non_blocking', deferred: c.deferralReason }
}

/**
 * A finding the reviewer located on the staged pull request body file
 * (`isStagedPrBodyFile`) is re-located at `PR body` (`PR body:<line>` when it
 * names a line) — the Developer's own output, which it edits through
 * `update_pull_request_body`, not a repository file. The shared prose rule
 * then reads it exactly as any finding a reviewer already wrote at "PR body":
 * capped at `MINOR`, never deferred as outside the Surface, and kept in the
 * verdict comment's FINDINGS block the Developer receives — and the merge
 * gate, re-reading that comment with no knowledge of the staged path, reaches
 * the same treatment. Severity and description are untouched; any other
 * location is returned as it is.
 */
export function relocateStagedPrBodyFinding(finding: Finding): Finding {
  const { file, line } = parseFindingLocation(finding.location)
  if (!isStagedPrBodyFile(file)) return finding
  return { ...finding, location: line === null ? 'PR body' : `PR body:${line}` }
}

// --- the round's deferral context (O2/O3), built from driver facts ----------

/**
 * A finding location's file and optional line: `packages/x.ts:42` →
 * `{ file: 'packages/x.ts', line: 42 }`, `packages/x.ts` →
 * `{ file, line: null }`. A `file:line:col` reads the FIRST number as the line.
 */
export function parseFindingLocation(location: string): { file: string; line: number | null } {
  const trimmed = location.trim()
  const m = /^(.*?):(\d+)(?::\d+)?$/.exec(trimmed)
  if (m) return { file: m[1] as string, line: Number(m[2]) }
  return { file: trimmed, line: null }
}

/**
 * Parse `git diff --unified=0` output into the NEW-side line numbers that
 * changed, per file. A file that appears at all (even a pure deletion, whose
 * hunk adds no new line) is a CHANGED file — recorded with whatever new-side
 * lines its hunks add, so a file-level finding on it counts as changed
 * (Traps to avoid). `/dev/null` on the new side (a deleted file) is not a
 * changed file a later finding could land on, so it is skipped.
 */
export function parseChangedLines(unifiedDiff: string): Map<string, Set<number>> {
  const changed = new Map<string, Set<number>>()
  let currentFile: string | null = null
  for (const line of unifiedDiff.split('\n')) {
    const fileMatch = /^\+\+\+ b\/(.+)$/.exec(line)
    if (fileMatch) {
      const f = (fileMatch[1] as string).trim()
      currentFile = f === '/dev/null' ? null : f
      if (currentFile && !changed.has(currentFile)) changed.set(currentFile, new Set())
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunk && currentFile) {
      const start = Number(hunk[1])
      const count = hunk[2] === undefined ? 1 : Number(hunk[2])
      const set = changed.get(currentFile) as Set<number>
      for (let i = 0; i < count; i++) set.add(start + i)
    }
  }
  return changed
}

/**
 * The `changedLine` predicate over a parsed changed-line map: a finding is on
 * a changed line when its file changed AND either it names no line (a
 * file-level finding on a changed file counts as changed) or its line is in
 * that file's changed set. A file absent from the map did not change.
 */
export function makeChangedLinePredicate(changed: Map<string, Set<number>>): (location: string) => boolean {
  return (location: string) => {
    const { file, line } = parseFindingLocation(location)
    const set = changed.get(file)
    if (set === undefined) return false
    if (line === null) return true
    return set.has(line)
  }
}

/** The `inSurface` predicate: a finding's file is covered by any `## Surface` `in:` glob — the SAME `globCoversPath` the Issue's own Surface checks use, never a second matcher. */
export function makeInSurfacePredicate(inGlobs: readonly string[]): (location: string) => boolean {
  return (location: string) => {
    const { file } = parseFindingLocation(location)
    return inGlobs.some((g) => globCoversPath(g, file))
  }
}

/** The `changedFile` predicate: a finding's file is one the task branch changed — an exact path in the branch's merge-base changed-path set. */
export function makeChangedFilePredicate(changedPaths: readonly string[]): (location: string) => boolean {
  const changed = new Set(changedPaths)
  return (location: string) => changed.has(parseFindingLocation(location).file)
}

/**
 * The round's deferral context (O2/O3), from what the driver could resolve:
 *
 *   - `inSurface` and `changedFile` are active together whenever the task's
 *     `## Surface` `in:` list resolved and the branch's changed-path set was
 *     read — ANY round (O3). A finding on a changed file beyond the Surface is
 *     reviewed; only one on an unchanged file beyond it is deferred. Without
 *     the changed-path set neither is set, so nothing is deferred for the
 *     Surface;
 *   - `changedLine` is active only from round 2 on, AND only when the previous
 *     round's head was recovered, differs from the current head, and the diff
 *     between them was readable. Round 1, an unrecoverable previous head, an
 *     unchanged head, or an unreadable diff each leave it inactive, so every
 *     in-Surface finding blocks as it did before — the brief's own fallback,
 *     never a guessed deferral.
 */
export function buildRoundDeferralContext(args: {
  round: number
  previousRoundHead: string | null
  head: string
  surface: IssueSurface | null
  /** The task branch's changed paths (merge base to `head`), or `null` when they could not be read. */
  changedPaths: readonly string[] | null
  unifiedDiff?: (from: string, to: string) => string | null
}): FindingDeferralContext {
  const context: FindingDeferralContext = {}
  if (args.surface && args.surface.in.length > 0 && args.changedPaths !== null) {
    context.inSurface = makeInSurfacePredicate(args.surface.in)
    context.changedFile = makeChangedFilePredicate(args.changedPaths)
  }
  if (args.round >= 2 && args.previousRoundHead !== null && args.previousRoundHead !== args.head && args.unifiedDiff) {
    const diff = args.unifiedDiff(args.previousRoundHead, args.head)
    if (diff) context.changedLine = makeChangedLinePredicate(parseChangedLines(diff))
  }
  return context
}

export type RoundVerdictParse = { observation: VerdictObservation; rendered: string }

/** The rendered value of a report line the ReviewResult's one `summary` already covers. */
const COVERED_BY_SUMMARY = '(covered by the review summary)'

/** One structured text field, flattened to the one line a rendered verdict carries. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Turns one reviewer's accepted structured ReviewResult — already
 * schema-valid and bound to this round's role, head and review-input manifest
 * by `classifyReviewOutcome` (`review-result.ts`) — into the round's verdict
 * observation and rendered comment. The verdict itself is derived here, by
 * policy, never read from the agent; finding ids are assigned here, in the
 * result's own order. A `blocked` result reaches this only when the
 * controller decided its blocker needs a Principal ruling
 * (`reviewBlockerNeedsRuling`): it renders as an escalation and is never a
 * verdict. A rule a schema cannot express breaks the result as
 * `ReviewerResultRejected` — no review, like any other invalid result.
 */
export function buildVerdictFromReview(
  role: 'reviewer' | 'security',
  review: ReviewResult,
  agent: AgentVendor,
  taskId: number,
  handle: DispatchHandle,
  manifest: ReviewInputManifest,
  policy: ReviewPolicy,
  resolvedObjectives: readonly Objective[],
  /**
   * O2/O3: the round's deferral rules, built by the driver from the previous
   * round's head (the changed-line diff) and the task's `## Surface`. `{}`
   * (the default) leaves both rules inactive — every in-Surface finding
   * blocks as before, exactly round 1's behaviour and the fallback for a
   * round whose previous head could not be recovered.
   */
  deferralContext: FindingDeferralContext = {}
): RoundVerdictParse {
  const headSha = manifest.headSha
  const objectivesVersionAtDispatch = manifest.objectivesVersion
  const rulingOrdinalAtDispatch = manifest.rulingOrdinal
  const sessionId = handle.resumeId ?? '(unknown)'
  const tokensIn = handle.usage ? String(handle.usage.input) : '—'
  const tokensOut = handle.usage ? String(handle.usage.output) : '—'
  const roleLabel = role === 'reviewer' ? ('Reviewer' as const) : ('Security' as const)
  const rejected = (field: ReviewerResultRejected['field'], reason: string): ReviewerResultRejected =>
    new ReviewerResultRejected(role, field, sessionId, new Error(reason), handle.effectId ?? null, handle.durationMs)

  if (review.status === 'blocked') {
    const rendered = renderEscalationComment({
      headSha,
      // A blocker only the Principal can settle is a question of authority over the task's scope.
      escalationClass: 'authority',
      summary: oneLine(`${review.blocker.kind}: ${review.blocker.detail} — ${review.summary}`),
      role: role === 'reviewer' ? 'review' : 'security',
      roleLabel,
      objectivesVersion: objectivesVersionAtDispatch,
      rulingOrdinal: rulingOrdinalAtDispatch,
      briefHash: manifest.briefHash,
      policyDigest: manifest.policyDigest,
      baseSha: manifest.baseSha,
      manifestVersion: manifest.manifestVersion ?? 2,
      pauseBoundRuling: manifest.pauseBoundRuling ?? null,
      taskId: String(taskId),
      model: agent,
      tokensIn,
      tokensOut,
      cost: '—',
      sessionId
    })
    return { observation: { role, verdict: 'ESCALATE', objectives: [], findings: [] }, rendered }
  }

  // Severity and file are already checked against this role's scale by the
  // binding check; the rules below are the ones every review — posted by
  // hand or dispatched — is held to.
  const findings: Finding[] = review.findings.map((f, i) => {
    const description = oneLine(f.description ?? '') || '(no description given)'
    try {
      checkDocCorrectnessSearch(description, i + 1)
    } catch (err) {
      if (err instanceof FindingsParseError) throw rejected('findings', err.message)
      throw err
    }
    const file = oneLine(f.file)
    return relocateStagedPrBodyFinding({
      severity: f.severity,
      location: f.line === null ? file : `${file}:${f.line}`,
      description
    })
  })

  let objectiveResults: ObjectiveResult[] = review.objectiveResults.map((o) => ({
    id: o.id.trim(),
    status: o.status,
    evidence: oneLine(o.evidence)
  }))
  for (const o of objectiveResults) {
    const invalid = /^O\d+$/.test(o.id) ? invalidObjectiveEvidenceReason(o.evidence) : 'not a well-formed objective id'
    if (invalid !== null) throw rejected('objectiveResults', `${o.id}: ${invalid}`)
  }
  // O4: the SAME coverage rule `review post`'s own
  // `resolveObjectiveResultsForCommand` already applies to a human-posted
  // verdict — an under-reporting reviewer (one that returned fewer, or extra,
  // objective results than the resolved objectives list) never yields a
  // version-bound verdict here either, never a silently-accepted partial review.
  if (resolvedObjectives.length > 0) {
    const coverageProblem = checkObjectiveIdCoverage(resolvedObjectives, objectiveResults)
    if (coverageProblem !== null) {
      throw rejected(
        'objectiveResults',
        `the objective results do not cover the resolved objectives list exactly: ${coverageProblem}`
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
  // needs to close). O2/O3: every finding is classified through the ONE
  // shared rule (`policyTreatmentFor` → `classifyFinding`); a `deferred`
  // finding carries its reason and location onto its observation so the round
  // summary can name it (O4), keeps its reported `severity`, and counts as
  // `non_blocking` toward this round.
  const scale = role === 'reviewer' ? CODE_REVIEW_SEVERITY_ORDER : SECURITY_SEVERITY_ORDER
  const threshold = role === 'reviewer' ? policy.codeReviewThreshold : policy.securityThreshold
  const classified = findings.map((f, i) => {
    const t = policyTreatmentFor(f, scale, threshold, deferralContext)
    return { finding: f, id: `F${i + 1}`, treatment: t.treatment, deferred: t.deferred }
  })
  // The reviewer wording is retained exactly from the parser: redacted first
  // (so a cut never leaves half a secret, and redaction cannot grow past the
  // cap), then bounded with a visible mark.
  const captureDescription = (description: string): string => {
    const redacted = redact(description, homedir())
    return redacted.length > REVIEW_FINDING_DESCRIPTION_MAX_LENGTH
      ? `${redacted.slice(0, REVIEW_FINDING_DESCRIPTION_MAX_LENGTH - 1)}…`
      : redacted
  }
  const findingObservations = classified.map((c) => ({
    id: c.id,
    severity: c.finding.severity,
    location: c.finding.location,
    description: captureDescription(c.finding.description),
    fingerprint: findingFingerprint(c.finding.description),
    state: null,
    severityScale: role === 'reviewer' ? ('code-review' as const) : ('security' as const),
    policyTreatment: c.treatment,
    ...(c.deferred !== null ? { deferred: c.deferred } : {})
  }))
  // A deferred finding does not block this round (O2/O3), so the derived
  // verdict AND the rendered comment's own FINDINGS block are built from only
  // the findings that still block — a contextless merge gate reading the
  // published comment then reaches the same clean verdict the loop did,
  // rather than re-blocking on a finding this round already set aside. The
  // deferred findings travel to the round summary (O4), never into the
  // verdict comment's finding list.
  const blockingEligibleFindings = classified.filter((c) => c.deferred === null).map((c) => c.finding)

  if (role === 'reviewer') {
    const verdict = deriveCodeReviewVerdict(blockingEligibleFindings, policy)
    const rendered = renderCodeReviewComment({
      headSha,
      verdict,
      briefConformance: oneLine(review.summary),
      specConformance: COVERED_BY_SUMMARY,
      findings: blockingEligibleFindings,
      scope: COVERED_BY_SUMMARY,
      scopeEvidence: null,
      tests: COVERED_BY_SUMMARY,
      docs: COVERED_BY_SUMMARY,
      objectivesVersion: objectivesVersionAtDispatch,
      objectiveResults: renderedObjectiveResults,
      rulingOrdinal: rulingOrdinalAtDispatch,
      briefHash: manifest.briefHash,
      policyDigest: manifest.policyDigest,
      baseSha: manifest.baseSha,
      manifestVersion: manifest.manifestVersion ?? 2,
      pauseBoundRuling: manifest.pauseBoundRuling ?? null,
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

  // The security summary is the comment's SECRETS line — required by the
  // schema, so never blank — under the same rule `vinaya review post`
  // applies: a clean claim cites the required secret-scan check's result by
  // name, never a scanner run, and a clean claim that does not is no review.
  const secrets = oneLine(review.summary)
  if (!noneFoundClaimCitesScanCheck(secrets, null)) {
    throw rejected('summary', `a clean secrets claim must cite a passing \`${SECRET_SCAN_CHECK}\` check result by name`)
  }

  const verdict = deriveSecurityVerdict(blockingEligibleFindings, policy)
  const rendered = renderSecurityComment({
    headSha,
    verdict,
    findings: blockingEligibleFindings,
    configScan: COVERED_BY_SUMMARY,
    secrets,
    secretsEvidence: null,
    objectivesVersion: objectivesVersionAtDispatch,
    objectiveResults: renderedObjectiveResults,
    rulingOrdinal: rulingOrdinalAtDispatch,
    briefHash: manifest.briefHash,
    policyDigest: manifest.policyDigest,
    baseSha: manifest.baseSha,
    manifestVersion: manifest.manifestVersion ?? 2,
    pauseBoundRuling: manifest.pauseBoundRuling ?? null,
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
  /**
   * O1/O2: this role's published doctrine — short version plus `## What you
   * check`, already resolved through the role plan (override-aware) by the
   * driver's `resolveReviewerDoctrine` dep. `null` (the default) injects no
   * doctrine block, the dispatch's pre-task shape and the fallback for a round
   * whose doctrine could not be resolved.
   */
  roleDoctrine: string | null = null,
  /**
   * O1/O2: this attempt's own staged input-file paths (`reviewer-isolation.ts`'s
   * `reviewerCandidateInputPaths`, resolved by the caller against the scratch
   * copy this attempt's `cwd` actually is — never against `facts`, which is
   * shared, unmutated, across both roles and every attempt). `null` (the
   * default) injects no block at all — no candidate existed this round, or
   * staging the files failed — the dispatch's pre-task shape.
   */
  candidateInputPaths: ReviewerCandidateInputPaths | null = null
): string {
  // The agent-config scan reaches the SECURITY prompt only, as a fact
  // piece — the code-reviewer never sees it. `facts.configScan` is `undefined`
  // for the code-reviewer and for any round the driver ran no scan, so this
  // adds nothing there.
  const scanPieces = role === 'security' ? securityScanPieces(facts.configScan) : []
  const pieces = [
    ...buildReviewerPromptPieces(facts),
    ...blockingSeverityPieces(role, facts.policy),
    ...candidateInputPieces(candidateInputPaths),
    ...requiredSourcePieces(facts.requiredSources),
    ...roleDoctrinePieces(role, roleDoctrine),
    ...scanPieces
  ]
  const base = joinReviewerPromptPieces(pieces)
  // The lint reads the renderer's own fixed text only. A Principal ruling, an
  // Issue's objectives, or an injected role doctrine may say anything at all —
  // that prose is carried through verbatim as a `fact` piece, never censored
  // and never able to end the round (O3).
  const lint = lintReviewerPrompt(driverAuthoredPromptText(pieces))
  if (lint.length > 0) {
    throw new Error(
      `devReviewLoop: renderReviewerPrompt's own fixed text carries banned framing: ${lint.join('; ')} — fix the renderer, never the lint.`
    )
  }
  const roleLine =
    role === 'reviewer' ? 'You are the code-reviewer for this round.' : 'You are the security reviewer for this round.'
  const instructions = [
    roleLine,
    'Review the PR at the HEAD above against the OBJECTIVES and RULINGS above.',
    `End your turn with exactly one ReviewResult as your structured output — never a file. Use role ${role === 'reviewer' ? 'code-reviewer' : 'security-reviewer'}, headSha ${facts.manifest.headSha}, and manifestDigest ${reviewManifestDigest(facts.manifest)}.`,
    'Return status completed with findings, one result for every objective, and a summary; or status blocked with a typed blocker and summary. Do not write result files.',
    role === 'reviewer'
      ? 'Each finding has a severity (BLOCKER, MAJOR or MINOR), the file, the line (null when it is about the whole file) and a description; return an empty findings list when there are none.'
      : 'Each finding has a severity (CRITICAL, HIGH, MEDIUM or LOW), the file, the line (null when it is about the whole file) and a description; return an empty findings list when there are none.',
    'Finding identities are controller-owned: do not invent or return finding ids.',
    // Named so a reviewer never under-reports a body/comment/
    // role-file finding's real severity to pre-empt this — the cap is
    // applied by the policy evaluator, not something to guess around.
    'A finding whose own location is the PR body, a comment, or a role file is capped to MINOR before it counts toward the threshold, regardless of the severity you assign it — write its real severity anyway.',
    ...(hasObjectivesFacts(facts)
      ? [
          'Return one objective result per objective listed above: its id (O<n>), status MET or NOT MET, and its evidence.',
          "NOT MET means you verified the objective is not met — never a decline. An objective outside your own lens is MET, citing the other reviewer's evidence or verifying it yourself directly — never NOT MET with an out-of-scope note.",
          'An objective you find unmet is reported as NOT MET in its objective result with code or test evidence — never only as a finding on the pull request body, which is capped to MINOR and never decides an objective.'
        ]
      : ['This task lists no objectives: return an empty objective results list.']),
    ...(role === 'reviewer'
      ? ['Your summary states, in a few sentences, brief conformance, spec conformance, scope, tests and docs.']
      : [
          `Your summary opens with your secrets judgement and is rendered as the comment's SECRETS line. The secret scan is the required \`${SECRET_SCAN_CHECK}\` CI check, running inside the \`vinaya check --all --diff-only\` CI job — you hold no GitHub credential and must never call \`gh\` to inspect it; judge it from the CI line above instead (\`CI: green\` means that job, and so this scan, passed) plus your own read of the diff. Open with \`none found — ${SECRET_SCAN_CHECK} passed\` only when CI above is green; if CI is red or pending, say so instead. Your own read of the diff for a credential the scanner's rules cannot see still applies.`,
          'The summary then states your agent-config judgement — when an AGENT-CONFIG SCAN block appears above, base it on that block plus your own read of the agent-config diff; the driver already ran the scanner outside its own trust, so never run `npx`, install a package, or run a scanner yourself. When that block says the scan was not applicable, not configured, or could not run, say exactly that and judge the config on your own read.'
        ]),
    'If you cannot review — an input missing or unreadable, the diff unavailable, tooling unavailable, or a scope only the Principal can settle — return status blocked with that blocker kind instead of a verdict. A blocked result is no review, never approval.'
  ].join('\n')
  return `${base}\n\n${instructions}`
}
