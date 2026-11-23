import {
  initialLoopState,
  type DevReviewLoopEventInput,
  type LoopState
} from '../../../../tools/dev-review-policy/types'
import {
  reconstructRounds,
  type ReconstructedJournal
} from '../../../../tools/dev-review-policy/journal-reconstruction'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import * as lifecycle from '../../../../loops/dev-review/standalone/dev-review-loop/driver-lifecycle'
import {
  createDriverExitRecorder,
  keepDriverLock,
  seedLoopHistory,
  taskRunId,
  writeRunLifecycleEvent,
  type DriverExitReason
} from '../../../../loops/dev-review/standalone/dev-review-loop/driver-lifecycle'
import type { RunRecorder } from '../../../../../../kernel/log/run-recorder'
import { attributeOf, createRunLifecycleWorld, eventNameOf, type RunLifecycleWorld } from '../../../run-lifecycle-world'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const loopLog = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'driver-lifecycle-'))
  scratch.push(dir)
  return join(dir, 'driver.log')
}

describe('the run lifecycle through the run handle', () => {
  const loop = (fields: Record<string, unknown>): DevReviewLoopEventInput =>
    ({ kind: 'dev_review_loop', payload: {}, loop_id: 'l1', ...fields }) as unknown as DevReviewLoopEventInput
  const started = loop({
    event: 'loop_started',
    task: 7,
    title: 'A task',
    policy: {
      max_rounds: 5,
      reviewers: ['code-reviewer', 'security'],
      models: { developer: 'opus', security: 'sonnet' }
    }
  })
  const write = (
    world: RunLifecycleWorld,
    recorder: RunRecorder,
    event: DevReviewLoopEventInput,
    round?: number
  ): void => {
    expect(
      writeRunLifecycleEvent(
        event,
        { runId: 'run-1', repository: 'atta-labs/vinaya' },
        { recorder, runtimeDir: () => world.runtimeDir, ...(round === undefined ? {} : { round }) }
      )
    ).toBe(true)
  }

  it('has no driver heartbeat timer or event of its own', () => {
    const exported = Object.keys(lifecycle)
    expect(exported.filter((name) => /heartbeat/i.test(name))).toEqual([])
  })

  it('writes a run start with the process, the round limit, the seats and their models, and one run span at the end', async () => {
    const world = createRunLifecycleWorld()
    const recorder = world.process()
    write(world, recorder, started)
    write(
      world,
      recorder,
      loop({
        event: 'journal_finalized',
        rounds: 2,
        total_wall_ms: 1000,
        time_to_green_ms: 500,
        files_changed_total: 4,
        final_head: 'abc',
        result: 'merged_ready'
      })
    )
    await recorder.drain()
    const runs = world.spans().filter((s) => s.name.startsWith('invoke_workflow'))
    expect(runs).toHaveLength(1)
    expect(runs[0]?.name).toBe('invoke_workflow vinaya-strict')
    expect(attributeOf(runs[0], 'vinaya.run.round_limit')).toBe(5)
    expect(attributeOf(runs[0], 'vinaya.run.rounds')).toBe(2)
    expect(attributeOf(runs[0], 'vinaya.run.outcome')).toBe('ready')
    expect(world.events().filter((e) => eventNameOf(e) === 'vinaya.run.started')).toHaveLength(1)
    expect(world.errors).toEqual([])
  })

  it('writes the alive event after two minutes of silence, and the exit with its kind and code', async () => {
    const world = createRunLifecycleWorld()
    const recorder = world.process()
    write(world, recorder, started, 3)
    world.advance(119_000)
    expect(world.events().filter((e) => eventNameOf(e) === 'vinaya.run.alive')).toHaveLength(0)
    world.advance(2_000)
    await recorder.drain()
    const alive = world.events().filter((e) => eventNameOf(e) === 'vinaya.run.alive')
    expect(alive).toHaveLength(1)
    // The standalone runner supplies the round it is in, and records no stage change, so its alive carries the round
    // and no phase.
    expect(attributeOf(alive[0], 'vinaya.round.number')).toBe(3)
    expect(attributeOf(alive[0], 'vinaya.phase.name')).toBeUndefined()
    write(
      world,
      recorder,
      loop({ event: 'driver_exited', task: 7, reason: 'reexec', last_decision: 'x', exit_code: 3 })
    )
    await recorder.drain()
    const exited = world.events().filter((e) => eventNameOf(e) === 'vinaya.run.exited')
    expect(exited).toHaveLength(1)
    expect(attributeOf(exited[0], 'vinaya.exit.kind')).toBe('restarted')
    expect(attributeOf(exited[0], 'vinaya.exit.code')).toBe(3)
  })

  it('carries a run on in a later process: one start, one pause span ended by the resume, one run span', async () => {
    const world = createRunLifecycleWorld()
    const first = world.process()
    write(world, first, started)
    write(world, first, loop({ event: 'paused', round: 2, reason: 'principal_item', reason_code: 'confidence' }))
    write(
      world,
      first,
      loop({
        event: 'journal_finalized',
        rounds: 2,
        total_wall_ms: 10,
        time_to_green_ms: null,
        files_changed_total: 1,
        final_head: 'abc',
        result: 'stopped'
      })
    )
    await first.drain()
    expect(world.spans().filter((s) => s.name.startsWith('invoke_workflow'))).toHaveLength(0)
    const second = world.process()
    write(world, second, loop({ event: 'resumed', round: 2, by: 'principal' }))
    write(world, second, started)
    write(world, second, loop({ event: 'stop_condition_met', round: 3, condition: 'max_rounds' }))
    write(
      world,
      second,
      loop({
        event: 'journal_finalized',
        rounds: 3,
        total_wall_ms: 20,
        time_to_green_ms: null,
        files_changed_total: 2,
        final_head: 'def',
        result: 'stopped'
      })
    )
    await second.drain()
    expect(world.events().filter((e) => eventNameOf(e) === 'vinaya.run.started')).toHaveLength(1)
    expect(world.spans().filter((s) => s.name.startsWith('invoke_workflow'))).toHaveLength(1)
    const pauses = world.spans().filter((s) => s.name === 'vinaya.pause')
    expect(pauses).toHaveLength(1)
    expect(attributeOf(pauses[0], 'vinaya.pause.by')).toBe('person')
    expect(attributeOf(pauses[0], 'vinaya.pause.why')).toBe('confidence')
    const rules = world.events().filter((e) => eventNameOf(e) === 'vinaya.run.stop_rule_met')
    expect(rules.map((e) => attributeOf(e, 'vinaya.rule'))).toEqual(['round_limit'])
    expect(world.errors).toEqual([])
  })

  it('leaves an event that is not a run lifecycle event to the earlier-format writer', () => {
    const world = createRunLifecycleWorld()
    const recorder = world.process()
    const other = { kind: 'gate', payload: {}, event: 'summary' } as never
    expect(writeRunLifecycleEvent(other, { runId: 'run-1' }, { recorder, runtimeDir: () => world.runtimeDir })).toBe(
      false
    )
  })

  it('names one run for a task in every process until the run ends', () => {
    const world = createRunLifecycleWorld()
    const first = taskRunId(world.runtimeDir, 7, () => 'run-a')
    expect(taskRunId(world.runtimeDir, 7, () => 'run-b')).toBe(first)
    expect(taskRunId(world.runtimeDir, 8, () => 'run-c')).toBe('run-c')
  })
})

describe('rounds, review and the change through the run handle', () => {
  const loop = (fields: Record<string, unknown>): DevReviewLoopEventInput =>
    ({ kind: 'dev_review_loop', payload: {}, loop_id: 'l1', ...fields }) as unknown as DevReviewLoopEventInput
  const where = { runId: 'run-1', repository: 'atta-labs/vinaya' }
  const write = (world: RunLifecycleWorld, recorder: RunRecorder, event: DevReviewLoopEventInput): void => {
    expect(writeRunLifecycleEvent(event, where, { recorder, runtimeDir: () => world.runtimeDir })).toBe(true)
  }
  const started = loop({ event: 'loop_started', task: 7, title: 'A task', policy: { max_rounds: 5, reviewers: [] } })
  const roundEnded = (round: number, outcome: string) =>
    loop({
      event: 'round_ended',
      round,
      base_head: 'aaa',
      head: 'bbb',
      files_changed: 2,
      insertions: 10,
      deletions: 3,
      wall_ms: 5,
      outcome
    })

  it('writes two rounds as two spans, each round once, with its review, gate read and confidence', async () => {
    const world = createRunLifecycleWorld()
    const recorder = world.process()
    write(world, recorder, started)
    write(world, recorder, loop({ event: 'round_started', round: 1, base_head: 'aaa' }))
    write(
      world,
      recorder,
      loop({
        event: 'gate_result_read',
        round: 1,
        head: 'bbb',
        green: true,
        confidence_value: 80,
        confidence_reason: 'tests pass',
        extra_turn_spent: true
      })
    )
    write(
      world,
      recorder,
      loop({
        event: 'verdicts_read',
        round: 1,
        head: 'bbb',
        all_approve: false,
        blockers: 1,
        findings: [{ id: 'F1', severity: 'MAJOR', location: 'a.ts:1', policy_treatment: 'blocking' }],
        reviewers: [
          { role: 'code-reviewer', outcome: 'changes_requested', blockers: 1 },
          { role: 'security', outcome: 'approve', blockers: 0 }
        ]
      })
    )
    write(
      world,
      recorder,
      loop({ event: 'findings_compared', round: 1, open: ['F1'], resolved: [], new: ['F1'], recurring: [] })
    )
    write(world, recorder, loop({ event: 'phase_time', round: 1, phase: 'review', step: 'assess-round', wall_ms: 40 }))
    write(world, recorder, roundEnded(1, 'changes_requested'))
    write(world, recorder, loop({ event: 'round_started', round: 2, base_head: 'bbb' }))
    write(
      world,
      recorder,
      loop({
        event: 'gate_result_read',
        round: 2,
        head: 'ccc',
        green: true,
        confidence_unavailable: true,
        extra_turn_spent: false
      })
    )
    write(world, recorder, roundEnded(2, 'green'))
    await recorder.drain()

    expect(world.errors).toEqual([])
    const rounds = world.spans().filter((s) => s.name.startsWith('vinaya.round'))
    expect(rounds.map((s) => s.name).sort()).toEqual(['vinaya.round 1', 'vinaya.round 2'])
    expect(
      attributeOf(
        rounds.find((s) => s.name === 'vinaya.round 1'),
        'vinaya.round.outcome'
      )
    ).toBe('changes_requested')
    expect(
      attributeOf(
        rounds.find((s) => s.name === 'vinaya.round 1'),
        'vinaya.round.start_commit'
      )
    ).toBe('aaa')
    expect(world.spans().filter((s) => s.name === 'vinaya.phase review')).toHaveLength(1)
    const names = world.events().map(eventNameOf)
    expect(names.filter((n) => n === 'vinaya.round.started')).toHaveLength(2)
    expect(names.filter((n) => n === 'vinaya.review.verdicts')).toHaveLength(1)
    expect(names.filter((n) => n === 'vinaya.review.findings_compared')).toHaveLength(1)
    expect(names.filter((n) => n === 'vinaya.checks.read')).toHaveLength(2)
    const confidence = world.events().filter((e) => eventNameOf(e) === 'vinaya.agent.confidence_stated')
    expect(confidence).toHaveLength(2)
    const stated = confidence.find((e) => attributeOf(e, 'vinaya.confidence') === 80)
    expect(stated).toBeDefined()
    expect(attributeOf(stated, 'vinaya.confidence.after_extra_turn')).toBe(true)
    // The other round stated none: not given, never a made-up number.
    expect(confidence.filter((e) => attributeOf(e, 'vinaya.confidence') === undefined)).toHaveLength(1)
    const verdicts = world.events().find((e) => eventNameOf(e) === 'vinaya.review.verdicts')
    expect(attributeOf(verdicts, 'vinaya.review.blocking_count')).toBe(1)
  })

  it('writes the change, and a merge linked to the run, by the run’s own watch', async () => {
    const world = createRunLifecycleWorld()
    const recorder = world.process()
    write(world, recorder, started)
    write(world, recorder, loop({ event: 'storage_push', round: 1, branch: 'task/x/7', head: 'bbb' }))
    write(world, recorder, loop({ event: 'unpushed_work_resume', round: 1, branch: 'task/x/7', detail: 'd' }))
    write(
      world,
      recorder,
      loop({
        event: 'ready_push',
        round: 2,
        head: 'ccc',
        outcome: 'passed',
        selected: 4,
        failed: 0,
        rerun: false,
        wall_ms: 9
      })
    )
    write(world, recorder, loop({ event: 'pr_opened', round: 2, pr: 318, head: 'ccc' }))
    write(world, recorder, loop({ event: 'conflict_reentry', task: 7, pr: 318, attempt: 1, bound: 3 }))
    const readEnd = () => ({ when: Date.parse('2026-11-22T02:00:00Z'), by: 'octocat' })
    const ended = { state: 'merged' as const, task: 7, pr: 318 }
    lifecycle.recordWatchedChangeEnded(ended, { ...where, recorder, readEnd })
    // The same end read twice is written once.
    lifecycle.recordWatchedChangeEnded(ended, { ...where, recorder, readEnd })
    await recorder.drain()

    expect(world.errors).toEqual([])
    const names = world.events().map(eventNameOf)
    for (const name of [
      'vinaya.change.saved',
      'vinaya.change.recovered',
      'vinaya.change.pushed',
      'vinaya.change.opened',
      'vinaya.change.conflicted'
    ])
      expect(names.filter((n) => n === name)).toHaveLength(1)
    const merged = world.events().filter((e) => eventNameOf(e) === 'vinaya.change.merged')
    expect(merged).toHaveLength(1)
    expect(attributeOf(merged[0], 'vinaya.run.id')).toBe('run-1')
    expect(attributeOf(merged[0], 'vinaya.actor')).toBe('octocat')
    const opened = world.events().find((e) => eventNameOf(e) === 'vinaya.change.opened')
    expect(attributeOf(opened, 'vinaya.change.id')).toBe('318')
    const pushed = world.events().find((e) => eventNameOf(e) === 'vinaya.change.pushed')
    expect(attributeOf(pushed, 'vinaya.change.tests_picked')).toBe(4)
  })

  it('writes a pull request closed without merging as closed, never merged', async () => {
    const world = createRunLifecycleWorld()
    const recorder = world.process()
    write(world, recorder, started)
    lifecycle.recordWatchedChangeEnded(
      { state: 'closed', task: 7, pr: 318 },
      { ...where, recorder, readEnd: () => ({}) }
    )
    await recorder.drain()
    const names = world.events().map(eventNameOf)
    expect(names.filter((n) => n === 'vinaya.change.closed')).toHaveLength(1)
    expect(names).not.toContain('vinaya.change.merged')
    const closed = world.events().find((e) => eventNameOf(e) === 'vinaya.change.closed')
    expect(attributeOf(closed, 'vinaya.run.id')).toBe('run-1')
  })

  it('ends a round in a later process: one span, not two', async () => {
    const world = createRunLifecycleWorld()
    const first = world.process()
    write(world, first, started)
    write(world, first, loop({ event: 'round_started', round: 1, base_head: 'aaa' }))
    await first.drain()
    const second = world.process()
    write(world, second, started)
    write(world, second, roundEnded(1, 'green'))
    await second.drain()
    const rounds = world.spans().filter((s) => s.name === 'vinaya.round 1')
    expect(rounds).toHaveLength(1)
    expect(attributeOf(rounds[0], 'vinaya.round.outcome')).toBe('green')
  })
})

describe('a round another process also starts', () => {
  const loop = (fields: Record<string, unknown>): DevReviewLoopEventInput =>
    ({ kind: 'dev_review_loop', payload: {}, loop_id: 'l1', ...fields }) as unknown as DevReviewLoopEventInput
  const where = { runId: 'run-1', repository: 'atta-labs/vinaya' }

  it('is one span: a later process that starts the round the first holds open writes no second span', async () => {
    const world = createRunLifecycleWorld()
    const options = (recorder: RunRecorder) => ({ recorder, runtimeDir: () => world.runtimeDir })
    const started = loop({ event: 'loop_started', task: 7, policy: { max_rounds: 5, reviewers: [] } })
    const first = world.process()
    writeRunLifecycleEvent(started, where, options(first))
    writeRunLifecycleEvent(loop({ event: 'round_started', round: 1, base_head: 'aaa' }), where, options(first))
    await first.drain()
    const second = world.process()
    writeRunLifecycleEvent(started, where, options(second))
    writeRunLifecycleEvent(loop({ event: 'round_started', round: 1, base_head: 'aaa' }), where, options(second))
    writeRunLifecycleEvent(
      loop({ event: 'round_ended', round: 1, files_changed: 1, insertions: 2, deletions: 0, outcome: 'green' }),
      where,
      options(second)
    )
    await second.drain()
    const rounds = world.spans().filter((s) => s.name === 'vinaya.round 1')
    expect(rounds).toHaveLength(1)
    expect(attributeOf(rounds[0], 'vinaya.round.outcome')).toBe('green')
    expect(world.errors).toEqual([])
  })
})

describe('the driver exit record', () => {
  function recorder(describeDecision = () => 'publish') {
    const events: DevReviewLoopEventInput[] = []
    const order: string[] = []
    const path = loopLog()
    const record = createDriverExitRecorder({
      loopId: 'l1',
      task: 7,
      loopLogPath: path,
      describeDecision,
      log: (event) => {
        order.push(`logged:${event.event}`)
        events.push(event)
      }
    })
    return { record, events, order, path }
  }

  it('writes the exit once, whichever path reaches it', () => {
    const { record, events, order } = recorder()
    record('finished', { exitCode: 0 })
    record('signal', { exitCode: 143 })
    record('error', { error: new Error('late') })
    expect(order).toEqual(['logged:driver_exited'])
    expect(events).toEqual([
      {
        kind: 'dev_review_loop',
        payload: {},
        loop_id: 'l1',
        event: 'driver_exited',
        task: 7,
        reason: 'finished',
        last_decision: 'publish',
        exit_code: 0
      }
    ])
  })

  it('classifies a thrown error by its code or class, never its message', () => {
    const { record, events } = recorder()
    record('error', { error: Object.assign(new Error('secret path /home/x'), { code: 'step_failed' }) })
    expect(events[0]).toMatchObject({ reason: 'error', error_class: 'step_failed' })
    expect(JSON.stringify(events[0])).not.toContain('secret')
  })

  it('traces only the abnormal exits in the per-task driver log', () => {
    for (const [reason, traced] of [
      ['finished', false],
      ['paused', false],
      ['reexec', true],
      ['error', true],
      ['signal', true]
    ] as Array<[DriverExitReason, boolean]>) {
      const { record, path } = recorder(() => 'pause(infrastructure)')
      record(reason)
      let text = ''
      try {
        text = readFileSync(path, 'utf8')
      } catch {}
      if (traced) expect(text).toContain(`driver_exited: reason=${reason} last_decision=pause(infrastructure)`)
      else expect(text).toBe('')
    }
  })

  it('reads the last decision when the exit is recorded, not when the recorder is built', () => {
    let decision = 'dispatch_developer'
    const { record, events } = recorder(() => decision)
    decision = 'pause(max_rounds)'
    record('paused')
    expect(events[0]).toMatchObject({ last_decision: 'pause(max_rounds)' })
  })

  it('survives a sink that throws', () => {
    const record = createDriverExitRecorder({
      loopId: 'l',
      task: 1,
      loopLogPath: loopLog(),
      describeDecision: () => 'publish',
      log: () => {
        throw new Error('sink down')
      }
    })
    expect(() => record('finished')).not.toThrow()
  })
})

describe('whether the driver lock is kept on exit', () => {
  it('clears it after a publish, and keeps it while the watching driver watches the published pull request', () => {
    expect(keepDriverLock({ kind: 'publish', watched: false })).toBe(false)
    expect(keepDriverLock({ kind: 'publish', watched: true })).toBe(true)
  })

  it('keeps it for an infrastructure pause and a stale-driver pause', () => {
    expect(keepDriverLock({ kind: 'pause', reason: 'infrastructure', watched: false })).toBe(true)
    expect(keepDriverLock({ kind: 'pause', reason: 'stale_driver', watched: false })).toBe(true)
  })

  it('keeps it for any pause under the watching driver', () => {
    for (const reason of ['escalation', 'max_rounds', 'confidence', 'ruling_posted', 'infrastructure'])
      expect(keepDriverLock({ kind: 'pause', reason, watched: true })).toBe(true)
  })

  it('clears it for every other pause, which only a Principal decides', () => {
    for (const reason of [
      'escalation',
      'max_rounds',
      'confidence',
      'reappearance',
      'no_push',
      'objectives_changed',
      'ruling_posted',
      'brief_superseded',
      'policy_changed'
    ])
      expect(keepDriverLock({ kind: 'pause', reason, watched: false })).toBe(false)
  })

  it('keeps it after an uncaught error, except a host the sandbox cannot run on', () => {
    expect(keepDriverLock({ kind: 'crash', hostRepair: false })).toBe(true)
    expect(keepDriverLock({ kind: 'crash', hostRepair: true })).toBe(false)
  })
})

describe('seeding the loop from the forge journal', () => {
  const state = (): LoopState =>
    initialLoopState({ loopId: 'l', task: 7, reviewers: [], models: {}, maxRounds: 5 } as never)
  const journal = (input: Parameters<typeof reconstructRounds>[0]): ReconstructedJournal => reconstructRounds(input)

  it('asks the forge about the pull request it is given', () => {
    const asked: Array<number | null> = []
    seedLoopHistory({
      fetchLoopHistory: (pr) => {
        asked.push(pr)
        return journal({ roundMarkers: [], summaryPublished: false, summaryUrl: null, reviewGate: 'unknown' })
      },
      prNumber: 31,
      state: state()
    })
    expect(asked).toEqual([31])
  })

  it('carries the rounds of an unfinished review into the state', () => {
    const history = journal({ roundMarkers: [1, 2], summaryPublished: false, summaryUrl: null, reviewGate: 'unknown' })
    const before = state()
    const seeded = seedLoopHistory({ fetchLoopHistory: () => history, prNumber: 31, state: before })
    expect(seeded.historyApplies).toBe(true)
    expect(seeded.loopHistory).toBe(history)
    expect(seeded.state.rounds.map((r) => r.round)).toEqual([1, 2])
    expect(seeded.state.totalWallMs).toBe(history.totalWallMs)
    expect(seeded.state.totalFilesChanged).toBe(history.totalFilesChanged)
    expect(before.rounds).toEqual([])
  })

  it('leaves the state alone for a journal that already concluded, so no round is doubled', () => {
    const history = journal({ roundMarkers: [1], summaryPublished: true, summaryUrl: 'u', reviewGate: 'pass' })
    const before = state()
    const seeded = seedLoopHistory({ fetchLoopHistory: () => history, prNumber: 31, state: before })
    expect(seeded.historyApplies).toBe(false)
    expect(seeded.state).toBe(before)
  })

  it('seeds again when the gate has since failed on a published summary', () => {
    const history = journal({ roundMarkers: [1], summaryPublished: true, summaryUrl: 'u', reviewGate: 'fail' })
    expect(seedLoopHistory({ fetchLoopHistory: () => history, prNumber: 31, state: state() }).historyApplies).toBe(true)
  })

  it('leaves the state alone when the forge holds no round at all', () => {
    const history = journal({ roundMarkers: [], summaryPublished: false, summaryUrl: null, reviewGate: 'unknown' })
    const before = state()
    const seeded = seedLoopHistory({ fetchLoopHistory: () => history, prNumber: null, state: before })
    expect(seeded.historyApplies).toBe(false)
    expect(seeded.state).toBe(before)
  })
})
