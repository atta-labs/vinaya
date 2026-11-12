import type { Confidence } from '../../../../tools/dev-review-policy/types'
import type { PauseReason } from '../../../../tools/dev-review-policy/types'
import type { DevReviewLoopEventInput } from '../../../../tools/dev-review-policy/types'

import { gh } from '../../../../tools/pr-report/pr-report-engine.js'
import { isGitHubConnectionFailure } from './round-assess.js'

import { sanitizePublicPauseDetail } from './pause-resume.js'
import { execFileSync } from 'node:child_process'
import { programForWords } from '../../../../tools/programs.js'
import { cliEntryPath } from '../../../../tools/cli-entry.js'
import { programFile } from '../../../../tools/programs.js'
import { spawnSync } from 'node:child_process'
import { obtainFreshReportBase } from '../../../../tools/pr-report/pr-report-engine.js'
import { buildReport } from '../../../../tools/pr-report/pr-report-engine.js'
import { runReportForOpenPr } from '../../../../tools/pr-report/pr-report-engine.js'
import type { AgentVendor } from '../../dispatch/dispatch.js'
import { terminateLaunchedChildOnShutdown as realTerminateLaunchedChildOnShutdown } from '../../dispatch/dispatch.js'
import type { LoopDeps } from './driver-deps.js'
import { dispatchRole as realDispatchRole } from '../../dispatch/dispatch.js'
import { resolveHead } from './gate-reading.js'
import { resolveParentBranch } from './gate-reading.js'
import { reviewPolicyForLoop } from './developer-dispatch.js'
import { fetchCiConclusion } from './gate-reading.js'
import { fetchFailingCheckRuns } from './gate-reading.js'
import { fetchFailedCheckWorkflowRunIds } from './gate-reading.js'
import { rerunFailedWorkflowJobs } from './gate-reading.js'
import { readJobLogTail } from '../../run-control/pr-facts.js'
import { fetchRulings } from './developer-dispatch.js'
import { fetchRulingText } from './developer-dispatch.js'
import { fetchNewestRulingOrdinal } from './developer-dispatch.js'
import { fetchNewestRulingAuthor } from './developer-dispatch.js'
import { fetchNewestIssueRulingOrdinal } from './developer-dispatch.js'
import { fetchIssueRulings } from './developer-dispatch.js'
import { fetchIssueRulingsAfterBrief } from './developer-dispatch.js'
import { fetchNewestIssueRulingAuthor } from './developer-dispatch.js'
import { fetchFrozenBrief } from './developer-dispatch.js'
import { resolveIssueObjectives } from './developer-dispatch.js'
import { fetchSourceRevision } from './developer-dispatch.js'
import { developerBranchFor } from './developer-dispatch.js'
import { checkTaskDispatchReadiness } from './developer-dispatch.js'
import { findOpenPrForBranch } from './developer-dispatch.js'
import { fetchIssueTitle } from './developer-dispatch.js'
import { createTaskWorktree } from './developer-dispatch.js'
import { createTaskWorktreeFromRemote } from './developer-dispatch.js'
import { readResumeRecord as realReadResumeRecord } from '../../dispatch/dispatch.js'
import { runtimeDir } from './reviewer-dispatch.js'
import { resolveVinayaLogAppendPath } from '../../../../integration/log/log-sink-factory.js'
import { defaultRepoRoot } from './git-defaults.js'
import { defaultGitRevParseOriginMain } from './git-defaults.js'
import { defaultGitIsAncestor } from './git-defaults.js'
import { defaultGitMergeBase } from './git-defaults.js'
import { defaultGitFetch } from './git-defaults.js'
import { defaultGitDiffShortstat } from './git-defaults.js'
import { defaultGitUnifiedDiff } from './git-defaults.js'
import { resolveTrustAnchorSecurityScanCommand } from './security-scan-command.js'
import { loadTrustAnchorConfig } from '../../../../integration/config/compose.js'
import { defaultGitChangedPaths } from './git-defaults.js'
import { defaultRunSecurityScanSubprocess } from './git-defaults.js'
import { defaultResolveTaskSurface } from './git-defaults.js'
import { resolveRoleDoctrineText } from '../../../../integration/roles/plan.js'
import { resolveDeveloperDoctrineText } from './developer-dispatch.js'
import { fetchLoopHistory } from './journal-history.js'
import { defaultSetHeartbeat } from './driver-lifecycle.js'
import { readWorktreeHead } from './gate-reading.js'
import { readUnpushedWorkDetail } from './unpushed-work.js'
import { defaultReadWorktreeBranch } from './git-defaults.js'
import { defaultGitWorktreeChangedPaths } from './git-defaults.js'
import { defaultReadDefaultBranchTip } from './git-defaults.js'
import { defaultReadMergedDefaultCommit } from './git-defaults.js'
import { defaultClassifyAgainstDefaultTip } from './git-defaults.js'
import { defaultRebaseOntoDefaultTip } from './git-defaults.js'
import { defaultMergeDefaultTip } from './git-defaults.js'
import { defaultRestoreWorktreeHead } from './git-defaults.js'
import { defaultPushTaskBranchWithLease } from './developer-defaults.js'
import { defaultGitWorktreeDiffText } from './git-defaults.js'
import { defaultBuildVendoredCliIfMissing } from './developer-defaults.js'
import { defaultInstallWorktreeDependencies } from './developer-defaults.js'
import { defaultCommitWorktree } from './developer-defaults.js'
import { validatePrBodyForCreate } from '../../../../tools/pull-request/bin/pr.js'
import { defaultPushTaskBranch } from './developer-defaults.js'
import { defaultOpenTaskPullRequest } from './developer-defaults.js'
import { defaultStartDevTools } from './developer-defaults.js'
import { defaultUpdatePrBody } from './developer-defaults.js'
import { defaultRefreshPrEvidence } from './developer-defaults.js'
import { defaultReadPrView } from './developer-defaults.js'
import { defaultRunWorktreeChecks } from './developer-defaults.js'
import { runRealLiveCommand } from './live-check.js'
import { vendorSignedIn } from './live-check.js'
import { LIVE_RUN_TIMEOUT_MS } from './live-check.js'
import { prepareRealLiveCheckout } from './live-check.js'
import { fetchDeveloperStop } from './developer-dispatch.js'
import { fetchMergeableState } from './gate-reading.js'
import { fetchConflictingFiles } from './gate-reading.js'
import { gitCommitsTouchingDriverPaths } from './gate-reading.js'
import { defaultSweepTasksAtStart } from './driver-helpers.js'
import { postMarkedComment } from '../../../../tools/task-contract/forge/forge-write.js'
import { postPauseComment } from './pause-resume.js'
import { postIssuePauseComment } from './pause-resume.js'
import { publishRound } from './publication.js'
import { upsertDeferredFindingsIssue } from '../../../../tools/task-contract/forge/forge-write.js'
import { fetchPrBody } from './developer-dispatch.js'
import { defaultPatchIdOf } from './git-defaults.js'

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
    return 'no accepted turn result stated a confidence on the re-asked turn — the developer never reported one a second time'
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
 * guard at each call site) — and so, for the same reason, is
 * `'repeat_finding'`, whose own `detail` from `assessRound` names the
 * reviewer-qualified finding key(s) that stayed open two rounds running. `assessVerdicts` no longer decides a
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

export async function defaultReadRateLimitReset(): Promise<number | null> {
  try {
    const out = await gh([
      'api',
      'rate_limit',
      '--jq',
      '[.resources.core, .resources.graphql] | map(select(.remaining == 0) | .reset) | max'
    ])
    const reset = Number(out.trim())
    return Number.isFinite(reset) && reset > 0 ? reset : null
  } catch {
    return null
  }
}

/** One `gh api rate_limit` read (it spends no limit): any answer, even a refusal, means GitHub is reachable. */
export async function defaultIsGitHubReachable(): Promise<boolean> {
  try {
    await gh(['api', 'rate_limit', '--jq', '.rate.limit'])
    return true
  } catch (err) {
    return !isGitHubConnectionFailure(err)
  }
}

export function defaultSleep(ms: number): Promise<void> {
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
export function gatePollEnvOverride(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** O7: `git pull --ff-only origin main` — the exact update `checkStaleDriver` re-execs from. `--ff-only` refuses rather than fabricating a merge commit on a base this driver never touches directly. */
export function defaultPullDefaultBranch(): { ok: true } | { ok: false; reason: string } {
  try {
    execFileSync('git', ['pull', '--ff-only', 'origin', 'main'], { stdio: ['ignore', 'ignore', 'pipe'] })
    return { ok: true }
  } catch (err) {
    const stderr = err && typeof err === 'object' && 'stderr' in err ? String((err as { stderr: unknown }).stderr) : ''
    return { ok: false, reason: stderr.trim() || (err instanceof Error ? err.message : String(err)) }
  }
}

/** O7: `process.argv[0]`/`[1]` are the interpreter and entry script this process itself was started with — re-spawning them with a fresh `args` tail reattaches under the exact same runtime, whether that's `bun apps/cli/src/index.ts` from source or a bundled `vinaya` binary. `stdio: 'inherit'` so the reattached run's own output reaches whatever terminal/log is watching this one. */
export function defaultReexecSelf(args: string[]): number | null {
  // A relaunch of a command a program replaced starts that program; any other starts the command line.
  const program = programForWords(args)
  const argv = program === null ? [cliEntryPath(), ...args] : [programFile(program.name), ...program.args]
  const result = spawnSync(process.argv[0] as string, argv, { stdio: 'inherit' })
  if (result.error) return null
  return result.status ?? 1
}

/**
 * The real `runEvidenceReport`: fetches `prNumber`'s live
 * body, builds the report from `cwd` (the task worktree, never
 * `process.cwd()` — see `pr-report-engine.ts`'s module doc, "`cwd`"), then
 * pushes it via `runReportForOpenPr` — the exact engine function `vinaya pr
 * report --push` itself calls. Never throws — every failure mode (the
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
export async function defaultRunEvidenceReport(
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
    // A required fresh-base read failure reaches the catch below as an infrastructure failure, never a stale ref.
    const base = await obtainFreshReportBase(cwd, envOverlay)
    const result = await buildReport({
      body: preEditBody,
      gradedBodySource: 'push',
      cwd,
      envOverlay,
      ...(base ? { base } : {})
    })
    // Every non-`'ok'` kind carries a `message` and reaches here as an
    // ordinary return, never a process exit — including `'body-checks-refused'`:
    // a body-check refusal during this push is just one more
    // failure mode this ternary already collapses to `{ ok: false, reason }`.
    const outcome = await runReportForOpenPr(pushPr, preEditBody, result, { branch })
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
export const IN_FLIGHT_SHUTDOWN_ROLES = ['developer', 'code-reviewer', 'security'] as const

/** Shared by `LoopDeps.terminateInFlightLaunchesOnShutdown`'s own default AND `cancelDevReviewLoop`'s (O3) — the identical role loop, never a second copy that could drift from it. */
export function defaultTerminateInFlightLaunchesOnShutdown(
  task: number,
  agent: AgentVendor,
  repo: { owner: string; repo: string } | null
): void {
  for (const role of IN_FLIGHT_SHUTDOWN_ROLES) realTerminateLaunchedChildOnShutdown(role, agent, repo, task)
}

export function defaultDeps(): LoopDeps {
  return {
    dispatchRole: realDispatchRole,
    resolveHead,
    resolveParentBranch,
    reviewPolicy: reviewPolicyForLoop,
    fetchCiConclusion,
    fetchFailingCheckRuns,
    fetchFailedCheckWorkflowRunIds,
    rerunFailedWorkflowJobs,
    readFailedCheckLogTail: (jobId) => readJobLogTail(jobId),
    fetchRulings,
    fetchRulingText,
    fetchNewestRulingOrdinal,
    fetchNewestRulingAuthor,
    fetchNewestIssueRulingOrdinal,
    fetchIssueRulings,
    fetchIssueRulingsAfterBrief,
    fetchNewestIssueRulingAuthor,
    fetchFrozenBrief,
    resolveIssueObjectives,
    fetchSourceRevision,
    developerBranchFor: (n, fetchTitle) => developerBranchFor(n, fetchTitle),
    // `VINAYA_DEV_REVIEW_LOOP_FAKE_DISPATCH_READINESS=1` exists only so a
    // real subprocess test (`dev-review-loop.test.ts`'s own fixtures, which
    // carry no real forge identity by design — VINAYA_REPO deleted, the fake
    // `git` binary answers no remote) can skip the real forge-dependent
    // shell-out `checkTaskDispatchReadiness` makes, the same "test env
    // escape hatch, unset in every real invocation" posture
    // `gatePollEnvOverride` already uses above. An in-process test
    // (`dev-review-loop-harness.ts`'s own `makeInProcessDeps`) overrides
    // this whole field directly instead and never needs the env var.
    checkTaskDispatchReadiness:
      process.env.VINAYA_DEV_REVIEW_LOOP_FAKE_DISPATCH_READINESS === '1'
        ? (_branch) => ({
            ready: true,
            output: 'VINAYA_DEV_REVIEW_LOOP_FAKE_DISPATCH_READINESS=1 — skipped for a test fixture'
          })
        : checkTaskDispatchReadiness,
    findOpenPrForBranch,
    fetchIssueTitle,
    createTaskWorktree,
    createTaskWorktreeFromRemote,
    readResumeRecord: (task, agent, repo) => realReadResumeRecord('developer', agent, repo, task),
    runtimeDir,
    resolveLogAppendPath: resolveVinayaLogAppendPath,
    repoRoot: defaultRepoRoot,
    gitRevParseOriginMain: defaultGitRevParseOriginMain,
    gitIsAncestor: defaultGitIsAncestor,
    gitMergeBase: defaultGitMergeBase,
    gitFetch: defaultGitFetch,
    gitDiffShortstat: defaultGitDiffShortstat,
    gitUnifiedDiff: defaultGitUnifiedDiff,
    resolveSecurityScanCommand: () => resolveTrustAnchorSecurityScanCommand(loadTrustAnchorConfig),
    gitChangedPaths: defaultGitChangedPaths,
    runSecurityScanSubprocess: defaultRunSecurityScanSubprocess,
    resolveTaskSurface: defaultResolveTaskSurface,
    resolveReviewerDoctrine: resolveRoleDoctrineText,
    resolveDeveloperDoctrine: resolveDeveloperDoctrineText,
    fetchLoopHistory,
    sleep: defaultSleep,
    now: () => Date.now(),
    readRateLimitReset: defaultReadRateLimitReset,
    isGitHubReachable: defaultIsGitHubReachable,
    setHeartbeat: defaultSetHeartbeat,
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
    readUnpushedWorkDetail,
    readWorktreeBranch: defaultReadWorktreeBranch,
    gitWorktreeChangedPaths: defaultGitWorktreeChangedPaths,
    readDefaultBranchTip: defaultReadDefaultBranchTip,
    readMergedDefaultCommit: defaultReadMergedDefaultCommit,
    classifyAgainstDefaultTip: defaultClassifyAgainstDefaultTip,
    rebaseOntoDefaultTip: defaultRebaseOntoDefaultTip,
    mergeDefaultTip: defaultMergeDefaultTip,
    restoreWorktreeHead: defaultRestoreWorktreeHead,
    pushTaskBranchWithLease: defaultPushTaskBranchWithLease,
    gitWorktreeDiffText: defaultGitWorktreeDiffText,
    buildVendoredCliIfMissing: defaultBuildVendoredCliIfMissing,
    installWorktreeDependencies: defaultInstallWorktreeDependencies,
    commitWorktree: defaultCommitWorktree,
    validatePrBodyForCreate,
    pushTaskBranch: defaultPushTaskBranch,
    openTaskPullRequest: defaultOpenTaskPullRequest,
    startDevTools: defaultStartDevTools,
    updatePrBody: defaultUpdatePrBody,
    refreshPrEvidence: defaultRefreshPrEvidence,
    readPrView: defaultReadPrView,
    runWorktreeChecks: defaultRunWorktreeChecks,
    runLiveCommand: runRealLiveCommand,
    liveVendorSignedIn: (vendor) => vendorSignedIn(vendor),
    liveRunTimeoutMs: LIVE_RUN_TIMEOUT_MS,
    prepareLiveCheckout: (repoRoot, head) => prepareRealLiveCheckout(repoRoot, head),
    fetchDeveloperStop,
    fetchMergeableState,
    fetchConflictingFiles,
    gitCommitsTouchingDriverPaths,
    pullDefaultBranch: defaultPullDefaultBranch,
    reexecSelf: defaultReexecSelf,
    exitProcess: (code) => process.exit(code),
    runEvidenceReport: defaultRunEvidenceReport,
    terminateInFlightLaunchesOnShutdown: defaultTerminateInFlightLaunchesOnShutdown,
    sweepTasksAtStart: defaultSweepTasksAtStart,
    // issue-709, O2: the real forge-write operations — unchanged for a real
    // run; a test injects fakes that record to its own in-memory world.
    postMarkedComment,
    postPauseComment,
    postIssuePauseComment,
    publishRound,
    writeDeferredFindingsIssue: upsertDeferredFindingsIssue,
    fetchPrBody,
    patchIdOf: defaultPatchIdOf
  }
}
