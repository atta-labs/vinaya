import { describe, expect, it } from 'vitest'
import { buildHeader, type HeaderInput } from './envelope'
import { HeaderMetaSchema, processAndRunnerOf, type HeaderMetaV4 } from './schema'

const input: HeaderInput = {
  now: new Date('2026-09-05T00:00:00.000Z'),
  runId: 'run',
  seq: 0,
  repo: null,
  vinaya: 'test',
  doctrine: 'test',
  host: 'cli',
  hostname: 'test',
  env: {},
  eventId: 'event',
  processId: 'instance'
}
const storedV3 = {
  schema: 3,
  ts: '2026-09-05T00:00:00.000Z',
  run_id: 'stored-run',
  seq: 0,
  repo: null,
  vinaya: 'test',
  doctrine: 'test',
  host: 'cli',
  machine: 'hash',
  event_id: 'stored-event',
  process_id: 'instance',
  actor_id: null,
  lineage: { run: null, attempt: null, parent: null },
  input_versions: { objectives_version: null, brief_hash: null, ruling_ordinal: null, policy_digest: null },
  provenance: 'unavailable',
  work: { ref: null, repo: null, change: null, revision: null },
  flow: { id: 'vinaya', version: null },
  runtime: null,
  source: null
}
const defaults: Pick<HeaderMetaV4, 'process' | 'runner'> = {
  process: { id: 'vinaya', version: null, digest: null },
  runner: { id: 'standalone', version: null }
}

describe('processAndRunnerOf', () => {
  const rows: { name: string; env: HeaderInput['env']; stored?: typeof storedV3; expected: typeof defaults }[] = [
    { name: 'standalone defaults', env: {}, expected: defaults },
    {
      name: 'Vinaya on Engine',
      env: { processVersion: '1', processDigest: 'digest', runnerId: 'atta-engine', runnerVersion: '2' },
      expected: {
        process: { id: 'vinaya', version: '1', digest: 'digest' },
        runner: { id: 'atta-engine', version: '2' }
      }
    },
    {
      name: 'another process on Engine',
      env: { processId: 'acme', runnerId: 'atta-engine' },
      expected: { process: { id: 'acme', version: null, digest: null }, runner: { id: 'atta-engine', version: null } }
    },
    {
      name: 'third-party runner',
      env: { runnerId: 'acme-runner' },
      expected: { process: defaults.process, runner: { id: 'acme-runner', version: null } }
    },
    { name: 'stored schema 3', env: {}, stored: storedV3, expected: defaults }
  ]
  it.each(rows)('$name', ({ env, stored, expected }) => {
    const meta = HeaderMetaSchema.parse(stored ?? buildHeader({ ...input, env }).meta)
    expect(processAndRunnerOf(meta)).toEqual(expected)
  })
})
