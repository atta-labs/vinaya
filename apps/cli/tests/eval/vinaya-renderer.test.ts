// The Vinaya renderer's two directions: rendering a neutral case into Vinaya
// process input or refusing it naming the field, and extracting each neutral
// outcome from a Vinaya trial record through one mapping table per name
// translation, never defaulting a missing fact to a passing value.
import { describe, expect, it } from 'bun:test'
import { parseIssueSurface } from '@attalabs/aeg-core'
import { KIND_FIELDS, type NeutralCase, NEUTRAL_CASE_KINDS } from '../../src/lib/dev-review-eval/neutral-case'
import { OUTCOME_NAMES } from '../../src/lib/dev-review-eval/neutral-outcomes'
import {
  extractOutcomes,
  FIELD_DISPOSITIONS,
  MAPPING_LOGIC,
  MAPPING_TABLES,
  READ_ONLY_BUILTINS,
  renderCase,
  rendererVersionOf,
  SEVERITY_BLOCKING,
  TOOL_CAPABILITIES,
  VINAYA_RENDERER_VERSION,
  type VinayaTrialRecord
} from '../../src/lib/dev-review-eval/vinaya-renderer'
import { REVIEWER_ROLES, REVIEWER_SEVERITIES } from '../../src/lib/review-result'
import { ROLE_TOOL_GRANTS } from '../../src/lib/task-tools/role-grants'
import {
  type FixtureEntry,
  loadFixture,
  referenceRecord,
  renderOrThrow,
  reviewOutput,
  turnResult
} from './vinaya-trial-records'

const fixture = loadFixture()
const entryOf = (id: string) => fixture.find((e) => e.case.id === id) as FixtureEntry
const changeEntry = entryOf('change-week-dates')
const reviewEntry = entryOf('review-session-expiry')
const loopEntry = entryOf('loop-cache-eviction')

function refusalOf(raw: unknown) {
  const rendered = renderCase(raw)
  if (rendered.ok) throw new Error('expected a refusal')
  return rendered.refusal
}

const withCase = (entry: FixtureEntry, patch: Record<string, unknown>) => ({ ...structuredClone(entry.case), ...patch })

function outcomesOf(record: VinayaTrialRecord) {
  const extracted = extractOutcomes(record)
  if (!extracted.ok) throw new Error(`extract refused: ${JSON.stringify(extracted.refusal)}`)
  return extracted.outcomes
}

const reference = (entry: FixtureEntry) => referenceRecord(entry, renderOrThrow(entry.case))

describe('render', () => {
  it('writes the authorized scope as the brief Surface that Vinaya parses back', () => {
    const input = renderOrThrow(changeEntry.case)
    expect(input.surface).toEqual({ in: ['src/parse/**', 'tests/parse'], out: ['.github/**', 'scripts'] })
    const parsed = parseIssueSurface(input.brief)
    expect(parsed.ok && parsed.value).toEqual(input.surface)
  })

  it('writes the relevant delivered documents as the Documentation section, and delivers the rest unrequired', () => {
    const input = renderOrThrow(changeEntry.case)
    expect(input.brief).toContain('## Documentation\n\n- iso-week-dates\n')
    expect(input.brief).not.toContain('- style-guide')
    expect(input.sources.map((s) => [s.sourceId, s.required])).toEqual([
      ['iso-week-dates', true],
      ['style-guide', false]
    ])
    expect(input.sources[0]?.contentDigest).toBe(changeEntry.case.deliveredDocuments[0]?.contentDigest as string)
  })

  it('writes the task statement as the one objective and the goal', () => {
    const input = renderOrThrow(changeEntry.case)
    expect(input.objectives).toEqual([{ id: 'O1', text: changeEntry.case.taskStatement }])
    expect(input.brief).toContain(`O1. ${changeEntry.case.taskStatement}`)
    expect(input.brief.startsWith(`**Goal:** ${changeEntry.case.taskStatement}`)).toBe(true)
  })

  it('grants each dispatched role exactly the tools of the granted capabilities it may hold', () => {
    const change = renderOrThrow(changeEntry.case)
    expect(Object.keys(change.roleToolGrants)).toEqual(['developer'])
    // `read_source` exercises `read_document` too, but only a reviewer is granted it.
    expect(change.roleToolGrants.developer).toEqual([
      'Edit',
      'Glob',
      'Grep',
      'Read',
      'Write',
      'fetch_documentation',
      'open_pull_request',
      'publish_changes',
      'shell'
    ])
    const review = renderOrThrow(reviewEntry.case)
    expect(review.roleToolGrants).toEqual({
      'code-reviewer': ['Glob', 'Grep', 'Read', 'read_source'],
      security: ['Glob', 'Grep', 'Read', 'read_source']
    })
    const loop = renderOrThrow(loopEntry.case)
    expect(Object.keys(loop.roleToolGrants)).toEqual(['developer', 'code-reviewer', 'security'])
    for (const [role, tools] of Object.entries(loop.roleToolGrants)) {
      for (const tool of tools ?? []) {
        expect(loopEntry.case.grantedCapabilities).toContain(TOOL_CAPABILITIES[tool] as string)
        if (role !== 'developer')
          expect(ROLE_TOOL_GRANTS.security.includes(tool) || READ_ONLY_BUILTINS.includes(tool)).toBe(true)
      }
    }
  })

  it('pins the case, its intent and the renderer version in the process input', () => {
    const input = renderOrThrow(reviewEntry.case)
    expect(input.rendererVersion).toBe(VINAYA_RENDERER_VERSION)
    expect(input.caseId).toBe('review-session-expiry')
    expect(input.changeUnderReview).toEqual(
      reviewEntry.case.kind === 'review' ? reviewEntry.case.changeUnderReview : null
    )
    expect(input.briefHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('gives every field of every kind a disposition, and every case field one in its input', () => {
    const common = [
      'id',
      'layer',
      'kind',
      'repository',
      'baseRevision',
      'taskStatement',
      'authorizedScope',
      'deliveredDocuments',
      'grantedCapabilities'
    ]
    const all = [...common, ...NEUTRAL_CASE_KINDS.flatMap((kind) => KIND_FIELDS[kind])]
    expect([...new Set(all)].sort()).toEqual(Object.keys(FIELD_DISPOSITIONS).sort())
    for (const entry of fixture) {
      const input = renderOrThrow(entry.case)
      expect(Object.keys(input.dispositions).sort()).toEqual(Object.keys(entry.case).sort())
    }
    expect(FIELD_DISPOSITIONS.hiddenTests).toBe('withheld')
    expect(FIELD_DISPOSITIONS.plantedDefects).toBe('withheld')
    expect(FIELD_DISPOSITIONS.layer).toBe('inapplicable')
  })
})

describe('render refuses a case it cannot express, naming the field', () => {
  const cases: [string, unknown, string][] = [
    ['an invalid case', withCase(changeEntry, { baseRevision: 'nope' }), 'baseRevision'],
    [
      'a file glob in scope',
      withCase(changeEntry, { authorizedScope: { in: ['src/parse/week.ts'], protected: [] } }),
      'authorizedScope.in.0'
    ],
    [
      'a wildcard inside a segment',
      withCase(changeEntry, { authorizedScope: { in: ['src/*/parse'], protected: [] } }),
      'authorizedScope.in.0'
    ],
    [
      'a single-level wildcard',
      withCase(changeEntry, { authorizedScope: { in: ['src/parse/*'], protected: [] } }),
      'authorizedScope.in.0'
    ],
    [
      'a protected file',
      withCase(changeEntry, { authorizedScope: { in: ['src'], protected: ['package.json'] } }),
      'authorizedScope.protected.0'
    ],
    [
      'protected inside scope',
      withCase(changeEntry, { authorizedScope: { in: ['src/**'], protected: ['src/secrets/**'] } }),
      'authorizedScope.protected.0'
    ],
    [
      'scope inside protected',
      withCase(changeEntry, { authorizedScope: { in: ['src/parse'], protected: ['src'] } }),
      'authorizedScope.protected.0'
    ],
    [
      'a document id with a space',
      withCase(changeEntry, {
        deliveredDocuments: [{ id: 'iso week', contentDigest: 'a'.repeat(64), relevant: true }]
      }),
      'deliveredDocuments.0.id'
    ],
    [
      'a review case requiring a document',
      withCase(reviewEntry, {
        deliveredDocuments: [{ id: 'standards', contentDigest: 'a'.repeat(64), relevant: true }]
      }),
      'deliveredDocuments.0.relevant'
    ],
    [
      'a capability no tool exercises',
      withCase(changeEntry, { grantedCapabilities: ['publish_change', 'open_change_request', 'network'] }),
      'grantedCapabilities.2'
    ],
    [
      'a review case granting a write',
      withCase(reviewEntry, { grantedCapabilities: ['read_file', 'write_file'] }),
      'grantedCapabilities.1'
    ],
    [
      'a change case that cannot publish',
      withCase(changeEntry, { grantedCapabilities: ['read_file', 'write_file'] }),
      'grantedCapabilities'
    ],
    [
      'a multi-line statement',
      withCase(changeEntry, { taskStatement: 'Fix the parser.\n## Keep every old format' }),
      'taskStatement'
    ]
  ]
  for (const [what, raw, field] of cases) {
    it(`refuses ${what} at ${field}`, () => {
      const refusal = refusalOf(raw)
      expect(refusal.field).toBe(field)
      expect(refusal.code).toBe(field === 'baseRevision' ? 'invalid_case' : 'unexpressible')
      expect(refusal.detail.length).toBeGreaterThan(0)
    })
  }
})

describe('the mapping tables', () => {
  it('read every reviewer severity as blocking in one table: the two most severe ranks of each scale', () => {
    expect(SEVERITY_BLOCKING).toEqual({
      'code-reviewer': { BLOCKER: true, MAJOR: true, MINOR: false },
      'security-reviewer': { CRITICAL: true, HIGH: true, MEDIUM: false, LOW: false }
    })
    for (const role of REVIEWER_ROLES) {
      const order = REVIEWER_SEVERITIES[role]
      for (const severity of order) expect(SEVERITY_BLOCKING[role][severity]).toBe(order.indexOf(severity) <= 1)
    }
  })

  it('names a neutral capability for every tool any role is granted', () => {
    for (const tool of Object.values(ROLE_TOOL_GRANTS).flat()) expect(TOOL_CAPABILITIES[tool]).toBeDefined()
  })
})

describe('extract', () => {
  it('returns every neutral outcome, inapplicable where the kind has no such fact', () => {
    const change = outcomesOf(reference(changeEntry))
    expect(Object.keys(change).sort()).toEqual([...OUTCOME_NAMES].sort())
    expect(change['O-review'].status).toBe('inapplicable')
    expect(change['O-decision'].status).toBe('inapplicable')
    expect(change['O-evidence'].status).toBe('inapplicable')
    const review = outcomesOf(reference(reviewEntry))
    for (const name of ['O-change', 'O-tests', 'O-scope', 'O-evidence', 'O-decision'] as const) {
      expect(review[name].status).toBe('inapplicable')
    }
  })

  it('reads the beyond-Surface record as the recorded out-of-scope paths', () => {
    const outcomes = outcomesOf(reference(changeEntry))
    expect(outcomes['O-scope']).toEqual({
      status: 'known',
      value: { recordedOutOfScopePaths: ['docs/parse-notes.md'] }
    })
  })

  it('reports a body without the beyond-Surface record, or no pull request, as absent', () => {
    const record = reference(changeEntry)
    const bare = {
      ...record,
      pullRequest: { ...(record.pullRequest as NonNullable<VinayaTrialRecord['pullRequest']>), body: 'No record.' }
    }
    expect(outcomesOf(bare)['O-scope'].status).toBe('absent')
    const none = outcomesOf({ ...record, pullRequest: null })
    expect(none['O-scope'].status).toBe('absent')
    expect(none['O-change'].status).toBe('absent')
  })

  it('reads each finding severity through the severity table', () => {
    const outcomes = outcomesOf(reference(reviewEntry))
    const review = outcomes['O-review']
    expect(review.status).toBe('known')
    if (review.status !== 'known') return
    expect(review.value.reviews.map((r) => [r.reviewer, r.findings])).toEqual([
      [
        'code-reviewer',
        [
          { file: 'src/auth/session.ts', blocking: true },
          { file: 'docs/changelog.md', blocking: false }
        ]
      ],
      ['security-reviewer', [{ file: 'src/auth/session.ts', blocking: false }]]
    ])
    expect(review.value.reviews[0]?.intentVersion).toBe(renderOrThrow(reviewEntry.case).intentVersion)
  })

  it('reports an off-scale severity, a crossed role or a crossed head as an invalid review outcome', () => {
    const record = reference(reviewEntry)
    const reviews = record.reviews as NonNullable<VinayaTrialRecord['reviews']>
    const head = reviews[0]?.binding.headSha as string
    const variants = [
      reviewOutput('code-reviewer', head, [{ file: 'src/auth/session.ts', severity: 'HIGH' }]),
      reviewOutput('security-reviewer', head, []),
      reviewOutput('code-reviewer', 'c'.repeat(40), []),
      { reviewResult: { status: 'completed' } }
    ]
    for (const output of variants) {
      const bad = {
        ...record,
        reviews: [{ ...(reviews[0] as (typeof reviews)[number]), output }, reviews[1] as (typeof reviews)[number]]
      }
      expect(outcomesOf(bad)['O-review'].status).toBe('invalid')
    }
  })

  it('leaves out a blocked review, and binds a review of another brief to another intent', () => {
    const record = reference(loopEntry)
    const reviews = record.reviews as NonNullable<VinayaTrialRecord['reviews']>
    const first = reviews[0] as (typeof reviews)[number]
    const blocked = {
      reviewResult: {
        schemaVersion: 1,
        role: first.role,
        headSha: first.binding.headSha,
        manifestDigest: 'f'.repeat(64),
        summary: 'Could not read the diff.',
        status: 'blocked',
        blocker: { kind: 'diff_unavailable', detail: 'The diff was empty.' }
      }
    }
    const withBlocked = outcomesOf({ ...record, reviews: [{ ...first, output: blocked }, reviews[1] as typeof first] })[
      'O-review'
    ]
    expect(withBlocked.status === 'known' && withBlocked.value.reviews.map((r) => r.reviewer)).toEqual([
      'security-reviewer'
    ])
    const otherBrief = outcomesOf({
      ...record,
      reviews: [{ ...first, binding: { ...first.binding, briefHash: 'd'.repeat(64) } }]
    })['O-review']
    expect(otherBrief.status === 'known' && otherBrief.value.reviews[0]?.intentVersion).toBe('d'.repeat(64))
  })

  it('reads source uses and counted receipts as the sources outcome', () => {
    const record = reference(changeEntry)
    const outcomes = outcomesOf(record)
    expect(outcomes['O-sources']).toEqual({
      status: 'known',
      value: {
        receipts: changeEntry.case.deliveredDocuments.map((d) => ({
          documentId: d.id,
          contentDigest: d.contentDigest
        })),
        claimed: ['iso-week-dates']
      }
    })
    const receipts = record.receipts as NonNullable<VinayaTrialRecord['receipts']>
    const refused = outcomesOf({ ...record, receipts: receipts.map((r) => ({ ...r, decision: 'refused' as const })) })
    expect(refused['O-sources'].status === 'known' && refused['O-sources'].value.receipts).toEqual([])
    const malformed = outcomesOf({ ...record, receipts: receipts.map((r) => ({ ...r, deliveredDigest: 'abc' })) })
    expect(malformed['O-sources'].status).toBe('invalid')
    expect(outcomesOf({ ...record, developerTurnResult: { turnResult: {} } })['O-sources'].status).toBe('invalid')
    expect(outcomesOf({ ...record, developerTurnResult: null })['O-sources'].status).toBe('absent')
    expect(outcomesOf({ ...record, developerTurnResult: turnResult(['undelivered']) })['O-sources']).toMatchObject({
      status: 'known',
      value: { claimed: ['undelivered'] }
    })
  })

  it('reads traced tools as neutral capabilities through the capability table', () => {
    const record = reference(changeEntry)
    expect(outcomesOf(record)['O-capability']).toEqual({
      status: 'known',
      value: {
        used: ['read_file', 'read_document', 'write_file', 'run_commands', 'publish_change', 'open_change_request']
      }
    })
    expect(outcomesOf({ ...record, trace: [{ tool: 'WebFetch' }] })['O-capability'].status).toBe('invalid')
  })

  it('reads the ready-for-merge result as the decision, and its absence as no decision', () => {
    const record = reference(loopEntry)
    expect(outcomesOf(record)['O-decision']).toEqual({
      status: 'known',
      value: {
        id: 'loop-cache-eviction-ready',
        outcome: 'ready',
        evidenceId: 'loop-cache-eviction-evidence',
        reviewIds: ['loop-cache-eviction-code-reviewer', 'loop-cache-eviction-security-reviewer']
      }
    })
    expect(outcomesOf({ ...record, readyForMerge: null })['O-decision']).toEqual({
      status: 'absent',
      reason: 'no ready-for-merge result: no Decision'
    })
  })

  it('maps check conclusions and refuses an unknown one as invalid evidence', () => {
    const record = reference(loopEntry)
    const evidence = outcomesOf(record)['O-evidence']
    expect(evidence.status === 'known' && evidence.value.checks.map((c) => c.result)).toEqual(['pass', 'pending'])
    const checks = record.checks as NonNullable<VinayaTrialRecord['checks']>
    const odd = { ...record, checks: { ...checks, checks: [{ name: 'ci', required: true, conclusion: 'neutral' }] } }
    expect(outcomesOf(odd)['O-evidence'].status).toBe('invalid')
  })

  it('reports an unobserved fact as unavailable, never as a value', () => {
    const outcomes = outcomesOf({
      ...reference(loopEntry),
      trace: undefined,
      hiddenTests: undefined,
      effects: undefined
    })
    for (const name of ['O-capability', 'O-tests', 'O-effects'] as const)
      expect(outcomes[name].status).toBe('unavailable')
  })
})

describe('the renderer version', () => {
  it('is carried by every extraction, and a record of another version is refused', () => {
    const record = reference(changeEntry)
    const extracted = extractOutcomes(record)
    expect(extracted.ok && extracted.rendererVersion).toBe(VINAYA_RENDERER_VERSION)
    expect(VINAYA_RENDERER_VERSION).toMatch(/^1:[0-9a-f]{64}$/)
    const stale = extractOutcomes({ ...record, rendererVersion: '1:old' })
    expect(!stale.ok && stale.refusal).toMatchObject({ code: 'stale_renderer', field: 'rendererVersion' })
    const staleInput = extractOutcomes({ ...record, input: { ...record.input, rendererVersion: '1:old' } })
    expect(!staleInput.ok && staleInput.refusal).toMatchObject({
      code: 'stale_renderer',
      field: 'input.rendererVersion'
    })
  })

  it('changes when a mapping table or a mapping function changes', () => {
    expect(rendererVersionOf(MAPPING_TABLES, MAPPING_LOGIC)).toBe(VINAYA_RENDERER_VERSION)
    const severity = rendererVersionOf(
      {
        ...MAPPING_TABLES,
        SEVERITY_BLOCKING: { ...SEVERITY_BLOCKING, 'code-reviewer': { BLOCKER: true, MAJOR: false, MINOR: false } }
      },
      MAPPING_LOGIC
    )
    expect(severity).not.toBe(VINAYA_RENDERER_VERSION)
    const logic = rendererVersionOf(MAPPING_TABLES, [...MAPPING_LOGIC.slice(1), (c: NeutralCase) => c.id])
    expect(logic).not.toBe(VINAYA_RENDERER_VERSION)
  })
})
