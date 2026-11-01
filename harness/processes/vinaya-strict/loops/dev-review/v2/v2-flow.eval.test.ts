import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ALL_TESTS, records, runV2, type Scenario, setUpWorld, tearDownWorld } from './v2-world'

// Deterministic evaluations of review locally, push once (version 2 of the developer-review Flow). Each case is a
// fake task in a throwaway repository, run on the real runner, Flow and actions with stub agents, a fake forge and
// a fake ready push. A case passes when the run ends where it should and its counts match: Developer turns, review
// rounds, ready pushes and what each selected, pull requests opened, CI reads, and the Log events that measure it.
// Each case also states what the same task costs version 1 — a pre-push test run and a CI run per round — so the
// counts the flow saves are part of the evaluation, not a guess. Run with `bun test evals/`.

interface EvalCase {
  id: string
  scenario: Scenario
  expect: {
    outcome: string
    developerTurns: number
    reviewRounds: number
    readyRuns: string[][]
    prsOpened: number
    ciReadsByFlow: number
    rerunEvents: number
  }
  /** Version 1's pre-push test runs and CI runs for the same task: one each per pushed round. */
  v1: { prePushTestRuns: number; ciRuns: number }
  /** A run that re-enters a pull request already open: its reviewers judge that pull request's head. */
  attached?: boolean
}

const CASES: EvalCase[] = [
  {
    // A published pull request in conflict with main, re-entered: the conflict turn first, one proven merge, one review.
    id: 'conflict-reentry-merge-proven',
    attached: true,
    scenario: {
      attachAtRound: 1,
      setUp: (world) => {
        world.commit(true)
        world.moveMain()
      },
      developer: (attempt, world) =>
        attempt === 1
          ? {
              output: {
                turnResult: {
                  schemaVersion: 1,
                  status: 'completed',
                  summary: 'Merged main.',
                  confidence: 90,
                  confidenceExplanation: 'Stub result.',
                  addressedFindingIds: [],
                  sourceUses: [],
                  reportedChecks: null
                }
              },
              act: () => {
                world.mergeMain(true)
              }
            }
          : undefined
    },
    expect: {
      outcome: 'completed',
      developerTurns: 1,
      reviewRounds: 1,
      readyRuns: [ALL_TESTS],
      prsOpened: 0,
      ciReadsByFlow: 1,
      rerunEvents: 0
    },
    v1: { prePushTestRuns: 1, ciRuns: 1 }
  },
  {
    id: 'approve-in-round-1',
    scenario: {},
    expect: {
      outcome: 'completed',
      developerTurns: 1,
      reviewRounds: 1,
      readyRuns: [ALL_TESTS],
      prsOpened: 1,
      ciReadsByFlow: 1,
      rerunEvents: 0
    },
    v1: { prePushTestRuns: 1, ciRuns: 1 }
  },
  {
    id: 'revise-then-approve',
    scenario: {
      reviewer: (role, attempt) => (role === 'code-reviewer' && attempt === 1 ? 'request-changes' : 'approve')
    },
    expect: {
      outcome: 'completed',
      developerTurns: 2,
      reviewRounds: 2,
      readyRuns: [ALL_TESTS],
      prsOpened: 1,
      ciReadsByFlow: 1,
      rerunEvents: 0
    },
    v1: { prePushTestRuns: 2, ciRuns: 2 }
  },
  {
    id: 'ready-push-refused-then-only-the-failed-test-reruns',
    scenario: { failingTests: (attempt) => (attempt === 1 ? ['/repo/b.test.ts'] : []) },
    expect: {
      outcome: 'completed',
      developerTurns: 2,
      reviewRounds: 2,
      readyRuns: [ALL_TESTS, ['/repo/b.test.ts']],
      prsOpened: 1,
      ciReadsByFlow: 1,
      rerunEvents: 1
    },
    // Version 1 pushes each round: the refused push runs the full selection, the fix runs it again.
    v1: { prePushTestRuns: 2, ciRuns: 1 }
  },
  {
    id: 'ci-red-then-fixed',
    scenario: { ci: ['red', 'green'] },
    expect: {
      outcome: 'completed',
      developerTurns: 2,
      reviewRounds: 2,
      readyRuns: [ALL_TESTS, ALL_TESTS],
      prsOpened: 1,
      ciReadsByFlow: 2,
      rerunEvents: 0
    },
    v1: { prePushTestRuns: 2, ciRuns: 2 }
  }
]

beforeAll(setUpWorld)
afterAll(tearDownWorld)

const summary: string[] = []
afterAll(() => {
  process.stderr.write(`\nreview locally, push once — eval summary\n${summary.join('\n')}\n`)
})

describe('review locally, push once — evals', () => {
  for (const c of CASES) {
    test(c.id, async () => {
      const observed = await runV2('claude', c.scenario)
      const loop = observed.rawEvents.filter((e) => e.kind === 'dev_review_loop')
      const named = (name: string) => loop.filter((e) => e.event === name)
      const got = {
        outcome: observed.outcome,
        developerTurns: observed.spawns.developer,
        reviewRounds: observed.spawns['code-reviewer'],
        readyRuns: observed.world.readyRuns,
        prsOpened: observed.world.prsOpened,
        ciReadsByFlow: records(observed, 'read-ci-once').length,
        rerunEvents: named('failed_tests_rerun').length
      }
      expect(got).toEqual(c.expect)
      // The reviewers judged a local commit, with no pull request (and so no CI) before the first approval, unless
      // the run re-entered one already open.
      expect(observed.world.prOpenAtReview[0]).toBe(c.attached === true)
      // Every Developer turn was backed up by a storage push.
      expect(observed.world.remoteAfterTurn).toHaveLength(got.developerTurns)
      // The Log measures it: a ready_push per ready run, a pr_opened per opening, a ci_result_read per CI read,
      // and the time of every step.
      expect(named('ready_push')).toHaveLength(got.readyRuns.length)
      expect(named('pr_opened')).toHaveLength(got.prsOpened)
      expect(named('ci_result_read')).toHaveLength(got.ciReadsByFlow)
      expect(named('phase_time').length).toBeGreaterThan(0)
      const testFilesRun = got.readyRuns.reduce((n, run) => n + run.length, 0)
      summary.push(
        `${c.id}: rounds ${got.reviewRounds}, ready pushes ${got.readyRuns.length} (${testFilesRun} test files), CI runs ${got.ciReadsByFlow}; ` +
          `v1 would run ${c.v1.prePushTestRuns} pre-push selections (${c.v1.prePushTestRuns * ALL_TESTS.length} test files) and ${c.v1.ciRuns} CI runs`
      )
    })
  }
})
