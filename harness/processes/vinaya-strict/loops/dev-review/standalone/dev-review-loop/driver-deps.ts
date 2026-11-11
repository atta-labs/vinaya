import type { dispatchRole as realDispatchRole } from '../../dispatch/dispatch.js'
import type { resolveHead } from './gate-reading.js'
import type { resolveParentBranch } from './gate-reading.js'
import type { reviewPolicyForLoop } from './developer-dispatch.js'
import type { fetchCiConclusion } from './gate-reading.js'
import type { fetchFailingCheckRuns } from './gate-reading.js'
import type { fetchFailedCheckWorkflowRunIds } from './gate-reading.js'
import type { rerunFailedWorkflowJobs } from './gate-reading.js'
import type { fetchRulings } from './developer-dispatch.js'
import type { fetchRulingText } from './developer-dispatch.js'
import type { fetchNewestRulingOrdinal } from './developer-dispatch.js'
import type { fetchNewestRulingAuthor } from './developer-dispatch.js'
import type { fetchNewestIssueRulingOrdinal } from './developer-dispatch.js'
import type { fetchIssueRulings } from './developer-dispatch.js'
import type { fetchIssueRulingsAfterBrief } from './developer-dispatch.js'
import type { fetchNewestIssueRulingAuthor } from './developer-dispatch.js'
import type { fetchFrozenBrief } from './developer-dispatch.js'
import type { resolveIssueObjectives } from './developer-dispatch.js'
import type { fetchSourceRevision } from './developer-dispatch.js'

import type { checkTaskDispatchReadiness } from './developer-dispatch.js'
import type { findOpenPrForBranch } from './developer-dispatch.js'
import type { fetchIssueTitle } from './developer-dispatch.js'
import type { createTaskWorktree } from './developer-dispatch.js'

import type { AgentVendor } from '../../dispatch/dispatch.js'
import type { ResumeRecord } from '../../dispatch/dispatch.js'

import type { LogSinkDeps } from '../../../../../../kernel/log/log-sink.js'
import type { IssueSurface } from '../../../../tools/task-contract/issue-validation'
import type { SecurityScanRun } from './reviewer-dispatch.js'

import type { ReconstructedJournal } from '../../../../tools/dev-review-policy/journal-reconstruction'
import type { readWorktreeHead } from './gate-reading.js'

import type { fetchDeveloperStop } from './developer-dispatch.js'
import type { fetchMergeableState } from './gate-reading.js'
import type { fetchConflictingFiles } from './gate-reading.js'
import type { gitCommitsTouchingDriverPaths } from './gate-reading.js'
import type { postMarkedComment } from '../../../../tools/task-contract/forge/forge-write.js'
import type { postPauseComment } from './pause-resume.js'
import type { postIssuePauseComment } from './pause-resume.js'
import type { publishRound } from './publication.js'
import type { DeferredFindingEntry } from '../../../../tools/task-contract/forge/forge-write.js'
import type { DeferredFindingsIssueRef } from '../../../../tools/task-contract/forge/forge-write.js'
import type { fetchPrBody } from './developer-dispatch.js'
import type { MergedDefaultCommit } from './git-defaults.js'
import type { DefaultTipClassification } from './git-defaults.js'
import type { RebaseOntoTipResult } from './git-defaults.js'
import type { MergeDefaultTipResult } from './git-defaults.js'
import type { CommitWorktreeResult } from './git-defaults.js'
import type { validatePrBodyForCreate } from '../../../../tools/pull-request/bin/pr.js'
import type { DevToolContext } from '../../../../../../kernel/tools/dev-tools-server.js'
import type { GrantedRole } from '../../../../integration/policies/roles.js'
import type { BridgeInvocation } from '../../../../../../kernel/tools/dev-tools-registration.js'
import type { FetchDocumentationDeps } from '../../../../../../kernel/tools/fetch-documentation.js'
import type { SourceProviderDeps } from '../../../../../../kernel/tools/source-provider.js'
import type { DevPullRequestView } from '../../../../../../kernel/tools/dev-tools-server.js'
import type { LiveRunner } from './live-check.js'
import type { LiveCheckoutPreparer } from './live-check.js'

// --- deps (injectable; every field defaults to the real implementation) -----

export type LoopDeps = {
  dispatchRole: typeof realDispatchRole
  resolveHead: typeof resolveHead
  /** The default branch's name, the parent of the task branch. */
  resolveParentBranch: typeof resolveParentBranch
  /**
   * The repository's review policy, read once per run from the default
   * branch's trust anchor — `reviewPolicyForLoop`, the fail-loud variant: a
   * FAILED read throws (after its own retry), which the setup-phase `try`
   * turns into a decided `pause(infrastructure)` rather than letting the loop
   * cast a verdict under the built-in default policy the gate would reject; a
   * missing/no-policy config resolves to the defaults. Injected so a test can
   * drive both paths without a real forge.
   */
  reviewPolicy: typeof reviewPolicyForLoop
  fetchCiConclusion: typeof fetchCiConclusion
  /** O3: named check-runs, never the review gate's own (excluded upstream). */
  fetchFailingCheckRuns: typeof fetchFailingCheckRuns
  /** The workflow runs behind a head's failed mechanical check runs, each read off the failed check run's own check suite — empty when none failed or none belongs to a workflow run. */
  fetchFailedCheckWorkflowRunIds: typeof fetchFailedCheckWorkflowRunIds
  /** Reruns one workflow run's failed jobs — a forge write under the driver's identity. Throws when the forge refuses it. */
  rerunFailedWorkflowJobs: typeof rerunFailedWorkflowJobs
  /** A failed check run's own job-log tail, sanitized and size-capped — the Operator's PR read's own reader (`readJobLogTail`), so a red-CI retry and `read_pull_request` can show the Developer what failed. Injected so the harness fakes it. */
  readFailedCheckLogTail: (jobId: number) => string | null
  fetchRulings: typeof fetchRulings
  /** The text of the one principal ruling a resolution's `authenticatedFrom` names (its pull request or Issue, and its ordinal) — what the pause-bound ruling slot's digest is taken over. */
  fetchRulingText: typeof fetchRulingText
  fetchNewestRulingOrdinal: typeof fetchNewestRulingOrdinal
  /** O2: the GitHub login that authored the newest principal ruling — a resolution record's `authenticatedBy`. */
  fetchNewestRulingAuthor: typeof fetchNewestRulingAuthor
  /** The newest principal ruling ordinal on the TASK ISSUE — the freshness baseline an escalation with no pull request records, since a ruling answering it can only be posted there. Its pull-request sibling above covers every other pause. */
  fetchNewestIssueRulingOrdinal: typeof fetchNewestIssueRulingOrdinal
  /** The principal rulings on the TASK ISSUE, and the newest one's author — what `--resume` reads for a pause recorded before any pull request existed and bound to one since (`escalationPrOf`), whose ruling was posted where its own comment went. */
  fetchIssueRulings: typeof fetchIssueRulings
  /** The TASK ISSUE's principal rulings posted after its newest frozen brief — what a Developer dispatch made before any pull request exists (and a resume of a pause bound to one since) carries. */
  fetchIssueRulingsAfterBrief: typeof fetchIssueRulingsAfterBrief
  fetchNewestIssueRulingAuthor: typeof fetchNewestIssueRulingAuthor
  fetchFrozenBrief: typeof fetchFrozenBrief
  resolveIssueObjectives: typeof resolveIssueObjectives
  /** O2: the frozen brief's own source revision, named to the reviewer as a fact. */
  fetchSourceRevision: typeof fetchSourceRevision
  /** `fetchTitle` replaces the Issue title read the derivation makes, so the caller keeps the title it read. */
  developerBranchFor: (issueNumber: number, fetchTitle?: (n: number) => string) => string
  /**
   * Runs the task's dispatch-readiness gate from this (unsandboxed) driver
   * process, before every Developer turn — `dispatchDeveloperOnce` calls
   * this and stages its result for the Developer to read rather than
   * re-running `check dispatch-readiness`/`verify-dispatch.ts` itself, where
   * either script's own `gh` call would hit the sandbox's denied forge-token
   * file (`isolation.md` §4a).
   */
  checkTaskDispatchReadiness: typeof checkTaskDispatchReadiness
  findOpenPrForBranch: typeof findOpenPrForBranch
  /** O3: the task Issue's own title — used verbatim as the pull request's title when the publication step opens it. */
  fetchIssueTitle: typeof fetchIssueTitle
  /**
   * O1: creates this task's own worktree (`.worktrees/<branch>`, cut from
   * `origin/main`'s tip; an existing one is reused, and moved to the default
   * tip with its remote branch when `branchHasTaskCommits` is `false`) and pushes
   * `branch` to the remote FROM that worktree with `-u` — the round-1
   * fresh-dispatch path calls it once, ONLY when the branch exists neither as
   * an open PR nor on the remote (O2 leaves an existing one untouched) —
   * BEFORE the first Developer dispatch, so the brief's own Step 0 can enter
   * the worktree rather than create it (`harness/processes/vinaya-strict/tools/task-contract/brief-render.ts`).
   * Never pushes from this process's own default-branch checkout (Traps to
   * avoid — that checkout's own pre-push hook judges `main`, not the task,
   * and refuses), and never force-pushes. Throwing is tolerated by the one
   * caller — logged, then the loop continues, since the Developer's own first
   * push creates the same remote branch later if this push failed; a failed
   * WORKTREE creation instead surfaces at the Developer's own Step 0, which
   * can no longer fall back to creating one itself.
   */
  createTaskWorktree: typeof createTaskWorktree
  /**
   * Creates `.worktrees/<branch>` from the branch already on the remote, at its
   * pushed head, tracking it — for a task continued on a machine with no
   * worktree. Never resets, rebases or pushes; throws when it cannot, or when an
   * existing local branch's head differs from the remote head.
   */
  createTaskWorktreeFromRemote: (branch: string) => void
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
   * server drain (`resolveVinayaLogAppendPath`). Used only to know
   * where to poll for an event's own line landing (`logEvents`, below) —
   * the loop never reads this file back for anything else, and never
   * flushes or otherwise publishes it: events reach the configured `logs`
   * destination live, as they are logged.
   */
  resolveLogAppendPath: (repo: { owner: string; repo: string } | null, issue: number) => string | Promise<string>
  /** Overrides for this run's own loop-event sink (`createVinayaLogSink`); absent, the sink's defaults. */
  logSink?: Partial<LogSinkDeps>
  repoRoot: () => string
  gitRevParseOriginMain: () => string
  /** True when `ancestor` is contained in `descendant`'s history. */
  gitIsAncestor: (ancestor: string, descendant: string) => boolean
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
  /**
   * O2: `git diff --unified=0 <from> <to>` between the previous round's head
   * and the current head — the raw diff `buildRoundDeferralContext` parses
   * into changed lines. `null` when git cannot answer (an unreachable sha, a
   * shallow clone, no git) — the caller then leaves the unchanged-line rule
   * inactive rather than guessing. Optional: a fixture that does not stub it
   * (`makeInProcessDeps` returns `null`) exercises the loop with the
   * unchanged-line rule off, exactly the round-1/no-previous-head behaviour.
   */
  gitUnifiedDiff?: (from: string, to: string) => string | null
  /**
   * O3: the task Issue's own `## Surface` `in:`/`out:` globs (`parseIssueSurface`),
   * or `null` when the Issue carries none or cannot be fetched — the
   * out-of-Surface rule is then inactive. Optional, for the same reason
   * `gitUnifiedDiff` is: a fixture that stubs neither runs with both deferral
   * rules off, the loop's pre-task behaviour.
   */
  resolveTaskSurface?: (task: number) => IssueSurface | null
  /**
   * The configured agent-config scanner argv, from
   * the default-branch trust anchor (`resolveSecurityScanCommand` +
   * `loadTrustAnchorConfig`). `null` when no `securityScan.command` is set —
   * the security pass is then told no scanner is configured. Optional, for the
   * same reason `gitUnifiedDiff`/`resolveTaskSurface` are: a fixture that stubs
   * none of the three scan deps runs the loop with no scan at all, the
   * pre-task shape.
   */
  resolveSecurityScanCommand?: () => readonly string[] | null
  /**
   * The pull request's changed paths (`base...head`),
   * for the scan's applicability decision. Absent leaves the changed-path list
   * empty, so a configured scanner reports `not_applicable` rather than
   * scanning paths the driver could not read.
   */
  gitChangedPaths?: (base: string, head: string) => readonly string[]
  /**
   * Runs the configured scanner over the head-verified
   * candidate copy with a constructed environment (no forge credential), a time
   * limit and an output cap (`defaultRunSecurityScanSubprocess`). A fixture
   * injects a fake here to exercise the scan path without spawning a process.
   */
  runSecurityScanSubprocess?: (command: readonly string[], cwd: string) => SecurityScanRun
  /**
   * O1/O2: the published doctrine — short version plus `## What you check` —
   * for the dispatched review role, resolved through the SAME override-aware
   * role plan `vinaya check --plan` renders (`resolveRoleDoctrineText`). The
   * reviewer prompt carries it as a fact piece. `null` when no doctrine can be
   * resolved (no bundled doctrine, the role absent from the plan) — the
   * dispatch then carries no doctrine block, the pre-task behaviour. Optional:
   * a fixture that does not stub it runs with no doctrine injected.
   */
  resolveReviewerDoctrine?: (role: 'reviewer' | 'security') => Promise<string | null>
  /**
   * O1: the developer role's published doctrine — its short
   * version plus its `## Stop conditions` and `## Verification before reporting
   * done` sections (the developer's checklist, Principal ruling) — resolved
   * through the SAME override-aware role plan `vinaya check --plan` renders
   * (`resolveDeveloperDoctrineText`). A fresh (non-resumed) developer session is
   * prepended this OUTSIDE the frozen brief, so the brief text and its
   * verdict-binding hash are untouched (O3). `null` when no doctrine can be
   * resolved — the dispatch then carries the brief alone, the pre-task shape.
   * Optional: a fixture that does not stub it runs with no doctrine prepended.
   */
  resolveDeveloperDoctrine?: () => Promise<string | null>
  /** The task's round journal, rebuilt from the pull request's principal-authored forge markers (developer round markers, the published summary) — never a log event, a flushed log comment or the telemetry outbox. */
  fetchLoopHistory: (prNumber: number | null) => ReconstructedJournal
  sleep: (ms: number) => Promise<void>
  now: () => number
  /**
   * The epoch-second a spent GitHub rate limit resets, read from `gh api
   * rate_limit` (which does not count against the limit); `null` when none is
   * reported (a secondary limit reports none) or the read fails. Optional: a
   * fixture that does not stub it waits the fixed fallback.
   */
  readRateLimitReset?: () => Promise<number | null>
  /**
   * Whether this host can reach GitHub at all right now — `true` once any
   * response comes back, whatever it says; `false` only for a connection
   * failure (`isGitHubConnectionFailure`). Read while the loop waits out a
   * connection failure. Optional: a fixture that does not stub it reads as
   * reachable.
   */
  isGitHubReachable?: () => Promise<boolean>
  /**
   * O1 (driver liveness): starts the driver's liveness heartbeat — a repeating timer
   * that fires `cb` every `intervalMs` while the process is alive, returning
   * a function that stops it. The production default is a real `setInterval`
   * whose handle is `.unref()`'d, so it NEVER keeps the process alive once
   * the loop's own work is done (Traps). Injected so a test drives the
   * callback on a fake clock, with no real timer and no five-minute wait.
   */
  setHeartbeat: (cb: () => void, intervalMs: number) => () => void
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
   * Runs the `VINAYA:EVIDENCE` report in-process and pushes it
   * onto `prNumber`'s live body, from `cwd` (the task's own worktree — see
   * `pr-report-engine.ts`'s module doc, "`cwd`"). The SAME engine function
   * `vinaya pr report --push` itself calls (`runReportForOpenPr`) — never a
   * `vinaya pr report --push` subprocess (Traps to avoid). `{ ok: false, reason }` on any
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
   * "Reviewers" in `harness/processes/vinaya-strict/loops/dev-review/loop.md`), so a signal arriving mid-round
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
  /**
   * issue-709, O2 — the loop's four forge-WRITE operations, injected so the
   * whole driver can run in-process against an in-memory world with no real
   * `gh`: the marked-comment poster (`postForgeEffectOnce`'s own poster
   * closures — the round marker and the unpushed-work-resume note), the two pause-comment posters (on the PR, and on
   * the Issue before a PR exists), and `publishRound`'s post-then-re-fetch
   * publication. Every production default is the real implementation
   * unchanged, so this changes nothing about a real run; a test's fake
   * records to its own world instead of shelling out. This is the one seam
   * this file gained for the in-process harness — documented in
   * `harness/processes/vinaya-strict/loops/dev-review/loop.md` § "The in-process test seam."
   */
  postMarkedComment: typeof postMarkedComment
  postPauseComment: typeof postPauseComment
  postIssuePauseComment: typeof postIssuePauseComment
  publishRound: typeof publishRound
  /**
   * Opens or updates the one backlog Issue per pull request that tracks the
   * findings this loop set aside rather than let block (O1, O2) — injected
   * like the four forge-writes above so an in-process run records the call
   * instead of shelling out to `gh`. Production default is the real
   * `upsertDeferredFindingsIssue`. Called from the publish step ONLY when a
   * round deferred something (O3: nothing deferred opens nothing).
   */
  writeDeferredFindingsIssue: (input: { prNumber: number; entries: DeferredFindingEntry[] }) => DeferredFindingsIssueRef
  /**
   * issue-709, O2 — the PR body read `checkPremiseAtHead` performs on every
   * round's gate check (a real `gh pr view <n> --json body`), injected for
   * the same reason as the writes above: an in-process run must not make a
   * real network `gh` call per round. Production default is the real
   * `fetchPrBody`. The `--resume` entry reads its PR body through this same
   * dependency, so a resumed run is in the in-process harness's scope too.
   */
  fetchPrBody: typeof fetchPrBody
  /**
   * issue-711 O1 — a commit's patch identity against the pull request's
   * base, `null` when git cannot answer (an unreachable commit, a fetch
   * failure — never read as "they match"). The SAME function
   * `check-review-gate.ts` wires into `checkReviewGate`'s own `patchIdOf`
   * (`patch-id.ts`'s `patchIdAt`), reused here rather than a second
   * implementation, so the loop's own patch tolerance and the merge gate's
   * agree by construction. This driver always judges against `main` — the
   * same base `gitRevParseOriginMain`/`defaultPullDefaultBranch` already
   * hardcode — never the PR's own (possibly different) `baseRefName`,
   * since the loop has no forge PR object in scope to read one from.
   */
  patchIdOf: (sha: string) => string | null
  /** O7: the worktree's current branch (`git rev-parse --abbrev-ref HEAD`), or `null` when unreadable — the publication step refuses to commit or publish from a worktree that is not on the task branch. */
  readWorktreeBranch: (worktreePath: string) => string | null
  /** O7: every path the worktree changed since `base` (committed AND uncommitted — `git diff --name-only <base>`), for the Surface check. Best-effort: `[]` when unreadable. */
  gitWorktreeChangedPaths: (worktreePath: string, base: string) => string[]
  /** The default branch's tip as the remote at `remoteUrl` reports it (never a local ref the Developer could move), or `null` when unreadable. */
  readDefaultBranchTip: (remoteUrl: string | null) => string | null
  /** The exact default-branch commit this turn merged into the worktree (an in-progress merge's incoming commit, else a merge commit's default-branch parent in `sinceBase..HEAD`), or `null` when the turn merged none. */
  readMergedDefaultCommit: (
    worktreePath: string,
    sinceBase: string | null,
    remoteUrl: string | null
  ) => MergedDefaultCommit | null
  /**
   * Sorts `paths` by how `head` relates to the default branch's `tip`:
   * `sameAsTip` when the path's content at `head` equals the tip's,
   * `mainDrift` when it equals the merge base of `head` and `tip` and differs
   * from the tip (the default branch changed it, the task did not), else
   * `taskChanged`. `null` when git cannot answer — never read as drift.
   */
  classifyAgainstDefaultTip: (
    worktreePath: string,
    head: string,
    tip: string,
    paths: readonly string[],
    remoteUrl: string | null
  ) => DefaultTipClassification | null
  /**
   * Rebases the worktree's own commits onto `tip` (`git rebase <tip>`). On a
   * conflict the rebase is aborted and the head checked back at its old value
   * before `{ ok: false }` returns the conflicting files; a worktree with
   * uncommitted tracked changes, or a range from the merge base to the head
   * holding a merge commit, is refused without rebasing.
   */
  rebaseOntoDefaultTip: (worktreePath: string, tip: string, remoteUrl: string | null) => RebaseOntoTipResult
  /** Merges the default branch's `tip` into the worktree's branch before a Developer turn (`defaultMergeDefaultTip`); a conflict is aborted. */
  mergeDefaultTip: (worktreePath: string, tip: string, remoteUrl: string | null) => MergeDefaultTipResult
  /**
   * Moves the worktree's branch back to `head` after the driver's own rebase
   * whose push did not land (`git reset --keep <head>`, which refuses rather
   * than discard an uncommitted change). `false` when the head is not back at
   * `head` afterwards.
   */
  restoreWorktreeHead: (worktreePath: string, head: string) => boolean
  /**
   * Pushes the task branch with `--force-with-lease` against
   * `expectedRemoteHead` — the remote head read before the publish — through
   * the Broker's `branch-lease-push` operation, authenticated like
   * `pushTaskBranch`. Only the driver's own publication calls it, after its
   * own rebase. `lease: true` marks a push git refused because the remote
   * branch is no longer at `expectedRemoteHead`.
   */
  pushTaskBranchWithLease: (
    input: Parameters<LoopDeps['pushTaskBranch']>[0] & { expectedRemoteHead: string }
  ) => { ok: true } | { ok: false; refusal: string; hook: boolean; lease: boolean }
  /** O1/O2: the worktree's own diff text since `base`, for the after-turn credential scan. `null` when unreadable. */
  gitWorktreeDiffText: (worktreePath: string, base: string) => string | null
  /** Builds this repository's vendored CLI before the driver's commit when its ignored bin is absent; ordinary adopters are a no-op. */
  buildVendoredCliIfMissing: (worktreePath: string) => void
  /** Installs the worktree's own dependencies before the Developer's first turn; a worktree with no `bun.lock` is a no-op, and a failure throws. */
  installWorktreeDependencies: (worktreePath: string) => void
  /**
   * O2: stages every change in the worktree and makes ONE commit under
   * `header`, returning the new HEAD sha. The commit runs the repository's
   * own `commit-msg`/`pre-commit` hooks exactly as a hand commit would —
   * never `--no-verify`. Injected so the in-process harness records a fake
   * commit instead of touching a real `.git`.
   */
  commitWorktree: (worktreePath: string, header: string) => CommitWorktreeResult
  /** The same aggregate body gates `vinaya pr create` runs, injected for fakes-based publication tests. */
  validatePrBodyForCreate: typeof validatePrBodyForCreate
  /**
   * O3/O4: pushes the task branch through the Broker's governed `branch-push`
   * operation, authenticated from the Developer's own launch record
   * (`authenticateWorkerInvocation`), so the push is authorized for this task
   * and recorded as an effect. `{ ok: true }` on a landed push; `{ ok: false,
   * refusal }` carrying the pre-push hook's own refusal text when the hook
   * refuses it (O4). Injected so the harness fakes the push against its
   * in-memory world.
   */
  pushTaskBranch: (input: {
    task: number
    branch: string
    sha: string
    touchedPaths: readonly string[]
    /** The task Issue's Surface — a protected administrative path in `touchedPaths` is accepted only when its `in:` globs cover it. */
    surface: IssueSurface | null
    round: number
    agent: AgentVendor
    repo: { owner: string; repo: string } | null
    worktreePath: string
  }) => { ok: true } | { ok: false; refusal: string; hook: boolean }
  /**
   * O3: opens the pull request through the Broker's governed `pr-open`
   * operation, authenticated the same way as `pushTaskBranch`, with `body` as
   * the Developer's body file and `title` the task Issue's title. Returns the
   * opened pull request's number, or `null` when the open could not be
   * confirmed. Injected so the harness fakes the open.
   */
  openTaskPullRequest: (input: {
    task: number
    branch: string
    title: string
    body: string
    round: number
    agent: AgentVendor
    repo: { owner: string; repo: string } | null
  }) => number | null
  /**
   * O2: start the driver-run dev-tools MCP host serving `context` on
   * `socketPath`, OUTSIDE the agent's sandbox, and return the bridge the
   * agent's own MCP client spawns to reach it plus a `close` for after the
   * turn. The real implementation listens on a unix socket
   * (`startDevToolsHost`); the harness fakes it — it returns a fake bridge and
   * a no-op close and drives the `context`'s tools directly, since no real
   * agent (hence no bridge) exists in-process. The ONE seam that keeps the
   * socket transport out of the harness while every gate in `context` stays
   * real (O5).
   */
  startDevTools: (input: {
    socketPath: string
    context: DevToolContext
    /** The dispatched role whose grant the host serves; absent, the Developer's. */
    role?: GrantedRole
  }) => Promise<{ bridge: BridgeInvocation; close: () => Promise<void> }>
  /** The `fetch_documentation` tool's name resolution and transport; absent, the real resolver and pinned TLS connection. Injected so a test fakes the network. */
  fetchDocumentationDeps?: FetchDocumentationDeps
  /** The source provider's git object reader for repository sources; absent, `git` in the task worktree. Injected so a test needs no repository. */
  readSourceObject?: SourceProviderDeps['readObject']
  /** O2/O3: replace the open PR's body — the `update_pull_request_body` tool's forge side effect (`gh api --method PATCH`). Injected so the harness fakes it. */
  updatePrBody: (input: {
    prNumber: number
    body: string
    repo: { owner: string; repo: string } | null
  }) => Promise<void>
  /** O2/O3: regenerate the PR body's Evidence block for the worktree's current head and write it back — the `refresh_evidence` tool's side effect. Injected so the harness fakes it. */
  refreshPrEvidence: (input: {
    worktreePath: string
    prNumber: number
    round: number
    repo: { owner: string; repo: string } | null
  }) => Promise<{ head: string; checksPassed: boolean; evidence: string }>
  /** O2/O3: the loop's view of the PR — state, checks, reviews, body, head — for the `read_pull_request` tool (`gh pr view --json`). Injected so the harness fakes it. */
  readPrView: (input: { branch: string; repo: { owner: string; repo: string } | null }) => Promise<DevPullRequestView>
  /** O2/O3: run `vinaya check --all` for the worktree's current head — the `run_checks` tool — with `env` (the pull request's body, number and branch, as CI passes them) added to the driver's own environment. Injected so the harness fakes it. */
  runWorktreeChecks: (
    worktreePath: string,
    env?: Record<string, string>
  ) => Promise<{ passed: boolean; output: string }>
  /** The live check's runner: one `[live]` Test plan command, run from this driver's own process and environment in the task worktree, stopped at the time bound (`live-check.ts`). Injected so a test runs no real command. */
  runLiveCommand: LiveRunner
  /** Whether this host holds a subscription sign-in for a vendor a `[live]` line names — reads where the login is kept, never calls the vendor. Injected so a test needs no real login. */
  liveVendorSignedIn: (vendor: AgentVendor) => boolean
  /** How long one `[live]` command may run before it reads as a red gate. */
  liveRunTimeoutMs: number
  /** Prepares the clean checkout of the approved head a live run uses — never the Developer's worktree (`live-check.ts`). Injected so a test creates no worktree. */
  prepareLiveCheckout: LiveCheckoutPreparer
}
