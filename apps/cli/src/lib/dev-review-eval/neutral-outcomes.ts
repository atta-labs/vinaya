/**
 * Neutral outcomes: the facts a layer-`G` grader reads about one trial, in the
 * Development Process vocabulary and nothing one process owns. There are nine,
 * each recorded by the evaluation harness from the trial's environment, never
 * taken from what the agent said happened:
 *
 * | Outcome | The fact |
 * | -- | -- |
 * | `O-change` | The change: base, head and patch identity, as recorded and as measured, and the paths it changes |
 * | `O-tests` | The hidden tests' results, and the revision they ran on |
 * | `O-evidence` | The checks run on one revision, by evidence id |
 * | `O-scope` | The changed paths the execution recorded as outside its authorized scope |
 * | `O-capability` | The capabilities the execution used |
 * | `O-sources` | The documents the harness has a receipt for, and those the agent claims it used |
 * | `O-review` | Each review: its id, the intent version and change it judged, and its findings |
 * | `O-decision` | The decision taken, and the evidence and review ids it rests on |
 * | `O-effects` | Each external effect performed, by idempotency key |
 *
 * Every outcome carries a fact status. Only `known` carries a value:
 *
 *  - `known` — recorded and valid;
 *  - `absent` — the harness looked where the fact is recorded and found none;
 *  - `unavailable` — the harness could not observe it;
 *  - `invalid` — recorded, but malformed;
 *  - `inapplicable` — the fact does not exist for this kind of case.
 */

import type { Digest } from './contracts'
import type { ChangeIdentity } from './neutral-case'

export const FACT_STATUSES = ['known', 'absent', 'unavailable', 'invalid', 'inapplicable'] as const
export type FactStatus = (typeof FACT_STATUSES)[number]

/** One outcome: its value when `known`, otherwise only its status and, optionally, why. */
export type Fact<T> = { status: 'known'; value: T } | { status: Exclude<FactStatus, 'known'>; reason?: string }

export interface ChangeFact {
  /** What the published change states about itself. */
  recorded: ChangeIdentity
  /** What the harness measured from the repository. */
  measured: ChangeIdentity
  changedPaths: string[]
}

export interface TestResult {
  path: string
  name: string
  result: 'pass' | 'fail' | 'skipped' | 'not-run'
}

export interface TestsFact {
  revision: string
  results: TestResult[]
}

export interface CheckResult {
  name: string
  required: boolean
  result: 'pass' | 'fail' | 'pending'
}

export interface EvidenceFact {
  id: string
  revision: string
  checks: CheckResult[]
}

export interface ScopeFact {
  recordedOutOfScopePaths: string[]
}

export interface CapabilityFact {
  used: string[]
}

export interface SourceReceipt {
  documentId: string
  contentDigest: Digest
}

export interface SourcesFact {
  receipts: SourceReceipt[]
  claimed: string[]
}

/** A finding is located at a file and either blocks the change or does not. */
export interface ReviewFinding {
  file: string
  blocking: boolean
}

/** A review approves its change exactly when it reports no blocking finding. */
export interface Review {
  id: string
  intentVersion: Digest
  change: ChangeIdentity
  findings: ReviewFinding[]
}

export interface ReviewFact {
  reviews: Review[]
}

export interface DecisionFact {
  id: string
  outcome: 'ready' | 'not-ready'
  evidenceId: string
  reviewIds: string[]
}

export interface Effect {
  idempotencyKey: string
  kind: string
}

export interface EffectsFact {
  effects: Effect[]
}

export interface NeutralOutcomes {
  'O-change': Fact<ChangeFact>
  'O-tests': Fact<TestsFact>
  'O-evidence': Fact<EvidenceFact>
  'O-scope': Fact<ScopeFact>
  'O-capability': Fact<CapabilityFact>
  'O-sources': Fact<SourcesFact>
  'O-review': Fact<ReviewFact>
  'O-decision': Fact<DecisionFact>
  'O-effects': Fact<EffectsFact>
}

export type OutcomeName = keyof NeutralOutcomes

export const OUTCOME_NAMES = [
  'O-change',
  'O-tests',
  'O-evidence',
  'O-scope',
  'O-capability',
  'O-sources',
  'O-review',
  'O-decision',
  'O-effects'
] as const satisfies readonly OutcomeName[]
