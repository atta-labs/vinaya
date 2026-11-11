import type { PauseState } from './pause-resume.js'
import type { readDriverLock, recoverLoopState } from './pause-resume.js'
import type { ReconstructedJournal } from '../../../../tools/dev-review-policy/journal-reconstruction'
import type { TurnWriteAttribution } from '../../../../../../kernel/isolation/worker-boundary.js'
import type { RequiredSourceManifest } from '../../../../../../kernel/source-manifest.js'
import type { DeveloperDispatchHistory } from './round-assess.js'
import type { createDriverExitRecorder } from './driver-lifecycle.js'
/**
 * `dev-review-loop`'s per-run context — the one object the round loop, the helpers it calls and the run phases
 * share, so a helper can live in its own module instead of closing over the driver's
 * locals. Created once per run inside `devReviewLoop`, never at module level.
 */

import type {
  Decision,
  DevReviewLoopEventInput,
  LoopConfig,
  LoopState
} from '../../../../tools/dev-review-policy/types'

import type { ReviewInputManifest } from '../../../../tools/task-contract/review-input-manifest'
import type { ReviewPolicy } from '../../../../tools/task-contract/review-policy'
import type { RoundHeadIdentity } from '../../../../../../kernel/connectors/checkpoint/control-store/index'
import type { Role } from '../../../../../../kernel/log/schema'
import type { AgentVendor } from '../../dispatch/dispatch.js'
import type { DeferredFindingEntry } from '../../../../tools/task-contract/forge/forge-write.js'
import type { createVinayaLogSink } from '../../../../integration/log/log-sink-factory.js'
import type { resolveRepo } from '../../../../../../kernel/adapters/code-host/github/resolve-repo'

import type { DeveloperHandoff } from './round-assess.js'
import type { createLivePublicationState } from '../../actions/live-developer-context.js'
import type { FailedCheckLog } from '../../../../../../kernel/tools/failed-check-log.js'

import type { LoopDeps, LoopInput } from '../dev-review-loop.js'

/**
 * The state one `devReviewLoop` run shares between its round loop, the helpers the loop calls and the
 * run phases — one object per run, created at the top of `devReviewLoop`,
 * never held at module level (two drivers run in one process in tests).
 *
 * The context carries:
 *  - the run's mutable locals (`round`, `decision`, `state`, the pause and wait counters, ...), which live
 *    here and nowhere else, so the code that moved and the code that stayed read and write the same cell;
 *  - values fixed once the run's setup finishes (`task`, `branch`, the log sink, the policy-independent
 *    configuration), copied in before the first round runs;
 *  - lifecycle resources (the log sink, heartbeat stopper and exit recorder). Phase helpers are direct
 *    imports that take this context, rather than callbacks stored on it.
 */
export type LoopRunContext = {
  // --- fixed for the whole run
  d: LoopDeps
  input: LoopInput
  root: string
  task: number
  branch: string
  dispatchAgent: AgentVendor
  dispatchModel: string | undefined
  pauseBoundRuling: import('../../../../tools/task-contract/review-input-manifest').PauseBoundRuling | null
  log: ReturnType<typeof createVinayaLogSink>['log']
  runId: string
  loopLogPath: string
  repo: Awaited<ReturnType<typeof resolveRepo>> | null
  config: LoopConfig
  deferredByRound: Map<number, DeferredFindingEntry[]>
  rerunHeads: Set<string>
  publicationState: ReturnType<typeof createLivePublicationState>

  // --- mutable, shared by the round loop and the code that stayed in `devReviewLoop`
  prNumber: number
  issueRulingsOwed: boolean
  keepLockAlive: boolean
  roleDispatchesInPass: number
  rateLimitWaits: number
  roundAtLastWait: number
  lastRateLimitResetEpoch: number | null
  answeredConnectionRetries: number
  roundAtLastConnectionRetry: number
  policy: ReviewPolicy
  lastHandoffFindings: { id: string; line: string }[] | null
  state: LoopState
  round: number
  infrastructureRetries: number
  heldResultIdentity: RoundHeadIdentity | null
  lastReviewContext: string | null
  lastDispatchedManifest: ReviewInputManifest | undefined
  patchCarryNote: string | null
  resumedDispatch: boolean
  lastFailingChecks: string[]
  lastFailureLogs: FailedCheckLog[]
  pendingGateRedRetry: boolean
  gateStalledStreak: number
  mechanicalRetryRecoverySurvivesOneReset: boolean
  unpushedResumeAttempted: boolean
  roundStartMs: number
  decision: Decision
  firstPass: boolean
  pendingCompletionEvents: DevReviewLoopEventInput[]
  liveCheckedHead: string | null
  approvedBriefContent: string | null
  taskTitle: string | undefined
  resumeFrom: PauseState | null
  agentSwitched: boolean
  resumeHeadAlreadyMoved: boolean
  drainLoopLogSink: ReturnType<typeof createVinayaLogSink>['drain']
  sweepDone: Promise<void>
  lockToken: string
  existingDriverLock: ReturnType<typeof readDriverLock>
  ownsExistingLock: boolean
  prevHost: string | undefined
  prevPr: string | undefined
  repoRoot: string
  baseHeadAtStart: string
  toolingRerunRounds: Set<number>
  loopOutboxPath: string
  narratedEvents: DevReviewLoopEventInput[]
  loopId: string
  loopHistory: ReconstructedJournal
  historyApplies: boolean
  recoveredLoopState: ReturnType<typeof recoverLoopState>
  deliveredFindingsIdentity: RoundHeadIdentity | null
  developerHandoff: DeveloperHandoff
  taskStartedAt: string
  phaseMs: Record<string, number>
  currentPhase: string | null
  currentPhaseSince: number
  devResumeId: string | null
  devDispatchHistory: DeveloperDispatchHistory
  turnPreStop: string | null
  turnConfinementByRole: Map<Role, TurnWriteAttribution>
  preparedSourcesByRound: Map<number, RequiredSourceManifest>
  worktreeDependenciesInstalled: boolean
  MAX_PUBLISH_REASKS: number
  stopHeartbeat: () => void
  recordDriverExited: ReturnType<typeof createDriverExitRecorder>
  emitHeartbeat: () => void
}

/**
 * The context a run starts with: the dependencies, the input and the runtime root, every mutable local at
 * its first value, and the fixed values and helper fields left for `devReviewLoop` to fill in before the
 * round loop runs (`Object.assign(c, { ... })`, right before its `try`). The cast is the one place the
 * object is wider than what it holds at creation.
 */
export function createLoopRunContext(seed: { d: LoopDeps; input: LoopInput; root: string }): LoopRunContext {
  return {
    d: seed.d,
    input: seed.input,
    root: seed.root,
    prNumber: -1, // resolved by setup, before any use — never read while -1
    issueRulingsOwed: false,
    keepLockAlive: false,
    roleDispatchesInPass: 0,
    rateLimitWaits: 0,
    roundAtLastWait: -1,
    lastRateLimitResetEpoch: null,
    answeredConnectionRetries: 0,
    roundAtLastConnectionRetry: -1,
    lastHandoffFindings: null,
    round: 1,
    infrastructureRetries: 0,
    heldResultIdentity: null,
    lastReviewContext: null,
    lastDispatchedManifest: undefined,
    patchCarryNote: null,
    resumedDispatch: false,
    lastFailingChecks: [],
    lastFailureLogs: [],
    pendingGateRedRetry: false,
    gateStalledStreak: 0,
    mechanicalRetryRecoverySurvivesOneReset: false,
    unpushedResumeAttempted: false,
    roundStartMs: 0,
    decision: { type: 'dispatch_developer' },
    firstPass: true,
    pendingCompletionEvents: [],
    liveCheckedHead: null,
    approvedBriefContent: null
  } as unknown as LoopRunContext
}
