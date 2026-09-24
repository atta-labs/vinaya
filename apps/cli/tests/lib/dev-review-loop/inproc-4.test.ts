/**
 * In-process conversions for the dev-review-loop.test.ts slice covering
 * review-validity/reviewer-prompt/gate-red/connection-retry/control-store
 * scenarios. See dev-review-loop-harness.ts's own doc comment for what the
 * harness does and does not fake.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { DispatchHandle } from '../../../src/lib/dispatch.js'
import type { LoopDeps } from '../../../src/lib/dev-review-loop.js'
import { CONFIDENCE_FILE_NAME } from '../../../src/lib/dev-review-loop.js'
import { MAX_INFRASTRUCTURE_RETRIES } from '../../../src/lib/dev-review-loop/round-assess.js'
import {
  cleanupWorlds,
  controlDir,
  developerDir,
  makeInProcessDeps,
  makeWorld,
  outboxLines,
  roundDir,
  runLoopInProcess,
  type LoopWorld
} from '../dev-review-loop-harness.js'

afterEach(cleanupWorlds)

function controlStoreLoopStatePath(world: LoopWorld): string {
  return join(controlDir(world), 'loop-state.json')
}

function writeControlStoreLoopState(world: LoopWorld, record: Record<string, unknown>): void {
  const path = controlStoreLoopStatePath(world)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(record), 'utf8')
}

/** One check run, cast past `LoopWorld`'s own narrower field shape — the harness's `fetchFailingCheckRuns` fake passes every field of `world.failingCheckRuns` straight through, so a `startedAt` here reaches `describeFailingCheckRun` exactly like a real REST payload's `started_at` would. */
function failingCheckRun(id: number, name: string, startedAt?: string): LoopWorld['failingCheckRuns'][number] {
  return {
    id,
    name,
    conclusion: 'failure',
    ...(startedAt ? { startedAt } : {})
  } as unknown as LoopWorld['failingCheckRuns'][number]
}

describe('devReviewLoop — a report.txt missing SECRETS is an infrastructure pause, never a fabricated clean claim (review-validity-v1 12, #526 round 2)', () => {
  it('retries once into a fresh work directory, then pauses naming report.txt and the reviewer session id — never a silent "none found"', async () => {
    const world = makeWorld({
      roleOutcomes: {
        1: {
          security: {
            findings: '',
            report: 'CONFIG_SCAN: clean\n',
            objectives: 'O1|MET|done.\n',
            sessionId: 'sec-session-no-secrets'
          }
        }
      }
    })
    const result = await runLoopInProcess(world)
    expect(result.finalDecision).toMatchObject({ type: 'pause', reason: 'infrastructure' })
    expect(world.dispatchCountByRole.security).toBe(2)

    expect(world.postedComments).toHaveLength(2)
    const pauseComment = world.postedComments[1]!.body
    expect(pauseComment).toMatch(/^<!-- aeg:loop:paused:infrastructure -->$/m)
    expect(pauseComment).toMatch(/report\.txt/)
    expect(pauseComment).toMatch(/sec-session-no-secrets/)
    expect(pauseComment).not.toMatch(/^VERDICT:/m)
    expect(pauseComment).not.toMatch(/SECRETS: none found/)
  })
})

describe('devReviewLoop — the reviewer prompt names the objectives file, and omitting it is the O1 infrastructure outcome (O3)', () => {
  it('names objectives.txt in the prompt when the task carries objectives, and pauses as infrastructure when security omits it', async () => {
    const world = makeWorld({
      roleOutcomes: {
        1: {
          security: {
            findings: '',
            report: 'CONFIG_SCAN: clean\nSECRETS: none found\n',
            objectives: null,
            sessionId: 'sec-session-1'
          }
        }
      }
    })
    const base = makeInProcessDeps(world)
    let reviewerPrompt = ''
    const dispatchRole: LoopDeps['dispatchRole'] = async (role, agent, prompt, opts) => {
      if (role === 'code-reviewer' && (opts.round ?? 1) === 1) reviewerPrompt = prompt
      return base.dispatchRole!(role, agent, prompt, opts)
    }

    const result = await runLoopInProcess(world, { task: world.task, agent: 'claude' }, { dispatchRole })
    expect(result.finalDecision).toMatchObject({ type: 'pause', reason: 'infrastructure' })

    expect(reviewerPrompt).toMatch(/objectives\.txt/)
    expect(reviewerPrompt).toMatch(/O<n>\|MET\|<evidence>/)
    // O6: the prompt states the bare-word status rule and that `|` never
    // appears in a description.
    expect(reviewerPrompt).toMatch(/bare leading word/)
    expect(reviewerPrompt).toMatch(/`\|` never appears in a description/)
    expect(reviewerPrompt).toMatch(/NOT MET means you verified the objective is not met — never a decline/)
    expect(reviewerPrompt).toMatch(/never NOT MET with an out-of-scope note/)

    expect(world.dispatchCountByRole.security).toBe(2)

    const pauseComment = world.postedComments[1]!.body
    expect(pauseComment).toMatch(/^<!-- aeg:loop:paused:infrastructure -->$/m)
    expect(pauseComment).toMatch(/security/)
    expect(pauseComment).toMatch(/objectives\.txt/)

    // The code-reviewer half finishes clean well before security's own
    // retry exhausts — its held verdict must not survive on disk either.
    expect(existsSync(join(roundDir(world, 1), 'reviewer.md'))).toBe(false)
    expect(existsSync(join(roundDir(world, 1), 'security.md'))).toBe(false)
  })
})

describe('devReviewLoop — a red gate the developer never fixes pauses, bounded (O2/O3)', () => {
  it('waits for the head to change, never re-reads a tight loop, and pauses naming the head and the failing check after the bound', async () => {
    const world = makeWorld({ gate: 'red', failingCheckRuns: [failingCheckRun(1, 'Vinaya CI')] })
    const base = makeInProcessDeps(world)
    const devPrompts: string[] = []
    const dispatchRole: LoopDeps['dispatchRole'] = async (role, agent, prompt, opts) => {
      if (role === 'developer') devPrompts.push(prompt)
      return base.dispatchRole!(role, agent, prompt, opts)
    }

    const result = await runLoopInProcess(world, { task: world.task, agent: 'claude' }, { dispatchRole })
    expect(result.finalDecision).toMatchObject({ type: 'pause', reason: 'infrastructure' })

    // O3: the developer was told which check-run actually failed, never a
    // bare "CI is red" and never the review gate's own name.
    const pauseComment = world.postedComments[0]!.body
    expect(pauseComment).toMatch(/^<!-- aeg:loop:paused:infrastructure -->$/m)
    expect(pauseComment).toMatch(/Vinaya CI/)
    expect(pauseComment).not.toMatch(/review gate/i)
    expect(pauseComment).toMatch(/Vinaya CI \(run 1\)/)

    // O2: `stop_condition_met` fires exactly once, never once per stalled turn.
    const loopEvents = outboxLines(world)
      .filter((l) => l.kind === 'dev_review_loop')
      .map((l) => l.event)
    expect(loopEvents.filter((e) => e === 'stop_condition_met')).toHaveLength(1)
    expect(loopEvents.filter((e) => e === 'paused')).toHaveLength(1)
    const stop = outboxLines(world).find((l) => l.event === 'stop_condition_met') as Record<string, unknown>
    expect(stop.condition).toBe('principal_stop')

    const pauseState = JSON.parse(readFileSync(join(controlDir(world), 'pause-state.json'), 'utf8')) as Record<
      string,
      unknown
    >
    expect(pauseState.reason).toBe('infrastructure')
    expect(pauseState.detail).toMatch(/head .* unchanged/)
    expect(pauseState.detail).toMatch(/Vinaya CI \(run 1\)/)

    // Round 1's own fresh entry, then every gate-red retry the bound
    // (MAX_GATE_STALLED_TURNS) allows before pausing — three developer
    // turns total, never a fourth.
    expect(devPrompts).toHaveLength(3)
    const gateRedPrompt = devPrompts[devPrompts.length - 1]!
    expect(gateRedPrompt).toMatch(new RegExp(`^Resuming task Issue #${world.task}\\.$`, 'm'))
    expect(gateRedPrompt).toMatch(new RegExp(`^Branch: \`${world.branch}\`$`, 'm'))
    expect(gateRedPrompt).toMatch(/^Worktree: `.*\.worktrees\//m)
    expect(gateRedPrompt).toMatch(/^Remote head: [0-9a-f]{40}$/m)
    expect(gateRedPrompt).toMatch(/CI is red on the last head/)
    expect(gateRedPrompt).toMatch(/`git push`/)
  })
})

describe("devReviewLoop — O2 (`[task-operator-v1]`/Issue #662): a developer dispatch classified 'connection-failed' is waited-and-re-dispatched, never an immediate decided stop", () => {
  it('recovers on the second attempt: the SAME session resumes, the round completes and publishes, and one recovered infrastructure_retry event is logged', async () => {
    const world = makeWorld()
    const base = makeInProcessDeps(world)
    let devAttempts = 0
    const dispatchRole: LoopDeps['dispatchRole'] = async (role, agent, prompt, opts) => {
      if (role === 'developer') {
        devAttempts += 1
        if (devAttempts === 1) {
          return {
            exitCode: null,
            durationMs: 1,
            usage: null,
            resumeId: null,
            timedOut: false,
            failureReason: 'connection-failed',
            effectId: 'eff-dev-connfail-1'
          } as DispatchHandle
        }
      }
      return base.dispatchRole!(role, agent, prompt, opts)
    }

    const result = await runLoopInProcess(world, { task: world.task, agent: 'claude' }, { dispatchRole })
    expect(result.finalDecision.type).toBe('publish')
    // One initial connection-failed attempt, then the SAME session recovers.
    expect(devAttempts).toBe(2)
    expect(world.dispatchCountByRole.developer).toBe(1)

    const retryEvent = outboxLines(world).find((l) => l.event === 'infrastructure_retry') as
      | Record<string, unknown>
      | undefined
    expect(retryEvent).toBeDefined()
    expect(retryEvent?.failure_kind).toBe('developer_connection')
    expect(retryEvent?.attempts).toBe(2)
    expect(retryEvent?.outcome).toBe('recovered')
    // Never a decided stop the developer itself never made.
    for (const c of world.postedComments) expect(c.body).not.toMatch(/aeg:loop:paused/)
  })

  it('exhausts the shared infrastructure-retry bound, then pauses infrastructure — never a crash, never blamed on the developer', async () => {
    const world = makeWorld()
    const base = makeInProcessDeps(world)
    let devAttempts = 0
    const dispatchRole: LoopDeps['dispatchRole'] = async (role, agent, prompt, opts) => {
      if (role === 'developer') {
        devAttempts += 1
        return {
          exitCode: null,
          durationMs: 1,
          usage: null,
          resumeId: null,
          timedOut: false,
          failureReason: 'connection-failed',
          effectId: `eff-dev-connfail-${devAttempts}`
        } as DispatchHandle
      }
      return base.dispatchRole!(role, agent, prompt, opts)
    }

    const result = await runLoopInProcess(world, { task: world.task, agent: 'claude' }, { dispatchRole })
    expect(result.finalDecision).toMatchObject({ type: 'pause', reason: 'infrastructure' })

    // One initial attempt plus every retry the shared bound allows.
    expect(devAttempts).toBe(MAX_INFRASTRUCTURE_RETRIES + 1)

    const retryEvent = outboxLines(world).find((l) => l.event === 'infrastructure_retry') as
      | Record<string, unknown>
      | undefined
    expect(retryEvent).toBeDefined()
    expect(retryEvent?.failure_kind).toBe('developer_connection')
    expect(retryEvent?.attempts).toBe(MAX_INFRASTRUCTURE_RETRIES + 1)
    expect(retryEvent?.outcome).toBe('exhausted')

    expect(world.postedComments.some((c) => /^<!-- aeg:loop:paused:infrastructure -->$/m.test(c.body))).toBe(true)
  })
})

describe('devReviewLoop — control-store-v1 task 4 (#554, O2): mechanical-retry budgets survive a restart, never reset', () => {
  it('a fresh process seeded with a prior stall count from the control store pauses after one fewer turn than a genuinely fresh one would', async () => {
    const world = makeWorld({ gate: 'red', failingCheckRuns: [failingCheckRun(1, 'Vinaya CI')] })
    writeControlStoreLoopState(world, {
      version: 1,
      kind: 'loop_state',
      task: world.task,
      round: 1,
      phase: 'dispatch_developer',
      pauseReason: null,
      budgets: { mechanicalRetries: 1, reviewRounds: 1, infrastructureRetries: 0 },
      heldResult: null,
      deliveredFindings: null,
      recordedAt: new Date().toISOString()
    })
    const base = makeInProcessDeps(world)
    const devPrompts: string[] = []
    const dispatchRole: LoopDeps['dispatchRole'] = async (role, agent, prompt, opts) => {
      if (role === 'developer') devPrompts.push(prompt)
      return base.dispatchRole!(role, agent, prompt, opts)
    }

    const result = await runLoopInProcess(world, { task: world.task, agent: 'claude' }, { dispatchRole })
    expect(result.finalDecision).toMatchObject({ type: 'pause', reason: 'infrastructure' })

    // A genuinely fresh process needs THREE developer turns before this
    // bound (round 1's own entry, then two stalled retries). Seeded at 1
    // already, this run needed only ONE retry after its own entry turn.
    expect(devPrompts).toHaveLength(2)

    const persisted = JSON.parse(readFileSync(controlStoreLoopStatePath(world), 'utf8')) as {
      phase: string
      pauseReason: string
      budgets: { mechanicalRetries: number; infrastructureRetries: number }
    }
    expect(persisted.budgets.mechanicalRetries).toBe(2)
    expect(persisted.budgets.infrastructureRetries).toBe(1)
    expect(persisted.phase).toBe('pause')
    expect(persisted.pauseReason).toBe('infrastructure')
  })
})

describe('devReviewLoop — control-store-v1 task 4 (#554, O3): a delivered-findings identity in the control store prevents a second redelivery, even with no local marker file', () => {
  it('reads as no_progress and dispatches nobody, purely from the control-store record — the local round-<k>-attach-redelivered marker never exists in this fixture', async () => {
    // An "attach" world: the PR and branch already exist from a prior run;
    // this run's own developer is never dispatched.
    const world = makeWorld({ developerPushed: true })

    mkdirSync(roundDir(world, 1), { recursive: true })
    writeFileSync(
      join(roundDir(world, 1), 'reviewer.md'),
      `VERDICT: REQUEST CHANGES\n\nJudged head: ${world.head}\n\nStill there.\n`
    )
    writeFileSync(
      join(roundDir(world, 1), 'security.md'),
      `VERDICT: FAIL\n\nJudged head: ${world.head}\n\nStill there.\n`
    )

    // No `round-1-attach-redelivered` marker on disk — the control store
    // alone carries the fact that round 1's findings were already
    // delivered on this exact head.
    writeControlStoreLoopState(world, {
      version: 1,
      kind: 'loop_state',
      task: world.task,
      round: 1,
      phase: 'dispatch_developer',
      pauseReason: null,
      budgets: { mechanicalRetries: 0, reviewRounds: 1, infrastructureRetries: 0 },
      heldResult: null,
      deliveredFindings: { round: 1, head: world.head },
      recordedAt: new Date().toISOString()
    })

    const result = await runLoopInProcess(world)
    expect(result.finalDecision).toMatchObject({ type: 'pause', reason: 'no_progress' })

    expect(world.dispatchCountByRole.developer).toBeUndefined()
    expect(existsSync(join(roundDir(world, 2), 'reviewer-work'))).toBe(false)
    expect(existsSync(join(roundDir(world, 2), 'security-work'))).toBe(false)
    expect(existsSync(join(roundDir(world, 1), 'attach-redelivered'))).toBe(false)

    // The control store is what actually held, and the local marker never
    // existed — the comment names it the other way around from the
    // sibling (local-marker-only) case.
    const pauseComment = world.postedComments[world.postedComments.length - 1]!.body
    expect(pauseComment).toContain('local marker file absent')
    expect(pauseComment).toContain('control-store delivered-findings identity matched')
  })
})

describe('devReviewLoop — control-store-v1 task 4 (#554, O1/O3): round numbering recovers from the control store alone when both the local held files AND the forge-flushed journal are missing', () => {
  it('dispatches round 2 directly with neither a held-verdict file nor any outbox/forge event history to reconstruct it from', async () => {
    const world = makeWorld({ developerPushed: true })

    // Deliberately nothing else: no round-1-reviewer.md/round-1-security.md
    // and no outbox/forge event history — only the control store's own
    // round-2 record survives.
    writeControlStoreLoopState(world, {
      version: 1,
      kind: 'loop_state',
      task: world.task,
      round: 2,
      phase: 'dispatch_reviewers',
      pauseReason: null,
      budgets: { mechanicalRetries: 0, reviewRounds: 2, infrastructureRetries: 0 },
      heldResult: null,
      deliveredFindings: { round: 1, head: world.head },
      recordedAt: new Date().toISOString()
    })

    mkdirSync(join(world.repoRoot, '.worktrees', world.branch), { recursive: true })
    mkdirSync(developerDir(world, 2), { recursive: true })
    writeFileSync(join(developerDir(world, 2), CONFIDENCE_FILE_NAME), 'CONFIDENCE: 90 — recovered from control state\n')

    const result = await runLoopInProcess(world)
    expect(result.finalDecision.type).toBe('publish')

    // Reviewers ran at round 2 — never a reset to round 1 for want of the
    // held files or the journal this task's optional telemetry would
    // otherwise have supplied.
    expect(existsSync(join(roundDir(world, 2), 'reviewer-work'))).toBe(true)
    expect(existsSync(join(roundDir(world, 2), 'security-work'))).toBe(true)
    expect(existsSync(join(roundDir(world, 1), 'reviewer-work'))).toBe(false)
    expect(world.dispatchCountByRole.developer).toBeUndefined()
  })
})

describe('devReviewLoop — control-store-v1 task 4 (#554, round 2 review, BLOCKER): a corrupt loop-state record decides a pause, never an uncaught crash', () => {
  it('exits non-zero with a decided infrastructure pause, dispatching no developer at all', async () => {
    const world = makeWorld()

    // Torn JSON — read as 'corrupt', never 'absent'. Before the fix, the
    // resulting throw sat BEFORE the try block even started, so it escaped
    // as an unhandled rejection instead of a decided pause.
    const loopStatePath = controlStoreLoopStatePath(world)
    mkdirSync(dirname(loopStatePath), { recursive: true })
    writeFileSync(loopStatePath, '{"version":1,"kind":"loop_state"', 'utf8')

    // A decided pause, not a crash: `runLoopInProcess` resolves, it never
    // rejects — the in-process equivalent of "never prints an unhandled
    // stack trace".
    const result = await runLoopInProcess(world)
    expect(result.finalDecision).toMatchObject({ type: 'pause', reason: 'infrastructure' })

    // No developer ever dispatched — the corrupt record is refused before
    // any real work starts, and before the frozen brief is ever fetched.
    expect(world.dispatchCountByRole.developer).toBeUndefined()

    // A real pause comment landed on the task Issue (no PR exists yet).
    const pauseFiles = world.postedComments.filter((c) => c.body.includes('aeg:loop:paused:infrastructure'))
    expect(pauseFiles).toHaveLength(1)
    expect(pauseFiles[0]!.kind).toBe('issue')
    expect(pauseFiles[0]!.body).toMatch(/control-store loop-state record is corrupt/)
  })
})

describe('devReviewLoop — control-store-v1 task 4 (round 3 review, BLOCKER): a real filesystem read fault on loop-state.json decides a pause too, never an uncaught crash', () => {
  it('exits non-zero with a decided infrastructure pause, dispatching no developer at all', async () => {
    const world = makeWorld()

    // The loop-state record's own path is itself a directory, not a file —
    // a real fs fault (EISDIR) distinct from torn JSON above and from
    // ENOENT (never written).
    const loopStatePath = controlStoreLoopStatePath(world)
    mkdirSync(loopStatePath, { recursive: true })

    const result = await runLoopInProcess(world)
    expect(result.finalDecision).toMatchObject({ type: 'pause', reason: 'infrastructure' })
    expect(world.dispatchCountByRole.developer).toBeUndefined()

    const pauseFiles = world.postedComments.filter((c) => c.body.includes('aeg:loop:paused:infrastructure'))
    expect(pauseFiles).toHaveLength(1)
    expect(pauseFiles[0]!.body).toMatch(/control-store loop-state record is corrupt/)
  })
})

describe('devReviewLoop — control-store-v1 task 4 (round 2 review, security HIGH): refusing a corrupt loop-state record never self-heals its infrastructure-retry count to zero', () => {
  it('persists MAX_INFRASTRUCTURE_RETRIES, not 0, to both the control store and the pause-state file', async () => {
    const world = makeWorld()

    const loopStatePath = controlStoreLoopStatePath(world)
    mkdirSync(dirname(loopStatePath), { recursive: true })
    writeFileSync(loopStatePath, '{"version":1,"kind":"loop_state"', 'utf8')

    const result = await runLoopInProcess(world)
    expect(result.finalDecision).toMatchObject({ type: 'pause', reason: 'infrastructure' })

    // Before the fix, refusing an untrustworthy record immediately
    // overwrote it with a zeroed budget. The outer catch's own
    // `infrastructureRetries += 1` lands on top of the
    // MAX_INFRASTRUCTURE_RETRIES seed, so the persisted value is AT LEAST
    // the bound, never exactly 0.
    const persisted = JSON.parse(readFileSync(loopStatePath, 'utf8')) as {
      budgets: { infrastructureRetries: number }
    }
    expect(persisted.budgets.infrastructureRetries).toBeGreaterThanOrEqual(MAX_INFRASTRUCTURE_RETRIES)

    const pauseState = JSON.parse(readFileSync(join(controlDir(world), 'pause-state.json'), 'utf8')) as {
      infrastructureRetries: number
    }
    expect(pauseState.infrastructureRetries).toBeGreaterThanOrEqual(MAX_INFRASTRUCTURE_RETRIES)
  })
})
