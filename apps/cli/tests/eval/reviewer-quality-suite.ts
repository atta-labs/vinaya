/** Reviewer-quality corpus, admission rule and binary grader (program §§6.9, 6.10). */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type CodeGraderIdentity,
  createSuite,
  type Report,
  type Task,
  type Trial,
  validateReport,
  validateTask,
  validateTrialSet
} from '../../src/lib/dev-review-eval/contracts'
import {
  REVIEWER_SEVERITIES,
  type CompletedReview,
  type ReviewBinding,
  type ReviewerRole,
  validateReviewResult
} from '../../src/lib/review-result'

export const CODE_SUITE = { name: 'code-reviewer-quality.l5', version: 1, layer: 'L5' } as const
export const SECURITY_SUITE = { name: 'security-reviewer-quality.l5', version: 1, layer: 'L5' } as const
export const CASES = {
  'code-reviewer': join(import.meta.dir, 'code-reviewer-cases.json'),
  'security-reviewer': join(import.meta.dir, 'security-reviewer-cases.json')
} as const
export const HELD_OUT = join(import.meta.dir, 'reviewer-quality-held-out.json')
const REPO_ROOT = join(import.meta.dir, '../../../..')

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
export type PatchRecord =
  | { source: 'inline'; file: string; digest: string; unified: string }
  | { source: 'git'; file: string; digest: string; parentCommit: string; changedCommit: string }
export interface RecordedAdjudication {
  runId: string
  fresh: true
  sawOther: false
  transcriptDigest: string
  binding: ReviewBinding
  output: unknown
}
export interface ReviewCase {
  id: string
  role: ReviewerRole
  set: CaseSet
  baseCommit: string
  patch: PatchRecord
  expected: null | { file: string; severity: string; kind: DefectKind; justified?: boolean }
  objectives: string[]
  provenance: { snapshotDigest?: string; pullRequest?: number; commentMarker?: string; confirmation: string }
  adjudication?: { first: RecordedAdjudication; second: RecordedAdjudication }
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
  reason: string | null
}
export interface QualityReport {
  recall: number
  falseBlockingRate: number
  objectiveDispositionAccuracy: number
  zeroCriticalHighSecurityMisses: boolean
}

export const sha256 = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex')
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value !== null && typeof value === 'object'
      ? `{${Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
          .join(',')}}`
      : JSON.stringify(value)

const graderContract =
  'validate ReviewResult against controller binding; require expected blocking finding, clean non-blocking result, and every objective disposition'
export const REVIEW_QUALITY_GRADER: CodeGraderIdentity = {
  kind: 'code',
  id: 'reviewer-quality-binary',
  version: '1',
  logicDigest: sha256(graderContract)
}
export type PatchResolver = (parent: string, changed: string, file: string) => string
const gitPatch: PatchResolver = (parent, changed, file) => {
  const run = spawnSync('git', ['diff', parent, changed, '--', file], { cwd: REPO_ROOT, encoding: 'utf8' })
  if (run.status !== 0) throw new Error(`reviewer cases: cannot reconstruct ${parent}..${changed}:${file}`)
  return run.stdout
}
export function patchBytes(item: ReviewCase, resolve: PatchResolver = gitPatch): string {
  const bytes =
    item.patch.source === 'inline'
      ? item.patch.unified
      : resolve(item.patch.parentCommit, item.patch.changedCommit, item.patch.file)
  if (bytes.length === 0 || sha256(bytes) !== item.patch.digest)
    throw new Error(`reviewer cases: patch digest changed for ${item.id}`)
  return bytes
}
const blocking = (role: ReviewerRole, severity: string) => {
  const order = REVIEWER_SEVERITIES[role]
  return order.indexOf(severity) >= 0 && order.indexOf(severity) <= 1
}
function adjudicationResult(run: RecordedAdjudication, item: ReviewCase): CompletedReview | null {
  if (
    !run.fresh ||
    run.sawOther ||
    run.binding.role !== item.role ||
    run.binding.objectiveIds.join('\0') !== item.objectives.join('\0')
  )
    return null
  const validation = validateReviewResult(run.output, run.binding)
  return validation.ok && validation.result.status === 'completed' ? validation.result : null
}
/** Clean entries cannot cross the corpus boundary without two independent accepted fresh reviews. */
export function admitClean(candidate: ReviewCase): 'admit' | 'drop' | 'historical' {
  const evidence = candidate.adjudication
  if (!evidence || evidence.first.runId === evidence.second.runId) return 'drop'
  const first = adjudicationResult(evidence.first, candidate)
  const second = adjudicationResult(evidence.second, candidate)
  if (!first || !second) return 'drop'
  const a = first.findings.some((finding) => blocking(candidate.role, finding.severity))
  const b = second.findings.some((finding) => blocking(candidate.role, finding.severity))
  return a && b ? 'historical' : a || b ? 'drop' : 'admit'
}
function validateCorpus(file: CaseFile, role: ReviewerRole, resolve: PatchResolver): CaseFile {
  if (file.role !== role || file.schemaVersion !== 1)
    throw new Error(`reviewer cases: wrong role or schema for ${role}`)
  if (file.split.heldOutFile !== 'reviewer-quality-held-out.json')
    throw new Error('reviewer cases: held-out path changed')
  if (sha256(canonical(file.cases)) !== file.split.developmentDigest)
    throw new Error('reviewer cases: development digest changed')
  if (
    file.cases.some((item) => !file.split.development.includes(item.id)) ||
    file.cases.length !== file.split.development.length
  )
    throw new Error('reviewer cases: development index differs')
  for (const item of file.cases) {
    patchBytes(item, resolve)
    if (item.set === 'clean' && admitClean(item) !== 'admit')
      throw new Error(`reviewer cases: clean item ${item.id} was not admitted`)
  }
  return file
}
export function loadDevelopment(role: ReviewerRole, read = readFileSync, resolve: PatchResolver = gitPatch): CaseFile {
  return validateCorpus(JSON.parse(read(CASES[role], 'utf8')) as CaseFile, role, resolve)
}
/** The only held-out reader checks approval before opening the held-out file. */
export function loadHeldOut(
  role: ReviewerRole,
  approval: string,
  read = readFileSync,
  resolve: PatchResolver = gitPatch
): ReviewCase[] {
  const record = loadDevelopment(role, read, resolve)
  if (approval !== record.split.heldOutDigest)
    throw new Error('reviewer cases: held-out approval does not name the pinned digest')
  const bytes = read(HELD_OUT, 'utf8')
  if (sha256(bytes) !== approval) throw new Error('reviewer cases: held-out bytes changed')
  const cases = (JSON.parse(bytes) as { cases: ReviewCase[] }).cases.filter((item) => item.role === role)
  if (canonical(cases.map((item) => item.id)) !== canonical(record.split.heldOut))
    throw new Error('reviewer cases: held-out index differs')
  for (const item of cases) {
    patchBytes(item, resolve)
    if (item.set === 'clean' && admitClean(item) !== 'admit')
      throw new Error(`reviewer cases: held-out clean item ${item.id} was not admitted`)
  }
  return cases
}
export function gradeItem(item: ReviewCase, output: unknown, binding: ReviewBinding): ItemGrade {
  const validation = validateReviewResult(output, binding)
  if (!validation.ok || validation.result.status !== 'completed') {
    return {
      defect: false,
      clean: false,
      objectives: false,
      accepted: false,
      pass: false,
      reason: validation.ok ? 'review blocked' : validation.errors.join('; ')
    }
  }
  const result = validation.result
  const matching =
    item.expected === null
      ? undefined
      : result.findings.find((finding) => finding.file === item.expected?.file && blocking(item.role, finding.severity))
  const anyBlocking = result.findings.some((finding) => blocking(item.role, finding.severity))
  const defect = item.expected === null || item.expected.justified === true ? !anyBlocking : matching !== undefined
  const clean = item.set !== 'clean' || !anyBlocking
  const objectives =
    item.objectives.length === result.objectiveResults.length &&
    item.objectives.every((id) => result.objectiveResults.some((objective) => objective.id === id))
  return { defect, clean, objectives, accepted: true, pass: defect && clean && objectives, reason: null }
}
export function qualityReport(items: ReviewCase[], grades: ItemGrade[]): QualityReport {
  if (items.length !== grades.length || grades.length === 0)
    throw new Error('reviewer report: every item needs one grade')
  const defects = items
    .map((item, i) => ({ item, grade: grades[i]! }))
    .filter(({ item }) => item.expected !== null && item.expected.justified !== true)
  const clean = items.map((item, i) => ({ item, grade: grades[i]! })).filter(({ item }) => item.set === 'clean')
  const criticalHigh = defects.filter(
    ({ item }) => item.role === 'security-reviewer' && ['CRITICAL', 'HIGH'].includes(item.expected!.severity)
  )
  return {
    recall: defects.length === 0 ? 1 : defects.filter(({ grade }) => grade.defect).length / defects.length,
    falseBlockingRate: clean.length === 0 ? 0 : clean.filter(({ grade }) => !grade.clean).length / clean.length,
    objectiveDispositionAccuracy: grades.filter((grade) => grade.objectives).length / grades.length,
    zeroCriticalHighSecurityMisses: criticalHigh.every(({ grade }) => grade.defect)
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
export function harnessTask(item: ReviewCase): Task {
  const briefDigest = sha256(canonical({ objectives: item.objectives, role: item.role }))
  const expectedOutcomeDigest = sha256(canonical(item.expected))
  const stagedInputDigests = { patch: item.patch.digest }
  const raw = {
    id: item.id,
    kind: 'non-coding',
    inputs: { repositoryCommit: item.baseCommit, briefDigest, stagedInputDigests, scriptedEnvironmentDigest: null },
    environmentBuilder: { id: 'reviewer-staged-change', version: '1' },
    referenceSolution: null,
    graders: [REVIEW_QUALITY_GRADER],
    pinning: {
      repositoryCommit: item.baseCommit,
      briefDigest,
      stagedInputDigests,
      referenceSolutionDigest: null,
      expectedOutcomeDigest,
      graders: [REVIEW_QUALITY_GRADER]
    }
  }
  const validated = validateTask(raw)
  if (!validated.ok) throw new Error(`reviewer task ${item.id}: ${validated.refusal.path}: ${validated.refusal.detail}`)
  return validated.value
}
export function harnessTrials(items: ReviewCase[], grades: ItemGrade[], transcriptDigests: string[]): Trial[] {
  const raw = items.map((item, index) => ({
    id: `${item.id}-trial`,
    taskId: item.id,
    condition: 'candidate',
    attempt: 1,
    scope: { kind: 'whole' },
    isolation: {
      workspaceId: `${item.id}-workspace`,
      vendorHomeId: `${item.id}-vendor-home`,
      checkpointerId: `${item.id}-checkpointer`,
      logDestinationId: `${item.id}-log`
    },
    outcome: {
      kind: 'graded',
      outcomeDigest: sha256(canonical(grades[index])),
      grades: [
        {
          grader: REVIEW_QUALITY_GRADER,
          result: grades[index]!.pass
            ? { verdict: 'pass' }
            : { verdict: 'fail', reason: grades[index]!.reason ?? 'review criterion failed' }
        }
      ]
    },
    transcriptDigests: [transcriptDigests[index]!]
  }))
  const validated = validateTrialSet(raw)
  if (!validated.ok) throw new Error(`reviewer trials: ${validated.refusal.path}: ${validated.refusal.detail}`)
  return validated.value
}
export function harnessReport(
  role: ReviewerRole,
  items: ReviewCase[],
  grades: ItemGrade[],
  transcriptDigests: string[]
): { report: Report; quality: QualityReport } {
  const tasks = items.map((item, index) => ({ taskId: item.id, successes: grades[index]!.pass ? 1 : 0, trials: 1 }))
  const mean = tasks.filter((task) => task.successes === 1).length / tasks.length
  const raw = {
    suite: { name: role === 'code-reviewer' ? CODE_SUITE.name : SECURITY_SUITE.name, version: 1 },
    split: 'development',
    conditions: [
      {
        condition: 'candidate',
        tasks,
        mean,
        interval: { lower: mean, upper: mean },
        resampling: { method: 'deterministic', seed: 0, resamples: 1, confidence: 0.95 },
        passHatK: [{ k: 1, value: mean }]
      }
    ],
    paired: null,
    quarantined: [],
    transcriptDigests
  }
  const validated = validateReport(raw)
  if (!validated.ok) throw new Error(`reviewer report: ${validated.refusal.path}: ${validated.refusal.detail}`)
  return { report: validated.value, quality: qualityReport(items, grades) }
}
