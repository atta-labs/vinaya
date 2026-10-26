import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  assessRound,
  parseLiveTestPlanItems,
  readLiveRecord,
  recordDeveloperAttempt,
  withLiveRecord,
  type Confidence,
  type DevReviewLoopEventInput,
  type LoopState,
  type Observations,
  type PauseReason,
  type ReviewInputManifest,
  type RoundStats,
  type TaskClock,
  type VerdictObservation
} from '@attalabs/aeg-core'
import type { RoleBinaryConfig, StepNodeResult } from '@atta/executor-agent-spawn'
import { generateClaudeSettings } from '../../../harness/adapters/agents/claude-code/settings'
import { generateCodexConfig } from '../../../harness/adapters/agents/codex/config'
import { loadRoleGrants, ROLE_NAMES, withModel } from '../../../harness/adapters/agents/manifest'
import { sessionIdOf, structuredResult } from '../../../harness/adapters/agents/structured-result'
import { pullRequestCheckEnv, type PullRequestView } from './pull-request-env'
import type { Handoff, InputVersions, PauseRequest } from './handoff'
import type { StagedPullRequest, V2Functions } from '../loops/dev-review/v2/v2-actions'
import { runCliChecks } from '../../../harness/gates/run-checks'
import { agentEnvAllowlist } from '../../../harness/adapters/agents/launch-env'
import type { GeneratedAgentConfig, GeneratorPaths } from '../../../harness/adapters/agents/policy'
import {
  createRoleLauncher,
  type ActionContext,
  type ActionRegistry,
  type DecisionRegistry,
  type ProcessAction,
  type RoleLauncher
} from '../../../harness/dev-process/engine-runtime/run-process'
import {
  checkTaskDispatchReadiness,
  createTaskWorktree,
  fetchSourceRevision,
  findOpenPrForBranch,
  findOpenPrForBranchStrict,
  type reviewPolicyForLoop
} from '../../../apps/cli/src/lib/dev-review-loop/developer-dispatch'
import {
  developerRoundMarker,
  DispatchSandboxRefused,
  driverDecidedPauseEvents,
  MAX_GATE_STALLED_TURNS,
  pollUntil,
  renderDeveloperRoundComment
} from '../../../apps/cli/src/lib/dev-review-loop/round-assess'
import { cleanupAllReviewerIsolationArtifacts } from '../../../apps/cli/src/lib/dev-review-loop/reviewer-isolation'
import {
  DeveloperTurnResultPause,
  normalizeSourceIdentity,
  PERMISSIBLE_RULING_DECISIONS,
  pauseForAcceptedResult
} from '../../../apps/cli/src/lib/dev-review-loop/turn-result'
import {
  describeInactiveControls,
  enforcementControlsActive,
  type EnforcementControl
} from '../../../apps/cli/src/lib/enforcement-controls'
import { realLocalGateControl } from '../../../apps/cli/src/lib/local-gate-control'
import {
  countedSourceIds,
  readSourceDeliveryReceipts,
  sourceReceiptsPath,
  sourceStoreDir
} from '../../../apps/cli/src/lib/source-manifest'
import {
  prepareSources,
  RequiredSourcesUnavailable,
  type PrepareSourcesResult
} from '../../../apps/cli/src/lib/source-provider'
import { probeAgentSandbox, type SandboxProbePlan } from '../../../apps/cli/src/lib/worker-boundary'
import { ensureRunDir, runPath } from '../../../apps/cli/src/lib/run-paths'
import {
  postForgeEffectOnce,
  publishRound,
  type PublishInput
} from '../../../apps/cli/src/lib/dev-review-loop/publication'
import {
  defaultDeps,
  defaultRunSecurityScanSubprocess,
  defaultUpdatePrBody,
  deferredEntriesForRound,
  deriveVerdictPauseDetail,
  describeConfidencePauseDetail,
  handoffFindings
} from '../../../apps/cli/src/lib/dev-review-loop'
import { loadTrustAnchorConfig } from '../../../apps/cli/src/lib/config'
import {
  checkPremiseAtHead,
  describeFailingCheckRun,
  fetchCiConclusion,
  fetchConflictingFiles,
  fetchFailedCheckWorkflowRunIds,
  fetchFailingCheckRuns,
  fetchMergeableState,
  pollMergeableState,
  readWorktreeHead,
  rerunFailedWorkflowJobs,
  type GatePoll
} from '../../../apps/cli/src/lib/dev-review-loop/gate-reading'
import {
  buildManifestRecord,
  decideSecurityScan,
  discardHeldVerdicts,
  persistManifestRecord,
  ReviewerInfrastructureFailure,
  ReviewerResultRejected,
  writeHeldVerdict,
  type RoundVerdictParse,
  type SecurityScanOutcome,
  type SecurityScanRun
} from '../../../apps/cli/src/lib/dev-review-loop/reviewer-dispatch'
import {
  noPushPauseDetail,
  readUnpushedWorkDetail,
  unpushedFailureMessage,
  unpushedWorkResumeDetail,
  type UnpushedWork
} from '../../../apps/cli/src/lib/dev-review-loop/unpushed-work'
import {
  LIVE_RUN_TIMEOUT_MS,
  livePassedAtHead,
  liveVendorsNamed,
  prepareRealLiveCheckout,
  renderLiveWithdrawal,
  runLiveChecks,
  runRealLiveCommand,
  vendorSignedIn,
  withdrawApprovedRound,
  type LiveCheckoutPreparer,
  type LiveFailure,
  type LiveRunner
} from '../../../apps/cli/src/lib/dev-review-loop/live-check'
import { routeCompletionEvents } from '../../../apps/cli/src/lib/dev-review-loop/round-assess'
import { resolveTrustAnchorSecurityScanCommand } from '../../../apps/cli/src/lib/dev-review-loop/security-scan-command'
import { fetchPrBody } from '../../../apps/cli/src/lib/dev-review-loop/developer-dispatch'
import {
  postMarkedComment,
  upsertDeferredFindingsIssue,
  type DeferredFindingEntry,
  type DeferredFindingsIssueRef
} from '../../../apps/cli/src/lib/forge-write'
import {
  validateDeveloperTurnResult,
  type DeveloperTurnResult,
  type DeveloperTurnSchemaContext
} from '../../../apps/cli/src/lib/developer-turn-result'
import {
  classifyReviewOutcome,
  manifestDigest,
  parseReviewResult,
  reviewBlockerNeedsRuling,
  type ReviewResult,
  type ReviewRunFacts
} from '../../../apps/cli/src/lib/review-result'

// The mechanical actions, decisions and role launchers of the developer
// review Flow. Each action adapts one function the review loop already
// has; the adaptation here is only argument and result shaping, exercised
// with stubs. Every round outcome is the shared assessment's (`assessRound`):
// an action builds the observation, records the decision the assessment
// returned, and its exit code only routes on it.

/** One objective as the round's reviewers were dispatched against it. */
export interface DispatchedObjective {
  id: string
  text: string
}

/** What one round's reviewers are dispatched against: the review-input manifest snapshot and the objectives it versions. */
export interface ReviewRoundInputs {
  manifest: ReviewInputManifest
  objectives: readonly DispatchedObjective[]
  /** The objectives as the reviewer prompt renders them, read with the rest of the snapshot. */
  objectivesText?: string
}

/** What the bound functions need that the recorded step results cannot supply. */
export interface TaskInput {
  /** The runtime directory run files go under (`<runtimeDir>/tasks-execution/<task>/…`), never the repository. */
  runtimeDir: string
  /** The CLI entry script whose `check --all` the gate step runs. */
  cliEntry: string
  branch: string
  issueNumber: number
  worktreePath: string
  developerContext: DeveloperTurnSchemaContext
  /** The loop state the first assessment starts from; later ones start from the newest state a deciding step recorded. */
  loopState: LoopState
  clock?: TaskClock
  /** The round's review round number, as `handoffFindings` counts it. */
  reviewRound: () => number
  /** Moves the review round forward to `round` (never back), for a run that continues rounds the forge already holds. */
  seedRound?: (round: number) => void
  /** The review-input manifest of the task head as it stands now, or null when it cannot be built. */
  currentManifest?: () => ReviewInputManifest | null
  /** The command of the objectives edit that moved the objectives, or null when no edit can be found. */
  objectivesEdit?: () => string | null
  /**
   * The round's review inputs, taken once when its reviewers are dispatched: the manifest snapshot every reviewer
   * prompt, held verdict and publication of the round reads, persisted best-effort to the control store.
   */
  reviewInputs?: (round: number) => ReviewRoundInputs
  /**
   * The reviewer prompt for `role`, built over this round's staged candidate and the security-scan step's
   * recorded outcome (absent in stub runs).
   */
  reviewerPrompt?: (
    role: 'reviewer' | 'security',
    results: Readonly<Record<string, StepNodeResult>>
  ) => string | Promise<string>
  /** The scratch directory prepared by the prompt for this role's current attempt. */
  reviewerWorkingDirectory?: (role: 'reviewer' | 'security') => string | null
  /** The round's staged, head-verified candidate copy the security scan runs over, or null when none could be staged. */
  candidateDir?: () => string | null
  /** The task's frozen brief, whose `[live]` Test Plan lines the live-check step runs. */
  frozenBrief?: () => string
  /** The reviewers' verdicts for the round, read from the recorded results; advances the round. */
  verdicts: (results: Readonly<Record<string, StepNodeResult>>) => readonly VerdictObservation[]
  /**
   * The `publishRound` input for the pull request and judged head found when the step runs: the
   * pull request does not exist when the task starts, and the head moves with every revision.
   */
  publish: (at: PublishTarget) => PublishInput
  /** One reviewer's accepted result as the round's verdict observation and the comment held for publication; throws `ReviewerResultRejected` for a result no rule accepts. */
  buildVerdict: (
    role: HeldVerdictRole,
    review: ReviewResult,
    inputs: ReviewRoundInputs,
    sessionId?: string
  ) => RoundVerdictParse
  /** The branch's head on the remote, or null when it cannot be read. */
  remoteHead?: () => string | null
  /** The task worktree's unpushed work (`readUnpushedWorkDetail`); the worktree itself is read when absent. */
  readUnpushedWork?: () => UnpushedWork
  /** The refusal the Developer's last publication in this turn met, or null when none is pending. */
  publicationRefusal?: () => string | null
  /** Replacements for the forge and filesystem functions the actions call, for a run that must not reach them. */
  bound?: Partial<BoundFunctions>
  /** The one function every pausing exit calls; the runner supplies it, bound to its run control. */
  handoff?: Handoff
  /** The brief, objectives, ruling and policy versions an escalation record binds its ruling to; throws when they cannot be read. */
  inputVersions?: () => InputVersions
  /** The repository root the local enforcement controls are read from and a live-check checkout is cut from; the working directory when absent. */
  repoRoot?: string
  /** Reads the review policy, throwing when it cannot be read; absent for a run with no policy to read. */
  reviewPolicy?: () => ReturnType<typeof reviewPolicyForLoop>
  /** The plan that proves the Developer's agent sandbox runs a command, or null when the run launches no sandboxed agent. */
  sandboxPlan?: () => SandboxProbePlan | null
  /** Prepares the task's required Documentation sources into the controller-owned store; absent for a run with no sources to prepare. */
  prepareSources?: () => Promise<PrepareSourcesResult>
  /** The budget the forge-gate steps poll a pending CI read or an unresolved mergeability within; the standalone loop's own when absent. */
  gatePoll?: GatePoll
  /** The flow key the run chose (`v1`, `v2`); absent is version 1. */
  flow?: string
  /** Version 2: the pull request the Developer staged, which opens only once both reviewers approve. */
  stagedPullRequest?: () => StagedPullRequest | null
  /** Version 2's forge and process functions (`v2-actions.ts`). */
  v2?: V2Functions
}

/** What only the moment of publication knows. */
export interface PublishTarget {
  prNumber: number
  expectedHead: string
  round: number
  /** The manifest snapshot the round's reviewers were dispatched against; absent when no dispatch is recorded. */
  manifest?: ReviewInputManifest
}

export type HeldVerdictRole = 'reviewer' | 'security'

/** The functions whose results depend on state that changes during the run. */
export interface BoundFunctions {
  checkTaskDispatchReadiness: typeof checkTaskDispatchReadiness
  createTaskWorktree: typeof createTaskWorktree
  fetchSourceRevision: typeof fetchSourceRevision
  /** Reads the branch's pull request for the checks' environment (`pullRequestCheckEnv`). */
  pullRequestView: (branch: string) => PullRequestView
  findOpenPrForBranch: typeof findOpenPrForBranch
  readWorktreeHead: typeof readWorktreeHead
  writeHeldVerdict: typeof writeHeldVerdict
  publishRound: typeof publishRound
  /** The configured security-scan argv, or null when the repository sets none. */
  resolveSecurityScanCommand: () => readonly string[] | null
  /** Runs the scanner over the candidate directory. */
  runSecurityScan: (command: readonly string[], cwd: string) => SecurityScanRun
  /** The paths the task branch changes against main. */
  changedPaths: (worktreePath: string) => readonly string[]
  /** The pull request's body. */
  fetchPrBody: (prNumber: number) => string
  updatePrBody: typeof defaultUpdatePrBody
  runLiveCommand: LiveRunner
  liveVendorSignedIn: (vendor: Parameters<typeof vendorSignedIn>[0]) => boolean
  liveRunTimeoutMs: number
  prepareLiveCheckout: LiveCheckoutPreparer
  discardHeldVerdicts: typeof discardHeldVerdicts
  /** Opens or updates the pull request's one deferred-findings Issue. */
  writeDeferredFindingsIssue: (input: { prNumber: number; entries: DeferredFindingEntry[] }) => DeferredFindingsIssueRef
  cleanupAllReviewerIsolationArtifacts: typeof cleanupAllReviewerIsolationArtifacts
  /** The repository's local gate control, read for the enforcement controls every dispatch requires. */
  localGateControl: () => EnforcementControl
  probeAgentSandbox: typeof probeAgentSandbox
  fetchCiConclusion: typeof fetchCiConclusion
  fetchFailingCheckRuns: typeof fetchFailingCheckRuns
  fetchFailedCheckWorkflowRunIds: typeof fetchFailedCheckWorkflowRunIds
  rerunFailedWorkflowJobs: typeof rerunFailedWorkflowJobs
  fetchMergeableState: typeof fetchMergeableState
  fetchConflictingFiles: typeof fetchConflictingFiles
  /** Posts a marked comment on the pull request: the round marker the reviewers' dispatch leaves. */
  postMarkedComment: typeof postMarkedComment
}

interface Binding {
  /** The functions this action adapts, by identity. */
  adapts: readonly ((...args: never[]) => unknown)[]
  build: (task: TaskInput) => ProcessAction
}

type Results = Readonly<Record<string, StepNodeResult>>

// --- the loop record the deciding steps carry ---------------------------------

/** The steps whose recorded result carries the loop state, each with the sequence number it was recorded under. */
export const STATE_STEPS = [
  'validate-developer-output',
  'check-mergeability',
  'assess-gate',
  'assess-round',
  'run-live-checks',
  'check-publish-mergeability',
  // Version 2's steps after an approval.
  'ready-push',
  'open-pull-request',
  'read-ci-once'
] as const

/** Why the Developer is dispatched again, as the step that sent it back recorded it. */
export type SendBackKind =
  | 'correction'
  | 'open-pull-request'
  | 'gate-red'
  | 'conflict'
  | 'low-confidence'
  | 'ask-confidence'
  | 'unpushed'
  | 'review'
  | 'live-red'
  // Version 2: a ready push or a pull request's opening refused an approved head, or CI was red on it.
  | 'ready-refused'
  | 'ci-red'

export interface SendBack {
  kind: SendBackKind
  /** Why a version 2 step sent the Developer back after an approval, for its next turn's prompt. */
  detail?: string
  /** The branch head on the remote when the Developer was sent back; a turn that leaves it unchanged pushed nothing. */
  headBefore?: string | null
  /** The files a conflicting head conflicts in, for the conflict turn's prompt. */
  files?: string[]
  /** The typed failures of a rejected turn result, for its one correction turn. */
  failures?: string[]
  /** The finding ids the rejected turn could cite, kept for its correction turn. */
  knownFindingIds?: string[]
  /** Whether the rejected turn answered review findings, so its correction must too. */
  answersFindings?: boolean
  /** The worktree head the rejected turn left, which its correction turn must not move. */
  head?: string | null
  /** What the rejected turn itself was answering: its corrected result is judged as that turn's. */
  corrects?: SendBack | null
}

/** The driver's own bounds within a round, carried with the loop state so a resumed run keeps them. */
export interface RoundCounters {
  /** Whether this stall's one unpushed-work resume was spent. */
  unpushedResumeAttempted: boolean
  /** Consecutive Developer turns that left a red head unchanged. */
  gateStalledStreak: number
  /** Set when a sent-back turn left the remote head unchanged with nothing unpushed: the next gate read decides whether it stalled. */
  stallCheck: { headBefore: string; refusal: string | null } | null
}

export const NO_COUNTERS: RoundCounters = { unpushedResumeAttempted: false, gateStalledStreak: 0, stallCheck: null }

/** One deciding step's record, as read back from its result. */
export interface LoopRecord {
  step: string
  seq: number
  state: LoopState
  counters: RoundCounters
  /** Why this step sent the Developer back, when it did. */
  sendBack: SendBack | null
  /** What the Developer turn this step validated was answering, when it validated one. */
  answered: SendBackKind | null
}

const MAP_TAG = '__map'

/** Loop state as JSON: its maps travel as tagged entry lists, the only part JSON cannot carry. */
export function encodeLoopState(state: LoopState): string {
  return JSON.stringify(state, (_key, value) => (value instanceof Map ? { [MAP_TAG]: [...value.entries()] } : value))
}

export function decodeLoopState(text: string): LoopState {
  return JSON.parse(text, (_key, value) =>
    value !== null && typeof value === 'object' && Array.isArray((value as Record<string, unknown>)[MAP_TAG])
      ? new Map((value as Record<string, [unknown, unknown][]>)[MAP_TAG])
      : value
  ) as LoopState
}

const stdoutOf = (result: StepNodeResult | undefined): string | null =>
  result && 'stdout' in result ? String(result.stdout) : null

/**
 * The newest record a deciding step left, by sequence number; null before any. A result that names a sequence
 * number but carries no readable state throws, since reading past it would silently restart the round count.
 */
export function latestRecord(results: Results): LoopRecord | null {
  let latest: LoopRecord | null = null
  for (const step of STATE_STEPS) {
    const stdout = stdoutOf(results[step])
    if (stdout === null || stdout.trim() === '') continue
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(stdout) as Record<string, unknown>
    } catch {
      continue
    }
    if (typeof parsed.seq !== 'number') continue
    let state: LoopState | undefined
    try {
      if (parsed.state !== undefined) state = decodeLoopState(JSON.stringify(parsed.state))
    } catch {
      state = undefined
    }
    if (state === undefined) throw new Error(`${step} recorded a result with no readable loop state`)
    if (latest !== null && parsed.seq <= latest.seq) continue
    latest = {
      step,
      seq: parsed.seq,
      state,
      counters: { ...NO_COUNTERS, ...(parsed.counters as Partial<RoundCounters> | undefined) },
      sendBack: (parsed.sendBack as SendBack | undefined) ?? null,
      answered: (parsed.answered as SendBackKind | undefined) ?? null
    }
  }
  return latest
}

const roundOf = (state: LoopState): number => Math.max(state.rounds.length, state.pending?.round ?? 0)

/**
 * The loop state the next assessment starts from: the newest state a deciding step recorded, or `initial` before
 * any did. The recorded state is the checkpointed one, so a resumed run carries it forward; a round number below
 * `initial`'s never replaces it.
 */
export function carriedLoopState(results: Results, initial: LoopState): LoopState {
  const recorded = latestRecord(results)?.state
  if (recorded === undefined) return initial
  return roundOf(recorded) < roundOf(initial) ? initial : recorded
}

/** The sequence number the next record is written under. */
function nextSeq(results: Results): number {
  return (latestRecord(results)?.seq ?? 0) + 1
}

/** A deciding step's record as its result's stdout. */
export function recordOutput(
  results: Results,
  state: LoopState,
  fields: {
    counters?: RoundCounters
    sendBack?: SendBack | null
    answered?: SendBackKind | null
    decision?: { type: string; reason?: string; detail?: string }
    events?: readonly unknown[]
    [extra: string]: unknown
  }
): string {
  return JSON.stringify({
    ...fields,
    seq: nextSeq(results),
    state: JSON.parse(encodeLoopState(state)),
    counters: fields.counters ?? NO_COUNTERS,
    sendBack: fields.sendBack ?? null,
    answered: fields.answered ?? null,
    events: fields.events ?? []
  })
}

/** The step's exit codes: forward, or back (to the Developer, or to the reviewers' dispatch). */
export const FORWARD = 0
export const BACK = 1

/** A pause the handoff makes durable; throws when no handoff is wired, since a pause nobody records would be lost. */
export function pauseThrough(task: TaskInput, step: string, request: PauseRequest): void {
  if (!task.handoff) throw new Error(`${step} decided a pause but no handoff is wired to make it durable`)
  task.handoff.pause(request)
}

/**
 * A precondition step's refusal: the pause made durable, and a result marked refused, so the run halts with the step
 * unrecorded and the resume after its cause is fixed runs it again. A deciding step's pause is recorded instead: its
 * record carries the decision the resume continues from.
 */
function refuseThrough(
  task: TaskInput,
  step: string,
  request: PauseRequest
): { exitCode: number; stdout: string; refused: true } {
  if (!task.handoff) throw new Error(`${step} refused (${request.reason}) but no handoff is wired to make it durable`)
  task.handoff.pause(request)
  return { exitCode: 1, stdout: request.detail, refused: true }
}

/** The round's statistics at the worktree's head against its merge base with main; unknown values when git cannot say. */
export function worktreeStats(worktreePath: string, wallMs: number): RoundStats {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: worktreePath, encoding: 'utf8' }).trim()
  try {
    const head = git('rev-parse', 'HEAD')
    const baseHead = git('merge-base', 'origin/main', head)
    const short = git('diff', '--shortstat', baseHead, head)
    const count = (pattern: RegExp) => Number(pattern.exec(short)?.[1] ?? 0)
    return {
      baseHead,
      head,
      filesChanged: count(/(\d+) files? changed/),
      insertions: count(/(\d+) insertions?/),
      deletions: count(/(\d+) deletions?/),
      wallMs
    }
  } catch {
    return { baseHead: 'unknown', head: 'unknown', filesChanged: 0, insertions: 0, deletions: 0, wallMs }
  }
}

/** The events an agent step recorded, without the exit marker a tolerant launch adds. */
function agentEvents(result: StepNodeResult | undefined): unknown[] {
  if (result?.kind !== 'agent-spawn') return []
  return result.events.filter((event) => agentExitOf(event) === null)
}

/** The event a tolerant launch appends when the agent process exited non-zero, so the step completes and is judged. */
export const AGENT_EXIT_EVENT = 'vinaya.agent_exit'

/** A reviewer process's non-zero exit, with the tail of what it wrote to stderr when it wrote anything. */
function agentExitOf(event: unknown): { code: number; stderr?: string } | null {
  let record = event
  if (typeof event === 'string') {
    try {
      record = JSON.parse(event)
    } catch {
      return null
    }
  }
  const candidate = record as { type?: unknown; exit_code?: unknown; stderr?: unknown } | null
  if (candidate?.type !== AGENT_EXIT_EVENT || typeof candidate.exit_code !== 'number') return null
  return typeof candidate.stderr === 'string' && candidate.stderr !== ''
    ? { code: candidate.exit_code, stderr: candidate.stderr }
    : { code: candidate.exit_code }
}

/** The final structured record an agent step reported, or undefined for a step that is not one. */
export function agentOutput(results: Results, step: string): unknown {
  const result = results[step]
  if (result?.kind !== 'agent-spawn') return undefined
  return structuredResult(agentEvents(result))
}

/** A Claude stream event (`system`, `result`, …) rather than a result: each names the session it belongs to. */
function isClaudeSessionEvent(record: unknown): boolean {
  const event = record as { type?: unknown; session_id?: unknown } | null
  return typeof event?.type === 'string' && typeof event.session_id === 'string'
}

/** What a reviewer step's run showed, as `classifyReviewOutcome` reads it. */
export function reviewRunFacts(results: Results, step: string): ReviewRunFacts {
  const result = results[step]
  if (result === undefined)
    return { cancelled: false, resumed: false, terminal: null, errors: [], hasResult: false, raw: undefined }
  const exits = result.kind === 'agent-spawn' ? result.events.map(agentExitOf).filter((code) => code !== null) : []
  const output = agentOutput(results, step)
  // A Claude stream that ended on one of its own session events carried no structured result at all.
  const raw = isClaudeSessionEvent(output) ? undefined : output
  return {
    cancelled: false,
    // The reviewer steps never continue a session: every launch is a fresh one.
    resumed: false,
    terminal: null,
    errors: [
      ...exits.map((exit) =>
        exit?.stderr === undefined
          ? `the reviewer process exited with code ${exit?.code}`
          : `the reviewer process exited with code ${exit.code}: ${exit.stderr}`
      ),
      ...(result.exitCode !== 0 ? [`the reviewer step exited with code ${result.exitCode}`] : [])
    ],
    hasResult: raw !== undefined,
    raw
  }
}

/** The confidence the newest Developer turn stated, or absent when it stated none. */
function stated(results: Results): Confidence {
  const turn = agentOutput(results, 'develop') as {
    turnResult?: { status?: unknown; confidence?: number; confidenceExplanation?: string }
  }
  const value = turn?.turnResult?.confidence
  return turn?.turnResult?.status === 'completed' && typeof value === 'number'
    ? { value, reason: turn.turnResult?.confidenceExplanation }
    : 'absent'
}

/** The failure a red gate step reported, as the assessment matches it; undefined when it printed nothing to name. */
export function gateFailure(gate: StepNodeResult): string | undefined {
  const text = (stdoutOf(gate) ?? '').trim()
  return text === '' ? undefined : text.slice(-4000)
}

/**
 * The assessment's events with a repeated round start left out: a round the Developer revisits after a red gate
 * or a low-confidence turn keeps its number, and starts once.
 */
function withoutRepeatedStart(
  before: LoopState,
  round: number,
  events: DevReviewLoopEventInput[]
): DevReviewLoopEventInput[] {
  const started = before.rounds.some((record) => record.round === round) || before.pending?.round === round
  return started ? events.filter((event) => event.event !== 'round_started') : events
}

/** The finding ids the newest revision handoff gave the Developer. */
function handedOverIds(results: Results): string[] {
  const stdout = stdoutOf(results['build-revision-handoff'])
  if (!stdout) return []
  try {
    const parsed = JSON.parse(stdout) as Array<{ id?: unknown }>
    return Array.isArray(parsed) ? parsed.flatMap((entry) => (typeof entry.id === 'string' ? [entry.id] : [])) : []
  } catch {
    return []
  }
}

/** The loop id the round's records name. */
const loopIdOf = (state: LoopState): string => state.config.loopId

// --- the Developer's turn result ----------------------------------------------

type Judged = { ok: true; result: DeveloperTurnResult } | { ok: false; failures: string[] }

/**
 * The controller's acceptance of the newest Developer turn result: the schema and the semantic rules against this
 * turn's own context, the round-1 and handoff rules, and a citation only behind a delivery receipt the controller
 * recorded — never the Developer's word.
 */
function judgeTurn(
  task: TaskInput,
  results: Results,
  round: number,
  knownFindingIds: readonly string[],
  answersFindings: boolean
): Judged {
  const validation = validateDeveloperTurnResult(agentOutput(results, 'develop'), {
    knownFindingIds,
    requiredSources: task.developerContext.requiredSources,
    permissibleDecisions: PERMISSIBLE_RULING_DECISIONS
  })
  if (!validation.ok) return { ok: false, failures: validation.errors }
  const result = validation.result
  const failures: string[] = []
  if (result.status === 'completed') {
    if (round === 1 && result.addressedFindingIds.length > 0)
      failures.push('addressedFindingIds: must be empty in round 1 — no review has handed over findings yet')
    if (answersFindings && knownFindingIds.length > 0 && result.addressedFindingIds.length === 0)
      failures.push('addressedFindingIds: required — name the finding ids from this handoff that this turn addressed')
    const counted = new Set(
      countedSourceIds(
        readSourceDeliveryReceipts(sourceReceiptsPath(sourceStoreDir(task.runtimeDir, task.issueNumber)))
      ).map(normalizeSourceIdentity)
    )
    for (const use of result.sourceUses ?? [])
      if (!counted.has(normalizeSourceIdentity(use.source)))
        failures.push(
          `sourceUses: ${use.source} has no delivery receipt the controller recorded — a page counts once read with the fetch_documentation tool; a citation of a source never delivered is not accepted`
        )
  }
  return failures.length > 0 ? { ok: false, failures } : { ok: true, result }
}

export const safeRead = <T>(read: (() => T) | undefined): T | null => {
  if (read === undefined) return null
  try {
    return read()
  } catch {
    return null
  }
}

/** The worktree head, or null when it cannot be read. */
export function worktreeHeadOf(task: TaskInput): string | null {
  return safeRead(() => (task.bound?.readWorktreeHead ?? readWorktreeHead)(task.worktreePath))
}

/** Records that both reviewers are due; the reviewer steps themselves launch after this one. */
export function dispatchReviewers(): { exitCode: number; stdout: string } {
  return ok('code-review,security-review')
}

export const ok = (stdout = ''): { exitCode: number; stdout: string } => ({ exitCode: 0, stdout })

// --- the round's review dispatch ----------------------------------------------

/** What the dispatch step recorded: the round, the attempt and the inputs its reviewers were dispatched against. */
export interface RecordedDispatch {
  round: number
  attempt: number
  inputs: ReviewRoundInputs | null
}

/** The newest reviewer dispatch the run recorded, or null before any. */
export function recordedDispatch(results: Results): RecordedDispatch | null {
  const stdout = stdoutOf(results['dispatch-reviewers'])
  if (!stdout) return null
  try {
    const parsed = JSON.parse(stdout) as Partial<RecordedDispatch>
    return typeof parsed.round === 'number' && typeof parsed.attempt === 'number'
      ? { round: parsed.round, attempt: parsed.attempt, inputs: parsed.inputs ?? null }
      : null
  } catch {
    return null
  }
}

/** The manifest snapshot the newest reviewer dispatch was taken against, or undefined before any. */
export function dispatchedManifest(results: Results): ReviewInputManifest | undefined {
  return recordedDispatch(results)?.inputs?.manifest
}

/** What the reviewer-output step decided: hold the verdicts, retry the reviewers, dispatch them again or pause. */
export type ReviewNext = 'hold' | 'retry' | 'redispatch' | 'pause'

interface RecordedReviews {
  round: number
  attempt: number
  next: ReviewNext
  /** Each role's accepted verdict this round, kept across a fresh retry of its sibling. */
  accepted: Partial<Record<HeldVerdictRole, RoundVerdictParse>>
  /** Each earlier attempt's miss this round, named again when the round's last attempt misses too. */
  missed: Array<{ role: HeldVerdictRole; detail: string }>
}

function recordedReviews(results: Results): RecordedReviews | null {
  const stdout = stdoutOf(results['validate-reviewer-outputs'])
  if (!stdout) return null
  try {
    const parsed = JSON.parse(stdout) as Partial<RecordedReviews>
    return typeof parsed.round === 'number' && typeof parsed.next === 'string'
      ? {
          round: parsed.round,
          attempt: parsed.attempt ?? 1,
          next: parsed.next as ReviewNext,
          accepted: parsed.accepted ?? {},
          missed: parsed.missed ?? []
        }
      : null
  } catch {
    return null
  }
}

/** The verdict observations the reviewer-output step held for the round; throws when it held none. */
export function recordedVerdicts(results: Results): VerdictObservation[] {
  const reviews = recordedReviews(results)
  const reviewer = reviews?.accepted.reviewer
  const security = reviews?.accepted.security
  if (reviews?.next !== 'hold' || reviewer === undefined || security === undefined)
    throw new Error('no verdicts were held for the round: the reviewer-output step recorded none')
  return [reviewer.observation, security.observation]
}

/** The review-input fields whose change pauses the round, each with the pause it is; a head or base change is not one. */
const MANIFEST_PAUSES: ReadonlyArray<[keyof ReturnType<typeof buildManifestRecord>, PauseReason]> = [
  ['objectivesVersion', 'objectives_changed'],
  ['rulingOrdinal', 'ruling_posted'],
  ['briefHash', 'brief_superseded'],
  ['policyDigest', 'policy_changed']
]

/** The manifest fields that differ between the dispatched snapshot and the inputs as they read now, via `buildManifestRecord`. */
export function changedReviewInputs(
  dispatched: ReviewInputManifest,
  current: ReviewInputManifest
): (keyof ReturnType<typeof buildManifestRecord>)[] {
  const identity = { repository: '', pr: 0, branch: '', round: 0, recordedAt: '' }
  const before = buildManifestRecord(dispatched, identity)
  const now = buildManifestRecord(current, identity)
  return (Object.keys(before) as (keyof typeof before)[]).filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(now[key])
  )
}

// --- the live check -----------------------------------------------------------

/** What the assess-round step recorded: its decision, the Log events and the state it ended on, and the findings it set aside so far. */
export interface RecordedAssessment {
  decision: { type: string; reason?: string; detail?: string }
  events: DevReviewLoopEventInput[]
  state: LoopState
  deferredFindings: DeferredFindingEntry[]
}

/** The assessment the assess-round step recorded; throws when it recorded none or something unreadable. */
export function readAssessment(results: Results): RecordedAssessment {
  const assessed = results['assess-round']
  if (!assessed || !('stdout' in assessed)) throw new Error('no recorded result for the assess-round step')
  let parsed: Partial<RecordedAssessment> & { state?: unknown }
  try {
    parsed = JSON.parse(String(assessed.stdout))
  } catch (error) {
    throw new Error(
      `the assess-round result is not readable: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (!parsed.decision || !Array.isArray(parsed.events) || parsed.state === undefined)
    throw new Error('the assess-round result has no decision, events or state')
  return {
    decision: parsed.decision,
    events: parsed.events,
    state: decodeLoopState(JSON.stringify(parsed.state)),
    deferredFindings: Array.isArray(parsed.deferredFindings) ? parsed.deferredFindings : []
  }
}

/** The findings set aside through the rounds so far, from the last assessment's record; empty before any. */
function recordedDeferredFindings(results: Results): DeferredFindingEntry[] {
  const stdout = stdoutOf(results['assess-round'])
  if (!stdout) return []
  try {
    const parsed = JSON.parse(stdout) as { deferredFindings?: unknown }
    return Array.isArray(parsed.deferredFindings) ? (parsed.deferredFindings as DeferredFindingEntry[]) : []
  } catch {
    return []
  }
}

/** The completion events the live-check step held back until publication — the journal's close; none before it ran. */
function heldCompletionEvents(results: Results): DevReviewLoopEventInput[] {
  const stdout = stdoutOf(results['run-live-checks'])
  if (!stdout) return []
  try {
    const parsed = JSON.parse(stdout) as { outcome?: unknown; deferred?: unknown }
    return parsed.outcome === 'publish' && Array.isArray(parsed.deferred)
      ? (parsed.deferred as DevReviewLoopEventInput[])
      : []
  } catch {
    return []
  }
}

/** The live-check step's exit result asks for the Developer when it did not exit zero. */
export function isLiveWithdrawn(examined: StepNodeResult): boolean {
  return examined.exitCode !== 0
}

/** The security scan outcome the scan step recorded, or undefined when it recorded none. */
export function recordedScanOutcome(results: Results): SecurityScanOutcome | undefined {
  const stdout = stdoutOf(results['run-security-scan'])
  if (stdout === null) return undefined
  try {
    return JSON.parse(stdout) as SecurityScanOutcome
  } catch {
    return undefined
  }
}

/** The paths `worktreePath`'s head changes against its merge base with main; empty when git cannot say. */
function worktreeChangedPaths(worktreePath: string): readonly string[] {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: worktreePath, encoding: 'utf8' }).trim()
  const head = git('rev-parse', 'HEAD')
  return git('diff', '--name-only', `${git('merge-base', 'origin/main', head)}...${head}`)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

// --- the decisions ------------------------------------------------------------

/** A deciding step's recorded exit result sends the run back when it exited one. */
export function isSentBack(examined: StepNodeResult): boolean {
  return examined.exitCode === BACK
}

/** The gate decision reads the gate assessment's exit result: back to the Developer, or on to the reviewers. */
export const isGateRed = isSentBack

/** The reconcile step's exit code when no pull request is open for the branch yet. */
export const EXIT_NO_OPEN_PR = 0
/** The reconcile step's exit code when a pull request is already open for the branch. */
export const EXIT_OPEN_PR = 1

/** The start decision's predicate: the Developer is due only when the reconcile step found no open pull request. */
export function isDevelopmentDue(examined: StepNodeResult): boolean {
  return examined.exitCode === EXIT_NO_OPEN_PR
}

/** The assessment step's recorded exit result asks for a revision when it did not exit zero. */
export function isRevisionRequested(examined: StepNodeResult): boolean {
  return examined.exitCode !== 0
}

/** Records how the gate assessment routed; the decision on this step reads the assessment's own exit result. */
export function classifyGateResult(context: ActionContext): { exitCode: number; stdout: string } {
  const assessed = context.results['assess-gate']
  if (!assessed) throw new Error('classify-gate-result ran before the gate assessment recorded a result')
  return ok(isSentBack(assessed) ? 'developer' : 'reviewers')
}

/** Records how the Developer output's validation routed. */
export function classifyDeveloperOutput(context: ActionContext): { exitCode: number; stdout: string } {
  const validated = context.results['validate-developer-output']
  if (!validated) throw new Error('classify-developer-output ran before the Developer output was validated')
  return ok(isSentBack(validated) ? 'developer' : 'gates')
}

/** Records how the reviewer outputs' validation routed. */
export function classifyReviewerOutputs(context: ActionContext): { exitCode: number; stdout: string } {
  const validated = context.results['validate-reviewer-outputs']
  if (!validated) throw new Error('classify-reviewer-outputs ran before the reviewer outputs were validated')
  return ok(isSentBack(validated) ? 'reviewers' : 'assessment')
}

/** The Developer's turn just validated: its result judged, then — for a sent-back turn — whether its push landed. */
function validateDeveloperOutput(task: TaskInput, context: ActionContext): { exitCode: number; stdout: string } {
  const { results } = context
  const previous = latestRecord(results)
  let state = carriedLoopState(results, task.loopState)
  const counters = previous?.counters ?? NO_COUNTERS
  const answered = previous?.sendBack ?? null
  const round = task.reviewRound()
  const events: DevReviewLoopEventInput[] = []
  const out = (
    exitCode: number,
    fields: { counters?: RoundCounters; sendBack?: SendBack | null; decision?: { type: string; reason?: string } }
  ) => ({
    exitCode,
    stdout: recordOutput(results, state, {
      counters: counters,
      ...fields,
      answered: original?.kind ?? null,
      events,
      decision: fields.decision ?? { type: exitCode === FORWARD ? 'accepted' : 'dispatch_developer' }
    })
  })
  /** A decided pause: logged as the standalone loop logs one, made durable, and routed to where its resume continues. */
  const pause = (reason: PauseReason, reasonCode: string, detail: string, error?: unknown) => {
    events.push(
      ...driverDecidedPauseEvents(loopIdOf(state), state, round, worktreeStats(task.worktreePath, 0), reasonCode)
    )
    pauseThrough(task, 'validate-developer-output', { reason, detail, ...(error === undefined ? {} : { error }) })
    // Its resume dispatches the turn this one answered again, never a second correction.
    return out(BACK, { counters: NO_COUNTERS, sendBack: original, decision: { type: 'pause', reason } })
  }
  /** An assessed mechanical failure of an attempt that produced no head; a pause when the assessment decides one. */
  const assessFailure = (failure: string) => {
    const assessed = assessRound(
      state,
      { kind: 'mechanical_failure', round, failure, stats: worktreeStats(task.worktreePath, 0) },
      task.clock
    )
    state = assessed.state
    events.push(...assessed.events)
    if (assessed.decision.type !== 'pause') return null
    pauseThrough(task, 'validate-developer-output', {
      reason: assessed.decision.reason,
      detail: assessed.decision.detail ?? assessed.decision.reason
    })
    return out(BACK, { counters: NO_COUNTERS, sendBack: original, decision: assessed.decision })
  }

  // The turn result first: a rejected one earns one correction turn of the same session, then pauses.
  const correcting = answered?.kind === 'correction'
  // What the turn answers once corrected: the send-back of the turn whose result was rejected.
  const original = correcting ? (answered.corrects ?? null) : answered
  const answersFindings = correcting ? answered.answersFindings === true : answered?.kind === 'review'
  const knownFindingIds = correcting ? (answered.knownFindingIds ?? []) : answersFindings ? handedOverIds(results) : []
  task.developerContext = { ...task.developerContext, knownFindingIds }
  const head = worktreeHeadOf(task)
  let judged = judgeTurn(task, results, round, knownFindingIds, answersFindings)
  if (judged.ok && correcting && answered.head !== undefined && head !== answered.head)
    judged = {
      ok: false,
      failures: [`turnResult: stale — the head moved from ${answered.head} to ${head} during the correction turn`]
    }
  if (!judged.ok) {
    if (correcting) {
      const rejection = new DeveloperTurnResultPause(
        'rejected',
        // Worded as the standalone loop words it: the rejected turn and its one correction.
        `the Developer's turn result was rejected twice in round ${round} (attempt 1: ${(answered.failures ?? []).join('; ')}; attempt 2: ${judged.failures.join('; ')})`
      )
      return pause(rejection.pauseReason, rejection.reasonCode, rejection.message, rejection)
    }
    return out(BACK, {
      sendBack: {
        kind: 'correction',
        failures: judged.failures,
        knownFindingIds,
        answersFindings,
        head,
        corrects: answered
      },
      decision: { type: 'correction' }
    })
  }
  // A finished Developer attempt: the same failure read again after it is a second attempt's.
  state = recordDeveloperAttempt(state)
  const escalation = pauseForAcceptedResult(judged.result)
  if (escalation !== null) return pause(escalation.pauseReason, escalation.reasonCode, escalation.message, escalation)
  // A corrected result stands for the turn it corrected: that turn's own pull request and push are judged next.

  // No pull request after the turn: resumed once with the push-and-open instructions, then an infrastructure pause.
  const pr = safeRead(() => (task.bound?.findOpenPrForBranch ?? findOpenPrForBranch)(task.branch))
  // Version 2 opens no pull request before approval: the Developer's staged one stands for it.
  const staged = task.flow === 'v2' ? safeRead(task.stagedPullRequest) : null
  if (pr === null && staged === null) {
    if (original?.kind === 'open-pull-request') {
      const detail = `no open pull request for ${task.branch} after resuming once with the push-and-open instructions`
      return pause('infrastructure', 'infrastructure', detail, new Error(detail))
    }
    return out(BACK, { sendBack: { kind: 'open-pull-request' } })
  }

  // A turn sent back for a red gate, a conflict or unpushed work must have moved the branch's remote head.
  if (
    (original?.kind !== 'gate-red' &&
      original?.kind !== 'conflict' &&
      original?.kind !== 'unpushed' &&
      original?.kind !== 'ready-refused' &&
      original?.kind !== 'ci-red') ||
    typeof original.headBefore !== 'string'
  )
    return out(FORWARD, { counters })
  const headBefore = original.headBefore
  const remote = safeRead(task.remoteHead)
  if (remote !== null && remote !== headBefore) return out(FORWARD, { counters: NO_COUNTERS })
  const readUnpushed = () => (task.readUnpushedWork ?? (() => readUnpushedWorkDetail(task.worktreePath)))()
  if (original.kind === 'unpushed') {
    // The one resume did not land either: a push that did not land is a mechanical failure, then `no_push`.
    const still = readUnpushed()
    if (still.aheadCount > 0) {
      const paused = assessFailure(unpushedFailureMessage(task.branch, headBefore, still))
      if (paused !== null) return paused
    }
    if (still.dirtyFiles.length === 0 && still.aheadCount === 0 && remote === headBefore)
      return out(FORWARD, { counters: { ...counters, stallCheck: null } })
    return pause('no_push', 'no_push', noPushPauseDetail(task.branch, still))
  }
  const refusal = safeRead(task.publicationRefusal)
  if (!counters.unpushedResumeAttempted && refusal === null) {
    const unpushed = readUnpushed()
    if (unpushed.dirtyFiles.length > 0 || unpushed.aheadCount > 0) {
      if (unpushed.aheadCount > 0) {
        const paused = assessFailure(unpushedFailureMessage(task.branch, headBefore, unpushed))
        if (paused !== null) return paused
      }
      events.push({
        kind: 'dev_review_loop',
        payload: {},
        loop_id: loopIdOf(state),
        event: 'unpushed_work_resume',
        round,
        branch: task.branch,
        detail: unpushedWorkResumeDetail(unpushed)
      } as DevReviewLoopEventInput)
      return out(BACK, {
        counters: { ...counters, unpushedResumeAttempted: true },
        sendBack: { kind: 'unpushed', headBefore }
      })
    }
  }
  // Nothing unpushed and nothing moved: the next gate read of this head decides whether the turn stalled.
  return out(FORWARD, { counters: { ...counters, stallCheck: { headBefore, refusal } } })
}

/** The gate step's result, observed by the assessment: a red gate is a gate observation like a green one. */
function assessGate(task: TaskInput, context: ActionContext): { exitCode: number; stdout: string } {
  const { results } = context
  const gate = results['run-mechanical-gates']
  if (!gate) throw new Error('assess-gate found no recorded result for the gate step run-mechanical-gates')
  const previous = latestRecord(results)
  const before = carriedLoopState(results, task.loopState)
  let state = before
  const counters = previous?.counters ?? NO_COUNTERS
  const round = task.reviewRound()
  // The head's gate is the local checks and the forge's CI read together: a red CI read is a red gate.
  const ci = recordedForgeCi(results)
  const localGreen = gate.exitCode === 0
  const ciRed = localGreen && ci?.conclusion === 'red'
  const unpushed = localGreen && ci?.conclusion === 'unpushed'
  const green = localGreen && !ciRed && !unpushed
  const failure = !localGreen
    ? gateFailure(gate)
    : ciRed && ci.failingChecks.length > 0
      ? ci.failingChecks.join('; ')
      : undefined
  const stats = worktreeStats(task.worktreePath, gate.kind === 'mechanical' ? gate.durationMs : 0)
  const events: DevReviewLoopEventInput[] = []
  const headNow = () => safeRead(task.remoteHead) ?? stats.head
  const out = (
    exitCode: number,
    decision: { type: string; reason?: string; detail?: string },
    fields: { counters?: RoundCounters; sendBack?: SendBack | null } = {}
  ) => ({
    exitCode,
    stdout: recordOutput(results, state, { counters: NO_COUNTERS, ...fields, events, decision })
  })
  const paused = (decision: { reason: PauseReason; detail?: string }, sendBack: SendBack, error?: unknown) => {
    pauseThrough(task, 'assess-gate', {
      reason: decision.reason,
      detail: decision.detail ?? decision.reason,
      ...(error === undefined ? {} : { error })
    })
    return out(BACK, { type: 'pause', ...decision }, { sendBack })
  }

  // A sent-back turn that moved nothing, read again red: a stalled turn, never a new gate observation.
  const stall = counters.stallCheck
  if (stall !== null && !green) {
    const streak = counters.gateStalledStreak + 1
    const named =
      stall.refusal !== null
        ? `publication refused: ${stall.refusal}`
        : !localGreen && failure !== undefined
          ? `failing check(s): ${failure}`
          : ciRed && ci.failingChecks.length > 0
            ? // Named as the standalone loop names the forge's own failing check-runs.
              `failing check-run(s): ${ci.failingChecks.join(', ')}`
            : null
    const detail = `head ${stall.headBefore} unchanged after dispatch; ${
      named ?? 'no named failure for this head — the developer pushed nothing for the gate to judge'
    }`
    const sendBack: SendBack = { kind: 'gate-red', headBefore: stall.headBefore }
    if (named !== null) {
      const assessed = assessRound(state, { kind: 'mechanical_failure', round, failure: detail, stats }, task.clock)
      state = assessed.state
      events.push(...assessed.events)
      if (assessed.decision.type === 'pause') return paused(assessed.decision, sendBack)
    }
    // A stall is no gate observation: the stall's one unpushed-work resume stays spent.
    if (streak < MAX_GATE_STALLED_TURNS)
      return out(
        BACK,
        { type: 'dispatch_developer' },
        { counters: { ...counters, gateStalledStreak: streak, stallCheck: null }, sendBack }
      )
    events.push(...driverDecidedPauseEvents(loopIdOf(state), state, round, stats, 'infrastructure'))
    return paused({ reason: 'infrastructure', detail }, sendBack, new Error(detail))
  }

  // A head the remote does not hold has no CI to judge: the Developer publishes it, and no gate is observed.
  if (unpushed)
    return out(
      BACK,
      { type: 'dispatch_developer', reason: 'unpushed' },
      { counters, sendBack: { kind: 'unpushed', headBefore: safeRead(task.remoteHead) } }
    )

  const confidence = round >= 2 && green ? stated(results) : undefined
  const observation: Observations = {
    kind: 'gate',
    round,
    green,
    ...(confidence === undefined ? {} : { confidence }),
    stats,
    ...(failure === undefined ? {} : { failure })
  }
  const assessed = assessRound(state, observation, task.clock)
  state = assessed.state
  events.push(...withoutRepeatedStart(before, round, assessed.events))
  const { decision } = assessed
  if (decision.type === 'dispatch_reviewers') return out(FORWARD, decision)
  if (decision.type === 'ask_confidence') return out(BACK, decision, { sendBack: { kind: 'ask-confidence' } })
  const sendBack: SendBack = green ? { kind: 'low-confidence' } : { kind: 'gate-red', headBefore: headNow() }
  if (decision.type === 'pause') {
    const detail =
      decision.reason === 'confidence' && decision.detail === undefined
        ? describeConfidencePauseDetail(confidence ?? 'absent')
        : decision.detail
    return paused({ reason: decision.reason, ...(detail === undefined ? {} : { detail }) }, sendBack)
  }
  return out(BACK, decision, { sendBack })
}

/**
 * Keeps a finished sibling's verdict at `rounds/<n>/<role>-kept-on-pause.md` — never the held-verdict file, which
 * only a round both roles finished holds — and returns the note the pause names it with; null when it cannot be
 * written.
 */
function keepSiblingVerdict(task: TaskInput, round: number, role: HeldVerdictRole, verdict: RoundVerdictParse) {
  const file = `${role}-kept-on-pause.md`
  try {
    ensureRunDir(runPath(task.runtimeDir, task.issueNumber, { area: 'round', round }), task.runtimeDir)
    writeFileSync(runPath(task.runtimeDir, task.issueNumber, { area: 'round', round, file }), verdict.rendered, 'utf8')
  } catch {
    return null
  }
  const findings = verdict.observation.findings.length
  return `the ${role === 'reviewer' ? 'code reviewer' : 'security reviewer'} finished this round (${verdict.observation.verdict}, ${findings} finding(s)), kept at rounds/${round}/${file}`
}

/** The reviewer steps' results, each classified; a retry, a re-dispatch or a pause when either gave no usable review. */
function validateReviewerOutputs(task: TaskInput, context: ActionContext): { exitCode: number; stdout: string } {
  const { results } = context
  const dispatch = recordedDispatch(results)
  const round = dispatch?.round ?? task.reviewRound()
  const attempt = dispatch?.attempt ?? 1
  const inputs = dispatch?.inputs ?? null
  const state = carriedLoopState(results, task.loopState)
  const prior = recordedReviews(results)
  // A role accepted on an earlier attempt of this round keeps its verdict across its sibling's fresh retry.
  const retried = prior !== null && prior.round === round && prior.next === 'retry'
  const accepted: Partial<Record<HeldVerdictRole, RoundVerdictParse>> = retried ? { ...prior.accepted } : {}
  const missing: Array<{ role: HeldVerdictRole; detail: string; rejected: ReviewerResultRejected | null }> = []
  const events: unknown[] = []
  const out = (exitCode: number, next: ReviewNext, decision: { type: string; reason?: string; detail?: string }) => ({
    exitCode,
    stdout: JSON.stringify({
      round,
      attempt,
      next,
      accepted,
      missed: [...(retried ? prior.missed : []), ...missing.map(({ role, detail }) => ({ role, detail }))],
      events,
      decision
    })
  })
  for (const [step, role] of [
    ['code-review', 'reviewer'],
    ['security-review', 'security']
  ] as const) {
    if (inputs === null) {
      // A run with no recorded dispatch inputs (a stub run) reads the shape alone.
      const parsed = parseReviewResult(agentOutput(results, step))
      if (!parsed.ok) {
        missing.push({
          role,
          detail: `${step} output failed ${parsed.stage} validation: ${parsed.errors.join('; ')}`,
          rejected: null
        })
        continue
      }
      accepted[role] = task.buildVerdict(role, parsed.result, { manifest: {} as ReviewInputManifest, objectives: [] })
      continue
    }
    // The vendor session the attempt ran in, named in a miss as the standalone loop names it.
    const sessionId = sessionIdOf(agentEvents(results[step]))
    const session = sessionId ?? '(unknown)'
    const outcome = classifyReviewOutcome(reviewRunFacts(results, step), {
      role: role === 'reviewer' ? 'code-reviewer' : 'security-reviewer',
      headSha: inputs.manifest.headSha,
      manifestDigest: manifestDigest(inputs.manifest),
      objectiveIds: inputs.objectives.map((objective) => objective.id),
      runId: loopIdOf(state),
      round,
      attempt
    })
    const review: ReviewResult | null =
      outcome.kind === 'review'
        ? outcome.result
        : outcome.blocked !== undefined && reviewBlockerNeedsRuling(outcome.blocked.blocker.kind)
          ? outcome.blocked
          : null
    if (review === null) {
      if (accepted[role] === undefined && outcome.kind === 'no_review')
        missing.push({
          role,
          detail: `attempt ${attempt} (session ${session}): no review (${outcome.reason}) — ${outcome.detail}`,
          rejected: null
        })
      continue
    }
    try {
      accepted[role] = task.buildVerdict(role, review, inputs, sessionId)
    } catch (error) {
      if (!(error instanceof ReviewerResultRejected)) throw error
      if (accepted[role] === undefined)
        missing.push({
          role,
          detail: `attempt ${attempt} (session ${session}): no review (rejected) — ${error.message}`,
          rejected: error
        })
    }
  }

  if (missing.length > 0) {
    // One fresh retry of the round's review; a second miss pauses with nothing held and the round unchanged.
    if (attempt < 2) return out(BACK, 'retry', { type: 'retry' })
    const first = missing[0]!
    const failure =
      first.rejected ??
      new ReviewerInfrastructureFailure(first.role, [
        ...(retried ? prior.missed : []).filter((miss) => miss.role === first.role).map((miss) => miss.detail),
        ...missing.filter((miss) => miss.role === first.role).map((miss) => miss.detail)
      ])
    // A sibling that finished while this one delivered no review is kept beside the round, never held, and named.
    const keptNotes = (first.rejected === null ? (Object.keys(accepted) as HeldVerdictRole[]) : []).flatMap((role) => {
      const note = keepSiblingVerdict(task, round, role, accepted[role]!)
      return note === null ? [] : [note]
    })
    for (const miss of missing)
      events.push({
        kind: 'role_attempt',
        event: 'attempted',
        payload: {},
        actor: miss.role,
        // As on the standalone driver: no attempt number at this site, and the model the role was dispatched under.
        attempt: null,
        effect_id: `${loopIdOf(state)}:${round}:${attempt}:${miss.role}`,
        model:
          (state.config.models as Readonly<Record<string, string>>)[
            miss.role === 'reviewer' ? 'code-reviewer' : miss.role
          ] ?? null,
        outcome: miss.rejected !== null ? 'incomplete' : 'infrastructure_failed',
        usage: null,
        duration_ms: 0
      })
    events.push(
      ...driverDecidedPauseEvents(
        loopIdOf(state),
        state,
        round,
        worktreeStats(task.worktreePath, 0),
        'infrastructure'
      ).filter((event) => event.event !== 'round_ended')
    )
    pauseThrough(task, 'validate-reviewer-outputs', {
      reason: 'infrastructure',
      detail: [failure.message, ...keptNotes].join(' — '),
      error: failure
    })
    return out(BACK, 'pause', { type: 'pause', reason: 'infrastructure' })
  }

  // Both reviews stand only for inputs that did not move while the reviewers ran.
  if (inputs !== null && task.currentManifest !== undefined) {
    const current = safeRead(task.currentManifest)
    const changed = current === null ? null : changedReviewInputs(inputs.manifest, current)
    if (changed === null || changed.length > 0) {
      ;(task.bound?.discardHeldVerdicts ?? discardHeldVerdicts)(task.runtimeDir, task.issueNumber, round)
      for (const role of Object.keys(accepted) as HeldVerdictRole[]) delete accepted[role]
      const typed = changed === null ? undefined : MANIFEST_PAUSES.find(([field]) => changed.includes(field))
      if (changed === null || typed !== undefined) {
        const reason: PauseReason = typed?.[1] ?? 'infrastructure'
        const detail =
          changed === null
            ? 'the review inputs could not be read again before the verdicts were held, so neither verdict is kept'
            : inputsChangedDetail(task, reason, inputs.manifest, current!, round)
        events.push(
          ...driverDecidedPauseEvents(loopIdOf(state), state, round, worktreeStats(task.worktreePath, 0), reason)
        )
        pauseThrough(task, 'validate-reviewer-outputs', {
          reason,
          detail,
          ...(reason === 'infrastructure' ? { error: new Error(detail) } : {})
        })
        return out(BACK, 'pause', { type: 'pause', reason })
      }
      // The head or its base moved: both verdicts judged another head, so the round's reviewers run again.
      return out(BACK, 'redispatch', { type: 'redispatch', detail: changed.join(', ') })
    }
  }

  // Nothing is held until both verdicts stand, so a round never holds one reviewer's verdict alone.
  const write = task.bound?.writeHeldVerdict ?? writeHeldVerdict
  for (const role of ['reviewer', 'security'] as const)
    write(task.runtimeDir, task.issueNumber, round, role, accepted[role]!.rendered)
  return out(FORWARD, 'hold', { type: 'hold' })
}

/** Why a moved review input paused the round, worded as the standalone loop words each. */
function inputsChangedDetail(
  task: TaskInput,
  reason: PauseReason,
  dispatched: ReviewInputManifest,
  current: ReviewInputManifest,
  round: number
): string {
  switch (reason) {
    case 'objectives_changed': {
      const command =
        safeRead(task.objectivesEdit) ??
        `vinaya issue objectives edit ${task.issueNumber} ... (edit comment not found on re-read)`
      return `objectives moved from ${dispatched.objectivesVersion ?? 'none'} to ${current.objectivesVersion ?? 'none'} between reviewer dispatch and assessment — superseded by \`${command}\``
    }
    case 'brief_superseded':
      return `the frozen brief was superseded between reviewer dispatch and assessment — brief hash moved from ${dispatched.briefHash ?? 'none'} to ${current.briefHash ?? 'none'}`
    case 'policy_changed':
      return `the review policy changed between reviewer dispatch and assessment — policy digest moved from ${dispatched.policyDigest} to ${current.policyDigest}`
    default: {
      const field = MANIFEST_PAUSES.find(([, pause]) => pause === reason)![0]
      const record = (manifest: ReviewInputManifest) =>
        String(buildManifestRecord(manifest, { repository: '', pr: 0, branch: '', round, recordedAt: '' })[field])
      return `${field} changed while the round-${round} reviewers ran (dispatched ${record(dispatched)}, now ${record(current)}); both verdicts are discarded`
    }
  }
}

/** The round's verdicts, observed by the assessment, which decides the round. */
function assessVerdictsAction(task: TaskInput, context: ActionContext): { exitCode: number; stdout: string } {
  const { results } = context
  const state0 = carriedLoopState(results, task.loopState)
  const round = task.reviewRound()
  const verdicts = recordedVerdicts(results)
  const assessment = assessRound(state0, { kind: 'verdicts', round, verdicts }, task.clock)
  const { decision, state } = assessment
  // The findings set aside rather than let block, round by round, for the publish step to track.
  const deferredFindings = [
    ...recordedDeferredFindings(results).filter((entry) => entry.round !== round),
    ...deferredEntriesForRound(round, verdicts)
  ]
  const stdout = recordOutput(results, state, {
    decision,
    events: assessment.events,
    deferredFindings,
    sendBack: decision.type === 'publish' ? null : { kind: 'review' }
  })
  if (decision.type === 'pause') {
    // An escalation or a reappearance names its cause from the round's facts, as the standalone loop's does.
    const escalated = (role: VerdictObservation['role']) =>
      verdicts.some((verdict) => verdict.role === role && verdict.verdict === 'ESCALATE')
    const detail =
      decision.detail ??
      deriveVerdictPauseDetail(decision.reason, assessment.events, escalated('reviewer'), escalated('security'))
    // The pause is a decision, not a failure: it is handed off and the run halts at this step's boundary.
    pauseThrough(task, 'assess-round', { reason: decision.reason, detail: detail ?? decision.reason })
  }
  return { exitCode: decision.type === 'publish' ? 0 : 1, stdout }
}

// --- the forge gates: mergeability, CI and the premise, in the standalone round order ---------------

/** The poll budget the forge-gate steps read within: the task's own, else the standalone loop's. */
export function gatePollOf(task: TaskInput): GatePoll {
  if (task.gatePoll !== undefined) return task.gatePoll
  const { gatePollMaxAttempts, gatePollIntervalMs, sleep } = defaultDeps()
  return { gatePollMaxAttempts, gatePollIntervalMs, sleep }
}

/** The pull request the forge gates judge; throws when none is open, since every gate step runs after one was. */
function openPullRequestOf(task: TaskInput, step: string): number {
  // A test or a run that supplies its own lookup keeps it; the live one tells a failed forge call apart from an
  // empty answer, retries the failure, and names it if it persists.
  const find = task.bound?.findOpenPrForBranch
  if (find && find !== findOpenPrForBranch) {
    const pr = find(task.branch)
    if (pr === null) throw new Error(`${step} found no open pull request for branch ${task.branch}`)
    return pr.number
  }
  let lastError = ''
  for (let attempt = 1; attempt <= OPEN_PR_LOOKUP_ATTEMPTS; attempt += 1) {
    try {
      const pr = findOpenPrForBranchStrict(task.branch)
      if (pr === null) throw new Error(`${step} found no open pull request for branch ${task.branch}`)
      return pr.number
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      if (lastError.startsWith(`${step} found no open pull request`)) throw error
      if (attempt < OPEN_PR_LOOKUP_ATTEMPTS) Bun.sleepSync(OPEN_PR_LOOKUP_SPACING_MS)
    }
  }
  throw new Error(`${step} could not list the open pull requests for branch ${task.branch}: ${lastError}`)
}

const OPEN_PR_LOOKUP_ATTEMPTS = 3
const OPEN_PR_LOOKUP_SPACING_MS = 5_000

/** A worktree head the remote branch does not hold yet: the head no CI has run on, and the remote head beside it. */
export interface UnpushedHead {
  head: string
  remoteHead: string
}

/**
 * The worktree head when it differs from the branch's head on the remote, so no CI can exist for it; null when they
 * match, or when either head cannot be read (a failed remote read keeps its own handling and is never `unpushed`).
 */
export function unpushedHeadOf(task: TaskInput): UnpushedHead | null {
  const head = worktreeHeadOf(task)
  const remoteHead = safeRead(task.remoteHead)
  if (head === null || remoteHead === null || head === remoteHead) return null
  return { head, remoteHead }
}

/** The head the forge gates judge: the worktree's, else the branch's on the remote. */
function judgedHeadOf(task: TaskInput): string {
  const head = worktreeHeadOf(task) ?? safeRead(task.remoteHead)
  if (head === null) throw new Error(`the forge gates could not read the head of ${task.worktreePath}`)
  return head
}

/**
 * The forge's mergeability of the pull request, read before any CI wait (`pollMergeableState`). A conflicting head
 * goes back to the Developer with the conflicting files (`fetchConflictingFiles`), never to the reviewers. A conflict
 * the Developer's turn left unchanged is a stalled turn named by the conflict: a mechanical failure the assessment
 * judges, so the same conflict twice pauses `repeat_failure`, and an unnamed second stall pauses `infrastructure`.
 */
async function checkMergeability(
  task: TaskInput,
  context: ActionContext
): Promise<{ exitCode: number; stdout: string }> {
  const { results } = context
  const previous = latestRecord(results)
  let state = carriedLoopState(results, task.loopState)
  const counters = previous?.counters ?? NO_COUNTERS
  const round = task.reviewRound()
  const events: DevReviewLoopEventInput[] = []
  const out = (
    exitCode: number,
    decision: { type: string; reason?: string; detail?: string },
    fields: { counters?: RoundCounters; sendBack?: SendBack | null; mergeable: string; files?: string[] }
  ) => ({
    exitCode,
    // What the Developer's turn answered is carried on, so the CI read that follows judges the same turn.
    stdout: recordOutput(results, state, {
      counters,
      answered: previous?.answered ?? null,
      ...fields,
      events,
      decision
    })
  })
  const prNumber = openPullRequestOf(task, 'check-mergeability')
  const mergeable = await pollMergeableState(prNumber, {
    ...gatePollOf(task),
    fetchMergeableState: task.bound?.fetchMergeableState ?? fetchMergeableState
  })
  // Mergeable: the stall check the Developer's turn left is the gate's to read next.
  if (mergeable !== 'CONFLICTING') return out(FORWARD, { type: 'mergeable' }, { mergeable })
  const files = (task.bound?.fetchConflictingFiles ?? fetchConflictingFiles)('main', task.branch)
  const head = safeRead(task.remoteHead) ?? judgedHeadOf(task)
  const sendBack: SendBack = { kind: 'conflict', headBefore: head, files }
  const stall = counters.stallCheck
  if (stall === null || previous?.answered !== 'conflict')
    return out(
      BACK,
      { type: 'dispatch_developer' },
      { counters: { ...counters, stallCheck: null }, sendBack, mergeable, files }
    )
  // The conflict turn moved nothing: a stall named by its refusal, else by the conflict itself.
  const streak = counters.gateStalledStreak + 1
  const stats = worktreeStats(task.worktreePath, 0)
  const named =
    stall.refusal !== null
      ? `publication refused: ${stall.refusal}`
      : `conflict never resolved (file(s): ${files.length > 0 ? files.join(', ') : '(unknown)'})`
  const detail = `head ${stall.headBefore} unchanged after dispatch; ${named}`
  const assessed = assessRound(state, { kind: 'mechanical_failure', round, failure: detail, stats }, task.clock)
  state = assessed.state
  events.push(...assessed.events)
  const paused = (decision: { reason: PauseReason; detail?: string }, error?: unknown) => {
    pauseThrough(task, 'check-mergeability', {
      reason: decision.reason,
      detail: decision.detail ?? decision.reason,
      ...(error === undefined ? {} : { error })
    })
    return out(BACK, { type: 'pause', ...decision }, { counters: NO_COUNTERS, sendBack, mergeable, files })
  }
  if (assessed.decision.type === 'pause') return paused(assessed.decision)
  if (streak < MAX_GATE_STALLED_TURNS)
    return out(
      BACK,
      { type: 'dispatch_developer' },
      { counters: { ...counters, gateStalledStreak: streak, stallCheck: null }, sendBack, mergeable, files }
    )
  events.push(...driverDecidedPauseEvents(loopIdOf(state), state, round, stats, 'infrastructure'))
  return paused({ reason: 'infrastructure', detail }, new Error(detail))
}

/**
 * The forge's mergeability, read again before publication as the standalone loop reads it: reviewers can work long
 * enough for an approved head to fall into conflict with the default branch. A conflicting head is never published:
 * the round's held verdicts are discarded, the completion events the live-check step deferred for this publication
 * are never handed on, the round does not advance, and the Developer is sent back with the conflicting files, so the
 * next reviewer dispatch judges the resolved head. An unresolved conflict is then bounded by the mergeability step
 * the resolved head passes through on its way back to the reviewers.
 */
async function checkPublishMergeability(
  task: TaskInput,
  context: ActionContext
): Promise<{ exitCode: number; stdout: string }> {
  const { results } = context
  const prNumber = openPullRequestOf(task, 'check-publish-mergeability')
  const mergeable = await pollMergeableState(prNumber, {
    ...gatePollOf(task),
    fetchMergeableState: task.bound?.fetchMergeableState ?? fetchMergeableState
  })
  if (mergeable !== 'CONFLICTING') return ok(JSON.stringify({ mergeable }))
  const files = (task.bound?.fetchConflictingFiles ?? fetchConflictingFiles)('main', task.branch)
  ;(task.bound?.discardHeldVerdicts ?? discardHeldVerdicts)(task.runtimeDir, task.issueNumber, task.reviewRound())
  const previous = latestRecord(results)
  const head = safeRead(task.remoteHead) ?? judgedHeadOf(task)
  return {
    exitCode: BACK,
    stdout: recordOutput(results, carriedLoopState(results, task.loopState), {
      counters: { ...(previous?.counters ?? NO_COUNTERS), stallCheck: null },
      sendBack: { kind: 'conflict', headBefore: head, files },
      decision: { type: 'dispatch_developer' },
      mergeable,
      files
    })
  }
}

/** Records how the pre-publication mergeability step routed; the decision on this step reads that step's exit result. */
export function classifyPublishMergeability(context: ActionContext): { exitCode: number; stdout: string } {
  const checked = context.results['check-publish-mergeability']
  if (!checked) throw new Error('classify-publish-mergeability ran before the mergeability step recorded a result')
  return ok(isSentBack(checked) ? 'developer' : 'publish')
}

/** Records how the mergeability step routed; the decision on this step reads that step's own exit result. */
export function classifyMergeability(context: ActionContext): { exitCode: number; stdout: string } {
  const checked = context.results['check-mergeability']
  if (!checked) throw new Error('classify-mergeability ran before the mergeability step recorded a result')
  return ok(isSentBack(checked) ? 'developer' : 'ci')
}

/** What the CI step recorded: the head it read, its conclusion, the failing check runs and the heads already rerun. */
export interface RecordedForgeCi {
  head: string | null
  /** `unpushed`: the worktree head is not on the remote, so no CI was read and the Developer publishes it first. */
  conclusion: 'green' | 'red' | 'pending' | 'skipped' | 'unpushed'
  failingChecks: string[]
  /** The heads whose failed jobs were rerun, each once. */
  rerunHeads: string[]
  /** The workflow runs this read reran, empty when it reran none. */
  rerunRunIds: number[]
}

/** The CI step's newest record, or null before it ran or when it recorded something unreadable. */
export function recordedForgeCi(results: Results): RecordedForgeCi | null {
  const stdout = stdoutOf(results['read-forge-ci'])
  if (!stdout) return null
  try {
    const parsed = JSON.parse(stdout) as Partial<RecordedForgeCi>
    return typeof parsed.conclusion === 'string'
      ? {
          head: parsed.head ?? null,
          conclusion: parsed.conclusion,
          failingChecks: parsed.failingChecks ?? [],
          rerunHeads: parsed.rerunHeads ?? [],
          rerunRunIds: parsed.rerunRunIds ?? []
        }
      : null
  } catch {
    return null
  }
}

/**
 * The forge's CI conclusion for the head (`fetchCiConclusion`, which leaves out the review gate and the test-plan
 * wait check), waited on while it reads pending within the gate poll budget; a budget spent on pending reads red,
 * as the standalone loop's gate wait does. A red head the Developer's turn left unchanged has its failed jobs rerun
 * once (`rerunFailedWorkflowJobs`) and is read again. A red local gate decides the round alone, so no CI is read;
 * a worktree head the remote does not hold reads `unpushed` (`unpushedHeadOf`), never polled.
 */
export async function readForgeCi(
  task: TaskInput,
  context: ActionContext
): Promise<{ exitCode: number; stdout: string }> {
  const { results } = context
  const prior = recordedForgeCi(results)
  const rerunHeads = prior?.rerunHeads ?? []
  const gate = results['run-mechanical-gates']
  if (gate !== undefined && gate.exitCode !== 0)
    return ok(JSON.stringify({ head: null, conclusion: 'skipped', failingChecks: [], rerunHeads, rerunRunIds: [] }))
  const unpushed = unpushedHeadOf(task)
  if (unpushed !== null)
    return ok(
      JSON.stringify({
        head: unpushed.head,
        remoteHead: unpushed.remoteHead,
        conclusion: 'unpushed',
        failingChecks: [],
        rerunHeads,
        rerunRunIds: []
      })
    )
  const head = judgedHeadOf(task)
  const readCi = task.bound?.fetchCiConclusion ?? fetchCiConclusion
  const poll = gatePollOf(task)
  const wait = () =>
    pollUntil(
      () => {
        const conclusion = readCi(head)
        return conclusion === 'pending' ? null : conclusion
      },
      poll.gatePollMaxAttempts,
      poll.gatePollIntervalMs,
      poll.sleep,
      `the CI read never resolved off 'pending' for head ${head} within the poll budget`
    ).catch(() => 'red' as const)
  let conclusion = await wait()
  const rerunRunIds: number[] = []
  const previous = latestRecord(results)
  const stall = previous?.counters.stallCheck ?? null
  const unchangedRedHead =
    conclusion === 'red' &&
    previous?.answered === 'gate-red' &&
    stall !== null &&
    stall.headBefore === head &&
    stall.refusal === null &&
    !rerunHeads.includes(head)
  if (unchangedRedHead) {
    const rerun = task.bound?.rerunFailedWorkflowJobs ?? rerunFailedWorkflowJobs
    for (const runId of (task.bound?.fetchFailedCheckWorkflowRunIds ?? fetchFailedCheckWorkflowRunIds)(head)) {
      try {
        rerun(runId)
        rerunRunIds.push(runId)
      } catch {
        // A run the forge refused to rerun keeps its failure; the others still rerun.
      }
    }
    if (rerunRunIds.length > 0) conclusion = await wait()
  }
  const failingChecks =
    conclusion === 'red'
      ? (task.bound?.fetchFailingCheckRuns ?? fetchFailingCheckRuns)(head).map(describeFailingCheckRun)
      : []
  return ok(
    JSON.stringify({
      head,
      conclusion,
      failingChecks,
      rerunHeads: rerunRunIds.length > 0 ? [...rerunHeads, head] : rerunHeads,
      rerunRunIds
    })
  )
}

/**
 * The dispatch gate's premise re-assertion against the pull request's live body at this head
 * (`checkPremiseAtHead`). A stale pin pauses through the handoff before any reviewer is dispatched; a body that
 * cannot be read, or carries no `Premise:` block, is dormant.
 */
function checkPremise(task: TaskInput): { exitCode: number; stdout: string; refused?: true } {
  const prNumber = openPullRequestOf(task, 'check-premise')
  const result = checkPremiseAtHead(prNumber, task.bound?.fetchPrBody ?? fetchPrBody)
  if (result === null || result.pass) return ok(JSON.stringify({ premise: result === null ? 'dormant' : 'holds' }))
  const failures = result.errors.map((error) => error.message)
  const head = worktreeHeadOf(task)
  pauseThrough(task, 'check-premise', {
    reason: 'escalation',
    detail: `a Premise pin no longer holds at ${head ?? 'the task head'}, so no reviewer is dispatched: ${failures.join('; ')}`
  })
  // A refusal: the re-pinned Premise is checked again when the run resumes.
  return { exitCode: 1, stdout: JSON.stringify({ premise: 'stale', head, failures }), refused: true }
}

/**
 * The round marker comment the standalone loop posts before its reviewers are dispatched
 * (`renderDeveloperRoundComment`): the judged head, the frozen manifest's ruling slot, and the finding ids and
 * checks the newest accepted Developer turn reported. Posted once per round and head.
 */
function postRoundMarker(task: TaskInput, results: Results, round: number, inputs: ReviewRoundInputs): void {
  const prNumber = openPullRequestOf(task, 'dispatch-reviewers')
  const head = inputs.manifest.headSha
  const turn = agentOutput(results, 'develop') as {
    turnResult?: {
      status?: unknown
      addressedFindingIds?: string[]
      reportedChecks?: { command: string; outcome: 'pass' | 'fail' }[] | null
    }
  }
  const completed = turn?.turnResult?.status === 'completed' ? turn.turnResult : null
  const post = task.bound?.postMarkedComment ?? postMarkedComment
  postForgeEffectOnce(task.runtimeDir, task.issueNumber, `developer-round-comment-${round}-${head}`, () =>
    post(
      'pr',
      String(prNumber),
      developerRoundMarker(round),
      renderDeveloperRoundComment(
        head,
        completed?.addressedFindingIds ?? [],
        completed?.reportedChecks ?? [],
        inputs.manifest.pauseBoundRuling ?? null
      )
    )
  )
}

export const ACTION_BINDINGS: Readonly<Record<string, Binding>> = {
  'vinaya.prepare-run': {
    adapts: [
      checkTaskDispatchReadiness,
      createTaskWorktree,
      cleanupAllReviewerIsolationArtifacts,
      enforcementControlsActive,
      probeAgentSandbox
    ],
    build: (task) => async () => {
      // Every refusal below is a pause through the handoff, never a thrown start: the run halts at this step's boundary,
      // the step unrecorded, so the resume after the cause is fixed runs it again and creates the worktree.
      const refuse = (request: PauseRequest) => refuseThrough(task, 'prepare-run', request)
      // The policy is read here, not when the run's input is built, so a failed read pauses instead of refusing entry.
      try {
        task.reviewPolicy?.()
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return refuse({
          reason: 'infrastructure',
          detail: `the review policy could not be read, so no verdict is cast under a default: ${reason}`,
          error
        })
      }
      // A prior run's reviewer candidates and scratch copies never leak into this one.
      ;(task.bound?.cleanupAllReviewerIsolationArtifacts ?? cleanupAllReviewerIsolationArtifacts)(
        task.runtimeDir,
        task.issueNumber
      )
      const controls = enforcementControlsActive([
        (task.bound?.localGateControl ?? (() => realLocalGateControl(task.repoRoot ?? process.cwd())))()
      ])
      if (!controls.active) {
        const detail = describeInactiveControls(controls)
        return refuse({ reason: 'infrastructure', detail, error: new Error(detail) })
      }
      const readiness = (task.bound?.checkTaskDispatchReadiness ?? checkTaskDispatchReadiness)(task.branch)
      if (!readiness.ready)
        return refuse({
          reason: 'escalation',
          detail: `the task is not ready to dispatch, so no worktree is created: ${readiness.output}`
        })
      ;(task.bound?.createTaskWorktree ?? createTaskWorktree)(task.branch)
      // The sandbox is proved by running a real command in it, before the first agent step.
      const plan = task.sandboxPlan?.() ?? null
      if (plan !== null) {
        const probe = await (task.bound?.probeAgentSandbox ?? probeAgentSandbox)(plan)
        if (!probe.ok) {
          const refusal = new DispatchSandboxRefused(
            { agent: plan.agent, error: probe.error },
            `task ${task.issueNumber}`
          )
          // A host-repair pause: addressed to the Operator, spends no infrastructure retry, never resumed by a ruling.
          return refuse({ reason: 'sandbox_refused', detail: refusal.message, error: refusal })
        }
      }
      return ok(readiness.output)
    }
  },
  'vinaya.reconcile-external-state': {
    adapts: [findOpenPrForBranch],
    build: (task) => () => {
      const open = (task.bound?.findOpenPrForBranch ?? findOpenPrForBranch)(task.branch)
      // The exit code is what the start decision reads: zero when no pull request is open yet.
      return { exitCode: open === null ? EXIT_NO_OPEN_PR : EXIT_OPEN_PR, stdout: JSON.stringify(open) }
    }
  },
  // The branch point itself is the Flow's decision on the reconcile step's result; this step records that it ran.
  'vinaya.choose-start': { adapts: [], build: () => () => ok() },
  'vinaya.prepare-sources': {
    adapts: [fetchSourceRevision, prepareSources],
    build: (task) => async () => {
      const revision = (task.bound?.fetchSourceRevision ?? fetchSourceRevision)(task.issueNumber)
      let prepared: Awaited<ReturnType<NonNullable<TaskInput['prepareSources']>>> | undefined
      try {
        prepared = await task.prepareSources?.()
      } catch (error) {
        // The reader itself failed — a missing worktree, a git that cannot run — so no source was judged missing.
        const reason = error instanceof Error ? error.message : String(error)
        return refuseThrough(task, 'prepare-sources', {
          reason: 'infrastructure',
          detail: `the required sources could not be read: ${reason}`,
          error
        })
      }
      if (prepared === undefined) return ok(revision)
      // A source the turn would have to take on memory pauses the run before the Developer is dispatched.
      if (prepared.unavailable.length > 0) {
        const unavailable = new RequiredSourcesUnavailable(prepared.unavailable)
        return refuseThrough(task, 'prepare-sources', {
          reason: 'missing_source',
          detail: unavailable.message,
          error: unavailable
        })
      }
      // The turn is judged against the sources the brief names, as the standalone loop does.
      task.developerContext = {
        ...task.developerContext,
        requiredSources: prepared.manifest.sources.map((source) => source.requirementText)
      }
      return ok(revision)
    }
  },
  'vinaya.validate-developer-output': {
    adapts: [validateDeveloperTurnResult, recordDeveloperAttempt, readUnpushedWorkDetail, assessRound],
    build: (task) => (context) => validateDeveloperOutput(task, context)
  },
  'vinaya.classify-developer-output': { adapts: [classifyDeveloperOutput], build: () => classifyDeveloperOutput },
  'harness.run-gates': {
    adapts: [runCliChecks],
    build: (task) => async (context) => {
      // A turn that only re-stated its confidence changed nothing: the head's gate result stands as read.
      const previous = context.results['run-mechanical-gates']
      if (previous && latestRecord(context.results)?.answered === 'ask-confidence')
        return { exitCode: previous.exitCode, stdout: stdoutOf(previous) ?? '' }
      const gates = await runCliChecks(
        task.cliEntry,
        task.worktreePath,
        pullRequestCheckEnv(task.branch, task.bound?.pullRequestView)
      )
      return { exitCode: gates.passed ? 0 : 1, stdout: gates.output }
    }
  },
  'vinaya.check-mergeability': {
    adapts: [pollMergeableState, fetchConflictingFiles, assessRound],
    build: (task) => (context) => checkMergeability(task, context)
  },
  'vinaya.classify-mergeability': { adapts: [classifyMergeability], build: () => classifyMergeability },
  'vinaya.read-forge-ci': {
    adapts: [fetchCiConclusion, rerunFailedWorkflowJobs],
    build: (task) => (context) => readForgeCi(task, context)
  },
  'vinaya.check-premise': { adapts: [checkPremiseAtHead], build: (task) => () => checkPremise(task) },
  'vinaya.assess-gate': { adapts: [assessRound], build: (task) => (context) => assessGate(task, context) },
  'vinaya.classify-gate-result': { adapts: [classifyGateResult], build: () => classifyGateResult },
  'vinaya.run-security-scan': {
    adapts: [decideSecurityScan, defaultRunSecurityScanSubprocess, resolveTrustAnchorSecurityScanCommand],
    build: (task) => () => {
      // The scan runs here, before either reviewer is dispatched and outside both reviewers' sandboxes. Its
      // outcome reaches the security reviewer's prompt only, and a scan that cannot run never stops the round.
      let outcome: SecurityScanOutcome
      try {
        const command = (
          task.bound?.resolveSecurityScanCommand ?? (() => resolveTrustAnchorSecurityScanCommand(loadTrustAnchorConfig))
        )()
        outcome = decideSecurityScan({
          command,
          changedPaths: command === null ? [] : (task.bound?.changedPaths ?? worktreeChangedPaths)(task.worktreePath),
          candidateDir: task.candidateDir?.() ?? null,
          runScan: task.bound?.runSecurityScan ?? defaultRunSecurityScanSubprocess
        })
      } catch (error) {
        outcome = { kind: 'failed', reason: error instanceof Error ? error.message : String(error) }
      }
      return ok(JSON.stringify(outcome))
    }
  },
  'vinaya.dispatch-reviewers': {
    adapts: [dispatchReviewers, persistManifestRecord, renderDeveloperRoundComment],
    build: (task) => (context) => {
      const round = task.reviewRound()
      const previous = recordedDispatch(context.results)
      const reviews = recordedReviews(context.results)
      // A fresh retry keeps the round's snapshot; a new round, a re-dispatch after moved inputs or a resumed pause takes one.
      const retry =
        previous !== null && previous.round === round && reviews?.round === round && reviews.next === 'retry'
      const inputs = retry ? previous.inputs : (task.reviewInputs?.(round) ?? null)
      // The round marker precedes the reviewers, as the standalone loop posts it; a stub run with no inputs posts none.
      // Version 2's rounds are local while no pull request is open: the Log holds them, and no marker is posted.
      const markerTarget =
        task.flow !== 'v2' ||
        safeRead(() => (task.bound?.findOpenPrForBranch ?? findOpenPrForBranch)(task.branch)) !== null
      if (inputs !== null && markerTarget) postRoundMarker(task, context.results, round, inputs)
      return ok(JSON.stringify({ round, attempt: retry ? previous.attempt + 1 : 1, inputs }))
    }
  },
  'vinaya.validate-reviewer-outputs': {
    adapts: [classifyReviewOutcome, writeHeldVerdict, buildManifestRecord],
    build: (task) => (context) => validateReviewerOutputs(task, context)
  },
  'vinaya.classify-reviewer-outputs': { adapts: [classifyReviewerOutputs], build: () => classifyReviewerOutputs },
  'vinaya.assess-round': {
    adapts: [assessRound],
    build: (task) => (context) => assessVerdictsAction(task, context)
  },
  'vinaya.build-revision-handoff': {
    adapts: [handoffFindings],
    build: (task) => (context) => {
      // Only a revise decision starts a new round; on publish the held verdicts stay bound to this round.
      const assessed = context.results['assess-round']
      const stdout = assessed && 'stdout' in assessed ? String(assessed.stdout) : ''
      let decision: string | undefined
      try {
        decision = (JSON.parse(stdout) as { decision?: { type?: string } }).decision?.type
      } catch (error) {
        throw new Error(
          `build-revision-handoff could not read the assess-round decision: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      if (typeof decision !== 'string')
        throw new Error(
          `build-revision-handoff found no decision type in the assess-round output: ${stdout.slice(0, 200)}`
        )
      if (decision === 'publish') return ok()
      // A pause does not end the round: the ruling that resumes it sends the Developer back to the same round,
      // so the round stays open and no verdict is consumed.
      if (decision === 'pause') return ok(JSON.stringify(handoffFindings(task.reviewRound())))
      return ok(JSON.stringify(handoffFindings(task.reviewRound(), ...task.verdicts(context.results))))
    }
  },
  'vinaya.run-live-checks': {
    adapts: [runLiveChecks, routeCompletionEvents],
    build: (task) => async (context) => {
      const assessment = readAssessment(context.results)
      if (assessment.decision.type !== 'publish')
        throw new Error(`run-live-checks reached after a ${assessment.decision.type} decision, not a publish`)
      const readHead = task.bound?.readWorktreeHead ?? readWorktreeHead
      const head = readHead(task.worktreePath)
      if (head === null) throw new Error(`run-live-checks could not read the head of ${task.worktreePath}`)
      if (task.frozenBrief === undefined) throw new Error('run-live-checks has no frozen brief wired to read')
      // Fails closed: a brief that cannot be read, or whose `[live]` lines cannot be learned, stops the run.
      let commands: string[]
      try {
        commands = parseLiveTestPlanItems(task.frozenBrief())
      } catch (error) {
        throw new Error(
          `the live check could not read the frozen brief's [live] lines at ${head}: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      const failures = commands.length === 0 ? [] : await runLiveGate(task, head, commands)
      if (failures.length === 0) {
        // The approval stands: the journal's close waits for the publish step, everything else is logged now.
        const routed = routeCompletionEvents(assessment.events, 'publish')
        return ok(
          JSON.stringify({
            outcome: 'publish',
            head,
            events: routed.toLogNow,
            deferred: routed.toDeferUntilPublish
          })
        )
      }
      // A failed line withdraws the approval: the round's held verdicts are never published.
      const round = task.reviewRound()
      ;(task.bound?.discardHeldVerdicts ?? discardHeldVerdicts)(task.runtimeDir, task.issueNumber, round)
      const atCap = round >= assessment.state.config.maxRounds
      const withdrawn = withdrawApprovedRound(assessment.events, assessment.state, atCap)
      const routed = routeCompletionEvents(withdrawn.events, atCap ? 'pause' : 'dispatch_developer')
      const stdout = recordOutput(context.results, withdrawn.state, {
        outcome: atCap ? 'pause' : 'revise',
        head,
        failures,
        withdrawal: renderLiveWithdrawal(head, failures),
        events: routed.toLogNow,
        deferred: routed.toDeferUntilPublish,
        sendBack: { kind: 'live-red' }
      })
      // At the round cap the failed line is the principal item: the withdrawn round pauses `max_rounds`, logged as
      // a `principal_item` pause, and the handoff makes it durable, as the standalone loop does. A line the host
      // cannot run is recorded unverified instead and held by the merge gate like an unticked principal item.
      if (atCap) {
        if (!task.handoff) throw new Error('run-live-checks decided a pause but no handoff is wired to make it durable')
        task.handoff.pause({
          reason: 'max_rounds',
          detail: `max rounds: ${assessment.state.config.maxRounds} — both reviewers approved ${head}, but its \`[live]\` line(s) failed: ${failures.map((f) => `\`${f.command}\` (${f.detail})`).join(', ')}`
        })
      } else {
        // The round advances exactly as it does for a reviewer's blocking finding.
        task.seedRound?.(round + 1)
      }
      return { exitCode: 1, stdout }
    }
  },
  'vinaya.classify-live-result': {
    adapts: [isLiveWithdrawn],
    build: () => (context) => {
      const live = context.results['run-live-checks']
      if (!live) throw new Error('classify-live-result ran before the live-check step recorded a result')
      return ok(isLiveWithdrawn(live) ? 'withdrawn' : 'approved')
    }
  },
  'vinaya.check-publish-mergeability': {
    adapts: [pollMergeableState, fetchConflictingFiles, discardHeldVerdicts],
    build: (task) => (context) => checkPublishMergeability(task, context)
  },
  'vinaya.classify-publish-mergeability': {
    adapts: [classifyPublishMergeability],
    build: () => classifyPublishMergeability
  },
  'harness.publish': {
    adapts: [publishRound, upsertDeferredFindingsIssue],
    build: (task) => (context) => {
      const findPr = task.bound?.findOpenPrForBranch ?? findOpenPrForBranch
      const readHead = task.bound?.readWorktreeHead ?? readWorktreeHead
      const publish = task.bound?.publishRound ?? publishRound
      const pr = findPr(task.branch)
      if (pr === null) throw new Error(`harness.publish found no open pull request for branch ${task.branch}`)
      const expectedHead = readHead(task.worktreePath)
      if (expectedHead === null) throw new Error(`harness.publish could not read the head of ${task.worktreePath}`)
      const results = context?.results ?? {}
      // The findings the rounds set aside are tracked in one Issue for the pull request; a run that
      // set none aside opens nothing.
      const deferredFindings = recordedDeferredFindings(results)
      const deferredIssue =
        deferredFindings.length > 0
          ? (task.bound?.writeDeferredFindingsIssue ?? upsertDeferredFindingsIssue)({
              prNumber: pr.number,
              entries: deferredFindings
            })
          : undefined
      // The publication carries the manifest the round's reviewers were dispatched against, never one rebuilt now.
      const manifest = dispatchedManifest(results)
      publish(task.runtimeDir, {
        ...task.publish({
          prNumber: pr.number,
          expectedHead,
          round: task.reviewRound(),
          ...(manifest === undefined ? {} : { manifest })
        }),
        ...(deferredIssue === undefined ? {} : { deferredIssue })
      })
      // The publication succeeded: the journal's close, held back by the live-check step, is this step's to hand on.
      return ok(JSON.stringify({ events: heldCompletionEvents(results) }))
    }
  }
}

/**
 * Runs every `[live]` line the host can run on the approved `head`, in a fresh checkout of it, and writes
 * the outcomes to the pull request's live record. Returns the lines that failed. A line already recorded
 * passed at this head does not run again; a record that cannot be written is left for the next run.
 */
async function runLiveGate(task: TaskInput, head: string, commands: readonly string[]): Promise<LiveFailure[]> {
  const bound = task.bound
  const pr = (bound?.findOpenPrForBranch ?? findOpenPrForBranch)(task.branch)
  const readBody = bound?.fetchPrBody ?? fetchPrBody
  let body: string | null
  try {
    body = pr === null ? null : readBody(pr.number)
  } catch {
    body = null
  }
  const previous = body === null ? [] : readLiveRecord(body)
  if (livePassedAtHead(commands, head, previous)) return []
  const signedIn = bound?.liveVendorSignedIn ?? ((vendor) => vendorSignedIn(vendor))
  // A checkout is prepared only when some line can run here.
  const anyRunnable = commands.some((command) => liveVendorsNamed(command).every(signedIn))
  const repoRoot = task.repoRoot ?? task.worktreePath
  const checkout = anyRunnable ? await (bound?.prepareLiveCheckout ?? prepareRealLiveCheckout)(repoRoot, head) : null
  let result: Awaited<ReturnType<typeof runLiveChecks>>
  try {
    result = await runLiveChecks({
      commands,
      head,
      cwd: checkout !== null && 'cwd' in checkout ? checkout.cwd : repoRoot,
      previous,
      cannotRun:
        checkout !== null && 'error' in checkout
          ? `the review loop could not prepare a clean checkout of this head (${checkout.error})`
          : null,
      signedIn,
      run: bound?.runLiveCommand ?? runRealLiveCommand,
      timeoutMs: bound?.liveRunTimeoutMs ?? LIVE_RUN_TIMEOUT_MS
    })
  } finally {
    if (checkout !== null && 'dispose' in checkout) checkout.dispose()
  }
  if (pr !== null) {
    try {
      const current = readBody(pr.number)
      const next = withLiveRecord(current, result.entries)
      if (next !== current)
        await (bound?.updatePrBody ?? defaultUpdatePrBody)({ prNumber: pr.number, body: next, repo: null })
    } catch {
      // The record is the driver's alone and the next run writes it.
    }
  }
  return result.failures
}

/**
 * The plan that proves the Developer's sandbox for the launch shape `vendor` generated: the settings file
 * Claude launches with, or the Codex configuration its `CODEX_HOME` holds, run from the task worktree with the
 * launcher's own environment over the agent environment allowlist.
 */
export function sandboxProbePlanFor(
  vendor: 'claude-code' | 'codex',
  launcher: Pick<RoleBinaryConfig, 'command' | 'env'>,
  generatedDir: string,
  cwd: string,
  sourceEnv: Readonly<Record<string, string | undefined>> = process.env
): SandboxProbePlan {
  const env: NodeJS.ProcessEnv = {}
  for (const key of agentEnvAllowlist()) if (sourceEnv[key] !== undefined) env[key] = sourceEnv[key]
  Object.assign(env, launcher.env)
  if (vendor === 'claude-code')
    return {
      agent: 'claude',
      binaryPath: launcher.command,
      cwd,
      env,
      settingsPath: join(generatedDir, 'role-settings.json')
    }
  return {
    agent: 'codex',
    binaryPath: launcher.command,
    cwd,
    env,
    configToml: readFileSync(join(generatedDir, 'config.toml'), 'utf8'),
    // The Engine's generated configuration names every writable root itself.
    withWritableDirs: (args) => [...args]
  }
}

/** The action registry for one task: each binding's action, built over that task's input. */
export function createActions(task: TaskInput): ActionRegistry {
  return Object.fromEntries(Object.entries(ACTION_BINDINGS).map(([name, binding]) => [name, binding.build(task)]))
}

/** Deciding step id to its boolean, read from the examined step's exit result. */
export const decisions: DecisionRegistry = {
  'choose-start': isDevelopmentDue,
  'classify-developer-output': isSentBack,
  'classify-mergeability': isSentBack,
  'classify-gate-result': isGateRed,
  'classify-reviewer-outputs': isSentBack,
  'build-revision-handoff': isRevisionRequested,
  'classify-live-result': isLiveWithdrawn,
  'classify-publish-mergeability': isSentBack
}

const executing = join(import.meta.dir)

/** Role launchers from the roles' grants files, one generated settings set per role under `generatedRoot`. */
export function createRoleLaunchers(options: {
  vendor: 'claude-code' | 'codex'
  generatedRoot: string
  variables?: Record<string, string>
  mcpCommand?: string
  /** A role-specific bridge command; takes precedence over the shared command. */
  mcpCommands?: Readonly<Record<string, string>>
  /** Replaces a `process-supplied` model in every role's grants for this run. */
  model?: string
  /** Claude's sandbox may use Unix sockets (the Linux host opt-in); the Codex adapter has no such filter. */
  allowUnixSockets?: boolean
  /** Copy the operator's Codex subscription login into each Codex role's generated CODEX_HOME (a live run). */
  stageCodexLogin?: boolean
  /** The ceiling in milliseconds each role launches with, by role name; a role absent from it keeps the executor's own bound. */
  timeouts?: Readonly<Record<string, number>>
}): RoleLauncher {
  const launchers: Record<string, ReturnType<typeof createRoleLauncher>> = {}
  for (const role of ROLE_NAMES) {
    const grants = withModel(loadRoleGrants(join(executing, role, 'grants.yaml')), options.model)
    const outputSchemaPath = join(executing, role, 'output.schema.json')
    const generatedDir = join(options.generatedRoot, role)
    const paths: GeneratorPaths = {
      generatedDir,
      outputSchemaPath,
      outputSchema: JSON.parse(readFileSync(outputSchemaPath, 'utf8')),
      mcpCommand: options.mcpCommands?.[role] ?? options.mcpCommand,
      variables: options.variables,
      allowUnixSockets: options.allowUnixSockets
    }
    const generated: GeneratedAgentConfig =
      options.vendor === 'claude-code' ? generateClaudeSettings(grants, paths) : generateCodexConfig(grants, paths)
    launchers[role] = createRoleLauncher(generated, {
      generatedDir,
      allowedPermissions: [`${role}/grants.yaml`],
      stageCodexLogin: options.stageCodexLogin === true,
      ...(options.timeouts?.[role] === undefined ? {} : { timeoutMs: options.timeouts[role] })
    })
  }
  return launchers
}
