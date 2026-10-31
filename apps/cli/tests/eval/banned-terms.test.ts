// The banned-terms checker: a neutral task statement carries no process term,
// and a refusal names the term it found.
import { describe, expect, it } from 'bun:test'
import {
  BANNED_TERMS,
  checkTaskStatement,
  findBannedTerms,
  interfaceCodeSpan
} from '../../src/lib/dev-review-eval/banned-terms'
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

  it("skips the code spans of a closing Interface block, and still reports every term in the statement's prose", () => {
    const block = ' Interface: flag `--surface-only`; field `Report.reviewer: string`; string `the brief is ready`.'
    expect(findBannedTerms(`${NEUTRAL}${block}`)).toEqual([])
    expect(checkTaskStatement(`${NEUTRAL}${block}`).ok).toBe(true)
    // The same words in the prose are reported, at the index the statement holds them.
    const prose = 'Keep the surface flag working for the reviewer.'
    expect(findBannedTerms(`${prose}${block}`)).toEqual([
      { term: 'Surface', match: 'surface', index: prose.indexOf('surface') },
      { term: 'reviewer', match: 'reviewer', index: prose.indexOf('reviewer') }
    ])
    // Only a well-formed block that ends the statement is skipped: a marker in the middle, an unknown kind or a
    // missing full stop leaves every span checked.
    expect(findBannedTerms(`${NEUTRAL}${block} Then stop.`).map((hit) => hit.term)).toContain('Surface')
    expect(findBannedTerms(`${NEUTRAL} Interface: name \`--surface-only\`.`).map((hit) => hit.term)).toEqual([
      'Surface'
    ])
    expect(findBannedTerms(`${NEUTRAL} Interface: flag \`--surface-only\``).map((hit) => hit.term)).toEqual(['Surface'])
    // A span before the last marker is prose.
    expect(findBannedTerms(`Use \`--surface\`.${' Interface: env `PATH`.'}`).map((hit) => hit.term)).toEqual([
      'Surface'
    ])
  })

  it('parses an Interface block whose items hold backticks, fenced by a longer run, and blanks each whole span', () => {
    const items = ['the `brief` is ready', '`--surface`', 'plain reviewer']
    expect(items.map(interfaceCodeSpan)).toEqual(['``the `brief` is ready``', '`` `--surface` ``', '`plain reviewer`'])
    const block = ` Interface: string ${interfaceCodeSpan(items[0] as string)}; flag ${interfaceCodeSpan(
      items[1] as string
    )}; key ${interfaceCodeSpan(items[2] as string)}.`
    expect(findBannedTerms(`${NEUTRAL}${block}`)).toEqual([])
    // A span the block never closes, or closes with a shorter run, leaves the block unparsed, so every span is checked.
    expect(
      findBannedTerms(`${NEUTRAL} Interface: string \`\`the \`brief\` is ready\`.`).map((hit) => hit.term)
    ).toEqual(['brief'])
    // The prose before the block is still checked.
    expect(findBannedTerms(`Ask the operator.${block}`).map((hit) => hit.term)).toEqual(['operator'])
  })

  it('names each term once', () => {
    const terms = BANNED_TERMS.map((t) => t.term)
    expect(new Set(terms).size).toBe(terms.length)
  })
})
