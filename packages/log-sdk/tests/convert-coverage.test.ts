import { expect, test } from 'bun:test'
import { convertEarlierEvents, LogEventSchema } from '../src/index.js'

export const fixtureEvents = (await Bun.file(new URL('./fixtures/earlier-events.jsonl', import.meta.url)).text())
  .trim()
  .split('\n')
  .map((line) => LogEventSchema.parse(JSON.parse(line)))

const pair = (event: { kind: string; event: string }) => `${event.kind}.${event.event}`

test('each pair declared by the schema has a fixture and a conversion', () => {
  const declared = LogEventSchema.options.flatMap((family) =>
    family.options.map((variant) => pair({ kind: variant.shape.kind.value, event: variant.shape.event.value }))
  )
  for (const name of declared) {
    const fixture = fixtureEvents.find((event) => pair(event) === name)
    if (fixture === undefined) throw new Error(`Missing fixture for ${name}`)
    const { traces, logs } = convertEarlierEvents([fixture])
    expect(traces.resourceSpans.length + logs.resourceLogs.length, name).toBe(1)
  }
  expect(fixtureEvents.map(pair).sort()).toEqual(declared.sort())
})
