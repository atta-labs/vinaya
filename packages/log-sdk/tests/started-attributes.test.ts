import { expect, test } from 'bun:test'
import type { Attributes } from '@opentelemetry/api'
import { ATTRIBUTE_NAMES as A, EVENT_NAMES as E } from '../src/contract/catalogue.js'
import type { SpanParent } from '../src/contract/ids.js'
import { harness } from './helpers.js'

type StartRow = {
  name: string
  event: string
  start: () => SpanParent
  finish?: (ref: SpanParent) => void
  completionField?: string
}

test('each start row emits the attributes its span starts with', async () => {
  const startedSpans = new Map<string, Attributes>()
  const home = '/home/log-sdk-test'
  const { handle, logs, errors } = harness({
    home,
    spanProcessors: [
      {
        onStart(span) {
          startedSpans.set(span.spanContext().spanId, { ...span.attributes })
        },
        onEnd() {},
        forceFlush: async () => {},
        shutdown: async () => {}
      }
    ]
  })

  const startTime = new Date(1_000)
  const rows: StartRow[] = [
    {
      name: 'log.run.started',
      event: E.runStarted,
      start: () => handle.run.started({ process: 'acme', work: { ref: '42' } })
    },
    {
      name: 'log.round.started',
      event: E.roundStarted,
      start: () => handle.round.started({ number: 3, startingCommit: 'abc123' })
    },
    {
      name: 'log.agent.sent',
      event: E.agentStarted,
      start: () => handle.agent.sent({ seat: 'reviewer', provider: 'anthropic', model: 'requested-model' })
    },
    {
      name: 'log.agent.stepStarted',
      event: E.stepStarted,
      start: () =>
        handle.agent.stepStarted({ tool: 'Read', callId: 'call-1', kind: 'reading', target: `${home}/notes.md` }),
      finish: (ref) => handle.agent.stepEnded(ref)
    },
    {
      name: 'log.run.paused',
      event: E.pauseStarted,
      start: () => handle.run.paused({ round: 3, why: 'escalation', startTime }),
      finish: (pause) => handle.run.resumed({ pause, by: 'person' }),
      completionField: A.pauseBy
    },
    {
      name: 'log.person.asked',
      event: E.personAsked,
      start: () =>
        handle.person.asked({ kind: 'strategy', key: 'q1', why: 'two_designs', decision: 'pick_one', startTime }),
      finish: (ref) => handle.person.answered({ kind: 'strategy', spanId: ref.spanId, startTime, by: 'principal' }),
      completionField: A.answeredBy
    }
  ]

  for (const row of rows) {
    const ref = row.start()
    const event = logs.getFinishedLogRecords().at(-1)
    expect(event?.eventName, row.name).toBe(row.event)
    expect(event?.spanContext, row.name).toMatchObject(ref)

    // Pauses and questions materialize their spans when they finish.
    row.finish?.(ref)
    const spanAttributes = startedSpans.get(ref.spanId)
    if (spanAttributes === undefined) throw new Error(`${row.name}: missing span`)
    for (const [key, value] of Object.entries(spanAttributes)) {
      if (key === row.completionField) continue
      expect(event?.attributes[key], `${row.name}: ${key}`).toEqual(value)
    }
    if (row.event === E.stepStarted) {
      expect(event?.attributes, row.name).toMatchObject({
        [A.toolName]: 'Read',
        [A.toolCallId]: 'call-1',
        [A.stepKind]: 'reading',
        [A.stepTarget]: '~/notes.md'
      })
    }
  }

  handle.agent.returned()
  handle.round.ended()
  handle.run.ended()
  await handle.shutdown()
  expect(errors).toEqual([])
})
