/**
 * Review fixtures: one plan draft for each reported Planner bug the Plan
 * reviewer must catch, each marked with the question it must trip. A round on a
 * fixture must return a blocking finding under that question.
 *
 * Each draft is built against a captured revision the caller supplies, and
 * names only files that exist in this repository, so its claims about the code
 * are checkable at that revision.
 */

import type { PlanDraft } from '../plan-draft/draft'
import { PLAN_REVIEW_QUESTION_VERSION } from './result'

export type ReviewFixtureQuestion = 1 | 2 | 3 | 4 | 5

export interface ReviewFixture {
  /** A stable name for the reported bug. */
  id: string
  /** The question whose blocking finding the round must return. */
  question: ReviewFixtureQuestion
  /** The reported bug, in one sentence. */
  bug: string
  /** The task of the draft the finding is about. */
  task: number
  draft: (revision: string) => PlanDraft
}

const RESULT = 'harness/processes/vinaya-strict/tools/plan-review/result.ts'
const DRAFT = 'harness/processes/vinaya-strict/tools/plan-draft/draft.ts'
const CHECK = 'harness/processes/vinaya-strict/tools/plan-draft/check.ts'

const body = (parts: {
  boundary: string
  premises?: string[]
  objectives: string[]
  tests?: string[]
  relations?: string
  surface?: string[]
}): string =>
  [
    `Boundary: ${parts.boundary}`,
    `Premises:\n${(parts.premises ?? ['(none)']).map((p) => `- ${p}`).join('\n')}`,
    `Objectives:\n${parts.objectives.map((o, i) => `O${i + 1}. ${o}`).join('\n')}`,
    `Test plan:\n${(parts.tests ?? [`bun test ${RESULT.replace('.ts', '.test.ts')} → passes`]).join('\n')}`,
    `Surface in: ${(parts.surface ?? ['harness/processes/vinaya-strict/tools/plan-review']).join(', ')}`,
    `Relations: ${parts.relations ?? 'Depends-on: none. Conflicts-with: none.'}`
  ].join('\n\n')

const draft = (
  revision: string,
  tranche: string,
  tasks: { title: string; body: string }[],
  scope: PlanDraft['scope'] = tasks.map((t, i) => ({
    item: `${t.title} is delivered to the Principal`,
    disposition: { kind: 'delivered' as const, task: i + 1 }
  }))
): PlanDraft => ({
  schemaVersion: 1,
  tranche,
  revision,
  reviewQuestionVersion: PLAN_REVIEW_QUESTION_VERSION,
  tasks: tasks.map((t, i) => ({ number: i + 1, issue: null, title: t.title, body: t.body, labels: [] })),
  scope
})

export const REVIEW_FIXTURES: readonly ReviewFixture[] = [
  {
    id: 'facts-false-claim',
    question: 3,
    task: 1,
    bug: 'A premise claims the code exports a symbol it does not export.',
    draft: (revision) =>
      draft(revision, 'fixture-false-claim', [
        {
          title: 'The verdict is read from a review',
          body: body({
            boundary: 'Read the verdict of a validated review.',
            premises: [`\`${RESULT}\` exports \`reviewVerdict\`, which takes a validated review and returns a verdict`],
            objectives: ['A caller reads the verdict of a validated review through `reviewVerdict`.']
          })
        }
      ])
  },
  {
    id: 'facts-deferred-without-producer',
    question: 3,
    task: 2,
    bug: 'A deferred fact names a producer task that never commits to delivering it.',
    draft: (revision) =>
      draft(revision, 'fixture-deferred-fact', [
        {
          title: 'The round is logged',
          body: body({
            boundary: 'Log each round to the run record.',
            objectives: ['Each round writes one line to the run record.']
          })
        },
        {
          title: 'The log line carries the cost',
          body: body({
            boundary: 'Add the cost of the round to its log line.',
            premises: [
              'after task 1: `harness/processes/vinaya-strict/tools/plan-review/cost.ts` contains `roundCost`'
            ],
            objectives: ['The log line of a round carries `roundCost`.']
          })
        }
      ])
  },
  {
    id: 'proof-undeliverable-objective',
    question: 2,
    task: 1,
    bug: "An objective contradicts the guarantee the code gives and the task's own other objective.",
    draft: (revision) =>
      draft(revision, 'fixture-undeliverable', [
        {
          title: 'Answers bound to another draft are accepted',
          body: body({
            boundary: 'Change what the validation accepts.',
            objectives: [
              `\`validatePlanReview\` in \`${RESULT}\` returns \`ok: true\` for an answer bound to another draft's fingerprint.`,
              '`validatePlanReview` never returns `ok: true` for an answer bound to another draft.'
            ],
            tests: [`bun test ${RESULT.replace('.ts', '.test.ts')} → passes`]
          })
        }
      ])
  },
  {
    id: 'proof-too-broad',
    question: 2,
    task: 1,
    bug: 'An objective is too broad to finish: it covers every function of the harness.',
    draft: (revision) =>
      draft(revision, 'fixture-too-broad', [
        {
          title: 'Every function is covered',
          body: body({
            boundary: 'Test the harness.',
            objectives: [
              'Every function of everything under `harness` has a test that exercises each of its branches.'
            ],
            tests: ['bun test harness → passes'],
            surface: ['harness']
          })
        }
      ])
  },
  {
    id: 'proof-no-measure',
    question: 2,
    task: 1,
    bug: 'An objective has a target no check can measure.',
    draft: (revision) =>
      draft(revision, 'fixture-no-measure', [
        {
          title: 'The review round reads well',
          body: body({
            boundary: 'Improve the round.',
            objectives: ['The review round is fast, reads well and feels natural to a coordinator.'],
            tests: ['(none: the Principal will judge)']
          })
        }
      ])
  },
  {
    id: 'inputs-unnamed-source',
    question: 1,
    task: 1,
    bug: 'A task consumes an input no source names, so the Developer cannot read it.',
    draft: (revision) =>
      draft(revision, 'fixture-unnamed-input', [
        {
          title: 'The round picks the agreed reviewers',
          body: body({
            boundary: 'Start a round on each reviewer the Principal agreed.',
            objectives: ['A round starts on each reviewer in the agreed list of reviewers.']
          })
        }
      ])
  },
  {
    id: 'relations-undeclared-reader',
    question: 4,
    task: 1,
    bug: 'A task changes a file other code reads, and no task of the plan declares that reader.',
    draft: (revision) =>
      draft(revision, 'fixture-undeclared-reader', [
        {
          title: 'The fingerprint changes its algorithm',
          body: body({
            boundary: `Change \`draftFingerprint\` in \`${DRAFT}\` to hash with a different algorithm.`,
            premises: [`\`${DRAFT}\` contains \`draftFingerprint\``],
            objectives: ['`draftFingerprint` returns a hash made with a different algorithm.'],
            tests: [`bun test ${DRAFT.replace('.ts', '.test.ts')} → passes`],
            surface: [DRAFT]
          })
        }
      ])
  },
  {
    id: 'relations-missing-conflict',
    question: 4,
    task: 2,
    bug: 'Two tasks change the same file and neither declares a relation to the other.',
    draft: (revision) =>
      draft(revision, 'fixture-missing-relation', [
        {
          title: 'Evidence has a new kind',
          body: body({
            boundary: `Add a kind of evidence to \`${RESULT}\`.`,
            objectives: ['A piece of evidence may name a command it ran.'],
            surface: [RESULT]
          })
        },
        {
          title: 'Findings carry a severity',
          body: body({
            boundary: `Add a severity to each finding in \`${RESULT}\`.`,
            objectives: ['Each finding names a severity.'],
            surface: [RESULT, CHECK]
          })
        }
      ])
  },
  {
    id: 'intent-prescribes-mechanism',
    question: 5,
    task: 1,
    bug: 'An objective prescribes the mechanism instead of the outcome.',
    draft: (revision) =>
      draft(revision, 'fixture-mechanism', [
        {
          title: 'A round remembers its findings',
          body: body({
            boundary: 'Keep the findings of a round.',
            objectives: [
              'Findings are held in a module-level `Map<string, Set<string>>` keyed by task number, filled by a `forEach` over the answer and read back with `Array.from`.'
            ]
          })
        }
      ])
  },
  {
    id: 'intent-changes-agreed-scope',
    question: 5,
    task: 1,
    bug: 'An objective changes what the Principal agreed: it publishes what the scope left out.',
    draft: (revision) =>
      draft(
        revision,
        'fixture-changed-intent',
        [
          {
            title: 'A reader sees the plan whole',
            body: body({
              boundary: 'Show the plan whole.',
              objectives: [
                'A reader sees every task of the plan in one place.',
                'Each task of the plan is published as an Issue.'
              ]
            })
          }
        ],
        [
          { item: 'A reader sees the plan whole', disposition: { kind: 'delivered', task: 1 } },
          {
            item: 'Nothing is published to the forge',
            disposition: { kind: 'left-out', reason: 'the Principal agreed that publishing is a later plan' }
          }
        ]
      )
  }
]
