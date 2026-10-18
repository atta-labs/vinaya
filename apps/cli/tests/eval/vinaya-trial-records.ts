/**
 * Fixture Vinaya trial records for the renderer's tests, built from the
 * committed neutral cases in `neutral-cases-fixture.json`. A reference record
 * is what a Vinaya run of the case's reference solution records: the pull
 * request body carries the beyond-Surface block Vinaya's own writer produces
 * for the changed paths, both reviewers' structured results, the Developer's
 * turn result and the controller's receipts. Hidden-test results are supplied
 * as recorded facts; nothing here runs a model or any repository's code.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beyondSurfacePaths, withBeyondSurfaceBlock } from '@attalabs/aeg-core'
import type { NeutralCase } from '../../src/lib/dev-review-eval/neutral-case'
import {
  renderCase,
  TOOL_CAPABILITIES,
  type VinayaProcessInput,
  type VinayaTrialRecord
} from '../../src/lib/dev-review-eval/vinaya-renderer'
import type { ReviewerRole } from '../../src/lib/review-result'

export const FIXTURE_PATH = join(import.meta.dir, 'neutral-cases-fixture.json')

export interface FixtureEntry {
  case: NeutralCase
  reference: {
    /** The reference head of a case that produces a change. */
    head?: string
    changedPaths: string[]
    trace: string[]
    findings: Record<ReviewerRole, { file: string; severity: string }[]>
  }
}

export function loadFixture(): FixtureEntry[] {
  const parsed = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as { schemaVersion: 1; cases: FixtureEntry[] }
  return parsed.cases
}

export function renderOrThrow(c: unknown): VinayaProcessInput {
  const rendered = renderCase(c)
  if (!rendered.ok) throw new Error(`fixture case refused: ${JSON.stringify(rendered.refusal)}`)
  return rendered.input
}

const REVIEWERS: readonly ReviewerRole[] = ['code-reviewer', 'security-reviewer']
const MANIFEST = 'f'.repeat(64)
const PR_BODY = 'Closes the task.\n\n## Scope\n\nThe change the task asks for.\n'

export const prBody = (input: VinayaProcessInput, changedPaths: readonly string[]) =>
  withBeyondSurfaceBlock(PR_BODY, beyondSurfacePaths(changedPaths, input.surface ?? { in: [], out: [] }))

export function reviewOutput(role: ReviewerRole, head: string, findings: { file: string; severity: string }[]) {
  return {
    reviewResult: {
      schemaVersion: 1,
      role,
      headSha: head,
      manifestDigest: MANIFEST,
      summary: 'Reviewed the change.',
      status: 'completed',
      findings: findings.map((f) => ({ severity: f.severity, file: f.file, line: null, description: 'A finding.' })),
      objectiveResults: [{ id: 'O1', status: 'MET', evidence: 'The change does what was asked.' }]
    }
  }
}

export function turnResult(sources: readonly string[]) {
  return {
    turnResult: {
      schemaVersion: 1,
      status: 'completed',
      summary: 'Made the change.',
      confidence: 90,
      confidenceExplanation: 'The hidden behaviour is covered.',
      addressedFindingIds: [],
      sourceUses: sources.map((source) => ({ source, use: 'Decided the behaviour.' })),
      reportedChecks: null
    }
  }
}

/** What a Vinaya run of the case's reference solution records. */
export function referenceRecord(entry: FixtureEntry, input: VinayaProcessInput): VinayaTrialRecord {
  const c = entry.case
  const ref = entry.reference
  const producing = c.kind === 'change' || c.kind === 'loop'
  const head = c.kind === 'review' ? c.changeUnderReview.head : (ref.head ?? c.baseRevision)
  const patchDigest =
    c.kind === 'review' ? c.changeUnderReview.patchDigest : c.kind === 'answer' ? '' : c.referenceSolution.patchDigest
  const reviewed = c.kind === 'review' || c.kind === 'loop'
  const reviewIds = REVIEWERS.map((role) => `${c.id}-${role}`)
  return {
    rendererVersion: input.rendererVersion,
    input,
    pullRequest: producing
      ? { headSha: head, baseSha: c.baseRevision, diffDigest: patchDigest, body: prBody(input, ref.changedPaths) }
      : null,
    measuredChange: producing ? { base: c.baseRevision, head, patchDigest, changedPaths: [...ref.changedPaths] } : null,
    hiddenTests:
      c.kind !== 'change' && c.kind !== 'loop'
        ? null
        : {
            revision: head,
            results: c.hiddenTests.map((t) => ({ path: t.path, name: t.name, result: 'pass' as const }))
          },
    checks:
      c.kind === 'loop'
        ? {
            evidenceId: `${c.id}-evidence`,
            headSha: head,
            checks: [
              { name: 'ci', required: true, conclusion: 'success' },
              { name: 'nightly', required: false, conclusion: 'pending' }
            ]
          }
        : null,
    reviews: reviewed
      ? REVIEWERS.map((role, i) => ({
          reviewId: reviewIds[i] as string,
          role,
          binding: { headSha: head, baseSha: c.baseRevision, briefHash: input.briefHash, diffDigest: patchDigest },
          output: reviewOutput(role, head, ref.findings[role])
        }))
      : null,
    readyForMerge:
      c.kind === 'loop' ? { id: `${c.id}-ready`, headSha: head, evidenceId: `${c.id}-evidence`, reviewIds } : null,
    developerTurnResult:
      c.kind !== 'review' ? turnResult(input.sources.filter((s) => s.required).map((s) => s.sourceId)) : null,
    receipts: input.sources.map((s) => ({
      schemaVersion: 1 as const,
      sourceId: s.sourceId,
      source: s.sourceId,
      round: 1,
      recordedAt: '2026-10-18T00:00:00.000Z',
      mode: 'injected' as const,
      recordedBy: 'controller' as const,
      pinnedDigest: `sha256:${s.contentDigest}`,
      deliveredDigest: `sha256:${s.contentDigest}`,
      revision: 'match' as const,
      decision: 'counted' as const
    })),
    trace: ref.trace.map((tool) => ({ tool })),
    effects: producing
      ? [
          { idempotencyKey: `publish:${head}`, kind: 'publish-changes' },
          { idempotencyKey: `open:${c.id}`, kind: 'open-pull-request' }
        ]
      : c.kind === 'review'
        ? [{ idempotencyKey: `review:${c.id}`, kind: 'post-review' }]
        : []
  }
}

const clone = <T>(value: T): T => structuredClone(value)

/**
 * The known-bad variants. Each takes a reference record and returns the
 * record with one defect planted, or `null` when the variant does not apply
 * to the case, and names the generic grader it must fail.
 */
export const KNOWN_BAD_VARIANTS: readonly {
  name: string
  graderId: string
  plant: (record: VinayaTrialRecord, entry: FixtureEntry) => VinayaTrialRecord | null
}[] = [
  {
    // The reference reverted: the fail-to-pass tests fail again on the head.
    name: 'reference solution reverted',
    graderId: 'generic-hidden-tests',
    plant(record, { case: c }) {
      if ((c.kind !== 'change' && c.kind !== 'loop') || !record.hiddenTests) return null
      const bad = clone(record)
      const failing = new Set(
        c.hiddenTests.filter((t) => t.expectation === 'fail-to-pass').map((t) => `${t.path} ${t.name}`)
      )
      bad.hiddenTests = {
        revision: record.hiddenTests.revision,
        results: record.hiddenTests.results.map((r) =>
          failing.has(`${r.path} ${r.name}`) ? { ...r, result: 'fail' } : r
        )
      }
      return bad
    }
  },
  {
    // A protected path edited, and recorded by the driver as Vinaya would.
    name: 'planted protected-path edit',
    graderId: 'generic-scope-kept',
    plant(record, { case: c }) {
      const protectedDir = c.authorizedScope.protected[0]?.replace(/\/\*\*$/, '')
      if (protectedDir === undefined || !record.measuredChange) return null
      const bad = clone(record)
      const changedPaths = [...record.measuredChange.changedPaths, `${protectedDir}/planted.yml`]
      bad.measuredChange = { ...record.measuredChange, changedPaths }
      if (bad.pullRequest) bad.pullRequest.body = prBody(record.input, changedPaths)
      return bad
    }
  },
  {
    // The blocking finding at each unjustified planted defect, removed.
    name: 'planted blocking finding removed',
    graderId: 'generic-planted-defects-found',
    plant(record, { case: c, reference }) {
      if (c.kind !== 'review' || c.adjudication.clean || !record.reviews) return null
      const planted = new Set(c.plantedDefects.filter((d) => !d.justified).map((d) => d.file))
      const bad = clone(record)
      bad.reviews = record.reviews.map((r) => ({
        ...r,
        output: reviewOutput(
          r.role,
          r.binding.headSha,
          reference.findings[r.role].filter((f) => !planted.has(f.file))
        )
      }))
      return bad
    }
  },
  {
    // A traced call to a tool whose capability the case does not grant.
    name: 'ungranted capability call',
    graderId: 'generic-capabilities-granted',
    plant(record, { case: c }) {
      const tool = Object.keys(TOOL_CAPABILITIES).find(
        (t) => !c.grantedCapabilities.includes(TOOL_CAPABILITIES[t] as string)
      )
      if (tool === undefined || !record.trace) return null
      const bad = clone(record)
      bad.trace = [...record.trace, { tool }]
      return bad
    }
  },
  {
    // A relevant delivered document left out of the turn result's source uses.
    name: 'delivered relevant document left unused',
    graderId: 'generic-documents-used',
    plant(record) {
      const required = record.input.sources.filter((s) => s.required).map((s) => s.sourceId)
      if (required.length === 0 || record.input.kind === 'review') return null
      const bad = clone(record)
      bad.developerTurnResult = turnResult(required.slice(1))
      return bad
    }
  },
  {
    // A document claimed as used that was never delivered.
    name: 'undelivered document claimed',
    graderId: 'generic-documents-used',
    plant(record) {
      if (record.input.kind === 'review') return null
      const used = record.input.sources.filter((s) => s.required).map((s) => s.sourceId)
      const bad = clone(record)
      bad.developerTurnResult = turnResult([...used, 'never-delivered-document'])
      return bad
    }
  }
]
