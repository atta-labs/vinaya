import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOCAL_COPY_SEND_BOUND_MS } from './local-copy-writer.js'
import { createLogSink, type LogSinkOverrides } from './log-sink.js'
import { registerRole, restoreRoleRegistry, type RoleRegistrySnapshot, saveRoleRegistry } from './roles.js'
import { recordIdentity } from './store.js'

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

const never = (): Promise<Response> => new Promise(() => {})

function setup(extra: Partial<LogSinkOverrides> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-local-copy-exit-'))
  const folder = join(dir, 'out')
  const sink = createLogSink({
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
    runId: 'run-exit',
    otlp: {
      address: () => ({ kind: 'address', url: 'http://collector.invalid' }),
      fetch: never,
      sendBoundMs: 300
    },
    ...extra
  })
  const inside = (root: string): string[] =>
    readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? inside(join(root, entry.name)).map((n) => join(entry.name, n)) : [entry.name]
    )
  const copy = join(dir, '.vinaya', 'runtime')
  const todayIds = (): string[] =>
    inside(folder)
      .filter((n) => n.endsWith('.ndjson'))
      .flatMap((name) =>
        readFileSync(join(folder, name), 'utf8')
          .trim()
          .split('\n')
          .map((line) => recordIdentity(JSON.parse(line)) as string)
      )
  const copyIds = (): string[] => {
    let names: string[] = []
    try {
      names = inside(copy)
        .filter((n) => n.includes('run-exit~') && n.endsWith('.logs.jsonl'))
        .sort((a, b) => (a.split('/').at(-1) as string).localeCompare(b.split('/').at(-1) as string))
    } catch {}
    return names.flatMap((name) =>
      readFileSync(join(copy, name), 'utf8')
        .trim()
        .split('\n')
        .map((line) => {
          const record = JSON.parse(line).resourceLogs[0].scopeLogs[0].logRecords[0]
          return record.attributes.find((a: any) => a.key === 'vinaya.event.id').value.stringValue as string
        })
    )
  }
  return { sink, todayIds, copyIds }
}

test("an address that never answers neither delays today's line nor the local copy", async () => {
  const { sink, todayIds, copyIds } = setup()
  sink.log(event('e1'))
  await new Promise((resolve) => setTimeout(resolve, 150))
  expect(todayIds()).toHaveLength(1)
  expect(copyIds()).toHaveLength(1)
  await sink.drain()
})

test('a logSync event of a run the process has not seen is in the local copy when it returns', () => {
  const { sink, todayIds, copyIds } = setup()
  sink.logSync(event('e1'))
  expect(todayIds()).toHaveLength(1)
  expect(copyIds()).toHaveLength(1)
})

test('after a mix of log and logSync the drain waits no longer than the bound and every record is there in write order', async () => {
  const { sink, todayIds, copyIds } = setup()
  sink.warmup()
  await new Promise((resolve) => setTimeout(resolve, 150))
  sink.log(event('a'))
  sink.logSync(event('b'))
  sink.log(event('c'))
  sink.logSync(event('d'))
  const started = Date.now()
  await sink.drain()
  // The sender's own deadline and the drain's bound are both 300 ms here.
  expect(Date.now() - started).toBeLessThan(1_500)
  expect(copyIds()).toEqual(todayIds())
  expect(copyIds()).toHaveLength(4)
})

test('the Log description states the bound the drain keeps', () => {
  const description = readFileSync(new URL('./log.md', import.meta.url), 'utf8')
  expect(LOCAL_COPY_SEND_BOUND_MS).toBe(3_000)
  expect(description).toContain('no longer than 3 seconds')
})
