import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  initialLoopState,
  reconstructRounds,
  type DevReviewLoopEventInput,
  type LoopState,
  type ReconstructedJournal
} from '@attalabs/aeg-core'
import {
  createDriverExitRecorder,
  DRIVER_HEARTBEAT_INTERVAL_MS,
  defaultSetHeartbeat,
  emitDriverHeartbeat,
  keepDriverLock,
  seedLoopHistory,
  type DriverExitReason
} from '../../../src/lib/dev-review-loop/driver-lifecycle'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const loopLog = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'driver-lifecycle-'))
  scratch.push(dir)
  return join(dir, 'driver.log')
}

describe('the driver heartbeat', () => {
  it('beats every five minutes', () => {
    expect(DRIVER_HEARTBEAT_INTERVAL_MS).toBe(300_000)
  })

  it('reports where the loop is, with its pull request once there is one', () => {
    const events: DevReviewLoopEventInput[] = []
    emitDriverHeartbeat({ loopId: 'l1', task: 7, round: 2, phase: 'gates', prNumber: 31, log: (e) => events.push(e) })
    emitDriverHeartbeat({ loopId: 'l1', task: 7, round: 1, phase: null, prNumber: 0, log: (e) => events.push(e) })
    expect(events).toEqual([
      {
        kind: 'dev_review_loop',
        payload: {},
        loop_id: 'l1',
        event: 'driver_heartbeat',
        task: 7,
        round: 2,
        phase: 'gates',
        pr: 31
      },
      {
        kind: 'dev_review_loop',
        payload: {},
        loop_id: 'l1',
        event: 'driver_heartbeat',
        task: 7,
        round: 1,
        phase: 'starting'
      }
    ])
  })

  it('never throws out of the timer when the sink does', () => {
    expect(() =>
      emitDriverHeartbeat({
        loopId: 'l',
        task: 1,
        round: 1,
        phase: null,
        prNumber: 0,
        log: () => {
          throw new Error('sink down')
        }
      })
    ).not.toThrow()
  })

  it('starts an unref-ed timer that the returned function stops', async () => {
    let beats = 0
    const stop = defaultSetHeartbeat(() => (beats += 1), 5)
    await new Promise((resolve) => setTimeout(resolve, 40))
    stop()
    const seen = beats
    expect(seen).toBeGreaterThan(0)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(beats).toBe(seen)
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
      stopHeartbeat: () => order.push('heartbeat-stopped'),
      log: (event) => {
        order.push(`logged:${event.event}`)
        events.push(event)
      }
    })
    return { record, events, order, path }
  }

  it('writes the exit once, whichever path reaches it, and stops the heartbeat first', () => {
    const { record, events, order } = recorder()
    record('finished', { exitCode: 0 })
    record('signal', { exitCode: 143 })
    record('error', { error: new Error('late') })
    expect(order).toEqual(['heartbeat-stopped', 'logged:driver_exited'])
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
      stopHeartbeat: () => {},
      log: () => {
        throw new Error('sink down')
      }
    })
    expect(() => record('finished')).not.toThrow()
  })
})

describe('whether the driver lock is kept on exit', () => {
  it('clears it after a publish', () => {
    expect(keepDriverLock({ kind: 'publish' })).toBe(false)
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
