/**
 * Question 2 — are reviewers strict? (`apps/cli/specs/log-sync.md`, "The
 * questions".) For each reviewer role and model, the verdicts a `dispatch`
 * recorded and how they read, and the findings and blockers those verdicts
 * carried, by severity. The answer counts what a verdict stated — `APPROVE`
 * or `PASS` read as approved, `REQUEST CHANGES` or `FAIL` as changes
 * requested, a finding's `policy_treatment: 'blocking'` as a blocker — and
 * never scores whether a reviewer was right to decide as it did.
 */

import type { Dataset, DatasetRow } from '../sync'
import type { Coverage, UnknownFigure } from './common'
import { buildCoverage, compareText, groupBy, objectField, rowsOfKinds, textField, trustedRows } from './common'

const JUDGMENT_KINDS = ['dispatch']
const APPROVED_VERDICTS = ['APPROVE', 'PASS']
const CHANGES_REQUESTED_VERDICTS = ['REQUEST CHANGES', 'FAIL']

export type SeverityFindings = {
  severity: string
  /** Findings of this severity. */
  findings: number
  /** Of those, findings whose `policy_treatment` is `'blocking'`. */
  blockers: number
}

export type VerdictFindings = {
  verdict: 'approved' | 'changes_requested'
  /** Ascending by severity. */
  bySeverity: SeverityFindings[]
}

export type ReviewerStrictness = {
  role: string
  model: string
  verdictsRead: number
  approved: number
  changesRequested: number
  /** Ascending: `'approved'` then `'changes_requested'`. */
  findings: VerdictFindings[]
}

export type JudgmentAnswer = {
  /** Ascending by role, then model. */
  reviewers: ReviewerStrictness[]
  coverage: Coverage
}

type FindingFact = { severity: string; blocking: boolean }

type Verdict = { outcome: 'approved' | 'changes_requested'; findings: FindingFact[] }

function findingsOf(outcome: Record<string, unknown>): FindingFact[] {
  const raw = outcome.findings
  if (!Array.isArray(raw)) return []
  const out: FindingFact[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const severity = (item as Record<string, unknown>).severity
    if (typeof severity !== 'string') continue
    out.push({ severity, blocking: (item as Record<string, unknown>).policy_treatment === 'blocking' })
  }
  return out
}

/** The verdict a `dispatch`'s `outcome_received` line carries, or `null` when it is not a verdict outcome. */
function verdictOf(row: DatasetRow): Verdict | null {
  if (row.event !== 'outcome_received') return null
  const outcome = objectField(row, 'outcome')
  if (outcome === null || outcome.type !== 'verdict') return null
  const verdict = outcome.verdict
  if (typeof verdict !== 'string') return null
  if (APPROVED_VERDICTS.includes(verdict)) return { outcome: 'approved', findings: findingsOf(outcome) }
  if (CHANGES_REQUESTED_VERDICTS.includes(verdict))
    return { outcome: 'changes_requested', findings: findingsOf(outcome) }
  return null
}

function bySeverityOf(findings: readonly FindingFact[]): SeverityFindings[] {
  return [...groupBy(findings, (f) => f.severity)]
    .sort(([a], [b]) => compareText(a, b))
    .map(([severity, group]) => ({
      severity,
      findings: group.length,
      blockers: group.filter((f) => f.blocking).length
    }))
}

/** Question 2: verdicts, and their findings and blockers by severity, by reviewer role and model. */
export function reviewerStrictness(dataset: Dataset): JudgmentAnswer {
  const { rows, lowTrust } = trustedRows(dataset)
  const used = rowsOfKinds(rows, JUDGMENT_KINDS)
  const unknowns: UnknownFigure[] = []

  type Group = { role: string; model: string; verdicts: Verdict[] }
  const groups = new Map<string, Group>()
  for (const row of used.withUnit) {
    const verdict = verdictOf(row)
    if (verdict === null) continue
    const role = textField(row, 'target_role')
    const model = textField(row, 'model')
    if (role === null || model === null) continue
    const key = JSON.stringify([role, model])
    const group = groups.get(key) ?? { role, model, verdicts: [] }
    group.verdicts.push(verdict)
    groups.set(key, group)
  }

  const reviewers: ReviewerStrictness[] = [...groups.values()]
    .sort((a, b) => compareText(a.role, b.role) || compareText(a.model, b.model))
    .map(({ role, model, verdicts }) => {
      const approved = verdicts.filter((v) => v.outcome === 'approved')
      const changesRequested = verdicts.filter((v) => v.outcome === 'changes_requested')
      const findings: VerdictFindings[] = [
        { verdict: 'approved' as const, bySeverity: bySeverityOf(approved.flatMap((v) => v.findings)) },
        {
          verdict: 'changes_requested' as const,
          bySeverity: bySeverityOf(changesRequested.flatMap((v) => v.findings))
        }
      ]
      return {
        role,
        model,
        verdictsRead: verdicts.length,
        approved: approved.length,
        changesRequested: changesRequested.length,
        findings
      }
    })

  return { reviewers, coverage: buildCoverage(dataset, lowTrust, used, unknowns) }
}
