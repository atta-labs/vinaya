import { describe, expect, it } from 'vitest'
import { objectivesVersion, parseObjectives, renderObjectives } from './objectives'

const WELL_FORMED = `## Objectives

O1. A task Issue carries a section.
O2. The parser is the only reader.

## Planner's rationale

Boundary — …
`

describe('parseObjectives', () => {
  it('parses a well-formed section into ordered objectives', () => {
    const result = parseObjectives(WELL_FORMED)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.objectives).toEqual([
      { id: 'O1', text: 'A task Issue carries a section.' },
      { id: 'O2', text: 'The parser is the only reader.' }
    ])
  })

  it('refuses a body with no `## Objectives` heading', () => {
    const result = parseObjectives('## Summary\n\nNo objectives here.\n')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.join(' ')).toMatch(/no `## Objectives` heading/)
  })

  it('refuses a section with zero lines', () => {
    const result = parseObjectives('## Objectives\n\n## Next\n\nX\n')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.join(' ')).toMatch(/no `O<n>\.` lines/)
  })

  it('refuses an `O1:` line (wrong grammar — colon, not period)', () => {
    const result = parseObjectives('## Objectives\n\nO1: A sentence.\n')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.join(' ')).toMatch(/not a well-formed objective line/)
  })

  it('refuses a bare `1.` line (wrong grammar — missing `O` prefix)', () => {
    const result = parseObjectives('## Objectives\n\n1. A sentence.\n')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.join(' ')).toMatch(/not a well-formed objective line/)
  })

  it('refuses an objective line with no sentence', () => {
    const result = parseObjectives('## Objectives\n\nO1.   \n')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.join(' ')).toMatch(/has no sentence/)
  })

  it('refuses an objective that is little more than a bare file path', () => {
    const result = parseObjectives('## Objectives\n\nO1. Edits `packages/aeg-core/src/objectives.ts` directly.\n')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.join(' ')).toMatch(/little more than a file path/)
  })

  it('tolerates a backticked token with no path separator', () => {
    const result = parseObjectives('## Objectives\n\nO1. `objectivesOf(body)` parses the list.\n')
    expect(result.ok).toBe(true)
  })

  it('tolerates a real path mentioned as supporting detail in a full sentence (Issue #404 shape)', () => {
    const result = parseObjectives(
      '## Objectives\n\n' +
        'O1. No file other than `apps/cli/src/lib/log-sink.ts` performs the append, and no file other than the two named chokepoints calls `log()`; a test proves both.\n'
    )
    expect(result.ok).toBe(true)
  })

  it('refuses a gap in numbering', () => {
    const result = parseObjectives('## Objectives\n\nO1. First.\nO3. Third.\n')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.join(' ')).toMatch(/numbering is not contiguous/)
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
    const reparsed = parseObjectives(rendered)
    expect(reparsed.ok).toBe(true)
    if (reparsed.ok) expect(reparsed.objectives).toEqual(objectives)
  })
})
