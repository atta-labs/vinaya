import { describe, expect, it } from 'vitest'
import { checkMilestoneShape, releaseFieldFromBody } from './milestone-validation'

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
