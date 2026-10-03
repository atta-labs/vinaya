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

  it('falls back to the branch-derived Issue when the env names no task (O1)', () => {
    const { subject, meta } = buildHeader({ ...baseInput, branchIssue: 792 })
    expect(subject.issue).toBe(792)
    // A branch is not an environment correlation — provenance is untouched.
    expect(meta.schema === 3 && meta.provenance).toBe('unavailable')
  })

  it('never lets a branch-derived Issue override one the env actually names (O2)', () => {
    const { subject } = buildHeader({ ...baseInput, env: { role: 'developer', task: '412' }, branchIssue: 792 })
    expect(subject.issue).toBe(412)
  })

  it('keeps issue null when the branch named none', () => {
    expect(buildHeader({ ...baseInput, branchIssue: null }).subject.issue).toBeNull()
  })

  it('never reads env_correlated over a branch-guessed issue, even when the env named a role', () => {
    // The shape a refused invocation takes: the role is recognised, the
    // task is absent or unparseable, and the number beside it came only
    // from the checkout. Saying `env_correlated` there would present a
    // guess as a correlation.
    const guessedWithRole = buildHeader({ ...baseInput, env: { role: 'developer' }, branchIssue: 792 })
    expect(guessedWithRole.meta.schema === 3 && guessedWithRole.meta.provenance).toBe('unavailable')
    const guessedWithBadTask = buildHeader({ ...baseInput, env: { role: 'developer', task: 'abc' }, branchIssue: 792 })
    expect(guessedWithBadTask.subject.issue).toBe(792)
    expect(guessedWithBadTask.meta.schema === 3 && guessedWithBadTask.meta.provenance).toBe('unavailable')
    // An env-named task keeps the correlation it really has.
    const named = buildHeader({ ...baseInput, env: { role: 'developer', task: '412' }, branchIssue: 792 })
    expect(named.meta.schema === 3 && named.meta.provenance).toBe('env_correlated')
  })

  it('leaves issue null for an unparseable VINAYA_TASK', () => {
    const { subject } = buildHeader({ ...baseInput, env: { task: 'abc' } })
    expect(subject.issue).toBeNull()
  })

  it('fills meta.schema/ts/run_id/seq/repo/vinaya/doctrine/host from the input', () => {
    const { meta } = buildHeader(baseInput)
    expect(meta).toMatchObject({
      schema: 3,
      ts: '2026-09-05T00:00:00.000Z',
      run_id: 'run-1',
      seq: 0,
      repo: 'atta-labs/vinaya',
      vinaya: '0.24.1',
      doctrine: 'aeg-root@abc123',
      host: 'cli'
    })
  })

  it('builds schema: 3 — event_id/process_id passed through, lineage/input_versions/provenance default to unavailable-not-invented', () => {
    const { meta } = buildHeader(baseInput)
    if (meta.schema !== 3) throw new Error('expected schema 3')
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
    if (meta.schema !== 3) throw new Error('expected schema 3')
    expect(meta.lineage).toEqual({ run: 'run-abc', attempt: 2, parent: 'event-0' })
  })

  it('leaves lineage.attempt null for an unparseable VINAYA_ATTEMPT', () => {
    const { meta } = buildHeader({ ...baseInput, env: { attempt: 'abc' } })
    if (meta.schema !== 3) throw new Error('expected schema 3')
    expect(meta.lineage.attempt).toBeNull()
  })

  it('fills actor_id from VINAYA_ROLE even when the role is NOT a known doctrine role — opaque, never validated against ROLE_VALUES', () => {
    const { meta } = buildHeader({ ...baseInput, env: { role: 'ci-gate' } })
    if (meta.schema !== 3) throw new Error('expected schema 3')
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
    if (meta.schema !== 3) throw new Error('expected schema 3')
    expect(meta.input_versions).toEqual({
      objectives_version: 'deadbeef',
      brief_hash: 'sha256:abc',
      ruling_ordinal: 3,
      policy_digest: 'sha256:def'
    })
  })

  it('derives provenance: env_correlated when role or task is present, never upgrading itself to parent_attributed', () => {
    const { meta } = buildHeader({ ...baseInput, env: { role: 'developer' } })
    if (meta.schema !== 3) throw new Error('expected schema 3')
    expect(meta.provenance).toBe('env_correlated')
  })

  it('honors an explicit provenance override from a caller that structurally knows it', () => {
    const { meta } = buildHeader({ ...baseInput, provenance: 'parent_attributed' })
    if (meta.schema !== 3) throw new Error('expected schema 3')
    expect(meta.provenance).toBe('parent_attributed')
  })

  it('names work, flow, runtime and source: none set reads null, except flow.id which is vinaya and a work ref that is the Issue number as text', () => {
    const empty = buildHeader(baseInput).meta
    if (empty.schema !== 3) throw new Error('expected schema 3')
    expect(empty.work).toEqual({ ref: null, repo: 'atta-labs/vinaya', change: null, revision: null })
    expect(empty.flow).toEqual({ id: 'vinaya', version: null })
    expect(empty.runtime).toBeNull()
    expect(empty.source).toBeNull()

    const task = buildHeader({ ...baseInput, env: { task: '412' } })
    if (task.meta.schema !== 3) throw new Error('expected schema 3')
    expect(task.meta.work.ref).toBe('412')
    expect(task.subject.issue).toBe(412)

    const branch = buildHeader({ ...baseInput, branchIssue: 792 })
    if (branch.meta.schema !== 3) throw new Error('expected schema 3')
    expect(branch.meta.work.ref).toBe('792')
  })

  it('takes work ref, flow id and version, runtime and source from the environment, and a stated work ref wins over the Issue number', () => {
    const { meta, subject } = buildHeader({
      ...baseInput,
      env: { task: '412', workRef: 'PROJ-9', flow: 'acme', flowVersion: '2', runtime: 'codex', source: 'ci' }
    })
    if (meta.schema !== 3) throw new Error('expected schema 3')
    expect(meta.work.ref).toBe('PROJ-9')
    expect(meta.flow).toEqual({ id: 'acme', version: '2' })
    expect(meta.runtime).toBe('codex')
    expect(meta.source).toBe('ci')
    expect(subject.issue).toBe(412)
  })

  it('treats an empty environment value as unset', () => {
    const { meta } = buildHeader({
      ...baseInput,
      env: { workRef: '', flow: '', flowVersion: '', runtime: '', source: '' }
    })
    if (meta.schema !== 3) throw new Error('expected schema 3')
    expect(meta.work.ref).toBeNull()
    expect(meta.flow).toEqual({ id: 'vinaya', version: null })
    expect(meta.runtime).toBeNull()
    expect(meta.source).toBeNull()
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

  it('parses VINAYA_PR into subject.pr, and leaves it out when absent or not a positive integer', () => {
    expect(buildHeader({ ...baseInput, env: { pr: '977' } }).subject.pr).toBe(977)
    for (const pr of [undefined, '', 'x', '0', '-3', '1.5']) {
      expect('pr' in buildHeader({ ...baseInput, env: { pr } }).subject).toBe(false)
    }
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
