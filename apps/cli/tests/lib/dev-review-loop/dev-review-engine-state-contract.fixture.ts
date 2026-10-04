/**
 * The target Atta-Engine-backed developer-review workflow's provider-neutral
 * state model — `apps/cli/specs/dev-review-engine-state-machine.md`'s own
 * machine-readable data, consumed by
 * `dev-review-engine-state-contract.test.ts`.
 *
 * This is the TARGET model (Linear "Tech spec — Developer-review on Atta
 * Engine", revision 7, section 16), not the standalone implementation: it
 * names no file in `apps/cli/src` or `packages/aeg-core/src`, because this
 * task specifies the contract production execution must satisfy, and does
 * not build that execution. It consumes Task 1's frozen, now fully
 * Principal-ruled ambiguity register
 * (`apps/cli/tests/fixtures/dev-review-architecture-invariants.json`) —
 * every `AMB-*` ruling it cites below is this model's only license to
 * encode that behavior; a policy choice with no ruling has no business
 * being decided in this file.
 */

export const OWNERS = [
  'vinaya-policy',
  'engine-runtime',
  'provider-adapter',
  'governed-operation',
  'log',
  'operator-control'
] as const
export type Owner = (typeof OWNERS)[number]

export const AUTHORITIES = ['control-state', 'forge', 'telemetry', 'pure-policy', 'effect'] as const
export type Authority = (typeof AUTHORITIES)[number]

export const SIDE_EFFECT_CLASSES = [
  'none',
  'pure-read-only',
  'replay-safe',
  'idempotent-keyed',
  'reconcilable-not-replayable'
] as const
export type SideEffectClass = (typeof SIDE_EFFECT_CLASSES)[number]

export const TERMINAL_OUTCOME_IDS = ['ready_for_merge', 'paused', 'failed', 'cancelled', 'exhausted'] as const
export type TerminalOutcomeId = (typeof TERMINAL_OUTCOME_IDS)[number]

/** One named position the run's `Progress.currentNode` may hold. Never a terminal outcome — those are listed separately, below. */
export interface EngineState {
  id: string
  description: string
  /** The layer that owns deciding what happens while control sits in this state (tech spec § 16.2/16.3). */
  owner: Owner
  /** What kind of state this position itself reads to decide anything (tech spec § 16.4's four distinct stores). */
  authority: Authority
}

/** A legal edge. `guard` must be a deterministic predicate description — never "the model decides". */
export interface EngineTransition {
  id: string
  from: string
  to: string
  /** The event or condition that fires this edge. */
  trigger: string
  /** The deterministic, versioned-transition-table predicate controller code evaluates — never a model judgement. */
  guard: string
  /** The ruled ambiguity this edge's specific behavior is licensed by, if any (e.g. `AMB-01`). */
  ruling?: string
}

export interface TerminalOutcome {
  id: TerminalOutcomeId
  description: string
  /** What control-state records, durably, the instant this outcome is reached. */
  persistence: string
  /** Whether and how a later action can continue past this outcome — explicit, never implied by "a graph node can rerun". */
  resumption: string
}

/** One workflow node's complete contract (O2). Every field is required — a node missing one is incomplete, not advisory. */
export interface NodeContract {
  id: string
  owner: Owner
  typedInput: string
  typedOutput: string
  /** `none` for a pure/deterministic node; otherwise the effect's replay classification (tech spec § 16.12). */
  sideEffects: SideEffectClass
  retryPolicy: string
  timeoutPolicy: string
  failureBehavior: string
  cancellationBehavior: string
  /** Log event kinds this node owns emitting, as `<kind>:<event>` pairs shipped by `apps/cli/specs/log.md` — never an invented family. */
  lifecycleEvents: string[]
}

// ---------------------------------------------------------------------------
// States — the graph's named positions (tech spec § 16.5's final graph).
// ---------------------------------------------------------------------------

export const ENGINE_STATES: EngineState[] = [
  {
    id: 'prepare_run',
    description:
      "Pins process/Flow/Plan/policy digests, the brief digest, objective version, ruling ordinal, base revision and target branch into a fresh RunIdentity before anything else runs. The ref-only bootstrap push that first creates this run's task branch may skip the repository's own hooks, but it is always made through the Broker — never around it (AMB-08).",
    owner: 'vinaya-policy',
    authority: 'control-state'
  },
  {
    id: 'reconcile_external_state',
    description:
      "On a fresh start this is a no-op; on resume it reconciles checkpoint, developer/reviewer session refs, and every prepared/committed/uncertain effect against external (forge) reality before Progress.currentNode moves again. Fetches the remote and compares against the repository's actual default branch, never a hard-coded name (AMB-13).",
    owner: 'engine-runtime',
    authority: 'control-state'
  },
  {
    id: 'prepare_sources',
    description:
      "Resolves the frozen brief's required sources into controller-owned PreparedSource records (canonical URI, retrieval time, digest, delivery mode) before the developer is ever dispatched (tech spec § 16.7).",
    owner: 'governed-operation',
    authority: 'effect'
  },
  {
    id: 'dispatch_developer',
    description:
      'Starts or resumes one isolated developer attempt through the portable AgentRuntime port, carrying the frozen brief, current objectives/rulings, prepared sources and (on a later round) the revision handoff packet.',
    owner: 'provider-adapter',
    authority: 'effect'
  },
  {
    id: 'await_developer',
    description:
      "Holds the checkpointed wait for the developer attempt's typed observation, distinguishing a clean return from a transient infrastructure failure.",
    owner: 'engine-runtime',
    authority: 'control-state'
  },
  {
    id: 'validate_developer_output',
    description:
      "Deterministically validates the developer's structured completion output's schema, version and provenance against the dispatched manifest; reads the developer's stated confidence where the gate rule applies.",
    owner: 'vinaya-policy',
    authority: 'pure-policy'
  },
  {
    id: 'run_mechanical_gates',
    description:
      'Runs the declared deterministic checks (CI, lint, typecheck, format, doc coverage, …) against the judged head and records one terminal outcome per check.',
    owner: 'governed-operation',
    authority: 'effect'
  },
  {
    id: 'classify_gate_failure',
    description:
      "Classifies a non-passing gate result as developer-caused, infrastructure (stuck-pending, absent, or a check that waits on the Principal), or a policy refusal — never defaulting an unclear case to developer fault (AMB-10). A commit-hook refusal of the driver's own commit is always developer-caused, sent back at once with the refusing hook's output — never an infrastructure pause (AMB-05).",
    owner: 'vinaya-policy',
    authority: 'pure-policy'
  },
  {
    id: 'dispatch_reviewers',
    description:
      'Fans out fresh, isolated code and security reviewer attempts over the same immutable review-input manifest, with zero cross-talk before the join. Re-stages and retries a reviewer with no verified candidate rather than ever running one unisolated (AMB-09).',
    owner: 'provider-adapter',
    authority: 'effect'
  },
  {
    id: 'validate_reviewer_outputs',
    description:
      "Deterministically validates each reviewer's structured output against the judged evidence (patch/head/brief/objectives/ruling/policy digests) before any finding is ever counted.",
    owner: 'vinaya-policy',
    authority: 'pure-policy'
  },
  {
    id: 'assess_round',
    description:
      'The pure, versioned decision function: combines validated reviewer observations, gate results, objective coverage and prior finding fingerprints into exactly one legal decision (revise, pause, fail, exhausted, or complete). A finding re-reported as open or with no state counts as a reappearance (AMB-02); `journal_finalized.rounds` counts distinct reviewed rounds, not attempts (AMB-03).',
    owner: 'vinaya-policy',
    authority: 'pure-policy'
  },
  {
    id: 'build_revision_handoff',
    description:
      "Builds the next developer handoff packet from the round's unresolved findings and changed authoritative facts — a delta packet, never the full prior transcript.",
    owner: 'vinaya-policy',
    authority: 'pure-policy'
  },
  {
    id: 'raise_human_handoff',
    description:
      'Durably records a pause with its stable identity, reason class, exact required decision, attempted automated recovery and allowed actions; owns resuming (typed, re-authenticated, freshness-checked) or cancelling. An escalation record that fails to write is re-raised on the next driver start, never left silently unrecoverable (AMB-12).',
    owner: 'operator-control',
    authority: 'control-state'
  },
  {
    id: 'publish_ready_for_merge',
    description:
      'The governed publish effect: prepares, commits and verifies the postcondition of making the judged change ready for Principal merge, as a distinct prepare/commit/reconcile identity rather than an idempotent no-op rerun. Re-checks only mergeability when the head is unchanged, never re-review (AMB-06); a republish after a restart only appends to a deferred-findings record, never shrinks it (AMB-07).',
    owner: 'governed-operation',
    authority: 'effect'
  },
  {
    id: 'cancel_run',
    description:
      'Terminates every owned process tree with bounded escalation and fences every in-flight effect so a cancelled run can never silently complete one after the fact.',
    owner: 'operator-control',
    authority: 'control-state'
  }
]

// ---------------------------------------------------------------------------
// Transitions — every legal edge, each with a trigger and a deterministic guard.
// ---------------------------------------------------------------------------

export const ENGINE_TRANSITIONS: EngineTransition[] = [
  {
    id: 'T01',
    from: 'prepare_run',
    to: 'reconcile_external_state',
    trigger: 'run identity pinned',
    guard:
      'pinnedInputs.every((d) => d.digest !== null) — an incompatible or missing pinned version refuses the start instead of taking this edge'
  },
  {
    id: 'T02',
    from: 'reconcile_external_state',
    to: 'prepare_sources',
    trigger: 'reconciliation complete',
    guard: 'uncertainEffectIds.length === 0'
  },
  {
    id: 'T03',
    from: 'reconcile_external_state',
    to: 'raise_human_handoff',
    trigger: 'an effect stays uncertain after reconciliation',
    guard: 'uncertainEffectIds.length > 0 && !autoReconcilable(effect)'
  },
  {
    id: 'T04',
    from: 'prepare_sources',
    to: 'dispatch_developer',
    trigger: 'every required source resolved',
    guard: "requiredSources.every((s) => s.deliveryMode !== 'unavailable')"
  },
  {
    id: 'T05',
    from: 'prepare_sources',
    to: 'raise_human_handoff',
    trigger: 'a required source could not be retrieved',
    guard: "requiredSources.some((s) => s.required && s.deliveryMode === 'unavailable')"
  },
  {
    id: 'T06',
    from: 'dispatch_developer',
    to: 'await_developer',
    trigger: 'developer attempt started',
    guard: 'true — starting the attempt is unconditional once this node is entered'
  },
  {
    id: 'T07',
    from: 'await_developer',
    to: 'validate_developer_output',
    trigger: 'developer attempt returned a typed observation',
    guard: "attempt.outcome !== 'infrastructure_failed'"
  },
  {
    id: 'T08',
    from: 'await_developer',
    to: 'reconcile_external_state',
    trigger: 'developer attempt failed on an infrastructure-class outcome',
    guard: "attempt.outcome === 'infrastructure_failed' && infraRetryCount < MAX_INFRASTRUCTURE_RETRIES"
  },
  {
    id: 'T09',
    from: 'await_developer',
    to: 'raise_human_handoff',
    trigger: 'infrastructure retry bound exhausted',
    guard: 'infraRetryCount >= MAX_INFRASTRUCTURE_RETRIES'
  },
  {
    id: 'T10',
    from: 'validate_developer_output',
    to: 'run_mechanical_gates',
    trigger: 'output schema and provenance both validate',
    guard: 'output.schemaValid && output.provenanceValid'
  },
  {
    id: 'T11',
    from: 'validate_developer_output',
    to: 'dispatch_developer',
    trigger: 'malformed output within its declared fresh-retry bound',
    guard: '!output.schemaValid && invalidOutputRetryCount < MAX_INVALID_OUTPUT_RETRIES'
  },
  {
    id: 'T12',
    from: 'run_mechanical_gates',
    to: 'dispatch_reviewers',
    trigger: 'every required gate passed',
    guard: "gateResult.outcome === 'pass'"
  },
  {
    id: 'T13',
    from: 'run_mechanical_gates',
    to: 'classify_gate_failure',
    trigger: 'a required gate did not pass',
    guard: "gateResult.outcome !== 'pass'"
  },
  {
    id: 'T14',
    from: 'classify_gate_failure',
    to: 'dispatch_developer',
    trigger: 'classified as developer-caused',
    guard: "classification === 'developer_fault'",
    ruling: 'AMB-10'
  },
  {
    id: 'T15',
    from: 'classify_gate_failure',
    to: 'run_mechanical_gates',
    trigger: 'classified as infrastructure (stuck-pending, absent, or flaky) and within bound',
    guard: "classification === 'infrastructure' && infraRetryCount < MAX_INFRASTRUCTURE_RETRIES",
    ruling: 'AMB-10'
  },
  {
    id: 'T16',
    from: 'classify_gate_failure',
    to: 'raise_human_handoff',
    trigger: 'infrastructure retry bound exhausted, or the gate itself waits on the Principal',
    guard:
      "(classification === 'infrastructure' && infraRetryCount >= MAX_INFRASTRUCTURE_RETRIES) || classification === 'principal_wait'",
    ruling: 'AMB-10'
  },
  {
    id: 'T17',
    from: 'dispatch_reviewers',
    to: 'validate_reviewer_outputs',
    trigger: 'every dispatched reviewer attempt returned',
    guard: 'reviewerAttempts.every((a) => a.returned)'
  },
  {
    id: 'T18',
    from: 'dispatch_reviewers',
    to: 'dispatch_reviewers',
    trigger: 'a reviewer has no verified candidate',
    guard: 'reviewerAttempts.some((a) => !a.candidateVerified) && restageRetryCount < MAX_REVIEWER_RESTAGE_RETRIES',
    ruling: 'AMB-09'
  },
  {
    id: 'T19',
    from: 'dispatch_reviewers',
    to: 'raise_human_handoff',
    trigger: 're-stage bound exhausted and the resulting infrastructure retry bound is also exhausted',
    guard: 'restageRetryCount >= MAX_REVIEWER_RESTAGE_RETRIES && infraRetryCount >= MAX_INFRASTRUCTURE_RETRIES',
    ruling: 'AMB-09'
  },
  {
    id: 'T20',
    from: 'validate_reviewer_outputs',
    to: 'assess_round',
    trigger: 'every reviewer output is valid, independent and evidence-bound',
    guard: 'reviewerOutputs.every((o) => o.valid && o.evidenceBound)'
  },
  {
    id: 'T21',
    from: 'validate_reviewer_outputs',
    to: 'dispatch_reviewers',
    trigger: 'an invalid reviewer output within its one declared retry',
    guard: 'reviewerOutputs.some((o) => !o.valid) && invalidReviewerRetryCount < 1'
  },
  {
    id: 'T22',
    from: 'assess_round',
    to: 'build_revision_handoff',
    trigger: 'decision is revise',
    guard: "decision.outcome === 'revise'"
  },
  {
    id: 'T23',
    from: 'build_revision_handoff',
    to: 'dispatch_developer',
    trigger: 'revision handoff packet built',
    guard: 'true — the same developer session is resumed unconditionally once the packet exists'
  },
  {
    id: 'T24',
    from: 'assess_round',
    to: 'raise_human_handoff',
    trigger: 'decision is pause',
    guard:
      "decision.outcome === 'pause' && decision.reasonCode === priorityOrder(['escalation','principal_item','repeat','max_rounds','infrastructure']).first(applicable)",
    ruling: 'AMB-01'
  },
  {
    id: 'T25',
    from: 'assess_round',
    to: 'failed',
    trigger: 'decision is fail',
    guard: "decision.outcome === 'fail'"
  },
  {
    id: 'T26',
    from: 'assess_round',
    to: 'exhausted',
    trigger: 'a declared budget (rounds, turns, time, token or cost) is exhausted',
    guard: "decision.outcome === 'exhausted'"
  },
  {
    id: 'T27',
    from: 'assess_round',
    to: 'publish_ready_for_merge',
    trigger: 'decision is complete',
    guard: "decision.outcome === 'complete' && readyForMergeConditions.every((c) => c.holds)"
  },
  {
    id: 'T28',
    from: 'publish_ready_for_merge',
    to: 'ready_for_merge',
    trigger: 'publish effect verified',
    guard: "publishEffect.outcome === 'success'"
  },
  {
    id: 'T29',
    from: 'publish_ready_for_merge',
    to: 'raise_human_handoff',
    trigger: 'publish effect uncertain',
    guard: "publishEffect.outcome === 'uncertain'"
  },
  {
    id: 'T30',
    from: 'raise_human_handoff',
    to: 'reconcile_external_state',
    trigger:
      'an authenticated, non-stale resume decision is received, or a stale_driver pause resumes unattended within its bound',
    guard: 'resumeDecision.authenticated && !resumeDecision.stale',
    ruling: 'AMB-11'
  },
  {
    id: 'T31',
    from: 'raise_human_handoff',
    to: 'cancelled',
    trigger: 'a cancel decision is received',
    guard: "resumeDecision.outcome === 'cancel'"
  },
  {
    id: 'T32',
    from: 'any in-flight state',
    to: 'cancel_run',
    trigger: 'cancellation requested',
    guard: 'cancellationRequestedAt !== null'
  },
  {
    id: 'T33',
    from: 'cancel_run',
    to: 'cancelled',
    trigger: 'every owned process tree terminated and every in-flight effect fenced',
    guard: 'processTreesTerminated && everyInFlightEffectFenced'
  }
]

// ---------------------------------------------------------------------------
// Terminal outcomes — never collapsed into one value (brief § 2 Traps).
// ---------------------------------------------------------------------------

export const TERMINAL_OUTCOMES: TerminalOutcome[] = [
  {
    id: 'ready_for_merge',
    description: 'Every readiness condition in tech spec § 16.10 holds and the publish effect verified.',
    persistence:
      "Control.status = 'ready_for_merge'; committedEffectIds includes the publish effect's identity; the state becomes immutable except for separate archival metadata.",
    resumption: 'None. Terminal — a later task or round starts a new run; it never resumes this one.'
  },
  {
    id: 'paused',
    description: 'A human handoff was raised: insufficient authority or confidence to continue unattended.',
    persistence:
      'Control.pauseOrTerminalReason records the handoff reason class; the escalation record (stable identity, required decision, attempted recovery, allowed actions) is durably written before this outcome is entered.',
    resumption:
      'Resume accepts typed external input and revalidates authority and freshness first — a stale ruling, a changed patch, or a superseded objective set refuses to resume the old checkpoint silently. A stale_driver pause is the one case that resumes unattended, within its own retry bound (AMB-11).'
  },
  {
    id: 'failed',
    description:
      'An unrecoverable policy or authorization failure, or a decision the assessment function itself classified as fail.',
    persistence: "Control.pauseOrTerminalReason records the failure's stable error class.",
    resumption: 'None. Terminal — only a new, distinguishable run continues the work; this run is never resumed.'
  },
  {
    id: 'cancelled',
    description:
      'A cancellation was requested and every owned process tree and in-flight effect was terminated/fenced.',
    persistence:
      'Control.cancellationRequestedAt plus the fencing outcome recorded for every effect that was in flight.',
    resumption:
      'None. Terminal — a repeated cancel call on an already-cancelled run replays the same outcome idempotently; it never re-enters the run.'
  },
  {
    id: 'exhausted',
    description: 'A declared iteration, token, time or cost budget was exhausted with no success reached.',
    persistence:
      "Control.pauseOrTerminalReason names the exhausted budget kind, distinctly from 'failed'/'cancelled'/'paused' — exhaustion is never reported as success and never silently reclassified as one of the other three.",
    resumption:
      "None by default. Terminal — a Principal-authorized budget increase starts a new, distinguishable run; it never silently continues this run's own counters."
  }
]

// ---------------------------------------------------------------------------
// Node contracts (O2) — one per state that performs work.
// ---------------------------------------------------------------------------

export const NODE_CONTRACTS: NodeContract[] = [
  {
    id: 'prepare_run',
    owner: 'vinaya-policy',
    typedInput:
      'RunSeed { taskIdentity, controllerEpoch, processVersion, flowDigest, planDigest, policyDigest, briefDigest, objectiveVersion, rulingOrdinal, baseRevision, targetBranch, repositoryIdentity, requiredSourceManifestDigest }',
    typedOutput: 'RunIdentity { runId, threadId, taskIdentity, controllerEpoch } + PinnedInputs, persisted',
    sideEffects: 'none',
    retryPolicy: 'None. A malformed or incompatible seed is a refused start, never a retryable attempt.',
    timeoutPolicy: 'None — deterministic, sub-second pinning with no external call.',
    failureBehavior:
      'An incompatible or missing pinned version is a typed refusal; the run never starts with an invented default.',
    cancellationBehavior: 'Not cancellable — no run identity exists yet for a cancellation to target.',
    lifecycleEvents: ['dev_review_loop:loop_started']
  },
  {
    id: 'reconcile_external_state',
    owner: 'engine-runtime',
    typedInput:
      'RunIdentity + Effects.{preparedEffectIds, committedEffectIds, uncertainEffectIds} + the last checkpoint',
    typedOutput:
      'Effects with every previously uncertain identity resolved to success, failure, or still-uncertain; Progress.currentNode restored to the pre-pause position',
    sideEffects: 'reconcilable-not-replayable',
    retryPolicy:
      'Bounded infrastructure retry with backoff on a transient external read failure (e.g. a remote fetch failure, AMB-13).',
    timeoutPolicy:
      'One bounded wall-clock timeout per external read; a hung read is classified as a transient infrastructure failure, not a hang.',
    failureBehavior:
      'An effect that remains uncertain after every retry raises a human handoff rather than guessing success or blindly re-executing it (tech spec § 16.12).',
    cancellationBehavior:
      'A cancel requested mid-reconciliation lets the current read finish, then stops before starting the next effect check.',
    lifecycleEvents: ['dev_review_loop:resumed', 'effect:verified']
  },
  {
    id: 'prepare_sources',
    owner: 'governed-operation',
    typedInput: "The frozen brief's required-source list + requiredSourceManifestDigest",
    typedOutput:
      'PreparedSource[] { sourceId, canonicalUri, requirementText, governs, retrievedAt, versionOrRevision?, contentDigest, mediaType, deliveryMode, snapshotRef?, freshnessPolicy, trustClassification }',
    sideEffects: 'idempotent-keyed',
    retryPolicy:
      'Bounded retry on a transient fetch failure, keyed by sourceId so a retry never produces two receipts for one source.',
    timeoutPolicy: 'One bounded timeout per source fetch.',
    failureBehavior:
      'A required source still unavailable after retry raises a human handoff with a typed missing-capability/source reason — the run never continues on model memory in its place (tech spec § 16.7).',
    cancellationBehavior:
      'In-flight fetches are abandoned; no PreparedSource record is written for an abandoned fetch.',
    lifecycleEvents: ['effect:verified']
  },
  {
    id: 'dispatch_developer',
    owner: 'provider-adapter',
    typedInput:
      'DeveloperInvocation { frozen brief + digest, objectives/ruling references, repository/base/head facts, PreparedSource[], round number, prior actionable findings on round > 1, permitted capability set, registered tool catalog, budgets/stop-conditions }',
    typedOutput:
      'AgentAttempt handle (session ref, attempt id) — via the portable AgentRuntime.start/resume port, never a provider-specific session object in core state',
    sideEffects: 'idempotent-keyed',
    retryPolicy:
      "A resume onto the same session identity is retried on a connection-class failure, bounded, on the same session — never silently falling back to a fresh session. A resume MAY select a different qualifying AgentRuntime implementation than the paused attempt used (AMB-04); the choice is recorded in Progress.developerSessionRef's own provenance, never silently assumed unchanged.",
    timeoutPolicy:
      'Per-invocation wall-clock timeout from the declared budget; exceeding it is a timeout outcome, never an infinite wait.',
    failureBehavior:
      'A dispatch-time refusal, crash, or timeout returns a typed outcome (never an empty/invented output) and is classified before any transition is taken.',
    cancellationBehavior:
      'AgentRuntime.cancel(attempt) terminates the owned process tree with bounded escalation; a cancelled attempt is never treated as a clean return.',
    lifecycleEvents: [
      'dispatch:dispatched',
      'dev_review_loop:round_started',
      'role_attempt:attempted',
      'usage:observed'
    ]
  },
  {
    id: 'await_developer',
    owner: 'engine-runtime',
    typedInput: 'The AgentAttempt handle from dispatch_developer',
    typedOutput:
      'AgentAttempt outcome: a typed completion, or a classified failure (infrastructure/timeout/crash/cancelled)',
    sideEffects: 'none',
    retryPolicy:
      'None at this node — the retry decision belongs to the edge (T08) that reads this outcome, not to the wait itself.',
    timeoutPolicy: 'Bounded by the same per-invocation wall-clock budget dispatch_developer declared.',
    failureBehavior:
      'Every exit path (clean, timeout, crash, signal) produces one typed outcome; none of them is reported as empty success.',
    cancellationBehavior:
      'A cancel requested while awaiting is forwarded to AgentRuntime.cancel and the wait resolves to a cancelled outcome, never a timeout.',
    lifecycleEvents: ['dispatch:outcome_received', 'dispatch:dispatch_failed', 'dev_review_loop:infrastructure_retry']
  },
  {
    id: 'validate_developer_output',
    owner: 'vinaya-policy',
    typedInput:
      "The developer's structured completion output + the dispatched manifest (identifiers to check it against)",
    typedOutput:
      'ValidationResult { schemaValid, provenanceValid, confidenceValue?, confidenceReason?, confidenceUnavailable? }',
    sideEffects: 'none',
    retryPolicy:
      'A fresh retry of the SAME round, bounded (MAX_INVALID_OUTPUT_RETRIES), on malformed output only — never on a validly-schemed output the policy merely disagrees with.',
    timeoutPolicy: 'None — deterministic parsing and schema validation, no external call.',
    failureBehavior:
      'Missing required fields, an unknown schema version, or a duplicate/contradictory claim is invalid output, never approval, empty findings, or generic success.',
    cancellationBehavior:
      'Not independently cancellable — a cancel in flight is handled by the node that is actually waiting (await_developer).',
    lifecycleEvents: ['dev_review_loop:gate_result_read']
  },
  {
    id: 'run_mechanical_gates',
    owner: 'governed-operation',
    typedInput: "The judged head's commit identity + the declared check set",
    typedOutput: 'GateResult { ran, passed, failed, skipped, failedChecks[], outcome }',
    sideEffects: 'pure-read-only',
    retryPolicy:
      "None at this node — a stuck/absent check's retry is classify_gate_failure's decision (T15), not this node's.",
    timeoutPolicy: 'One bounded timeout per check run.',
    failureBehavior:
      'A check that errors, waits, or times out is recorded with its own typed outcome; absence of a result is never read as a pass.',
    cancellationBehavior:
      'A check killed mid-flight by a cancel is recorded with outcome cancelled, from the signal path itself — never silently dropped.',
    lifecycleEvents: ['gate:summary', 'gate:checked']
  },
  {
    id: 'classify_gate_failure',
    owner: 'vinaya-policy',
    typedInput: 'GateResult from run_mechanical_gates',
    typedOutput: "Classification: 'developer_fault' | 'infrastructure' | 'principal_wait' | 'policy_refusal'",
    sideEffects: 'none',
    retryPolicy:
      'Not applicable to this node directly — it produces the classification the edges (T14/T15/T16) retry against.',
    timeoutPolicy: 'None — deterministic classification over an already-returned GateResult.',
    failureBehavior:
      'Stuck-pending or absent CI is never defaulted to developer_fault (AMB-10); an unrecognized failure shape is policy_refusal, never silently coerced into developer_fault.',
    cancellationBehavior: 'Not independently cancellable — deterministic and sub-second.',
    lifecycleEvents: ['dev_review_loop:infrastructure_retry']
  },
  {
    id: 'dispatch_reviewers',
    owner: 'provider-adapter',
    typedInput:
      'ReviewInputManifest { immutable judged patch/head, brief, objectives, ruling, policy digests } — identical for every reviewer, delivered with zero cross-talk before the join',
    typedOutput: 'AgentAttempt[] — one per reviewer role (code-reviewer, security), each isolated',
    sideEffects: 'idempotent-keyed',
    retryPolicy:
      'A reviewer with no verified candidate is re-staged and retried, bounded (MAX_REVIEWER_RESTAGE_RETRIES); exhausting that bound becomes a bounded infrastructure retry that itself resumes unattended, never a reviewer run unisolated (AMB-09).',
    timeoutPolicy: 'Per-reviewer wall-clock timeout from the declared budget.',
    failureBehavior:
      'A reviewer dispatch that fails returns role_attempt outcome infrastructure_failed/incomplete — never a fabricated empty-findings verdict standing in for a reviewer that never ran.',
    cancellationBehavior:
      "Cancelling fans out to every in-flight reviewer attempt; a cancelled reviewer's partial output is discarded, never counted toward the join.",
    lifecycleEvents: ['dispatch:dispatched', 'role_attempt:attempted', 'usage:observed']
  },
  {
    id: 'validate_reviewer_outputs',
    owner: 'vinaya-policy',
    typedInput: 'AgentAttempt outcomes from every dispatched reviewer + the same ReviewInputManifest',
    typedOutput:
      'ReviewVerdict[] { role, outcome, blockers, findings[] } with validity/independence/evidence-binding checked',
    sideEffects: 'none',
    retryPolicy:
      'One declared fresh retry per invalid reviewer output — never more, and never for a validly-schemed verdict the policy merely disagrees with.',
    timeoutPolicy: 'None — deterministic validation over already-returned outputs.',
    failureBehavior:
      'An invalid, stale-evidence, or cross-talk-tainted output counts as no review, never a default approval.',
    cancellationBehavior: 'Not independently cancellable — deterministic and sub-second.',
    lifecycleEvents: ['dev_review_loop:verdicts_read']
  },
  {
    id: 'assess_round',
    owner: 'vinaya-policy',
    typedInput:
      "ReviewVerdict[] + GateResult + objective coverage + prior finding fingerprints — the pure, versioned assessment function's full input",
    typedOutput: "Decision { outcome: 'revise'|'pause'|'fail'|'exhausted'|'complete', reasonCode?, reasons[] }",
    sideEffects: 'none',
    retryPolicy:
      'Not applicable — this node is a pure function; a round that cannot legally decide is itself the pause (T24), not a retry of this node.',
    timeoutPolicy: 'None — deterministic, no external call.',
    failureBehavior:
      'When several exit conditions apply in the same round, the most severe wins in a fixed, published order (escalation, then a Principal-owned item, then repeat, then max-rounds, then infrastructure); every applicable reason is still recorded, only the top one is shown (AMB-01). A resolved finding re-reported as open, or with no state, counts as a reappearance, never silent (AMB-02).',
    cancellationBehavior: 'Not independently cancellable — deterministic and sub-second.',
    lifecycleEvents: ['dev_review_loop:stop_condition_met', 'dev_review_loop:findings_compared']
  },
  {
    id: 'build_revision_handoff',
    owner: 'vinaya-policy',
    typedInput:
      "assess_round's Decision (outcome === 'revise') + the round's unresolved findings + changed authoritative facts",
    typedOutput:
      'RevisionHandoff { objective, permitted scope, unresolved findings, expected output schema, authority/tool limits, stop conditions/budgets, provenance to the parent attempt } — a delta packet, never the full prior transcript',
    sideEffects: 'none',
    retryPolicy: 'Not applicable — deterministic packet construction.',
    timeoutPolicy: 'None.',
    failureBehavior:
      'Not applicable — construction from already-validated inputs cannot itself fail; a missing input is a defect in an earlier node, not this one.',
    cancellationBehavior: 'Not independently cancellable — deterministic and sub-second.',
    lifecycleEvents: ['dev_review_loop:round_ended']
  },
  {
    id: 'raise_human_handoff',
    owner: 'operator-control',
    typedInput:
      'Pause reason class + the exact decision required + compact authoritative evidence + attempted automated recovery + allowed actions and their schemas',
    typedOutput:
      'EscalationRecord { stable identity, reason class, required decision, allowed actions, expiry/staleness conditions, correlation }, durably persisted before being reported anywhere',
    sideEffects: 'idempotent-keyed',
    retryPolicy:
      'A failed write of the escalation record itself is retried, bounded; if it still cannot be written, the pause is re-raised on the next driver start rather than left silently unrecoverable (AMB-12).',
    timeoutPolicy:
      'None on the pause itself — a pause is durable and does not expire on its own; individual allowed actions may carry their own staleness window.',
    failureBehavior:
      'A resume attempt against a stale ruling, a changed patch, or a superseded objective set is refused, never silently applied to the old checkpoint.',
    cancellationBehavior:
      'A cancel decision received while paused is a legal resolution (T31) — cancelling a pause is itself a first-class, non-destructive exit.',
    lifecycleEvents: [
      'handoff:raised',
      'dev_review_loop:paused',
      'handoff:resolved',
      'dev_review_loop:resumed',
      'dev_review_loop:cancelled'
    ]
  },
  {
    id: 'publish_ready_for_merge',
    owner: 'governed-operation',
    typedInput:
      'The judged head + every verified gate/review/objective/source obligation — the full tech spec § 16.10 readiness checklist',
    typedOutput:
      'EffectOutcome { prepared identity, committed identity, verified postcondition } — never a bare boolean',
    sideEffects: 'reconcilable-not-replayable',
    retryPolicy:
      'A crash after remote success but before local acknowledgement is reconciled by stable effect identity on the next entry to reconcile_external_state — it is never blindly re-executed merely because this node can rerun.',
    timeoutPolicy:
      "One bounded timeout for the commit step; the postcondition verification is retried, bounded, independent of the commit's own timeout.",
    failureBehavior:
      'An uncertain postcondition raises a human handoff (T29) rather than being guessed as success; an identical, already-reviewed head re-checks only mergeability, never re-review (AMB-06); a republish after a restart only appends to an existing deferred-findings record, never shrinks it (AMB-07).',
    cancellationBehavior:
      'Once commit has been requested, a cancel no longer aborts the effect — it is tracked through to reconciliation instead of left uncertain forever.',
    lifecycleEvents: ['effect:verified', 'dev_review_loop:round_ended', 'dev_review_loop:journal_finalized']
  },
  {
    id: 'cancel_run',
    owner: 'operator-control',
    typedInput: 'CancellationRequest { requestedAt, requestedBy }',
    typedOutput: 'CancelOutcome { every owned process tree terminated, every in-flight effect fenced or reconciled }',
    sideEffects: 'reconcilable-not-replayable',
    retryPolicy:
      'A repeated cancel call on an already-cancelled run is idempotent — it replays the same recorded outcome rather than re-running termination.',
    timeoutPolicy: 'Bounded escalation: a graceful stop request, then a forced termination after a fixed grace window.',
    failureBehavior:
      'A process tree that will not terminate within the escalation bound is recorded as a fencing failure, never silently reported as cancelled.',
    cancellationBehavior:
      'This node IS the cancellation path; it is not itself cancellable by a second concurrent cancel (that second call is the idempotent replay above).',
    lifecycleEvents: ['dev_review_loop:cancelled']
  }
]

/**
 * The ONLY place a provider name may appear — the explicit adapter
 * extension points (tech spec § 16.3's typed ports). Everything above this
 * line (states, transitions, terminal outcomes, node contracts) is core and
 * must name no provider; everything a provider adapter actually does is
 * named here instead, confined rather than absent (O3).
 */
export const PROVIDER_ADAPTER_EXTENSION_POINTS = [
  {
    port: 'AgentRuntime.start / resume / cancel / events',
    coreCaller: 'dispatch_developer, dispatch_reviewers, await_developer, cancel_run',
    implementations: ['claude-code-adapter', 'codex-adapter']
  },
  {
    port: 'ToolCatalog.list / invoke',
    coreCaller: 'dispatch_developer, dispatch_reviewers (tool grants only; never gate/publish authorization)',
    implementations: ['claude-code-adapter', 'codex-adapter']
  },
  {
    port: 'SourceProvider.prepare / deliver',
    coreCaller: 'prepare_sources',
    implementations: ['claude-code-adapter', 'codex-adapter']
  }
] as const
