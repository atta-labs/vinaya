import { describe, expect, it } from 'vitest'
import {
  type EscalationRecord,
  type ManifestRecord,
  parseEffectRecord,
  parseEscalationRecord,
  parseInputRecord,
  parseManifestRecord,
  parseOwnershipRecord,
  parseResolutionRecord,
  parseRunRecord,
  parseTransitionRecord,
  type ResolutionRecord,
  type RunRecord
} from './records'

const validRun: RunRecord = {
  version: 1,
  kind: 'run',
  task: 551,
  runId: 'run-1',
  pid: 1234,
  host: 'box',
  startedAt: '2026-09-14T00:00:00.000Z'
}

describe('parseRunRecord', () => {
  it('reads a valid record as ok', () => {
    const result = parseRunRecord(JSON.stringify(validRun))
    expect(result).toEqual({ status: 'ok', value: validRun })
  })

  it('reports absent when nothing was ever written', () => {
    expect(parseRunRecord(undefined)).toEqual({ status: 'absent' })
  })

  it('reports corrupt, never absent, for torn JSON', () => {
    const result = parseRunRecord('{"version":1,"kind":"run","task":551,')
    expect(result.status).toBe('corrupt')
  })

  it('reports corrupt for an unknown version, never absent', () => {
    const result = parseRunRecord(JSON.stringify({ ...validRun, version: 2 }))
    expect(result.status).toBe('corrupt')
  })

  it('reports corrupt for an extra key (strict schema)', () => {
    const result = parseRunRecord(JSON.stringify({ ...validRun, extra: 'nope' }))
    expect(result.status).toBe('corrupt')
  })

  it('reports corrupt for a missing required field', () => {
    const { pid: _pid, ...withoutPid } = validRun
    const result = parseRunRecord(JSON.stringify(withoutPid))
    expect(result.status).toBe('corrupt')
  })

  it('reports corrupt for valid JSON that is not an object at all', () => {
    const result = parseRunRecord('"just a string"')
    expect(result.status).toBe('corrupt')
  })
})

describe('parseInputRecord', () => {
  it('accepts a resume input with a known PR and a fresh input with none', () => {
    const resume = parseInputRecord(
      JSON.stringify({
        version: 1,
        kind: 'input',
        task: 551,
        runId: 'run-1',
        source: 'resume',
        pr: 600,
        round: 2,
        recordedAt: '2026-09-14T00:00:00.000Z'
      })
    )
    expect(resume.status).toBe('ok')

    const fresh = parseInputRecord(
      JSON.stringify({
        version: 1,
        kind: 'input',
        task: 551,
        runId: 'run-2',
        source: 'fresh',
        pr: null,
        round: 0,
        recordedAt: '2026-09-14T00:00:00.000Z'
      })
    )
    expect(fresh.status).toBe('ok')
  })

  it('refuses an out-of-union source as corrupt', () => {
    const result = parseInputRecord(
      JSON.stringify({
        version: 1,
        kind: 'input',
        task: 551,
        runId: 'run-1',
        source: 'sideways',
        pr: null,
        round: 0,
        recordedAt: '2026-09-14T00:00:00.000Z'
      })
    )
    expect(result.status).toBe('corrupt')
  })
})

describe('parseOwnershipRecord', () => {
  it('round-trips a valid ownership record', () => {
    const record = {
      version: 1 as const,
      kind: 'ownership' as const,
      task: 551,
      epoch: 3,
      ownerId: 'run-3',
      pid: 42,
      host: 'box',
      acquiredAt: '2026-09-14T00:00:00.000Z'
    }
    expect(parseOwnershipRecord(JSON.stringify(record))).toEqual({ status: 'ok', value: record })
  })

  it('refuses a negative epoch as corrupt', () => {
    const result = parseOwnershipRecord(
      JSON.stringify({
        version: 1,
        kind: 'ownership',
        task: 551,
        epoch: -1,
        ownerId: 'run-3',
        pid: 42,
        host: 'box',
        acquiredAt: '2026-09-14T00:00:00.000Z'
      })
    )
    expect(result.status).toBe('corrupt')
  })
})

describe('parseTransitionRecord', () => {
  it('accepts a transition with no detail and one with detail', () => {
    const base = {
      version: 1 as const,
      kind: 'transition' as const,
      task: 551,
      epoch: 1,
      seq: 0,
      from: 'active',
      to: 'paused',
      at: '2026-09-14T00:00:00.000Z'
    }
    expect(parseTransitionRecord(JSON.stringify(base)).status).toBe('ok')
    expect(parseTransitionRecord(JSON.stringify({ ...base, detail: 'confidence' })).status).toBe('ok')
  })
})

describe('parseManifestRecord (#555, O1)', () => {
  const validManifest: ManifestRecord = {
    version: 1,
    kind: 'manifest',
    task: 555,
    round: 1,
    repository: 'atta-labs/vinaya',
    pr: 601,
    branch: 'task/control-store-v1/5',
    baseSha: 'f'.repeat(40),
    headSha: 'a'.repeat(40),
    briefHash: 'b'.repeat(64),
    objectivesVersion: 'c'.repeat(64),
    rulingOrdinal: 0,
    policyDigest: 'd'.repeat(64),
    recordedAt: '2026-09-14T00:00:00.000Z'
  }

  it('round-trips a full manifest snapshot — repository, work, base, candidate, versions, rulings, policy', () => {
    expect(parseManifestRecord(JSON.stringify(validManifest))).toEqual({ status: 'ok', value: validManifest })
  })

  it('accepts the nullable identity fields (no base, no brief, no objectives resolvable)', () => {
    const nullable: ManifestRecord = { ...validManifest, baseSha: null, briefHash: null, objectivesVersion: null }
    expect(parseManifestRecord(JSON.stringify(nullable))).toEqual({ status: 'ok', value: nullable })
  })

  it('an absent read is absent, never confused with a corrupt one', () => {
    expect(parseManifestRecord(undefined)).toEqual({ status: 'absent' })
  })

  it('torn JSON is corrupt, never absent', () => {
    expect(parseManifestRecord('{"version":1,"kind":"manifest"').status).toBe('corrupt')
  })

  it('an unknown version is corrupt (a closed literal), never silently accepted', () => {
    expect(parseManifestRecord(JSON.stringify({ ...validManifest, version: 2 })).status).toBe('corrupt')
  })

  it('an empty policy digest is corrupt — the policy identity is never allowed blank', () => {
    expect(parseManifestRecord(JSON.stringify({ ...validManifest, policyDigest: '' })).status).toBe('corrupt')
  })

  it('a negative round is corrupt', () => {
    expect(parseManifestRecord(JSON.stringify({ ...validManifest, round: -1 })).status).toBe('corrupt')
  })
})

describe('parseEffectRecord', () => {
  const base = {
    version: 1 as const,
    kind: 'effect' as const,
    task: 552,
    key: 'round-1-summary',
    operation: 'pr-comment',
    target: 'pr:600',
    inputVersion: 1,
    payloadDigest: 'deadbeef',
    status: 'started' as const,
    recordedAt: '2026-09-14T00:00:00.000Z'
  }

  it('accepts a started record with no url, and a verified record with one', () => {
    expect(parseEffectRecord(JSON.stringify(base)).status).toBe('ok')
    expect(
      parseEffectRecord(JSON.stringify({ ...base, status: 'verified', url: 'https://example.com/c/1' })).status
    ).toBe('ok')
  })

  it('accepts an uncertain record', () => {
    expect(parseEffectRecord(JSON.stringify({ ...base, status: 'uncertain' })).status).toBe('ok')
  })

  it('refuses an out-of-union status as corrupt', () => {
    expect(parseEffectRecord(JSON.stringify({ ...base, status: 'posted' })).status).toBe('corrupt')
  })

  it('reports absent when nothing was ever written', () => {
    expect(parseEffectRecord(undefined)).toEqual({ status: 'absent' })
  })
})

describe('parseEscalationRecord (#556, O1)', () => {
  const validEscalation: EscalationRecord = {
    version: 1,
    kind: 'escalation',
    task: 556,
    escalationId: `556-1-${'a'.repeat(40)}`,
    round: 1,
    head: 'a'.repeat(40),
    branch: 'task/control-store-v1/6',
    pr: 617,
    runId: 'run-a',
    pid: 4242,
    host: 'test-host',
    reason: 'escalation',
    attemptedRecovery: 'none — an escalation is a decision request, not a retry condition.',
    requestedDecision: 'rule or redirect the work',
    recipient: 'principal',
    briefHash: 'brief-hash',
    objectivesVersion: 'v1',
    rulingOrdinal: 0,
    policyDigest: 'policy-digest',
    recordedAt: '2026-09-15T00:00:00.000Z'
  }

  it('accepts a fully-populated escalation record', () => {
    expect(parseEscalationRecord(JSON.stringify(validEscalation))).toEqual({ status: 'ok', value: validEscalation })
  })

  it('accepts nullable briefHash/objectivesVersion and no PR (the pre-push, Issue-anchored shape)', () => {
    const preposh = { ...validEscalation, pr: null, briefHash: null, objectivesVersion: null }
    expect(parseEscalationRecord(JSON.stringify(preposh))).toEqual({ status: 'ok', value: preposh })
  })

  it('accepts optional detail/evidence when present, omits them when absent', () => {
    const withOptional = { ...validEscalation, detail: 'branch X is dirty', evidence: 'round 1 findings' }
    expect(parseEscalationRecord(JSON.stringify(withOptional))).toEqual({ status: 'ok', value: withOptional })
  })

  it('reports absent when nothing was ever written', () => {
    expect(parseEscalationRecord(undefined)).toEqual({ status: 'absent' })
  })

  it('reports corrupt on an unsupported version', () => {
    expect(parseEscalationRecord(JSON.stringify({ ...validEscalation, version: 2 })).status).toBe('corrupt')
  })

  it('reports corrupt on a blank recipient — .strict() schemas refuse an empty required field', () => {
    expect(parseEscalationRecord(JSON.stringify({ ...validEscalation, recipient: '' })).status).toBe('corrupt')
  })

  it('reports corrupt on an extra field — every record here is .strict()', () => {
    expect(parseEscalationRecord(JSON.stringify({ ...validEscalation, extra: 'nope' })).status).toBe('corrupt')
  })
})

describe('parseResolutionRecord (#556, O2)', () => {
  const validResolution: ResolutionRecord = {
    version: 1,
    kind: 'resolution',
    task: 556,
    escalationId: `556-1-${'a'.repeat(40)}`,
    decision: 'resume',
    authenticatedBy: 'principal-login',
    authenticatedFrom: '617-1',
    consumedAt: '2026-09-15T00:05:00.000Z'
  }

  it('accepts a "resume" decision and a "cancel" decision — never a third value', () => {
    expect(parseResolutionRecord(JSON.stringify(validResolution))).toEqual({ status: 'ok', value: validResolution })
    expect(parseResolutionRecord(JSON.stringify({ ...validResolution, decision: 'cancel' })).status).toBe('ok')
    expect(parseResolutionRecord(JSON.stringify({ ...validResolution, decision: 'defer' })).status).toBe('corrupt')
  })

  it('reports absent when nothing was ever written', () => {
    expect(parseResolutionRecord(undefined)).toEqual({ status: 'absent' })
  })

  it('reports corrupt on torn JSON', () => {
    expect(parseResolutionRecord('{"version":1,"kind":"resolution"').status).toBe('corrupt')
  })
})
