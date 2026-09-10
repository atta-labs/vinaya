import { describe, expect, it } from 'vitest'
import {
  hasObjectivesHeading,
  isIssueNotFoundError,
  objectivesSectionBounds,
  objectivesVersion,
  objectivesOf,
  renderObjectives,
  resolveObjectivesSource
} from './objectives'

const WELL_FORMED = `## Objectives

O1. A task Issue carries a section.
O2. The parser is the only reader.

## Planner's rationale

Boundary — …
`

describe('objectivesOf', () => {
  it('parses a well-formed section into ordered objectives', () => {
    const result = objectivesOf(WELL_FORMED)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.objectives).toEqual([
      { id: 'O1', text: 'A task Issue carries a section.' },
      { id: 'O2', text: 'The parser is the only reader.' }
    ])
  })

  it('refuses a body with no `## Objectives` heading', () => {
    const result = objectivesOf('## Summary\n\nNo objectives here.\n')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.join(' ')).toMatch(/no `## Objectives` heading/)
  })

  it('refuses a section with zero lines', () => {
    const result = objectivesOf('## Objectives\n\n## Next\n\nX\n')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.join(' ')).toMatch(/no `O<n>\.` lines/)
  })

  it('refuses an `O1:` line (wrong grammar — colon, not period)', () => {
    const result = objectivesOf('## Objectives\n\nO1: A sentence.\n')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.join(' ')).toMatch(/not a well-formed objective line/)
  })

  it('refuses a bare `1.` line (wrong grammar — missing `O` prefix)', () => {
    const result = objectivesOf('## Objectives\n\n1. A sentence.\n')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.join(' ')).toMatch(/not a well-formed objective line/)
  })

  it('refuses an objective line with no sentence', () => {
    const result = objectivesOf('## Objectives\n\nO1.   \n')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.join(' ')).toMatch(/has no sentence/)
  })

  it('refuses an objective that is little more than a bare file path', () => {
    const result = objectivesOf('## Objectives\n\nO1. Edits `packages/aeg-core/src/objectives.ts` directly.\n')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.join(' ')).toMatch(/little more than a file path/)
  })

  it('stays fast on a line dense with unmatched backticks and no path (security review, PR #423, MEDIUM)', () => {
    // The old regex (`` /`[^`\n]*\/[^`\n]*`/ `` ) restarted its inner scan
    // from every backtick position on a line like this, going quadratic.
    // A generous wall-clock ceiling proves the replacement stays linear
    // without pinning an exact, environment-sensitive duration.
    const adversarial = `O1. ${'`'.repeat(50_000)}real sentence with enough words to pass.`
    const start = performance.now()
    const result = objectivesOf(`## Objectives\n\n${adversarial}\n`)
    expect(performance.now() - start).toBeLessThan(500)
    expect(result.ok).toBe(true)
  })

  it('tolerates a backticked token with no path separator', () => {
    const result = objectivesOf('## Objectives\n\nO1. `objectivesOf(body)` parses the list.\n')
    expect(result.ok).toBe(true)
  })

  it('tolerates a real path mentioned as supporting detail in a full sentence (Issue #404 shape)', () => {
    const result = objectivesOf(
      '## Objectives\n\n' +
        'O1. No file other than `apps/cli/src/lib/log-sink.ts` performs the append, and no file other than the two named chokepoints calls `log()`; a test proves both.\n'
    )
    expect(result.ok).toBe(true)
  })

  it('refuses a gap in numbering', () => {
    const result = objectivesOf('## Objectives\n\nO1. First.\nO3. Third.\n')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.join(' ')).toMatch(/numbering is not contiguous/)
  })
})

describe('hasObjectivesHeading', () => {
  it('is true whenever a `## Objectives` heading exists, even if the section under it is malformed', () => {
    expect(hasObjectivesHeading('## Objectives\n\n1. wrong grammar\n')).toBe(true)
    expect(hasObjectivesHeading(WELL_FORMED)).toBe(true)
  })

  it('is false for a body with no heading at all', () => {
    expect(hasObjectivesHeading('## Summary\n\nNo objectives here.\n')).toBe(false)
  })
})

describe('objectivesVersion', () => {
  it('hashes identically for lists differing only in whitespace', () => {
    const a = [{ id: 'O1', text: 'One   sentence.' }]
    const b = [{ id: 'O1', text: '  One sentence.  ' }]
    expect(objectivesVersion(a)).toBe(objectivesVersion(b))
  })

  it('hashes differently when one word changes', () => {
    const a = [{ id: 'O1', text: 'One sentence.' }]
    const b = [{ id: 'O1', text: 'One clause.' }]
    expect(objectivesVersion(a)).not.toBe(objectivesVersion(b))
  })

  it('hashes differently when the list itself changes', () => {
    const a = [{ id: 'O1', text: 'One sentence.' }]
    const b = [
      { id: 'O1', text: 'One sentence.' },
      { id: 'O2', text: 'Another.' }
    ]
    expect(objectivesVersion(a)).not.toBe(objectivesVersion(b))
  })
})

describe('renderObjectives', () => {
  it('renders a list back into a parseable `## Objectives` section', () => {
    const objectives = [
      { id: 'O1', text: 'First outcome.' },
      { id: 'O2', text: 'Second outcome.' }
    ]
    const rendered = renderObjectives(objectives)
    expect(rendered).toBe('## Objectives\n\nO1. First outcome.\nO2. Second outcome.')
    const reparsed = objectivesOf(rendered)
    expect(reparsed.ok).toBe(true)
    if (reparsed.ok) expect(reparsed.objectives).toEqual(objectives)
  })
})

describe('isIssueNotFoundError', () => {
  it('recognises the real gh GraphQL not-found text', () => {
    const err = new Error(
      'Command failed: gh issue view 999 --json body\nGraphQL: Could not resolve to an issue or pull request with the number of 999. (repository.issue)'
    )
    expect(isIssueNotFoundError(err)).toBe(true)
  })

  it('reads stderr too, not just message, since execFileSync rarely puts the real text first', () => {
    const err = Object.assign(new Error('Command failed'), {
      stderr: 'GraphQL: Could not resolve to an issue or pull request with the number of 999. (repository.issue)'
    })
    expect(isIssueNotFoundError(err)).toBe(true)
  })

  it('does NOT treat a real failure (auth, network) as not-found', () => {
    expect(isIssueNotFoundError(new Error('gh: authentication failed'))).toBe(false)
    expect(isIssueNotFoundError(new Error('connect ETIMEDOUT'))).toBe(false)
  })
})

describe('objectivesSectionBounds', () => {
  it('returns null for a body with no heading', () => {
    expect(objectivesSectionBounds('no heading here.')).toBeNull()
  })

  it('bounds the section from just after the heading line to the next heading', () => {
    const bounds = objectivesSectionBounds(WELL_FORMED) as { start: number; end: number }
    expect(WELL_FORMED.slice(bounds.start, bounds.end)).toBe(
      '\n\nO1. A task Issue carries a section.\nO2. The parser is the only reader.\n\n'
    )
  })

  it('bounds to end-of-body when there is no following heading', () => {
    const body = '## Objectives\n\nO1. Only section here.\n'
    const bounds = objectivesSectionBounds(body) as { start: number; end: number }
    expect(bounds.end).toBe(body.length)
  })
})

describe('resolveObjectivesSource', () => {
  const CUTOVER = 404

  it('an Issue at the cutover resolves to the issue source, even when the body also has a heading', () => {
    expect(resolveObjectivesSource('## Objectives\n\nO1. x.\n', 404, CUTOVER)).toEqual({ kind: 'issue', issue: 404 })
  })

  it('an Issue above the cutover resolves to the issue source', () => {
    expect(resolveObjectivesSource('no heading.', 500, CUTOVER)).toEqual({ kind: 'issue', issue: 500 })
  })

  it('an Issue below the cutover resolves to none, even when the body has its own heading', () => {
    expect(resolveObjectivesSource('## Objectives\n\nO1. x.\n', 1, CUTOVER)).toEqual({ kind: 'none' })
  })

  it('no Issue, PR body carries a heading — resolves to the body source', () => {
    expect(resolveObjectivesSource('## Objectives\n\nO1. x.\n', null, CUTOVER)).toEqual({ kind: 'body' })
  })

  it('no Issue, no heading — resolves to none', () => {
    expect(resolveObjectivesSource('nothing here.', null, CUTOVER)).toEqual({ kind: 'none' })
  })
})
