import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  assessRound,
  parseLiveTestPlanItems,
  readLiveRecord,
  withLiveRecord,
  type DevReviewLoopEventInput,
  type LoopState,
  type Observations,
  type ReviewInputManifest,
  type TaskClock,
  type VerdictObservation
} from '@attalabs/aeg-core'
import type { RoleBinaryConfig, StepNodeResult } from '@atta/executor-agent-spawn'
import { generateClaudeSettings } from '../../../harness/adapters/agents/claude-code/settings'
import { generateCodexConfig } from '../../../harness/adapters/agents/codex/config'
import { loadRoleGrants, ROLE_NAMES, withModel } from '../../../harness/adapters/agents/manifest'
import { structuredResult } from '../../../harness/adapters/agents/structured-result'
import { pullRequestCheckEnv, type PullRequestView } from './pull-request-env'
import type { Handoff, InputVersions, PauseRequest } from './handoff'
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
  type reviewPolicyForLoop
} from '../../../apps/cli/src/lib/dev-review-loop/developer-dispatch'
import { DispatchSandboxRefused } from '../../../apps/cli/src/lib/dev-review-loop/round-assess'
import { cleanupAllReviewerIsolationArtifacts } from '../../../apps/cli/src/lib/dev-review-loop/reviewer-isolation'
import { normalizeSourceIdentity } from '../../../apps/cli/src/lib/dev-review-loop/turn-result'
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
import { publishRound, type PublishInput } from '../../../apps/cli/src/lib/dev-review-loop/publication'
import {
  defaultRunSecurityScanSubprocess,
  defaultUpdatePrBody,
  deferredEntriesForRound,
  handoffFindings
} from '../../../apps/cli/src/lib/dev-review-loop'
import { loadTrustAnchorConfig } from '../../../apps/cli/src/lib/config'
import { readWorktreeHead } from '../../../apps/cli/src/lib/dev-review-loop/gate-reading'
import {
  decideSecurityScan,
  discardHeldVerdicts,
  writeHeldVerdict,
  type SecurityScanOutcome,
  type SecurityScanRun
} from '../../../apps/cli/src/lib/dev-review-loop/reviewer-dispatch'
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
  upsertDeferredFindingsIssue,
  type DeferredFindingEntry,
  type DeferredFindingsIssueRef
} from '../../../apps/cli/src/lib/forge-write'
import {
  parseDeveloperTurnResult,
  type DeveloperTurnSchemaContext
} from '../../../apps/cli/src/lib/developer-turn-result'
import { parseReviewResult, type ReviewResult } from '../../../apps/cli/src/lib/review-result'

// The mechanical actions, decisions and role launchers of the developer
// review Flow. Each action adapts one function the review loop already
// has; the adaptation here is only argument and result shaping, exercised
// with stubs.

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
  /** The loop state the first `assessRound` starts from; later assessments start from the previous assessment's recorded state. */
  loopState: LoopState
  clock?: TaskClock
  /** The round's review round number, as `handoffFindings` counts it. */
  reviewRound: () => number
  /** Moves the review round forward to `round` (never back), for a run that continues rounds the forge already holds. */
  seedRound?: (round: number) => void
  /** The review-input manifest of the task head as it stands now, or null when it cannot be built. */
  currentManifest?: () => ReviewInputManifest | null
  /** What the round's gate and verdicts amount to, read from the recorded results. */
  observe: (results: Readonly<Record<string, StepNodeResult>>) => Observations
  /**
   * The reviewer prompt for `role`, built over this round's staged candidate and the security-scan step's
   * recorded outcome (absent in stub runs).
   */
  reviewerPrompt?: (
    role: 'reviewer' | 'security',
    results: Readonly<Record<string, StepNodeResult>>
  ) => string | Promise<string>
  /** The round's staged, head-verified candidate copy the security scan runs over, or null when none could be staged. */
  candidateDir?: () => string | null
  /** The task's frozen brief, whose `[live]` Test Plan lines the live-check step runs. */
  frozenBrief?: () => string
  /** The reviewers' verdicts for the round, read from the recorded results. */
  verdicts: (results: Readonly<Record<string, StepNodeResult>>) => readonly VerdictObservation[]
  /**
   * The `publishRound` input for the pull request and judged head found when the step runs: the
   * pull request does not exist when the task starts, and the head moves with every revision.
   */
  publish: (at: PublishTarget) => PublishInput
  /** Renders one reviewer's validated result as the comment text held for publication. */
  renderVerdict: (role: HeldVerdictRole, review: ReviewResult) => string
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
}

/** What only the moment of publication knows. */
export interface PublishTarget {
  prNumber: number
  expectedHead: string
  round: number
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
}

interface Binding {
  /** The functions this action adapts, by identity. */
  adapts: readonly ((...args: never[]) => unknown)[]
  build: (task: TaskInput) => ProcessAction
}

/**
 * The gate observation for `round`, read from the recorded gate step's result (green when it exited zero,
 * its wall time) and the task worktree's diff against main, with the Developer's stated confidence.
 * Throws when the gate step has no recorded result, or recorded a red one: the Flow reaches the
 * assessment only after a green gate, so a red one here is a wiring fault, never a judgement.
 */
export function gateObservation(
  worktreePath: string,
  round: number,
  results: Readonly<Record<string, StepNodeResult>>
): Observations {
  const gate = results['run-mechanical-gates']
  if (!gate) throw new Error('assess-round found no recorded result for the gate step run-mechanical-gates')
  const green = gate.exitCode === 0
  if (!green) throw new Error(`assess-round reached after a red gate (run-mechanical-gates exited ${gate.exitCode})`)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: worktreePath, encoding: 'utf8' }).trim()
  const head = git('rev-parse', 'HEAD')
  const baseHead = git('merge-base', 'origin/main', head)
  const short = git('diff', '--shortstat', baseHead, head)
  const count = (pattern: RegExp) => Number(pattern.exec(short)?.[1] ?? 0)
  const turn = agentOutput(results, 'develop') as {
    turnResult?: { confidence?: number; confidenceExplanation?: string }
  }
  const value = turn?.turnResult?.confidence
  return {
    kind: 'gate',
    round,
    green,
    confidence: typeof value === 'number' ? { value, reason: turn.turnResult?.confidenceExplanation } : 'absent',
    stats: {
      baseHead,
      head,
      filesChanged: count(/(\d+) files? changed/),
      insertions: count(/(\d+) insertions?/),
      deletions: count(/(\d+) deletions?/),
      wallMs: gate.kind === 'mechanical' ? gate.durationMs : 0
    }
  }
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

/**
 * The loop state the next assessment starts from: the state recorded in the previous assessment's step result,
 * or `initial` before any assessment ran. The recorded state is the checkpointed one, so a resumed run carries it
 * forward; a round number below `initial`'s never replaces it. A recorded result with no readable state throws,
 * since falling back to `initial` would silently restart the round count.
 */
export function carriedLoopState(results: Readonly<Record<string, StepNodeResult>>, initial: LoopState): LoopState {
  const previous = results['assess-round']
  if (!previous || !('stdout' in previous)) return initial
  let recorded: LoopState | undefined
  try {
    const parsed = JSON.parse(String(previous.stdout)) as { state?: unknown }
    if (parsed.state !== undefined) recorded = decodeLoopState(JSON.stringify(parsed.state))
  } catch {
    // Reported below with the rest of the unreadable cases.
  }
  if (!recorded) throw new Error('assess-round found a previous assessment result with no readable loop state')
  // A live check that withdrew the approval of that very assessment recorded the state the next assessment starts from.
  const live = results['run-live-checks']
  if (live && 'stdout' in live) {
    try {
      const parsed = JSON.parse(String(live.stdout)) as { state?: unknown; from?: unknown }
      if (parsed.state !== undefined && parsed.from === roundOf(recorded))
        recorded = decodeLoopState(JSON.stringify(parsed.state))
    } catch {
      // A live result with no readable state leaves the assessment's own.
    }
  }
  return roundOf(recorded) < roundOf(initial) ? initial : recorded
}

/** What the assess-round step recorded: its decision, the Log events and the state it ended on, and the findings it set aside so far. */
export interface RecordedAssessment {
  decision: { type: string; reason?: string; detail?: string }
  events: DevReviewLoopEventInput[]
  state: LoopState
  deferredFindings: DeferredFindingEntry[]
}

/** The assessment the assess-round step recorded; throws when it recorded none or something unreadable. */
export function readAssessment(results: Readonly<Record<string, StepNodeResult>>): RecordedAssessment {
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
function recordedDeferredFindings(results: Readonly<Record<string, StepNodeResult>>): DeferredFindingEntry[] {
  const previous = results['assess-round']
  if (!previous || !('stdout' in previous)) return []
  try {
    const parsed = JSON.parse(String(previous.stdout)) as { deferredFindings?: unknown }
    return Array.isArray(parsed.deferredFindings) ? (parsed.deferredFindings as DeferredFindingEntry[]) : []
  } catch {
    return []
  }
}

/** The completion events the live-check step held back until publication — the journal's close; none before it ran. */
function heldCompletionEvents(results: Readonly<Record<string, StepNodeResult>>): DevReviewLoopEventInput[] {
  const live = results['run-live-checks']
  if (!live || !('stdout' in live)) return []
  try {
    const parsed = JSON.parse(String(live.stdout)) as { outcome?: unknown; deferred?: unknown }
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
export function recordedScanOutcome(
  results: Readonly<Record<string, StepNodeResult>>
): SecurityScanOutcome | undefined {
  const scan = results['run-security-scan']
  if (!scan || !('stdout' in scan)) return undefined
  try {
    return JSON.parse(String(scan.stdout)) as SecurityScanOutcome
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

const roundOf = (state: LoopState): number => Math.max(state.rounds.length, state.pending?.round ?? 0)

const ok = (stdout = ''): { exitCode: number; stdout: string } => ({ exitCode: 0, stdout })

/** The final structured record an agent step reported, or undefined for a step that is not one. */
export function agentOutput(results: Readonly<Record<string, StepNodeResult>>, step: string): unknown {
  const result = results[step]
  if (result?.kind !== 'agent-spawn') return undefined
  return structuredResult(result.events)
}

/** The gate step's recorded exit result is red when it did not exit zero. */
export function isGateRed(examined: StepNodeResult): boolean {
  return examined.exitCode !== 0
}

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

/** Records whether the gate step ended red; the decision on this step reads the gate's own exit result. */
export function classifyGateResult(context: ActionContext): { exitCode: number; stdout: string } {
  const gate = context.results['run-mechanical-gates']
  if (!gate) throw new Error('classify-gate-result ran before the gate step recorded a result')
  return ok(isGateRed(gate) ? 'red' : 'green')
}

/** Records that both reviewers are due; the reviewer steps themselves launch after this one. */
export function dispatchReviewers(): { exitCode: number; stdout: string } {
  return ok('code-review,security-review')
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
      // Every refusal below is a pause through the handoff, never a thrown start: the run halts at this step's boundary.
      const refuse = (request: PauseRequest): { exitCode: number; stdout: string } => {
        if (!task.handoff)
          throw new Error(`prepare-run refused (${request.reason}) but no handoff is wired to make it durable`)
        task.handoff.pause(request)
        return { exitCode: 1, stdout: request.detail }
      }
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
      if (!readiness.ready) return { exitCode: 1, stdout: readiness.output }
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
      const prepared = await task.prepareSources?.()
      if (prepared === undefined) return ok(revision)
      // A source the turn would have to take on memory pauses the run before the Developer is dispatched.
      if (prepared.unavailable.length > 0) {
        if (!task.handoff)
          throw new Error('prepare-sources found an unreadable source but no handoff is wired to make it durable')
        const unavailable = new RequiredSourcesUnavailable(prepared.unavailable)
        task.handoff.pause({ reason: 'missing_source', detail: unavailable.message, error: unavailable })
        return { exitCode: 1, stdout: unavailable.message }
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
    adapts: [parseDeveloperTurnResult],
    build: (task) => (context) => {
      const validation = parseDeveloperTurnResult(agentOutput(context.results, 'develop'), task.developerContext)
      // The Flow has no human-handoff step, so an invalid turn ends the run as failed.
      if (!validation.ok)
        throw new Error(`Developer output failed ${validation.stage} validation: ${validation.errors.join('; ')}`)
      // A citation counts only behind a delivery receipt the controller recorded, never the Developer's word.
      if (validation.result.status === 'completed') {
        const counted = new Set(
          countedSourceIds(
            readSourceDeliveryReceipts(sourceReceiptsPath(sourceStoreDir(task.runtimeDir, task.issueNumber)))
          ).map(normalizeSourceIdentity)
        )
        const unread = (validation.result.sourceUses ?? []).filter(
          (use) => !counted.has(normalizeSourceIdentity(use.source))
        )
        if (unread.length > 0)
          throw new Error(
            `Developer output cites required source(s) with no delivery receipt the controller recorded: ${unread.map((use) => use.source).join(', ')}`
          )
      }
      return ok()
    }
  },
  'harness.run-gates': {
    adapts: [runCliChecks],
    build: (task) => async () => {
      const gates = await runCliChecks(
        task.cliEntry,
        task.worktreePath,
        pullRequestCheckEnv(task.branch, task.bound?.pullRequestView)
      )
      return { exitCode: gates.passed ? 0 : 1, stdout: gates.output }
    }
  },
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
  'vinaya.dispatch-reviewers': { adapts: [dispatchReviewers], build: () => dispatchReviewers },
  'vinaya.validate-reviewer-outputs': {
    adapts: [parseReviewResult, writeHeldVerdict],
    build: (task) => (context) => {
      const write = task.bound?.writeHeldVerdict ?? writeHeldVerdict
      const held: Array<[HeldVerdictRole, ReviewResult]> = []
      for (const [step, role] of [
        ['code-review', 'reviewer'],
        ['security-review', 'security']
      ] as const) {
        const validation = parseReviewResult(agentOutput(context.results, step))
        if (!validation.ok)
          throw new Error(`${step} output failed ${validation.stage} validation: ${validation.errors.join('; ')}`)
        held.push([role, validation.result])
      }
      // Nothing is held until both verdicts validated, so a round never holds one reviewer's verdict alone.
      const round = task.reviewRound()
      for (const [role, review] of held)
        write(task.runtimeDir, task.issueNumber, round, role, task.renderVerdict(role, review))
      return ok()
    }
  },
  'vinaya.assess-round': {
    adapts: [assessRound],
    build: (task) => {
      return (context) => {
        let state = carriedLoopState(context.results, task.loopState)
        // assessRound reads a round as a gate observation, then the verdicts; the Flow reaches this step only
        // after a green gate, so the gate observation is recorded here first when the state has no pending round.
        const observation = task.observe(context.results)
        const gateEvents: unknown[] = []
        if (observation.kind === 'verdicts' && (state.pending === null || state.pending.round !== observation.round)) {
          const gate = assessRound(
            state,
            gateObservation(task.worktreePath, observation.round, context.results),
            task.clock
          )
          state = gate.state
          gateEvents.push(...gate.events)
        }
        const assessment = assessRound(state, observation, task.clock)
        state = assessment.state
        const { decision } = assessment
        // The gate's events come first, as the standalone loop records them, then the verdicts'.
        const events = [...gateEvents, ...assessment.events]
        // The Log events the assessment produced travel in the step's result; the log producers read them back.
        // The findings set aside rather than let block, round by round, for the publish step to track.
        const deferredFindings = [
          ...recordedDeferredFindings(context.results).filter(
            (entry) => observation.kind !== 'verdicts' || entry.round !== observation.round
          ),
          ...(observation.kind === 'verdicts' ? deferredEntriesForRound(observation.round, observation.verdicts) : [])
        ]
        const stdout = JSON.stringify({
          decision,
          events,
          state: JSON.parse(encodeLoopState(state)),
          deferredFindings
        })
        if (decision.type === 'pause') {
          // The pause is a decision, not a failure: it is handed off and the run halts at this step's boundary.
          if (!task.handoff) throw new Error('assess-round decided a pause but no handoff is wired to make it durable')
          task.handoff.pause({ reason: decision.reason, detail: decision.detail ?? decision.reason })
        }
        return { exitCode: decision.type === 'publish' ? 0 : 1, stdout }
      }
    }
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
      const from = roundOf(assessment.state)
      if (failures.length === 0) {
        // The approval stands: the journal's close waits for the publish step, everything else is logged now.
        const routed = routeCompletionEvents(assessment.events, 'publish')
        return ok(
          JSON.stringify({
            outcome: 'publish',
            head,
            events: routed.toLogNow,
            deferred: routed.toDeferUntilPublish,
            from
          })
        )
      }
      // A failed line withdraws the approval: the round's held verdicts are never published.
      const round = task.reviewRound()
      ;(task.bound?.discardHeldVerdicts ?? discardHeldVerdicts)(task.runtimeDir, task.issueNumber, round)
      const atCap = round >= assessment.state.config.maxRounds
      const withdrawn = withdrawApprovedRound(assessment.events, assessment.state, atCap)
      const routed = routeCompletionEvents(withdrawn.events, atCap ? 'pause' : 'dispatch_developer')
      const stdout = JSON.stringify({
        outcome: atCap ? 'pause' : 'revise',
        head,
        failures,
        withdrawal: renderLiveWithdrawal(head, failures),
        events: routed.toLogNow,
        deferred: routed.toDeferUntilPublish,
        state: JSON.parse(encodeLoopState(withdrawn.state)),
        from
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
      // The findings the rounds set aside are tracked in one Issue for the pull request; a run that
      // set none aside opens nothing.
      const deferredFindings = recordedDeferredFindings(context?.results ?? {})
      const deferredIssue =
        deferredFindings.length > 0
          ? (task.bound?.writeDeferredFindingsIssue ?? upsertDeferredFindingsIssue)({
              prNumber: pr.number,
              entries: deferredFindings
            })
          : undefined
      publish(task.runtimeDir, {
        ...task.publish({ prNumber: pr.number, expectedHead, round: task.reviewRound() }),
        ...(deferredIssue === undefined ? {} : { deferredIssue })
      })
      // The publication succeeded: the journal's close, held back by the live-check step, is this step's to hand on.
      return ok(JSON.stringify({ events: heldCompletionEvents(context?.results ?? {}) }))
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
  'classify-gate-result': isGateRed,
  'build-revision-handoff': isRevisionRequested,
  'classify-live-result': isLiveWithdrawn
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
