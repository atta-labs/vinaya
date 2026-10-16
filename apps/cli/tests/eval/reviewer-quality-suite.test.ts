import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { ReviewBinding, ReviewerRole } from '../../src/lib/review-result'
import {
  admitClean,
  gradeItem,
  harnessReport,
  harnessSuite,
  harnessTask,
  harnessTrials,
  loadDevelopment,
  loadHeldOut,
  patchBytes,
  qualityReport,
  REVIEW_QUALITY_GRADER,
  sha256,
  type ReviewCase
} from './reviewer-quality-suite'

function review(
  item: ReviewCase,
  findings?: { severity: string; file: string; line: number | null; description: string }[]
) {
  const binding: ReviewBinding = {
    role: item.role,
    headSha: item.patch.source === 'git' ? item.patch.changedCommit : item.baseCommit,
    manifestDigest: '4040404040404040404040404040404040404040404040404040404040404040',
    objectiveIds: item.objectives
  }
  return {
    binding,
    output: {
      reviewResult: {
        schemaVersion: 1,
        status: 'completed',
        role: item.role,
        headSha: binding.headSha,
        manifestDigest: binding.manifestDigest,
        summary: 'reviewed',
        findings:
          findings ??
          (item.expected && !item.expected.justified
            ? [
                {
                  severity: item.expected.severity,
                  file: item.expected.file,
                  line: 1,
                  description: `blocking ${item.expected.kind}`
                }
              ]
            : []),
        objectiveResults: item.objectives.map((id) => ({
          id,
          status: 'MET',
          evidence: 'verified in the staged change'
        }))
      }
    }
  }
}

describe('reviewer quality suites', () => {
  it('pins both splits and never opens held-out content during development', () => {
    for (const role of ['code-reviewer', 'security-reviewer'] as const) {
      let heldOutRead = false
      const file = loadDevelopment(role, ((path: string) => {
        if (path.endsWith('reviewer-quality-held-out.json')) heldOutRead = true
        return readFileSync(path, 'utf8')
      }) as typeof readFileSync)
      expect(heldOutRead).toBe(false)
      expect(harnessSuite(role, file).ok).toBe(true)
      expect(() => loadHeldOut(role, '0'.repeat(64))).toThrow('approval')
    }
  })

  it('materializes and digest-checks actual seeded and git-reconstructed patches', () => {
    const items = [...loadDevelopment('code-reviewer').cases, ...loadDevelopment('security-reviewer').cases]
    for (const item of items) {
      const patch = patchBytes(item)
      expect(patch).toContain('diff --git ')
      expect(patch).toContain(item.patch.file)
    }
    const planted = structuredClone(items[0]!)
    planted.patch.digest = '0'.repeat(64)
    expect(() => patchBytes(planted)).toThrow('patch digest changed')
    if (planted.patch.source !== 'inline') throw new Error('the first seed must be inline')
    planted.patch.unified = planted.patch.unified.replace('return t.successes / t.trials', 'return absent / context')
    planted.patch.digest = sha256(planted.patch.unified)
    expect(() => patchBytes(planted)).toThrow('does not apply')
  })

  it('holds all required seeded kinds and at least five snapshot-backed historical rounds', () => {
    const code = loadDevelopment('code-reviewer').cases
    const security = loadDevelopment('security-reviewer').cases
    expect(code.filter((item) => item.set === 'historical')).toHaveLength(5)
    expect(new Set(code.filter((item) => item.set === 'seeded').map((item) => item.expected?.kind))).toEqual(
      new Set(['logic-error', 'contract-break', 'missing-test', 'beyond-surface', 'objective-unmet'])
    )
    expect(new Set(security.filter((item) => item.set === 'seeded').map((item) => item.expected?.kind))).toEqual(
      new Set(['credential', 'path-traversal', 'unsafe-shell', 'widened-permission', 'injected-instructions'])
    )
    for (const item of code.filter((entry) => entry.set === 'historical')) {
      expect(item.provenance.snapshotDigest).toBe('38a5e600209978775b2e44b63503bfcd53e41bf167fd07c9773b7b92bcd44f00')
    }
  })

  it('enforces two snapshot-backed independent adjudications bound to the candidate head', () => {
    const clean: ReviewCase = structuredClone(
      loadDevelopment('code-reviewer').cases.find((item) => item.set === 'clean')!
    )
    expect(admitClean(clean)).toBe('admit')
    clean.adjudication!.second.runId = clean.adjudication!.first.runId
    expect(admitClean(clean)).toBe('drop')
    clean.adjudication!.second.runId = 'independent-again'
    clean.adjudication!.second.judgedHead = 'another-change'
    expect(admitClean(clean)).toBe('drop')
    clean.adjudication!.second.judgedHead = clean.adjudication!.first.judgedHead
    clean.adjudication!.second.verdict = 'blocking'
    expect(admitClean(clean)).toBe('drop')
    clean.adjudication!.first.verdict = 'blocking'
    expect(admitClean(clean)).toBe('historical')
  })

  it('uses production schema and semantic acceptance before any binary grade', () => {
    const item = loadDevelopment('code-reviewer').cases[0]!
    const valid = review(item)
    expect(gradeItem(item, valid.output, valid.binding).pass).toBe(true)
    expect(gradeItem(item, {}, valid.binding)).toMatchObject({ accepted: false, pass: false })
    const crossed = structuredClone(valid.output) as any
    crossed.reviewResult.role = 'security-reviewer'
    expect(gradeItem(item, crossed, valid.binding)).toMatchObject({ accepted: false, pass: false })
    expect(gradeItem(item, valid.output, { ...valid.binding, headSha: 'other-head' })).toMatchObject({
      accepted: false,
      pass: false
    })
  })

  it('constructs validated Task, Trial, Suite and Report ports with a pinned code grader', () => {
    expect(REVIEW_QUALITY_GRADER.logicDigest).not.toBe(
      sha256(
        'validate ReviewResult against controller binding; require expected blocking finding, clean non-blocking result, and every objective disposition'
      )
    )
    for (const role of ['code-reviewer', 'security-reviewer'] as ReviewerRole[]) {
      const items = loadDevelopment(role).cases
      const grades = items.map((item) => {
        const accepted = review(item)
        return gradeItem(item, accepted.output, accepted.binding)
      })
      const transcripts = items.map((_, index) =>
        (index + (role === 'code-reviewer' ? 50 : 70)).toString(16).padStart(64, '0')
      )
      expect(items.map(harnessTask)).toHaveLength(items.length)
      expect(harnessTrials(items, grades, transcripts)).toHaveLength(items.length)
      const evidence = harnessReport(role, items, grades, transcripts)
      expect(evidence.report.conditions[0]!.mean).toBe(1)
      expect(evidence.quality).toMatchObject({
        recall: 1,
        falseBlockingRate: 0,
        objectiveDispositionAccuracy: 1,
        zeroCriticalHighSecurityMisses: true
      })
      expect(qualityReport(items, grades)).toEqual(evidence.quality)
    }
  })

  it('holds a clean blocking finding pending until adjudication decides its disposition', () => {
    const item = loadDevelopment('code-reviewer').cases.find((candidate) => candidate.set === 'clean')!
    const blockingReview = review(item, [
      { severity: 'MAJOR', file: item.patch.file, line: 1, description: 'possible real defect' }
    ])
    const grade = gradeItem(item, blockingReview.output, blockingReview.binding)
    expect(qualityReport([item], [grade])).toMatchObject({
      falseBlockingRate: null,
      pendingCleanFindings: [item.id]
    })
    expect(qualityReport([item], [grade], { [item.id]: 'false-block' })).toMatchObject({
      falseBlockingRate: 1,
      pendingCleanFindings: []
    })
    expect(qualityReport([item], [grade], { [item.id]: 'real-defect' })).toMatchObject({
      falseBlockingRate: 0,
      movedToHistorical: [item.id]
    })
  })
})
