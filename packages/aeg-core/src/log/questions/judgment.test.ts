import { describe, expect, it } from 'vitest'
import { buildExecution, buildExecutions, type ExecutionName } from '../fixtures'
import { createMemoryCache, normalizeStoredLine } from '../sync'
import type { Dataset } from '../sync'
import { reviewerStrictness } from './judgment'

/**
 * Question 2 over the fixture executions. Every expected value below is
 * written by hand from the scenario each execution tells
 * (`../fixtures/executions.ts`) — never produced by the query under test.
 * The question reads each round's `verdicts_read` event:
 * - `green-one-round` approves with no findings and no per-reviewer entries,
 *   so no role can be read from it;
 * - `three-rounds-recurring-finding` asks for changes twice on the
 *   code-review scale (round 1: the MAJOR, blocking `fnd-auth-1`; round 2: it
 *   again beside the MINOR, non-blocking `fnd-docs-2`), then round 3 carries
 *   per-reviewer entries — code-reviewer and security both approve;
 * - `paused-and-resumed` asks for changes once: the MAJOR, blocking `fnd-q-1`
 *   on the code-review scale, beside the LOW, non-blocking `fnd-sec-3` on the
 *   security scale — the round did not approve and security blocked nothing,
 *   so security has no verdict there and that finding is unattributed — then
 *   approves with no findings and no entries, which reads no role.
 */

function datasetOf(lines: readonly string[]): Dataset {
  const cache = createMemoryCache()
  for (const [position, raw] of lines.entries()) {
    cache.put(normalizeStoredLine(raw, { source: 'fixtures', position: String(position) }))
  }
  return cache.dataset()
}

function rawLines(name: ExecutionName): string[] {
  return buildExecution(name).lines.map((line) => line.raw)
}

function allFixtures(): Dataset {
  return datasetOf(buildExecutions().flatMap((execution) => execution.lines.map((line) => line.raw)))
}

const BOTH_SCALES_ENTRIES = [
  { role: 'code-reviewer', outcome: 'approve', blockers: 0 },
  { role: 'security', outcome: 'changes_requested', blockers: 1 }
]

/** `paused-and-resumed` with its round 1 `verdicts_read` line rewritten by `change`. */
function pausedWith(change: (payload: Record<string, unknown>) => void): Dataset {
  return datasetOf(
    rawLines('paused-and-resumed').map((raw) => {
      const object = JSON.parse(raw)
      if (object.event === 'verdicts_read' && object.round === 1) change(object)
      return JSON.stringify(object)
    })
  )
}

describe('question 2 — are reviewers strict', () => {
  const answer = reviewerStrictness(allFixtures())

  it('reads both reviewer roles from the rounds, approved and changes requested', () => {
    expect(answer.reviewers).toEqual([
      {
        role: 'code-reviewer',
        verdictsRead: 4,
        approved: 1,
        changesRequested: 3,
        findings: [
          { verdict: 'approved', bySeverity: [] },
          {
            verdict: 'changes_requested',
            bySeverity: [
              { severity: 'MAJOR', findings: 3, blockers: 3 },
              { severity: 'MINOR', findings: 1, blockers: 0 }
            ]
          }
        ]
      },
      {
        role: 'security',
        verdictsRead: 1,
        approved: 1,
        changesRequested: 0,
        findings: [
          { verdict: 'approved', bySeverity: [] },
          { verdict: 'changes_requested', bySeverity: [] }
        ]
      }
    ])
  })

  it('states its coverage: the rounds it attributed, the rounds and findings it could not', () => {
    expect(answer.coverage).toEqual({
      rowsRead: 93,
      lowTrustLeftOut: 3,
      unitUnknown: 0,
      // verdicts_read: 1 (green) + 3 (three-rounds) + 2 (paused); escalated-handoff has none.
      rowsUsed: 6,
      gaps: 0,
      quarantined: 2,
      unknowns: [],
      // attributed: three-rounds 1, 2, 3 and paused 1; unattributed: green 1 and paused 2.
      roundsAttributed: 4,
      roundsUnattributed: 2,
      // paused round 1's security finding: that round gave security no verdict.
      findingsUnattributed: 1
    })
  })

  it("lets a round's per-reviewer entries win over the scale", () => {
    const answer = reviewerStrictness(
      pausedWith((line) => {
        line.reviewers = BOTH_SCALES_ENTRIES
      })
    )
    // Round 1: code-reviewer approves (despite its blocking finding), security asks for changes (despite its non-blocking one).
    expect(answer.reviewers).toEqual([
      {
        role: 'code-reviewer',
        verdictsRead: 1,
        approved: 1,
        changesRequested: 0,
        findings: [
          { verdict: 'approved', bySeverity: [{ severity: 'MAJOR', findings: 1, blockers: 1 }] },
          { verdict: 'changes_requested', bySeverity: [] }
        ]
      },
      {
        role: 'security',
        verdictsRead: 1,
        approved: 0,
        changesRequested: 1,
        findings: [
          { verdict: 'approved', bySeverity: [] },
          { verdict: 'changes_requested', bySeverity: [{ severity: 'LOW', findings: 1, blockers: 0 }] }
        ]
      }
    ])
    expect(answer.coverage).toMatchObject({ roundsAttributed: 1, roundsUnattributed: 1, findingsUnattributed: 0 })
  })

  it('reads a role that was not reviewed as no verdict', () => {
    const answer = reviewerStrictness(
      pausedWith((line) => {
        line.reviewers = [
          { role: 'code-reviewer', outcome: 'changes_requested', blockers: 1 },
          { role: 'security', outcome: 'not_reviewed', blockers: 0 }
        ]
      })
    )
    expect(answer.reviewers.map((r) => [r.role, r.verdictsRead])).toEqual([['code-reviewer', 1]])
    expect(answer.coverage).toMatchObject({ findingsUnattributed: 1 })
  })

  it('counts a finding with no severity scale as unattributed, never as a role', () => {
    const answer = reviewerStrictness(
      pausedWith((line) => {
        for (const f of line.findings as Array<Record<string, unknown>>) delete f.severity_scale
      })
    )
    expect(answer.reviewers).toEqual([])
    expect(answer.coverage).toMatchObject({ roundsAttributed: 0, roundsUnattributed: 2, findingsUnattributed: 2 })
  })
})

describe('question 2 — what it refuses to guess', () => {
  it('never reports whether a reviewer was right — only counts', () => {
    const answer = reviewerStrictness(allFixtures())
    for (const key of Object.keys(answer.reviewers[0] as object)) {
      expect(key).not.toMatch(/correct|right|good|strict|lenient/i)
    }
  })

  it('never reads a dispatch outcome: a verdict there adds nothing', () => {
    const answer = reviewerStrictness(datasetOf(rawLines('escalated-handoff')))
    expect(answer.reviewers).toEqual([])
    expect(answer.coverage).toMatchObject({ rowsUsed: 0, roundsAttributed: 0, roundsUnattributed: 0 })
  })

  it('leaves low-trust rows out of every figure and counts them', () => {
    const lowTrust = rawLines('green-one-round').map((raw) => {
      const object = JSON.parse(raw)
      object.meta.vinaya = '0.30.1'
      return JSON.stringify(object)
    })
    const answer = reviewerStrictness(datasetOf([...lowTrust, ...rawLines('escalated-handoff')]))
    expect(answer.reviewers).toEqual([])
    expect(answer.coverage).toMatchObject({ lowTrustLeftOut: 12, rowsRead: 20, rowsUsed: 0, roundsUnattributed: 0 })
  })

  it('counts rows with no unit out loud and builds no reviewer from them', () => {
    const noUnit = rawLines('three-rounds-recurring-finding').map((raw) => {
      const object = JSON.parse(raw)
      object.meta.work.ref = null
      return JSON.stringify(object)
    })
    const answer = reviewerStrictness(datasetOf(noUnit))
    expect(answer.reviewers).toEqual([])
    expect(answer.coverage).toMatchObject({ unitUnknown: 3, rowsUsed: 0 })
  })

  it('reports a single round with no findings and no entries as unattributed, not as an approval', () => {
    const answer = reviewerStrictness(datasetOf(rawLines('green-one-round')))
    expect(answer.reviewers).toEqual([])
    expect(answer.coverage).toMatchObject({ rowsUsed: 1, roundsAttributed: 0, roundsUnattributed: 1 })
  })
})
