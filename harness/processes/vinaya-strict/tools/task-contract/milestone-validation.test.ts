import { describe, expect, it } from 'vitest'
import { type AdoptFacts, checkAdoptable, checkMilestoneShape, releaseFieldFromBody } from './milestone-validation'

describe('releaseFieldFromBody', () => {
  it('is absent when no Release: field exists', () => {
    expect(releaseFieldFromBody('A milestone with no version.')).toEqual({ declared: false, value: null })
  })

  it('reads a bold-inline Release: field', () => {
    expect(releaseFieldFromBody('The goal.\n\n**Release:** 1.2.0')).toEqual({ declared: true, value: '1.2.0' })
  })

  it('reads a plain Release: field', () => {
    expect(releaseFieldFromBody('The goal.\n\nRelease: 1.2.0')).toEqual({ declared: true, value: '1.2.0' })
  })

  it('tolerates a `v`-prefixed version and backtick wrapping', () => {
    expect(releaseFieldFromBody('Release: `v2.0.0`')).toEqual({ declared: true, value: 'v2.0.0' })
  })

  it('accepts a pre-release/build suffix', () => {
    expect(releaseFieldFromBody('Release: 1.0.0-rc.1+build.5')).toEqual({
      declared: true,
      value: '1.0.0-rc.1+build.5'
    })
  })

  it('reports declared true, value null for a malformed version', () => {
    expect(releaseFieldFromBody('Release: whenever it ships')).toEqual({ declared: true, value: null })
  })

  it('never matches inside a fenced code example of the field', () => {
    const body = ['The goal.', '', '```', 'Release: 1.0.0', '```', ''].join('\n')
    expect(releaseFieldFromBody(body)).toEqual({ declared: false, value: null })
  })

  it('takes the first match when the field appears twice', () => {
    expect(releaseFieldFromBody('Release: 1.0.0\n\nRelease: 2.0.0')).toEqual({ declared: true, value: '1.0.0' })
  })
})

describe('checkMilestoneShape', () => {
  it('passes a goal-only body with no Release: and no intents', () => {
    const result = checkMilestoneShape('A milestone with no version and no declared tranches yet.')
    expect(result).toEqual({
      status: 'pass',
      goal: 'A milestone with no version and no declared tranches yet.',
      release: null,
      intents: []
    })
  })

  it('passes a body carrying goal, Release, and intents', () => {
    const body = [
      'Ship the milestone model.',
      '',
      'Release: 1.0.0',
      '',
      '### Tranche intents',
      '- vinaya-milestone-model-v1: A milestone can be created and refused when malformed.',
      '- vinaya-selfgov-v1: The native tranche moves off Milestones.'
    ].join('\n')

    expect(checkMilestoneShape(body)).toEqual({
      status: 'pass',
      goal: 'Ship the milestone model.',
      release: '1.0.0',
      intents: [
        {
          slug: 'vinaya-milestone-model-v1',
          goal: 'A milestone can be created and refused when malformed.'
        },
        { slug: 'vinaya-selfgov-v1', goal: 'The native tranche moves off Milestones.' }
      ]
    })
  })

  it('refuses when the goal is absent', () => {
    const body = ['Release: 1.0.0', '', '### Tranche intents', '- a-slug: something'].join('\n')
    const result = checkMilestoneShape(body)
    expect(result.status).toBe('fail')
    expect(result.status === 'fail' && result.errors.some((e) => /goal/i.test(e))).toBe(true)
  })

  it('refuses when Release: is present but malformed', () => {
    const result = checkMilestoneShape('The goal.\n\nRelease: soon')
    expect(result.status).toBe('fail')
    expect(result.status === 'fail' && result.errors.some((e) => /Release/i.test(e))).toBe(true)
  })

  it('refuses when the intents section does not parse', () => {
    const body = ['The goal.', '', '### Tranche intents', 'not a bullet line'].join('\n')
    const result = checkMilestoneShape(body)
    expect(result.status).toBe('fail')
    expect(result.status === 'fail' && result.errors.some((e) => /intents/i.test(e))).toBe(true)
  })

  it('passes when the intents heading exists but is empty', () => {
    const body = ['The goal.', '', '### Tranche intents', ''].join('\n')
    expect(checkMilestoneShape(body)).toEqual({ status: 'pass', goal: 'The goal.', release: null, intents: [] })
  })
})

describe('checkAdoptable', () => {
  const openTarget = { title: 'a-goal-v1', exists: true, state: 'open' as const }

  function facts(overrides: Partial<AdoptFacts> = {}): AdoptFacts {
    return {
      target: openTarget,
      slugs: [{ slug: 'tranche-a', labelExists: true, issueNumbers: [10, 11], adoptedElsewhere: [] }],
      ...overrides
    }
  }

  it('passes a well-formed single-slug adoption', () => {
    expect(checkAdoptable(facts())).toEqual({ status: 'pass' })
  })

  it('passes a well-formed multi-slug adoption', () => {
    const result = checkAdoptable(
      facts({
        slugs: [
          { slug: 'tranche-a', labelExists: true, issueNumbers: [10], adoptedElsewhere: [] },
          { slug: 'tranche-b', labelExists: true, issueNumbers: [20, 21], adoptedElsewhere: [] }
        ]
      })
    )
    expect(result).toEqual({ status: 'pass' })
  })

  it('refuses an unknown slug — no such label exists', () => {
    const result = checkAdoptable(
      facts({ slugs: [{ slug: 'no-such-tranche', labelExists: false, issueNumbers: [], adoptedElsewhere: [] }] })
    )
    expect(result.status).toBe('fail')
    expect(result.status === 'fail' && result.errors.some((e) => /unknown-slug/.test(e))).toBe(true)
  })

  it('refuses a slug whose label carries no Issues', () => {
    const result = checkAdoptable(
      facts({ slugs: [{ slug: 'empty-tranche', labelExists: true, issueNumbers: [], adoptedElsewhere: [] }] })
    )
    expect(result.status).toBe('fail')
    expect(result.status === 'fail' && result.errors.some((e) => /no-issues/.test(e))).toBe(true)
  })

  it('refuses a target that does not exist', () => {
    const result = checkAdoptable(facts({ target: { title: 'missing-v1', exists: false, state: null } }))
    expect(result.status).toBe('fail')
    expect(result.status === 'fail' && result.errors.some((e) => /does not exist/.test(e))).toBe(true)
  })

  it('refuses a target that is closed', () => {
    const result = checkAdoptable(facts({ target: { title: 'closed-v1', exists: true, state: 'closed' } }))
    expect(result.status).toBe('fail')
    expect(result.status === 'fail' && result.errors.some((e) => /is closed/.test(e))).toBe(true)
  })

  it('refuses a slug already adopted into a different Milestone', () => {
    const result = checkAdoptable(
      facts({
        slugs: [{ slug: 'tranche-a', labelExists: true, issueNumbers: [10], adoptedElsewhere: ['other-goal-v1'] }]
      })
    )
    expect(result.status).toBe('fail')
    expect(result.status === 'fail' && result.errors.some((e) => /already-adopted/.test(e))).toBe(true)
  })

  it('collects every refusal across a mixed valid/invalid batch, in one result', () => {
    const result = checkAdoptable(
      facts({
        slugs: [
          { slug: 'tranche-a', labelExists: true, issueNumbers: [10], adoptedElsewhere: [] },
          { slug: 'no-such-tranche', labelExists: false, issueNumbers: [], adoptedElsewhere: [] }
        ]
      })
    )
    expect(result.status).toBe('fail')
    expect(result.status === 'fail' && result.errors.length).toBe(1)
    expect(result.status === 'fail' && result.errors[0]).toMatch(/unknown-slug/)
  })
})
