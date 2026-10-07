/**
 * Question 2 — are reviewers strict? (`apps/cli/specs/log-sync.md`, "The
 * questions".) For each reviewer role, the verdicts a round's `verdicts_read`
 * event recorded and how they read, and the findings and blockers those
 * rounds carried, by severity. A role comes from the round's own per-reviewer
 * entries where it has them, and from each finding's severity scale where it
 * does not. The answer counts what a round stated — a finding's
 * `policy_treatment: 'blocking'` as a blocker — and never scores whether a
 * reviewer was right to decide as it did.
 */

import type { Dataset, DatasetRow } from '../sync'
import type { Coverage } from './common'
import {
  booleanField,
  buildCoverage,
  compareText,
  groupBy,
  objectArrayField,
  rowsOfKinds,
  textOf,
  trustedRows
} from './common'

const JUDGMENT_KINDS = ['dev_review_loop']
/** The reviewer role each severity scale belongs to. A scale not listed here names no role. */
const ROLE_OF_SCALE: Readonly<Record<string, string>> = { 'code-review': 'code-reviewer', security: 'security' }

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
  verdictsRead: number
  approved: number
  changesRequested: number
  /** Ascending: `'approved'` then `'changes_requested'`. */
  findings: VerdictFindings[]
}

/** What the answer states about how far it could attribute the rounds it read. */
export type JudgmentCoverage = Coverage & {
  /** Rounds in which at least one reviewer role could be given a verdict. */
  roundsAttributed: number
  /** Rounds in which no reviewer role could be given a verdict. */
  roundsUnattributed: number
  /** Findings read that no role's verdict could carry: no known severity scale, or a role with no verdict in its round. */
  findingsUnattributed: number
}

export type JudgmentAnswer = {
  /** Ascending by role. */
  reviewers: ReviewerStrictness[]
  coverage: JudgmentCoverage
}

type FindingFact = { severity: string; blocking: boolean; role: string | null }

type RoleVerdict = { outcome: 'approved' | 'changes_requested'; findings: FindingFact[] }

function findingsOf(row: DatasetRow): FindingFact[] {
  const out: FindingFact[] = []
  for (const item of objectArrayField(row, 'findings')) {
    const severity = textOf(item, 'severity')
    if (severity === null) continue
    const scale = textOf(item, 'severity_scale')
    out.push({
      severity,
      blocking: item.policy_treatment === 'blocking',
      role: scale === null ? null : (ROLE_OF_SCALE[scale] ?? null)
    })
  }
  return out
}

/** The verdict each role gave in one `verdicts_read` round, and the findings no verdict could carry. */
function roundVerdicts(row: DatasetRow): { verdicts: Map<string, RoleVerdict>; unattributed: number } {
  const findings = findingsOf(row)
  const verdicts = new Map<string, RoleVerdict>()
  const entries = objectArrayField(row, 'reviewers')
  if (entries.length > 0) {
    // The round's own per-reviewer entries win over the scale.
    for (const entry of entries) {
      const role = textOf(entry, 'role')
      const outcome = textOf(entry, 'outcome')
      if (role === null) continue
      if (outcome === 'approve') verdicts.set(role, { outcome: 'approved', findings: [] })
      else if (outcome === 'changes_requested') verdicts.set(role, { outcome: 'changes_requested', findings: [] })
    }
  } else {
    const approved = booleanField(row, 'all_approve') === true
    for (const role of new Set(findings.flatMap((f) => (f.role === null ? [] : [f.role])))) {
      if (findings.some((f) => f.role === role && f.blocking))
        verdicts.set(role, { outcome: 'changes_requested', findings: [] })
      else if (approved) verdicts.set(role, { outcome: 'approved', findings: [] })
    }
  }
  let unattributed = 0
  for (const f of findings) {
    const verdict = f.role === null ? undefined : verdicts.get(f.role)
    if (verdict) verdict.findings.push(f)
    else unattributed++
  }
  return { verdicts, unattributed }
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

/** Question 2: verdicts, and their findings and blockers by severity, by reviewer role. */
export function reviewerStrictness(dataset: Dataset): JudgmentAnswer {
  const { rows, lowTrust } = trustedRows(dataset)
  const used = rowsOfKinds(
    rows.filter((row) => row.event === 'verdicts_read'),
    JUDGMENT_KINDS
  )

  const byRole = new Map<string, RoleVerdict[]>()
  let roundsAttributed = 0
  let roundsUnattributed = 0
  let findingsUnattributed = 0
  for (const row of used.withUnit) {
    const { verdicts, unattributed } = roundVerdicts(row)
    findingsUnattributed += unattributed
    if (verdicts.size === 0) roundsUnattributed++
    else roundsAttributed++
    for (const [role, verdict] of verdicts) byRole.set(role, [...(byRole.get(role) ?? []), verdict])
  }

  const reviewers: ReviewerStrictness[] = [...byRole]
    .sort(([a], [b]) => compareText(a, b))
    .map(([role, verdicts]) => {
      const approved = verdicts.filter((v) => v.outcome === 'approved')
      const changesRequested = verdicts.filter((v) => v.outcome === 'changes_requested')
      return {
        role,
        verdictsRead: verdicts.length,
        approved: approved.length,
        changesRequested: changesRequested.length,
        findings: [
          { verdict: 'approved' as const, bySeverity: bySeverityOf(approved.flatMap((v) => v.findings)) },
          {
            verdict: 'changes_requested' as const,
            bySeverity: bySeverityOf(changesRequested.flatMap((v) => v.findings))
          }
        ]
      }
    })

  return {
    reviewers,
    coverage: {
      ...buildCoverage(dataset, lowTrust, used, []),
      roundsAttributed,
      roundsUnattributed,
      findingsUnattributed
    }
  }
}
