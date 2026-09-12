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
 *
 * `apps/cli/src/lib/dev-review-loop.ts` is the COMPOSITION ROOT
 * (task 8, `#506`, O8): the driver split into modules
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
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  assessRound,
  buildReviewInputManifest,
  compareManifest,
  initialLoopState,
  manifestAsEchoed,
  type Confidence,
  type Decision,
  type DevReviewLoopEventInput,
  type LoopConfig,
  type LoopState,
  type Observations,
  type ReviewInputManifest,
  type RoundStats
} from '@attalabs/aeg-core'
import {
  AGENT_VENDOR_NAMES,
  type AgentVendor,
  dispatchRole as realDispatchRole,
  type DispatchHandle,
  readResumeRecord as realReadResumeRecord,
  type ResumeRecord
} from './dispatch.js'
import { postMarkedComment } from './forge-write.js'
import { createLogSink, outboxPathFor } from './log-sink.js'
import { appendRunStartMarker, loopLogPathFor } from './loop-log.js'
import { flushOutbox as flushOutboxLib, LogFlushError } from './log-flush.js'
import { resolveRepo } from '@attalabs/aeg-forge-state'
import {
  fetchCiConclusion,
  fetchConflictingFiles,
  fetchFailingCheckNames,
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
  fetchNewestRulingOrdinal,
  fetchPrBody,
  fetchRulings,
  fetchSourceRevision,
  findOpenPrForBranch,
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
  outboxRoot,
  readIfExists,
  renderReviewerDispatchPrompt,
  type ReviewerPromptFacts,
  ReviewerInfrastructureFailure,
  ReviewerReportParseFailure,
  reviewerWorkDir,
  type RoundVerdictParse,
  writeHeldVerdict
} from './dev-review-loop/reviewer-dispatch.js'
import {
  assertDispatchOrEscalate,
  CONFIDENCE_FILE_NAME,
  CONFIDENCE_PROMPT_LINE,
  driverDecidedPauseEvents,
  MAX_GATE_STALLED_TURNS,
  parseConfidenceReply,
  parseShortstat,
  pollUntil,
  routeCompletionEvents,
  sizeOfSafe,
  waitForOwnLoopLine
} from './dev-review-loop/round-assess.js'
import { postForgeEffectOnce, publishRound } from './dev-review-loop/publication.js'
import {
  clearDriverLock,
  isDriverPidAlive,
  pauseMarker,
  type PauseState,
  postPauseComment,
  printDriverLockLine,
  readDriverLock,
  readPauseState,
  renderNoPushStopComment,
  writeDriverLock,
  writePauseState
} from './dev-review-loop/pause-resume.js'

// Re-exports — every name this file exported before the O8 split still
// resolves from this exact path, either defined below or re-exported from
// the module that now owns it (task 8, `#506`).
export {
  fetchCiConclusion,
  fetchConflictingFiles,
  fetchFailingCheckNames,
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
  outboxRoot,
  renderReviewerPrompt,
  ReviewerInfrastructureFailure,
  ReviewerReportParseFailure,
  writeHeldVerdict
} from './dev-review-loop/reviewer-dispatch.js'
export type { ReviewerPromptFacts } from './dev-review-loop/reviewer-dispatch.js'
export { publishRound } from './dev-review-loop/publication.js'
export type { PublishInput } from './dev-review-loop/publication.js'
export { renderNoPushStopComment, renderPauseComment } from './dev-review-loop/pause-resume.js'
export {
  CONFIDENCE_PROMPT_LINE,
  DevReviewLoopResumeError,
  parseConfidenceReply,
  routeCompletionEvents
} from './dev-review-loop/round-assess.js'

// --- deps (injectable; every field defaults to the real implementation) -----

export type LoopDeps = {
  dispatchRole: typeof realDispatchRole
  resolveHead: typeof resolveHead
  fetchCiConclusion: typeof fetchCiConclusion
  /** O3: named check-runs, never the review gate's own (excluded upstream). */
  fetchFailingCheckNames: typeof fetchFailingCheckNames
  fetchRulings: typeof fetchRulings
  fetchNewestRulingOrdinal: typeof fetchNewestRulingOrdinal
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
  flushOutbox: (task: number) => Promise<void>
  sleep: (ms: number) => Promise<void>
  now: () => number
  prPollMaxAttempts: number
  prPollIntervalMs: number
  gatePollMaxAttempts: number
  gatePollIntervalMs: number
  /** O2/O3: the developer's own worktree HEAD (`.worktrees/<branch>`), or `null` when unreadable/unknown. */
  readWorktreeHead: typeof readWorktreeHead
  /** O9: the newest developer-stop comment on the task Issue, or `null`. */
  fetchDeveloperStop: typeof fetchDeveloperStop
  /** O4/O5/O7: the forge's own mergeable state for a PR. */
  fetchMergeableState: typeof fetchMergeableState
  /** O4/O6: the conflicting file(s) between a head branch and the base. */
  fetchConflictingFiles: typeof fetchConflictingFiles
  /** O8: commits touching `DRIVER_OWNED_PATHS` between two base-branch shas. */
  gitCommitsTouchingDriverPaths: typeof gitCommitsTouchingDriverPaths
  /** O7 (task-run-v1 task 15): pulls the default branch in place. `{ok:true}` on success; `{ok:false, reason}` on any failure (merge conflict, network, detached HEAD) — never throws. */
  pullDefaultBranch: () => { ok: true } | { ok: false; reason: string }
  /** O7: re-execs this same process (same interpreter, same entry script) with `args` replacing the subcommand/flags, `stdio: 'inherit'`. Returns the child's exit code, or `null` when the spawn itself could not even start. Never throws. */
  reexecSelf: (args: string[]) => number | null
  /** O7: the driver's actual process-exit call, injected so a test can observe "the driver would hand off here" without killing the test process. Production default is the real `process.exit`. */
  exitProcess: (code: number) => never
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
 * Calls `flushOutbox` (`./log-flush.js`) in-process rather than spawning a
 * `vinaya log flush` subprocess (task 3, `#482`, O2) — a command calling a
 * command, via a child process, which `apps/cli/specs/surface.md`'s "the
 * rule" forbids. `flushOutbox` never calls `process.exit` (unlike the old
 * `logFlushCommand` it replaced here), so this driver's long-running,
 * multi-round process is never at risk of dying on a flush's own terminal
 * path; a thrown `LogFlushError` — or any other failure — is caught and
 * logged to stderr, never fatal to the loop (flush failures don't undo a
 * dispatch's own already-durable outbox lines).
 */
async function defaultFlushOutbox(task: number): Promise<void> {
  try {
    await flushOutboxLib({ issue: task })
  } catch (err) {
    const message = err instanceof LogFlushError || err instanceof Error ? err.message : String(err)
    process.stderr.write(
      `vinaya dev-review-loop: round-end flush failed (non-fatal, lines stay in the outbox for a later flush): ${message}\n`
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

function defaultDeps(): LoopDeps {
  return {
    dispatchRole: realDispatchRole,
    resolveHead,
    fetchCiConclusion,
    fetchFailingCheckNames,
    fetchRulings,
    fetchNewestRulingOrdinal,
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
    fetchDeveloperStop,
    fetchMergeableState,
    fetchConflictingFiles,
    gitCommitsTouchingDriverPaths,
    pullDefaultBranch: defaultPullDefaultBranch,
    reexecSelf: defaultReexecSelf,
    exitProcess: (code) => process.exit(code)
  }
}

// --- the loop -----------------------------------------------------------------

export type LoopInput = { agent: AgentVendor } & ({ task: number } | { resumePr: number })
export type LoopResult = { finalDecision: Decision; prNumber: number; task: number }

export async function devReviewLoop(input: LoopInput, deps: Partial<LoopDeps> = {}): Promise<LoopResult> {
  const d: LoopDeps = { ...defaultDeps(), ...deps }
  const root = d.outboxRoot()

  let task: number
  let branch: string
  let prNumber = -1 // resolved below, before any use — never read while -1
  let resumeFrom: PauseState | null = null
  /** O8 (task-run-v1 task 15): true when `--resume` found the head already moved past the pause-time head — a ruling followed by a fix push, the normal case. Widens `firstPass` below so the loop skips redispatching the developer (it already acted) and goes straight to the gate/reviewer path on the new head. */
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
    const rulings = d.fetchRulings(resumePr)
    if (rulings.length === 0) {
      throw new Error(
        `devReviewLoop --resume: PR #${resumePr} carries no Principal ruling comment yet — nothing to resume from.`
      )
    }
    const currentHead = d.resolveHead(held.branch)
    // O8: a moved head is accepted, never refused, once a ruling exists —
    // "a ruling followed by a fix push is the normal case." The ruling is
    // itself the round-cap override it declares: the round counter
    // restarts at the ruling's own newest ordinal (`fetchNewestRulingOrdinal`,
    // the same integer `ruling_posted` mid-round invalidation already reads)
    // rather than continuing from `held.round`, which may already sit past
    // `MAX_ROUNDS` and would otherwise re-trigger the very pause this
    // `--resume` exists to lift.
    resumeHeadAlreadyMoved = currentHead !== held.head
    task = held.task
    branch = held.branch
    prNumber = held.prNumber
    resumeFrom = resumeHeadAlreadyMoved ? { ...held, round: d.fetchNewestRulingOrdinal(resumePr) } : held
  } else {
    task = input.task
    branch = d.developerBranchFor(task)
  }

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

  try {
    return await runDevReviewLoopBody()
  } finally {
    clearDriverLock(root, task)
  }

  async function runDevReviewLoopBody(): Promise<LoopResult> {
    const { log, runId } = createLogSink()
    if (!process.env.VINAYA_RUN_ID) process.env.VINAYA_RUN_ID = runId
    // `buildHeader` derives `subject.issue` (and thus the outbox file this
    // loop's OWN `log()` calls land in) purely from `env.VINAYA_TASK`
    // (`envelope.ts`'s `issueFromTask`) — never self-declared. `dispatchRole`
    // sets it on each CHILD's env already; this driver's own top-level events
    // (`loop_started`, `round_started`, …) need it on THIS process's env too,
    // or they land under the `none` bucket instead of this task's.
    process.env.VINAYA_TASK = String(task)

    // Which severities block is repository policy (task
    // 8, `#506`, O1/O4) — resolved once, from the default branch, and reused
    // for every round's derivation and this run's publication self-check;
    // the gate reads the identical source (`check-review-gate.ts`).
    const policy = reviewPolicy()

    // Primes `resolveRepo()`'s process-lifetime cache BEFORE this loop's own
    // `log()` calls start racing each other on it (see `waitForLoopLineCount`'s
    // doc comment) — every later call in this process, including the ones
    // inside `log()` itself, resolves the identical value instantly.
    const repo = await resolveRepo().catch(() => null)
    const repoRoot = d.repoRoot()
    const confidenceFilePath = join(repoRoot, '.worktrees', branch, CONFIDENCE_FILE_NAME)
    /** O8: recorded once, at loop start — never re-derived. Re-read at every round entry (top of the `while(true)` below) and compared against this fixed watermark for commits touching `DRIVER_OWNED_PATHS`. */
    const baseHeadAtStart = d.gitRevParseOriginMain()
    const loopOutboxPath = outboxPathFor({ outboxRoot: () => root }, repo, task)
    /**
     * O6: the one file this run's own role-prefixed stream tees to,
     * regardless of where it was launched — `vinaya task status --follow`
     * tails it live. Resolved once, from the same `repo`/`task` every other
     * per-run path here already uses; the run-start marker delineates this
     * process's own narration from an earlier relaunch's still-appended one.
     */
    const loopLogPath = loopLogPathFor(repo, task)
    appendRunStartMarker(loopLogPath, { role: 'dev-review-loop', pid: process.pid, runId })
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
    /** O4/O6: the conflicting file(s) from the last mergeability read, consumed by the very next `dispatch_developer` prompt, then cleared — never a CI-red retry (never sets `pendingGateRedRetry`), so the head-change-wait that follows always re-checks the gate fresh rather than replaying `lastFailingChecks`. */
    let pendingConflictFiles: string[] | null = null

    async function dispatchDeveloper(prompt: string, roundNum: number): Promise<DispatchHandle> {
      const isResume = devResumeId !== null
      const handle = await withPromptFile(prompt, (promptFile) =>
        d.dispatchRole('developer', input.agent, prompt, {
          task: task,
          round: roundNum,
          resumeId: devResumeId ?? undefined,
          promptFile,
          roleLogPath: loopLogPath
        })
      )
      await assertDispatchOrEscalate(handle, input.agent, isResume, devDispatchSucceededBefore)
      if (!handle.failureReason) {
        devDispatchSucceededBefore = true
        if (handle.resumeId) devResumeId = handle.resumeId
      }
      return handle
    }

    /** O2/O3: the developer's own worktree convention (`aeg-root/roles/developer.md`) — `.worktrees/<branch>` under this repo's root, the SAME path `confidenceFilePath` above already derives its own parent from. */
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

    /** O4/O6: the loop's own conflict prompt — names the conflicting file(s) so the developer does not have to re-derive mergeability itself. */
    function renderConflictPrompt(files: readonly string[]): string {
      const fileList =
        files.length > 0 ? files.map((f) => `- ${f}`).join('\n') : '(no specific file could be determined)'
      return [
        'This branch is behind the base in a way that conflicts — it cannot merge as-is.',
        'Merge or rebase the base and resolve before pushing again, per aeg-root/roles/developer.md. Conflicting file(s):',
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

        // O2: resume once, foreground — this single resume's own prompt
        // covers both the missing push and (since it also asks for the
        // open) the common case where the PR was never opened either.
        const rec = d.readResumeRecord(task, input.agent, repo)
        if (rec) devResumeId = rec.resumeId
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
      // crash-recovery path) but the PR is still missing: resume once to
      // open it, then poll.
      const rec = d.readResumeRecord(task, input.agent, repo)
      if (rec) devResumeId = rec.resumeId
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
      let lastParseFailure: ReviewerReportParseFailure | null = null
      for (let attempt = 1; attempt <= 2; attempt++) {
        const workDir = reviewerWorkDir(root, task, roundNum, role, attempt)
        mkdirSync(workDir, { recursive: true })
        const prompt = renderReviewerDispatchPrompt(role, facts, workDir)
        const handle = await withPromptFile(prompt, (promptFile) =>
          d.dispatchRole(dispatchRoleName, input.agent, prompt, {
            task: task,
            round: roundNum,
            promptFile,
            roleLogPath: loopLogPath
          })
        )
        await assertDispatchOrEscalate(handle, input.agent, false, false)
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
          return buildVerdictFromReport(
            role,
            workDir,
            input.agent,
            task,
            handle,
            facts.manifest,
            policy,
            facts.resolvedObjectives
          )
        } catch (err) {
          if (!(err instanceof ReviewerReportParseFailure)) throw err
          lastParseFailure = err
          lastMissing = []
        }
      }
      if (lastParseFailure) throw lastParseFailure
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

    /** O4/O5/O7: the forge's own mergeable state, polled off `UNKNOWN` within the existing gate poll budget — never read as clean and never as conflicting (O7). A budget exhaustion is treated as `CONFLICTING`, never as clean: this gates a reviewer dispatch or a publish, and silently proceeding on an unresolved answer is the one failure mode O4/O5 exist to prevent. */
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
    let decision: Decision = { type: 'dispatch_developer' }
    // O8: `resumeHeadAlreadyMoved` widens this exactly like a fresh round-1
    // attach — the developer already pushed the fix a ruling asked for, so
    // this run dispatches no developer at all and goes straight to the
    // gate/reviewer path below, on the head that's already there.
    let firstPass = !resumeFrom || resumeHeadAlreadyMoved
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
        // next, unmodified, straight off `firstPass` — UNLESS O4 (below)
        // recovers a real round from held state.
        prNumber = existingPr.number
        const rec = d.readResumeRecord(task, input.agent, repo)
        if (rec) devResumeId = rec.resumeId

        // O4 (task 3, `#482`): a prior process may have
        // dispatched round k's reviewers, held REQUEST-CHANGES verdicts on
        // disk, and dispatched the developer — then crashed or was
        // restarted before ever observing whether the developer pushed a
        // fix. Left alone, `round` stays at its default of 1 and this
        // attach would re-run round 1's OWN gate check on a head that may
        // be several real rounds deep (Origin: PR #529 — every attach
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
            const marker = join(root, 'dev-review-loop', String(task), `round-${held.round}-attach-redelivered`)
            if (existsSync(marker)) {
              const stats = computeStats(currentHead, d.now())
              await logEvents(driverDecidedPauseEvents(config.loopId, state, held.round + 1, stats))
              decision = {
                type: 'pause',
                reason: 'no_progress',
                detail: `round ${held.round} findings delivered again on unchanged head ${currentHead}, with no developer push since the first delivery`
              }
            } else {
              mkdirSync(dirname(marker), { recursive: true })
              writeFileSync(marker, new Date().toISOString(), 'utf8')
              round = held.round + 1
              lastReviewContext = held.rendered
              firstPass = false
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
          await dispatchDeveloper(brief, round)

          try {
            prNumber = await afterDeveloperTurnBeforePrPoll(false)
          } catch (err) {
            if (!(err instanceof DeveloperStopSignal)) throw err
            // O9: no branch ever reached the remote, and the developer
            // posted a refusal/escalation instead — end the loop now, on the
            // Issue (there is no PR to comment on), never entering the poll.
            postForgeEffectOnce(root, task, `no-push-stop-${round}`, () =>
              postMarkedComment(
                'issue',
                String(task),
                pauseMarker('escalation'),
                renderNoPushStopComment(task, err.detail)
              )
            )
            await d.flushOutbox(task)
            return { finalDecision: { type: 'pause', reason: 'escalation', detail: err.detail }, prNumber: 0, task }
          }
        }
      }
    }

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
     */
    async function checkStaleDriver(): Promise<boolean> {
      const currentBaseHead = d.gitRevParseOriginMain()
      if (currentBaseHead === baseHeadAtStart) return false
      const touching = d.gitCommitsTouchingDriverPaths(baseHeadAtStart, currentBaseHead)
      if (touching.length === 0) return false

      // O7 (task-run-v1 task 15): a moved base costs a restart, never a
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
        const reexecArgs =
          'resumePr' in input
            ? ['dev-review-loop', '--resume', String(input.resumePr), '--agent', input.agent]
            : ['dev-review-loop', '--task', String(task), '--agent', input.agent]
        const exitCode = d.reexecSelf(reexecArgs)
        if (exitCode !== null) {
          d.exitProcess(exitCode)
        }
        reexecFailureNote = `re-exec of \`vinaya ${reexecArgs.join(' ')}\` could not even start after pulling the updated base`
      } else {
        reexecFailureNote = `could not pull the default branch to re-exec from: ${pulled.reason}`
      }

      const head = d.resolveHead(branch)
      const stats = computeStats(head, roundStartMs)
      const detail = `base moved from ${baseHeadAtStart} to ${currentBaseHead}, touching this driver's own code (${touching.join('; ')}) — ${reexecFailureNote}`
      await logEvents(driverDecidedPauseEvents(config.loopId, state, round, stats))
      decision = { type: 'pause', reason: 'stale_driver', detail }
      await d.flushOutbox(task)
      return true
    }

    // eslint-disable-next-line no-constant-condition
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
        // `packages/aeg-core`, out of this task's declared Surface, Issue
        // #488 §4) is true exactly when THIS dispatch is the driver sending
        // the developer back for a red mechanical gate — the one case that
        // needs the head-change wait (Traps: never re-read the gate in a
        // tight loop on an unchanged head — `#479`'s own five-re-dispatches-
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
          const prompt = [
            conflictFiles !== null
              ? renderConflictPrompt(conflictFiles)
              : resumedDispatch
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
          const headBeforeDispatch = isGateRedRetry || conflictFiles !== null ? d.resolveHead(branch) : null
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
              const detail =
                conflictFiles !== null
                  ? `head ${headBeforeDispatch} unchanged after dispatch; conflict never resolved (file(s): ${
                      conflictFiles.length > 0 ? conflictFiles.join(', ') : '(unknown)'
                    })`
                  : `head ${headBeforeDispatch} unchanged after dispatch; failing check-run(s): ${
                      lastFailingChecks.length > 0 ? lastFailingChecks.join(', ') : '(unknown)'
                    }`
              if (gateStalledStreak < MAX_GATE_STALLED_TURNS) {
                await d.flushOutbox(task)
                continue
              }
              await logEvents(driverDecidedPauseEvents(config.loopId, state, round, stats))
              decision = { type: 'pause', reason: 'infrastructure', detail }
              await d.flushOutbox(task)
              continue
            }
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
          await d.flushOutbox(task)
          continue
        }
        pendingConflictFiles = null

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
        await d.flushOutbox(task)
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
        await d.flushOutbox(task)
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
          await d.flushOutbox(task)
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
        const manifest: ReviewInputManifest = buildReviewInputManifest({
          headSha: head,
          briefContent: briefContentAtDispatch,
          objectivesVersion: resolvedObjectives.version,
          rulingOrdinal,
          policy
        })
        const facts: ReviewerPromptFacts = {
          objectives: resolvedObjectives.text,
          resolvedObjectives: resolvedObjectives.objectives,
          rulings,
          ciConclusion,
          revision,
          manifest
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
          if (!(err instanceof ReviewerInfrastructureFailure) && !(err instanceof ReviewerReportParseFailure)) throw err
          const stats = computeStats(head, roundStartMs)
          await logEvents(driverDecidedPauseEvents(config.loopId, state, round, stats))
          decision = { type: 'pause', reason: 'infrastructure', detail: err.message }
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
          // second, hand-rolled inequality check per field (task 4, `#478`,
          // O2): the echo here is simply `facts.manifest` itself, never a
          // round-trip through the rendered text (Traps to avoid — nothing
          // to trust or distrust when the value is this driver's own, still
          // in memory).
          const reassessedObjectives = d.resolveIssueObjectives(task)
          const reassessedRulingOrdinal = d.fetchNewestRulingOrdinal(prNumber)
          const reassessedBriefContent = d.fetchFrozenBrief(task)
          const currentManifest: ReviewInputManifest = buildReviewInputManifest({
            headSha: head,
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
            await d.flushOutbox(task)
          } else if (!binding.rulingOrdinal) {
            const detail = `a new ruling landed between reviewer dispatch and assessment — ruling ordinal moved from ${facts.manifest.rulingOrdinal} to ${reassessedRulingOrdinal} — superseded by ruling ${prNumber}-${reassessedRulingOrdinal}`
            const stats = computeStats(head, roundStartMs)
            await logEvents(driverDecidedPauseEvents(config.loopId, state, round, stats))
            decision = { type: 'pause', reason: 'ruling_posted', detail }
            await d.flushOutbox(task)
          } else if (!binding.briefHash) {
            const detail = `the frozen brief was superseded between reviewer dispatch and assessment — brief hash moved from ${facts.manifest.briefHash ?? 'none'} to ${currentManifest.briefHash ?? 'none'}`
            const stats = computeStats(head, roundStartMs)
            await logEvents(driverDecidedPauseEvents(config.loopId, state, round, stats))
            decision = { type: 'pause', reason: 'brief_superseded', detail }
            await d.flushOutbox(task)
          } else if (!binding.policyDigest) {
            const detail = `the review policy changed between reviewer dispatch and assessment — policy digest moved from ${facts.manifest.policyDigest} to ${currentManifest.policyDigest}`
            const stats = computeStats(head, roundStartMs)
            await logEvents(driverDecidedPauseEvents(config.loopId, state, round, stats))
            decision = { type: 'pause', reason: 'policy_changed', detail }
            await d.flushOutbox(task)
          } else {
            const [reviewer, security] = verdicts
            // Both roles genuinely finished (`Promise.all` did not reject) —
            // only now is it safe to hold either verdict on disk (O2's "nothing
            // is held … for that round" invariant; see `dispatchReviewer`'s doc
            // comment, above).
            writeHeldVerdict(root, task, round, 'reviewer', reviewer.rendered)
            writeHeldVerdict(root, task, round, 'security', security.rendered)
            lastReviewContext = `${reviewer.rendered}\n\n---\n\n${security.rendered}`

            const obs: Observations = {
              kind: 'verdicts',
              round,
              verdicts: [reviewer.observation, security.observation]
            }
            const result = assessRound(state, obs)
            state = result.state
            decision = result.decision
            const routed = routeCompletionEvents(result.events, decision.type)
            pendingCompletionEvents = routed.toDeferUntilPublish
            await logEvents(routed.toLogNow)
            await d.flushOutbox(task)
            if (decision.type === 'dispatch_developer') round += 1
          }
        } else {
          await d.flushOutbox(task)
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
          await d.flushOutbox(task)
          continue
        }
        pendingConflictFiles = null

        // O8 (round 2 review, BLOCKER): re-check staleness here too — a
        // clean `dispatch_reviewers` → `publish` transition reaches this
        // point in the SAME iteration, with no loop-back to the top in
        // between, so the top-of-loop check alone never catches a base that
        // moved past this driver's own code while reviewers were working.
        if (await checkStaleDriver()) {
          await d.flushOutbox(task)
          continue
        }

        publishRound(root, {
          task,
          round,
          prNumber,
          expectedHead: d.resolveHead(branch),
          journal: { rounds: state.rounds },
          policy
        })
        // Only now — posts confirmed, not merely attempted — does the durable
        // log get to say this run completed. A throw above (a post that
        // failed, or re-parsed dirty) skips this entirely, so the log never
        // claims `merged_ready` for a run that did not actually finish.
        await logEvents(pendingCompletionEvents)
        await d.flushOutbox(task)
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
        await d.flushOutbox(task)
        return { finalDecision: decision, prNumber, task }
      }
    }
  }
}

export const DEV_REVIEW_LOOP_AGENTS = AGENT_VENDOR_NAMES
