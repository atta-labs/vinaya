import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { CompletedReview, ReviewerRole } from '../../src/lib/review-result'
import {
  admitClean,
  gradeItem,
  harnessSuite,
  loadDevelopment,
  loadHeldOut,
  qualityReport,
  type ReviewCase
} from './reviewer-quality-suite'

const result = (role: ReviewerRole, findings: CompletedReview['findings'], objectives = ['O1']): CompletedReview => ({
  schemaVersion: 1,
  status: 'completed',
  role,
  headSha: 'head',
  manifestDigest: 'manifest',
  summary: 'reviewed',
  findings,
  objectiveResults: objectives.map((id) => ({ id, status: 'MET', evidence: 'verified in the staged change' }))
})

describe('reviewer quality suites', () => {
  it('pins development and held-out splits without opening held-out during development', () => {
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

  it('holds all required seeded kinds, real historical rounds and independent clean adjudications', () => {
    const code = loadDevelopment('code-reviewer').cases
    const security = loadDevelopment('security-reviewer').cases
    expect(code.filter((c) => c.set === 'historical').length).toBeGreaterThanOrEqual(5)
    expect(new Set(code.filter((c) => c.set === 'seeded').map((c) => c.expected?.kind))).toEqual(
      new Set(['logic-error', 'contract-break', 'missing-test', 'beyond-surface', 'objective-unmet'])
    )
    expect(new Set(security.filter((c) => c.set === 'seeded').map((c) => c.expected?.kind))).toEqual(
      new Set(['credential', 'path-traversal', 'unsafe-shell', 'widened-permission', 'injected-instructions'])
    )
    for (const c of [...code, ...security]) {
      expect(c.baseCommit).toMatch(/^[0-9a-f]{40}$/)
      expect(c.patch.digest).toMatch(/^[0-9a-f]{64}$/)
      if (c.set === 'historical')
        expect(c.provenance.snapshotDigest).toBe('38a5e600209978775b2e44b63503bfcd53e41bf167fd07c9773b7b92bcd44f00')
      if (c.set === 'clean') expect(admitClean(c)).toBe('admit')
    }
  })

  it('drops disagreement and moves a confirmed defect to history', () => {
    const clean: ReviewCase = structuredClone(loadDevelopment('code-reviewer').cases.find((c) => c.set === 'clean')!)
    clean.adjudication!.second.blockingDefect = true
    expect(admitClean(clean)).toBe('drop')
    clean.adjudication!.second.confirmedDefect = true
    expect(admitClean(clean)).toBe('historical')
    ;(clean.adjudication!.second as { sawOther: boolean }).sawOther = true
    expect(admitClean(clean)).toBe('drop')
  })

  it('grades file, blocking severity, Surface justification, clean findings, objectives and acceptance', () => {
    const items = loadDevelopment('code-reviewer').cases
    const grades = items.map((item) => gradeItem(item, passing(item)))
    expect(grades.every((g) => g.pass)).toBe(true)
    const report = qualityReport(items, grades)
    expect(report).toMatchObject({ recall: 1, falseBlockingRate: 0, objectiveDispositionAccuracy: 1 })
    const planted = items.find((c) => c.expected && !c.expected.justified)!
    expect(gradeItem(planted, result('code-reviewer', [], planted.objectives), true).pass).toBe(false)
    expect(gradeItem(planted, passing(planted), false).accepted).toBe(false)
  })

  it('requires zero misses on seeded critical and high security defects', () => {
    const items = loadDevelopment('security-reviewer').cases
    const grades = items.map((item) => gradeItem(item, passing(item)))
    expect(qualityReport(items, grades).zeroCriticalHighSecurityMisses).toBe(true)
    const i = items.findIndex((c) => c.expected?.severity === 'CRITICAL')
    grades[i] = gradeItem(items[i]!, result('security-reviewer', [], items[i]!.objectives))
    expect(qualityReport(items, grades).zeroCriticalHighSecurityMisses).toBe(false)
  })
})

function passing(item: ReviewCase): CompletedReview {
  const findings =
    item.expected && !item.expected.justified
      ? [
          {
            severity: item.expected.severity,
            file: item.expected.file,
            line: 1,
            description: `blocking ${item.expected.kind}`
          }
        ]
      : []
  return result(item.role, findings, item.objectives)
}
