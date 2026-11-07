import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogSink, type LogSinkDeps, type LogSinkOverrides } from './log-sink.js'

// The sink names no doctrine layout: the version a header records comes from
// the optional `doctrineIdentity` dependency its builder supplies, asked once
// per sink, and is the package version when no builder supplies one.

const REPO = { owner: 'atta-labs', repo: 'vinaya' }
const VERSION = '0.24.1'

const DISPATCHED = {
  kind: 'dispatch' as const,
  event: 'dispatched' as const,
  payload: {},
  target_role: 'developer' as const,
  model: 'sonnet',
  effect_id: 'e1',
  prompt_hash: 'sha256:abc'
}

function sinkDeps(dir: string, overrides: Partial<LogSinkDeps> = {}): LogSinkOverrides {
  return {
    outboxRoot: () => join(dir, 'outbox'),
    resolveLogDestination: () => ({ kind: 'folder', folder: join(dir, 'outbox') }),
    home: () => dir,
    hostname: () => 'test-host',
    cwd: () => dir,
    now: () => new Date('2026-09-05T00:00:00.000Z'),
    env: () => ({ VINAYA_ROLE: 'developer', VINAYA_TASK: '101' }),
    resolveRepo: () => Promise.resolve(REPO),
    resolveBranchIssue: () => Promise.resolve(null),
    vinayaVersion: () => VERSION,
    stderr: () => {},
    ...overrides
  }
}

function ndjsonUnder(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...ndjsonUnder(full))
    else if (name.endsWith('.ndjson')) out.push(full)
  }
  return out
}

async function doctrineOf(overrides: Partial<LogSinkDeps>): Promise<{ doctrine: unknown[]; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-log-doctrine-identity-'))
  const sink = createLogSink(sinkDeps(dir, overrides))
  sink.log(DISPATCHED)
  sink.log(DISPATCHED)
  await sink.drain()
  const lines = ndjsonUnder(join(dir, 'outbox')).flatMap((file) =>
    readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { meta: { doctrine: unknown } }).meta.doctrine)
  )
  return { doctrine: lines, dir }
}

describe('Log sink — doctrineIdentity', () => {
  it('records what the dependency returns, asked once per sink with the cwd and the package version', async () => {
    const calls: [string, string][] = []
    const { doctrine, dir } = await doctrineOf({
      doctrineIdentity: (cwd, packageVersion) => {
        calls.push([cwd, packageVersion])
        return Promise.resolve('doctrine@abc123')
      }
    })
    try {
      expect(doctrine).toEqual(['doctrine@abc123', 'doctrine@abc123'])
      expect(calls).toEqual([[dir, VERSION]])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('records the package version when no dependency is supplied', async () => {
    const { doctrine, dir } = await doctrineOf({})
    try {
      expect(doctrine).toEqual([VERSION, VERSION])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
