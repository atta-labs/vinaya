import { fixtureDir } from '../../../apps/cli/tests/lib/test-temp-fixture'
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { initialLoopState, type VerdictObservation } from '@attalabs/aeg-core'
import { createRunControl } from '@atta/executor-agent-spawn'
import {
  escalationPrOf,
  pauseGrantsBareResume,
  readPauseState
} from '../../../apps/cli/src/lib/dev-review-loop/pause-resume'
import {
  DispatchSignInRefused,
  MAX_INFRASTRUCTURE_RETRIES
} from '../../../apps/cli/src/lib/dev-review-loop/round-assess'
import { renderNoPushStopComment, renderPauseComment } from '../../../apps/cli/src/lib/dev-review-loop/pause-resume'
import { createActions, type TaskInput } from '../executing/actions'
import { createHandoff, type Handoff, type HandoffRun } from '../executing/handoff'
import { handoffHaltReason } from '../executing/log-events'
import { heldReviews } from './round-fakes'
import { recordedHandoff } from './handoff-fakes'

const TASK = 9
const BRANCH = 'task/issue-9'

type Action = (context: never) => Promise<{ exitCode: number; stdout?: string }> | { exitCode: number; stdout?: string }

// A worktree whose `origin/main` sits one commit behind HEAD, so the gate observation can read a diff.
function worktree(): string {
  const dir = fixtureDir('handoff-wt-')
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q')
  writeFileSync(join(dir, 'a.txt'), 'a\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  writeFileSync(join(dir, 'b.txt'), 'b\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'change')
  return dir
}

/** One run's handoff over a run folder of its own, the records and posts recorded in order. */
function setup(options: {
  agent: 'claude' | 'codex'
  pr?: number | null
  versions?: () => never
  runtimeDir?: string
}) {
  const runtimeDir = options.runtimeDir ?? fixtureDir('handoff-run-')
  const control = createRunControl()
  const recorded = recordedHandoff()
  // The pause record must already be on disk when the forge is told: a comment is the last thing written.
  const onDisk: boolean[] = []
  const inner = recorded.deps
  const deps = {
    ...inner,
    postPauseComment: (...args: Parameters<typeof inner.postPauseComment>) => {
      onDisk.push(readPauseState(runtimeDir, TASK) !== null)
      return inner.postPauseComment(...args)
    },
    postIssuePauseComment: (...args: Parameters<typeof inner.postIssuePauseComment>) => {
      onDisk.push(readPauseState(runtimeDir, TASK) !== null)
      return inner.postIssuePauseComment(...args)
    }
  }
  let pr: number | null = options.pr === undefined ? 70 : options.pr
  const run: HandoffRun = {
    task: TASK,
    branch: BRANCH,
    runtimeDir,
    runId: 'run-1',
    agent: options.agent,
    round: () => 2,
    head: () => 'abc123',
    prNumber: () => pr,
    versions:
      options.versions ??
      (() => ({ briefHash: 'brief', objectivesVersion: 'objectives', rulingOrdinal: 3, policyDigest: 'policy' })),
    halt: (reason) => control.halt(handoffHaltReason(reason))
  }
  const handoff = createHandoff(run, 'loop-1', deps)
  return {
    handoff,
    control,
    recorded,
    runtimeDir,
    onDisk,
    setPr: (n: number | null) => {
      pr = n
    }
  }
}

/** A fresh run over a run folder an earlier one left behind. */
function again(first: ReturnType<typeof setup>, agent: 'claude' | 'codex') {
  return setup({ agent, runtimeDir: first.runtimeDir })
}

const blocking = {
  id: 'F1',
  severity: 'blocker',
  state: 'open',
  severityScale: 'code-review',
  policyTreatment: 'blocking'
} as const

const verdictsOf = (reviewer: VerdictObservation): VerdictObservation[] => [
  reviewer,
  { role: 'security', verdict: 'PASS', objectives: [], findings: [] }
]

/** The assess-round action over a task whose rounds observe `rounds` in turn, handing off through `handoff`. */
function assessing(handoff: Handoff, rounds: VerdictObservation[][]) {
  let round = 0
  const task = {
    worktreePath: worktree(),
    loopState: initialLoopState({
      loopId: 'loop-1',
      task: TASK,
      reviewers: ['reviewer', 'security'],
      models: {},
      maxRounds: 5,
      maxTaskMinutes: 0
    }),
    handoff,
    reviewRound: () => round + 1
  } as unknown as TaskInput
  const actions = createActions(task)
  const gateAction = actions['vinaya.assess-gate'] as unknown as Action
  const action = actions['vinaya.assess-round'] as unknown as Action
  const develop = {
    kind: 'agent-spawn',
    nodeId: 'develop',
    exitCode: 0,
    events: [{ turnResult: { confidence: 90, confidenceExplanation: 'tested' } }]
  }
  const gate = {
    kind: 'mechanical',
    nodeId: 'run-mechanical-gates',
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 5
  }
  const results: Record<string, unknown> = { develop, 'run-mechanical-gates': gate }
  // Each round: the gate assessed first, then the verdicts the reviewer step held for it.
  return async () => {
    const gated = await gateAction({ results } as never)
    results['assess-gate'] = { kind: 'mechanical', nodeId: 'assess-gate', ...gated }
    results['validate-reviewer-outputs'] = { kind: 'mechanical', ...heldReviews(round + 1, rounds[round]!) }
    const result = await action({ results } as never)
    results['assess-round'] = { kind: 'mechanical', nodeId: 'assess-round', ...result }
    round += 1
    return result
  }
}

for (const agent of ['claude', 'codex'] as const) {
  describe(`a pause on the Engine path (${agent})`, () => {
    test('an escalation writes the escalation record, then the pause record, then one comment, and halts the run', async () => {
      const { handoff, control, recorded, runtimeDir, onDisk } = setup({ agent, pr: null })
      const assess = assessing(handoff, [
        verdictsOf({ role: 'reviewer', verdict: 'ESCALATE', objectives: [], findings: [] })
      ])
      const result = await assess()
      // The action returns the decision; it does not throw to pause.
      expect(result.exitCode).toBe(1)
      expect(JSON.parse(result.stdout ?? '').decision).toMatchObject({ type: 'pause', reason: 'escalation' })
      expect(recorded.calls).toEqual(['escalation:escalation', 'pause-state:escalation', 'comment:issue:escalation'])
      expect(onDisk).toEqual([true])
      expect(control.halted).toBe(true)
      expect(control.haltReason).toBe(handoffHaltReason('escalation'))
      const held = readPauseState(runtimeDir, TASK)
      expect(held).toMatchObject({
        task: TASK,
        round: 2,
        head: 'abc123',
        branch: BRANCH,
        prNumber: null,
        reason: 'escalation',
        agent,
        escalationId: `${TASK}-2-abc123`
      })
    })

    test('a blocking finding open in two rounds pauses as a repeated finding, with the comment on the pull request', async () => {
      const { handoff, control, recorded, runtimeDir } = setup({ agent, pr: 70 })
      const reviewer = (): VerdictObservation => ({
        role: 'reviewer',
        verdict: 'REQUEST CHANGES',
        objectives: [],
        findings: [blocking]
      })
      const assess = assessing(handoff, [verdictsOf(reviewer()), verdictsOf(reviewer())])
      const first = await assess()
      expect(JSON.parse(first.stdout ?? '').decision.type).toBe('dispatch_developer')
      expect(recorded.calls).toEqual([])
      expect(control.halted).toBe(false)
      const second = await assess()
      expect(JSON.parse(second.stdout ?? '').decision).toMatchObject({ type: 'pause', reason: 'repeat_finding' })
      expect(recorded.calls).toEqual([
        'escalation:repeat_finding',
        'pause-state:repeat_finding',
        'comment:pr:repeat_finding'
      ])
      expect(control.halted).toBe(true)
      expect(readPauseState(runtimeDir, TASK)).toMatchObject({ reason: 'repeat_finding', prNumber: 70 })
    })

    test('an infrastructure error pauses the run through the same records, spending one retry', () => {
      const { handoff, control, recorded, runtimeDir } = setup({ agent, pr: 70 })
      const result = handoff.pause({
        reason: 'infrastructure',
        detail: 'an uncaught error ended round 2',
        error: new Error('socket closed')
      })
      expect(recorded.calls).toEqual([
        'escalation:infrastructure',
        'pause-state:infrastructure',
        'comment:pr:infrastructure'
      ])
      expect(control.halted).toBe(true)
      expect(result).toMatchObject({ commentPosted: true, infrastructureRetries: 1, retryBudgetSpent: false })
      expect(readPauseState(runtimeDir, TASK)?.infrastructureRetries).toBe(1)
    })

    test('a forge read that fails once still leaves the escalation record a ruling resolves', () => {
      const runtimeDir = fixtureDir('handoff-run-')
      const recorded = recordedHandoff()
      const reported: string[] = []
      let reads = 0
      const handoff = createHandoff(
        {
          task: TASK,
          branch: BRANCH,
          runtimeDir,
          runId: 'run-1',
          agent,
          round: () => 2,
          head: () => 'abc123',
          prNumber: () => 70,
          versions: () => {
            reads += 1
            if (reads === 1) throw new Error('HTTP 502 from the forge')
            return { briefHash: 'b', objectivesVersion: 'o', rulingOrdinal: 0, policyDigest: 'p' }
          },
          halt: () => {}
        },
        'loop-1',
        { ...recorded.deps, report: (line) => void reported.push(line), sleepSync: () => {} }
      )
      handoff.pause({ reason: 'escalation', detail: 'needs a call' })
      expect(recorded.calls[0]).toBe('escalation:escalation')
      expect(reported).toEqual([
        'the escalation record for this pause could not be written (attempt 1 of 3): HTTP 502 from the forge'
      ])
    })

    test('the pause comment names the Engine resume command, with and without a pull request', () => {
      for (const pr of [70, null]) {
        const runtimeDir = fixtureDir('handoff-run-')
        const recorded = recordedHandoff()
        const bodies: string[] = []
        const deps = {
          ...recorded.deps,
          postPauseComment: (...args: Parameters<typeof recorded.deps.postPauseComment>) => {
            const [, , , prNumber, reason, detail, invocation] = args
            bodies.push(renderPauseComment(prNumber, reason, detail, invocation))
            return recorded.deps.postPauseComment(...args)
          },
          postIssuePauseComment: (...args: Parameters<typeof recorded.deps.postIssuePauseComment>) => {
            const [task, branch, , reason, detail, invocation, ordinal] = args
            bodies.push(renderNoPushStopComment(task, branch, reason, detail, invocation, ordinal))
            return recorded.deps.postIssuePauseComment(...args)
          }
        }
        const control = createRunControl()
        const handoff = createHandoff(
          {
            task: TASK,
            branch: BRANCH,
            runtimeDir,
            runId: 'run-1',
            agent,
            round: () => 2,
            head: () => 'abc123',
            prNumber: () => pr,
            versions: () => ({ briefHash: 'b', objectivesVersion: 'o', rulingOrdinal: 0, policyDigest: 'p' }),
            halt: (reason) => control.halt(handoffHaltReason(reason))
          },
          'loop-1',
          deps
        )
        handoff.pause({ reason: 'escalation', detail: 'needs a call' })
        expect(bodies).toHaveLength(1)
        expect(bodies[0]).toContain(`vinaya task run --issue ${TASK} --agent ${agent} --runner atta-engine`)
        expect(bodies[0]).not.toContain('dev-review-loop --resume')
      }
    })

    test('a pause handed off twice in one run writes its records and its comment once', () => {
      const { handoff, recorded } = setup({ agent })
      handoff.pause({ reason: 'escalation', detail: 'needs a call' })
      const again = handoff.pause({ reason: 'infrastructure', detail: 'a later error', error: new Error('x') })
      expect(again.repeated).toBe(true)
      expect(recorded.calls).toEqual(['escalation:escalation', 'pause-state:escalation', 'comment:pr:escalation'])
    })

    test('an escalation record that cannot be written leaves the pause record and the comment', () => {
      const unreadable = () => {
        throw new Error('the forge is unreachable')
      }
      const { handoff, control, recorded, runtimeDir } = setup({ agent, versions: unreadable })
      const result = handoff.pause({ reason: 'escalation', detail: 'needs a call' })
      expect(recorded.calls).toEqual(['pause-state:escalation', 'comment:pr:escalation'])
      expect(result.escalationId).toBeUndefined()
      expect(control.halted).toBe(true)
      expect(readPauseState(runtimeDir, TASK)?.escalationId).toBeUndefined()
    })

    test('a pause comment that took several attempts, or never landed, is logged as an infrastructure retry', () => {
      const slow = setup({ agent })
      slow.recorded.postResult = { attempts: 3, posted: true }
      slow.handoff.pause({ reason: 'escalation', detail: 'd' })
      expect(slow.recorded.logged).toEqual([
        expect.objectContaining({
          kind: 'dev_review_loop',
          event: 'infrastructure_retry',
          loop_id: 'loop-1',
          round: 2,
          failure_kind: 'pause_comment_post',
          attempts: 3,
          outcome: 'recovered'
        })
      ])
      const lost = setup({ agent })
      lost.recorded.postResult = { attempts: 5, posted: false }
      const result = lost.handoff.pause({ reason: 'escalation', detail: 'd' })
      expect(result.commentPosted).toBe(false)
      expect(lost.recorded.logged).toEqual([expect.objectContaining({ attempts: 5, outcome: 'exhausted' })])
      const quiet = setup({ agent })
      quiet.handoff.pause({ reason: 'escalation', detail: 'd' })
      expect(quiet.recorded.logged).toEqual([])
    })

    test('each infrastructure pause spends the retry budget, and a run that has spent it no longer grants a bare resume', () => {
      let last = setup({ agent })
      for (let spent = 1; spent <= MAX_INFRASTRUCTURE_RETRIES; spent++) {
        const next = spent === 1 ? last : again(last, agent)
        const result = next.handoff.pause({ reason: 'infrastructure', detail: 'd', error: new Error('boom') })
        expect(result.infrastructureRetries).toBe(spent)
        expect(result.retryBudgetSpent).toBe(spent >= MAX_INFRASTRUCTURE_RETRIES)
        const held = readPauseState(next.runtimeDir, TASK)!
        expect(held.infrastructureRetries).toBe(spent)
        expect(pauseGrantsBareResume(held)).toBe(spent < MAX_INFRASTRUCTURE_RETRIES)
        last = next
      }
      // A sixth pause stays at the spent budget and still pauses.
      const sixth = again(last, agent)
      const result = sixth.handoff.pause({ reason: 'infrastructure', detail: 'd', error: new Error('boom') })
      expect(result.retryBudgetSpent).toBe(true)
      expect(sixth.control.halted).toBe(true)
      expect(pauseGrantsBareResume(readPauseState(sixth.runtimeDir, TASK)!)).toBe(false)
    })

    test('a refused sign-in spends no retry', () => {
      const run = setup({ agent })
      const result = run.handoff.pause({
        reason: 'infrastructure',
        detail: 'sign in again',
        error: new DispatchSignInRefused('claude', 'the developer')
      })
      expect(result.infrastructureRetries).toBe(0)
      expect(readPauseState(run.runtimeDir, TASK)?.infrastructureRetries).toBe(0)
    })

    test('a pause raised before any pull request existed is bound to the pull request once one opens', () => {
      const run = setup({ agent, pr: null })
      run.handoff.pause({ reason: 'escalation', detail: 'needs a call' })
      expect(readPauseState(run.runtimeDir, TASK)?.prNumber).toBeNull()
      run.setPr(70)
      const bound = run.handoff.bindToPullRequest(70)
      expect(bound).toMatchObject({ prNumber: 70, reason: 'escalation', escalationId: `${TASK}-2-abc123` })
      expect(bound?.boundAt).toBeDefined()
      const held = readPauseState(run.runtimeDir, TASK)
      expect(held).toEqual(bound)
      // The ruling stays on the task Issue where the comment went, as the escalation record names no pull request.
      expect(escalationPrOf(held!)).toBeNull()
      // Binding is once: a pause that names a pull request is left alone.
      expect(run.handoff.bindToPullRequest(71)).toBeNull()
      expect(readPauseState(run.runtimeDir, TASK)?.prNumber).toBe(70)
    })

    test('no pause is held, or one on another branch, binds nothing', () => {
      const none = setup({ agent, pr: null })
      expect(none.handoff.bindToPullRequest(70)).toBeNull()
      const other = setup({ agent, pr: null })
      other.handoff.pause({ reason: 'escalation', detail: 'needs a call' })
      const stranger = createHandoff(
        {
          task: TASK,
          branch: 'task/issue-10',
          runtimeDir: other.runtimeDir,
          runId: 'r',
          agent,
          round: () => 1,
          head: () => 'h',
          prNumber: () => null,
          versions: () => {
            throw new Error('unused')
          },
          halt: () => {}
        },
        'loop-1',
        other.recorded.deps
      )
      expect(stranger.bindToPullRequest(70)).toBeNull()
      expect(readPauseState(other.runtimeDir, TASK)?.prNumber).toBeNull()
    })
  })
}
