/**
 * `dev-review-loop`'s per-run context — the one object the round loop, the helpers it calls and the code still
 * nested in `devReviewLoop` share, so a helper can live in its own module instead of closing over the driver's
 * locals. Created once per run inside `devReviewLoop`, never at module level.
 */

import type {
  Confidence,
  Decision,
  DevReviewLoopEventInput,
  LoopConfig,
  LoopState,
  PauseReason,
  TaskClock,
  VerdictObservation
} from '../../../../tools/dev-review-policy/types'
import type { CredentialFinding } from '../../../../../../kernel/isolation/worker-boundary.js'
import type { ReviewInputManifest } from '../../../../tools/task-contract/review-input-manifest'
import type { ReviewPolicy } from '../../../../tools/task-contract/review-policy'
import type { RoundHeadIdentity } from '../../../../../../kernel/connectors/checkpoint/control-store/index'
import type { Role } from '../../../../../../kernel/log/schema'
import type { AgentVendor, DispatchHandle } from '../../dispatch/dispatch.js'
import type { DeferredFindingEntry } from '../../../../tools/task-contract/forge/forge-write.js'
import type { createVinayaLogSink } from '../../../../integration/log/log-sink-factory.js'
import type { resolveRepo } from '../../../../../../kernel/adapters/code-host/github/resolve-repo'
import type { ReviewerSourceFacts } from './reviewer-dispatch.js'
import type { DeveloperHandoff } from './round-assess.js'
import type { createLivePublicationState } from '../../actions/live-developer-context.js'
import type { FailedCheckLog } from '../../../../../../kernel/tools/failed-check-log.js'
import type { BridgeInvocation } from '../../../../../../kernel/tools/dev-tools-registration.js'
import type { PauseCommentPostResult } from './pause-resume.js'
import type { LoopDeps, LoopInput } from '../dev-review-loop.js'

/**
 * The state one `devReviewLoop` run shares between its round loop, the helpers the loop calls and the
 * helpers still nested inside `devReviewLoop` — one object per run, created at the top of `devReviewLoop`,
 * never held at module level (two drivers run in one process in tests).
 *
 * Three groups of fields:
 *  - the run's mutable locals (`round`, `decision`, `state`, the pause and wait counters, ...), which live
 *    here and nowhere else, so the code that moved and the code that stayed read and write the same cell;
 *  - values fixed once the run's setup finishes (`task`, `branch`, the log sink, the policy-independent
 *    configuration), copied in before the first round runs;
 *  - the helpers that still live inside `devReviewLoop` or at the driver's module level, as function
 *    fields — the second half of the split replaces each with a direct call.
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
  handoffFindingIds: () => string[]
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

  // --- helpers still nested in `devReviewLoop`
  logEvents: (events: readonly DevReviewLoopEventInput[]) => Promise<void>
  taskClock: () => TaskClock
  persistCurrentLoopState: (phase: string, pauseReason?: string) => void
  persistDeveloperHandoff: (next: Partial<DeveloperHandoff>) => void
  bestEffortInputVersions: () => {
    briefHash: string | null
    objectivesVersion: string | null
    rulingOrdinal: number
    policyDigest: string
  }
  snapshotTurnConfinement: (role: Role, roundNum: number) => void
  checkTurnConfinement: (
    role: Role,
    scanTexts: readonly { text: string; location: string }[]
  ) => { changedPaths: string[]; credentialFindings: CredentialFinding[] }
  describeTurnConfinementViolation: (result: {
    changedPaths: string[]
    credentialFindings: CredentialFinding[]
  }) => string
  reviewerScanTexts: (handle: DispatchHandle) => { text: string; location: string }[]
  dispatchDeveloper: (
    prompt: string,
    roundNum: number,
    opts?: {
      skipResumeContext?: boolean
      developerFiles?: readonly string[]
      skipPublish?: boolean
      publicationRefusal?: { kind: 'refused'; check: string; errorLine: string; reason: string; signature: string }
      /** This dispatch hands the Developer review findings to answer (O2: `addressedFindingIds` is then required). */
      answersFindings?: boolean
    }
  ) => Promise<DispatchHandle>
  roundReviewerSources: (roundNum: number) => { requiredSources?: ReviewerSourceFacts }
  startReviewerSourceTools: (
    dispatchRoleName: 'code-reviewer' | 'security',
    sources: ReviewerSourceFacts | undefined
  ) => Promise<{ bridge: BridgeInvocation; close: () => Promise<void> } | null>
  worktreePathForBranch: () => string
  issueRulingsBlock: () => string | null
  commitAndPushPrompt: () => string
  unpushedFailureMessage: (head: string, unpushed: { dirtyFiles: string[]; aheadCount: number }) => string
  logUnpushedWorkResume: (roundNum: number, detail: string) => Promise<void>
  logPauseCommentRetryIfNotable: (roundNum: number, result: PauseCommentPostResult) => Promise<void>
  postUnpushedWorkResumeComment: (
    roundNum: number,
    head: string,
    unpushed: { dirtyFiles: string[]; aheadCount: number }
  ) => Promise<void>
  checkStaleDriver: () => Promise<boolean>

  // --- helpers at the driver's module level
  publishingInstructionLine: () => string
  renderFailedCheckLog: (log: FailedCheckLog) => string
  failureSignaturePart: (run: { name: string; detail?: string }, logTail: string | null) => string
  describeConfidencePauseDetail: (confidence: Confidence) => string
  handoffFindings: (
    reviewRound: number,
    ...observations: readonly VerdictObservation[]
  ) => { id: string; line: string }[]
  deferredEntriesForRound: (round: number, verdicts: VerdictObservation[]) => DeferredFindingEntry[]
  deriveVerdictPauseDetail: (
    reason: PauseReason,
    events: readonly DevReviewLoopEventInput[],
    reviewerEscalated: boolean,
    securityEscalated: boolean
  ) => string | undefined
  gatePollEnvOverride: (name: string, fallback: number) => number
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
