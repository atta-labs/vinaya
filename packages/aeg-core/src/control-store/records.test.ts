import { describe, expect, it } from 'vitest'
import {
  type LoopStateRecord,
  type ManifestRecord,
  parseEffectRecord,
  parseInputRecord,
  parseLoopStateRecord,
  parseManifestRecord,
  parseOwnershipRecord,
  parseRunRecord,
  parseTransitionRecord,
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

describe('parseLoopStateRecord (control-store-v1 task 4, O1)', () => {
  const validLoopState: LoopStateRecord = {
    version: 1,
    kind: 'loop_state',
    task: 554,
    round: 2,
    phase: 'dispatch_developer',
    pauseReason: null,
    budgets: { mechanicalRetries: 1, reviewRounds: 2, infrastructureRetries: 0 },
    heldResult: { round: 2, head: 'a'.repeat(40) },
    deliveredFindings: { round: 1, head: 'b'.repeat(40) },
    recordedAt: '2026-09-14T00:00:00.000Z'
  }

  it('round-trips phase, round, budgets, held-result and delivered-findings identity', () => {
    expect(parseLoopStateRecord(JSON.stringify(validLoopState))).toEqual({ status: 'ok', value: validLoopState })
  })

  it('accepts a pause phase with a reason, and null held-result/delivered-findings', () => {
    const paused: LoopStateRecord = {
      ...validLoopState,
      phase: 'pause',
      pauseReason: 'infrastructure',
      heldResult: null,
      deliveredFindings: null
    }
    expect(parseLoopStateRecord(JSON.stringify(paused))).toEqual({ status: 'ok', value: paused })
  })

  it('an absent read is absent, never confused with a corrupt one', () => {
    expect(parseLoopStateRecord(undefined)).toEqual({ status: 'absent' })
  })

  it('torn JSON is corrupt, never absent', () => {
    expect(parseLoopStateRecord('{"version":1,"kind":"loop_state"').status).toBe('corrupt')
  })

  it('an unknown version is corrupt (a closed literal), never silently accepted', () => {
    expect(parseLoopStateRecord(JSON.stringify({ ...validLoopState, version: 2 })).status).toBe('corrupt')
  })

  it('a negative mechanical-retry count is corrupt', () => {
    const bad = { ...validLoopState, budgets: { ...validLoopState.budgets, mechanicalRetries: -1 } }
    expect(parseLoopStateRecord(JSON.stringify(bad)).status).toBe('corrupt')
  })

  it('an extra key is corrupt (strict schema)', () => {
    expect(parseLoopStateRecord(JSON.stringify({ ...validLoopState, extra: 'nope' })).status).toBe('corrupt')
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
