// The neutral case: the validator accepts each kind with the fields it needs,
// refuses a missing or foreign field by name, and the digest identifies a case
// whatever its key order.
import { describe, expect, it } from 'bun:test'
import type { ContractRefusalCode, Validated } from '../../src/lib/dev-review-eval/contracts'
import {
  intentVersion,
  KIND_FIELDS,
  type NeutralCase,
  NEUTRAL_CASE_KINDS,
  neutralCaseDigest,
  validateNeutralCase
} from '../../src/lib/dev-review-eval/neutral-case'

const D = (c: string) => c.repeat(64)
const BASE = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)

function common(): Record<string, unknown> {
  return {
    id: 'iso-week-dates',
    layer: 'G',
    repository: 'example/dates',
    baseRevision: BASE,
    taskStatement: 'Make the date parser accept ISO week dates and keep every existing format working.',
    authorizedScope: { in: ['src/parse/**', 'tests/parse'], protected: ['.github/**'] },
    deliveredDocuments: [
      { id: 'iso-8601', contentDigest: D('1'), relevant: true },
      { id: 'style-guide', contentDigest: D('2'), relevant: false }
    ],
    grantedCapabilities: ['read_file', 'write_file', 'run_tests']
  }
}

const changeFields = () => ({
  hiddenTests: [
    { path: 'tests/parse/week.test.ts', name: 'parses 2026-W03-4', expectation: 'fail-to-pass' },
    { path: 'tests/parse/basic.test.ts', name: 'parses 2026-01-15', expectation: 'pass-to-pass' }
  ],
  referenceSolution: { patchDigest: D('3') }
})

const reviewFields = () => ({
  plantedDefects: [
    { file: 'src/parse/week.ts', kind: 'logic-error', blocking: true, critical: false, justified: false },
    { file: 'docs/notes.md', kind: 'out-of-scope-change', blocking: false, critical: false, justified: true }
  ],
  changeUnderReview: { base: BASE, head: HEAD, patchDigest: D('4') },
  adjudication: { clean: false, adjudicators: ['adjudicator-a', 'adjudicator-b'] }
})

function caseOf(kind: (typeof NEUTRAL_CASE_KINDS)[number]): Record<string, unknown> {
  return { ...common(), kind, ...(kind === 'review' ? reviewFields() : changeFields()) }
}

function accepted(input: unknown): NeutralCase {
  const result = validateNeutralCase(input)
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.refusal)}`)
  return result.value
}

function refused<T>(result: Validated<T>): { code: ContractRefusalCode; path: string } {
  if (result.ok) throw new Error('expected a refusal')
  return { code: result.refusal.code, path: result.refusal.path }
}

function without(input: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = structuredClone(input)
  delete copy[key]
  return copy
}

/** The same value with every object's keys in reverse order. */
function reversedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversedKeys)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .reverse()
        .map(([k, v]) => [k, reversedKeys(v)])
    )
  }
  return value
}

describe('neutral case validator', () => {
  it('accepts a change, a review and a loop case carrying every field its kind needs', () => {
    for (const kind of NEUTRAL_CASE_KINDS) {
      const value = accepted(caseOf(kind))
      expect(value.kind).toBe(kind)
      expect(value.layer).toBe('G')
      expect(value.authorizedScope).toEqual({ in: ['src/parse/**', 'tests/parse'], protected: ['.github/**'] })
      expect(value.deliveredDocuments.map((d) => d.relevant)).toEqual([true, false])
    }
    const review = accepted(caseOf('review'))
    if (review.kind !== 'review') throw new Error('expected a review case')
    expect(review.plantedDefects[0]).toEqual({
      file: 'src/parse/week.ts',
      kind: 'logic-error',
      blocking: true,
      critical: false,
      justified: false
    })
  })

  it('refuses a case missing any common field, naming it', () => {
    for (const kind of NEUTRAL_CASE_KINDS) {
      for (const key of Object.keys(common())) {
        expect({ kind, ...refused(validateNeutralCase(without(caseOf(kind), key))) }).toEqual({
          kind,
          code: 'missing_field',
          path: key
        })
      }
    }
    expect(refused(validateNeutralCase(without(caseOf('change'), 'kind')))).toEqual({
      code: 'missing_field',
      path: 'kind'
    })
  })

  it('refuses a case missing any field its kind requires, naming it', () => {
    for (const kind of NEUTRAL_CASE_KINDS) {
      for (const key of KIND_FIELDS[kind]) {
        expect({ kind, ...refused(validateNeutralCase(without(caseOf(kind), key))) }).toEqual({
          kind,
          code: 'missing_field',
          path: key
        })
      }
    }
  })

  it('refuses a missing field inside a nested value, naming its path', () => {
    const scope = caseOf('change')
    delete (scope.authorizedScope as Record<string, unknown>).protected
    expect(refused(validateNeutralCase(scope))).toEqual({ code: 'missing_field', path: 'authorizedScope.protected' })

    const document = caseOf('change')
    delete (document.deliveredDocuments as Record<string, unknown>[])[0]?.contentDigest
    expect(refused(validateNeutralCase(document))).toEqual({
      code: 'missing_field',
      path: 'deliveredDocuments.0.contentDigest'
    })

    for (const key of ['file', 'kind', 'blocking', 'critical', 'justified']) {
      const defect = caseOf('review')
      delete (defect.plantedDefects as Record<string, unknown>[])[0]?.[key]
      expect(refused(validateNeutralCase(defect))).toEqual({ code: 'missing_field', path: `plantedDefects.0.${key}` })
    }

    const change = caseOf('review')
    delete (change.changeUnderReview as Record<string, unknown>).patchDigest
    expect(refused(validateNeutralCase(change))).toEqual({
      code: 'missing_field',
      path: 'changeUnderReview.patchDigest'
    })
  })

  it('refuses a field that belongs to another kind', () => {
    expect(refused(validateNeutralCase({ ...caseOf('change'), plantedDefects: [] }))).toEqual({
      code: 'inconsistent',
      path: 'plantedDefects'
    })
    expect(refused(validateNeutralCase({ ...caseOf('review'), hiddenTests: [] }))).toEqual({
      code: 'inconsistent',
      path: 'hiddenTests'
    })
  })

  it('refuses a layer other than G, an unknown kind and malformed values', () => {
    expect(refused(validateNeutralCase({ ...caseOf('change'), layer: 'P' }))).toEqual({
      code: 'unknown_value',
      path: 'layer'
    })
    expect(refused(validateNeutralCase({ ...caseOf('change'), kind: 'plan' }))).toEqual({
      code: 'unknown_value',
      path: 'kind'
    })
    expect(refused(validateNeutralCase({ ...caseOf('change'), baseRevision: 'main' }))).toEqual({
      code: 'bad_commit',
      path: 'baseRevision'
    })
    expect(refused(validateNeutralCase({ ...caseOf('change'), hiddenTests: [] }))).toEqual({
      code: 'empty',
      path: 'hiddenTests'
    })
    const flag = caseOf('change')
    ;(flag.deliveredDocuments as Record<string, unknown>[])[0]!.relevant = 'yes'
    expect(refused(validateNeutralCase(flag))).toEqual({ code: 'wrong_type', path: 'deliveredDocuments.0.relevant' })
  })

  it('refuses a review case whose change, defects and adjudication disagree', () => {
    const otherBase = caseOf('review')
    ;(otherBase.changeUnderReview as Record<string, unknown>).base = 'f'.repeat(40)
    expect(refused(validateNeutralCase(otherBase))).toEqual({ code: 'inconsistent', path: 'changeUnderReview.base' })

    const cleanWithDefects = caseOf('review')
    ;(cleanWithDefects.adjudication as Record<string, unknown>).clean = true
    expect(refused(validateNeutralCase(cleanWithDefects))).toEqual({ code: 'inconsistent', path: 'plantedDefects' })

    expect(refused(validateNeutralCase({ ...caseOf('review'), plantedDefects: [] }))).toEqual({
      code: 'empty',
      path: 'plantedDefects'
    })

    const clean: Record<string, unknown> = { ...caseOf('review'), plantedDefects: [] }
    ;(clean.adjudication as Record<string, unknown>).clean = true
    expect(accepted(clean).kind).toBe('review')

    const oneAdjudicator = caseOf('review')
    ;(oneAdjudicator.adjudication as Record<string, unknown>).adjudicators = ['adjudicator-a']
    expect(refused(validateNeutralCase(oneAdjudicator))).toEqual({
      code: 'out_of_range',
      path: 'adjudication.adjudicators'
    })
  })

  it('refuses a task statement carrying a process term', () => {
    expect(
      refused(validateNeutralCase({ ...caseOf('change'), taskStatement: 'Follow the brief and meet O1.' }))
    ).toEqual({ code: 'banned_term', path: 'taskStatement' })
  })
})

describe('neutral case digest', () => {
  it('is stable for a case regardless of key order', () => {
    for (const kind of NEUTRAL_CASE_KINDS) {
      const raw = caseOf(kind)
      const forward = accepted(raw)
      const backward = accepted(reversedKeys(raw))
      expect(Object.keys(reversedKeys(forward) as object)).not.toEqual(Object.keys(forward))
      expect(neutralCaseDigest(backward)).toBe(neutralCaseDigest(forward))
      expect(neutralCaseDigest(reversedKeys(forward) as NeutralCase)).toBe(neutralCaseDigest(forward))
      expect(neutralCaseDigest(forward)).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('changes when any field changes', () => {
    const base = accepted(caseOf('review'))
    const before = neutralCaseDigest(base)
    const edits: ((c: Record<string, any>) => void)[] = [
      (c) => (c.id = 'other-id'),
      (c) => (c.repository = 'example/other'),
      (c) => (c.baseRevision = 'f'.repeat(40)),
      (c) => (c.taskStatement = `${c.taskStatement} Also handle ordinal dates.`),
      (c) => c.authorizedScope.in.push('src/extra'),
      (c) => c.authorizedScope.protected.push('package.json'),
      (c) => (c.deliveredDocuments[0].contentDigest = D('9')),
      (c) => (c.deliveredDocuments[1].relevant = true),
      (c) => c.grantedCapabilities.push('network'),
      (c) => (c.plantedDefects[0].critical = true),
      (c) => (c.plantedDefects[1].justified = false),
      (c) => (c.changeUnderReview.head = 'e'.repeat(40)),
      (c) => (c.adjudication.adjudicators[1] = 'adjudicator-c')
    ]
    const seen = new Set([before])
    for (const edit of edits) {
      const next = structuredClone(base) as Record<string, any>
      edit(next)
      const digest = neutralCaseDigest(next as NeutralCase)
      expect(digest).not.toBe(before)
      seen.add(digest)
    }
    expect(seen.size).toBe(edits.length + 1)

    const change = accepted(caseOf('change'))
    const changed = structuredClone(change) as Record<string, any>
    changed.hiddenTests[0].name = 'parses 2026-W04-1'
    expect(neutralCaseDigest(changed as NeutralCase)).not.toBe(neutralCaseDigest(change))
    const solution = structuredClone(change) as Record<string, any>
    solution.referenceSolution.patchDigest = D('8')
    expect(neutralCaseDigest(solution as NeutralCase)).not.toBe(neutralCaseDigest(change))
  })

  it('versions the intent by the task statement and the authorized scope only', () => {
    const c = accepted(caseOf('change'))
    const sameIntent = { ...c, id: 'renamed', grantedCapabilities: [] } as NeutralCase
    expect(intentVersion(sameIntent)).toBe(intentVersion(c))
    const widened = structuredClone(c)
    widened.authorizedScope.in.push('src/other')
    expect(intentVersion(widened)).not.toBe(intentVersion(c))
  })
})
