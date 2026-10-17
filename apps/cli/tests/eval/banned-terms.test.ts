// The banned-terms checker: a neutral task statement carries no process term,
// and a refusal names the term it found.
import { describe, expect, it } from 'bun:test'
import { BANNED_TERMS, checkTaskStatement, findBannedTerms } from '../../src/lib/dev-review-eval/banned-terms'
import { REVIEWER_SEVERITIES } from '../../src/lib/review-result'

const NEUTRAL =
  'Make the date parser accept ISO week dates such as 2026-W03-4, keep every existing format working, and add tests for both.'

function refusedTerm(statement: string): string {
  const result = checkTaskStatement(statement)
  if (result.ok) throw new Error(`expected a refusal for ${JSON.stringify(statement)}`)
  expect(result.refusal.code).toBe('banned_term')
  expect(result.refusal.path).toBe('taskStatement')
  return result.refusal.detail
}

describe('banned-terms checker', () => {
  it('accepts a statement free of every process term', () => {
    expect(checkTaskStatement(NEUTRAL)).toEqual({ ok: true, value: NEUTRAL })
    expect(findBannedTerms(NEUTRAL)).toEqual([])
    // Ordinary English that shares letters with a severity name or an id stays allowed.
    expect(checkTaskStatement('Keep latency low on a high-traffic route; the O-ring part number is OX7.').ok).toBe(true)
  })

  it('refuses each process word, naming the term', () => {
    const cases: [string, string][] = [
      ['Stay inside the Surface of this change.', 'Surface'],
      ['Meet every objective listed below.', 'objective'],
      ['Follow the brief exactly.', 'brief'],
      ['Explain the verdict in the summary.', 'verdict'],
      ['Satisfy O3 before the rest.', 'objective id'],
      ['Address F2 from the last round.', 'finding id'],
      ['Address R2-CR-3 and R1-SEC-1.', 'finding id'],
      ['Ask the Principal when unsure.', 'principal'],
      ['The planner wants this split.', 'planner'],
      ['The architect signed off.', 'architect'],
      ['Leave it for the tranche archivist.', 'archivist'],
      ['As the developer, write the fix.', 'developer'],
      ['The code-reviewer will check it.', 'reviewer'],
      ['The security reviewer will check it.', 'reviewer'],
      ['Let the operator resume it.', 'operator']
    ]
    for (const [statement, term] of cases) {
      expect({ statement, detail: refusedTerm(statement) }).toEqual({
        statement,
        detail: expect.stringContaining(`"${term}"`)
      })
    }
  })

  it('refuses every reviewer severity name as the scales write it', () => {
    const severities = Object.values(REVIEWER_SEVERITIES).flat()
    expect(severities.length).toBeGreaterThan(0)
    for (const severity of severities) {
      expect(refusedTerm(`Nothing here may be ${severity}.`)).toContain(`"${severity}"`)
    }
  })

  it('reports every term a statement contains, in list order', () => {
    expect(findBannedTerms('The brief names O1 for the developer.').map((hit) => hit.term)).toEqual([
      'brief',
      'objective id',
      'developer'
    ])
  })

  it('names each term once', () => {
    const terms = BANNED_TERMS.map((t) => t.term)
    expect(new Set(terms).size).toBe(terms.length)
  })
})
