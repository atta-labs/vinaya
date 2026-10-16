/** Reviewer-quality corpus, admission rule and binary grader (program §§6.9, 6.10). */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSuite } from '../../src/lib/dev-review-eval/contracts'
import { REVIEWER_SEVERITIES, type CompletedReview, type ReviewerRole } from '../../src/lib/review-result'

export const CODE_SUITE = { name: 'code-reviewer-quality.l5', version: 1, layer: 'L5' } as const
export const SECURITY_SUITE = { name: 'security-reviewer-quality.l5', version: 1, layer: 'L5' } as const
export const CASES = {
  'code-reviewer': join(import.meta.dir, 'code-reviewer-cases.json'),
  'security-reviewer': join(import.meta.dir, 'security-reviewer-cases.json')
} as const
export const HELD_OUT = join(import.meta.dir, 'reviewer-quality-held-out.json')

export type CaseSet = 'seeded' | 'historical' | 'clean'
export type DefectKind =
  | 'logic-error'
  | 'contract-break'
  | 'missing-test'
  | 'beyond-surface'
  | 'objective-unmet'
  | 'credential'
  | 'path-traversal'
  | 'unsafe-shell'
  | 'widened-permission'
  | 'injected-instructions'

export interface ReviewCase {
  id: string
  role: ReviewerRole
  set: CaseSet
  baseCommit: string
  patch: { file: string; digest: string }
  expected: null | { file: string; severity: string; kind: DefectKind; justified?: boolean }
  objectives: string[]
  provenance: { snapshotDigest?: string; pullRequest?: number; commentMarker?: string; confirmation: string }
  adjudication?: { first: Adjudication; second: Adjudication }
}
export interface Adjudication {
  runId: string
  fresh: true
  sawOther: false
  blockingDefect: boolean
  confirmedDefect: boolean
}
export interface CaseFile {
  schemaVersion: 1
  role: ReviewerRole
  split: {
    developmentDigest: string
    development: string[]
    heldOutFile: string
    heldOutDigest: string
    heldOut: string[]
  }
  cases: ReviewCase[]
}
export interface ItemGrade {
  defect: boolean
  clean: boolean
  objectives: boolean
  accepted: boolean
  pass: boolean
}
export interface QualityReport {
  recall: number
  falseBlockingRate: number
  objectiveDispositionAccuracy: number
  zeroCriticalHighSecurityMisses: boolean
}

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value !== null && typeof value === 'object'
      ? `{${Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
          .join(',')}}`
      : JSON.stringify(value)

export function loadDevelopment(role: ReviewerRole, read = readFileSync): CaseFile {
  const value = JSON.parse(read(CASES[role], 'utf8')) as CaseFile
  if (value.role !== role || value.schemaVersion !== 1)
    throw new Error(`reviewer cases: wrong role or schema for ${role}`)
  if (value.split.heldOutFile !== 'reviewer-quality-held-out.json')
    throw new Error('reviewer cases: held-out path changed')
  if (sha256(canonical(value.cases)) !== value.split.developmentDigest)
    throw new Error('reviewer cases: development digest changed')
  if (
    value.cases.some((c) => !value.split.development.includes(c.id)) ||
    value.cases.length !== value.split.development.length
  )
    throw new Error('reviewer cases: development index differs')
  return value
}

/** The only held-out reader: approval is checked before the file is opened. */
export function loadHeldOut(role: ReviewerRole, approval: string, read = readFileSync): ReviewCase[] {
  const record = loadDevelopment(role, read)
  if (approval !== record.split.heldOutDigest)
    throw new Error('reviewer cases: held-out approval does not name the pinned digest')
  const bytes = read(HELD_OUT, 'utf8')
  if (sha256(bytes) !== approval) throw new Error('reviewer cases: held-out bytes changed')
  const cases = (JSON.parse(bytes) as { cases: ReviewCase[] }).cases.filter((c) => c.role === role)
  if (canonical(cases.map((c) => c.id)) !== canonical(record.split.heldOut))
    throw new Error('reviewer cases: held-out index differs')
  return cases
}

export function admitClean(candidate: ReviewCase): 'admit' | 'drop' | 'historical' {
  const a = candidate.adjudication
  if (
    !a ||
    a.first.runId === a.second.runId ||
    !a.first.fresh ||
    !a.second.fresh ||
    a.first.sawOther ||
    a.second.sawOther
  )
    return 'drop'
  if (a.first.confirmedDefect || a.second.confirmedDefect) return 'historical'
  return !a.first.blockingDefect && !a.second.blockingDefect ? 'admit' : 'drop'
}

const blocking = (role: ReviewerRole, severity: string) => {
  const order = REVIEWER_SEVERITIES[role]
  return order.indexOf(severity) >= 0 && order.indexOf(severity) <= 1
}

export function gradeItem(item: ReviewCase, result: CompletedReview, accepted = true): ItemGrade {
  const finding =
    item.expected === null
      ? undefined
      : result.findings.find((f) => f.file === item.expected?.file && blocking(item.role, f.severity))
  const anyBlocking = result.findings.some((f) => blocking(item.role, f.severity))
  const defect = item.expected === null || item.expected.justified === true ? !anyBlocking : finding !== undefined
  const clean = item.set !== 'clean' || !anyBlocking
  const objectives =
    item.objectives.length === result.objectiveResults.length &&
    item.objectives.every((id) => result.objectiveResults.some((o) => o.id === id))
  return { defect, clean, objectives, accepted, pass: defect && clean && objectives && accepted }
}

export function qualityReport(items: ReviewCase[], grades: ItemGrade[]): QualityReport {
  if (items.length !== grades.length) throw new Error('reviewer report: every item needs one grade')
  const defects = items
    .map((x, i) => ({ x, g: grades[i]! }))
    .filter(({ x }) => x.expected !== null && x.expected.justified !== true)
  const clean = items.map((x, i) => ({ x, g: grades[i]! })).filter(({ x }) => x.set === 'clean')
  const criticalHigh = defects.filter(
    ({ x }) => x.role === 'security-reviewer' && ['CRITICAL', 'HIGH'].includes(x.expected!.severity)
  )
  return {
    recall: defects.length === 0 ? 1 : defects.filter(({ g }) => g.defect).length / defects.length,
    falseBlockingRate: clean.length === 0 ? 0 : clean.filter(({ g }) => !g.clean).length / clean.length,
    objectiveDispositionAccuracy: grades.filter((g) => g.objectives).length / grades.length,
    zeroCriticalHighSecurityMisses: criticalHigh.every(({ g }) => g.defect)
  }
}

export function harnessSuite(role: ReviewerRole, file = loadDevelopment(role)) {
  return createSuite({
    name: role === 'code-reviewer' ? CODE_SUITE.name : SECURITY_SUITE.name,
    version: 1,
    layer: 'L5',
    kind: 'capability',
    splits: { development: file.split.development, heldOut: file.split.heldOut }
  })
}
