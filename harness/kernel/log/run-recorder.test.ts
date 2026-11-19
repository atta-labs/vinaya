import { expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentSpanIdFor } from '../../../packages/log-sdk/src/contract/convert-map.js'
import { traceIdFor } from '../../../packages/log-sdk/src/contract/ids.js'
import { createRunRecorder } from './run-recorder.js'

const RUN = 'run-recorder'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-run-recorder-'))
  const folder = join(dir, 'logs')
  const errors: unknown[] = []
  const recorder = createRunRecorder({
    runId: () => RUN,
    workRef: () => '404',
    target: () => ({ folder, repository: 'atta-labs/vinaya' }),
    home: () => dir,
    cwd: () => mkdtempSync(join(tmpdir(), 'vinaya-run-recorder-root-')),
    onError: (e) => errors.push(e)
  })
  const records = (signal: 'traces' | 'logs'): any[] => {
    let names: string[] = []
    try {
      names = readdirSync(join(folder, 'atta-labs-vinaya')).filter((n) => n.endsWith(`.${signal}.jsonl`))
    } catch {}
    return names.flatMap((name) =>
      readFileSync(join(folder, 'atta-labs-vinaya', name), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    )
  }
  const spans = () =>
    records('traces').flatMap((r) => r.resourceSpans.flatMap((g: any) => g.scopeSpans.flatMap((s: any) => s.spans)))
  const events = () =>
    records('logs').flatMap((r) => r.resourceLogs.flatMap((g: any) => g.scopeLogs.flatMap((s: any) => s.logRecords)))
  return { recorder, errors, spans, events }
}

const attribute = (record: any, key: string): unknown => {
  const value = record.attributes.find((a: any) => a.key === key)?.value
  if (value === undefined) return undefined
  if (value.intValue !== undefined) return Number(value.intValue)
  return value.stringValue ?? value.boolValue ?? value.doubleValue
}

test('a step whose dispatch has no effect id records nothing and throws nothing', () => {
  const { recorder, errors, spans, events } = setup()
  const steps = recorder.steps(undefined)
  expect(() => {
    steps.observe({ type: 'start', id: 'c1', tool: 'Bash', kind: 'running', target: 'ls', at: 1_000 })
    steps.observe({ type: 'result', id: 'c1', kind: 'running', target: 'ls', ok: true, durationMs: 5, at: 1_005 })
    steps.close()
  }).not.toThrow()
  expect(spans()).toEqual([])
  expect(events()).toEqual([])
  expect(errors).toEqual([])
})

test("step updates become step spans under the dispatch's agent span, with no payload", () => {
  const { recorder, errors, spans } = setup()
  const steps = recorder.steps('effect-1')
  steps.observe({ type: 'start', id: 'c1', tool: 'Bash', kind: 'running_tests', target: 'bun test', at: 1_000 })
  steps.observe({
    type: 'result',
    id: 'c1',
    kind: 'running_tests',
    target: 'bun test',
    ok: false,
    durationMs: 250,
    at: 1_250,
    error: 'SECRET-TOOL-OUTPUT-LINE',
    failedTests: 3
  })
  steps.observe({ type: 'start', id: 'c2', tool: 'Read', kind: 'reading', target: 'a.ts', at: 2_000 })
  steps.observe({ type: 'result', id: 'c2', kind: 'reading', target: 'a.ts', ok: true, durationMs: 10, at: 2_010 })
  const written = spans()
  expect(errors).toEqual([])
  expect(written).toHaveLength(2)
  const tests = written.find((s) => s.name === 'execute_tool Bash')
  expect(tests.traceId).toBe(traceIdFor(RUN))
  expect(tests.parentSpanId).toBe(agentSpanIdFor(RUN, 'effect-1'))
  expect(attribute(tests, 'gen_ai.tool.name')).toBe('Bash')
  expect(attribute(tests, 'gen_ai.tool.call.id')).toBe('c1')
  expect(attribute(tests, 'vinaya.step.kind')).toBe('running_tests')
  expect(attribute(tests, 'vinaya.step.target')).toBe('bun test')
  expect(attribute(tests, 'error.type')).toBe('tests_failed')
  expect(String(attribute(tests, 'vinaya.step.error_line'))).toBe('3 failed')
  expect(JSON.stringify(written)).not.toContain('SECRET-TOOL-OUTPUT-LINE')
  expect(BigInt(tests.endTimeUnixNano) - BigInt(tests.startTimeUnixNano)).toBe(250_000_000n)
  const read = written.find((s) => s.name === 'execute_tool Read')
  expect(attribute(read, 'error.type')).toBeUndefined()
  for (const span of written) {
    expect(attribute(span, 'vinaya.provenance')).toBe('governed')
    expect(attribute(span, 'vinaya.work.ref')).toBe('404')
    expect(
      span.attributes.map((a: any) => a.key).filter((k: string) => /input|output|content|command/.test(k))
    ).toEqual([])
  }
})

test("a stage change becomes a stage-changed event with the stage and round, governed and on the run's trace", () => {
  const { recorder, events } = setup()
  recorder.stageChanged({ stage: 'review', round: 2 })
  const written = events().filter((e) => e.eventName === 'vinaya.run.stage_changed')
  expect(written).toHaveLength(1)
  const [stage] = written
  expect(stage.traceId).toBe(traceIdFor(RUN))
  expect(attribute(stage, 'vinaya.stage.to')).toBe('review')
  expect(attribute(stage, 'vinaya.round.number')).toBe(2)
  expect(attribute(stage, 'vinaya.provenance')).toBe('governed')
  expect(attribute(stage, 'vinaya.work.ref')).toBe('404')
})

test('a step left open when the dispatch ends is closed as interrupted', () => {
  const { recorder, spans } = setup()
  const steps = recorder.steps('effect-2')
  steps.observe({ type: 'start', id: 'c1', tool: 'Bash', kind: 'running', target: 'sleep', at: 1_000 })
  steps.close()
  expect(attribute(spans()[0], 'error.type')).toBe('interrupted')
})
