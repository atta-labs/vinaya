import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { traceIdFor } from '@attalabs/vinaya-log-sdk'
import { createRunRecorder } from './run-recorder.js'

const RUN = 'run-recorder'

const IDENTITY = {
  runnerName: 'atta-engine',
  runnerVersion: '4.5.6',
  cliVersion: '0.9.1',
  flowId: 'example-flow',
  flowVersion: 'v2',
  processDigest: 'a'.repeat(64)
}

function setup(options: { off?: boolean; root?: string; identity?: typeof IDENTITY | {}; folder?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-run-recorder-'))
  const folder = options.folder ?? join(dir, 'logs')
  const errors: unknown[] = []
  const sent: unknown[] = []
  let drained = 0
  const recorder = createRunRecorder({
    runId: () => RUN,
    workRef: () => '404',
    repository: () => 'atta-labs/vinaya',
    place: (repository) => (options.off ? undefined : { folder, repository }),
    processIdentity: () => ({ name: 'Example', version: '1.2.3' }),
    ...(options.identity === undefined ? {} : { runIdentity: () => options.identity as typeof IDENTITY }),
    sender: () => ({
      request: (place) => void sent.push(place),
      remember: () => {},
      drain: async () => {
        drained += 1
      }
    }),
    home: () => dir,
    cwd: () => options.root ?? mkdtempSync(join(tmpdir(), 'vinaya-run-recorder-root-')),
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
  const resources = (): Record<string, unknown>[] =>
    records('traces').flatMap((r) =>
      r.resourceSpans.map((g: any) =>
        Object.fromEntries(g.resource.attributes.map((a: any) => [a.key, a.value.stringValue ?? a.value.boolValue]))
      )
    )
  return { recorder, errors, sent, drained: () => drained, folder, spans, events, resources }
}

const attribute = (record: any, key: string): unknown => {
  const value = record.attributes.find((a: any) => a.key === key)?.value
  if (value === undefined) return undefined
  if (value.intValue !== undefined) return Number(value.intValue)
  return value.stringValue ?? value.boolValue ?? value.doubleValue
}

test('the handle opens from the process settings alone and writes to the local copy folder, with no earlier-format write', () => {
  const { recorder, errors, folder, spans } = setup()
  expect(existsSync(folder)).toBe(false)
  const turn = recorder.turn({ seat: 'developer', key: 'turn-0', provider: 'claude' })
  turn.returned({ outcome: 'done' })
  expect(errors).toEqual([])
  expect(spans().map((s) => s.name)).toEqual(['invoke_agent developer'])
  expect(existsSync(join(folder, 'atta-labs-vinaya'))).toBe(true)
  expect(recorder.handle()?.runId).toBe(RUN)
})

test('with recording off a turn records nothing and throws nothing', () => {
  const { recorder, errors, folder, sent } = setup({ off: true })
  const turn = recorder.turn({ seat: 'developer', key: 'turn-off' })
  expect(() => {
    turn.steps.observe({ type: 'start', id: 'c1', tool: 'Bash', kind: 'running', target: 'ls', at: 1_000 })
    turn.usage({ inputTokens: 1, outputTokens: 2 })
    turn.returned({ outcome: 'done' })
  }).not.toThrow()
  expect(existsSync(folder)).toBe(false)
  expect(errors).toEqual([])
  expect(sent).toEqual([])
  expect(recorder.handle()).toBeUndefined()
})

test('a turn is one invoke_agent span with its usage and its steps under it, governed and on the run trace', () => {
  const { recorder, errors, spans, sent } = setup()
  const turn = recorder.turn({
    seat: 'code-reviewer',
    provider: 'claude',
    codingAgent: 'claude',
    model: 'sonnet',
    round: 2,
    key: 'turn-1',
    startTime: 1_000
  })
  turn.steps.observe({ type: 'start', id: 'c1', tool: 'Bash', kind: 'running_tests', target: 'bun test', at: 1_000 })
  turn.steps.observe({
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
  turn.steps.observe({ type: 'start', id: 'c2', tool: 'Read', kind: 'reading', target: 'a.ts', at: 2_000 })
  turn.steps.observe({ type: 'result', id: 'c2', kind: 'reading', target: 'a.ts', ok: true, durationMs: 10, at: 2_010 })
  turn.usage({ inputTokens: 120, outputTokens: 45, cacheReadInputTokens: 30 })
  turn.returned({ outcome: 'done', attempt: 2, responseModel: 'claude-sonnet-5-5' })
  const written = spans()
  expect(errors).toEqual([])
  expect(written).toHaveLength(3)
  const agent = written.find((s) => s.name === 'invoke_agent code-reviewer')
  expect(agent.traceId).toBe(traceIdFor(RUN))
  expect(attribute(agent, 'gen_ai.agent.name')).toBe('code-reviewer')
  expect(attribute(agent, 'gen_ai.request.model')).toBe('sonnet')
  expect(attribute(agent, 'gen_ai.response.model')).toBe('claude-sonnet-5-5')
  expect(attribute(agent, 'gen_ai.usage.input_tokens')).toBe(120)
  expect(attribute(agent, 'gen_ai.usage.output_tokens')).toBe(45)
  expect(attribute(agent, 'gen_ai.usage.cache_read.input_tokens')).toBe(30)
  const tests = written.find((s) => s.name === 'execute_tool Bash')
  expect(tests.parentSpanId).toBe(agent.spanId)
  expect(attribute(tests, 'gen_ai.tool.name')).toBe('Bash')
  expect(attribute(tests, 'gen_ai.tool.call.id')).toBe('c1')
  expect(attribute(tests, 'vinaya.step.kind')).toBe('running_tests')
  expect(attribute(tests, 'vinaya.step.target')).toBe('bun test')
  expect(attribute(tests, 'error.type')).toBe('tests_failed')
  expect(String(attribute(tests, 'vinaya.step.error_line'))).toBe('3 failed')
  expect(JSON.stringify(written)).not.toContain('SECRET-TOOL-OUTPUT-LINE')
  expect(BigInt(tests.endTimeUnixNano) - BigInt(tests.startTimeUnixNano)).toBe(250_000_000n)
  const read = written.find((s) => s.name === 'execute_tool Read')
  expect(read.parentSpanId).toBe(agent.spanId)
  expect(attribute(read, 'error.type')).toBeUndefined()
  for (const span of written) {
    expect(attribute(span, 'vinaya.provenance')).toBe('governed')
    expect(attribute(span, 'vinaya.work.ref')).toBe('404')
    // A step carries no payload; the agent span carries only the token counts.
    const keys: string[] = span.attributes
      .map((a: any) => a.key)
      .filter((k: string) => /input|output|content|command/.test(k))
    expect(keys.filter((k) => !k.startsWith('gen_ai.usage.'))).toEqual([])
    if (span !== agent) expect(keys).toEqual([])
  }
  expect(sent).toHaveLength(1)
})

test('a failed turn ends with its error type and a usage that is not known keeps its reason and no figure', () => {
  const { recorder, errors, spans } = setup()
  const turn = recorder.turn({ seat: 'developer', key: 'turn-2' })
  turn.usage({ inputTokens: null, outputTokens: null, unknownReason: 'the stream carried no usage' })
  turn.failed({ errorType: 'usage_limit', resetAt: '2026-11-22T10:00:00.000Z', attempt: 1 })
  const [agent] = spans()
  expect(errors).toEqual([])
  expect(attribute(agent, 'error.type')).toBe('usage_limit')
  expect(attribute(agent, 'gen_ai.usage.unknown_reason') ?? attribute(agent, 'vinaya.usage.unknown_reason')).toBe(
    'the stream carried no usage'
  )
  expect(attribute(agent, 'gen_ai.usage.input_tokens')).toBeUndefined()
  expect(attribute(agent, 'gen_ai.usage.output_tokens')).toBeUndefined()
})

test('usage with no figure and no reason is recorded as unknown, never as zero', () => {
  const { recorder, spans } = setup()
  const turn = recorder.turn({ seat: 'developer', key: 'turn-3' })
  turn.usage({ inputTokens: null, outputTokens: null })
  turn.returned({ outcome: 'done' })
  const [agent] = spans()
  expect(attribute(agent, 'gen_ai.usage.input_tokens')).toBeUndefined()
  expect(attribute(agent, 'gen_ai.usage.output_tokens')).toBeUndefined()
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

test('a step left open when the turn ends is closed as interrupted', () => {
  const { recorder, spans } = setup()
  const turn = recorder.turn({ seat: 'developer', key: 'turn-4' })
  turn.steps.observe({ type: 'start', id: 'c1', tool: 'Bash', kind: 'running', target: 'sleep', at: 1_000 })
  turn.failed({ errorType: 'crash' })
  const step = spans().find((s) => s.name === 'execute_tool Bash')
  expect(attribute(step, 'error.type')).toBe('interrupted')
})

test('the drain sends the local copy through the shared sender', async () => {
  const { recorder, drained } = setup()
  recorder.turn({ seat: 'developer', key: 'turn-5' }).returned({ outcome: 'done' })
  await recorder.drain()
  expect(drained()).toBe(1)
})

const RESOURCE_KEYS = {
  runnerName: 'vinaya.runner.name',
  runnerVersion: 'vinaya.runner.version',
  cliVersion: 'vinaya.cli.version',
  flowId: 'vinaya.flow.id',
  flowVersion: 'vinaya.flow.version',
  processDigest: 'vinaya.process.digest',
  settingsDigest: 'vinaya.settings.digest'
} as const

const rootWith = (config?: string): string => {
  const root = mkdtempSync(join(tmpdir(), 'vinaya-run-recorder-config-'))
  if (config !== undefined) writeFileSync(join(root, 'vinaya.config.json'), config)
  return root
}

test('every record carries the run identity, with the settings digest hashed from the file bytes', () => {
  const config = '{ "a":1 }\n'
  const { recorder, errors, resources } = setup({ root: rootWith(config), identity: IDENTITY })
  recorder.turn({ seat: 'developer', key: 'turn-0' }).returned({ outcome: 'done' })
  expect(errors).toEqual([])
  const resource = resources()[0]!
  for (const [part, key] of Object.entries(RESOURCE_KEYS)) {
    if (part === 'settingsDigest') continue
    expect(resource[key]).toBe(IDENTITY[part as keyof typeof IDENTITY])
  }
  expect(resource[RESOURCE_KEYS.settingsDigest]).toBe(createHash('sha256').update(config).digest('hex'))
})

test('a reformatted settings file reads as changed, and an absent one writes no settings digest', () => {
  const first = setup({ root: rootWith('{"a":1}'), identity: IDENTITY })
  first.recorder.turn({ seat: 'developer', key: 'turn-0' }).returned()
  const second = setup({ root: rootWith('{ "a": 1 }'), identity: IDENTITY })
  second.recorder.turn({ seat: 'developer', key: 'turn-0' }).returned()
  expect(first.resources()[0]![RESOURCE_KEYS.settingsDigest]).not.toBe(
    second.resources()[0]![RESOURCE_KEYS.settingsDigest]
  )
  const absent = setup({ root: rootWith(), identity: IDENTITY })
  absent.recorder.turn({ seat: 'developer', key: 'turn-0' }).returned()
  const resource = absent.resources()[0]!
  expect(RESOURCE_KEYS.settingsDigest in resource).toBe(false)
  expect(resource[RESOURCE_KEYS.runnerName]).toBe('atta-engine')
})

test('a part whose source is absent is not written', () => {
  const { recorder, resources } = setup({ root: rootWith(), identity: { runnerName: 'standalone' } })
  recorder.turn({ seat: 'developer', key: 'turn-0' }).returned()
  const resource = resources()[0]!
  expect(resource[RESOURCE_KEYS.runnerName]).toBe('standalone')
  for (const key of [
    RESOURCE_KEYS.runnerVersion,
    RESOURCE_KEYS.cliVersion,
    RESOURCE_KEYS.flowId,
    RESOURCE_KEYS.processDigest
  ])
    expect(key in resource).toBe(false)
})

test('a second recorder for the same run in a new process connects with the same parts', () => {
  const root = rootWith('{}')
  const folder = join(mkdtempSync(join(tmpdir(), 'vinaya-run-recorder-shared-')), 'logs')
  const first = setup({ root, identity: IDENTITY, folder })
  first.recorder.turn({ seat: 'developer', key: 'turn-0' }).returned()
  const second = setup({ root, identity: IDENTITY, folder })
  second.recorder.turn({ seat: 'code-reviewer', key: 'turn-1' }).returned()
  const all = second.resources()
  expect(all.length).toBeGreaterThanOrEqual(2)
  expect(new Set(all.map((r) => JSON.stringify(r))).size).toBe(1)
})

test("each agent turn records its effort: the one named, the run's own, else medium", () => {
  const { recorder, spans } = setup()
  recorder.turn({ seat: 'developer', key: 'a' }).returned()
  recorder.bind({ effort: 'high' })
  recorder.turn({ seat: 'developer', key: 'b' }).returned()
  recorder.turn({ seat: 'developer', key: 'c', effort: 'low' }).returned()
  expect(
    spans()
      .map((s) => attribute(s, 'vinaya.agent.effort'))
      .sort()
  ).toEqual(['high', 'low', 'medium'])
})
