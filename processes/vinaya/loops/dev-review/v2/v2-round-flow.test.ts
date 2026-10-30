import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'
import { loadProcess } from '../../../../../harness/dev-process/loader/load-process'
import { fixtureDir } from '../../../../../apps/cli/tests/lib/test-temp-fixture'
import { decodeLoopState, type latestRecord, recordOutput } from '../../../executing/actions'
import { V2_APPROVED_REPAIR_ALLOWANCE, exhaustedPause, withPolicyCeilings } from '../../../bin/run-engine'
import { heldVerdictPath } from '../../../../../apps/cli/src/lib/dev-review-loop/reviewer-dispatch'
import { publicationEffectKey } from '../../../../../apps/cli/src/lib/dev-review-loop/publication'
import { conflictRepairFailure, readyTestPlanCommand } from './v2-actions'
import {
  ALL_TESTS,
  AGENTS,
  confident,
  PR,
  records,
  TASK,
  runV2,
  type Scenario,
  setUpWorld,
  tearDownWorld
} from './v2-world'

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

describe('CI red with failed jobs on the head', () => {
  test('the Developer prompt carries each failed job’s failure lines, and names a job whose log was unreadable', async () => {
    const observed = await runV2('claude', {
      ci: ['red', 'green'],
      failingRuns: [
        { name: 'test-shard-1', id: 501 },
        { name: 'test-shard-2', id: 502 },
        { name: 'workflow CI', id: 503, detail: 'workflow CI run 503 ended failure with no failing job' }
      ],
      jobExcerpts: { 501: '(fail) loop > sends back on red CI\nExpected: 1\nReceived: 2', 502: null }
    })
    expect(observed.outcome).toBe('completed')
    const prompt = observed.prompts.developer[1] ?? ''
    expect(prompt).toContain('(fail) loop > sends back on red CI')
    expect(prompt).toContain('Received: 2')
    expect(prompt).toContain('Failure lines of `test-shard-1` (run 501)')
    expect(prompt).toContain('Failure lines of `test-shard-2` (run 502): the job log could not be read.')
    expect(prompt).not.toContain('(run 503)')
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
  test('pauses for a person naming the limit and the selected files, with no send-back and no Developer turn', async () => {
    const observed = await runV2('claude', {
      policy: { readyPushTimeoutMinutes: 45 },
      readyTimesOut: () => true
    })
    expect(observed.outcome).toBe('pause:ready_push_failed')
    expect(observed.trace.pauseReason).toBe('ready_push_failed')
    expect(observed.world.readyRuns).toEqual([ALL_TESTS])
    expect(observed.spawns.developer).toBe(1)
    const [timedOut] = records(observed, 'ready-push')
    expect(timedOut?.outcome).toBe('timed-out')
    expect(timedOut?.sendBack ?? null).toBeNull()
    expect(timedOut?.readyPushFailures).toBe(0)
    expect(timedOut?.decision).toMatchObject({
      type: 'pause',
      reason: 'ready_push_failed',
      detail: expect.stringContaining(`${ALL_TESTS.length} selected test files at its 45-minute limit`)
    })
  })

  test('names the default limit when the policy sets none', async () => {
    const observed = await runV2('claude', { readyTimesOut: () => true })
    expect(records(observed, 'ready-push')[0]?.decision).toMatchObject({
      detail: expect.stringContaining('at its 20-minute limit')
    })
  })

  test('a real test failure is still sent back with its failing lines', async () => {
    const observed = await runV2('claude', { failingTests: (attempt) => (attempt === 1 ? ['/repo/b.test.ts'] : []) })
    expect(observed.outcome).toBe('completed')
    const [refused] = records(observed, 'ready-push')
    expect(refused?.outcome).toBe('refused')
    expect(refused?.sendBack).toMatchObject({ kind: 'ready-refused' })
    expect(observed.prompts.developer[1]).toContain('/repo/b.test.ts')
  })
})

describe('the loop writes the Evidence block', () => {
  test('retries a transient failure once and logs the failed attempt', async () => {
    const observed = await runV2('claude', {
      evidenceResult: (attempt) =>
        attempt === 1 ? { ok: false, reason: 'forge unavailable', retryable: true } : { ok: true }
    })
    expect(observed.world.evidenceWrites).toHaveLength(2)
    expect(observed.world.evidenceWaits).toEqual([1000])
    expect(observed.world.evidenceLogs).toEqual([`Evidence write for pull request #${PR} failed: forge unavailable`])
    expect(records(observed, 'open-pull-request')[0]?.evidence).toBe('written')
  })

  test('does not retry a policy refusal and leaves routing to CI', async () => {
    const observed = await runV2('claude', {
      evidenceResult: () => ({ ok: false, reason: 'policy_refusal', retryable: false })
    })
    expect(observed.world.evidenceWrites).toHaveLength(1)
    expect(observed.world.evidenceWaits).toEqual([])
    expect(observed.world.evidenceLogs).toEqual([`Evidence write for pull request #${PR} failed: policy_refusal`])
    expect(records(observed, 'open-pull-request')[0]?.evidence).toBe('not written: policy_refusal')
    expect(observed.world.ciReads).toBe(1)
  })

  test('records the final failure after the single retry, logging both attempts', async () => {
    const observed = await runV2('claude', {
      evidenceResult: (attempt) => ({ ok: false, reason: `forge failure ${attempt}`, retryable: true })
    })
    expect(observed.world.evidenceWrites).toHaveLength(2)
    expect(observed.world.evidenceWaits).toEqual([1000])
    expect(observed.world.evidenceLogs).toEqual([
      `Evidence write for pull request #${PR} failed: forge failure 1`,
      `Evidence write for pull request #${PR} failed: forge failure 2`
    ])
    expect(records(observed, 'open-pull-request')[0]?.evidence).toBe('not written: forge failure 2')
    expect(observed.world.ciReads).toBe(1)
  })

  test('retries a thrown forge failure without sleeping in the fake world', async () => {
    const observed = await runV2('claude', {
      evidenceResult: (attempt) => {
        if (attempt === 1) throw new Error('forge threw\nretry later')
        return { ok: true }
      }
    })
    expect(observed.world.evidenceWrites).toHaveLength(2)
    expect(observed.world.evidenceWaits).toEqual([1000])
    expect(observed.world.evidenceLogs).toEqual([
      `Evidence write for pull request #${PR} failed: forge threw retry later`
    ])
    expect(records(observed, 'open-pull-request')[0]?.evidence).toBe('written')
  })

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
    expect(observed.world.openedBodies[0]).toContain(readyTestPlanCommand(ALL_TESTS, observed.world.worktree))
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

test('approved repairs whose CI never turns green pause by name, never as max_rounds', async () => {
  const observed = await runV2('claude', { policy: { maxRounds: 1, maxTaskMinutes: 0 }, ci: ['red'] })
  expect(observed.outcome).toBe('exhausted')
  expect(exhaustedPause('v2').reason).toBe('approved_repairs_spent')
  expect(exhaustedPause('v1').reason).toBe('max_rounds')
  expect(observed.rawEvents.filter((event) => event.event === 'round_ended').every((event) => event.round === 1)).toBe(
    true
  )
}, 60_000)

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
  expect(prompt).not.toContain('deadline')
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

test('the first record after a ready-push pause, written on resume, starts a fresh failure count', async () => {
  const observed = await runV2('codex', { policy: { maxRounds: 1 }, failingTests: () => ['/repo/b.test.ts'] })
  const paused = records(observed, 'ready-push').at(-1) as Record<string, unknown>
  expect(paused.readyPushFailures).toBe(3)
  const results = { 'ready-push': { stdout: JSON.stringify(paused) } } as unknown as Parameters<typeof latestRecord>[0]
  const resumed = JSON.parse(recordOutput(results, decodeLoopState(JSON.stringify(paused.state)), {})) as {
    readyPushFailures?: number
  }
  expect(resumed.readyPushFailures).toBe(0)
})

test('a ready-push pause leaves no held approval that resume could publish', async () => {
  const observed = await runV2('codex', { policy: { maxRounds: 1 }, failingTests: () => ['/repo/b.test.ts'] })
  expect(observed.outcome).toBe('pause:ready_push_failed')
  for (const role of ['reviewer', 'security'] as const)
    expect(existsSync(heldVerdictPath(observed.world.runtimeDir, TASK, 1, role))).toBe(false)
})

// A published pull request that falls into conflict with the default branch, re-entered by a fresh run: the
// Developer's conflict turn comes first, and no reviewer judges the repair until the controller proves the merge.
const conflictReentry = (developer: Scenario['developer'], extra: Scenario = {}): Scenario => ({
  attachAtRound: 1,
  setUp: (world) => {
    world.commit(true)
    world.moveMain()
  },
  developer,
  ...extra
})
const proofOutcomes = (observed: Awaited<ReturnType<typeof runV2>>) =>
  records(observed, 'prove-conflict-repair')
    .filter((record) => record.proof !== 'not-owed')
    .map((record) => (record.decision?.type === 'conflict_repair_proven' ? 'proven' : String(record.failure)))

for (const agent of AGENTS) {
  describe(`a conflict re-entry (${agent})`, () => {
    test('the first Developer turn is the conflict turn, with the paths and the fetched tip, before any check or reviewer', async () => {
      let tip = ''
      let merged = ''
      const observed = await runV2(
        agent,
        conflictReentry((attempt, world) =>
          attempt === 1
            ? {
                output: confident(90),
                act: () => {
                  tip = world.mainTip()
                  merged = world.mergeMain(true)
                }
              }
            : undefined
        )
      )
      expect(observed.outcome).toBe('completed')
      expect(observed.spawns.developer).toBe(1)
      const [first] = observed.prompts.developer
      expect(first).toContain('- sample.ts')
      expect(first).toContain(`git merge --no-commit ${tip}`)
      // A fresh run's conflict turn starts the session, so it carries the brief as well.
      expect(first).toContain('# Frozen brief')
      expect(observed.world.gateRunsAtDeveloper).toEqual([0])
      const [reconciled] = records(observed, 'reconcile-external-state')
      expect(reconciled?.sendBack).toMatchObject({ kind: 'conflict', files: ['sample.ts'], mainTip: tip })
      expect(proofOutcomes(observed)).toEqual(['proven'])
      // The reviewers judged the proven merge, on the same pull request.
      expect(observed.spawns['code-reviewer']).toBe(1)
      expect(observed.prompts['code-reviewer'][0]).toContain(merged)
      expect(observed.world.prsOpened).toBe(0)
      expect(observed.world.verdictHeads).toEqual([merged])
    })

    test('a single-parent commit is sent back unproven and never reaches a reviewer', async () => {
      let wording = ''
      const observed = await runV2(
        agent,
        conflictReentry((attempt, world) => ({
          output: confident(90),
          act: () => {
            if (attempt === 1) wording = world.commit(true)
            else world.mergeMain(true)
          }
        }))
      )
      expect(observed.outcome).toBe('completed')
      expect(observed.spawns.developer).toBe(2)
      expect(proofOutcomes(observed)).toEqual(['single-parent', 'proven'])
      expect(observed.prompts.developer[1]).toContain('single-parent commit, not a merge of the default branch')
      expect(observed.prompts.developer[1]).toContain('- sample.ts')
      expect(observed.spawns['code-reviewer']).toBe(1)
      for (const prompt of [...observed.prompts['code-reviewer'], ...observed.prompts['security-reviewer']])
        expect(prompt).not.toContain(wording)
      expect(observed.world.gateRunsAtDeveloper).toEqual([0, 0])
    })

    test('an unchanged head is sent back, and the same unproven repair twice pauses with no reviewer run', async () => {
      const observed = await runV2(
        agent,
        conflictReentry(() => ({ output: confident(90) }))
      )
      expect(observed.outcome).toBe('pause:repeat_failure')
      expect(proofOutcomes(observed)).toEqual(['unchanged-head', 'unchanged-head'])
      expect(observed.spawns.developer).toBe(2)
      expect(observed.spawns['code-reviewer']).toBe(0)
      expect(observed.spawns['security-reviewer']).toBe(0)
      expect(observed.gateRuns).toBe(0)
      expect(observed.published).toEqual([])
    })

    test('a mergeability other than MERGEABLE holds the proven merge back from the reviewers', async () => {
      let merged = ''
      const observed = await runV2(
        agent,
        conflictReentry(
          (attempt, world) => ({
            output: confident(90),
            act: () => {
              if (attempt === 1) merged = world.mergeMain(true)
            }
          }),
          { mergeable: (fromGit, world) => (merged !== '' && world.remote === merged ? 'UNKNOWN' : fromGit) }
        )
      )
      expect(proofOutcomes(observed)[0]).toBe('not-mergeable')
      expect(observed.prompts.developer[1]).toContain('mergeability is CONFLICTING, not MERGEABLE')
      expect(observed.outcome).toBe('pause:repeat_failure')
      expect(observed.spawns['code-reviewer']).toBe(0)
      expect(observed.published).toEqual([])
    })

    test('a failed open-pull-request lookup during the proof fails closed: unproven, no reviewer', async () => {
      let merged = ''
      const observed = await runV2(
        agent,
        conflictReentry(
          (attempt, world) => ({
            output: confident(90),
            act: () => {
              if (attempt === 1) merged = world.mergeMain(true)
            }
          }),
          { pullRequestLookupFails: () => merged !== '' }
        )
      )
      expect(proofOutcomes(observed)[0]).toBe('pr-unreadable')
      expect(proofOutcomes(observed)).not.toContain('proven')
      expect(observed.prompts.developer[1]).toContain('could not be read, so its mergeability is unknown')
      expect(observed.spawns['code-reviewer']).toBe(0)
      expect(observed.spawns['security-reviewer']).toBe(0)
      expect(observed.published).toEqual([])
    })

    test('main moving while the reviewers run lets both finish; the conflict is handled after their verdicts', async () => {
      let merged = ''
      const observed = await runV2(agent, {
        attachAtRound: 1,
        setUp: (world) => void world.commit(true),
        reviewer: (role, attempt, world) => {
          if (role === 'code-reviewer' && attempt === 1) world.moveMain()
          return 'approve'
        },
        developer: (attempt, world) =>
          attempt === 1
            ? {
                output: confident(90),
                act: () => {
                  merged = world.mergeMain(true)
                }
              }
            : undefined
      })
      expect(observed.outcome).toBe('completed')
      // One launch per reviewer per round: the first round's reviewers were neither cancelled nor replaced.
      expect(observed.spawns['code-reviewer']).toBe(2)
      expect(observed.spawns['security-reviewer']).toBe(2)
      expect(observed.spawns.developer).toBe(1)
      const nodes = observed.steps.map((step) => step.node)
      const conflictAt = observed.steps.findIndex(
        (step) => step.node === 'check-publish-mergeability' && step.exitCode === 1
      )
      expect(conflictAt).toBeGreaterThan(nodes.indexOf('validate-reviewer-outputs'))
      expect(proofOutcomes(observed)).toEqual(['proven'])
      expect(observed.world.verdictHeads.at(-1)).toBe(merged)
    })
  })
}

const mergeOnce: Scenario['developer'] = (attempt, world) =>
  attempt === 1
    ? {
        output: confident(90),
        act: () => {
          world.mergeMain(true)
        }
      }
    : undefined

for (const agent of AGENTS) {
  describe(`conflict state survives a checkpoint restart (${agent})`, () => {
    test('a restart after the conflict is recorded runs one conflict turn, not two and not none', async () => {
      const observed = await runV2(
        agent,
        conflictReentry(mergeOnce, { restartAfter: { step: 'reconcile-external-state', beforeResume: () => {} } })
      )
      expect(observed.driverLegs).toBe(2)
      expect(observed.outcome).toBe('completed')
      expect(observed.spawns.developer).toBe(1)
      expect(observed.prompts.developer[0]).toContain('- sample.ts')
      expect(observed.spawns['code-reviewer']).toBe(1)
      expect(observed.published).toHaveLength(1)
    })

    test('a restart after the merge is proven keeps the proof: no second conflict turn, review or verdict post', async () => {
      const observed = await runV2(
        agent,
        conflictReentry(mergeOnce, { restartAfter: { step: 'prove-conflict-repair', beforeResume: () => {} } })
      )
      expect(observed.driverLegs).toBe(2)
      expect(observed.outcome).toBe('completed')
      expect(observed.spawns.developer).toBe(1)
      expect(proofOutcomes(observed)).toEqual(['proven'])
      expect(observed.spawns['code-reviewer']).toBe(1)
      expect(observed.spawns['security-reviewer']).toBe(1)
      expect(observed.published).toHaveLength(1)
    })
  })
}

// A published pull request whose CI turned red once every run on its head completed, re-entered by a fresh run: the
// reconcile step records the failing checks, and the Developer's first turn answers them before any check or reviewer.
const ciRedReentry = (extra: Scenario = {}): Scenario => ({
  attachAtRound: 1,
  setUp: (world) => void world.commit(true),
  settledCi: 'red',
  failingRuns: [
    { name: 'evidence-fresh', id: 601 },
    { name: 'test-cli (1)', id: 602 }
  ],
  jobExcerpts: { 601: 'Evidence is stale for the head', 602: '(fail) watch > reads red' },
  ...extra
})

for (const agent of AGENTS) {
  describe(`a red CI re-entry (${agent})`, () => {
    test('the first Developer turn names each failing check, before any check or reviewer', async () => {
      const observed = await runV2(agent, ciRedReentry())
      expect(observed.outcome).toBe('completed')
      expect(observed.spawns.developer).toBe(1)
      const [first] = observed.prompts.developer
      expect(first).toContain(`CI turned red on pull request #${PR}`)
      expect(first).toContain('evidence-fresh (run 601)')
      expect(first).toContain('test-cli (1) (run 602)')
      expect(first).toContain('(fail) watch > reads red')
      // A fresh run's red turn starts the session, so it carries the brief as well.
      expect(first).toContain('# Frozen brief')
      expect(observed.world.gateRunsAtDeveloper).toEqual([0])
      const [reconciled] = records(observed, 'reconcile-external-state')
      expect(reconciled?.sendBack).toMatchObject({ kind: 'ci-red' })
      expect(reconciled?.failingChecks).toEqual(['evidence-fresh (run 601)', 'test-cli (1) (run 602)'])
      // The fix is reviewed and published on the same pull request.
      expect(observed.spawns['code-reviewer']).toBe(1)
      expect(observed.world.prsOpened).toBe(0)
      expect(observed.published).toHaveLength(1)
    })

    test('a restart after the red is recorded runs one red turn, not two and not none', async () => {
      const observed = await runV2(
        agent,
        ciRedReentry({ restartAfter: { step: 'reconcile-external-state', beforeResume: () => {} } })
      )
      expect(observed.driverLegs).toBe(2)
      expect(observed.outcome).toBe('completed')
      expect(observed.spawns.developer).toBe(1)
      expect(observed.prompts.developer[0]).toContain('evidence-fresh (run 601)')
      expect(observed.published).toHaveLength(1)
    })
  })
}

test('an open pull request whose CI is not red attaches at the local checks, as before', async () => {
  const observed = await runV2('claude', ciRedReentry({ settledCi: 'pending' }))
  expect(observed.outcome).toBe('completed')
  const [reconciled] = records(observed, 'reconcile-external-state')
  // The step records the open pull request alone, with no send-back.
  expect(reconciled).toMatchObject({ number: PR })
  expect(reconciled?.sendBack).toBeUndefined()
  expect(observed.spawns.developer ?? 0).toBe(0)
})

// The proof's local half on real git histories: each way a repair can fall short, and the merges that hold.
describe('conflictRepairFailure on real git histories', () => {
  const setUpRepo = () => {
    const dir = fixtureDir('conflict-proof-')
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      }).trim()
    const tryGit = (...args: string[]) => {
      try {
        git(...args)
      } catch {}
    }
    const write = (content: string) => writeFileSync(join(dir, 'a.ts'), content)
    git('init', '-q', '-b', 'main')
    write('base\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'base')
    git('checkout', '-q', '-b', 'task')
    write('task\n')
    git('commit', '-q', '-am', 'task')
    const before = git('rev-parse', 'HEAD')
    git('checkout', '-q', 'main')
    write('main\n')
    git('commit', '-q', '-am', 'main')
    const tip = git('rev-parse', 'HEAD')
    git('checkout', '-q', 'task')
    return { dir, git, tryGit, write, before, tip }
  }
  type Repo = ReturnType<typeof setUpRepo>
  const resolveMerge = (repo: Repo, target: string) => {
    repo.tryGit('merge', '--no-commit', '--no-ff', target)
    repo.write('resolved\n')
    repo.git('add', 'a.ts')
    repo.git('commit', '-q', '--no-edit')
    return repo.git('rev-parse', 'HEAD')
  }
  const moveMain = (repo: Repo, file: string, content: string) => {
    repo.git('checkout', '-q', 'main')
    writeFileSync(join(repo.dir, file), content)
    repo.git('add', file)
    repo.git('commit', '-q', '-m', `main ${content.trim()}`)
    const moved = repo.git('rev-parse', 'HEAD')
    repo.git('checkout', '-q', 'task')
    return moved
  }
  const proof = (repo: Repo, head: string, overrides: { remote?: string; freshTip?: string } = {}) =>
    conflictRepairFailure({
      worktreePath: repo.dir,
      head,
      remote: overrides.remote ?? head,
      headBefore: repo.before,
      mainTip: repo.tip,
      freshTip: overrides.freshTip ?? repo.tip
    })

  test('a resolved merge of the fetched tip that merges cleanly with main is proven', () => {
    const repo = setUpRepo()
    expect(proof(repo, resolveMerge(repo, repo.tip))).toBeNull()
  })

  test('an unchanged head, and a merge not on the remote, are not proven', () => {
    const repo = setUpRepo()
    expect(proof(repo, repo.before)?.code).toBe('unchanged-head')
    expect(proof(repo, resolveMerge(repo, repo.tip), { remote: repo.before })?.code).toBe('unpublished')
  })

  test('a single-parent commit is not a merge', () => {
    const repo = setUpRepo()
    repo.write('reworded\n')
    repo.git('commit', '-q', '-am', 'reword')
    expect(proof(repo, repo.git('rev-parse', 'HEAD'))?.code).toBe('single-parent')
  })

  test('a merge whose parents leave out the fetched main tip is not proven', () => {
    const repo = setUpRepo()
    repo.git('checkout', '-q', '-b', 'side', repo.before)
    repo.write('side\n')
    repo.git('commit', '-q', '-am', 'side')
    const side = repo.git('rev-parse', 'HEAD')
    repo.git('checkout', '-q', 'task')
    expect(proof(repo, resolveMerge(repo, side))?.code).toBe('main-tip-missing')
  })

  test('unresolved index entries are not proven, naming the files', () => {
    const repo = setUpRepo()
    const head = resolveMerge(repo, repo.tip)
    const again = moveMain(repo, 'a.ts', 'main again\n')
    repo.tryGit('merge', '--no-commit', '--no-ff', again)
    const failure = proof(repo, head)
    expect(failure?.code).toBe('unresolved-index')
    expect(failure?.files).toEqual(['a.ts'])
  })

  test('a merge that conflicts with main fetched again is not proven, naming the files', () => {
    const repo = setUpRepo()
    const head = resolveMerge(repo, repo.tip)
    const fresh = moveMain(repo, 'a.ts', 'main again\n')
    const failure = proof(repo, head, { freshTip: fresh })
    expect(failure?.code).toBe('not-clean')
    expect(failure?.files).toEqual(['a.ts'])
  })

  test('a merge of a later main commit that contains the fetched tip is proven', () => {
    const repo = setUpRepo()
    const later = moveMain(repo, 'b.ts', 'more\n')
    expect(proof(repo, resolveMerge(repo, later), { freshTip: later })).toBeNull()
  })
})

// The approvals a proven repair started from, on real git: one assertion both sides extend at the same place (each
// adds a `.replace(...)` after `.trim()`), so the merge conflicts. Keeping both lines leaves the pull request's own
// patch unchanged and the approvals carry; changing its own line gets an interdiff review against them.
const ASSERTION = 'assert.test.ts'
const assertion = (...calls: string[]) =>
  ['expect(', '  value', '    .trim()', ...calls.map((call) => `    ${call}`), ')', ''].join('\n')
const OWN_CALL = '.replace(/a/, "b")'
const MAIN_CALL = '.replace(/x/, "y")'
const KEPT_BOTH = assertion(MAIN_CALL, OWN_CALL)
const CHANGED_OWN = assertion(MAIN_CALL, '.replace(/a/, "c")')
const MAIN_ONLY = { 'main-only.ts': 'export const fromMain = true\n' }

/** The default branch holds the assertion, the task branch has it too, then extends it with its own call. */
const branchWithOwnCall = (world: Parameters<NonNullable<Scenario['setUp']>>[0]) => {
  world.moveMainWith({ [ASSERTION]: assertion() })
  world.git('merge', '-q', '--ff-only', world.mainTip())
  return world.commitFiles({ [ASSERTION]: assertion(OWN_CALL) }, true)
}

/** A published, approved pull request whose assertion main extended too: the re-entry's first turn merges main. */
const approvedThenConflicting = (
  resolution: string,
  extra: Scenario = {},
  approvals: { rulingOrdinal?: number } = {}
) => {
  let posted: { reviewer: string; security: string } | null = null
  const merged: string[] = []
  const scenario: Scenario = {
    attachAtRound: 1,
    setUp: (world) => {
      branchWithOwnCall(world)
      posted = world.approvalsOfHead(approvals)
      world.moveMainWith({ [ASSERTION]: assertion(MAIN_CALL), ...MAIN_ONLY })
    },
    postedVerdicts: () => posted,
    developer: (attempt, world) =>
      attempt === 1
        ? { output: confident(90), act: () => void merged.push(world.mergeMainWith({ [ASSERTION]: resolution }, true)) }
        : undefined,
    ...extra
  }
  return { scenario, merged, posted: () => posted }
}

const carries = (observed: Awaited<ReturnType<typeof runV2>>) =>
  records(observed, 'prove-conflict-repair')
    .filter((record) => record.carry !== undefined)
    .map((record) => record.carry.kind as string)

for (const agent of AGENTS) {
  describe(`approvals across a proven conflict repair (${agent})`, () => {
    test('an unchanged own patch carries both approvals: no reviewer, scan or check; ready tests and CI on the merge', async () => {
      const { scenario, merged } = approvedThenConflicting(KEPT_BOTH)
      const observed = await runV2(agent, scenario)
      const head = merged[0] as string
      expect(observed.outcome).toBe('completed')
      expect(carries(observed)).toEqual(['carry'])
      expect(observed.spawns.developer).toBe(1)
      expect(observed.spawns['code-reviewer']).toBe(0)
      expect(observed.spawns['security-reviewer']).toBe(0)
      const nodes = observed.steps.map((step) => step.node)
      for (const skipped of ['run-mechanical-gates', 'run-security-scan', 'dispatch-reviewers', 'run-live-checks'])
        expect(nodes).not.toContain(skipped)
      expect(observed.gateRuns).toBe(0)
      // The ready push and CI ran on the merge itself, and nothing was posted again or relabeled.
      expect(observed.world.readyRuns).toHaveLength(1)
      expect(records(observed, 'ready-push')[0]).toMatchObject({ outcome: 'passed', head })
      expect(observed.world.evidenceWrites).toEqual([{ pr: PR, head }])
      expect(observed.world.ciReads).toBe(1)
      expect(observed.published).toEqual([])
      // The review round did not move: the ready push is recorded in the round the approvals were cast in.
      const ready = observed.rawEvents.filter((event) => event.event === 'ready_push')
      expect(ready.map((event) => [event.round, event.head])).toEqual([[1, head]])
      expect(observed.rawEvents.filter((event) => event.event === 'round_started')).toEqual([])
    })

    test('a changed own patch is reviewed by its interdiff against the approvals, by both reviewers', async () => {
      const staged: Record<string, { diff: string; prior: string }> = {}
      const { scenario, merged } = approvedThenConflicting(CHANGED_OWN, {
        reviewer: (role, _attempt, _world, prompt) => {
          const diff = /staged diff file \(([^)]+)\)/.exec(prompt)?.[1]
          const prior = /staged prior-findings file \(([^)]+)\)/.exec(prompt)?.[1]
          staged[role] = {
            diff: diff ? readFileSync(diff, 'utf8') : '',
            prior: prior ? readFileSync(prior, 'utf8') : ''
          }
          return 'approve'
        }
      })
      const observed = await runV2(agent, scenario)
      expect(observed.outcome).toBe('completed')
      expect(carries(observed)).toEqual(['interdiff'])
      expect(observed.spawns['code-reviewer']).toBe(1)
      expect(observed.spawns['security-reviewer']).toBe(1)
      for (const role of ['code-reviewer', 'security-reviewer']) {
        const { diff, prior } = staged[role] ?? { diff: '', prior: '' }
        expect(diff).toContain('-+    .replace(/a/, "b")')
        expect(diff).toContain('++    .replace(/a/, "c")')
        // Main-only work never appears as a change to review.
        expect(diff).not.toContain('main-only.ts')
        expect(diff).not.toContain(MAIN_CALL)
        expect(prior).toContain('VERDICT: APPROVE')
        expect(prior).toContain('VERDICT: PASS')
      }
      for (const prompt of [...observed.prompts['code-reviewer'], ...observed.prompts['security-reviewer']])
        expect(prompt).toContain('This round reviews a conflict repair')
      expect(observed.world.verdictHeads).toEqual(merged)
    })

    test('a moved review input refuses the carry: the merge gets a whole review', async () => {
      // Approvals cast against an older ruling ordinal than the pull request holds now.
      const { scenario } = approvedThenConflicting(KEPT_BOTH, {}, { rulingOrdinal: 5 })
      const observed = await runV2(agent, scenario)
      expect(carries(observed)).toEqual(['none'])
      expect(records(observed, 'prove-conflict-repair').find((r) => r.carry)?.carry.reason).toContain('rulingOrdinal')
      expect(observed.spawns['code-reviewer']).toBe(1)
      expect(observed.spawns['security-reviewer']).toBe(1)
    })

    test('within one run, a conflict read after CI carries the approvals held for the first opening', async () => {
      const merged: string[] = []
      let judged = ''
      const observed = await runV2(agent, {
        setUp: (world) => {
          world.moveMainWith({ [ASSERTION]: assertion() })
          world.git('merge', '-q', '--ff-only', world.mainTip())
        },
        reviewer: (role, attempt, world) => {
          if (role === 'code-reviewer' && attempt === 1)
            world.moveMainWith({ [ASSERTION]: assertion(MAIN_CALL), ...MAIN_ONLY })
          return 'approve'
        },
        developer: (attempt, world) =>
          attempt === 1
            ? {
                output: confident(90),
                act: () => {
                  judged = world.commitFiles({ [ASSERTION]: assertion(OWN_CALL) }, true)
                  world.staged = { title: 'Feat(sample): Do the thing', body: `Closes #${TASK}` }
                  world.remoteAfterTurn.push(world.remote)
                }
              }
            : attempt === 2
              ? {
                  output: confident(90),
                  act: () => void merged.push(world.mergeMainWith({ [ASSERTION]: KEPT_BOTH }, true))
                }
              : undefined
      })
      expect(observed.outcome).toBe('completed')
      expect(carries(observed)).toEqual(['carry'])
      expect(observed.spawns.developer).toBe(2)
      expect(observed.spawns['code-reviewer']).toBe(1)
      expect(observed.spawns['security-reviewer']).toBe(1)
      // The verdicts were posted once, for the head they judged; the merge got its own ready push, Evidence and CI.
      expect(observed.world.verdictHeads).toEqual([judged])
      expect(observed.world.readyRuns).toHaveLength(2)
      expect(observed.world.evidenceWrites.map((write) => write.head)).toEqual([judged, ...merged])
      expect(observed.world.ciReads).toBe(2)
    })
  })

  describe(`the approval decision survives a checkpoint restart (${agent})`, () => {
    test('a restart after a carrying proof: no reviewer, no verdict post, one ready push on the merge', async () => {
      const { scenario, merged } = approvedThenConflicting(KEPT_BOTH, {
        restartAfter: { step: 'prove-conflict-repair', beforeResume: () => {} }
      })
      const observed = await runV2(agent, scenario)
      expect(observed.driverLegs).toBe(2)
      expect(observed.outcome).toBe('completed')
      expect(observed.spawns.developer).toBe(1)
      expect(observed.spawns['code-reviewer']).toBe(0)
      expect(observed.published).toEqual([])
      expect(observed.world.readyRuns).toHaveLength(1)
      expect(observed.world.evidenceWrites).toEqual(merged.map((head) => ({ pr: PR, head })))
    })

    test('a restart after the carried ready push: no second ready push, no stale-head test, no post', async () => {
      const { scenario, merged } = approvedThenConflicting(KEPT_BOTH, {
        restartAfter: { step: 'ready-push', beforeResume: () => {} }
      })
      const observed = await runV2(agent, scenario)
      expect(observed.driverLegs).toBe(2)
      expect(observed.outcome).toBe('completed')
      expect(observed.world.readyRuns).toHaveLength(1)
      expect(records(observed, 'ready-push').map((record) => record.head)).toEqual(merged)
      expect(observed.published).toEqual([])
    })

    test('a restart after an interdiff decision reviews the interdiff once', async () => {
      const { scenario } = approvedThenConflicting(CHANGED_OWN, {
        restartAfter: { step: 'prove-conflict-repair', beforeResume: () => {} }
      })
      const observed = await runV2(agent, scenario)
      expect(observed.driverLegs).toBe(2)
      expect(observed.outcome).toBe('completed')
      expect(observed.spawns['code-reviewer']).toBe(1)
      expect(observed.spawns['security-reviewer']).toBe(1)
      for (const prompt of observed.prompts['code-reviewer'])
        expect(prompt).toContain('This round reviews a conflict repair')
      expect(observed.published).toHaveLength(1)
    })
  })
}

// Opted in: the ready push keeps its cheap gates and defers the selected tests to required current-head CI; the
// driver runs the approved explicit Test Plan commands on the published head; the run completes only on its own
// head's successful required CI.
const READY_CI = { mode: 'ci' as const, workflow: '.github/workflows/ci.yml', check: 'Vinaya CI' }
const PLAN_BODY = [
  `Closes #${TASK}`,
  '',
  '## Test plan',
  '',
  '```',
  'bun test ./a.test.ts → passes',
  'cd apps/cli && bun test --timeout=30000 tests/a.test.ts → 0 fail',
  'bunx turbo run typecheck --filter=@x/y → exits 0',
  '```',
  ''
].join('\n')
const EXPLICIT = ['cd apps/cli && bun test --timeout=30000 tests/a.test.ts', 'bunx turbo run typecheck --filter=@x/y']
const pendingRead = { state: 'pending' as const, detail: 'run 1 attempt 1 is in_progress' }
const codeRed = {
  state: 'red' as const,
  runId: 1,
  runUrl: 'https://github.com/o/r/actions/runs/1',
  failures: [{ job: 'Test (apps/cli, shard 2)', jobId: 11, url: null, step: 'Test shard 2', kind: 'code' as const }]
}

describe('ready tests deferred to required CI', () => {
  test('the hook defers, the driver runs the explicit commands once on the head, the plan names the required check, and only green CI completes', async () => {
    const observed = await runV2('claude', { readyTests: READY_CI, stagedBody: PLAN_BODY })
    expect(observed.outcome).toBe('completed')
    expect(observed.world.readyDeferrals).toEqual([true])
    expect(observed.world.explicitRuns.map((run) => run.commands)).toEqual([EXPLICIT])
    const [ready] = records(observed, 'ready-push')
    expect(ready?.localTests).toBe('deferred')
    expect(ready?.requiredCi).toMatchObject({ check: 'Vinaya CI', head: ready?.head })
    expect(observed.world.explicitRuns[0]?.head).toBe(ready?.head)
    // The opened body's Test Plan leads with the required-CI line and keeps both explicit commands in order.
    const opened = observed.world.openedBodies[0] ?? ''
    expect(opened).toContain(
      'required-ci "Vinaya CI" .github/workflows/ci.yml → the selected tests pass in the required current-head CI check'
    )
    expect(opened).not.toContain('bun test ./a.test.ts')
    expect(opened.indexOf('required-ci')).toBeLessThan(opened.indexOf(EXPLICIT[0] as string))
    expect(observed.world.requiredCiReads).toEqual([ready?.head])
    const [ci] = records(observed, 'read-ci-once')
    expect(ci?.conclusion).toBe('green')
    expect(ci?.requiredCiIdentity).toMatchObject({ runId: 1, checkRunId: 2, head: ready?.head })
  })

  test('a repository that does not opt in tests locally, unchanged', async () => {
    const observed = await runV2('claude', { readyTests: { mode: 'local' }, stagedBody: PLAN_BODY })
    expect(observed.outcome).toBe('completed')
    expect(observed.world.readyDeferrals).toEqual([false])
    expect(observed.world.readyRuns).toEqual([ALL_TESTS])
    // The hook ran the selected suite; the driver then ran the other Test Plan commands once, on the ready head.
    const [ready] = records(observed, 'ready-push')
    expect(observed.world.explicitRuns).toEqual([{ head: ready?.head as string, commands: EXPLICIT }])
    expect(ready?.explicit).toEqual(EXPLICIT.map((command) => ({ command, outcome: 'passed' })))
    expect(observed.world.requiredCiReads).toEqual([])
    expect(ready?.requiredCi).toBeUndefined()
  })

  test('a failing explicit command on the local path goes back to the Developer with its command and output', async () => {
    const observed = await runV2('claude', {
      readyTests: { mode: 'local' },
      stagedBody: PLAN_BODY,
      explicit: (attempt, commands) =>
        attempt === 1
          ? {
              outcome: 'failed',
              results: [
                { command: commands[0] as string, outcome: 'failed', output: 'expected 1 to be 2', exitCode: 1 }
              ],
              wallMs: 3
            }
          : {
              outcome: 'passed',
              results: commands.map((command) => ({ command, outcome: 'passed', output: 'ok' })),
              wallMs: 1
            }
    })
    expect(observed.outcome).toBe('completed')
    expect(observed.prompts.developer[1]).toContain(`the Test Plan command \`${EXPLICIT[0]}\` failed`)
    expect(observed.prompts.developer[1]).toContain('expected 1 to be 2')
    expect(observed.world.explicitRuns).toHaveLength(2)
    expect(observed.world.prsOpened).toBe(1)
  })

  test('a failed trusted read of the policy pauses before anything runs, never deferring', async () => {
    const observed = await runV2('claude', { readyTests: 'unreadable', stagedBody: PLAN_BODY })
    expect(observed.outcome).toBe('pause:infrastructure')
    expect(observed.world.readyRuns).toEqual([])
    expect(observed.world.explicitRuns).toEqual([])
    expect(records(observed, 'ready-push')[0]?.outcome).toBe('policy-unreadable')
  })

  test('a stale loop baseline sends the Developer back, naming the refresh, before the hook or any command', async () => {
    const observed = await runV2('claude', {
      readyTests: READY_CI,
      stagedBody: PLAN_BODY,
      baseline: (attempt) =>
        attempt === 1
          ? {
              ok: false,
              reason: 'the recorded loop baseline is stale; run `bun apps/cli/scripts/refresh-loop-baseline.ts`'
            }
          : { ok: true }
    })
    expect(observed.outcome).toBe('completed')
    const [refused] = records(observed, 'ready-push')
    expect(refused?.outcome).toBe('baseline-refused')
    expect(refused?.sendBack).toMatchObject({ kind: 'ready-refused' })
    expect(observed.prompts.developer[1]).toContain('refresh-loop-baseline.ts')
    // The refused attempt ran neither the hook nor any command; only the next one did.
    expect(observed.world.readyDeferrals).toEqual([true])
    expect(observed.world.explicitRuns).toHaveLength(1)
  })

  test('a failing explicit command goes back to the Developer with its command and output, then a passing one completes', async () => {
    const observed = await runV2('claude', {
      readyTests: READY_CI,
      stagedBody: PLAN_BODY,
      explicit: (attempt, commands) =>
        attempt === 1
          ? {
              outcome: 'failed',
              results: [
                { command: commands[0] as string, outcome: 'failed', output: 'expected 1 to be 2', exitCode: 1 }
              ],
              wallMs: 3
            }
          : {
              outcome: 'passed',
              results: commands.map((command) => ({ command, outcome: 'passed', output: 'ok' })),
              wallMs: 1
            }
    })
    expect(observed.outcome).toBe('completed')
    expect(observed.prompts.developer[1]).toContain(`the Test Plan command \`${EXPLICIT[0]}\` failed`)
    expect(observed.prompts.developer[1]).toContain('expected 1 to be 2')
    expect(observed.world.explicitRuns).toHaveLength(2)
    expect(observed.world.prsOpened).toBe(1)
  })

  test('an explicit command past its limit pauses, with no Developer turn', async () => {
    const observed = await runV2('claude', {
      readyTests: READY_CI,
      stagedBody: PLAN_BODY,
      explicit: (_attempt, commands) => ({
        outcome: 'timed-out',
        results: [{ command: commands[0] as string, outcome: 'timed-out', output: '' }],
        wallMs: 9
      })
    })
    expect(observed.outcome).toBe('pause:ready_push_failed')
    expect(observed.spawns.developer).toBe(1)
    expect(observed.world.prsOpened).toBe(0)
  })

  test('pending is never green, a code failure in required CI goes back to the Developer, and only a later green completes', async () => {
    const observed = await runV2('claude', {
      readyTests: READY_CI,
      stagedBody: PLAN_BODY,
      requiredCi: [
        pendingRead,
        codeRed,
        pendingRead,
        (head) => ({
          state: 'green',
          identity: {
            head,
            workflow: READY_CI.workflow,
            check: READY_CI.check,
            runId: 9,
            runAttempt: 2,
            checkRunId: 99,
            url: null
          }
        })
      ]
    })
    expect(observed.outcome).toBe('completed')
    expect(observed.spawns.developer).toBe(2)
    expect(observed.prompts.developer[1]).toContain('The required check Vinaya CI is red')
    expect(observed.prompts.developer[1]).toContain('Test (apps/cli, shard 2)')
    const reads = records(observed, 'read-ci-once')
    expect(reads.map((r) => r.conclusion)).toEqual(['red', 'green'])
    expect(reads[1]?.requiredCiIdentity).toMatchObject({ runId: 9, runAttempt: 2 })
  })

  test('a recognized setup failure pauses for the Operator with the job, URL and diagnostic, and no Developer turn', async () => {
    const observed = await runV2('claude', {
      readyTests: READY_CI,
      stagedBody: PLAN_BODY,
      requiredCi: [
        {
          state: 'red',
          runId: 1,
          runUrl: 'https://github.com/o/r/actions/runs/1',
          failures: [
            {
              job: 'Sandbox conformance (Linux)',
              jobId: 12,
              url: 'https://github.com/o/r/actions/runs/1/job/12',
              step: 'Install the Linux sandbox tools',
              kind: 'infrastructure',
              diagnostic: 'the setup step "Install the Linux sandbox tools" failed'
            }
          ]
        }
      ]
    })
    expect(observed.outcome).toBe('pause:infrastructure')
    expect(observed.spawns.developer).toBe(1)
    const [ci] = records(observed, 'read-ci-once')
    expect(ci?.decision?.detail).toContain('Sandbox conformance (Linux)')
    expect(ci?.decision?.detail).toContain('https://github.com/o/r/actions/runs/1/job/12')
    expect(ci?.decision?.detail).toContain('Install the Linux sandbox tools')
    expect(ci?.decision?.detail).toContain('nothing was rerun')
  })

  test('a queue that expired pauses distinctly from a code failure', async () => {
    const observed = await runV2('claude', {
      readyTests: READY_CI,
      stagedBody: PLAN_BODY,
      requiredCi: [
        {
          state: 'stalled',
          bound: 'queue',
          job: 'Test (shared packages)',
          jobId: 3,
          url: null,
          detail: 'the job Test (shared packages) has waited over 10 minutes for a runner'
        }
      ]
    })
    expect(observed.outcome).toBe('pause:infrastructure')
    expect(observed.spawns.developer).toBe(1)
    expect(records(observed, 'read-ci-once')[0]?.stalled).toBe('queue')
  })

  test('another required check failing is still sent back even when the test check passed', async () => {
    const observed = await runV2('claude', { readyTests: READY_CI, stagedBody: PLAN_BODY, ci: ['red', 'green'] })
    expect(observed.outcome).toBe('completed')
    expect(observed.prompts.developer[1]).toContain(`CI is red on pull request #${PR}`)
  })

  test('a restart after the deferred ready push keeps its CI obligation: no second ready push, the strict read completes it', async () => {
    const observed = await runV2('claude', {
      readyTests: READY_CI,
      stagedBody: PLAN_BODY,
      restartAfter: { step: 'ready-push', beforeResume: () => {} }
    })
    expect(observed.driverLegs).toBe(2)
    expect(observed.outcome).toBe('completed')
    expect(observed.world.readyDeferrals).toEqual([true])
    expect(observed.world.requiredCiReads).toHaveLength(1)
  })
})

describe('a carried-approval merge on a deferred run', () => {
  test('the driver obtains the explicit-command receipts on the merge head itself, with no Developer receipt turn, and the suite stays deferred', async () => {
    const { scenario, merged } = approvedThenConflicting(KEPT_BOTH, {
      readyTests: READY_CI,
      // The approved Test Plan the run staged when it first opened the pull request.
      after: {
        'reconcile-external-state': (world) => {
          world.staged = { title: 'Feat(sample): Do the thing', body: PLAN_BODY }
        }
      }
    })
    const observed = await runV2('claude', scenario)
    expect(observed.outcome).toBe('completed')
    expect(carries(observed)).toEqual(['carry'])
    // One Developer turn: the merge itself. No reviewer, and no turn spent writing receipts.
    expect(observed.spawns.developer).toBe(1)
    expect(observed.spawns['code-reviewer']).toBe(0)
    expect(observed.world.readyDeferrals).toEqual([true])
    expect(observed.world.explicitRuns).toEqual([{ head: merged[0] as string, commands: EXPLICIT }])
    expect(observed.world.requiredCiReads).toEqual(merged)
    expect(observed.published).toEqual([])
  })
})
