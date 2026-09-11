import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_REVIEW_POLICY, type ReviewInputManifest } from '@attalabs/aeg-core'
import type { DispatchHandle } from '../../../src/lib/dispatch'
import { buildVerdictFromReport, ReviewerReportParseFailure } from '../../../src/lib/dev-review-loop/reviewer-dispatch'

// --- objective-id coverage at the driver (review-validity-v1 task 4, #478, O4) ---

describe('buildVerdictFromReport — objective-id coverage, the same rule `review post` already applies', () => {
  let workDir: string

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'vinaya-build-verdict-'))
  })
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  const MANIFEST: ReviewInputManifest = {
    headSha: 'a'.repeat(40),
    briefHash: 'b'.repeat(64),
    objectivesVersion: 'c'.repeat(64),
    rulingOrdinal: 0,
    policyDigest: 'd'.repeat(64)
  }

  const HANDLE: DispatchHandle = {
    exitCode: 0,
    durationMs: 100,
    usage: { input: 10, output: 5 },
    resumeId: 'session-1',
    timedOut: false
  }

  const RESOLVED_OBJECTIVES = [
    { id: 'O1', text: 'Do the first thing.' },
    { id: 'O2', text: 'Do the second thing.' }
  ]

  function writeArtifacts(objectivesLines: string): void {
    writeFileSync(join(workDir, 'findings.txt'), '')
    writeFileSync(join(workDir, 'objectives.txt'), objectivesLines)
    writeFileSync(
      join(workDir, 'report.txt'),
      'BRIEF_CONFORMANCE: clean\nSPEC_CONFORMANCE: clean\nSCOPE: small\nTESTS: honest\nDOCS: n/a'
    )
  }

  it('accepts an objectives.txt covering every resolved id exactly', () => {
    writeArtifacts('O1|MET|done\nO2|MET|done')
    const result = buildVerdictFromReport(
      'reviewer',
      workDir,
      'claude',
      478,
      HANDLE,
      MANIFEST,
      DEFAULT_REVIEW_POLICY,
      RESOLVED_OBJECTIVES
    )
    expect(result.observation.verdict).toBe('APPROVE')
    expect(result.observation.objectives).toEqual([
      { id: 'O1', met: true },
      { id: 'O2', met: true }
    ])
  })

  it('refuses (ReviewerReportParseFailure) when objectives.txt is missing one resolved id', () => {
    writeArtifacts('O1|MET|done')
    expect(() =>
      buildVerdictFromReport(
        'reviewer',
        workDir,
        'claude',
        478,
        HANDLE,
        MANIFEST,
        DEFAULT_REVIEW_POLICY,
        RESOLVED_OBJECTIVES
      )
    ).toThrow(ReviewerReportParseFailure)
    try {
      buildVerdictFromReport('reviewer', workDir, 'claude', 478, HANDLE, MANIFEST, DEFAULT_REVIEW_POLICY, RESOLVED_OBJECTIVES)
      throw new Error('expected a throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewerReportParseFailure)
      expect((err as Error).message).toContain('missing O2')
    }
  })

  it('refuses when objectives.txt carries an extra id not on the resolved list', () => {
    writeArtifacts('O1|MET|done\nO2|MET|done\nO3|MET|done')
    expect(() =>
      buildVerdictFromReport(
        'reviewer',
        workDir,
        'claude',
        478,
        HANDLE,
        MANIFEST,
        DEFAULT_REVIEW_POLICY,
        RESOLVED_OBJECTIVES
      )
    ).toThrow(ReviewerReportParseFailure)
  })

  it('skips the coverage check entirely when the task carries no objectives at all', () => {
    writeFileSync(join(workDir, 'findings.txt'), '')
    writeFileSync(
      join(workDir, 'report.txt'),
      'BRIEF_CONFORMANCE: clean\nSPEC_CONFORMANCE: clean\nSCOPE: small\nTESTS: honest\nDOCS: n/a'
    )
    const result = buildVerdictFromReport(
      'reviewer',
      workDir,
      'claude',
      478,
      HANDLE,
      MANIFEST,
      DEFAULT_REVIEW_POLICY,
      []
    )
    expect(result.observation.verdict).toBe('APPROVE')
    expect(result.observation.objectives).toEqual([])
  })

  it('never runs the coverage check for an ESCALATE report', () => {
    writeFileSync(join(workDir, 'report.txt'), 'ESCALATE: strategy\nSUMMARY: found a design gap')
    const result = buildVerdictFromReport(
      'reviewer',
      workDir,
      'claude',
      478,
      HANDLE,
      MANIFEST,
      DEFAULT_REVIEW_POLICY,
      RESOLVED_OBJECTIVES
    )
    expect(result.observation.verdict).toBe('ESCALATE')
  })
})
