/**
 * The process's Log sink factory (`integration/log/log-sink-factory.ts`):
 * what it supplies a sink beyond the sink's own defaults — the Vinaya branch
 * reader, shared across the process — what it leaves to a caller that brings
 * its own reader, and the default-sink installation an entry point makes.
 * The real branch read itself is held by `branch-issue.test.ts` beside this file.
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSyncBudgeted, stripVinayaEnv } from '../../../../../../apps/cli/tests/lib/process-fixture.js'
import { createVinayaLogSink, resolveVinayaLogAppendPath } from '../../../integration/log/log-sink-factory.js'

const DISPATCHED = {
  kind: 'dispatch' as const,
  event: 'dispatched' as const,
  payload: {},
  target_role: 'developer' as const,
  model: 'sonnet',
  effect_id: 'e1',
  prompt_hash: 'sha256:abc'
}

// The overrides the factory takes, named through the factory itself rather than the Log client.
type SinkOverrides = NonNullable<Parameters<typeof createVinayaLogSink>[0]>

function fixedDeps(dir: string): SinkOverrides {
  return {
    outboxRoot: () => join(dir, 'outbox'),
    resolveLogDestination: () => ({ kind: 'folder', folder: join(dir, 'outbox') }),
    home: () => dir,
    hostname: () => 'test-host',
    cwd: () => dir,
    now: () => new Date('2026-11-01T00:00:00.000Z'),
    env: () => ({}),
    resolveRepo: () => Promise.resolve({ owner: 'atta-labs', repo: 'vinaya' }),
    vinayaVersion: () => '0.0.0-test',
    stderr: () => {}
  }
}

describe('the process Log sink factory', () => {
  it("keeps a caller's own branch reader, asks it once per sink, and shares its answer with no other sink", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vinaya-factory-own-reader-')))
    const asked: string[] = []
    const sinkWith = (name: string, issue: number) =>
      createVinayaLogSink({
        ...fixedDeps(dir),
        resolveBranchIssue: (repo) => {
          asked.push(`${name} ${repo}`)
          return Promise.resolve(issue)
        }
      })
    const first = sinkWith('first', 792)
    const second = sinkWith('second', 905)
    first.log(DISPATCHED)
    first.log(DISPATCHED)
    second.log(DISPATCHED)
    await Promise.all([first.drain(), second.drain()])
    expect(asked.sort()).toEqual(['first atta-labs/vinaya', 'second atta-labs/vinaya'])
    expect(readdirSync(join(dir, 'outbox', 'atta-labs-vinaya')).sort()).toEqual(['792.ndjson', '905.ndjson'])
  })

  it('names the same file for a polling caller as the sink with the same reader writes', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vinaya-factory-append-path-')))
    const deps = { ...fixedDeps(dir), resolveBranchIssue: () => Promise.resolve(792) }
    const sink = createVinayaLogSink(deps)
    sink.log(DISPATCHED)
    await sink.drain()
    const polled = await resolveVinayaLogAppendPath({ owner: 'atta-labs', repo: 'vinaya' }, null, deps)
    expect(polled).toBe(join(dir, 'outbox', 'atta-labs-vinaya', '792.ndjson'))
    expect(readdirSync(join(dir, 'outbox', 'atta-labs-vinaya'))).toEqual(['792.ndjson'])
  })

  it('installed by an entry point, it is the factory the bare log() builds its sink from', () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'vinaya-factory-install-')))
    const factory = join(import.meta.dir, '..', '..', '..', 'integration', 'log', 'log-sink-factory.ts')
    const logSink = join(
      import.meta.dir,
      '..',
      '..',
      '..',
      '..',
      '..',
      '..',
      'apps',
      'cli',
      'src',
      'lib',
      'log-sink.ts'
    )
    const probe = join(scratch, 'probe.ts')
    writeFileSync(
      probe,
      `import { installVinayaLogSinkFactory } from ${JSON.stringify(factory)}\n` +
        `import { drainLogSink, log } from ${JSON.stringify(logSink)}\n` +
        'installVinayaLogSinkFactory()\n' +
        `log(${JSON.stringify({ ...DISPATCHED, effect_id: 'installed-factory' })})\n` +
        'await drainLogSink()\n'
    )
    const run = spawnSyncBudgeted(
      'bun',
      [probe],
      {
        cwd: scratch,
        encoding: 'utf8',
        env: {
          ...stripVinayaEnv(),
          HOME: scratch,
          AEG_REPO: 'example/example',
          VINAYA_TASK: '404',
          VINAYA_RUNTIME_DIR: join(scratch, 'runtime')
        }
      },
      20_000,
      'installed-factory probe'
    )
    expect(run.status, run.stderr).toBe(0)
    const landed = readdirSync(join(scratch, 'runtime'), { recursive: true, encoding: 'utf8' }).filter((f) =>
      f.endsWith('404.ndjson')
    )
    expect(landed).toHaveLength(1)
  }, 30_000)
})
