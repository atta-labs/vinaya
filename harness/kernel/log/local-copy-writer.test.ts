import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as localCopyWriter from './local-copy-writer.js'
import { createLogSink, type LogSinkOverrides } from './log-sink.js'
import { registerRole, restoreRoleRegistry, type RoleRegistrySnapshot, saveRoleRegistry } from './roles.js'

let saved: RoleRegistrySnapshot
beforeAll(() => {
  saved = saveRoleRegistry()
  registerRole('developer', { reading: 'developer', title: 'Developer', reviews: false })
})
afterAll(() => restoreRoleRegistry(saved))

const tmp = (): string => mkdtempSync(join(tmpdir(), 'vinaya-local-copy-'))

describe('the local copy has no converted earlier-format writer', () => {
  test('the module keeps the sender and the folder rule, and exports no writer of converted events', () => {
    expect(typeof localCopyWriter.createLocalCopySender).toBe('function')
    expect(typeof localCopyWriter.resolveLocalCopyFolder).toBe('function')
    expect('createLocalCopyWriter' in localCopyWriter).toBe(false)
  })
})

describe('the sink writes the earlier format only', () => {
  const deps = (dir: string, destination: any, extra: Partial<LogSinkOverrides> = {}): LogSinkOverrides => ({
    outboxRoot: () => join(dir, 'outbox'),
    resolveLogDestination: () => destination,
    unresolvedLogDestination: () => destination,
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
    runId: 'run-sink',
    ...extra
  })
  const event = {
    kind: 'dispatch' as const,
    event: 'dispatched' as const,
    payload: {},
    target_role: 'developer' as const,
    model: 'sonnet',
    effect_id: 'e1',
    prompt_hash: 'sha256:abc'
  }
  const copyFolder = (dir: string) => join(dir, '.vinaya', 'runtime', 'atta-labs-vinaya', 'logs')

  test("a folder destination keeps today's line and writes no converted copy", async () => {
    const dir = tmp()
    const sink = createLogSink(deps(dir, { kind: 'folder', folder: join(dir, 'out') }))
    sink.log(event)
    await sink.drain()
    const today = JSON.parse(readFileSync(join(dir, 'out', 'atta-labs-vinaya', '404.ndjson'), 'utf8').trim())
    expect(today.meta.run_id).toBe('run-sink')
    expect(readdirSync(join(dir, 'out', 'atta-labs-vinaya'))).toEqual(['404.ndjson'])
    expect(existsSync(copyFolder(dir))).toBe(false)
  })

  test("a server destination keeps today's line in the retry queue and writes no converted copy", async () => {
    const dir = tmp()
    const sink = createLogSink(deps(dir, { kind: 'server', url: 'http://127.0.0.1:9/ingest' }))
    sink.log(event)
    await sink.drain()
    expect(
      readFileSync(join(dir, 'outbox', 'atta-labs-vinaya', '404.ndjson'), 'utf8')
        .trim()
        .split('\n')
    ).toHaveLength(1)
    expect(existsSync(copyFolder(dir))).toBe(false)
  })

  test('recording off writes nothing', async () => {
    const dir = tmp()
    mkdirSync(join(dir, 'out'), { recursive: true })
    const sink = createLogSink(deps(dir, { kind: 'none', reason: 'off' }))
    sink.log(event)
    sink.logSync(event)
    await sink.drain()
    expect(readdirSync(join(dir, 'out'))).toEqual([])
    expect(existsSync(copyFolder(dir))).toBe(false)
  })
})
