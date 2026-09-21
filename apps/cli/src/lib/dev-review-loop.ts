/**
 * `devReviewLoop` — the driver half of the loop spec (Linear's
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
 *
 * `apps/cli/src/lib/dev-review-loop.ts` is the COMPOSITION ROOT:
 * the driver is split into modules
 * under `apps/cli/src/lib/dev-review-loop/`, one per concern — gate reading,
 * reviewer dispatch and report parsing, round assessment glue, publication,
 * pause and resume, developer dispatch and branch polling. `devReviewLoop`
 * itself (its own internal closures — `dispatchReviewer`, `dispatchDeveloper`,
 * the round loop) stays here: it is the one function that genuinely shares
 * state (`d`, `root`, `task`, `branch`, `policy`) across every concern, so
 * splitting IT apart would mean threading that state through explicit
 * parameters everywhere — a real design change, not a move. Every name this
 * file used to export directly is still exported from this exact path,
 * either defined here or re-exported from the module that now owns it —
 * so no existing import elsewhere in this codebase needed to change.
 */

import { randomUUID } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import {
  assessRound,
  briefHash as briefHashOf,
  buildReviewInputManifest,
  compareManifest,
  DEFAULT_REVIEW_POLICY,
  DevReviewLoopEventSchema,
  initialLoopState,
  manifestAsEchoed,
  nextRoundNumber,
  policyDigest as policyDigestOf,
  type Confidence,
  type Decision,
  type DevReviewLoopEventInput,
  type EscalationRecord,
  type LoopConfig,
  type LoopState,
  type Observations,
  type PauseReason,
  type ReconstructedJournal,
  type ReviewInputManifest,
  type ReviewPolicy,
  type RoundHeadIdentity,
  type RoundStats
} from '@attalabs/aeg-core'
import {
  AGENT_VENDOR_NAMES,
  type AgentVendor,
  dispatchRole as realDispatchRole,
  type DispatchHandle,
  isAgentVendor,
  readResumeRecord as realReadResumeRecord,
  type ResumeRecord,
  terminateLaunchedChildOnShutdown as realTerminateLaunchedChildOnShutdown
} from './dispatch.js'
import { postMarkedComment } from './forge-write.js'
import { createLogSink, currentRunId, drainLogSink, log, resolveLogAppendPath } from './log-sink.js'
import { ensureRunDir, markProcessUnattended, runPath } from './run-paths.js'
import { defaultTaskSweepAsyncDeps, sweepModernTasksAsync } from './task-sweep.js'
import { appendRoleLine, appendRunStartMarker, loopLogPathFor } from './loop-log.js'
import { resolveRepo } from '@attalabs/aeg-forge-state'
import {
  describeFailingCheckRun,
  fetchCiConclusion,
  fetchConflictingFiles,
  fetchFailingCheckRuns,
  fetchMergeableState,
  gitCommitsTouchingDriverPaths,
  type MergeableState,
  readWorktreeHead,
  resolveHead,
  sh
} from './dev-review-loop/gate-reading.js'
import {
  describeObjectivesEdit,
  developerBranchFor,
  DeveloperStopSignal,
  fetchDeveloperStop,
  fetchFrozenBrief,
  fetchNewestRulingAuthor,
  fetchNewestRulingOrdinal,
  fetchPrBody,
  fetchRulings,
  fetchSourceRevision,
  findOpenPrForBranch,
  LaunchContinuityLost,
  recoverDeveloperLaunch,
  resolveIssueObjectives,
  reviewPolicy,
  taskFromPrBody,
  withPromptFile
} from './dev-review-loop/developer-dispatch.js'
import {
  buildVerdictFromReport,
  discardHeldVerdicts,
  hasObjectivesFacts,
  latestHeldRequestChanges,
  missingReviewerArtifacts,
  persistManifestRecord,
  readIfExists,
  renderReviewerDispatchPrompt,
  runtimeDir,
  type ReviewerPromptFacts,
  ReviewerInfrastructureFailure,
  ReviewerReportParseFailure,
  reviewerWorkDir,
  type RoundVerdictParse,
  writeHeldVerdict
} from './dev-review-loop/reviewer-dispatch.js'
import {
  buildReviewerScratch,
  buildVerifiedReviewerCandidate,
  cleanupAllReviewerIsolationArtifacts,
  cleanupReviewerIsolationForRound
} from './dev-review-loop/reviewer-isolation.js'
import {
  assertDispatchOrEscalate,
  CONFIDENCE_FILE_NAME,
  confidencePromptLine,
  developerRoundMarker,
  DEVELOPER_ROUND_RESPONSE_FILE_NAME,
  driverCrashEvents,
  driverDecidedPauseEvents,
  MAX_GATE_STALLED_TURNS,
  MAX_INFRASTRUCTURE_RETRIES,
  parseConfidenceReply,
  parseRoundResponseFindingIds,
  parseShortstat,
  persistLoopState,
  pollUntil,
  renderDeveloperRoundComment,
  roundResponsePromptLine,
  routeCompletionEvents,
  sizeOfSafe,
  waitForOwnLoopLine
} from './dev-review-loop/round-assess.js'
import { buildReport, gh, resolveMergeBase, runReportForOpenPr } from './pr-report-engine.js'
import { reassertPrBodyPremise } from '../checks/bin/check-pr-premise-reassert.js'
import type { PremiseReassertResult } from '../checks/premise-reassert-logic.js'
import { postForgeEffectOnce, publishRound } from './dev-review-loop/publication.js'
import { fetchLoopHistory } from './dev-review-loop/journal-history.js'
import {
  clearDriverLock,
  escalationIdFor,
  fenceStartedEffectsAsUncertain,
  isDriverPidAlive,
  type PauseCommentPostResult,
  type PauseState,
  postIssuePauseComment,
  postPauseComment,
  printDriverLockLine,
  readDriverLock,
  readEscalationRecord,
  readPauseState,
  recoverLoopState,
  ReplayedResolutionError,
  resolveEscalation,
  type ResolveEscalationResult,
  sanitizePublicPauseDetail,
  StaleEscalationError,
  writeDriverLock,
  writeEscalationRecord,
  writePauseState,
  WrongTargetResolutionError
} from './dev-review-loop/pause-resume.js'

// Re-exports — every name this file exported before the O8 split still
// resolves from this exact path, either defined below or re-exported from
// the module that now owns it.
export {
  describeFailingCheckRun,
  fetchCiConclusion,
  fetchConflictingFiles,
  fetchFailingCheckRuns,
  fetchMergeableState,
  gitCommitsTouchingDriverPaths,
  readWorktreeHead,
  resolveHead
} from './dev-review-loop/gate-reading.js'
export type { MergeableState } from './dev-review-loop/gate-reading.js'
export { DRIVER_OWNED_PATHS, parseMergeTreeConflictFiles } from './dev-review-loop/gate-reading.js'
export {
  describeObjectivesEdit,
  developerBranchFor,
  DeveloperStopSignal,
  extractObjectivesSection,
  fetchDeveloperStop,
  fetchFrozenBrief,
  fetchIssueTitle,
  fetchNewestRulingAuthor,
  fetchNewestRulingOrdinal,
  fetchRulings,
  fetchSourceRevision,
  filterDeveloperStops,
  filterPrincipalRulings,
  findLatestPrincipalObjectivesEdit,
  findOpenPrForBranch,
  findPrincipalFrozenBrief,
  NO_SOURCE_REVISION,
  parseObjectivesEditComment,
  resolveIssueObjectives,
  taskFromPrBody
} from './dev-review-loop/developer-dispatch.js'
export type {
  MarkerComment,
  ObjectivesEditParse,
  ObjectivesEditSource,
  ObjectivesResolution
} from './dev-review-loop/developer-dispatch.js'
export {
  lintReviewerPrompt,
  reclassifyProseOnlyNotMet,
  runtimeDir,
  renderReviewerPrompt,
  ReviewerInfrastructureFailure,
  ReviewerReportParseFailure,
  writeHeldVerdict
} from './dev-review-loop/reviewer-dispatch.js'
export type { ReviewerPromptFacts } from './dev-review-loop/reviewer-dispatch.js'
export { publishRound } from './dev-review-loop/publication.js'
export type { PublishInput } from './dev-review-loop/publication.js'
export {
  escalationIdFor,
  fenceStartedEffectsAsUncertain,
  readEscalationRecord,
  readResolutionRecord,
  renderNoPushStopComment,
  renderPauseComment,
  ReplayedResolutionError,
  resolveEscalation,
  StaleEscalationError,
  writeEscalationRecord,
  WrongTargetResolutionError
} from './dev-review-loop/pause-resume.js'
export type { EscalationFacts, ResolveEscalationResult } from './dev-review-loop/pause-resume.js'
export {
  CONFIDENCE_FILE_NAME,
  confidencePromptLine,
  DEVELOPER_ROUND_RESPONSE_FILE_NAME,
  developerRoundMarker,
  DevReviewLoopResumeError,
  parseConfidenceReply,
  parseRoundResponseFindingIds,
  renderDeveloperRoundComment,
  roundResponsePromptLine,
  routeCompletionEvents
} from './dev-review-loop/round-assess.js'

// --- deps (injectable; every field defaults to the real implementation) -----

export type LoopDeps = {
  dispatchRole: typeof realDispatchRole
  resolveHead: typeof resolveHead
  fetchCiConclusion: typeof fetchCiConclusion
  /** O3: named check-runs, never the review gate's own (excluded upstream). */
  fetchFailingCheckRuns: typeof fetchFailingCheckRuns
  fetchRulings: typeof fetchRulings
  fetchNewestRulingOrdinal: typeof fetchNewestRulingOrdinal
  /** O2: the GitHub login that authored the newest principal ruling — a resolution record's `authenticatedBy`. */
  fetchNewestRulingAuthor: typeof fetchNewestRulingAuthor
  fetchFrozenBrief: typeof fetchFrozenBrief
  resolveIssueObjectives: typeof resolveIssueObjectives
  /** O2: the frozen brief's own source revision, named to the reviewer as a fact. */
  fetchSourceRevision: typeof fetchSourceRevision
  developerBranchFor: (issueNumber: number) => string
  findOpenPrForBranch: typeof findOpenPrForBranch
  /** O4: the durable session id `dispatch.ts` last recorded for this repo+role+vendor+task, or `null`. */
  readResumeRecord: (
    task: number,
    agent: AgentVendor,
    repo: { owner: string; repo: string } | null
  ) => ResumeRecord | null
  /**
   * The one directory this task's run writes under (`run-paths.ts`) — the
   * driver lock, the control records, the held verdicts, every round's
   * reviewer hand-off files and isolation copies.
   */
  runtimeDir: () => string
  /**
   * The exact path THIS process's `log()` calls for `task` land at — a
   * folder destination's own file, or the local retry queue ahead of a
   * server drain (`log-sink.ts`'s `resolveLogAppendPath`). Used only to know
   * where to poll for an event's own line landing (`logEvents`, below) —
   * the loop never reads this file back for anything else, and never
   * flushes or otherwise publishes it: events reach the configured `logs`
   * destination live, as they are logged.
   */
  resolveLogAppendPath: (repo: { owner: string; repo: string } | null, issue: number) => string | Promise<string>
  repoRoot: () => string
  gitRevParseOriginMain: () => string
  /**
   * issue-657, O4 — the review-input manifest's own base identity: the
   * merge base of `head` and the default branch, never the default branch's
   * raw tip (`gitRevParseOriginMain`, above) — a base that moved past the
   * candidate's branch point is never part of the pull request's own diff,
   * and a two-dot diff against the raw tip attributes that drift to the PR.
   * Reuses `pr-report-engine.ts`'s own `resolveMergeBase` (the same
   * `origin/main`-then-`main` fallback the Evidence block's Group A diff
   * already resolves through) rather than a second, ad hoc `git`
   * invocation — one capability, one function. Throws
   * `UnresolvableMergeBaseError` when no candidate ref yields a base that is
   * a real common ancestor of `head` (unrelated histories, or neither ref
   * resolves) — the same fail-loud posture every other git dependency here
   * already takes; the caller never falls back to a value that is not
   * actually an ancestor of the head it is judging.
   */
  gitMergeBase: (head: string) => Promise<string>
  gitFetch: (sha: string) => void
  gitDiffShortstat: (base: string, head: string) => string
  /** The task's round journal, rebuilt from the pull request's principal-authored forge markers (developer round markers, the published summary) — never a log event, a flushed log comment or the telemetry outbox. */
  fetchLoopHistory: (prNumber: number | null) => ReconstructedJournal
  sleep: (ms: number) => Promise<void>
  now: () => number
  prPollMaxAttempts: number
  prPollIntervalMs: number
  gatePollMaxAttempts: number
  gatePollIntervalMs: number
  /** O2/O3: the developer's own worktree HEAD (`.worktrees/<branch>`), or `null` when unreadable/unknown. */
  readWorktreeHead: typeof readWorktreeHead
  /**
   * The developer's own worktree's uncommitted files (`git
   * status --porcelain`, one path per entry) and how many commits its local
   * `HEAD` sits ahead of its upstream — read fresh after every developer
   * turn that ends with no new head on the branch, to tell "stopped without
   * pushing real work" (either signal non-zero) apart from a genuinely idle
   * turn (both zero). Best-effort: an unreadable worktree or a branch with
   * no upstream tracking ref reports zero for that half, never throws.
   */
  readUnpushedWorkDetail: (worktreePath: string) => { dirtyFiles: string[]; aheadCount: number }
  /** O9: the newest developer-stop comment on the task Issue, or `null`. */
  fetchDeveloperStop: typeof fetchDeveloperStop
  /** O4/O5/O7: the forge's own mergeable state for a PR. */
  fetchMergeableState: typeof fetchMergeableState
  /** O4/O6: the conflicting file(s) between a head branch and the base. */
  fetchConflictingFiles: typeof fetchConflictingFiles
  /** O8: commits touching `DRIVER_OWNED_PATHS` between two base-branch shas. */
  gitCommitsTouchingDriverPaths: typeof gitCommitsTouchingDriverPaths
  /** O7: pulls the default branch in place. `{ok:true}` on success; `{ok:false, reason}` on any failure (merge conflict, network, detached HEAD) — never throws. */
  pullDefaultBranch: () => { ok: true } | { ok: false; reason: string }
  /** O7: re-execs this same process (same interpreter, same entry script) with `args` replacing the subcommand/flags, `stdio: 'inherit'`. Returns the child's exit code, or `null` when the spawn itself could not even start. Never throws. */
  reexecSelf: (args: string[]) => number | null
  /** O7: the driver's actual process-exit call, injected so a test can observe "the driver would hand off here" without killing the test process. Production default is the real `process.exit`. */
  exitProcess: (code: number) => never
  /**
   * Runs the `AEG:EVIDENCE` report in-process and pushes it
   * onto `prNumber`'s live body, from `cwd` (the task's own worktree — see
   * `pr-report-engine.ts`'s module doc, "`cwd`"). The SAME engine function
   * `vinaya pr report --push` itself calls (`runReportForOpenPr`) — never a
   * `vinaya pr report --push` subprocess (Traps to avoid). Never collects a
   * token row (`includeTokens: false` — see `runReportForOpenPr`'s own doc
   * comment for why: the driver's own session is not the Developer's, so its
   * metering probe would misattribute usage). `{ ok: false, reason }` on any
   * refusal — the caller treats this as a non-fatal, logged condition (O1:
   * this task's whole point is that the loop's own paperwork must never cost
   * a round), never a pause.
   */
  runEvidenceReport: (
    prNumber: number,
    cwd: string,
    branch: string
  ) => Promise<{ ok: true; gatesFailed: boolean } | { ok: false; reason: string }>
  /**
   * O1 (widened after a round-3 review found a MAJOR/HIGH gap): called from the
   * driver's own `SIGTERM`/`SIGINT` handlers, before it exits. Terminates
   * whichever of `developer`/`code-reviewer`/`security`'s launches is
   * genuinely in flight and marks its launch record `interrupted` — never
   * an orphan left running past this driver's own death, and never a stale
   * `'launched'` record for the next start to misread as still live.
   * Reviewers are dispatched via the SAME `dispatchRole`/`LaunchRecord`
   * machinery the developer is (concurrently, via `Promise.all` — see
   * "Reviewers" in `apps/cli/specs/loop.md`), so a signal arriving mid-round
   * can orphan a reviewer's child exactly as it can the developer's; each
   * role's own launch record is checked independently, and a role with
   * nothing in flight is a safe no-op. Injected so a test can observe "the
   * driver would clean up here" without touching a real process or the
   * real session-record home, this task's own `sessions/` folder.
   */
  terminateInFlightLaunchesOnShutdown: (
    task: number,
    agent: AgentVendor,
    repo: { owner: string; repo: string } | null
  ) => void
  /**
   * The same keep-policy `vinaya task sweep` runs on demand, started once
   * at the very start of a run — but never awaited before the first
   * dispatch, since its own lookups run concurrently with everything else
   * this process does. `task` excluded so this run never sweeps its own
   * folder. Best-effort by design: a failure here is reported and ignored,
   * never a reason the run itself stops. The returned promise never
   * rejects; awaited once, in this function's own `finally`, so the
   * process never exits mid-removal.
   */
  sweepTasksAtStart: (task: number) => Promise<void>
}

function defaultRepoRoot(): string {
  return sh('git', ['rev-parse', '--show-toplevel'])
}

function defaultGitRevParseOriginMain(): string {
  return sh('git', ['rev-parse', 'origin/main'])
}

function defaultGitMergeBase(head: string): Promise<string> {
  return resolveMergeBase(head)
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
 * O6: every event this loop emits, checked against its own
 * per-discriminant shape before `meta`/`subject` exist — derived from
 * `DevReviewLoopEventSchema` (`@attalabs/aeg-core`), the exact schema
 * `log-sink.ts` validates the FULL envelope against, minus the two fields
 * only `buildHeader` can fill in. Built once, from the schema the package
 * already exports — no second, hand-maintained field list to drift from
 * the real one.
 */
// `z.discriminatedUnion`'s own generic constrains every option's shape to be
// statically known to share ONE literal-typed discriminator key — a
// constraint TypeScript cannot verify across ten independently-omitted
// object schemas built by a `.map`, though every one of them genuinely
// does carry `event` as a string literal at runtime (the exact same
// `DevReviewLoopEventSchema` already relies on this to build itself). Cast
// through the function, not the data: a discriminated union gives a
// PER-BRANCH parse error (the failing field, not a "no branch matched"
// aggregate) — the entire reason this exists, so `z.union`'s looser typing
// is not an acceptable substitute here.
const DevReviewLoopEventInputSchema: z.ZodTypeAny = (z.discriminatedUnion as any)(
  'event',
  DevReviewLoopEventSchema.options.map((option) =>
    (option as z.ZodObject<z.ZodRawShape>).omit({ meta: true, subject: true })
  )
)

/**
 * O6: refuses an event this loop is about to emit, naming the exact field
 * that fails its own schema — checked HERE, at emit time, inside
 * `logEvents` below, so a malformed event never reaches the outbox at all;
 * `log-flush.ts`'s own `parseOutboxLine` re-validation at flush time is
 * then a check that always passes for this loop's own lines, never the
 * first place a violation would be caught. Thrown, not warned:
 * `logEvents`'s every call site is inside the round loop's own top-level
 * `catch` (below), which turns any thrown error into a graceful
 * `pause{reason:'infrastructure'}` — the same treatment every other
 * unexpected failure on this path already gets, never a re-thrown
 * exception that crashes the process.
 */
export function assertValidLoopEvent(e: DevReviewLoopEventInput): void {
  const parsed = DevReviewLoopEventInputSchema.safeParse(e)
  if (parsed.success) return
  const issue = parsed.error.issues[0]
  const field = issue && issue.path.length > 0 ? issue.path.join('.') : '(root)'
  throw new Error(
    `devReviewLoop: refusing to emit a "${e.event}" event — field \`${field}\` ${issue?.message ?? 'fails its own schema'}.`
  )
}

/**
 * O2: the loop's own two control files
 * (`CONFIDENCE_FILE_NAME`, `DEVELOPER_ROUND_RESPONSE_FILE_NAME`) are now
 * written under that round's own Developer folder inside the task's folder
 * (`runPath`'s `{ area: 'developer', ... }`), never at the worktree root —
 * so this reads the worktree's own `git status --porcelain` with no
 * exemption at all: a file bearing either old name that still shows up here
 * is ordinary untracked work, exactly like any other stray file, never
 * specially ignored.
 */
function defaultReadUnpushedWorkDetail(worktreePath: string): { dirtyFiles: string[]; aheadCount: number } {
  let dirtyFiles: string[] = []
  try {
    // Deliberately NOT `sh()`: its own blanket `.trim()` on the whole output
    // destroys porcelain's own leading space on line 1 when the status code
    // there is ` M` (unstaged modify) — the single most common code — before
    // this function's own fixed-width slice ever runs. `execFileSync` here
    // keeps every byte porcelain actually printed.
    const raw = execFileSync('git', ['-C', worktreePath, 'status', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    dirtyFiles = raw
      .split('\n')
      .filter((line) => line.length > 3)
      .map((line) => line.slice(3))
  } catch {
    // Worktree unreadable — nothing to report.
  }
  let aheadCount = 0
  try {
    const count = sh('git', ['-C', worktreePath, 'rev-list', '--count', '@{u}..HEAD'])
    const parsed = Number.parseInt(count.trim(), 10)
    aheadCount = Number.isFinite(parsed) ? parsed : 0
  } catch {
    // No upstream tracking ref (or the worktree is unreadable) — zero, not a throw.
  }
  return { dirtyFiles, aheadCount }
}

/**
 * O1/O3: `assessRound`'s own `'confidence'` pause (`packages/aeg-core`, out
 * of this task's Surface — the guard itself is untouched) carries no
 * `detail` at all for either branch that reaches it (a re-asked turn that
 * never reported one; a reported value still under 50 after the loop's one
 * extra turn). The driver already read the exact `Confidence` value that
 * decided which branch fired — this only narrates that already-observed
 * fact, never a new one `assessRound` didn't already see.
 */
export function describeConfidencePauseDetail(confidence: Confidence): string {
  if (confidence === 'absent') {
    return 'no confidence line was found on the re-asked turn — the developer never reported one a second time'
  }
  const reasonSuffix = confidence.reason ? ` (${confidence.reason})` : ''
  return `confidence reported at ${confidence.value}${reasonSuffix}, below the required 50 threshold, after the loop's one extra turn was already used`
}

/**
 * O1/O3: the `'reappearance'`/`'escalation'` pauses
 * `assessVerdicts` decides (`packages/aeg-core`, out of Surface) carry no
 * `detail` either, though the round's own `findings_compared` event (Boundary:
 * read here, never recomputed — the comparison itself stays entirely in
 * `assessRound`) already names exactly which finding ids reappeared, and the
 * driver already knows which role(s) returned `ESCALATE` from the same
 * verdicts it built `Observations` from. `max_rounds` is excluded: it
 * already carries its own `detail` from `assessRound` (`max rounds: <n>`),
 * so this is never called for it (see the `decision.detail === undefined`
 * guard at each call site). `assessVerdicts` no longer decides a
 * `'no_progress'` pause at all — the driver's own attach-redelivery pause is
 * the only `'no_progress'` source now, and it builds its own `detail` inline
 * rather than here.
 */
export function deriveVerdictPauseDetail(
  reason: PauseReason,
  events: readonly DevReviewLoopEventInput[],
  reviewerEscalated: boolean,
  securityEscalated: boolean
): string | undefined {
  if (reason === 'escalation') {
    const roles = [reviewerEscalated ? 'reviewer' : null, securityEscalated ? 'security' : null].filter(
      (r): r is string => r !== null
    )
    return roles.length > 0 ? `${roles.join(' and ')} returned ESCALATE this round` : undefined
  }
  const findingsCompared = events.find(
    (e): e is Extract<DevReviewLoopEventInput, { event: 'findings_compared' }> => e.event === 'findings_compared'
  )
  if (!findingsCompared) return undefined
  if (reason === 'reappearance') {
    return findingsCompared.recurring.length > 0
      ? `finding${findingsCompared.recurring.length > 1 ? 's' : ''} ${findingsCompared.recurring.join(', ')} reappeared after being marked resolved in an earlier round`
      : undefined
  }
  return undefined
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * The redaction itself lives in `sanitizePublicPauseDetail`
 * (`dev-review-loop/pause-resume.js`), applied unconditionally INSIDE
 * `postPauseComment` — every pause reason's `detail` is sanitized there, not
 * only this file's own uncaught-error path. This wrapper survives only
 * because callers (and this file's own tests) still reach for the
 * `err: unknown` shape; it adds nothing `postPauseComment` doesn't already
 * re-apply.
 */
export function sanitizeUncaughtErrorForPublicPause(err: unknown): string {
  return sanitizePublicPauseDetail(err instanceof Error ? err.message : String(err))
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

/** O7: `git pull --ff-only origin main` — the exact update `checkStaleDriver` re-execs from. `--ff-only` refuses rather than fabricating a merge commit on a base this driver never touches directly. */
function defaultPullDefaultBranch(): { ok: true } | { ok: false; reason: string } {
  try {
    execFileSync('git', ['pull', '--ff-only', 'origin', 'main'], { stdio: ['ignore', 'ignore', 'pipe'] })
    return { ok: true }
  } catch (err) {
    const stderr = err && typeof err === 'object' && 'stderr' in err ? String((err as { stderr: unknown }).stderr) : ''
    return { ok: false, reason: stderr.trim() || (err instanceof Error ? err.message : String(err)) }
  }
}

/** O7: `process.argv[0]`/`[1]` are the interpreter and entry script this process itself was started with — re-spawning them with a fresh `args` tail reattaches under the exact same runtime, whether that's `bun apps/cli/src/index.ts` from source or a bundled `vinaya` binary. `stdio: 'inherit'` so the reattached run's own output reaches whatever terminal/log is watching this one. */
function defaultReexecSelf(args: string[]): number | null {
  const result = spawnSync(process.argv[0] as string, [process.argv[1] as string, ...args], { stdio: 'inherit' })
  if (result.error) return null
  return result.status ?? 1
}

/**
 * The real `runEvidenceReport`: fetches `prNumber`'s live
 * body, builds the report from `cwd` (the task worktree, never
 * `process.cwd()` — see `pr-report-engine.ts`'s module doc, "`cwd`"), then
 * pushes it via `runReportForOpenPr` — the exact engine function `vinaya pr
 * report --push` itself calls. `includeTokens: false`: see `runEvidenceReport`'s
 * own doc comment on `LoopDeps`. Never throws — every failure mode (the
 * initial `gh pr view` fetch, `buildReport` itself, or the push) collapses to
 * `{ ok: false, reason }` so the caller can log-and-continue rather than
 * treat the loop's own evidence bookkeeping as a stop condition.
 *
 * Builds a local `envOverlay` object for `buildReport`'s Group B gate child
 * and passes `branch` straight into `runReportForOpenPr`, rather than
 * mutating this process's own `process.env.PR_BODY`/`PR_NUMBER`/`BRANCH` the
 * way a one-shot `vinaya pr report --push` CLI invocation safely does. This
 * function runs inside the driver's own long-lived process, concurrently
 * (via `Promise.all`) with `dispatchReviewer` calls that spawn their own
 * subprocesses reading this same process's `process.env` at spawn time — a
 * global mutation here would race those spawns and leak this PR's body/
 * number into a reviewer or security agent's environment, or have a check
 * that agent spawns grade the wrong body. Never touching the shared
 * `process.env` closes both hazards at once: nothing to race, and nothing
 * left over to restore afterward.
 */
async function defaultRunEvidenceReport(
  prNumber: number,
  cwd: string,
  branch: string
): Promise<{ ok: true; gatesFailed: boolean } | { ok: false; reason: string }> {
  const pushPr = String(prNumber)
  let preEditBody: string
  try {
    preEditBody = await gh(['pr', 'view', pushPr, '--json', 'body', '-q', '.body'])
  } catch (err) {
    return {
      ok: false,
      reason: `could not fetch PR ${pushPr}'s live body: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  const envOverlay: NodeJS.ProcessEnv = { ...process.env, PR_BODY: preEditBody, PR_NUMBER: pushPr, BRANCH: branch }
  try {
    const result = await buildReport({ body: preEditBody, gradedBodySource: 'push', cwd, envOverlay })
    // Every non-`'ok'` kind carries a `message` and reaches here as an
    // ordinary return, never a process exit — including `'body-checks-refused'`:
    // a body-check refusal during this push is just one more
    // failure mode this ternary already collapses to `{ ok: false, reason }`.
    const outcome = await runReportForOpenPr(pushPr, preEditBody, result, { includeTokens: false, branch })
    return outcome.kind === 'ok'
      ? { ok: true, gatesFailed: outcome.gatesFailed }
      : { ok: false, reason: outcome.message }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * O1 (widened after a round-3 review found a MAJOR/HIGH gap): every role this driver ever
 * dispatches through `dispatchRole` — developer AND both reviewers, which
 * run concurrently — is a candidate for an in-flight launch a shutdown
 * signal could orphan. `terminateInFlightLaunchesOnShutdown`'s default
 * implementation checks all three unconditionally; a role with nothing in
 * flight reads its own launch record as not `'launched'` and is a no-op.
 */
const IN_FLIGHT_SHUTDOWN_ROLES = ['developer', 'code-reviewer', 'security'] as const

/** Shared by `LoopDeps.terminateInFlightLaunchesOnShutdown`'s own default AND `cancelDevReviewLoop`'s (O3) — the identical role loop, never a second copy that could drift from it. */
function defaultTerminateInFlightLaunchesOnShutdown(
  task: number,
  agent: AgentVendor,
  repo: { owner: string; repo: string } | null
): void {
  for (const role of IN_FLIGHT_SHUTDOWN_ROLES) realTerminateLaunchedChildOnShutdown(role, agent, repo, task)
}

function defaultDeps(): LoopDeps {
  return {
    dispatchRole: realDispatchRole,
    resolveHead,
    fetchCiConclusion,
    fetchFailingCheckRuns,
    fetchRulings,
    fetchNewestRulingOrdinal,
    fetchNewestRulingAuthor,
    fetchFrozenBrief,
    resolveIssueObjectives,
    fetchSourceRevision,
    developerBranchFor: (n) => developerBranchFor(n),
    findOpenPrForBranch,
    readResumeRecord: (task, agent, repo) => realReadResumeRecord('developer', agent, repo, task),
    runtimeDir,
    resolveLogAppendPath,
    repoRoot: defaultRepoRoot,
    gitRevParseOriginMain: defaultGitRevParseOriginMain,
    gitMergeBase: defaultGitMergeBase,
    gitFetch: defaultGitFetch,
    gitDiffShortstat: defaultGitDiffShortstat,
    fetchLoopHistory,
    sleep: defaultSleep,
    now: () => Date.now(),
    // O3: env-overridable the same way the gate poll
    // budget already is (`gatePollEnvOverride`'s own doc comment) — a real
    // subprocess test exercising the PR-poll timeout path needs this in
    // test time, not the ~30 real minutes the production budget takes.
    // Unset in every real invocation, so production behavior is unchanged.
    prPollMaxAttempts: gatePollEnvOverride('VINAYA_DEV_REVIEW_LOOP_PR_POLL_MAX_ATTEMPTS', 120),
    prPollIntervalMs: gatePollEnvOverride('VINAYA_DEV_REVIEW_LOOP_PR_POLL_INTERVAL_MS', 15_000),
    gatePollMaxAttempts: gatePollEnvOverride('VINAYA_DEV_REVIEW_LOOP_GATE_POLL_MAX_ATTEMPTS', 120),
    gatePollIntervalMs: gatePollEnvOverride('VINAYA_DEV_REVIEW_LOOP_GATE_POLL_INTERVAL_MS', 15_000),
    readWorktreeHead,
    readUnpushedWorkDetail: defaultReadUnpushedWorkDetail,
    fetchDeveloperStop,
    fetchMergeableState,
    fetchConflictingFiles,
    gitCommitsTouchingDriverPaths,
    pullDefaultBranch: defaultPullDefaultBranch,
    reexecSelf: defaultReexecSelf,
    exitProcess: (code) => process.exit(code),
    runEvidenceReport: defaultRunEvidenceReport,
    terminateInFlightLaunchesOnShutdown: defaultTerminateInFlightLaunchesOnShutdown,
    sweepTasksAtStart: defaultSweepTasksAtStart
  }
}

// --- the loop -----------------------------------------------------------------

/**
 * `model` (issue-661, O1) — resolved once by `task-run.ts`'s `runTask`
 * (explicit `--model`, then the Issue's own suggested-agent-class mapping,
 * then this vendor's default) and spent in exactly one place: the
 * developer's own `dispatchRole` call in `dispatchDeveloper` below.
 * `undefined` on the deprecated `task dispatch` path and on every direct
 * `devReviewLoop` caller that never resolved one — `dispatchRole` already
 * treats an absent `model` as "run this vendor's own default," unchanged.
 */
export type LoopInput = { json?: boolean; model?: string } & (
  | { task: number; agent: AgentVendor }
  | { resumePr: number; agent?: AgentVendor }
)
export type LoopResult = { finalDecision: Decision; prNumber: number; task: number }

/**
 * The exact argv `checkStaleDriver`'s re-exec hands to a fresh `vinaya
 * dev-review-loop` process — pulled out as its own pure function
 * (a round-2 review MINOR finding) so the one thing that
 * actually regresses easily — a flag silently dropped across the restart —
 * is unit-testable without driving the whole re-exec/driver-lock path.
 * Carries the ORIGINAL invocation's `--json` intent through: dropping it
 * would silently switch an unattended, machine-parsed caller over to
 * human-readable output the moment a moved base restarts this same driver
 * underneath it.
 *
 * O4: ALWAYS `--task <n>`, never `--resume <pr>`, even when
 * `input` itself carries a `resumePr` — a re-exec is this SAME run
 * continuing, not a fresh `--resume` invocation, and `--resume`'s own
 * top-of-function gate authenticates the Principal's ruling by CONSUMING
 * its resolution exactly once (`resolveEscalation`/`consumeResolutionOnce`,
 * `pause-resume.ts`), durably, in the control store. A re-exec that
 * rebuilt `--resume <pr>` re-entered that SAME gate a second time against
 * the SAME already-consumed resolution — `ReplayedResolutionError`, thrown
 * before this process's own outer `try`/`finally` even starts, so nothing
 * traces it: a resumed loop that ran a full round, took the developer's
 * next push, then hit a stale-driver restart mid-round exited with no
 * pause and no reviewers (origin: live, 2026-09-19). `--task <n>`'s own
 * round-1 entry already attaches to the open PR with no ruling required
 * (`loop.md` § Rounds — "an already-open pull request… means ATTACH") and
 * recovers the round number from the durable journal/held-verdict state,
 * exactly the position a mid-loop restart needs — never from a stale
 * `pause-state.json` a completed resume has already moved past. A
 * genuinely fresh, human-invoked `--resume <pr>` past an already-consumed
 * resolution must still refuse (Traps to avoid) — this function is never
 * in that path; it only shapes the driver's OWN internal re-exec.
 */
export function buildReexecArgs(input: LoopInput, task: number): string[] {
  if (!input.agent) throw new Error('buildReexecArgs: resolved agent is required')
  return [
    'dev-review-loop',
    '--task',
    String(task),
    '--agent',
    input.agent,
    ...(input.model ? ['--model', input.model] : []),
    ...(input.json ? ['--json'] : [])
  ]
}

/**
 * `sweepModernTasksAsync`'s own call, started once at the start of every
 * run, `excludeScope: task` so this run never sweeps the very folder it is
 * about to write into. Best-effort: a thrown error is reported to stderr
 * and swallowed, never re-thrown — the same "the mechanics stalled, not a
 * review verdict" tolerance this driver already gives every other
 * best-effort side effect. Non-blocking lookups with bounded
 * concurrency (Traps to avoid) — never the legacy-layout half of the sweep
 * (Boundary: out of scope, and its own driver-side result was always
 * discarded anyway). Injectable (`LoopDeps.sweepTasksAtStart`) so a test
 * never shells out to real `gh` or touches a real runtime directory just
 * because a run started. Never rejects — every failure, including one from
 * `onDecision` itself, is caught and reported, so the caller can safely
 * await the returned promise unconditionally.
 */
async function defaultSweepTasksAtStart(task: number): Promise<void> {
  try {
    await sweepModernTasksAsync(
      task,
      (decision) => {
        const verb = decision.removed ? 'removed' : 'kept'
        console.error(
          `vinaya dev-review-loop: sweep — [${decision.completed}/${decision.total}] ${verb} ${decision.folder}: ${decision.reason}`
        )
      },
      defaultTaskSweepAsyncDeps
    )
  } catch (err) {
    console.error(`vinaya dev-review-loop: sweep failed — ${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function devReviewLoop(input: LoopInput, deps: Partial<LoopDeps> = {}): Promise<LoopResult> {
  // Round 2 review (MAJOR) / security review (MEDIUM): a driver runs with no
  // human watching, so it must resolve `runtimeDir` through the
  // default-branch gate rather than trusting the working tree. Marked FIRST,
  // before any path is resolved and before anything is dispatched, so the
  // classification is already true for this process and for every child that
  // inherits its environment.
  markProcessUnattended()
  const d: LoopDeps = { ...defaultDeps(), ...deps }
  const root = d.runtimeDir()

  let task: number
  let branch: string
  let prNumber = -1 // resolved below, before any use — never read while -1
  let resumeFrom: PauseState | null = null
  let dispatchAgent: AgentVendor = input.agent ?? 'claude'
  let dispatchModel = input.model
  /** O8: true when `--resume` found the head already moved past the pause-time head — a ruling followed by a fix push, the normal case. Widens `firstPass` below so the loop skips redispatching the developer (it already acted) and goes straight to the gate/reviewer path on the new head. */
  let resumeHeadAlreadyMoved = false

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
    if (held.agent !== undefined && !isAgentVendor(held.agent)) {
      throw new Error(`devReviewLoop --resume: held pause state carries invalid agent '${held.agent}'.`)
    }
    if (!input.agent && !held.agent) {
      throw new Error(
        'devReviewLoop --resume: this legacy pause state does not record an agent; retry once with --agent <claude|codex|gemini>.'
      )
    }
    if (input.agent && held.agent && input.agent !== held.agent) {
      throw new Error(
        `devReviewLoop --resume: task ${closesTask} was dispatched with agent '${held.agent}', not '${input.agent}'. Retry without --agent or with --agent ${held.agent}.`
      )
    }
    dispatchAgent = input.agent ?? (held.agent as AgentVendor)
    dispatchModel = input.model ?? held.model
    // O5: an `'infrastructure'` pause is the driver's own
    // recoverable hiccup, never a human decision point (same wording the
    // pause-return branch below already uses for it and `stale_driver`) —
    // `--resume` continues it on the bare command, no Principal ruling
    // required. Every OTHER pause reason is unchanged: a genuine decision
    // point still refuses to resume without one.
    // Bounded, and the bound is READ from
    // the control store rather than reset by this restart — a task that
    // keeps hitting `'infrastructure'`/`'stale_driver'` and getting resumed
    // past it forever, with no genuine review round in between, exhausts
    // this bare-command allowance and starts requiring a ruling like any
    // other reason. `'corrupt'` is read as "budget unknown, be
    // conservative" here — never as `0` — so a control-store read failure
    // can never itself grant an unbounded bare-command resume. Floored
    // against `held.infrastructureRetries` (round 2 review, security HIGH):
    // `held` is `writePauseState`'s own plain `writeFileSync` record, a
    // different write path than `persistLoopState`'s control-store one, so
    // a `persistLoopState` write that silently failed at the very pause
    // `held` itself records still leaves this floor intact — the
    // control-store read alone can no longer heal a real count down to `0`
    // (or any lower number) just because its own write never landed.
    const recoveredForResume = recoverLoopState(closesTask)
    const controlStoreInfrastructureRetries =
      recoveredForResume.status === 'ok'
        ? recoveredForResume.value.budgets.infrastructureRetries
        : recoveredForResume.status === 'corrupt'
          ? Number.POSITIVE_INFINITY
          : 0
    const infrastructureRetriesSoFar = Math.max(controlStoreInfrastructureRetries, held.infrastructureRetries ?? 0)
    const bareInfrastructureResume =
      held.reason === 'infrastructure' && infrastructureRetriesSoFar < MAX_INFRASTRUCTURE_RETRIES
    const rulings = bareInfrastructureResume ? [] : d.fetchRulings(resumePr)
    if (!bareInfrastructureResume && rulings.length === 0) {
      throw new Error(
        `devReviewLoop --resume: PR #${resumePr} carries no Principal ruling comment yet — nothing to resume from.` +
          (held.reason === 'infrastructure'
            ? ` (task ${closesTask} has hit ${infrastructureRetriesSoFar} infrastructure/stale_driver pause(s) — at or past the bound of ${MAX_INFRASTRUCTURE_RETRIES}, a ruling is required even for this reason.)`
            : '')
      )
    }
    // O2: the authenticated resolution — consumed at most once
    // (`resolveEscalation`), refusing a wrong-target, stale, or replayed
    // attempt before this run ever re-enters the round loop. An
    // `'infrastructure'`/`'stale_driver'` resume carries no ruling (above),
    // so it authenticates as the driver's own recoverable-hiccup recovery
    // rather than a principal decision — still consumed at most once, so a
    // duplicate bare `--resume` against the SAME held hiccup is refused too.
    // `held.escalationId` is the escalation's OWN real id — a disambiguating
    // suffix when `writeEscalation` had to claim one (code review, round 2,
    // MEDIUM); the natural key is still correct whenever no collision ever
    // happened, and for a `PauseState` written before this field existed.
    const resumeEscalationId = held.escalationId ?? escalationIdFor(closesTask, held.round, held.head)
    const resumeAuthenticatedBy =
      held.reason === 'infrastructure' ? 'driver-self' : (d.fetchNewestRulingAuthor(resumePr) ?? 'unknown-principal')
    const resumeAuthenticatedFrom =
      held.reason === 'infrastructure'
        ? `${resumePr}-infrastructure-retry`
        : `${resumePr}-${d.fetchNewestRulingOrdinal(resumePr)}`
    let attachAfterReplayedResolution = false
    try {
      resolveEscalation(
        closesTask,
        resumeEscalationId,
        resumePr,
        'resume',
        resumeAuthenticatedBy,
        resumeAuthenticatedFrom
      )
    } catch (err) {
      if (err instanceof WrongTargetResolutionError || err instanceof StaleEscalationError) {
        throw new Error(`devReviewLoop --resume: ${err.message}`)
      }
      if (!(err instanceof ReplayedResolutionError)) throw err
      // An escalation that already carries a consumed resolution
      // is not necessarily a replay attempt to refuse — the run that
      // consumed it may itself have ended (a crash, or a later pause that
      // collided back onto the SAME natural key — `sameEscalationInstance`,
      // `control-store/local.ts`, treats a same-round/head/branch/pr/reason/
      // detail repeat as a rerun of the identical instance, so its own
      // `pause-state.json` write never advances past the already-consumed
      // id) before the task's review actually concluded. The storage
      // guarantee still binds exactly as before whenever a driver still
      // holds the task (Traps to avoid: never weakened for that case), or
      // whenever the task's own durable journal already shows this review
      // concluded — nothing left for a bare `--resume` to attach to, the
      // exact case the pre-existing "replay refused" fixture covers.
      // Otherwise this run continues from the pull request's CURRENT state
      // instead, the same attach a fresh `--task <n>` itself takes onto an
      // already-open PR — never fabricating a second resolution (Traps to
      // avoid), and never re-deriving a round/head from this stale record.
      const existingLock = readDriverLock(root, closesTask)
      const driverIsLive = existingLock !== null && isDriverPidAlive(existingLock.pid)
      const history = d.fetchLoopHistory(resumePr)
      const alreadyConcluded = history.journalFinalized?.result === 'merged_ready'
      if (driverIsLive || err.existing?.decision !== 'resume' || alreadyConcluded) {
        throw new Error(`devReviewLoop --resume: ${err.message}`)
      }
      attachAfterReplayedResolution = true
    }
    if (attachAfterReplayedResolution) {
      task = held.task
      branch = held.branch
    } else {
      const currentHead = d.resolveHead(held.branch)
      // O8: a moved head is accepted, never refused, once a ruling exists —
      // "a ruling followed by a fix push is the normal case." The ruling is
      // itself the round-cap override it declares: the round counter
      // restarts at the ruling's own newest ordinal (`fetchNewestRulingOrdinal`,
      // the same integer `ruling_posted` mid-round invalidation already reads)
      // rather than continuing from `held.round`, which may already sit past
      // `MAX_ROUNDS` and would otherwise re-trigger the very pause this
      // `--resume` exists to lift. An `'infrastructure'` resume carries no
      // ruling to re-derive that override from, so a moved head there just
      // keeps `held.round` — the same round this pause interrupted.
      resumeHeadAlreadyMoved = currentHead !== held.head
      task = held.task
      branch = held.branch
      prNumber = held.prNumber
      resumeFrom =
        resumeHeadAlreadyMoved && rulings.length > 0 ? { ...held, round: d.fetchNewestRulingOrdinal(resumePr) } : held
    }
  } else {
    task = input.task
    branch = d.developerBranchFor(task)
  }

  // O1: this run's own narration begins here, before the start-of-run
  // sweep below ever makes a forge lookup — the log sink (and this
  // process's own `runId`) is created now, rather than inside
  // `runDevReviewLoopBody` below (its later, original home), so the
  // run-start marker and a line saying the sweep is running land in the
  // loop log AND on stderr first. A driver that still has many folders
  // left to classify must never look silent while it works through them.
  const { log, runId, drain: drainLoopLogSink } = createLogSink()
  if (!process.env.VINAYA_RUN_ID) process.env.VINAYA_RUN_ID = runId
  // O3: two independent sink instances can both have a `log()` call in
  // flight when this driver is about to exit — this closure's own
  // `createLogSink()` instance above (the round/pause events `logEvents`
  // emits) and the module-level default sink (`./log-sink.js`'s plain
  // `log`/`drainLogSink`), which `effects.ts`'s `EffectExecutor` writes
  // its `attempted`/`observed`/`verified` lines through instead — a
  // separate `createLogSink()` call, with its own `pendingWrites`/
  // `drainChain`, that this closure's own `drain()` cannot see. Every abrupt
  // exit below drains both, never just the one this closure happens to own.
  const drainAllLogSinks = (): Promise<void> => Promise.all([drainLoopLogSink(), drainLogSink()]).then(() => undefined)
  // `loopLogPathFor`'s own `repo` parameter never affects the path it
  // returns (kept on the signature only for callers that already resolved
  // one) — passing `null` here means this marker never waits on
  // `resolveRepo()`, which only runs later, inside the body.
  const loopLogPath = loopLogPathFor(null, task)
  appendRunStartMarker(loopLogPath, { role: 'dev-review-loop', pid: process.pid, runId })
  appendRoleLine(loopLogPath, 'dev-review-loop', 'sweep — running')
  console.error('vinaya dev-review-loop: sweep — running')

  // The same keep-policy `vinaya task sweep` runs on demand, started here
  // but never awaited before dispatch (O2) — `excludeScope` (this run's OWN
  // task) is the guard against a race this exact invocation could otherwise
  // lose to itself: were the forge to report this task finished (a stale
  // read, or a genuine race against an external close), the sweep must
  // never remove the very folder this run is about to write its driver
  // lock and control-store records into. A sweep failure is reported to
  // this run's own stderr and ignored — never a reason the run itself
  // stops (Traps to avoid: a housekeeping pass must never gate the loop it
  // runs alongside). Awaited once, in the `finally` below, so the process
  // never exits while it is still mid-removal.
  const sweepDone = d.sweepTasksAtStart(task)

  // O1/O2: one driver per task — checked before any dispatch, a live record
  // refuses this start outright; a dead one (crashed prior driver) is taken
  // over rather than left blocking forever (Traps to avoid: no lease, no
  // timestamp expiry — liveness is the only test).
  const existingDriverLock = readDriverLock(root, task)
  if (existingDriverLock && isDriverPidAlive(existingDriverLock.pid)) {
    const message = `refuses to start for task ${task} — a driver is already running (pid ${existingDriverLock.pid}, started ${existingDriverLock.startedAt})`
    printDriverLockLine(message)
    throw new Error(`devReviewLoop: ${message}`)
  }
  if (existingDriverLock) {
    printDriverLockLine(
      `task ${task}'s driver lock names pid ${existingDriverLock.pid} (started ${existingDriverLock.startedAt}), which is no longer alive — taking over`
    )
  }
  writeDriverLock(root, task, { pid: process.pid, startedAt: new Date().toISOString() })
  // O3: restart cleanliness — a crashed or killed prior run's own
  // reviewer candidate/scratch directories never leak into this run. Safe
  // on a fresh task (nothing to remove) and mid-recovery from a stale lock
  // (above): this run builds its own artifacts for whichever round it
  // reaches first and never reads a prior run's leftovers.
  cleanupAllReviewerIsolationArtifacts(root, task)

  // True only for the two pause reasons that are
  // themselves an infrastructure/re-exec hiccup, never a human decision
  // point ('infrastructure', 'stale_driver') — set at the single shared
  // pause-return branch and at the outer crash catch below, both of which
  // this variable is declared ahead of so either closure can set it. Every
  // OTHER pause reason (escalation, max_rounds, confidence, reappearance,
  // no_push, objectives_changed, ruling_posted, brief_superseded,
  // policy_changed) is a genuine decision point a Principal must act on —
  // those clear the lock exactly as before, unchanged.
  let keepLockAlive = false

  try {
    return await runDevReviewLoopBody()
  } finally {
    // O3: every pause decision (including an uncaught error, converted to
    // `pause{reason:'infrastructure'}` by `runDevReviewLoopBody`'s own crash
    // catch) and every clean publish all return through here — the ONE
    // place this covers both exits the objective names. The caller
    // (`devReviewLoopCommand`) calls `process.exit(1)` on a pause AFTER
    // this promise resolves, so draining here, before that return, is what
    // makes both log sinks land everything first.
    await drainAllLogSinks()
    // O2/Traps: the sweep was never awaited before dispatch, but a run
    // that is about to exit must "let it finish… cleanly" rather than
    // leave a removal partway done — `sweepDone` never rejects (its own
    // doc comment), so this is safe unconditionally, including while a
    // real error is already propagating out of the `try`.
    await sweepDone
    // An infrastructure/stale_driver pause deliberately leaves the lock
    // in place — this run is not "done," it is a live process that hit a
    // recoverable hiccup, and a cleared lock here would misrepresent that
    // as a settled, resume-able-by-hand pause identical to a genuine
    // Principal-decision one. Every other exit (publish, an explicit stop,
    // or any other pause reason) clears it exactly as before.
    if (!keepLockAlive) clearDriverLock(root, task)
  }

  async function runDevReviewLoopBody(): Promise<LoopResult> {
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
    // O6: `policy`/`repoRoot`/
    // `baseHeadAtStart` are
    // DECLARED here, at the top of this function's scope, but ASSIGNED only
    // once the widened `try` below actually runs `reviewPolicy()`/
    // `d.repoRoot()`/`d.gitRevParseOriginMain()` — each a real forge/git
    // read that can throw. Declaring them here (rather than at the point of
    // assignment, inside the try) is what lets every OTHER function in this
    // scope — `checkStaleDriver`, `dispatchDeveloper`, `runRoundLoop`, all
    // declared throughout this function — keep closing over the SAME
    // outer-scope bindings they always have; only when the values are
    // actually computed moves.
    let policy!: ReviewPolicy
    let repoRoot!: string
    /** O8: recorded once, at loop start — never re-derived. Re-read at every round entry (top of the `while(true)` below) and compared against this fixed watermark for commits touching `DRIVER_OWNED_PATHS`. */
    let baseHeadAtStart!: string
    /**
     * O1: THIS round's own absolute path for
     * the Developer's confidence/round-response files, under
     * `<task folder>/rounds/<round>/developer/` — never a fixed path
     * computed once at loop start, since a resumed Developer session gets a
     * fresh prompt every round and reusing an earlier round's path would let
     * a stale round's answer be read as the current one.
     */
    function confidenceFilePathFor(roundNum: number): string {
      return runPath(root, task, { area: 'developer', round: roundNum, file: CONFIDENCE_FILE_NAME })
    }
    /** O1: the round-response counterpart to `confidenceFilePathFor`, above. */
    function roundResponseFilePathFor(roundNum: number): string {
      return runPath(root, task, { area: 'developer', round: roundNum, file: DEVELOPER_ROUND_RESPONSE_FILE_NAME })
    }
    const loopOutboxPath = await d.resolveLogAppendPath(repo, task)
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
        assertValidLoopEvent(e)
        const priorSize = sizeOfSafe(loopOutboxPath)
        log(e)
        await waitForOwnLoopLine(loopOutboxPath, priorSize, runId, e, d.sleep)
      }
    }

    // Every `log()` call this process makes from
    // here on — this driver's own `dev_review_loop` events AND every
    // `effect`/`operation` event a downstream call into `effects.ts`/
    // `broker.ts` emits (pause posts, escalation writes) — reads
    // `meta.lineage.run` from THIS env var (`log-sink.ts`'s own default
    // falls back to the process's bare `runId` only when it's unset), so
    // setting it to this run's own `loopId` is what makes "one correlated
    // history" (this task's own title) literally true: every event kind
    // this one process emits shares the same `lineage.run` value.
    const loopId = randomUUID()
    process.env.VINAYA_RUN = loopId
    const config: LoopConfig = {
      loopId,
      task: task,
      // `loop_started`'s own schema constrains `policy.reviewers`/`policy.models`
      // keys to `RoleSchema` (`schema.ts`) — the DOCTRINE role vocabulary
      // (`code-reviewer`), not `VerdictObservation.role`'s separate
      // `'reviewer' | 'security'` vocabulary this driver uses everywhere else
      // for the policy's own findings/verdict shape. Using `'reviewer'` here
      // fails schema validation silently (`log()` never throws — `loop_started`
      // just never lands in the outbox; found live authoring this task).
      reviewers: ['code-reviewer', 'security'],
      // issue-661, O1: the developer's own resolved model when `runTask`
      // resolved one, else the vendor name unchanged — reviewer/security
      // model resolution is out of this task's boundary.
      models: { developer: dispatchModel ?? dispatchAgent, 'code-reviewer': dispatchAgent, security: dispatchAgent },
      // O4: the repo-wide default, corrected to the REAL
      // `reviewPolicy()` value the moment the widened `try` below reads it
      // successfully (O6: `config` must be valid — never built from a
      // not-yet-read `policy` — before that read even runs, so a crash
      // reading policy itself still reports against a real `maxRounds`).
      maxRounds: DEFAULT_REVIEW_POLICY.maxRounds
    }
    let state: LoopState = initialLoopState(config)

    // The `resumed` observation — a genuine
    // `--resume` attach, already authenticated (`resolveEscalation`, above)
    // before this process ever re-entered the round loop. A bare
    // `'infrastructure'` recoverable-hiccup resume is never a Principal
    // decision (`resumeAuthenticatedBy` above reads `'driver-self'` for
    // exactly this reason) — `by: 'driver'` says so honestly rather than
    // claiming a ruling this process never actually read.
    if (resumeFrom !== null) {
      await logEvents([
        {
          kind: 'dev_review_loop',
          payload: {},
          loop_id: config.loopId,
          event: 'resumed',
          round: resumeFrom.round,
          by: resumeFrom.reason === 'infrastructure' ? 'driver' : 'principal'
        }
      ])
    }

    /**
     * The round journal is the task's, not this process's — on a plain
     * attach (never a genuine round-1 dispatch, which by construction has
     * no prior round to recover), rebuild the task's prior rounds from the
     * pull request's own principal-authored forge markers before this run
     * computes one of its own. `seedLoopHistory` is called from exactly one
     * site below: the `existingPr` attach branch. Its source is the forge
     * markers alone (`fetchLoopHistory`), NEVER a log event, a flushed log
     * comment, or the telemetry outbox — the Log is telemetry and is never
     * read to recover a run.
     *
     * Deliberately NEVER called on `--resume` (round 2 review, BLOCKER):
     * `resumeFrom.round` is the exact round the paused process was on before
     * it exited — its developer round marker is already on the forge, so
     * seeding here, then letting this same resumed run recompute and append
     * that identical round number again, is the precise double-count this
     * function's own append-only `state.rounds` guards against elsewhere
     * (see below) — the attach branch never hits it because attach always
     * continues at `held.round + 1`, one past anything reconstructed, while
     * resume deliberately continues AT `resumeFrom.round` to give the
     * ruling's fix a chance in the same round. `state.rounds` starts empty on
     * resume and accumulates only the rounds this process itself computes
     * from here on.
     *
     * Applied whenever this task has NOT actually reached a real terminal
     * publish — never gated on a round having merely decided `publish` (round
     * 2 review, BLOCKER): the control store's own `loop_state.phase` reads
     * `'publish'` the moment `assessRound` decides it, written before
     * `publishRound` ever runs, so it can never stand for "actually
     * published." The one honest signal is a principal-authored ready-for-
     * merge SUMMARY comment on the forge (`journalFinalized.result ===
     * 'merged_ready'`): `publishRound` posts it last, after both verdicts, so
     * a crash mid-publish (a `gh` failure) leaves NO summary and this reads
     * `null` — never mistaking that crash for a completion, the exact case
     * that once silently dropped every round from the published table and
     * restarted numbering at `1` on the next attach. Guards the one real
     * hazard seeding would otherwise create even when genuinely finalized:
     * `assessRound` always APPENDS to `state.rounds` (`assess-round.ts`'s
     * `buildRoundRecord` call sites), never deduplicates by round number —
     * seeding round 1's record here, then letting THIS SAME run recompute
     * round 1 live (the "rerun posts nothing twice" idempotency case), would
     * double it in the published table.
     */
    let loopHistory: ReconstructedJournal = { rounds: [], totalWallMs: 0, totalFilesChanged: 0, journalFinalized: null }
    /** Whether `seedLoopHistory` actually applied — the round-bump below reuses this instead of re-deriving the same "already published?" check a second time. */
    let historyApplies = false
    function seedLoopHistory(): void {
      // The forge markers on this task's own pull request — never a log
      // event or the telemetry outbox. `prNumber` is already the attached
      // PR's number by the one call site below.
      loopHistory = d.fetchLoopHistory(prNumber)
      const newest = loopHistory.rounds[loopHistory.rounds.length - 1]
      const actuallyPublished = loopHistory.journalFinalized?.result === 'merged_ready'
      historyApplies = newest !== undefined && !actuallyPublished
      if (!historyApplies) return
      state = {
        ...state,
        rounds: loopHistory.rounds,
        totalWallMs: loopHistory.totalWallMs,
        totalFilesChanged: loopHistory.totalFilesChanged
      }
    }
    let round = resumeFrom ? resumeFrom.round : 1

    // The authoritative recovery read —
    // this task's control-store `loop_state` record, if one has ever been
    // persisted. `'absent'` seeds every budget at zero, exactly the prior
    // behavior for a fresh task or one that predates this mechanism.
    // `'corrupt'` is read as "nothing safe to seed FROM here" for
    // `heldResultIdentity`/`deliveredFindingsIdentity` below (identical to
    // `'absent'`'s own defaults there) — never as license to guess a real
    // budget. The actual refusal is thrown from INSIDE the `try` block below
    // (round 2 review, BLOCKER): this call site sits before that `try` even
    // starts, so a throw here would escape `devReviewLoop` uncaught instead
    // of reaching the outer `catch` that turns it into a decided
    // `pause{reason:'infrastructure'}` — the one thing every comment on this
    // path already claimed it did. THAT catch persists whatever this
    // process's own `infrastructureRetries` variable holds at the moment of
    // the throw (`persistCurrentLoopState`) — so seeding it at `0` for
    // `'corrupt'`, the same default `'absent'` gets, would silently WRITE
    // BACK a healed, zeroed budget over the very record just refused as
    // untrustworthy (round 2 review, security HIGH: "a corrupted record
    // self-heals to a low count"). `infrastructureRetries` alone therefore
    // seeds `'corrupt'` at `MAX_INFRASTRUCTURE_RETRIES` — already "at the
    // bound," a real, JSON-safe number (unlike `--resume`'s own in-memory-only
    // `Number.POSITIVE_INFINITY` comparison, this value IS persisted) that
    // forces the next `--resume` to require a ruling rather than granting a
    // fresh bare-command allowance off a corruption-erased count.
    const recoveredLoopState = recoverLoopState(task)
    /**
     * O2: never reset by a restart — seeded from the control store, never
     * hardcoded to `0` the way a fresh in-memory run otherwise would be.
     * Floored against `resumeFrom.infrastructureRetries` (round 3 review,
     * MAJOR): on `--resume`, `resumeFrom` is the SAME `pause-state.json`
     * record the gate check above (`infrastructureRetriesSoFar`) already
     * floors its own comparison against — a different write path than
     * `persistLoopState`'s control-store one, so a control-store write that
     * has been silently failing for this task's whole life still leaves this
     * count recoverable there. Without this floor, a resume this process
     * legitimately reaches (bare, or ruling-backed) would reseed its OWN
     * live counter at the control store's understated reading, then persist
     * THAT lower number back into `pause-state.json` on its next pause —
     * overwriting the one independent record the gate depends on with a
     * value lower than the truth, reopening the exact unbounded-resume hole
     * the ruling ordered closed. `resumeFrom` is `null` on a fresh
     * (non-resume) start, where `?? 0` makes this `Math.max` a no-op.
     */
    let infrastructureRetries = Math.max(
      recoveredLoopState.status === 'ok'
        ? recoveredLoopState.value.budgets.infrastructureRetries
        : recoveredLoopState.status === 'corrupt'
          ? MAX_INFRASTRUCTURE_RETRIES
          : 0,
      resumeFrom?.infrastructureRetries ?? 0
    )
    /** O1/O3: the round whose verdict is currently held on disk, awaiting delivery or publish — recovered so a crash between holding a verdict and delivering/publishing it is never silently forgotten. */
    let heldResultIdentity: RoundHeadIdentity | null =
      recoveredLoopState.status === 'ok' ? recoveredLoopState.value.heldResult : null
    /** O3: the round+head whose findings have already been delivered to the developer once — recovered so a later attach never redelivers the same pair, even when the local `round-<k>-attach-redelivered` marker file this same identity backs up is itself lost. */
    let deliveredFindingsIdentity: RoundHeadIdentity | null =
      recoveredLoopState.status === 'ok' ? recoveredLoopState.value.deliveredFindings : null

    /** O1: writes the current in-memory round/budget/held-result/delivered-findings state to the control store — called at every meaningful transition below, never only at pause, so a kill mid-round has something fresher than "the last pause" to recover from. */
    function persistCurrentLoopState(phase: string, pauseReason?: string): void {
      persistLoopState(task, {
        round,
        phase,
        pauseReason,
        budgets: { mechanicalRetries: gateStalledStreak, reviewRounds: round, infrastructureRetries },
        heldResult: heldResultIdentity,
        deliveredFindings: deliveredFindingsIdentity
      })
    }
    let devResumeId: string | null = null
    let devDispatchSucceededBefore = false
    let lastReviewContext: string | null = null
    // The manifest the most recent `dispatch_reviewers` round was dispatched
    // against (O3) — hoisted here so the sibling `publish` block can
    // bind the posted verdicts against it with the SAME `compareManifest` the
    // gate uses. Set the moment the manifest is built, read only at publish.
    let lastDispatchedManifest: ReviewInputManifest | undefined
    /**
     * O1: the input-version facts an escalation record binds to
     * (`writeEscalationRecord`'s own `briefHash`/`objectivesVersion`/
     * `rulingOrdinal`/`policyDigest`) — the round's own dispatched manifest
     * when one exists (a pause after reviewers ran), else a fresh best-effort
     * read of the same four facts (a pause before any manifest was ever
     * built — an early gate-red stall, a round-1 infrastructure hiccup).
     * Never throws: any individual read failing here must not turn a
     * best-effort escalation write into a reason the pause itself fails.
     */
    function bestEffortInputVersions(): {
      briefHash: string | null
      objectivesVersion: string | null
      rulingOrdinal: number
      policyDigest: string
    } {
      if (lastDispatchedManifest) {
        return {
          briefHash: lastDispatchedManifest.briefHash,
          objectivesVersion: lastDispatchedManifest.objectivesVersion,
          rulingOrdinal: lastDispatchedManifest.rulingOrdinal,
          policyDigest: lastDispatchedManifest.policyDigest
        }
      }
      let brief: string | null = null
      let objectives: string | null = null
      let ordinal = 0
      try {
        brief = briefHashOf(d.fetchFrozenBrief(task))
      } catch {
        // Best-effort — no frozen brief yet, or unreadable.
      }
      try {
        objectives = d.resolveIssueObjectives(task).version
      } catch {
        // Best-effort — objectives unresolvable this early.
      }
      try {
        ordinal = prNumber > 0 ? d.fetchNewestRulingOrdinal(prNumber) : 0
      } catch {
        // Best-effort — no PR yet, or the forge read failed.
      }
      let digest = 'unknown'
      try {
        digest = policyDigestOf(policy)
      } catch {
        // Best-effort — a crash this early in setup can leave `policy` unassigned.
      }
      return { briefHash: brief, objectivesVersion: objectives, rulingOrdinal: ordinal, policyDigest: digest }
    }
    let resumedDispatch = resumeFrom !== null
    /** O3: the last red gate's failing check-run names, for the next gate-red dispatch prompt and, if it stalls, the pause detail. */
    let lastFailingChecks: string[] = []
    /** O2: true iff the current `dispatch_developer` decision came from a red gate (never inferred from `decision` itself — see this branch's own comment, below). Reset to `false` by every genuine `gate` observation. */
    let pendingGateRedRetry = false
    /** O2: consecutive gate-red developer turns that produced no push on one head — reset to 0 by every genuine `gate` observation. Seeded from the control store, never hardcoded to `0`, so a kill mid-stall-episode resumes the SAME count rather than a fresh budget. */
    let gateStalledStreak = recoveredLoopState.status === 'ok' ? recoveredLoopState.value.budgets.mechanicalRetries : 0
    /**
     * O2: a recovered, non-zero `gateStalledStreak` must survive exactly
     * ONE "genuine gate observation" reset — the very first one this
     * process makes, which on an attach or a fresh `--resume` is ALSO this
     * process's first gate check ever, indistinguishable in memory from a
     * truly fresh situation unless this flag says otherwise. Consumed
     * (never reset back to `true`) the first time either reset site below
     * runs; every later genuine observation resets to `0` exactly as
     * before. A task with no recovered budget (`gateStalledStreak` seeded
     * at `0`) never sets this at all — resetting `0` to `0` is a no-op, so
     * this flag changes nothing for a genuinely fresh task.
     */
    let mechanicalRetryRecoverySurvivesOneReset = gateStalledStreak > 0
    /** O2: true once this stall episode has already used its one unpushed-work resume — reset alongside `gateStalledStreak`, by every genuine `gate` observation, so a LATER stall gets its own resume. */
    let unpushedResumeAttempted = false
    /** O4/O6: the conflicting file(s) from the last mergeability read, consumed by the very next `dispatch_developer` prompt, then cleared — never a CI-red retry (never sets `pendingGateRedRetry`), so the head-change-wait that follows always re-checks the gate fresh rather than replaying `lastFailingChecks`. */
    let pendingConflictFiles: string[] | null = null

    /**
     * O11: the task Issue, branch, worktree path,
     * and current remote head — every prompt a RESUMED developer session
     * receives names all four, so a session resumed among many worktrees on
     * the same machine never has to ask which branch is meant (confirmed
     * live: exactly that, with forty stale worktrees present). Never
     * prepended to a genuinely fresh round-1 dispatch — that prompt is the
     * frozen brief itself, opening a brand-new session with no worktree to
     * be confused about yet.
     */
    function resumeContextBlock(): string {
      let remoteHead: string | null
      try {
        remoteHead = d.resolveHead(branch)
      } catch {
        remoteHead = null
      }
      return [
        `Resuming task Issue #${task}.`,
        `Branch: \`${branch}\``,
        `Worktree: \`${worktreePathForBranch()}\``,
        `Remote head: ${remoteHead ?? '(no head on origin)'}`
      ].join('\n')
    }

    /**
     * O11 (round 2 review, MAJOR): whether THIS prompt carries the context
     * block above is never gated on `devResumeId !== null` (the vendor
     * session's own `-r <id>` eligibility) — a `--resume <pr>` run's very
     * first developer dispatch (the ruling-resume prompt) has no durable
     * resume record either (this driver never reads one for that path,
     * only the `existingPr` attach branch does), so gating on it silently
     * skipped the context block for exactly the prompt's own Origin
     * note was about. Every `dispatchDeveloper` call defaults
     * to carrying it; the one call site that must NOT (the genuinely fresh
     * round-1 dispatch, opening a brand-new session onto a brand-new
     * worktree the frozen brief itself already describes) passes
     * `skipResumeContext: true` explicitly.
     */
    async function dispatchDeveloper(
      prompt: string,
      roundNum: number,
      opts: { skipResumeContext?: boolean; developerFiles?: readonly string[] } = {}
    ): Promise<DispatchHandle> {
      const isResume = devResumeId !== null
      const fullPrompt = opts.skipResumeContext ? prompt : `${resumeContextBlock()}\n\n${prompt}`
      // O1/O3: confine the Developer to
      // its own worktree when one already exists on this machine — `null`
      // on a fresh attach with nothing dispatched here yet (the same
      // "driver running on a different host" case `reviewer-isolation.ts`'s
      // own doc names), where `dispatchRole` falls back to the repo root
      // instead (its own doc comment on `unattended`) rather than refusing
      // a round-1 dispatch whose own Step 0 is creating that worktree.
      const devWorktreeDir = existsSync(worktreePathForBranch()) ? worktreePathForBranch() : null
      // O1/O3: this round's own confidence
      // and/or round-response files, when this prompt named any — the
      // parent directory must exist before dispatch, both so a confined
      // Write's own `fs.realpathSync(path.dirname(filePath))` resolves and
      // so a Seatbelt-confined child's `mkdirSync(dirname(path), {
      // recursive: true })` needs only the pre-existing traversal grant.
      if (opts.developerFiles && opts.developerFiles.length > 0) {
        ensureRunDir(runPath(root, task, { area: 'developer', round: roundNum }), root)
      }
      const attemptDispatch = (): Promise<DispatchHandle> =>
        withPromptFile(fullPrompt, (promptFile) =>
          d.dispatchRole('developer', dispatchAgent, fullPrompt, {
            task: task,
            round: roundNum,
            resumeId: devResumeId ?? undefined,
            promptFile,
            roleLogPath: loopLogPath,
            ...(devWorktreeDir ? { cwd: devWorktreeDir } : {}),
            ...(opts.developerFiles && opts.developerFiles.length > 0 ? { developerFiles: opts.developerFiles } : {}),
            // issue-661, O1: `runTask`'s own resolved model, spent here and
            // only here — `dispatchRole`'s own `resolvedModel` log line
            // already reports `requested:<model>` vs `'default'`, so no
            // separate log line is needed on this side.
            ...(dispatchModel ? { model: dispatchModel } : {}),
            unattended: true
          })
        )
      let handle = await attemptDispatch()
      // O2: the launcher's own
      // `'connection-failed'` classification means the vendor could not be
      // reached — never a developer decision. Wait and re-dispatch the SAME
      // session, bounded by the existing infrastructure-retry budget
      // (`MAX_INFRASTRUCTURE_RETRIES`, shared with every other
      // infrastructure-class hiccup this task hits), before this ever
      // reaches `assertDispatchOrEscalate`'s stop-and-escalate/pause path —
      // a network drop that recovers on retry must never become a decided
      // stop the developer itself never made. `reconcileDeveloperResume`
      // picks the exact session back up from the durable launch record,
      // which binds one the instant the vendor stream reports it, even on
      // an attempt this connection failure interrupted mid-turn — the
      // returned `handle` itself always carries `resumeId: null` on a
      // failure path (`dispatch.ts`), so this is the only way to recover it.
      let connectionRetryAttempts = 0
      while (handle.failureReason === 'connection-failed' && infrastructureRetries < MAX_INFRASTRUCTURE_RETRIES) {
        infrastructureRetries += 1
        connectionRetryAttempts += 1
        await d.sleep(gatePollEnvOverride('VINAYA_DEV_REVIEW_LOOP_CONNECTION_RETRY_BACKOFF_MS', 5_000))
        reconcileDeveloperResume(false)
        handle = await attemptDispatch()
      }
      // O3: one typed event per retry episode, naming the failure kind, the
      // total attempts made, and whether a later attempt eventually
      // recovered — never one line per attempt, and never logged at all for
      // the common case (no connection failure this dispatch).
      //
      // round 2 review, MAJOR: `outcome` reads off whether the LAST attempt
      // still carries ANY `failureReason`, never specifically
      // `'connection-failed'` — the retry loop's own condition only re-enters
      // on `'connection-failed'`, so its exit can land on a genuine success
      // (`handle.failureReason` undefined: `'recovered'`) OR on the bound
      // being exhausted while still `'connection-failed'` OR on a retried
      // attempt that failed for a DIFFERENT reason (crash/timeout/refused/
      // signal/unbound) — every one of those non-success cases is
      // `'exhausted'`, never silently reported as `'recovered'`.
      if (connectionRetryAttempts > 0) {
        await logEvents([
          {
            kind: 'dev_review_loop' as const,
            payload: {},
            loop_id: config.loopId,
            event: 'infrastructure_retry' as const,
            round: roundNum,
            failure_kind: 'developer_connection' as const,
            attempts: connectionRetryAttempts + 1,
            outcome: handle.failureReason ? 'exhausted' : 'recovered'
          }
        ])
      }
      await assertDispatchOrEscalate(handle, dispatchAgent, isResume, devDispatchSucceededBefore)
      if (!handle.failureReason) {
        devDispatchSucceededBefore = true
        if (handle.resumeId) devResumeId = handle.resumeId
      }
      return handle
    }

    /**
     * O3: reconcile the developer's prior launch before resuming it, at every
     * seam that used to read the durable resume record blind. A prior launch
     * whose child is still running, or one whose required session is gone,
     * both throw `LaunchContinuityLost` — the loop's own outer handler turns it
     * into a decided `pause{reason:'infrastructure'}` (`apps/cli/specs/loop.md`),
     * so a second worker never races the first and a lost session pauses
     * explicitly instead of silently starting fresh. A recoverable session
     * (now including one bound on an INTERRUPTED attempt — O1) sets
     * `devResumeId` to the exact session. `none` — no launch record, the
     * common case, and the only case every existing fixture reaches with its
     * scratch `$HOME` — falls back to the durable resume-record read the loop
     * already used, unchanged.
     */
    function reconcileDeveloperResume(artifactsPresent: boolean): void {
      const recon = recoverDeveloperLaunch(task, dispatchAgent, repo, { artifactsPresent })
      if (recon.kind === 'live') {
        throw new LaunchContinuityLost(
          `a prior dispatched developer launch (pid ${recon.record.childPid}) is still running for task ${task} — refusing to start a second worker on the same task`
        )
      }
      if (recon.kind === 'pause') throw new LaunchContinuityLost(recon.detail)
      if (recon.kind === 'resume') {
        devResumeId = recon.resumeId
        return
      }
      // 'none' | 'finished' — no continuity-required session to reconcile;
      // fall back to the durable resume-record read the loop already used.
      const rec = d.readResumeRecord(task, dispatchAgent, repo)
      if (rec) devResumeId = rec.resumeId
    }

    /** O2/O3: the developer's own worktree convention (`aeg-root/roles/developer.md`) — `.worktrees/<branch>` under this repo's root. */
    function worktreePathForBranch(): string {
      return join(repoRoot, '.worktrees', branch)
    }

    /** O3: names branch, local head (if the worktree is known), remote head, and pull-request existence — whatever this driver actually observed, however this give-up happened, so a principal reading it knows which step was skipped. */
    function pollGiveUpMessage(context: string): string {
      const localHead = d.readWorktreeHead(worktreePathForBranch())
      let remoteHead: string | null
      try {
        remoteHead = d.resolveHead(branch)
      } catch {
        remoteHead = null
      }
      const pr = d.findOpenPrForBranch(branch)
      return [
        `devReviewLoop: ${context}`,
        `branch: ${branch}`,
        `local head: ${localHead ?? `(worktree not found at .worktrees/${branch} — cannot read)`}`,
        `remote head: ${remoteHead ?? '(no head on origin)'}`,
        `pull request: ${pr ? `#${pr.number} open` : 'none open'}`
      ].join('\n')
    }

    const PUSH_AND_OPEN_PROMPT = [
      'Your turn ended without a push: this branch has no head on the remote yet.',
      'The push and the pull-request open are foreground steps per aeg-root/roles/developer.md — run them now, in the foreground, and wait for each to finish:',
      '`git push` (from this task’s worktree), then',
      '`bun apps/cli/src/index.ts pr create --body-file <path> --title "<title>"`.'
    ].join('\n\n')

    const OPEN_PR_PROMPT = [
      'This branch already exists with no open pull request for it.',
      'Open the pull request through the validated path per aeg-root/roles/developer.md:',
      '`bun apps/cli/src/index.ts pr create --body-file <path> --title "<title>"`.'
    ].join('\n\n')

    /** Mid-round unpushed-work resume — distinct from `PUSH_AND_OPEN_PROMPT` (round-1 entry, no head at all yet): this branch already has commits on the remote, the developer's LATEST turn just didn't add a new one. */
    const COMMIT_AND_PUSH_PROMPT = [
      'Your last turn ended without pushing: this worktree has uncommitted changes and/or local commits ahead of the remote, but the branch has no new head.',
      'Committing and pushing are foreground steps per aeg-root/roles/developer.md — run them now, in the foreground, and wait for each to finish:',
      '`git add -A && git commit -m "<message>"` (only if there are uncommitted changes), then',
      '`git push` from this task’s worktree.'
    ].join('\n\n')

    /** Shared by the journal event and the PR comment below, so the two never describe the same stall differently. */
    function unpushedWorkResumeDetail(unpushed: { dirtyFiles: string[]; aheadCount: number }): string {
      return unpushed.dirtyFiles.length > 0
        ? `dirty file(s): ${unpushed.dirtyFiles.join(', ')}`
        : `${unpushed.aheadCount} commit(s) ahead of the remote, worktree clean`
    }

    /**
     * A round-2 review MAJOR finding: records the driver's own mid-round
     * resume as a real `dev_review_loop` telemetry event —
     * `unpushed_work_resume` (`schema.ts`) — not only the marked PR comment
     * below, so the resume leaves a durable observation in the Log. This
     * event is deliberately kept exactly as it was — this change moves only
     * where the round HISTORY is read from, never which events the loop
     * emits: the round journal is now rebuilt from the pull request's own
     * principal-authored forge markers (`fetchLoopHistory`), never replayed
     * from this or any other log event. Mid-round, never terminal — flushed
     * immediately anyway, matching every other `logEvents` call site in this
     * file, so the event is durable even if the resumed developer's own turn
     * crashes the process before the round ends.
     */
    async function logUnpushedWorkResume(roundNum: number, detail: string): Promise<void> {
      await logEvents([
        {
          kind: 'dev_review_loop' as const,
          payload: {},
          loop_id: config.loopId,
          event: 'unpushed_work_resume' as const,
          round: roundNum,
          branch,
          detail
        }
      ])
    }

    /**
     * O1/O3: every pause/escalation
     * comment post site calls THIS, never `postPauseComment`/
     * `postIssuePauseComment` directly followed by its own error handling —
     * both functions already never throw (they retry with backoff, then
     * report the outcome), so there is nothing to catch here; this
     * function's only job is the ONE thing every call site would otherwise
     * duplicate: logging a durable `infrastructure_retry` event whenever
     * `result` shows something notable — a retry genuinely happened
     * (`attempts > 1`), OR the post never landed at all (`posted: false`,
     * regardless of `attempts` — round 5 review, MINOR: a corrupt-record
     * refusal or an epoch-acquisition failure reports `attempts: 1` with
     * `posted: false`, and used to be silently dropped by an `attempts <=
     * 1` check that could not tell that apart from an ordinary first-try
     * success). The truly common case — a boring first-try success,
     * `posted: true` with `attempts` `0` (idempotent no-op) or `1` — is the
     * only one that stays silent, exactly as O3 intends.
     */
    async function logPauseCommentRetryIfNotable(roundNum: number, result: PauseCommentPostResult): Promise<void> {
      if (result.posted && result.attempts <= 1) return
      await logEvents([
        {
          kind: 'dev_review_loop' as const,
          payload: {},
          loop_id: config.loopId,
          event: 'infrastructure_retry' as const,
          round: roundNum,
          failure_kind: 'pause_comment_post' as const,
          attempts: result.attempts,
          outcome: result.posted ? ('recovered' as const) : ('exhausted' as const)
        }
      ])
    }

    /** Records the mid-round unpushed-work resume as its own marked, idempotent PR comment — the same `postForgeEffectOnce`/`postMarkedComment` mechanism `postPauseComment` already uses, keyed by round+head so a genuine re-run of the same stall posts only once. */
    async function postUnpushedWorkResumeComment(
      roundNum: number,
      head: string,
      unpushed: { dirtyFiles: string[]; aheadCount: number }
    ): Promise<void> {
      const detail = unpushedWorkResumeDetail(unpushed)
      const body = [
        `unpushed_work_resume: the developer's last turn on \`${branch}\` ended with unpushed work (${detail}) and no new head on the branch (last known head \`${head}\`).`,
        '',
        'Resumed once, in the foreground, with a commit-and-push instruction.'
      ].join('\n')
      postForgeEffectOnce(root, task, `unpushed-work-resume-${roundNum}-${head}`, () =>
        postMarkedComment('pr', String(prNumber), '<!-- aeg:loop:unpushed-work-resume -->', body)
      )
    }

    /** O4/O6: the loop's own conflict prompt — names the conflicting file(s) so the developer does not have to re-derive mergeability itself. */
    function renderConflictPrompt(files: readonly string[]): string {
      const fileList =
        files.length > 0 ? files.map((f) => `- ${f}`).join('\n') : '(no specific file could be determined)'
      return [
        'This branch is behind the base in a way that conflicts — it cannot merge as-is.',
        'Merge or rebase the base and resolve before pushing again, per aeg-root/roles/developer.md: run `git merge origin/main` (or `git rebase origin/main`) from this worktree, resolve the conflicting file(s) below, then `git push` once resolved. Conflicting file(s):',
        fileList
      ].join('\n\n')
    }

    /**
     * O2/O3/O9: run once, right after the developer's round-1 turn ends and
     * BEFORE any poll for a pull request — the poll never starts against a
     * branch the developer has not pushed (Traps to avoid). Covers both
     * round-1 entries this driver can reach here: a fresh dispatch just
     * ran (`alreadyPushed: false` — the branch may or may not have a head
     * on the remote yet) and a crash-recovery re-entry (`alreadyPushed:
     * true` — the branch already exists, no fresh dispatch this call).
     * Resumes the developer AT MOST ONCE (Traps: never resume twice for
     * this) — a still-missing push after that one resume is left to the
     * poll's own bounded timeout rather than a second dispatch.
     */
    async function afterDeveloperTurnBeforePrPoll(alreadyPushed: boolean): Promise<number> {
      let remoteHead: string | null
      try {
        remoteHead = d.resolveHead(branch)
      } catch {
        remoteHead = null
      }

      if (!alreadyPushed && remoteHead === null) {
        // O9: no push at all yet. A posted refusal/escalation ends the loop
        // now, never entering the pull-request poll.
        const stop = d.fetchDeveloperStop(task)
        if (stop !== null) throw new DeveloperStopSignal(stop)

        // O2/O3: reconcile the prior launch, then resume once, foreground —
        // this single resume's own prompt covers both the missing push and
        // (since it also asks for the open) the common case where the PR was
        // never opened either. `artifactsPresent: false` — no head reached the
        // remote yet.
        reconcileDeveloperResume(false)
        await dispatchDeveloper(PUSH_AND_OPEN_PROMPT, round)
        return await pollUntil(
          () => d.findOpenPrForBranch(branch),
          d.prPollMaxAttempts,
          d.prPollIntervalMs,
          d.sleep,
          () =>
            pollGiveUpMessage(
              'no open PR appeared within the poll budget after resuming once with the push-and-open instructions.'
            )
        ).then((pr) => pr.number)
      }

      const existingPrNow = d.findOpenPrForBranch(branch)
      if (existingPrNow) return existingPrNow.number

      // Pushed (originally, or by this call's own `alreadyPushed: true`
      // crash-recovery path) but the PR is still missing: reconcile the prior
      // launch, then resume once to open it, then poll. `artifactsPresent:
      // true` — a head is on the remote, the branch itself is real work.
      reconcileDeveloperResume(true)
      await dispatchDeveloper(OPEN_PR_PROMPT, round)
      return await pollUntil(
        () => d.findOpenPrForBranch(branch),
        d.prPollMaxAttempts,
        d.prPollIntervalMs,
        d.sleep,
        () => pollGiveUpMessage('no open PR appeared within the poll budget after resuming to open one.')
      ).then((pr) => pr.number)
    }

    /**
     * O1/O2: a dispatch whose work directory is still missing a required
     * artifact is an infrastructure outcome, never a clean verdict — retried
     * once with a fresh dispatch into a fresh work directory (`attempt` 2,
     * never the first attempt's own directory); a second miss throws
     * `ReviewerInfrastructureFailure`, which the caller turns into a pause
     * rather than a held or published verdict for this round.
     *
     * Deliberately does NOT call `writeHeldVerdict` itself (a round-1 review
     * BLOCKER finding): both roles run inside one `Promise.all` in
     * the caller, so a role that finishes clean can resolve before its
     * sibling's own retry exhausts and throws — writing the held verdict file
     * here would leave one on disk for a round that pauses as infrastructure,
     * violating O2's "nothing is held … for that round" the moment the two
     * roles finish in that order. The caller writes both held verdicts only
     * after `Promise.all` itself resolves — i.e. only once it knows neither
     * role failed.
     */
    /** `report.txt`'s `FINDING_IDS:` line — one id per `findings.txt` line, in order, comma-separated. `true` when there is nothing to cite (an empty findings list) or the line's ids exactly cover the findings, one each, no duplicates. */
    function findingIdsCited(workDir: string, findingCount: number): boolean {
      if (findingCount === 0) return true
      const raw = readIfExists(join(workDir, 'report.txt')) ?? ''
      const line = raw.split('\n').find((l) => l.trim().toUpperCase().startsWith('FINDING_IDS:'))
      if (!line) return false
      const ids = line
        .slice(line.indexOf(':') + 1)
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id.length > 0)
      return ids.length === findingCount && new Set(ids).size === ids.length
    }

    function citeFindingIdsPrompt(workDir: string): string {
      return [
        "Your last report.txt did not cite finding ids: findings.txt has finding(s), but report.txt's `FINDING_IDS:` line is missing, or does not carry exactly one id per findings.txt line.",
        `Rewrite findings.txt and report.txt (same grammar as before) at ${join(workDir, 'findings.txt')} and ${join(workDir, 'report.txt')} — this time including a \`FINDING_IDS:\` line in report.txt, one id per findings.txt line, in the same order, comma-separated (e.g. \`F1,F2,F3\`) — so this round's findings are comparable to the next round's.`
      ].join('\n\n')
    }

    /**
     * A round's own findings must carry reviewer-cited ids to be
     * comparable across rounds at all (`assessRound`'s own `reappearance`
     * derivation compares finding ids between rounds, and a fresh
     * `findings.txt` each round has no other stable identity to compare on).
     * A report missing them is sent back ONCE with `CITE_FINDING_IDS_PROMPT`,
     * into a fresh work directory (`attempt` 3 — never overwriting either of
     * `dispatchReviewer`'s own two attempts) — a FRESH dispatch, deliberately
     * never `--resume`: this file's own module doc states, as a load-bearing
     * invariant, that a reviewer session is never resumed (only the
     * developer's is); "the same reviewer session" in this task's own
     * wording is read as "the same round's reviewer work, redone," matching
     * the fresh-dispatch shape `dispatchReviewer`'s own missing-artifact/
     * parse-failure retries already use. Still uncitable after that resend
     * is `report_uncitable`: the round proceeds on `verdict`'s severities —
     * whichever attempt actually produced a parseable verdict — never
     * treated as though no report came back at all.
     */
    async function resendForFindingIds(
      role: 'reviewer' | 'security',
      roundNum: number,
      facts: ReviewerPromptFacts,
      firstVerdict: RoundVerdictParse,
      candidateDir: string | null
    ): Promise<{ verdict: RoundVerdictParse; findingsUncitable: boolean }> {
      const hasObjectives = hasObjectivesFacts(facts)
      const dispatchRoleName = role === 'reviewer' ? ('code-reviewer' as const) : ('security' as const)
      const workDir = reviewerWorkDir(root, task, roundNum, role, 3)
      ensureRunDir(workDir, root)
      const prompt = citeFindingIdsPrompt(workDir)
      // O2/O3: a fresh scratch copy for this resend attempt — never
      // the first attempt's own, matching this function's own fresh-dispatch
      // invariant. `null` when no candidate was built this round (a fresh
      // attach with no local worktree yet) — `d.dispatchRole` then gets no
      // `cwd` override, exactly as before this task.
      const scratchDir = candidateDir ? buildReviewerScratch(root, task, roundNum, role, 3, candidateDir) : null
      const handle = await withPromptFile(prompt, (promptFile) =>
        d.dispatchRole(dispatchRoleName, dispatchAgent, prompt, {
          task: task,
          round: roundNum,
          promptFile,
          roleLogPath: loopLogPath,
          inputVersions: {
            objectivesVersion: facts.manifest.objectivesVersion,
            briefHash: facts.manifest.briefHash,
            rulingOrdinal: facts.manifest.rulingOrdinal,
            policyDigest: facts.manifest.policyDigest
          },
          ...(scratchDir ? { cwd: scratchDir } : {}),
          // O1/O3: a Reviewer dispatched
          // by this driver is unattended the same way the Developer is.
          unattended: true,
          // Round 6 fix, live-reproduced: a confined reviewer writes
          // findings.txt/report.txt/objectives.txt into workDir — see
          // `extraWritableDirs`'s own doc comment (dispatch.ts).
          // The absolute directory, never one relative to a root: this sits
          // under the configurable runtime directory, which need not be
          // under the Vinaya home at all.
          extraWritableDirs: [workDir]
        })
      )
      await assertDispatchOrEscalate(handle, dispatchAgent, false, false)
      if (missingReviewerArtifacts(workDir, hasObjectives).length > 0) {
        return { verdict: firstVerdict, findingsUncitable: true }
      }
      try {
        const verdict = buildVerdictFromReport(
          role,
          workDir,
          dispatchAgent,
          task,
          handle,
          facts.manifest,
          policy,
          facts.resolvedObjectives
        )
        return { verdict, findingsUncitable: !findingIdsCited(workDir, verdict.observation.findings.length) }
      } catch (err) {
        if (!(err instanceof ReviewerReportParseFailure)) throw err
        return { verdict: firstVerdict, findingsUncitable: true }
      }
    }

    async function dispatchReviewer(
      role: 'reviewer' | 'security',
      roundNum: number,
      facts: ReviewerPromptFacts,
      candidateDir: string | null
    ): Promise<{ verdict: RoundVerdictParse; findingsUncitable: boolean }> {
      const hasObjectives = hasObjectivesFacts(facts)
      const dispatchRoleName = role === 'reviewer' ? ('code-reviewer' as const) : ('security' as const)
      let lastMissing: string[] = []
      let lastParseFailure: ReviewerReportParseFailure | null = null
      // Round 2 review, MAJOR: captured so a `ReviewerInfrastructureFailure`
      // thrown after the loop can carry the LAST attempt's own real
      // effect_id/durationMs, rather than the caller inventing a fresh id
      // and timing it against the whole round.
      let lastHandle: DispatchHandle | null = null
      for (let attempt = 1; attempt <= 2; attempt++) {
        const workDir = reviewerWorkDir(root, task, roundNum, role, attempt)
        ensureRunDir(workDir, root)
        const prompt = renderReviewerDispatchPrompt(role, facts, workDir)
        // O1/O2: a fresh, writable copy of this round's shared,
        // read-only candidate (built once, below, before both roles
        // dispatch) — never the candidate itself, never the sibling role's
        // own copy, and never a prior attempt's own (fresh per attempt,
        // same invariant `reviewerWorkDir`'s own `attempt` suffix already
        // holds for `findings.txt`/`report.txt`). `null` when no candidate
        // was built this round — `cwd` is then omitted, exactly as every
        // dispatch before this task.
        const scratchDir = candidateDir ? buildReviewerScratch(root, task, roundNum, role, attempt, candidateDir) : null
        const handle = await withPromptFile(prompt, (promptFile) =>
          d.dispatchRole(dispatchRoleName, dispatchAgent, prompt, {
            task: task,
            round: roundNum,
            promptFile,
            roleLogPath: loopLogPath,
            inputVersions: {
              objectivesVersion: facts.manifest.objectivesVersion,
              briefHash: facts.manifest.briefHash,
              rulingOrdinal: facts.manifest.rulingOrdinal,
              policyDigest: facts.manifest.policyDigest
            },
            ...(scratchDir ? { cwd: scratchDir } : {}),
            // O1/O3: a Reviewer
            // dispatched by this driver is unattended the same way the
            // Developer is.
            unattended: true,
            // Round 6 fix, live-reproduced: a confined reviewer writes
            // findings.txt/report.txt/objectives.txt into workDir — see
            // `extraWritableDirs`'s own doc comment (dispatch.ts).
            // The absolute directory, never one relative to a root: this
            // sits under the configurable runtime directory, which need not
            // be under the Vinaya home at all.
            extraWritableDirs: [workDir]
          })
        )
        await assertDispatchOrEscalate(handle, dispatchAgent, false, false)
        lastHandle = handle
        const missing = missingReviewerArtifacts(workDir, hasObjectives)
        if (missing.length > 0) {
          lastMissing = missing
          lastParseFailure = null
          continue
        }
        // O6: the SAME one-fresh-retry treatment a missing artifact gets —
        // a findings.txt/objectives.txt that exists but still does not
        // parse is retried once, into a fresh work directory, before it
        // becomes a pause.
        try {
          const verdict = buildVerdictFromReport(
            role,
            workDir,
            dispatchAgent,
            task,
            handle,
            facts.manifest,
            policy,
            facts.resolvedObjectives
          )
          if (findingIdsCited(workDir, verdict.observation.findings.length)) {
            return { verdict, findingsUncitable: false }
          }
          return await resendForFindingIds(role, roundNum, facts, verdict, candidateDir)
        } catch (err) {
          if (!(err instanceof ReviewerReportParseFailure)) throw err
          lastParseFailure = err
          lastMissing = []
        }
      }
      if (lastParseFailure) throw lastParseFailure
      throw new ReviewerInfrastructureFailure(
        role,
        lastMissing,
        lastHandle?.effectId ?? null,
        lastHandle?.durationMs ?? null
      )
    }

    function computeStats(head: string, roundStartMs: number): RoundStats {
      const baseHead = d.gitRevParseOriginMain()
      d.gitFetch(head)
      const { filesChanged, insertions, deletions } = parseShortstat(d.gitDiffShortstat(baseHead, head))
      return { baseHead, head, filesChanged, insertions, deletions, wallMs: d.now() - roundStartMs }
    }

    /**
     * The dispatch gate's premise re-assertion against `prNumber`'s LIVE
     * body — `null` on any failure to even fetch it (an ordinary forge-read
     * hiccup, one this driver never exits over) OR when the body carries no
     * `Premise:` block at all; both are dormant, never a reason to treat the
     * premise itself as failed. Wrapped here, not inside
     * `reassertPrBodyPremise` itself, because that function's own contract
     * is pure-ish (a supplied body in, a verdict out) — the live
     * `fetchPrBody` round-trip is this call site's own addition, and its
     * failure mode belongs here.
     */
    function checkPremiseAtHead(pr: number): PremiseReassertResult | null {
      let body: string
      try {
        body = fetchPrBody(pr)
      } catch {
        return null
      }
      return reassertPrBodyPremise(body)
    }

    async function waitForGreenGate(roundStartMs: number): Promise<{
      green: boolean
      stats: RoundStats
      ciConclusion: 'green' | 'red' | 'pending'
      /** O3: the mechanical check-runs that actually failed, named by check name AND run — never the review gate's own, never a superseded run (`fetchFailingCheckRuns` is already deduped to the newest per name) — empty unless `ciConclusion === 'red'`. */
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
      const failingChecks = conclusion === 'red' ? d.fetchFailingCheckRuns(head).map(describeFailingCheckRun) : []
      return {
        green: conclusion === 'green',
        stats: computeStats(head, roundStartMs),
        ciConclusion: conclusion,
        failingChecks
      }
    }

    /** O4/O5/O7: the forge's own mergeable state, polled off `UNKNOWN` within the existing gate poll budget — never read as clean and never as conflicting. A budget exhaustion is treated as `CONFLICTING`, never as clean: this gates a reviewer dispatch or a publish, and silently proceeding on an unresolved answer is the one failure mode O4/O5 exist to prevent. */
    async function pollMergeableState(prNumber: number): Promise<MergeableState> {
      return await pollUntil(
        () => {
          const m = d.fetchMergeableState(prNumber)
          return m === 'UNKNOWN' ? null : m
        },
        d.gatePollMaxAttempts,
        d.gatePollIntervalMs,
        d.sleep,
        () => `devReviewLoop: mergeability for PR #${prNumber} never resolved off UNKNOWN within the poll budget.`
      ).catch(() => 'CONFLICTING' as const)
    }

    /** O1: reads and clears THIS round's own confidence file, at the absolute path this round's own dispatch named in its prompt. */
    function readAndClearConfidence(roundNum: number): Confidence {
      const path = confidenceFilePathFor(roundNum)
      const content = readIfExists(path)
      try {
        unlinkSync(path)
      } catch {
        // Never written, or already gone — nothing to clean up.
      }
      return content ? parseConfidenceReply(content) : 'absent'
    }

    /** O2: best-effort, mirroring `readAndClearConfidence` — a missing or malformed file yields no citation, never a stall (`DEVELOPER_ROUND_RESPONSE_FILE_NAME`'s own doc comment). */
    function readAndClearRoundResponse(roundNum: number): string[] {
      const path = roundResponseFilePathFor(roundNum)
      const content = readIfExists(path)
      try {
        unlinkSync(path)
      } catch {
        // Never written, or already gone — nothing to clean up.
      }
      return parseRoundResponseFindingIds(content)
    }

    /** O2: the round marker comment the driver now posts in the Developer's place (`renderDeveloperRoundComment`) — idempotent per round+head, the same `postForgeEffectOnce` discipline every other driver-posted comment in this file already uses. */
    function postDeveloperRoundComment(roundNum: number, head: string, findingIds: readonly string[]): void {
      postForgeEffectOnce(root, task, `developer-round-comment-${roundNum}-${head}`, () =>
        postMarkedComment(
          'pr',
          String(prNumber),
          developerRoundMarker(roundNum),
          renderDeveloperRoundComment(head, findingIds)
        )
      )
    }

    let roundStartMs = d.now()
    let decision: Decision = { type: 'dispatch_developer' }

    // A driver that exits without ever recording a real
    // `paused`/`publish` decision still leaves ONE trace — inside this
    // task's Surface, so this is the role log `task status --follow`
    // already tails, never a second journal family (Traps to avoid). A
    // forge journal event for the same exit needs a `packages/aeg-core`
    // schema change, out of this task's declared Surface, and is left for a
    // later task with that Surface.
    // `exitTraceWritten` guards the three call sites below (reexec success,
    // an uncaught error, a process signal) from ever firing twice for the
    // same exit.
    let exitTraceWritten = false
    function recordDriverExited(reason: 'reexec' | 'error' | 'signal'): void {
      if (exitTraceWritten) return
      exitTraceWritten = true
      const describedDecision = decision.type === 'pause' ? `pause(${decision.reason})` : decision.type
      appendRoleLine(
        loopLogPath,
        'dev-review-loop',
        `driver_exited: reason=${reason} last_decision=${describedDecision}`
      )
    }
    // Registered once `decision`/`loopLogPath` both exist, so a signal
    // arriving mid-round can still name a real last decision rather than
    // reading the TDZ. `process.exit` here (not `d.exitProcess`, which
    // exists for testability, not for a real signal — no fixture drives a
    // real OS signal) is deliberate: without it, a second delivery of the
    // same signal would be Node's own default (immediate termination,
    // uncatchable) rather than this line ever finishing its write.
    // O1 (widened after a round-3 review found a MAJOR/HIGH gap):
    // `terminateInFlightLaunchesOnShutdown` runs FIRST, before either the
    // exit trace or `process.exit` — it terminates whichever role's
    // dispatched child is genuinely in flight (developer, or either
    // reviewer, dispatched concurrently) and marks its launch record
    // `interrupted`, so a killed driver leaves no orphan and no stale
    // `'launched'` record for the next start to trip over.
    process.on('SIGTERM', async () => {
      d.terminateInFlightLaunchesOnShutdown(task, dispatchAgent, repo)
      cleanupAllReviewerIsolationArtifacts(root, task)
      recordDriverExited('signal')
      // O3: this driver's own sink may still have a `log()` call in flight
      // (`context()` unresolved, or a webhook drain still running) — a bare
      // `process.exit` here tears the process down with no microtask
      // draining, which would silently drop it. Awaited once, on the way
      // out, never per event.
      await drainAllLogSinks()
      process.exit(143)
    })
    process.on('SIGINT', async () => {
      d.terminateInFlightLaunchesOnShutdown(task, dispatchAgent, repo)
      cleanupAllReviewerIsolationArtifacts(root, task)
      recordDriverExited('signal')
      await drainAllLogSinks()
      process.exit(130)
    })

    // Round 2 review, BLOCKER: `firstPass`/`pendingCompletionEvents` are
    // declared here, in this function's own scope — never inside the `try`
    // block opened just below — because `runRoundLoop` (a sibling function
    // declaration that closes over both as mutable state) needs them
    // visible from OUTSIDE that block; a `let` inside `try { }` is scoped to
    // that block alone and would be invisible to a function declared beside
    // it, even though function declarations themselves hoist.
    let firstPass = !resumeFrom || resumeHeadAlreadyMoved
    let pendingCompletionEvents: DevReviewLoopEventInput[] = []

    /**
     * O8 (round 2 review, BLOCKER): re-read the base branch's head and
     * compare against the fixed watermark recorded at loop start. A base
     * that moved past a commit touching this driver's own code sets
     * `decision` to `pause{reason:'stale_driver'}` and returns `true` — the
     * caller's job is to stop doing whatever it was about to do and let
     * that decision reach the bottom pause-handling. Called from TWO sites,
     * not just the loop top: a clean `dispatch_reviewers` → `publish`
     * transition falls through to publish in the SAME iteration with no
     * loop-back in between (found live, round 2 review — the doc comment's
     * old claim that "every iteration is a superset of every round entry"
     * was false for exactly this transition, the common clean-round path),
     * so publish re-checks this itself rather than trusting the top-of-loop
     * check alone.
     *
     * Declared here, before the `try` below, for the same reason
     * `firstPass`/`pendingCompletionEvents` are — `runRoundLoop` (a sibling
     * function declaration) calls this, and a function declared INSIDE a
     * `try { }` block is scoped to that block, invisible outside it.
     */
    async function checkStaleDriver(): Promise<boolean> {
      const currentBaseHead = d.gitRevParseOriginMain()
      if (currentBaseHead === baseHeadAtStart) return false
      const touching = d.gitCommitsTouchingDriverPaths(baseHeadAtStart, currentBaseHead)
      if (touching.length === 0) return false

      // O7: a moved base costs a restart, never a
      // hand — re-exec this same process from the updated base, reattaching
      // to the same task with the same arguments (`--resume <pr>` when this
      // run itself started that way, `--task <n>` otherwise — both forms
      // `dev-review-loop`'s own round-1 entry already treats as "attach if a
      // PR/pause state exists, start fresh otherwise"). Pausing is reserved
      // for when the re-exec attempt ITSELF fails — the pull, or the spawn —
      // never for the staleness alone.
      const pulled = d.pullDefaultBranch()
      let reexecFailureNote = ''
      if (pulled.ok) {
        // O1: hand the lock to the child BEFORE it starts, not after
        // this process happens to unwind. `spawnSync` blocks synchronously
        // until the child exits, and the success path below calls
        // `exitProcess` (real `process.exit`) — which never lets this
        // function's own caller's `finally` (the driver-lock clear at the
        // top-level `devReviewLoop` entry) run at all. Left cleared only
        // there, the still-present lock refused the child outright (found
        // live: a re-exec died to exactly this). Clearing it here,
        // synchronously, before the spawn, means the child's own entry-gate
        // lock check (`readDriverLock`/`isDriverPidAlive`) sees no lock and
        // starts; the child then writes its own lock immediately, same as
        // any fresh driver invocation.
        clearDriverLock(root, task)
        const reexecArgs = buildReexecArgs(
          { ...input, agent: dispatchAgent, ...(dispatchModel ? { model: dispatchModel } : {}) },
          task
        )
        const exitCode = d.reexecSelf(reexecArgs)
        if (exitCode !== null) {
          // A clean hand-off to the child is never a
          // `paused`/`publish` decision — nothing else traces it. `finally`
          // never runs on this path (`d.exitProcess` below is real
          // `process.exit`), so this is the only chance to write it.
          recordDriverExited('reexec')
          await drainAllLogSinks()
          d.exitProcess(exitCode)
          // `exitProcess` is typed `(code: number) => never` — real process.exit
          // never returns here. This `return` guards a test fake that records
          // the call instead of truly exiting: without it, such a fake would
          // fall through into the failure-note/pause path below with a
          // successful re-exec, logging a spurious stale_driver pause.
          return true
        }
        // O1: the spawn itself never started (`reexecSelf` returned `null`)
        // — this process is still the one driving the task, so the lock it
        // cleared above must come back, or a second invocation would see no
        // lock at all and start a genuinely concurrent driver against the
        // same outbox.
        writeDriverLock(root, task, { pid: process.pid, startedAt: new Date().toISOString() })
        reexecFailureNote = `re-exec of \`vinaya ${reexecArgs.join(' ')}\` could not even start after pulling the updated base`
      } else {
        reexecFailureNote = `could not pull the default branch to re-exec from: ${pulled.reason}`
      }

      const head = d.resolveHead(branch)
      const stats = computeStats(head, roundStartMs)
      const detail = `base moved from ${baseHeadAtStart} to ${currentBaseHead}, touching this driver's own code (${touching.join('; ')}) — ${reexecFailureNote}`
      await logEvents(driverDecidedPauseEvents(config.loopId, state, round, stats))
      decision = { type: 'pause', reason: 'stale_driver', detail }
      // Cumulative, never reset by a
      // restart — see `MAX_INFRASTRUCTURE_RETRIES`'s own doc comment.
      infrastructureRetries += 1
      return true
    }

    // The `try` below now wraps EVERY executable statement from here
    // through the end of this function — including the driver's own SETUP
    // (`reviewPolicy()`, `d.repoRoot()`, `d.gitRevParseOriginMain()`, each a
    // real forge/git read that can throw) and round 1's own fresh-dispatch
    // entry (`fetchFrozenBrief`, a real forge read that can throw), not
    // merely the later `runRoundLoop()` call. A forge-read failure, a
    // dispatch failure, or any other thrown exception anywhere in this span
    // is caught by the SAME catch below and becomes a decided pause, never a
    // re-thrown crash — a narrower wrap that leaves any part of this setup
    // or round-1's own entry uncovered lets a `gh`/`git` failure there crash
    // the driver instead of pausing it.
    try {
      // A corrupt control-store loop-state record is refused HERE, first
      // thing inside the `try` (round 2 review, BLOCKER) — never at the
      // earlier `recoverLoopState` call site, which sits before this `try`
      // even starts and would let the throw escape uncaught. Thrown here,
      // it reaches the SAME outer `catch` below as every other setup
      // failure on this path, which decides `pause{reason:'infrastructure'}`,
      // writes the pause state, posts the pause comment, and keeps the
      // driver lock alive — never a silent crash with no forge-visible
      // trace at all.
      if (recoveredLoopState.status === 'corrupt') {
        throw new Error(
          `devReviewLoop: task ${task}'s control-store loop-state record is corrupt: ${recoveredLoopState.reason} — refusing to recover budgets from it.`
        )
      }

      // Which severities block is repository policy (task 8,
      // O1/O4) — resolved once, from the default branch, and reused for
      // every round's derivation and this run's publication self-check; the
      // gate reads the identical source (`check-review-gate.ts`). `config`
      // (built above with the repo-wide default) is corrected in place the
      // moment this succeeds — same object, every closure already holding a
      // reference to it sees the real value from here on.
      policy = reviewPolicy()
      config.maxRounds = policy.maxRounds
      repoRoot = d.repoRoot()
      baseHeadAtStart = d.gitRevParseOriginMain()

      // O8: `resumeHeadAlreadyMoved` widens this exactly like a fresh round-1
      // attach — the developer already pushed the fix a ruling asked for, so
      // this run dispatches no developer at all and goes straight to the
      // gate/reviewer path below, on the head that's already there.
      if (resumeFrom) {
        // O2: resuming — the PR and branch are already known (`resumeFrom`), so
        // there is no round-1 dispatch and no PR to poll for. `lastReviewContext`
        // carries the Principal's ruling(s) instead of a reviewer's findings;
        // `resumedDispatch` (below) labels the prompt accordingly, once.
        const rulings = d.fetchRulings(prNumber)
        lastReviewContext = rulings.map((r, i) => `${i + 1}. ${r}`).join('\n')
        // O1: the pause comment this run
        // is resuming from may never have reached the forge (a network
        // drop mid-post, or the pause path's own exhausted retry) — the
        // local record (`resumeFrom`) is what is authoritative; the
        // comment is only ever a projection of it. Re-posting here is a
        // no-op when it already landed (`postPauseComment`'s own
        // idempotent identity check reads the SAME `pause-<round>-<head>`
        // key its original post used) and posts the missing copy, once,
        // when it didn't — before this run does anything else. Skipped
        // once the head has already moved past the held pause (O8): that
        // identity is superseded by the fix already pushed, and reposting
        // here would build a DIFFERENT key (`resumeFrom.round` widened to
        // the ruling's own ordinal) than the one the original post ever
        // used, never actually completing it.
        if (!resumeHeadAlreadyMoved) {
          await logPauseCommentRetryIfNotable(
            resumeFrom.round,
            postPauseComment(task, resumeFrom.round, resumeFrom.head, prNumber, resumeFrom.reason, resumeFrom.detail, {
              agent: dispatchAgent,
              ...(dispatchModel ? { model: dispatchModel } : {})
            })
          )
        }
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
          // next, unmodified, straight off `firstPass` — UNLESS O4 (below)
          // recovers a real round from held state.
          prNumber = existingPr.number
          // O3: reconcile the prior launch before a later round resumes it —
          // an open PR means the branch is real work (`artifactsPresent`).
          reconcileDeveloperResume(true)
          seedLoopHistory()

          // O4 (task 3): a prior process may have
          // dispatched round k's reviewers, held REQUEST-CHANGES verdicts on
          // disk, and dispatched the developer — then crashed or was
          // restarted before ever observing whether the developer pushed a
          // fix. Left alone, `round` stays at its default of 1 and this
          // attach would re-run round 1's OWN gate check on a head that may
          // be several real rounds deep (previously, every attach
          // after a fix push re-delivered round 1's stale findings and
          // drifted into a confidence-collapse pause). Recovered here
          // instead, from the durable, machine-local held-verdict files.
          const held = latestHeldRequestChanges(root, task)
          if (held) {
            const currentHead = d.resolveHead(branch)
            if (currentHead !== held.head) {
              // The developer already pushed since round k's findings were
              // computed — never re-deliver round k's findings. `round` set
              // to k+1 and `firstPass` left at its default `true` (attach)
              // is exactly the existing, already-tested fallthrough: no
              // developer dispatch here, straight to round k+1's own gate
              // check, which itself decides `dispatch_reviewers` once green.
              round = held.round + 1
            } else {
              // Head unchanged — round k's findings were never actually
              // delivered to the developer (or the developer hasn't
              // responded yet). Never a third consecutive attempt on the
              // SAME head with no push in between: the second one reads as
              // `no_progress`, not another redelivery drifting toward a
              // confidence collapse.
              const marker = runPath(root, task, { area: 'round', round: held.round, file: 'attach-redelivered' })
              // The control-store
              // `deliveredFindings` identity backs up the SAME "already
              // delivered" fact the local marker file records — checked
              // alongside it, never instead of it, so a machine whose local
              // marker was lost (a different host, an outbox that was
              // cleaned) still refuses a second redelivery of the same
              // (round, head) pair.
              const alreadyDeliveredInStore =
                deliveredFindingsIdentity !== null &&
                deliveredFindingsIdentity.round === held.round &&
                deliveredFindingsIdentity.head === currentHead
              const markerPresent = existsSync(marker)
              if (markerPresent || alreadyDeliveredInStore) {
                const stats = computeStats(currentHead, d.now())
                await logEvents(driverDecidedPauseEvents(config.loopId, state, held.round + 1, stats))
                // O3: names WHICH of the two independent guard inputs was
                // observed true — a local marker this machine wrote
                // earlier, a control-store identity a (possibly different)
                // machine wrote — so a comment where neither actually held
                // is visibly wrong, rather than reading identically to an
                // ordinary redelivery pause.
                decision = {
                  type: 'pause',
                  reason: 'no_progress',
                  detail: `round ${held.round} findings delivered again on unchanged head ${currentHead}, with no developer push since the first delivery (guard: local marker file ${markerPresent ? 'present' : 'absent'}, control-store delivered-findings identity ${alreadyDeliveredInStore ? 'matched' : 'absent'})`
                }
              } else {
                ensureRunDir(dirname(marker), root)
                writeFileSync(marker, new Date().toISOString(), 'utf8')
                round = held.round + 1
                lastReviewContext = held.rendered
                firstPass = false
                deliveredFindingsIdentity = { round: held.round, head: currentHead }
                persistCurrentLoopState('dispatch_developer')
              }
            }
          }
        } else {
          let branchExists = true
          try {
            d.resolveHead(branch)
          } catch {
            branchExists = false
          }
          if (branchExists) {
            // Crash-recovery re-entry: the branch already exists (pushed by a
            // prior process), no dispatch here — `afterDeveloperTurnBeforePrPoll`
            // resumes once to open the PR and polls (O2/O3).
            prNumber = await afterDeveloperTurnBeforePrPoll(true)
          } else {
            // Round 1: fresh dispatch, brief read from the frozen Issue comment
            // (O1). What happens next — check, at most one resume, poll — is
            // O2/O3/O9's own job, never blind.
            const brief = d.fetchFrozenBrief(task)
            await dispatchDeveloper(brief, round, { skipResumeContext: true })

            try {
              prNumber = await afterDeveloperTurnBeforePrPoll(false)
            } catch (err) {
              if (!(err instanceof DeveloperStopSignal)) throw err
              // O9: no branch ever reached the remote, and the developer
              // posted a refusal/escalation instead — end the loop now, on the
              // Issue (there is no PR to comment on), never entering the poll.
              const detail = err.detail
              // O1 (round 2 review, security MEDIUM): the local record is
              // written BEFORE the post here too — this is the one pause/
              // escalation call site in this file that used to post straight
              // to the forge with no prior `writeEscalationRecord`/
              // `writePauseState`, unlike every other one. `head: 'unknown'`
              // mirrors the crash-handler's own sentinel (above) — no branch
              // ever reached the remote here, so there is no real head to
              // resolve. Best-effort exactly like the general pause branch:
              // a control-store write failure here never blocks the post.
              let escalationRecord: EscalationRecord | null = null
              try {
                escalationRecord = writeEscalationRecord({
                  task,
                  round,
                  head: 'unknown',
                  branch,
                  pr: null,
                  runId,
                  agent: dispatchAgent,
                  reason: 'escalation',
                  detail,
                  evidence: lastReviewContext ?? undefined,
                  ...bestEffortInputVersions()
                })
              } catch {
                // Best-effort — the pause state and comment below are the
                // authoritative record; a control-store write failure here
                // never undoes them.
              }
              writePauseState(root, {
                task,
                round,
                head: 'unknown',
                branch,
                prNumber: -1,
                reason: 'escalation',
                detail,
                pausedAt: new Date().toISOString(),
                agent: dispatchAgent,
                ...(dispatchModel ? { model: dispatchModel } : {}),
                escalationId: escalationRecord?.escalationId,
                infrastructureRetries
              })
              await logPauseCommentRetryIfNotable(round, postIssuePauseComment(task, round, 'escalation', detail))
              return { finalDecision: { type: 'pause', reason: 'escalation', detail }, prNumber: 0, task }
            }
          }
        }
      }

      // An attach with no locally-held request-changes file to recover
      // `round` from (`latestHeldRequestChanges`, above, returned null — a
      // different machine, or local state already cleaned) must still not
      // restart round numbering at 1 when the forge markers show real prior
      // rounds that never reached a published summary (`historyApplies` —
      // see `seedLoopHistory`'s own doc comment for why a task whose summary
      // WAS published never reaches here). The markers come from the pull
      // request's own developer round comments, never a log event. Never
      // applied to `--resume`: that round is deliberately the ruling's own
      // ordinal (O8), not the next sequential round, and `Math.max` never
      // regresses the more-precise, locally-held recovery above when both
      // agree or the local one is ahead.
      if (!resumeFrom && historyApplies) round = Math.max(round, nextRoundNumber(loopHistory.rounds))

      // The control store's own recovered round is the authoritative one —
      // `Math.max` only ever advances `round` here, never regresses it, so
      // every mechanism above (the ruling ordinal on `--resume`, the
      // locally-held request-changes recovery, the forge-marker fallback just
      // above) keeps winning whenever it already agrees or is ahead. What
      // this closes: a task whose held-verdict files AND forge markers are
      // both unavailable (a different machine, a GitHub read that fails, a
      // pull request whose comments were never posted) no longer silently
      // restarts numbering at 1 as long as this task's own control-store
      // record survived — the control store and the forge markers together
      // are the round-history source, never the Log.
      if (recoveredLoopState.status === 'ok') round = Math.max(round, recoveredLoopState.value.round)

      // Held back from `logEvents` until `publishRound` (below) actually
      // succeeds — `assessRound`'s one `journal_finalized`/`merged_ready` event
      // (`assess-round.ts`) always arrives bundled with a `publish` decision in
      // the SAME `result.events`, and logging it immediately, before the posts
      // it claims are done, is what let a crash mid-publish leave the durable
      // log asserting a completion the pull request never got (found by code
      // review as a MAJOR gap). Every other event in that same `result.events` — the
      // round's own `stop_condition_met`/`round_ended` — is true regardless of
      // whether publication later fails, so only this one event is deferred.

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

      /**
       * O10 (round 2 review, BLOCKER): every event this driver emits is
       * whatever `logEvents` is explicitly told to log — nothing synthesizes
       * the terminal event a genuinely uncaught error skips on its own. Left
       * alone, a crash mid-round left the log with `loop_started` and
       * `round_started` but no `paused`/`journal_finalized` at all,
       * permanently — exactly the shape O10 calls a test failure.
       * Deliberately `driverCrashEvents`, never `driverDecidedPauseEvents`:
       * the latter also fabricates a `round_ended`, wrong the moment the
       * crash strikes AFTER a real one already logged (`publishRound`
       * throwing post-green — see `driverCrashEvents`'s own doc comment).
       * Best-effort on the head: a `resolveHead` failure is itself a
       * plausible CAUSE of the crash being handled here, so this never lets
       * a secondary failure mask the original error.
       */
      return await runRoundLoop()
    } catch (err) {
      // A genuinely uncaught error — a gate error, a
      // dispatch error, a forge read error, any thrown exception on the
      // driver's own path — is now a decided `pause{reason:'infrastructure'}`
      // like any other infrastructure hiccup, never a re-thrown exception
      // that ends the process. `decision` (whatever it last held) is only
      // readable from inside this closure, so the trace is written here,
      // not in the outer `finally`. `keepLockAlive` (declared in the
      // enclosing `devReviewLoop`) is set here too — the same lock-stays-alive
      // treatment as the shared pause-return branch's own
      // 'infrastructure'/'stale_driver' cases below.
      recordDriverExited('error')
      let head = 'unknown'
      try {
        head = d.resolveHead(branch)
      } catch {
        // Left as 'unknown' — the schema only requires a string.
      }
      await logEvents(driverCrashEvents(config.loopId, state, round, head))
      // `decision.detail` (below) carries the RAW error message — it lands only in this
      // MACHINE-local outbox (`writePauseState`, never posted anywhere) and
      // in `finalDecision`, which the CLI never prints past the bare reason.
      // `postPauseComment` (below) sanitizes its OWN `detail` argument
      // unconditionally now (`sanitizePublicPauseDetail`), so the raw string
      // passed here is never posted un-redacted — this call site no longer
      // needs its own separately-sanitized copy, and neither does any other
      // `postPauseComment` call in this file.
      decision = {
        type: 'pause',
        reason: 'infrastructure',
        detail: `an uncaught error ended round ${round}'s own processing: ${err instanceof Error ? err.message : String(err)}`
      }
      keepLockAlive = true
      // The SAME durable snapshot every
      // other pause reason gets, best-effort like the write itself already
      // is — a genuinely uncaught error is exactly the case this record
      // exists for, so the next attach/resume recovers this round's
      // budgets rather than starting a fresh in-memory count at zero.
      infrastructureRetries += 1
      persistCurrentLoopState('pause', decision.reason)
      // This bookkeeping is best-effort, never a second chance for the
      // process to crash on its way out — the ORIGINAL error is already
      // handled (this pause IS the handling); a forge write failing here
      // too (the exact fault that just took down the round, still live)
      // must never re-throw and undo it. `recordDriverExited` above already
      // follows the identical "never throws" discipline for the same
      // reason.
      try {
        // O1: the durable escalation record — best-effort (never a second
        // chance for the process to crash on its way out), written BEFORE
        // `pause-state.json` so its own real `escalationId` (code review,
        // round 2, MEDIUM: `writeEscalation` claims a disambiguating suffix
        // rather than silently overwriting a colliding, genuinely different
        // escalation) can be carried on `PauseState` for `--resume`/
        // `--cancel` to find later.
        let escalationRecord: EscalationRecord | null = null
        try {
          escalationRecord = writeEscalationRecord({
            task,
            round,
            head,
            branch,
            pr: prNumber > 0 ? prNumber : null,
            runId,
            agent: dispatchAgent,
            reason: decision.reason,
            detail: decision.detail,
            evidence: lastReviewContext ?? undefined,
            ...bestEffortInputVersions()
          })
        } catch {
          // Best-effort — the pause state and comment below are the
          // authoritative record; a control-store write failure here never
          // undoes them.
        }
        writePauseState(root, {
          task,
          round,
          head,
          branch,
          prNumber,
          reason: decision.reason,
          detail: decision.detail,
          pausedAt: new Date().toISOString(),
          agent: dispatchAgent,
          ...(dispatchModel ? { model: dispatchModel } : {}),
          escalationId: escalationRecord?.escalationId,
          infrastructureRetries
        })
        // A crash this early — setup, or a fresh round-1 task never getting
        // as far as resolving one — leaves `prNumber` at its `-1` sentinel:
        // no PR is known to exist, so a PR comment would target a number
        // nothing was ever opened against. Recorded on the task Issue
        // instead, the one forge location that is always addressable for a
        // task with no open PR yet.
        const postResult =
          prNumber < 0
            ? postIssuePauseComment(task, round, decision.reason, decision.detail)
            : postPauseComment(task, round, head, prNumber, decision.reason, decision.detail, {
                agent: dispatchAgent,
                ...(dispatchModel ? { model: dispatchModel } : {})
              })
        await logPauseCommentRetryIfNotable(round, postResult)
      } catch {
        // Swallowed deliberately — see above. The role log's own
        // `driver_exited` trace (written above, unconditionally) is what a
        // Principal reads when even this best-effort post never lands.
      }
      return { finalDecision: decision, prNumber, task }
    }

    // eslint-disable-next-line no-constant-condition
    async function runRoundLoop(): Promise<LoopResult> {
      while (true) {
        // Checking more often than the minimum ("every round entry") is
        // strictly safer, never wrong — this runs before every iteration's
        // own dispatch/gate/publish logic.
        if (decision.type !== 'pause') {
          await checkStaleDriver()
        }

        if (decision.type === 'dispatch_developer') {
          // O2: `pendingGateRedRetry` (set below, at this round's own two `gate`
          // observation call sites — never inferred from `decision` itself,
          // since `assessGate`'s red branch returns a bare `dispatch_developer`
          // with no reason tag: `Decision`/`PauseReason` live in
          // `packages/aeg-core`, out of this task's declared Surface) is true
          // exactly when THIS dispatch is the driver sending
          // the developer back for a red mechanical gate — the one case that
          // needs the head-change wait (Traps: never re-read the gate in a
          // tight loop on an unchanged head — a real five-re-dispatches-
          // in-two-minutes failure).
          const isGateRedRetry = pendingGateRedRetry
          // O4/O6: a conflict-resolve retry — READ, never cleared here. Same
          // persistence discipline as `pendingGateRedRetry`: it survives a
          // bounded stall's own `continue` unchanged (this branch's own
          // `dispatch_developer` decision doesn't change either), so the NEXT
          // iteration rebuilds the SAME conflict prompt and re-runs the SAME
          // stall check, rather than falling through to a stale fallback
          // prompt and a fresh, unbounded gate-check/re-detect cycle (found
          // live: clearing it here let the loop rediscover the same conflict
          // every OTHER iteration, doubling the dispatches needed to reach the
          // bound and sending one nonsense prompt per cycle). Cleared only
          // where it's genuinely resolved — the mergeability re-reads at the
          // `dispatch_reviewers`/`publish` sites, below.
          const conflictFiles = pendingConflictFiles
          if (!firstPass) {
            // O2: findings citation only makes sense on the genuine
            // review-findings path — not a conflict retry, a ruling resume,
            // or a CI-red retry, none of which ever sent the developer a
            // findings list to cite ids against.
            const isReviewFindingsRetry = conflictFiles === null && !resumedDispatch && !isGateRedRetry
            // O1: built fresh for THIS
            // round, never reused from an earlier round — a resumed
            // developer session gets a fresh prompt every round, and the
            // driver names the exact absolute path this round's own
            // dispatch is granted write access to.
            const thisRoundConfidencePath = confidenceFilePathFor(round)
            const thisRoundResponsePath = roundResponseFilePathFor(round)
            const prompt = [
              conflictFiles !== null
                ? renderConflictPrompt(conflictFiles)
                : resumedDispatch
                  ? `Principal ruling on this pause:\n\n${lastReviewContext}\n`
                  : isGateRedRetry
                    ? `CI is red on the last head. Failing check-run(s): ${
                        lastFailingChecks.length > 0 ? lastFailingChecks.join(', ') : '(unknown)'
                      }. Fix the failing check(s), then run \`git push\` from this worktree to push the fix as a new commit on the SAME branch.`
                    : // `isGateRedRetry` is false here only when this dispatch came from
                      // `assessVerdicts`' review-findings fallback, which requires
                      // `dispatch_reviewers` to have already run and set `lastReviewContext`
                      // — so it is never null in this branch (code review, round 1, MINOR:
                      // the prior 'CI was red...' fallback below this was unreachable).
                      `Round ${round} review findings:\n\n${lastReviewContext}\n`,
              'Address the findings above per aeg-root/roles/developer.md. Commit the fix, then run `git push` from this worktree to push it as a new commit on the SAME branch; do not open a new PR.',
              round >= 2 ? confidencePromptLine(thisRoundConfidencePath) : '',
              isReviewFindingsRetry ? roundResponsePromptLine(thisRoundResponsePath) : ''
            ]
              .filter(Boolean)
              .join('\n\n')
            const thisRoundDeveloperFiles = [
              ...(round >= 2 ? [thisRoundConfidencePath] : []),
              ...(isReviewFindingsRetry ? [thisRoundResponsePath] : [])
            ]
            // Unchanged from before this task: a head-change wait runs ONLY
            // for a CI-red retry or a conflict retry — never for the plain
            // review-findings retry, whose own next `dispatch_reviewers`
            // phase re-reads whatever head exists rather than waiting for
            // one to CHANGE (Traps: never re-read the gate in a tight loop
            // on an unchanged head — that same real failure). This case
            // adds the unpushed-work resume ONLY inside this same,
            // already-narrower scope — widening it to the review-findings
            // path would mean every existing fixture for that path (there is
            // no real push to wait for there today) would need to start
            // simulating one, well beyond this fix's own boundary.
            const headBeforeDispatch = isGateRedRetry || conflictFiles !== null ? d.resolveHead(branch) : null
            roundStartMs = d.now()
            await dispatchDeveloper(prompt, round, { developerFiles: thisRoundDeveloperFiles })
            resumedDispatch = false

            const changedHead =
              headBeforeDispatch !== null
                ? await pollUntil(
                    () => {
                      const h = d.resolveHead(branch)
                      return h !== headBeforeDispatch ? h : null
                    },
                    d.gatePollMaxAttempts,
                    d.gatePollIntervalMs,
                    d.sleep,
                    'devReviewLoop: head-change wait timed out'
                  ).catch(() => null)
                : 'not-applicable'

            if (headBeforeDispatch !== null && changedHead === null) {
              // Before charging this to the driver's generic
              // bounded stall counter, tell "stopped without pushing REAL
              // work" apart from a genuinely idle turn: a dirty worktree or
              // local commits ahead of the remote is real, unpushed work —
              // resumed ONCE, foreground, with a dedicated commit-and-push
              // instruction (Traps: never resume more than once for this).
              let resolvedByUnpushedResume = false
              if (!unpushedResumeAttempted) {
                const unpushed = d.readUnpushedWorkDetail(worktreePathForBranch())
                if (unpushed.dirtyFiles.length > 0 || unpushed.aheadCount > 0) {
                  unpushedResumeAttempted = true
                  await logUnpushedWorkResume(round, unpushedWorkResumeDetail(unpushed))
                  await postUnpushedWorkResumeComment(round, headBeforeDispatch, unpushed)
                  await dispatchDeveloper(COMMIT_AND_PUSH_PROMPT, round)
                  const resumedHead = await pollUntil(
                    () => {
                      const h = d.resolveHead(branch)
                      return h !== headBeforeDispatch ? h : null
                    },
                    d.gatePollMaxAttempts,
                    d.gatePollIntervalMs,
                    d.sleep,
                    'devReviewLoop: head-change wait timed out after unpushed-work resume'
                  ).catch(() => null)

                  if (resumedHead !== null) {
                    resolvedByUnpushedResume = true
                  } else {
                    const stillUnpushed = d.readUnpushedWorkDetail(worktreePathForBranch())
                    const stats = computeStats(headBeforeDispatch, roundStartMs)
                    const detail = `branch ${branch}; dirty file(s): ${
                      stillUnpushed.dirtyFiles.length > 0
                        ? stillUnpushed.dirtyFiles.join(', ')
                        : '(none — commits ahead of the remote only)'
                    }`
                    await logEvents(driverDecidedPauseEvents(config.loopId, state, round, stats))
                    decision = { type: 'pause', reason: 'no_push', detail }
                    continue
                  }
                }
              }

              if (!resolvedByUnpushedResume) {
                // The developer returned without pushing — not a fresh gate
                // read (the head never moved), so this feeds the DRIVER's own
                // bounded stall counter instead of `fetchCiConclusion` again.
                gateStalledStreak += 1
                // Persisted the moment it
                // increments, not only once a pause eventually fires — a
                // kill mid-episode (the process dies before ever reaching
                // the bound below) must not hand the next attach a fresh
                // budget of `MAX_GATE_STALLED_TURNS` turns.
                persistCurrentLoopState('dispatch_developer')
                const stats = computeStats(headBeforeDispatch, roundStartMs)
                const detail =
                  conflictFiles !== null
                    ? `head ${headBeforeDispatch} unchanged after dispatch; conflict never resolved (file(s): ${
                        conflictFiles.length > 0 ? conflictFiles.join(', ') : '(unknown)'
                      })`
                    : `head ${headBeforeDispatch} unchanged after dispatch; failing check-run(s): ${
                        lastFailingChecks.length > 0 ? lastFailingChecks.join(', ') : '(unknown)'
                      }`
                if (gateStalledStreak < MAX_GATE_STALLED_TURNS) {
                  continue
                }
                await logEvents(driverDecidedPauseEvents(config.loopId, state, round, stats))
                decision = { type: 'pause', reason: 'infrastructure', detail }
                infrastructureRetries += 1
                continue
              }
              // else: `resolvedByUnpushedResume` — fall through exactly like
              // a normal `changedHead !== null` success, into the
              // mergeable/gate checks below.
            }
          }
          firstPass = false

          // O4/O7 (round 2 review, BLOCKER): mergeability is checked BEFORE
          // the CI gate is ever waited on — `waitForGreenGate` below used to
          // run unconditionally here, so even round 1 burned the full CI poll
          // budget on a head that might already be `CONFLICTING`, and the
          // mergeability read at the `dispatch_reviewers` branch (below) never
          // ran until a whole extra iteration later. Checked here, every time
          // this branch runs (fresh round-1 entry, a conflict-retry, or a
          // genuine next round), so a conflicting head is sent back before any
          // CI wait, never after one.
          const mergeableBeforeGate = await pollMergeableState(prNumber)
          if (mergeableBeforeGate === 'CONFLICTING') {
            pendingConflictFiles = d.fetchConflictingFiles('main', branch)
            continue
          }
          pendingConflictFiles = null

          const gate = await waitForGreenGate(roundStartMs)
          // The dispatch gate's own premise re-assertion,
          // re-run against the PR's live body at this exact head — a stale
          // `Premise:` pin (a symbol the head deleted since the brief was
          // authored) is a developer finding sent back through the SAME
          // gate-red retry prompt below, never a reason for this driver to
          // exit. `reassertPrBodyPremise` returns `null` for a body with no
          // `Premise:` block at all — dormant, same as every other PR. Runs
          // on every round's gate check, which is also the first thing a
          // re-exec'd child evaluates once it reaches this same point — one
          // call site covers both "on first run and on re-exec" (Traps to
          // avoid: no separate re-exec-only path to fall out of sync with
          // this one). Best-effort, like `runEvidenceReport`: a body-fetch
          // failure here is its own infrastructure hiccup, never grounds to
          // treat the premise itself as failed.
          const premiseResult: PremiseReassertResult | null = checkPremiseAtHead(prNumber)
          const premiseFailed = premiseResult !== null && !premiseResult.pass
          const premiseFailureLines = premiseResult !== null ? premiseResult.errors.map((e) => e.message) : []
          const gateGreen = gate.green && !premiseFailed
          lastFailingChecks = [...gate.failingChecks, ...premiseFailureLines]
          pendingGateRedRetry = !gateGreen
          if (mechanicalRetryRecoverySurvivesOneReset) {
            mechanicalRetryRecoverySurvivesOneReset = false
          } else {
            gateStalledStreak = 0
          }
          unpushedResumeAttempted = false
          const confidence = round >= 2 && gateGreen ? readAndClearConfidence(round) : undefined
          const obs: Observations = { kind: 'gate', round, green: gateGreen, confidence, stats: gate.stats }
          const result = assessRound(state, obs)
          state = result.state
          decision = result.decision
          if (decision.type === 'pause' && decision.reason === 'confidence' && decision.detail === undefined) {
            decision = { ...decision, detail: describeConfidencePauseDetail(confidence ?? 'absent') }
          }
          await logEvents(result.events)
          persistCurrentLoopState(decision.type, decision.type === 'pause' ? decision.reason : undefined)
        } else if (decision.type === 'ask_confidence') {
          const reaskConfidencePath = confidenceFilePathFor(round)
          const reaskPrompt = `Your last reply did not include a valid confidence line.\n\n${confidencePromptLine(reaskConfidencePath)}`
          await dispatchDeveloper(reaskPrompt, round, { developerFiles: [reaskConfidencePath] })
          const head = d.resolveHead(branch)
          const stats = computeStats(head, roundStartMs)
          const confidence = readAndClearConfidence(round)
          const obs: Observations = { kind: 'gate', round, green: true, confidence, stats }
          const result = assessRound(state, obs)
          state = result.state
          decision = result.decision
          if (decision.type === 'pause' && decision.reason === 'confidence' && decision.detail === undefined) {
            decision = { ...decision, detail: describeConfidencePauseDetail(confidence) }
          }
          pendingGateRedRetry = false
          if (mechanicalRetryRecoverySurvivesOneReset) {
            mechanicalRetryRecoverySurvivesOneReset = false
          } else {
            gateStalledStreak = 0
          }
          unpushedResumeAttempted = false
          await logEvents(result.events)
          persistCurrentLoopState(decision.type, decision.type === 'pause' ? decision.reason : undefined)
        } else if (decision.type === 'dispatch_reviewers') {
          // O4/O7: mergeability is read BEFORE any CI
          // read or reviewer dispatch — a branch in conflict with the base
          // sends the developer back with the conflicting files named; no
          // reviewer starts and no CI is waited on for this head. Round
          // number does not advance (same discipline as the infrastructure
          // pause below — this round's reviewers never ran).
          const mergeableForReview = await pollMergeableState(prNumber)
          if (mergeableForReview === 'CONFLICTING') {
            pendingConflictFiles = d.fetchConflictingFiles('main', branch)
            decision = { type: 'dispatch_developer' }
            continue
          }
          // Genuinely resolved (or never conflicting) — clear the retry flag
          // so a later conflict starts its own fresh stall count rather than
          // inheriting this one's file list.
          pendingConflictFiles = null

          const head = d.resolveHead(branch)
          const ciConclusion = d.fetchCiConclusion(head)
          const resolvedObjectives = d.resolveIssueObjectives(task)
          const rulings = d.fetchRulings(prNumber)
          const rulingOrdinal = d.fetchNewestRulingOrdinal(prNumber)
          const revision = d.fetchSourceRevision(task)
          const briefContentAtDispatch = d.fetchFrozenBrief(task)
          // The base identity this round's candidate is judged against
          // (task 5, O1; issue-657, O4) — the merge base of `head` and the
          // default branch, never the default branch's raw tip: a commit
          // that landed on the default branch after this candidate branched
          // is never part of the pull request's own diff, and judging
          // against the raw tip attributed that drift to the PR. Resolved
          // ONCE here and reused in the self-check below, so it never drifts
          // within a single round: the same treatment the policy already
          // gets (`loop.md`, "the policy is resolved once per loop run and
          // so never drifts within a single run"). A base move across
          // rounds is caught by the gate and by the existing `stale_driver`
          // guard, not by manufacturing a new mid-round pause reason.
          const baseSha = await d.gitMergeBase(head)
          const manifest: ReviewInputManifest = buildReviewInputManifest({
            headSha: head,
            baseSha,
            briefContent: briefContentAtDispatch,
            objectivesVersion: resolvedObjectives.version,
            rulingOrdinal,
            policy
          })
          lastDispatchedManifest = manifest
          const facts: ReviewerPromptFacts = {
            objectives: resolvedObjectives.text,
            resolvedObjectives: resolvedObjectives.objectives,
            rulings,
            ciConclusion,
            revision,
            manifest
          }

          // O1: the parent persists this round's manifest to the control store
          // BEFORE dispatching reviewers — the durable record `loop.md`'s
          // "Deferred, deliberately" paragraph named, now that the store is
          // built. Best-effort (see `persistManifestRecord`): a snapshot that
          // could not be written never fails the round; the echoed-comment
          // binding is what gates a verdict. Skipped only when the repository
          // cannot be resolved (no identity to key the record on).
          if (repo) {
            persistManifestRecord(root, task, manifest, {
              repository: `${repo.owner}/${repo.repo}`,
              pr: prNumber,
              branch,
              round,
              recordedAt: new Date(d.now()).toISOString()
            })
          }

          // O1/O2: the head's required CI is already green (this branch is
          // only ever entered off a `gate` observation reading `green: true`
          // — `assessRound`'s own policy) and mergeability is already
          // confirmed above — this is the earliest point the round's own
          // Developer-turn artifacts (the outbox response file) are safe to
          // read and clear, and the earliest point the evidence report can
          // run against a head that will not move again this round. Posted
          // BEFORE the reviewer dispatch below, never after: a reviewer
          // reading the PR mid-round sees the round marker comment already
          // there, exactly as it would have if the Developer had posted it.
          const findingIdsAddressed = readAndClearRoundResponse(round)
          postDeveloperRoundComment(round, head, findingIdsAddressed)

          // O5: an infrastructure outcome from either role (after its own
          // one-retry inside `dispatchReviewer`) is a driver-decided pause —
          // there is no `Observations` kind for it (adding one would edit
          // `packages/aeg-core`, out of this task's declared Surface) — but
          // `driverDecidedPauseEvents` logs the same
          // `stop_condition_met`/`paused`/`round_ended`/`journal_finalized`
          // events every policy-decided pause gets (a round-2 code-review MAJOR
          // finding: the driver used to build this `pause` decision by hand
          // and skip the log entirely). No verdict is held or published for
          // this round, and the round number does not advance.
          let verdicts:
            | [
                { verdict: RoundVerdictParse; findingsUncitable: boolean },
                { verdict: RoundVerdictParse; findingsUncitable: boolean }
              ]
            | null = null
          // O1: ONE shared, read-only candidate for this round,
          // built once here — before either reviewer dispatches — from the
          // developer's own local worktree, so both roles judge byte-
          // identical content regardless of what that worktree does after
          // this copy is taken. `null` when no local worktree exists on
          // this machine (a fresh attach with nothing dispatched here yet)
          // OR the local worktree's own head no longer matches the round's
          // resolved candidate sha (round 2 review, MAJOR: a diverged local
          // worktree copied blind would hand both reviewers content the
          // manifest's `headSha` never actually pinned, with nothing else
          // in this mechanism positioned to catch it) — `dispatchReviewer`
          // then omits `cwd` entirely, the same as every round before this
          // task.
          const candidateSourceDir = worktreePathForBranch()
          // `buildVerifiedReviewerCandidate` (reviewer-isolation.ts) checks
          // the worktree's head both before AND after the copy — the local
          // worktree can advance mid-copy (round 2 review, MINOR), and a
          // candidate caught that way is discarded rather than handed to
          // both reviewers as bytes the manifest's own `headSha` never
          // actually pinned.
          const candidateDir = buildVerifiedReviewerCandidate(
            root,
            task,
            round,
            candidateSourceDir,
            head,
            d.readWorktreeHead
          )
          try {
            // O1/O2: the evidence report runs IN PARALLEL with both reviewer
            // dispatches, never before or after them — reviewers dispatch on
            // the green head without waiting on the report, and the report
            // never waits on reviewers either. A report failure is logged,
            // never a pause: this task exists precisely so the loop's own
            // paperwork can never cost a round (O1's origin — a report that
            // took over ten minutes idled the session twice). The merge
            // gate's own `evidence-fresh` check is the real backstop for a
            // report that never lands.
            const [reviewerResult, securityResult, evidenceOutcome] = await Promise.all([
              dispatchReviewer('reviewer', round, facts, candidateDir),
              dispatchReviewer('security', round, facts, candidateDir),
              d.runEvidenceReport(prNumber, worktreePathForBranch(), branch)
            ])
            verdicts = [reviewerResult, securityResult]
            if (!evidenceOutcome.ok) {
              // Logged to the driver's own role log, never a PR comment: a
              // report failure is never counted toward `no_progress` or a
              // pause (O1's whole point), and the `evidence-fresh` merge-gate
              // check is the real backstop for a block that never lands —
              // this line exists purely so a Principal reading
              // `vinaya task status --follow` can see why.
              appendRoleLine(
                loopLogPath,
                'dev-review-loop',
                `evidence_report_failed: round=${round} head=${head} reason=${evidenceOutcome.reason}`
              )
            }
          } catch (err) {
            if (!(err instanceof ReviewerInfrastructureFailure) && !(err instanceof ReviewerReportParseFailure))
              throw err
            // An invalid report is a failure
            // observation, never something a reader could mistake for a
            // clean, empty `verdicts_read` — this role never reached one, so
            // its own `role_attempt` line is the only durable record of the
            // attempt at all. `usage`/`attempt` stay honestly unavailable at
            // this generic catch site, but `effect_id`/`duration_ms` are the
            // failing attempt's own REAL values (round 2 review, MAJOR: a
            // freshly minted id here could never be joined back to the
            // `dispatch`/`role_attempt`/`usage` lines `dispatchRole` already
            // logged for that same attempt, and the whole round's elapsed
            // time is not this attempt's own duration) — carried on the
            // thrown error by `buildVerdictFromReport`'s own `handle`
            // parameter (`ReviewerReportParseFailure`) or the last dispatch
            // attempt in `dispatchReviewer`'s retry loop
            // (`ReviewerInfrastructureFailure`). `null` only in the
            // structurally unreachable case where no attempt ever produced
            // a handle at all.
            log({
              kind: 'role_attempt',
              event: 'attempted',
              payload: {},
              actor: err.role,
              attempt: null,
              effect_id: err.attemptEffectId ?? randomUUID(),
              model: dispatchAgent,
              outcome: err instanceof ReviewerInfrastructureFailure ? 'infrastructure_failed' : 'incomplete',
              usage: null,
              duration_ms: err.attemptDurationMs ?? d.now() - roundStartMs
            })
            const stats = computeStats(head, roundStartMs)
            await logEvents(driverDecidedPauseEvents(config.loopId, state, round, stats))
            decision = { type: 'pause', reason: 'infrastructure', detail: err.message }
            infrastructureRetries += 1
          } finally {
            // O3: this round's candidate and every scratch copy any attempt
            // created — removed the moment the round's reviewer dispatches
            // are done with it, whether the round published, paused, or is
            // about to hand another round back to the developer. Never
            // conditioned on `verdicts` being set: an infrastructure failure
            // above still built a candidate/scratch worth cleaning up.
            cleanupReviewerIsolationForRound(root, task, round)
          }

          if (verdicts) {
            // O2: the loop's own publication self-check — objectives may have
            // moved between the dispatch above (`facts.manifest`, captured
            // before either reviewer ran) and now, right after both finished
            // (a principal's `issue objectives edit`, a ruling, a brief
            // supersession, or — in principle — a policy change can each land
            // mid-round). Re-resolved BEFORE either verdict is held: neither
            // `verdicts` value (still in-memory only) is ever written to disk
            // on a mismatch, so "the held verdicts … are discarded" holds by
            // never holding them. `compareManifest` — the SAME comparison the
            // merge gate calls — decides this, field by field, rather than a
            // second, hand-rolled inequality check per field: the echo here
            // is simply `facts.manifest` itself, never a
            // round-trip through the rendered text (Traps to avoid — nothing
            // to trust or distrust when the value is this driver's own, still
            // in memory).
            const reassessedObjectives = d.resolveIssueObjectives(task)
            const reassessedRulingOrdinal = d.fetchNewestRulingOrdinal(prNumber)
            const reassessedBriefContent = d.fetchFrozenBrief(task)
            const currentManifest: ReviewInputManifest = buildReviewInputManifest({
              headSha: head,
              baseSha,
              briefContent: reassessedBriefContent,
              objectivesVersion: reassessedObjectives.version,
              rulingOrdinal: reassessedRulingOrdinal,
              policy
            })
            const binding = compareManifest(manifestAsEchoed(facts.manifest), currentManifest)
            if (!binding.objectivesVersion) {
              const command = reassessedObjectives.edit
                ? describeObjectivesEdit(task, reassessedObjectives.edit)
                : `vinaya issue objectives edit ${task} ... (edit comment not found on re-read)`
              const detail = `objectives moved from ${facts.manifest.objectivesVersion ?? 'none'} to ${
                reassessedObjectives.version ?? 'none'
              } between reviewer dispatch and assessment — superseded by \`${command}\``
              const stats = computeStats(head, roundStartMs)
              await logEvents(driverDecidedPauseEvents(config.loopId, state, round, stats))
              decision = { type: 'pause', reason: 'objectives_changed', detail }
            } else if (!binding.rulingOrdinal) {
              const detail = `a new ruling landed between reviewer dispatch and assessment — ruling ordinal moved from ${facts.manifest.rulingOrdinal} to ${reassessedRulingOrdinal} — superseded by ruling ${prNumber}-${reassessedRulingOrdinal}`
              const stats = computeStats(head, roundStartMs)
              await logEvents(driverDecidedPauseEvents(config.loopId, state, round, stats))
              decision = { type: 'pause', reason: 'ruling_posted', detail }
            } else if (!binding.briefHash) {
              const detail = `the frozen brief was superseded between reviewer dispatch and assessment — brief hash moved from ${facts.manifest.briefHash ?? 'none'} to ${currentManifest.briefHash ?? 'none'}`
              const stats = computeStats(head, roundStartMs)
              await logEvents(driverDecidedPauseEvents(config.loopId, state, round, stats))
              decision = { type: 'pause', reason: 'brief_superseded', detail }
            } else if (!binding.policyDigest) {
              const detail = `the review policy changed between reviewer dispatch and assessment — policy digest moved from ${facts.manifest.policyDigest} to ${currentManifest.policyDigest}`
              const stats = computeStats(head, roundStartMs)
              await logEvents(driverDecidedPauseEvents(config.loopId, state, round, stats))
              decision = { type: 'pause', reason: 'policy_changed', detail }
            } else {
              const [reviewer, security] = verdicts
              // Both roles genuinely finished (`Promise.all` did not reject) —
              // only now is it safe to hold either verdict on disk (O2's "nothing
              // is held … for that round" invariant; see `dispatchReviewer`'s doc
              // comment, above).
              writeHeldVerdict(root, task, round, 'reviewer', reviewer.verdict.rendered)
              writeHeldVerdict(root, task, round, 'security', security.verdict.rendered)
              // The round whose verdict is
              // now held on disk, awaiting delivery or publish — recovered
              // so a crash right after this write, before the round's own
              // outcome is even decided, is never silently forgotten.
              heldResultIdentity = { round, head }
              lastReviewContext = `${reviewer.verdict.rendered}\n\n---\n\n${security.verdict.rendered}`

              // Recorded once per round, so a Principal reading
              // the PR sees WHICH role's ids the driver could not trust —
              // never silent just because the round still proceeded.
              const uncitableRoles = [
                reviewer.findingsUncitable ? 'reviewer' : null,
                security.findingsUncitable ? 'security' : null
              ].filter((r): r is string => r !== null)
              if (uncitableRoles.length > 0) {
                postForgeEffectOnce(root, task, `report-uncitable-${round}`, () =>
                  postMarkedComment(
                    'pr',
                    String(prNumber),
                    '<!-- aeg:loop:report-uncitable -->',
                    `report_uncitable: ${uncitableRoles.join(', ')} still carried findings with no citable \`FINDING_IDS:\` after one resend this round. Proceeding on this round's severities — never counted toward \`no_progress\`.`
                  )
                )
              }

              const obs: Observations = {
                kind: 'verdicts',
                round,
                verdicts: [reviewer.verdict.observation, security.verdict.observation]
              }
              const result = assessRound(state, obs)
              state = result.state
              decision = result.decision
              if (decision.type === 'pause' && decision.detail === undefined) {
                decision = {
                  ...decision,
                  detail: deriveVerdictPauseDetail(
                    decision.reason,
                    result.events,
                    reviewer.verdict.observation.verdict === 'ESCALATE',
                    security.verdict.observation.verdict === 'ESCALATE'
                  )
                }
              }
              const routed = routeCompletionEvents(result.events, decision.type)
              pendingCompletionEvents = routed.toDeferUntilPublish
              await logEvents(routed.toLogNow)
              if (decision.type === 'dispatch_developer') round += 1
              persistCurrentLoopState(decision.type, decision.type === 'pause' ? decision.reason : undefined)
            }
          } else {
            persistCurrentLoopState(decision.type, decision.type === 'pause' ? decision.reason : undefined)
          }
        }

        if (decision.type === 'publish') {
          // O5: mergeability is read AGAIN before
          // publication — reviewers can take long enough that a clean head
          // falls into conflict with the base while they worked. A branch
          // that fell into conflict has its held verdicts for this round
          // discarded (never published against a head that cannot merge);
          // the developer is resumed to resolve, and round does not advance,
          // so the NEXT reviewer dispatch judges the resolved head.
          const mergeableForPublish = await pollMergeableState(prNumber)
          if (mergeableForPublish === 'CONFLICTING') {
            discardHeldVerdicts(root, task, round)
            // This round's deferred completion events described an outcome
            // (`publish`) that is no longer real — dropped rather than logged
            // against whichever LATER round genuinely publishes next.
            pendingCompletionEvents = []
            pendingConflictFiles = d.fetchConflictingFiles('main', branch)
            decision = { type: 'dispatch_developer' }
            // The held-verdict files this round's `heldResultIdentity` named
            // were just discarded above — nothing is held any more.
            heldResultIdentity = null
            persistCurrentLoopState(decision.type)
            continue
          }
          pendingConflictFiles = null

          // O8 (round 2 review, BLOCKER): re-check staleness here too — a
          // clean `dispatch_reviewers` → `publish` transition reaches this
          // point in the SAME iteration, with no loop-back to the top in
          // between, so the top-of-loop check alone never catches a base that
          // moved past this driver's own code while reviewers were working.
          if (await checkStaleDriver()) {
            continue
          }

          publishRound(root, {
            task,
            round,
            prNumber,
            expectedHead: d.resolveHead(branch),
            journal: { rounds: state.rounds },
            policy,
            // The manifest this round was dispatched against (O3) —
            // the pre-hold self-check already proved it did not drift before
            // either verdict was held, so binding the posted comments against
            // it is the same field-complete check the gate applies. Non-null
            // on every real path here: a `publish` decision is only ever set
            // inside the `dispatch_reviewers` branch that just assigned it.
            manifest:
              lastDispatchedManifest ??
              buildReviewInputManifest({
                headSha: d.resolveHead(branch),
                baseSha: await d.gitMergeBase(d.resolveHead(branch)),
                briefContent: d.fetchFrozenBrief(task),
                objectivesVersion: d.resolveIssueObjectives(task).version,
                rulingOrdinal: d.fetchNewestRulingOrdinal(prNumber),
                policy
              })
          })
          // Only now — posts confirmed, not merely attempted — does the durable
          // log get to say this run completed. A throw above (a post that
          // failed, or re-parsed dirty) skips this entirely, so the log never
          // claims `merged_ready` for a run that did not actually finish.
          await logEvents(pendingCompletionEvents)
          // Published — nothing is held any more.
          heldResultIdentity = null
          persistCurrentLoopState('publish')
          return { finalDecision: decision, prNumber, task }
        }

        if (decision.type === 'pause') {
          // 'infrastructure' and 'stale_driver' are the
          // loop's own two "the mechanics stalled, not a review verdict"
          // reasons (the gate-red bound, a missing-artifact reviewer retry
          // bound, a re-exec that could not proceed) — recoverable hiccups,
          // never a human decision point. Every other reason here IS a
          // decision only a Principal can make (escalation, max_rounds,
          // confidence, reappearance, no_push, objectives_changed,
          // ruling_posted, brief_superseded, policy_changed) and clears the
          // lock exactly as before.
          if (decision.reason === 'infrastructure' || decision.reason === 'stale_driver') {
            keepLockAlive = true
          }
          const pauseHead = d.resolveHead(branch)
          // O1: best-effort, same discipline as the crash-catch pause site —
          // written BEFORE `pause-state.json` so its own real `escalationId`
          // (code review, round 2, MEDIUM — see `writeEscalation`'s own doc
          // comment) can be carried on `PauseState`.
          let escalationRecord: EscalationRecord | null = null
          try {
            escalationRecord = writeEscalationRecord({
              task,
              round,
              head: pauseHead,
              branch,
              pr: prNumber > 0 ? prNumber : null,
              runId,
              agent: dispatchAgent,
              reason: decision.reason,
              detail: decision.detail,
              evidence: lastReviewContext ?? undefined,
              ...bestEffortInputVersions()
            })
          } catch {
            // Best-effort — the pause state and comment below are the
            // authoritative record.
          }
          writePauseState(root, {
            task,
            round,
            head: pauseHead,
            branch,
            prNumber,
            reason: decision.reason,
            detail: decision.detail,
            pausedAt: new Date().toISOString(),
            agent: dispatchAgent,
            ...(dispatchModel ? { model: dispatchModel } : {}),
            escalationId: escalationRecord?.escalationId,
            infrastructureRetries
          })
          // O1: `postPauseComment` never
          // throws — a post that fails even after its own bounded retry
          // reports `posted: false` rather than escaping to crash the
          // driver or reach the outer catch, which would otherwise
          // overwrite `writePauseState`'s already-correct reason, above,
          // with a synthetic 'infrastructure' one.
          await logPauseCommentRetryIfNotable(
            round,
            postPauseComment(task, round, pauseHead, prNumber, decision.reason, decision.detail, {
              agent: dispatchAgent,
              ...(dispatchModel ? { model: dispatchModel } : {})
            })
          )
          // Every pause, regardless of
          // which branch above decided it, funnels through here exactly
          // once before returning — the one call site that makes every
          // pause reason's final round/budget/held-result state durable.
          persistCurrentLoopState('pause', decision.reason)
          return { finalDecision: decision, prNumber, task }
        }
      }
    }
  }
}

// --- cancel (O3) -------------------------------------------------------

export type CancelInput = { cancelPr: number; agent: AgentVendor }
export type CancelResult = { task: number; escalationId: string; fencedEffectKeys: string[] }

export type CancelDeps = {
  fetchPrBody: typeof fetchPrBody
  taskFromPrBody: typeof taskFromPrBody
  readPauseState: typeof readPauseState
  fetchRulings: typeof fetchRulings
  fetchNewestRulingOrdinal: typeof fetchNewestRulingOrdinal
  fetchNewestRulingAuthor: typeof fetchNewestRulingAuthor
  runtimeDir: () => string
  resolveLogAppendPath: (repo: { owner: string; repo: string } | null, issue: number) => string | Promise<string>
  resolveRepo: () => Promise<{ owner: string; repo: string } | null>
  terminateInFlightLaunchesOnShutdown: (
    task: number,
    agent: AgentVendor,
    repo: { owner: string; repo: string } | null
  ) => void
  sleep: (ms: number) => Promise<void>
}

function defaultCancelDeps(): CancelDeps {
  return {
    fetchPrBody,
    taskFromPrBody,
    readPauseState,
    fetchRulings,
    fetchNewestRulingOrdinal,
    fetchNewestRulingAuthor,
    runtimeDir,
    resolveLogAppendPath,
    resolveRepo: () => resolveRepo().catch(() => null),
    sleep: defaultSleep,
    terminateInFlightLaunchesOnShutdown: defaultTerminateInFlightLaunchesOnShutdown
  }
}

/**
 * O3: cancels a PAUSED run's own escalation — "resume or cancel only their
 * intended run" is this function's own half of that sentence, the mirror of
 * `devReviewLoop`'s `--resume` path above. Never re-enters the round loop
 * (a cancelled run has nothing left to continue): it authenticates the same
 * way `--resume` does (a principal-authored ruling comment on the PR — "the
 * Operator cannot author a ruling," Traps to avoid), consumes the SAME
 * `resolveEscalation` single-consumption guard (so a paused escalation
 * cannot be BOTH resumed and cancelled, nor cancelled twice), requests
 * termination of whichever role is genuinely in flight through task 3's own
 * identity-checked shutdown path (a safe no-op when nothing is), and fences
 * any effect record left `'started'` — a late-arriving reviewer result, or
 * an in-flight forge post — as `'uncertain'` under the SAME epoch the
 * resolution was just consumed under, so a write still trying to complete
 * against the now-superseded epoch is refused by `StaleEpochWriteError` the
 * instant it tries, never silently landing after cancellation.
 */
export async function cancelDevReviewLoop(input: CancelInput, deps: Partial<CancelDeps> = {}): Promise<CancelResult> {
  // Round 2 review (MAJOR) / security review (MEDIUM): a driver runs with no
  // human watching, so it must resolve `runtimeDir` through the
  // default-branch gate rather than trusting the working tree. Marked FIRST,
  // before any path is resolved and before anything is dispatched, so the
  // classification is already true for this process and for every child that
  // inherits its environment.
  markProcessUnattended()
  const d: CancelDeps = { ...defaultCancelDeps(), ...deps }
  const task = d.taskFromPrBody(d.fetchPrBody(input.cancelPr))
  if (task === null) {
    throw new Error(
      `devReviewLoop --cancel: PR #${input.cancelPr}'s body carries no \`Closes #N\` reference — cannot derive its task.`
    )
  }
  const root = d.runtimeDir()
  const held = d.readPauseState(root, task)
  if (!held) {
    throw new Error(
      `devReviewLoop --cancel: no held pause state found for task ${task} (PR #${input.cancelPr}) — nothing to cancel.`
    )
  }
  if (held.prNumber !== input.cancelPr) {
    throw new Error(
      `devReviewLoop --cancel: task ${task}'s held pause state names PR #${held.prNumber}, not PR #${input.cancelPr}.`
    )
  }
  const rulings = d.fetchRulings(input.cancelPr)
  if (rulings.length === 0) {
    throw new Error(
      `devReviewLoop --cancel: PR #${input.cancelPr} carries no Principal ruling comment yet — nothing authenticates this cancel.`
    )
  }
  // See the identical comment on the `--resume` path above.
  const escalationId = held.escalationId ?? escalationIdFor(task, held.round, held.head)
  // Code review, round 2, MAJOR: the operator-typed `--agent` flag used to
  // decide what gets terminated with nothing persisted to check it against.
  // The escalation record now carries the agent the run was ACTUALLY
  // dispatched under (`EscalationFacts.agent`, written at pause time) — read
  // (peeked, never consumed) BEFORE `resolveEscalation` below so a mismatch
  // is refused before the resolution is ever consumed, not after: a
  // mistyped or stale `--agent` must never leave a genuine cancel decision
  // silently recorded while still refusing to act on it. `undefined` only
  // for an escalation record written before this field existed; that legacy
  // case falls back to trusting the operator-supplied value, same as before
  // this fix.
  const peekedEscalation = readEscalationRecord(task, escalationId)
  const dispatchedAgent = peekedEscalation?.agent
  if (dispatchedAgent !== undefined && dispatchedAgent !== input.agent) {
    throw new Error(
      `devReviewLoop --cancel: task ${task}'s escalation was dispatched under agent '${dispatchedAgent}', not '${input.agent}' — refusing to terminate under the wrong agent. Retry with --agent ${dispatchedAgent}.`
    )
  }
  const terminateAgent: AgentVendor =
    dispatchedAgent !== undefined && isAgentVendor(dispatchedAgent) ? dispatchedAgent : input.agent
  const authenticatedBy = d.fetchNewestRulingAuthor(input.cancelPr) ?? 'unknown-principal'
  const authenticatedFrom = `${input.cancelPr}-${d.fetchNewestRulingOrdinal(input.cancelPr)}`
  let resolved: ResolveEscalationResult
  try {
    resolved = resolveEscalation(task, escalationId, input.cancelPr, 'cancel', authenticatedBy, authenticatedFrom)
  } catch (err) {
    if (
      err instanceof WrongTargetResolutionError ||
      err instanceof StaleEscalationError ||
      err instanceof ReplayedResolutionError
    ) {
      // Mutate the message in place and rethrow the SAME instance — a caller
      // (`task_cancel`'s handler) that needs `instanceof` to tell a replayed
      // cancel apart from a wrong-target/stale one must still be able to,
      // which a fresh `new Error(...)` here would silently lose (code review,
      // MAJOR: this used to throw a plain `Error`, so `instanceof
      // ReplayedResolutionError` downstream could never match a real
      // duplicate cancel request going through this function).
      err.message = `devReviewLoop --cancel: ${err.message}`
      throw err
    }
    throw err
  }
  const repo = await d.resolveRepo()
  d.terminateInFlightLaunchesOnShutdown(task, terminateAgent, repo)
  const fencedEffectKeys = fenceStartedEffectsAsUncertain(task, resolved.epoch)

  // The `cancelled` terminal observation — this
  // command is its own process, with no `LoopConfig.loopId` carried over
  // from whatever run it is cancelling (never persisted anywhere to
  // recover), so it mints one of its own, the same fresh-`loop_id`-per-
  // process convention every other pause/crash event already follows for a
  // NEW process that was never part of the original loop run. `VINAYA_TASK`
  // is set first so this line (and its own `lineage.run`, via
  // `process.env.VINAYA_RUN` below) files under the SAME task outbox every
  // other event for this task already lands in, never the `none` bucket —
  // and restored in the `finally` below, the SAME save/restore-around-one-
  // call discipline `log-flush.ts`'s `logForFlush` already uses. This
  // function is a one-shot CLI command's own process (safe to mutate for its
  // remaining lifetime either way) but is ALSO called in-process, unchanged,
  // from `task-tools/cancel.ts` inside the shared, multi-task `vinaya
  // task-tools serve` MCP server (round 2 security review, HIGH): leaving
  // these globals mutated after this call returns would silently misattribute
  // every later `log()` call in that process — including a completely
  // different task's own `task_resume` — into THIS task's outbox, exactly
  // the fabricated cross-task history O1/O3 forbid.
  const prevTask = process.env.VINAYA_TASK
  const prevRun = process.env.VINAYA_RUN
  process.env.VINAYA_TASK = String(task)
  const cancelLoopId = randomUUID()
  process.env.VINAYA_RUN = cancelLoopId
  const cancelEvent: DevReviewLoopEventInput = {
    kind: 'dev_review_loop',
    payload: {},
    loop_id: cancelLoopId,
    event: 'cancelled',
    round: held.round,
    by: 'principal'
  }
  const cancelOutboxPath = await d.resolveLogAppendPath(repo, task)
  const priorSize = sizeOfSafe(cancelOutboxPath)
  try {
    log(cancelEvent)
    await waitForOwnLoopLine(cancelOutboxPath, priorSize, currentRunId(), cancelEvent, d.sleep)
  } finally {
    if (prevTask === undefined) delete process.env.VINAYA_TASK
    else process.env.VINAYA_TASK = prevTask
    if (prevRun === undefined) delete process.env.VINAYA_RUN
    else process.env.VINAYA_RUN = prevRun
  }

  return { task, escalationId, fencedEffectKeys }
}

export const DEV_REVIEW_LOOP_AGENTS = AGENT_VENDOR_NAMES
