import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
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
    ...extra
  })
  const inside = (root: string): string[] =>
    readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? inside(join(root, entry.name)).map((n) => join(entry.name, n)) : [entry.name]
    )
  const todayIds = (): string[] =>
    inside(folder)
      .filter((n) => n.endsWith('.ndjson'))
      .flatMap((name) =>
        readFileSync(join(folder, name), 'utf8')
          .trim()
          .split('\n')
          .map((line) => recordIdentity(JSON.parse(line)) as string)
      )
  const copyExists = (): boolean => existsSync(join(dir, '.vinaya', 'runtime', 'atta-labs-vinaya', 'logs'))
  return { sink, todayIds, copyExists }
}

test("an address that never answers does not delay today's line, and the sink writes no converted copy", async () => {
  const { sink, todayIds, copyExists } = setup()
  sink.log(event('e1'))
  await new Promise((resolve) => setTimeout(resolve, 150))
  expect(todayIds()).toHaveLength(1)
  expect(copyExists()).toBe(false)
  await sink.drain()
})

test("a logSync event is in today's file when it returns, with no converted copy", () => {
  const { sink, todayIds, copyExists } = setup()
  sink.logSync(event('e1'))
  expect(todayIds()).toHaveLength(1)
  expect(copyExists()).toBe(false)
})

test('after a mix of log and logSync the drain returns promptly and every line is there', async () => {
  const { sink, todayIds } = setup()
  sink.warmup()
  await new Promise((resolve) => setTimeout(resolve, 150))
  sink.log(event('a'))
  sink.logSync(event('b'))
  sink.log(event('c'))
  sink.logSync(event('d'))
  const started = Date.now()
  await sink.drain()
  expect(Date.now() - started).toBeLessThan(1_500)
  expect(todayIds()).toHaveLength(4)
})

test('the Log description states the bound the drain keeps', () => {
  const description = readFileSync(new URL('./log.md', import.meta.url), 'utf8')
  expect(LOCAL_COPY_SEND_BOUND_MS).toBe(3_000)
  expect(description).toContain('no longer than 3 seconds')
})
