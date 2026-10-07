/**
 * The map of questions (`apps/cli/specs/log-sync.md`, "The questions"): one
 * entry per question, under its number. A reader of the log looks a question
 * up here and runs it over a dataset; a question added later is one more entry.
 */

import type { Dataset } from '../sync'
import { catchesAndEscapes } from './catches'
import { checkOutcomes } from './checks'
import { completionByModel } from './completion'
import { changeSizeBands, confidenceVsOutcome, outcomesByInstructionVersion, recurringFindings } from './convergence'
import { determinism } from './determinism'
import { reviewerStrictness } from './judgment'
import { timeByUnit } from './time'
import { usageByUnitAndRole } from './usage'

export type Question<Answer> = {
  /** The question's number; `null` for the confidence comparison, a companion comparison the spec names but does not number among the ten. */
  number: number | null
  title: string
  /** A pure function over the dataset: no I/O, no clock. */
  run(dataset: Dataset): Answer
}

export const QUESTIONS = {
  q1: { number: 1, title: 'Does a cheaper model finish?', run: completionByModel },
  q2: { number: 2, title: 'Are reviewers strict?', run: reviewerStrictness },
  q3: { number: 3, title: 'What does a unit of work cost?', run: usageByUnitAndRole },
  q4: { number: 4, title: 'Where does the time go?', run: timeByUnit },
  q5: { number: 5, title: 'Does the product catch anything?', run: catchesAndEscapes },
  q6: { number: 6, title: 'Which check catches most?', run: checkOutcomes },
  q7: { number: 7, title: 'Are checks deterministic?', run: determinism },
  q8: { number: 8, title: 'Which findings recur?', run: recurringFindings },
  q9: { number: 9, title: 'Is the instruction version the problem?', run: outcomesByInstructionVersion },
  q10: { number: 10, title: 'What change size converges?', run: changeSizeBands },
  confidence: { number: null, title: 'Does stated confidence predict review outcome?', run: confidenceVsOutcome }
} satisfies Record<`q${number}` | 'confidence', Question<unknown>>

export type QuestionId = keyof typeof QUESTIONS

export { catchesAndEscapes } from './catches'
export type { CatchesAnswer } from './catches'
export { checkOutcomes } from './checks'
export type { CheckOutcome, ChecksAnswer } from './checks'
export { completionByModel } from './completion'
export type { CompletionAnswer, ModelCompletion, RoundsToGreen } from './completion'
export type { Coverage, UnknownFigure } from './common'
export { changeSizeBands, confidenceVsOutcome, outcomesByInstructionVersion, recurringFindings } from './convergence'
export type {
  ChangeSizeAnswer,
  ChangeSizeBand,
  ConfidenceAnswer,
  ConfidenceOutcome,
  OutcomesByVersionAnswer,
  RecurringFinding,
  RecurringFindingsAnswer,
  SizeBandOutcome,
  VersionOutcome
} from './convergence'
export { determinism } from './determinism'
export type { DeterminismAnswer, FailureRecord } from './determinism'
export { reviewerStrictness } from './judgment'
export type {
  JudgmentAnswer,
  JudgmentCoverage,
  ReviewerStrictness,
  SeverityFindings,
  VerdictFindings
} from './judgment'
export { NO_LABELS_REASON } from './labels'
export type { HumanLabel, HumanLabelKind } from './labels'
export { timeByUnit } from './time'
export type { Span, TimeAnswer, UnitTime } from './time'
export { usageByUnitAndRole } from './usage'
export type { RoleUsage, UnitUsage, UsageAnswer, UsageTotals } from './usage'
