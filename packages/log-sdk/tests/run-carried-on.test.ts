import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ATTRIBUTE_NAMES as A, EVENT_NAMES as E, spanIdFor, type Timers } from '../src/index.js'
import { createFolderSource } from '../src/reader/folder-source.js'
import { harness } from './helpers.js'

const temp = mkdtempSync(join(tmpdir(), 'log-sdk-carried-on-'))
afterAll(() => rmSync(temp, { recursive: true, force: true }))

/** A clock and timers a test drives by hand, so no real time passes. */
function fakeTimers(): Timers & { advance(ms: number): void } {
  let now = 1_000_000
  let next = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = next++
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout(id) {
      timers.delete(id as number)
    },
    advance(ms) {
      const target = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (due === undefined) break
        timers.delete(due[0])
        now = Math.max(now, due[1].at)
        due[1].fn()
      }
      now = target
    }
  }
}

/** Two handles on one run id and one local copy folder: the first process, then a later one. */
function twoProcesses(runId: string) {
  const runtimeDir = mkdtempSync(join(temp, 'copy-'))
  const timers = fakeTimers()
  const first = harness({ runId, runtimeDir })
  const later = harness({ runId, runtimeDir, timers })
  const copy = async () => {
    const logs = join(runtimeDir, 'logs')
    const folder = join(logs, readdirSync(logs)[0] as string)
    return (await createFolderSource({ runId, folder }).read()).records
  }
  return { first, later, timers, copy }
}

const T0 = new Date(1_000)

test('a later process carries on the run', async () => {
  const { first, later, timers, copy } = twoProcesses('carried-run')
  first.handle.run.started({ process: 'acme', processVersion: '1', startTime: T0 })
  first.handle.run.stageChanged({ to: 'review' })
  first.handle.round.started({ number: 2, startingCommit: 'abc', startTime: new Date(2_000) })
  first.handle.run.paused({ round: 2, why: 'escalation', startTime: new Date(3_000) })
  const asked = first.handle.person.asked({
    kind: 'strategy',
    key: 'q',
    why: 'two_designs',
    decision: 'pick_one',
    howToAnswer: 'answer it',
    startTime: new Date(4_000)
  })
  expect(first.spans.getFinishedSpans()).toEqual([])

  const ref = later.handle.run.started({ process: 'acme' })
  expect(ref.spanId).toBe(spanIdFor('carried-run', 'run'))
  later.handle.round.ended({ outcome: 'approved', endTime: new Date(5_000) })
  later.handle.run.resumed({ by: 'person', endTime: new Date(6_000) })
  later.handle.person.answered({
    kind: 'strategy',
    spanId: asked.spanId,
    answer: 'option_a',
    by: 'principal',
    endTime: new Date(7_000)
  })
  timers.advance(120_000)
  later.handle.run.ended({ rounds: 2, outcome: 'ready', endTime: new Date(8_000) })
  expect(later.errors).toEqual([])
  expect(first.errors).toEqual([])

  const records = await copy()
  expect(records.filter((r) => r.name === E.runStarted)).toHaveLength(1)
  const spans = later.spans.getFinishedSpans()
  expect(spans.map((s) => s.name).sort()).toEqual([
    'invoke_workflow acme',
    'vinaya.pause',
    'vinaya.person strategy',
    'vinaya.round 2'
  ])
  const byName = (name: string) => spans.find((s) => s.name === name)
  const runSpan = byName('invoke_workflow acme')
  expect(runSpan?.spanContext().spanId).toBe(spanIdFor('carried-run', 'run'))
  expect(runSpan?.startTime).toEqual([1, 0])
  expect(runSpan?.endTime).toEqual([8, 0])
  expect(runSpan?.parentSpanContext).toBeUndefined()
  expect(runSpan?.attributes).toMatchObject({
    [A.processName]: 'acme',
    [A.processVersion]: '1',
    [A.runRounds]: 2,
    [A.runOutcome]: 'ready'
  })
  const round = byName('vinaya.round 2')
  expect(round?.startTime).toEqual([2, 0])
  expect(round?.endTime).toEqual([5, 0])
  expect(round?.parentSpanContext?.spanId).toBe(spanIdFor('carried-run', 'run'))
  expect(round?.attributes).toMatchObject({
    [A.roundNumber]: 2,
    [A.roundStartCommit]: 'abc',
    [A.roundOutcome]: 'approved'
  })
  const pause = byName('vinaya.pause')
  expect(pause?.startTime).toEqual([3, 0])
  expect(pause?.endTime).toEqual([6, 0])
  expect(pause?.attributes).toMatchObject({ [A.roundNumber]: 2, [A.pauseWhy]: 'escalation', [A.pauseBy]: 'person' })
  const person = byName('vinaya.person strategy')
  expect(person?.spanContext().spanId).toBe(asked.spanId)
  expect(person?.startTime).toEqual([4, 0])
  expect(person?.endTime).toEqual([7, 0])
  expect(person?.attributes).toMatchObject({
    [A.personWhy]: 'two_designs',
    [A.personDecision]: 'pick_one',
    [A.personHowToAnswer]: 'answer it',
    [A.personAnswer]: 'option_a',
    [A.answeredBy]: 'principal'
  })
  const events = later.logs.getFinishedLogRecords()
  expect(events.filter((e) => e.eventName === E.runStarted)).toEqual([])
  expect(events.filter((e) => e.eventName === E.alive)).toHaveLength(1)
})

test('a carried-on run keeps its round and stage', () => {
  const { first, later, timers } = twoProcesses('carried-moment')
  first.handle.run.started({ process: 'acme', startTime: T0 })
  first.handle.round.started({ number: 1, startTime: new Date(2_000) })
  first.handle.round.ended({ endTime: new Date(3_000) })
  first.handle.round.started({ number: 2, startTime: new Date(4_000) })
  first.handle.run.stageChanged({ from: 'develop', to: 'review' })
  first.handle.run.stageChanged({ from: 'review', to: 'ready_push' })

  later.handle.run.started({ process: 'acme' })
  later.handle.change.saved({ branch: 'b' })
  timers.advance(120_000)
  const saved = later.logs.getFinishedLogRecords().find((e) => e.eventName === E.changeSaved)
  expect(saved?.attributes[A.round]).toBe(2)
  const alive = later.logs.getFinishedLogRecords().filter((e) => e.eventName === E.alive)
  expect(alive).toHaveLength(1)
  expect(alive[0]?.attributes).toMatchObject({ [A.roundNumber]: 2, [A.phaseName]: 'ready_push' })

  // Its own round and stage calls change them.
  later.handle.round.started({ number: 3 })
  later.handle.run.stageChanged({ to: 'waiting_on_ci' })
  timers.advance(120_000)
  const next = later.logs.getFinishedLogRecords().filter((e) => e.eventName === E.alive)
  expect(next[1]?.attributes).toMatchObject({ [A.roundNumber]: 3, [A.phaseName]: 'waiting_on_ci' })
  expect(later.errors).toEqual([])
})

test('a span with no start anywhere reports through onError and writes nothing', () => {
  const { later } = twoProcesses('carried-none')
  later.handle.round.ended()
  later.handle.run.resumed({ by: 'run' })
  later.handle.person.answered({ kind: 'product', spanId: '1111111111111111', by: 'principal' })
  later.handle.run.ended()
  expect(later.errors).toHaveLength(4)
  expect(later.spans.getFinishedSpans()).toEqual([])
})

test('a carried-on run ends once and sends no alive afterwards', () => {
  const { first, later, timers } = twoProcesses('carried-end')
  first.handle.run.started({ process: 'acme', startTime: T0 })
  first.handle.round.started({ number: 1, startTime: new Date(2_000) })
  later.handle.run.started({ process: 'acme' })
  later.handle.round.ended({ endTime: new Date(3_000) })
  later.handle.round.ended({ endTime: new Date(3_500) })
  later.handle.run.ended({ endTime: new Date(4_000) })
  later.handle.run.ended({ endTime: new Date(4_500) })
  timers.advance(300_000)
  expect(
    later.spans
      .getFinishedSpans()
      .map((s) => s.name)
      .sort()
  ).toEqual(['invoke_workflow acme', 'vinaya.round 1'])
  expect(later.errors).toHaveLength(2)
  expect(later.logs.getFinishedLogRecords().filter((e) => e.eventName === E.alive)).toEqual([])
})

test('a handle that carries on stops its alive at shutdown', async () => {
  const { first, later, timers } = twoProcesses('carried-stop')
  first.handle.run.started({ process: 'acme', startTime: T0 })
  later.handle.run.started({ process: 'acme' })
  await later.handle.shutdown()
  timers.advance(300_000)
  expect(later.logs.getFinishedLogRecords().filter((e) => e.eventName === E.alive)).toEqual([])
})
