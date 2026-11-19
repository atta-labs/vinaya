import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogSink, type LogSinkOverrides } from './log-sink.js'
import { resolveOtlpAddress } from './otlp-address.js'
import { registerRole, restoreRoleRegistry, type RoleRegistrySnapshot, saveRoleRegistry } from './roles.js'

let saved: RoleRegistrySnapshot
beforeAll(() => {
  saved = saveRoleRegistry()
  registerRole('developer', { reading: 'developer', title: 'Developer', reviews: false })
})
afterAll(() => restoreRoleRegistry(saved))

const event = (id: string) => ({
  kind: 'dispatch' as const,
  event: 'dispatched' as const,
  payload: {},
  target_role: 'developer' as const,
  model: 'sonnet',
  effect_id: id,
  prompt_hash: 'sha256:abc'
})

type Call = { url: string; body: string }
const receiver = () => {
  const calls: Call[] = []
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, body: String(init.body) })
    return new Response(null, { status: 200 })
  }
  return { calls, fetch }
}

const until = async (done: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 20))
}

function sinkIn(
  dir: string,
  runId: string,
  otlp: NonNullable<LogSinkOverrides['otlp']>
): ReturnType<typeof createLogSink> {
  const folder = join(dir, 'out')
  return createLogSink({
    outboxRoot: () => join(dir, 'outbox'),
    resolveLogDestination: () => ({ kind: 'folder', folder }),
    unresolvedLogDestination: () => ({ kind: 'folder', folder }),
    readConfig: () => null,
    home: () => dir,
    hostname: () => 'test-host',
    cwd: () => dir,
    now: () => new Date('2026-09-05T00:00:00.000Z'),
    env: () => ({ VINAYA_ROLE: 'developer', VINAYA_TASK: '404' }),
    resolveRepo: () => Promise.resolve({ owner: 'atta-labs', repo: 'vinaya' }),
    resolveBranchIssue: () => Promise.resolve(null),
    vinayaVersion: () => '0.0.0',
    stderr: () => {},
    runId,
    otlp: { sendIntervalMs: 0, sendBoundMs: 2_000, ...otlp }
  })
}

const tmp = (): string => mkdtempSync(join(tmpdir(), 'vinaya-local-copy-sending-'))

test('with an address resolved the local copy reaches the receiver with no manual command', async () => {
  const { calls, fetch } = receiver()
  const sink = sinkIn(tmp(), 'run-send', {
    address: () => ({ kind: 'address', url: 'http://collector.invalid/base' }),
    fetch
  })
  sink.log(event('e1'))
  await until(() => calls.length > 0)
  expect(calls.length).toBeGreaterThan(0)
  expect(calls.every((c) => c.url.startsWith('http://collector.invalid/base/v1/'))).toBe(true)
  expect(calls.some((c) => c.body.includes('run-send') || c.body.includes('resourceLogs'))).toBe(true)
})

test('a logs.url alone sends nothing', async () => {
  const { calls, fetch } = receiver()
  const sink = sinkIn(tmp(), 'run-url', {
    address: () =>
      resolveOtlpAddress({
        localConfig: { logs: { url: 'http://log-server.invalid' } },
        trustAnchorConfig: null,
        unattended: false,
        env: {}
      }),
    fetch
  })
  sink.log(event('e1'))
  await sink.drain()
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(calls).toEqual([])
})

test('records a process left unsent reach the receiver through a later process of the repository', async () => {
  const dir = tmp()
  // The first process: the address does not answer, and the process exits at its drain.
  const refused = async (): Promise<Response> => {
    throw new Error('no answer')
  }
  const first = sinkIn(dir, 'run-left', {
    address: () => ({ kind: 'address', url: 'http://collector.invalid' }),
    fetch: refused,
    sendBoundMs: 300
  })
  first.log(event('left-1'))
  await first.drain()
  // A later process, of another run, records any event with the address answering.
  const { calls, fetch } = receiver()
  const later = sinkIn(dir, 'run-later', {
    address: () => ({ kind: 'address', url: 'http://collector.invalid' }),
    fetch
  })
  later.log(event('later-1'))
  await until(() => calls.some((c) => c.body.includes('left-1')) && calls.some((c) => c.body.includes('later-1')))
  expect(calls.some((c) => c.body.includes('left-1'))).toBe(true)
  expect(calls.some((c) => c.body.includes('later-1'))).toBe(true)
})
