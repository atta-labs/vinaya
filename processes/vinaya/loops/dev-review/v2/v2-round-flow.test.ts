import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'
import { loadProcess } from '../../../../../harness/dev-process/loader/load-process'
import { fixtureDir } from '../../../../../apps/cli/tests/lib/test-temp-fixture'
import { V2_APPROVED_REPAIR_ALLOWANCE, withPolicyCeilings } from '../../../bin/run-engine'
import { heldVerdictPath } from '../../../../../apps/cli/src/lib/dev-review-loop/reviewer-dispatch'
import { publicationEffectKey } from '../../../../../apps/cli/src/lib/dev-review-loop/publication'
import { readyTestCommand } from '../../../../../apps/cli/src/lib/pre-push-test-runner'
import { ALL_TESTS, AGENTS, confident, PR, records, TASK, runV2, setUpWorld, tearDownWorld } from './v2-world'

// Version 2 of the developer-review Flow (review locally, push once), end to end on the real runner, Flow and
// actions with fakes for the forge, the ready push and the agents: approve in round 1; revise then approve; a ready
// push refused by a failing test, then fixed with only that test re-run; CI red, then fixed.

beforeAll(setUpWorld)
afterAll(tearDownWorld)

const loopEvents = (events: string[]) =>
  events.filter((e) => e.startsWith('dev_review_loop/')).map((e) => e.slice('dev_review_loop/'.length))

for (const agent of AGENTS) {
  describe(`approve in round 1 (${agent})`, () => {
    test('local round, one ready push, the pull request opens and CI runs once', async () => {
      const observed = await runV2(agent)
      expect(observed.outcome).toBe('completed')
      expect(observed.spawns.developer).toBe(1)
      expect(observed.spawns['code-reviewer']).toBe(1)
      // The reviewers judged the local commit with no pull request open, and the storage push moved the remote.
      expect(observed.world.prOpenAtReview.every((open) => open === false)).toBe(true)
      expect(observed.world.remoteAfterTurn).toHaveLength(1)
      expect(observed.world.readyRuns).toEqual([ALL_TESTS])
      expect(observed.world.prsOpened).toBe(1)
      expect(observed.world.ciReads).toBe(1)
      expect(observed.world.storageEnded).toBe(1)
      expect(observed.published).toHaveLength(1)
      const events = loopEvents(observed.events)
      for (const name of ['local_checks_run', 'ready_push', 'pr_opened', 'ci_result_read', 'phase_time'])
        expect(events).toContain(name)
      expect(events).not.toContain('failed_tests_rerun')
      expect(events.indexOf('ready_push')).toBeLessThan(events.indexOf('pr_opened'))
      expect(events.indexOf('pr_opened')).toBeLessThan(events.indexOf('ci_result_read'))
      // No pull request round marker was posted while the rounds were local.
      expect(observed.markers).toEqual([])
    })
  })
}

describe('revise then approve', () => {
  test('two local rounds, then one ready push and one CI read', async () => {
    const observed = await runV2('claude', {
      reviewer: (role, attempt) => (role === 'code-reviewer' && attempt === 1 ? 'request-changes' : 'approve')
    })
    expect(observed.outcome).toBe('completed')
    expect(observed.spawns.developer).toBe(2)
    expect(observed.spawns['code-reviewer']).toBe(2)
    expect(observed.world.prOpenAtReview.every((open) => open === false)).toBe(true)
    // Each Developer turn was backed up by a storage push.
    expect(new Set(observed.world.remoteAfterTurn).size).toBe(2)
    expect(observed.world.readyRuns).toHaveLength(1)
    expect(observed.world.prsOpened).toBe(1)
    expect(observed.world.ciReads).toBe(1)
    expect(loopEvents(observed.events).filter((e) => e === 'ready_push')).toHaveLength(1)
  })
})

describe('a ready push refused by a failing test', () => {
  test('goes back to the Developer, and the next ready push re-runs only that test', async () => {
    const observed = await runV2('claude', {
      failingTests: (attempt) => (attempt === 1 ? ['/repo/b.test.ts'] : [])
    })
    expect(observed.outcome).toBe('completed')
    expect(observed.world.readyRuns).toEqual([ALL_TESTS, ['/repo/b.test.ts']])
    expect(observed.spawns.developer).toBe(2)
    // The Developer's second turn was told which test failed.
    expect(observed.prompts.developer[1]).toContain('the ready push refused it')
    expect(observed.prompts.developer[1]).toContain('/repo/b.test.ts')
    // No pull request opened before the passing ready push; it opened once.
    expect(observed.world.prsOpened).toBe(1)
    expect(observed.world.ciReads).toBe(1)
    const [refused, passed] = records(observed, 'ready-push')
    expect(refused?.outcome).toBe('refused')
    expect(refused?.sendBack).toMatchObject({ kind: 'ready-refused' })
    expect(passed?.outcome).toBe('passed')
    const events = loopEvents(observed.events)
    expect(events.filter((e) => e === 'ready_push')).toHaveLength(2)
    expect(events.filter((e) => e === 'failed_tests_rerun')).toHaveLength(1)
    const rerun = observed.rawEvents.find((e) => e.event === 'failed_tests_rerun')
    expect(rerun).toMatchObject({ failed_files: 1, affected_files: 0, full_count: 3 })
  })
})

describe('CI red after the pull request opened', () => {
  test('goes back to the Developer, whose fix is reviewed and pushed again; CI is read once per approval', async () => {
    const observed = await runV2('claude', { ci: ['red', 'green'] })
    expect(observed.outcome).toBe('completed')
    expect(observed.spawns.developer).toBe(2)
    // One CI read per approval by the flow (the round-2 reviewers, with the pull request now open, also see its CI).
    expect(records(observed, 'read-ci-once')).toHaveLength(2)
    // The pull request opened once; the second approval kept it.
    expect(observed.world.prsOpened).toBe(1)
    expect(records(observed, 'open-pull-request').map((r) => r.opened)).toEqual([true, false])
    expect(observed.prompts.developer[1]).toContain(`CI is red on pull request #${PR}`)
    const ci = observed.rawEvents.filter((e) => e.event === 'ci_result_read').map((e) => e.conclusion)
    expect(ci).toEqual(['red', 'green'])
    expect(observed.published).toHaveLength(2)
  })
})

describe('the ready push tests exactly the approved commit', () => {
  test('a head moved after approval is refused without running the tests, and goes back through review', async () => {
    let moved = false
    const observed = await runV2('claude', {
      after: {
        'assess-round': (world) => {
          if (moved) return
          moved = true
          world.commit(true)
        }
      }
    })
    expect(observed.outcome).toBe('completed')
    expect(observed.spawns.developer).toBe(2)
    expect(observed.spawns['code-reviewer']).toBe(2)
    // The moved head never reached the hook: the only ready run is the one after the second approval.
    expect(observed.world.readyRuns).toHaveLength(1)
    const refused = observed.steps.find(
      (step) => step.node === 'ready-push' && step.stdout.includes('not the approved head')
    )
    expect(refused).toBeDefined()
  })

  test('uncommitted changes after approval are refused without running the tests', async () => {
    let dirtied = false
    const observed = await runV2('claude', {
      after: {
        'assess-round': (world) => {
          if (dirtied) return
          dirtied = true
          writeFileSync(join(world.worktree, 'stray.ts'), 'export const stray = 1\n')
        }
      },
      developer: (_attempt, world) => ({
        output: confident(90),
        act: () => {
          rmSync(join(world.worktree, 'stray.ts'), { force: true })
          world.commit(true)
          world.staged = { title: 'Feat(sample): Do the thing', body: `Closes #${TASK}` }
          world.remoteAfterTurn.push(world.remote)
        }
      })
    })
    expect(observed.outcome).toBe('completed')
    expect(observed.world.readyRuns).toHaveLength(1)
    const refused = observed.steps.find(
      (step) => step.node === 'ready-push' && step.stdout.includes('uncommitted changes')
    )
    expect(refused).toBeDefined()
  })
})

describe('a ready push past its deadline', () => {
  test('is a recorded timeout that goes back to the Developer, and the next ready push runs its full selection', async () => {
    const observed = await runV2('claude', { readyTimesOut: (attempt) => attempt === 1 })
    expect(observed.outcome).toBe('completed')
    expect(observed.world.readyRuns).toEqual([ALL_TESTS, ALL_TESTS])
    const [timedOut, passed] = records(observed, 'ready-push')
    expect(timedOut?.outcome).toBe('timed-out')
    expect(timedOut?.sendBack).toMatchObject({ kind: 'ready-refused' })
    expect(passed?.outcome).toBe('passed')
    expect(observed.prompts.developer[1]).toContain('ran past the deadline')
  })
})

describe('the loop writes the Evidence block', () => {
  test('once the pull request opens, for the head the ready push passed; every ready push gets the run signal', async () => {
    const observed = await runV2('claude')
    expect(observed.world.evidenceWrites).toEqual([{ pr: PR, head: observed.world.remote }])
    expect(records(observed, 'open-pull-request')[0]?.evidence).toBe('written')
    expect(observed.world.readySignals).toEqual([true])
  })
})

describe('the opened body carries the ready push command as its Test Plan line', () => {
  test('so the Evidence write reuses that run instead of running the tests again', async () => {
    const body = ['## Test plan', '', '```', 'bun test other.test.ts → passes', '```', ''].join('\n')
    const observed = await runV2('claude', {
      after: {
        'ready-push': (world) => {
          world.staged = { title: 'Feat(x): y', body }
        }
      }
    })
    expect(observed.world.openedBodies).toHaveLength(1)
    expect(observed.world.openedBodies[0]).toContain(readyTestCommand(ALL_TESTS))
    expect(observed.world.openedBodies[0]).not.toContain('other.test.ts')
  })
})

describe('Log rounds follow review rounds', () => {
  function expectReviewRounds(observed: Awaited<ReturnType<typeof runV2>>) {
    expect(observed.outcome).toBe('completed')
    const loop = observed.rawEvents.filter((event) => event.kind === 'dev_review_loop')
    expect(loop.filter((event) => event.event === 'round_ended').map((event) => event.round)).toEqual([1, 2])
    const checks = loop.filter((event) => event.event === 'local_checks_run')
    expect(checks.map((event) => event.round)).toEqual([1, 2])
    for (const round of [1, 2]) {
      const start = loop.findIndex(
        (event) => event.event === 'phase_time' && event.step === 'develop' && event.round === round
      )
      expect(start).toBeGreaterThanOrEqual(0)
      const next = loop.findIndex(
        (event, index) =>
          index > start && event.event === 'phase_time' && event.step === 'develop' && event.round === round + 1
      )
      const events = loop.slice(start, next < 0 ? undefined : next).filter((event) => typeof event.round === 'number')
      expect(events.length).toBeGreaterThan(0)
      expect([...new Set(events.map((event) => event.round))]).toEqual([round])
    }
  }

  test('validation re-dispatch keeps round 1 and the next review round is round 2', async () => {
    const observed = await runV2('claude', {
      developer: (attempt, world) =>
        attempt === 1
          ? {
              act: () => {
                world.commit(true)
                world.staged = { title: 'Feat(sample): Do the thing', body: `Closes #${TASK}` }
              }
            }
          : attempt === 2
            ? { output: confident(90) }
            : undefined,
      reviewer: (role, attempt) => (role === 'code-reviewer' && attempt === 1 ? 'request-changes' : 'approve')
    })
    expect(observed.spawns.developer).toBe(3)
    expect(
      observed.steps.filter((step) => step.node === 'validate-developer-output' && step.exitCode !== 0)
    ).toHaveLength(1)
    expectReviewRounds(observed)
  })

  test('successful tool-host loss keeps the review round without replay after a validation retry', async () => {
    const observed = await runV2('claude', {
      developer: (attempt, world) =>
        attempt === 1
          ? {
              act: () => {
                world.commit(true)
                world.staged = { title: 'Feat(sample): Do the thing', body: `Closes #${TASK}` }
              }
            }
          : attempt === 2
            ? { output: confident(90) }
            : undefined,
      loseDeveloperToolsAt: 3,
      reviewer: (role, attempt) => (role === 'code-reviewer' && attempt === 1 ? 'request-changes' : 'approve')
    })
    expect(observed.spawns.developer).toBe(3)
    expect(observed.steps.filter((step) => step.node === 'validate-developer-output')).toHaveLength(3)
    expectReviewRounds(observed)
  })
})

for (const agent of AGENTS) {
  describe(`ready-push failures have their own budget (${agent})`, () => {
    test('two refused ready pushes after approval at the review cap still get fresh Developer turns', async () => {
      const observed = await runV2(agent, {
        policy: { maxRounds: 2 },
        reviewer: (role, attempt) => (role === 'code-reviewer' && attempt === 1 ? 'request-changes' : 'approve'),
        failingTests: (attempt) => (attempt <= 2 ? ['/repo/b.test.ts'] : [])
      })
      expect(observed.outcome).toBe('completed')
      expect(observed.spawns.developer).toBe(4)
      expect(observed.world.readyRuns).toHaveLength(3)
      expect(observed.trace.pauseReason ?? null).toBeNull()
    })
    test('approved CI repairs never spend the review ceiling before three ready-push failures', async () => {
      const observed = await runV2(agent, {
        policy: { maxRounds: 1 },
        ci: ['red'],
        failingTests: (attempt) => (attempt >= 5 ? ['/repo/b.test.ts'] : [])
      })
      expect(observed.outcome).toBe('pause:ready_push_failed')
      expect(observed.trace.pauseReason).toBe('ready_push_failed')
      expect(records(observed, 'read-ci-once')).toHaveLength(4)
      expect(observed.world.readyRuns).toHaveLength(7)
      expect(observed.spawns.developer).toBe(7)
      expect(observed.spawns['code-reviewer']).toBe(7)
      expect(
        observed.rawEvents.filter((event) => event.event === 'round_ended').every((event) => event.round === 1)
      ).toBe(true)
      expect(records(observed, 'ready-push').at(-1)?.readyPushFailures).toBe(3)
    })
    test('requested changes still pause at the configured review ceiling', async () => {
      const observed = await runV2(agent, {
        policy: { maxRounds: 1 },
        reviewer: (role) => (role === 'code-reviewer' ? 'request-changes' : 'approve')
      })
      expect(observed.outcome).toBe('pause:max_rounds')
      expect(observed.spawns.developer).toBe(1)
      expect(observed.world.readyRuns).toHaveLength(0)
    })
    test('the third consecutive ready-push failure pauses by name with its failing files', async () => {
      const observed = await runV2(agent, { policy: { maxRounds: 1 }, failingTests: () => ['/repo/b.test.ts'] })
      expect(observed.outcome).toBe('pause:ready_push_failed')
      expect(observed.trace.pauseReason).toBe('ready_push_failed')
      expect(observed.world.readyRuns).toHaveLength(3)
      expect(observed.spawns.developer).toBe(3)
      expect(records(observed, 'ready-push').at(-1)?.decision).toMatchObject({
        type: 'pause',
        reason: 'ready_push_failed',
        detail: expect.stringContaining('/repo/b.test.ts')
      })
    })
  })
}

test('approved CI repairs remain bounded by the configured active-time budget', async () => {
  const clock = { elapsedMs: 0, byPhaseMs: {} }
  const observed = await runV2('claude', {
    policy: { maxRounds: 1, maxTaskMinutes: 1 },
    ci: ['red'],
    clock,
    after: {
      'read-ci-once': () => {
        clock.elapsedMs += 30001
      }
    }
  })
  expect(observed.outcome).toBe('pause:time_budget')
  expect(records(observed, 'read-ci-once')).toHaveLength(2)
  expect(observed.world.readyRuns).toHaveLength(2)
})

test('version 2 policy budgets are independent of dispatch counts and version 1 ceilings stay unchanged', () => {
  for (const flow of ['v1', 'v2'] as const) {
    const loaded = loadProcess(resolve(import.meta.dir, '../../..'), { flow })
    const rendered = withPolicyCeilings(loaded, fixtureDir('ceilings-'), 2)
    const parsed = parse(readFileSync(rendered.flowPath, 'utf8')) as {
      steps: Array<{ decision?: { max_revisions: number } }>
    }
    const ceilings = parsed.steps.flatMap((step) => (step.decision ? [step.decision.max_revisions] : []))
    expect(ceilings.length).toBeGreaterThan(0)
    expect(new Set(ceilings)).toEqual(new Set([flow === 'v2' ? 2 + V2_APPROVED_REPAIR_ALLOWANCE : 2]))
  }
})

test('the repair turn names the failed files and the ready-hook contract', async () => {
  const observed = await runV2('claude', { failingTests: (attempt) => (attempt === 1 ? ['/repo/b.test.ts'] : []) })
  expect(observed.outcome).toBe('completed')
  const prompt = observed.prompts.developer[1] ?? ''
  expect(prompt).toContain('/repo/b.test.ts')
  expect(prompt).toContain('selected test files on the approved head')
  expect(prompt).toContain("repository's pre-push hook in ready mode")
  expect(prompt).toContain('20-minute deadline')
  expect(prompt).toContain('Run the named failing files before publishing')
})

test('each round duration includes Developer and reviewer time rather than just local checks', async () => {
  let now = 1000
  const observed = await runV2('claude', {
    now: () => now,
    reviewer: (role, attempt) => (role === 'code-reviewer' && attempt === 1 ? 'request-changes' : 'approve'),
    after: {
      'validate-developer-output': () => {
        now += 60000
      },
      'assess-gate': () => {
        now += 2000
      },
      'validate-reviewer-outputs': () => {
        now += 30000
      }
    }
  })
  expect(observed.outcome).toBe('completed')
  const rounds = observed.rawEvents.filter((event) => event.event === 'round_ended')
  expect(rounds.map((event) => [event.round, event.wall_ms])).toEqual([
    [1, 92000],
    [2, 92000]
  ])
})

test('a restarted driver measures the round from its checkpointed start', async () => {
  let now = 1000
  const observed = await runV2('claude', {
    now: () => now,
    restartAfter: {
      step: 'dispatch-reviewers',
      beforeResume: () => {
        now += 120000
      }
    },
    after: {
      'validate-developer-output': () => {
        now += 60000
      },
      'assess-gate': () => {
        now += 2000
      },
      'validate-reviewer-outputs': () => {
        now += 30000
      }
    }
  })
  expect(observed.driverLegs).toBe(2)
  expect(observed.outcome).toBe('completed')
  expect(observed.spawns.developer).toBe(1)
  expect(
    observed.rawEvents.filter((event) => event.event === 'round_ended').map((event) => [event.round, event.wall_ms])
  ).toEqual([[1, 212000]])
})

for (const ci of [['green'], ['red', 'green']] as Array<Array<'green' | 'red'>>) {
  test(`verdicts precede each approved head's CI read without a final duplicate (${ci.join(',')})`, async () => {
    const readHeads: string[] = []
    const observed = await runV2('claude', {
      ci,
      after: {
        'read-ci-once': (world) => {
          expect(world.verdictHeads).toContain(world.remote)
          readHeads.push(world.remote)
        }
      }
    })
    expect(observed.outcome).toBe('completed')
    expect(observed.world.verdictHeads).toEqual(readHeads)
    expect(observed.published).toHaveLength(ci.length)
    expect(new Set(readHeads).size).toBe(ci.length)
  })
}

test('publication effects bind to each approved head without changing legacy identities', () => {
  for (const kind of ['reviewer-verdict', 'security-verdict', 'summary'] as const) {
    const first = { round: 1, expectedHead: 'head-one', headScopedEffects: true }
    expect(publicationEffectKey(first, kind)).toBe(publicationEffectKey({ ...first }, kind))
    expect(publicationEffectKey(first, kind)).not.toBe(
      publicationEffectKey({ ...first, expectedHead: 'head-two' }, kind)
    )
    expect(publicationEffectKey({ round: 1, expectedHead: 'anything' }, kind)).toBe(`1-${kind}`)
  }
})

test('a ready-push pause leaves no held approval that resume could publish', async () => {
  const observed = await runV2('codex', { policy: { maxRounds: 1 }, failingTests: () => ['/repo/b.test.ts'] })
  expect(observed.outcome).toBe('pause:ready_push_failed')
  for (const role of ['reviewer', 'security'] as const)
    expect(existsSync(heldVerdictPath(observed.world.runtimeDir, TASK, 1, role))).toBe(false)
})
