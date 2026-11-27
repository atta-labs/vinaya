import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  installConfigProvider,
  type ProvidedConfig,
  uninstallConfigProvider
} from '../config/loader/config-provider.js'
import * as localCopyWriter from './local-copy-writer.js'
import {
  createLogSink,
  type LogSinkOverrides,
  processLocalCopyPlace,
  resetTrustAnchorConfigMemo,
  resolveProcessOtlpAddress
} from './log-sink.js'
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

describe('the keep window beside the local copy folder', () => {
  test("a repository's window is read from its settings, and an unattended or handed-directory process keeps the default", () => {
    const cwd = tmp()
    writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify({ logs: { keepDays: 12 } }))
    const base = { home: tmp(), cwd, handedRuntimeDir: undefined, unattended: false }
    expect(localCopyWriter.resolveLocalCopySettings(base, 'a/b')?.keepDays).toBe(12)
    expect(localCopyWriter.resolveLocalCopySettings({ ...base, unattended: true }, 'a/b')?.keepDays).toBe(90)
    expect(localCopyWriter.resolveLocalCopySettings({ ...base, handedRuntimeDir: tmp() }, 'a/b')?.keepDays).toBe(90)
  })
})

describe('recording off gives every process no local copy', () => {
  const settingsAt = (settings: unknown): string => {
    const cwd = tmp()
    writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify(settings))
    return cwd
  }

  test('with recording off, a handed runtime directory and an unattended process both get no place', () => {
    const off = { home: tmp(), cwd: settingsAt({ logs: false }), handedRuntimeDir: undefined, unattended: false }
    expect(localCopyWriter.resolveLocalCopySettings(off, 'a/b')).toBeUndefined()
    expect(localCopyWriter.resolveLocalCopySettings({ ...off, handedRuntimeDir: tmp() }, 'a/b')).toBeUndefined()
    const branchOff = () => ({ logs: false })
    expect(
      localCopyWriter.resolveLocalCopySettings({ ...off, unattended: true, defaultBranchLogs: branchOff }, 'a/b')
    ).toBeUndefined()
    expect(
      localCopyWriter.resolveLocalCopySettings(
        { ...off, unattended: true, handedRuntimeDir: tmp(), defaultBranchLogs: branchOff },
        'a/b'
      )
    ).toBeUndefined()
  })

  test('an unattended process whose default branch turns recording off gets none while its working tree says on', () => {
    const on = { home: tmp(), cwd: settingsAt({ logs: { keepDays: 12 } }), handedRuntimeDir: undefined }
    expect(localCopyWriter.resolveLocalCopySettings({ ...on, unattended: false }, 'a/b')?.folder).toBeDefined()
    expect(
      localCopyWriter.resolveLocalCopySettings(
        { ...on, unattended: true, defaultBranchLogs: () => ({ logs: false }) },
        'a/b'
      )
    ).toBeUndefined()
  })

  test('an unattended process follows the address rule: its working tree or its default branch turns recording off, and unreadable settings leave it on', () => {
    const home = tmp()
    const defaultFolder = join(home, '.vinaya', 'runtime', 'a-b', 'logs')
    // As the OpenTelemetry address: a working tree's `logs: false` turns an unattended process's recording off too.
    const treeOff = { home, cwd: settingsAt({ logs: false }), handedRuntimeDir: undefined, unattended: true }
    expect(
      localCopyWriter.resolveLocalCopySettings({ ...treeOff, defaultBranchLogs: () => ({}) }, 'a/b')
    ).toBeUndefined()
    // A default branch whose settings cannot be read keeps the default folder, as before.
    const treeOn = { ...treeOff, cwd: settingsAt({}) }
    expect(localCopyWriter.resolveLocalCopySettings({ ...treeOn, defaultBranchLogs: () => null }, 'a/b')?.folder).toBe(
      defaultFolder
    )
    expect(localCopyWriter.resolveLocalCopySettings({ ...treeOn, defaultBranchLogs: () => ({}) }, 'a/b')?.folder).toBe(
      defaultFolder
    )
    expect(localCopyWriter.resolveLocalCopySettings(treeOn, 'a/b')?.folder).toBe(defaultFolder)
  })

  test('an attended process never reads the default branch for its off switch', () => {
    let reads = 0
    const defaultBranchLogs = () => {
      reads += 1
      return { logs: false }
    }
    const on = { home: tmp(), cwd: settingsAt({}), handedRuntimeDir: undefined, unattended: false, defaultBranchLogs }
    expect(localCopyWriter.resolveLocalCopySettings(on, 'a/b')).toBeDefined()
    expect(localCopyWriter.resolveLocalCopySettings({ ...on, handedRuntimeDir: tmp() }, 'a/b')).toBeDefined()
    expect(reads).toBe(0)
  })

  test("the process's own place reads the default branch once, synchronously, and obeys its off switch", () => {
    const previous = uninstallConfigProvider()
    const role = process.env.VINAYA_ROLE
    let reads = 0
    let quiet: boolean | undefined
    installConfigProvider({
      homeDir: tmp(),
      loadConfig: () => null,
      loadTrustAnchorConfig: (options) => {
        reads += 1
        quiet = options?.quiet
        return { logs: false } as ProvidedConfig
      },
      loadTrustAnchorConfigAsync: async () => null
    })
    resetTrustAnchorConfigMemo()
    try {
      process.env.VINAYA_ROLE = 'developer'
      expect(processLocalCopyPlace('a/b')).toBeUndefined()
      expect(processLocalCopyPlace('a/b')).toBeUndefined()
      expect(reads).toBe(1)
      expect(quiet).toBe(true)
    } finally {
      if (role === undefined) delete process.env.VINAYA_ROLE
      else process.env.VINAYA_ROLE = role
      resetTrustAnchorConfigMemo()
      uninstallConfigProvider()
      if (previous !== null) installConfigProvider(previous)
    }
  })
})

test("the local copy's synchronous default-branch read never stands in for the address's own read", async () => {
  const previous = uninstallConfigProvider()
  const role = process.env.VINAYA_ROLE
  installConfigProvider({
    homeDir: tmp(),
    loadConfig: () => null,
    loadTrustAnchorConfig: () => ({ logs: { otlp: { url: 'https://sync.example' } } }) as ProvidedConfig,
    loadTrustAnchorConfigAsync: async () => null
  })
  resetTrustAnchorConfigMemo()
  try {
    process.env.VINAYA_ROLE = 'developer'
    expect(processLocalCopyPlace('a/b')).toBeDefined()
    expect(await resolveProcessOtlpAddress({ readConfig: () => null, env: () => ({}) })).toEqual({
      kind: 'none',
      reason: 'default branch settings unavailable'
    })
  } finally {
    if (role === undefined) delete process.env.VINAYA_ROLE
    else process.env.VINAYA_ROLE = role
    resetTrustAnchorConfigMemo()
    uninstallConfigProvider()
    if (previous !== null) installConfigProvider(previous)
  }
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
