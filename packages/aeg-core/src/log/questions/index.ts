/**
 * The map of questions (`apps/cli/specs/log-sync.md`, "The questions"): one
 * entry per question, under its number. A reader of the log looks a question
 * up here and runs it over a dataset; a question added later is one more entry.
 */

import type { Dataset } from '../sync'
import { completionByModel } from './completion'
import { timeByUnit } from './time'
import { usageByUnitAndRole } from './usage'

export type Question<Answer> = {
  /** The question's number. */
  number: number
  title: string
  /** A pure function over the dataset: no I/O, no clock. */
  run(dataset: Dataset): Answer
}

export const QUESTIONS = {
  q1: { number: 1, title: 'Does a cheaper model finish?', run: completionByModel },
  q3: { number: 3, title: 'What does a unit of work cost?', run: usageByUnitAndRole },
  q4: { number: 4, title: 'Where does the time go?', run: timeByUnit }
} satisfies Record<`q${number}`, Question<unknown>>

export type QuestionId = keyof typeof QUESTIONS

export { completionByModel } from './completion'
export type { CompletionAnswer, ModelCompletion, RoundsToGreen } from './completion'
export type { Coverage, UnknownFigure } from './common'
export { timeByUnit } from './time'
export type { Span, TimeAnswer, UnitTime } from './time'
export { usageByUnitAndRole } from './usage'
export type { RoleUsage, UnitUsage, UsageAnswer, UsageTotals } from './usage'
