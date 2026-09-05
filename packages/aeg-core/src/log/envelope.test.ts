import { describe, expect, it } from 'vitest'
import { buildHeader, type HeaderInput } from './envelope'

const baseInput: HeaderInput = {
  now: new Date('2026-09-05T00:00:00.000Z'),
  runId: 'run-1',
  seq: 0,
  repo: 'atta-labs/vinaya',
  vinaya: '0.24.1',
  doctrine: 'aeg-root@abc123',
  host: 'cli',
  hostname: 'my-laptop.local',
  env: {}
}

describe('buildHeader', () => {
  it('fills role: unattributed and issue: null with an empty env', () => {
    const { subject } = buildHeader(baseInput)
    expect(subject.role).toBe('unattributed')
    expect(subject.issue).toBeNull()
  })

  it('fills role and issue from VINAYA_ROLE / VINAYA_TASK', () => {
    const { subject } = buildHeader({ ...baseInput, env: { role: 'developer', task: '412' } })
    expect(subject.role).toBe('developer')
    expect(subject.issue).toBe(412)
  })

  it('rejects an unrecognized role — becomes unattributed, never accepted as-is', () => {
    const { subject } = buildHeader({ ...baseInput, env: { role: 'admin' } })
    expect(subject.role).toBe('unattributed')
  })

  it('leaves issue null for an unparseable VINAYA_TASK', () => {
    const { subject } = buildHeader({ ...baseInput, env: { task: 'abc' } })
    expect(subject.issue).toBeNull()
  })

  it('fills meta.schema/ts/run_id/seq/repo/vinaya/doctrine/host from the input', () => {
    const { meta } = buildHeader(baseInput)
    expect(meta).toMatchObject({
      schema: 1,
      ts: '2026-09-05T00:00:00.000Z',
      run_id: 'run-1',
      seq: 0,
      repo: 'atta-labs/vinaya',
      vinaya: '0.24.1',
      doctrine: 'aeg-root@abc123',
      host: 'cli'
    })
  })

  it('hashes the hostname into meta.machine — never the raw name', () => {
    const { meta } = buildHeader(baseInput)
    expect(meta.machine).not.toBe('my-laptop.local')
    expect(meta.machine).toMatch(/^[a-f0-9]{64}$/)
  })

  it('is deterministic: the same hostname always hashes to the same machine id', () => {
    const a = buildHeader(baseInput).meta.machine
    const b = buildHeader({ ...baseInput, hostname: 'my-laptop.local' }).meta.machine
    expect(a).toBe(b)
  })

  it('parses VINAYA_ROUND into subject.round', () => {
    const { subject } = buildHeader({ ...baseInput, env: { round: '2' } })
    expect(subject.round).toBe(2)
  })

  it('an explicit subject override wins over the env-derived defaults', () => {
    const { subject } = buildHeader({ ...baseInput, env: { role: 'developer' }, subject: { pr: 417 } })
    expect(subject.role).toBe('developer')
    expect(subject.pr).toBe(417)
  })
})
