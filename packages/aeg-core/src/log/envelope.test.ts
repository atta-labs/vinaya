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
  env: {},
  eventId: 'event-1',
  processId: 'process-1'
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
      schema: 2,
      ts: '2026-09-05T00:00:00.000Z',
      run_id: 'run-1',
      seq: 0,
      repo: 'atta-labs/vinaya',
      vinaya: '0.24.1',
      doctrine: 'aeg-root@abc123',
      host: 'cli'
    })
  })

  it('builds schema: 2 — event_id/process_id passed through, lineage/input_versions/provenance default to unavailable-not-invented', () => {
    const { meta } = buildHeader(baseInput)
    if (meta.schema !== 2) throw new Error('expected schema 2')
    expect(meta.event_id).toBe('event-1')
    expect(meta.process_id).toBe('process-1')
    expect(meta.actor_id).toBeNull()
    expect(meta.lineage).toEqual({ run: null, attempt: null, parent: null })
    expect(meta.input_versions).toEqual({
      objectives_version: null,
      brief_hash: null,
      ruling_ordinal: null,
      policy_digest: null
    })
    expect(meta.provenance).toBe('unavailable')
  })

  it('fills lineage from VINAYA_RUN / VINAYA_ATTEMPT / VINAYA_PARENT_EVENT', () => {
    const { meta } = buildHeader({ ...baseInput, env: { run: 'run-abc', attempt: '2', parent: 'event-0' } })
    if (meta.schema !== 2) throw new Error('expected schema 2')
    expect(meta.lineage).toEqual({ run: 'run-abc', attempt: 2, parent: 'event-0' })
  })

  it('leaves lineage.attempt null for an unparseable VINAYA_ATTEMPT', () => {
    const { meta } = buildHeader({ ...baseInput, env: { attempt: 'abc' } })
    if (meta.schema !== 2) throw new Error('expected schema 2')
    expect(meta.lineage.attempt).toBeNull()
  })

  it('fills actor_id from VINAYA_ROLE even when the role is NOT a known doctrine role — opaque, never validated against ROLE_VALUES', () => {
    const { meta } = buildHeader({ ...baseInput, env: { role: 'ci-gate' } })
    if (meta.schema !== 2) throw new Error('expected schema 2')
    expect(meta.actor_id).toBe('ci-gate')
    // subject.role, unlike actor_id, stays validated and falls back to unattributed
  })

  it('fills input_versions from an explicit inputVersions override', () => {
    const { meta } = buildHeader({
      ...baseInput,
      inputVersions: {
        objectivesVersion: 'deadbeef',
        briefHash: 'sha256:abc',
        rulingOrdinal: 3,
        policyDigest: 'sha256:def'
      }
    })
    if (meta.schema !== 2) throw new Error('expected schema 2')
    expect(meta.input_versions).toEqual({
      objectives_version: 'deadbeef',
      brief_hash: 'sha256:abc',
      ruling_ordinal: 3,
      policy_digest: 'sha256:def'
    })
  })

  it('derives provenance: env_correlated when role or task is present, never upgrading itself to parent_attributed', () => {
    const { meta } = buildHeader({ ...baseInput, env: { role: 'developer' } })
    if (meta.schema !== 2) throw new Error('expected schema 2')
    expect(meta.provenance).toBe('env_correlated')
  })

  it('honors an explicit provenance override from a caller that structurally knows it', () => {
    const { meta } = buildHeader({ ...baseInput, provenance: 'parent_attributed' })
    if (meta.schema !== 2) throw new Error('expected schema 2')
    expect(meta.provenance).toBe('parent_attributed')
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
