import { expect, spyOn, test } from 'bun:test'
import * as childProcess from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { traceIdFor } from '@attalabs/vinaya-log-sdk'
import { createRunRecorder, githubRepositoryOf, originUrlOf, processRepository } from './run-recorder.js'

const RUN = 'run-recorder'

const IDENTITY = {
  runnerName: 'atta-engine',
  runnerVersion: '4.5.6',
  cliVersion: '0.9.1',
  flowId: 'example-flow',
  flowVersion: 'v2',
  processDigest: 'a'.repeat(64)
}

function setup(
  options: {
    off?: boolean
    root?: string
    identity?: typeof IDENTITY | {}
    folder?: string
    keepDays?: number
    environment?: { role?: string; task?: string }
  } = {}
) {
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-run-recorder-'))
  const folder = options.folder ?? join(dir, 'logs')
  const errors: unknown[] = []
  const sent: unknown[] = []
  let drained = 0
  const recorder = createRunRecorder({
    runId: () => RUN,
    workRef: () => '404',
    repository: () => 'atta-labs/vinaya',
    place: (repository) =>
      options.off
        ? undefined
        : { folder, repository, ...(options.keepDays === undefined ? {} : { keepDays: options.keepDays }) },
    processIdentity: () => ({ name: 'Example', version: '1.2.3' }),
    ...(options.identity === undefined ? {} : { runIdentity: () => options.identity as typeof IDENTITY }),
    sender: () => ({
      request: (place) => void sent.push(place),
      remember: () => {},
      drain: async () => {
        drained += 1
      }
    }),
    environment: () => options.environment ?? {},
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

test('a turn with a cost records it with its kind, and never the reason a cost is missing', () => {
  const { recorder, errors, spans } = setup()
  const turn = recorder.turn({ seat: 'developer', key: 'turn-cost' })
  turn.usage({
    inputTokens: 10,
    outputTokens: 4,
    cost: { amount: 0.25, kind: 'estimated' },
    costUnknownReason: 'not_reported'
  })
  turn.returned({ outcome: 'done' })
  const [agent] = spans()
  expect(errors).toEqual([])
  expect(attribute(agent, 'gen_ai.usage.input_tokens')).toBe(10)
  expect(attribute(agent, 'vinaya.usage.cost')).toBe(0.25)
  expect(attribute(agent, 'vinaya.usage.cost_kind')).toBe('estimated')
  expect(attribute(agent, 'vinaya.usage.cost_unknown_reason')).toBeUndefined()
})

test('a turn with tokens and no cost records the code saying why, and no cost figure', () => {
  const { recorder, errors, spans } = setup()
  const turn = recorder.turn({ seat: 'developer', key: 'turn-no-cost' })
  turn.usage({ inputTokens: 10, outputTokens: 4, costUnknownReason: 'not_reported_by_agent' })
  turn.returned({ outcome: 'done' })
  const [agent] = spans()
  expect(errors).toEqual([])
  expect(attribute(agent, 'gen_ai.usage.output_tokens')).toBe(4)
  expect(attribute(agent, 'vinaya.usage.cost_unknown_reason')).toBe('not_reported_by_agent')
  expect(attribute(agent, 'vinaya.usage.cost')).toBeUndefined()
  expect(attribute(agent, 'vinaya.usage.cost_kind')).toBeUndefined()
})

test('a turn whose usage is not known records neither a cost nor a cost reason', () => {
  const { recorder, errors, spans } = setup()
  const turn = recorder.turn({ seat: 'developer', key: 'turn-unobserved' })
  turn.usage({ unknownReason: 'the stream carried no usage', costUnknownReason: 'not_reported' })
  turn.returned({ outcome: 'done' })
  const [agent] = spans()
  expect(errors).toEqual([])
  expect(attribute(agent, 'vinaya.usage.cost_unknown_reason')).toBeUndefined()
  expect(attribute(agent, 'vinaya.usage.cost')).toBeUndefined()
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

/** Plants a traces file last written `days` days ago in a recorder's repository folder; returns its path. */
function plantOld(folder: string, name: string, days: number): string {
  const directory = join(folder, 'atta-labs-vinaya')
  mkdirSync(directory, { recursive: true })
  const path = join(directory, name)
  writeFileSync(path, '{}\n')
  const when = new Date(Date.now() - days * 86_400_000)
  utimesSync(path, when, when)
  return path
}

test('the run handle cleans the local copy with the window the place carries', () => {
  const configured = setup({ keepDays: 5 })
  const old = plantOld(configured.folder, 'past~w1~000000000000.traces.jsonl', 10)
  configured.recorder.turn({ seat: 'developer', key: 'turn-0' }).returned()
  expect(existsSync(old)).toBe(false)
  expect(configured.errors).toEqual([])
})

test('a place that carries no window cleans with the default of 90 days', () => {
  const plain = setup()
  const tenDays = plantOld(plain.folder, 'ten~w1~000000000000.traces.jsonl', 10)
  const longAgo = plantOld(plain.folder, 'long~w1~000000000000.traces.jsonl', 120)
  plain.recorder.turn({ seat: 'developer', key: 'turn-0' }).returned()
  expect(existsSync(tenDays)).toBe(true)
  expect(existsSync(longAgo)).toBe(false)
})

/** The trust and provenance the first agent span's resource and attributes carry. */
function trustOf(setupResult: ReturnType<typeof setup>): { trust: unknown; provenance: unknown } {
  const [resource] = setupResult.resources()
  const [span] = setupResult.spans()
  return {
    trust: resource?.['vinaya.trust'] ?? attribute(span, 'vinaya.trust'),
    provenance: resource?.['vinaya.provenance'] ?? attribute(span, 'vinaya.provenance')
  }
}

test('a launching process writes parent_attributed, one with a role or task in its environment env_correlated, a bare one unavailable; provenance stays governed', () => {
  const launched = setup({ environment: {} })
  launched.recorder.launching()
  launched.recorder.turn({ seat: 'developer', key: 'l' }).returned()
  expect(trustOf(launched)).toEqual({ trust: 'parent_attributed', provenance: 'governed' })

  const byRole = setup({ environment: { role: 'developer' } })
  byRole.recorder.turn({ seat: 'developer', key: 'r' }).returned()
  expect(trustOf(byRole)).toEqual({ trust: 'env_correlated', provenance: 'governed' })

  const byTask = setup({ environment: { task: '404' } })
  byTask.recorder.turn({ seat: 'developer', key: 't' }).returned()
  expect(trustOf(byTask)).toEqual({ trust: 'env_correlated', provenance: 'governed' })

  const bare = setup({ environment: {} })
  bare.recorder.turn({ seat: 'developer', key: 'b' }).returned()
  expect(trustOf(bare)).toEqual({ trust: 'unavailable', provenance: 'governed' })
})

/** A checkout whose git config names `origin` at `url` (none when `url` is null), as a directory or a linked worktree. */
function checkout(url: string | null, shape: 'directory' | 'worktree' = 'directory'): string {
  const root = mkdtempSync(join(tmpdir(), 'vinaya-run-recorder-checkout-'))
  const config = `[core]\n\tbare = false\n${url === null ? '' : `[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`}`
  const main = join(root, 'main')
  mkdirSync(join(main, '.git', 'worktrees', 'task'), { recursive: true })
  writeFileSync(join(main, '.git', 'config'), config)
  if (shape === 'directory') return main
  const worktree = join(root, 'task')
  mkdirSync(join(worktree, 'nested'), { recursive: true })
  writeFileSync(join(worktree, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'task')}\n`)
  writeFileSync(join(main, '.git', 'worktrees', 'task', 'commondir'), '../..\n')
  return join(worktree, 'nested')
}

/** A recorder whose default repository is the process's own rule, over `cwd`'s checkout, with every file read counted. */
function recorderIn(cwd: string, env: NodeJS.ProcessEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-run-recorder-'))
  const folder = join(dir, 'logs')
  const configReads: string[] = []
  const repository = processRepository({
    env: () => env,
    cwd: () => cwd,
    reader: {
      exists: existsSync,
      readText: (path) => {
        if (path.endsWith('config')) configReads.push(path)
        return readFileSync(path, 'utf8')
      },
      realpath: realpathSync
    }
  })
  const errors: unknown[] = []
  const recorder = createRunRecorder({
    runId: () => RUN,
    workRef: () => undefined,
    repository,
    place: (repo) => ({ folder, repository: repo }),
    processIdentity: () => undefined,
    sender: () => ({ request: () => {}, remember: () => {}, drain: async () => {} }),
    environment: () => ({}),
    home: () => dir,
    cwd: () => cwd,
    onError: (e) => errors.push(e)
  })
  return { recorder, folder, configReads, errors, repository }
}

test("a record from a process given no repository lands in the git remote's repository folder", () => {
  for (const [url, shape] of [
    ['git@github.com:acme/widgets.git', 'directory'],
    ['https://github.com/acme/widgets.git', 'worktree'],
    ['ssh://git@github.com/acme/widgets', 'directory']
  ] as const) {
    const { recorder, folder, errors } = recorderIn(checkout(url, shape))
    recorder.turn({ seat: 'developer', key: 'remote' }).returned()
    expect(errors).toEqual([])
    expect(readdirSync(folder)).toEqual(['acme-widgets'])
  }
})

test('the environment’s VINAYA_REPO wins over the remote, and with no GitHub origin the record stays unresolved', () => {
  const named = recorderIn(checkout('git@github.com:acme/widgets.git'), { VINAYA_REPO: 'atta-labs/vinaya' })
  named.recorder.turn({ seat: 'developer', key: 'named' }).returned()
  expect(readdirSync(named.folder)).toEqual(['atta-labs-vinaya'])
  expect(named.configReads).toEqual([])

  for (const url of [null, 'https://gitlab.com/acme/widgets.git', '/srv/git/widgets.git']) {
    const { recorder, folder, repository } = recorderIn(checkout(url))
    expect(repository()).toBeUndefined()
    recorder.turn({ seat: 'developer', key: 'none' }).returned()
    expect(readdirSync(folder)).toEqual(['unresolved'])
  }
  const outside = recorderIn(mkdtempSync(join(tmpdir(), 'vinaya-run-recorder-no-checkout-')))
  expect(outside.repository()).toBeUndefined()
})

test('many handle opens read the git config once and spawn no process', () => {
  const spawns = [
    spyOn(childProcess, 'execFileSync'),
    spyOn(childProcess, 'execSync'),
    spyOn(childProcess, 'spawnSync'),
    spyOn(childProcess, 'spawn'),
    spyOn(childProcess, 'execFile'),
    spyOn(childProcess, 'exec')
  ]
  try {
    const { recorder, folder, configReads } = recorderIn(checkout('git@github.com:acme/widgets.git', 'worktree'))
    for (let n = 0; n < 25; n += 1) {
      recorder.turn({ seat: 'developer', key: `turn-${n}` }).returned()
      recorder.stageChanged({ stage: 'review', round: n })
      recorder.handle()
    }
    expect(readdirSync(folder)).toEqual(['acme-widgets'])
    expect(configReads).toHaveLength(1)
    for (const spawn of spawns) expect(spawn).not.toHaveBeenCalled()
  } finally {
    for (const spawn of spawns) spawn.mockRestore()
  }
})

test('the origin URL and the GitHub repository are read from the shapes git writes', () => {
  expect(
    originUrlOf(
      '[remote "upstream"]\n\turl = git@github.com:other/x.git\n[remote "origin"]\n\turl = git@github.com:acme/widgets.git\n'
    )
  ).toBe('git@github.com:acme/widgets.git')
  expect(originUrlOf('[core]\n\tbare = false\n')).toBeUndefined()
  expect(githubRepositoryOf('git@github.com:acme/widgets.git')).toBe('acme/widgets')
  expect(githubRepositoryOf('https://token@github.com/acme/widgets/')).toBe('acme/widgets')
  expect(githubRepositoryOf('https://github.com/acme/widgets/tree/main')).toBeUndefined()
  expect(githubRepositoryOf('git@gitlab.com:acme/widgets.git')).toBeUndefined()
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
