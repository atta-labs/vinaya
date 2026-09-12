import { describe, expect, it } from 'bun:test'
import { appendPartLine, removePartLinesCitingOnly } from '../../src/commands/issue-objectives'

// task-run-v1 task 15, O5 — pure unit coverage of the `## Parts` splice
// helpers, apart from the CLI-subprocess fixtures in
// `issue-objectives.test.ts`.

const BODY = [
  '## Objectives',
  '',
  'O1. First.',
  'O2. Second.',
  '',
  '## Parts',
  '',
  'Part 1 (O1) — outcome one.',
  'Part 2 (O2) — outcome two.',
  '',
  "## Planner's rationale",
  '',
  'text'
].join('\n')

describe('appendPartLine', () => {
  it('appends the new line at the end of the Parts section, leaving everything else untouched', () => {
    const result = appendPartLine(BODY, 'Part 3 (O3) — outcome three.')
    expect(result).toContain('Part 1 (O1) — outcome one.')
    expect(result).toContain('Part 2 (O2) — outcome two.')
    expect(result).toContain('Part 3 (O3) — outcome three.')
    expect(result).toContain("## Planner's rationale")
    // The new line lands INSIDE the Parts section, before the next heading.
    const partsIdx = result.indexOf('## Parts')
    const nextHeadingIdx = result.indexOf("## Planner's rationale")
    const newLineIdx = result.indexOf('Part 3 (O3)')
    expect(newLineIdx).toBeGreaterThan(partsIdx)
    expect(newLineIdx).toBeLessThan(nextHeadingIdx)
  })

  it('throws when the body has no `## Parts` heading at all', () => {
    const noParts = '## Objectives\n\nO1. First.\n'
    expect(() => appendPartLine(noParts, 'Part 1 (O1) — x.')).toThrow(/no `## Parts` heading/)
  })

  it('appends after the LAST existing Part line, not at the start of the section', () => {
    const result = appendPartLine(BODY, 'Part 3 (O3) — outcome three.')
    const lines = result.split('\n').map((l) => l.trim())
    const idx2 = lines.indexOf('Part 2 (O2) — outcome two.')
    const idx3 = lines.indexOf('Part 3 (O3) — outcome three.')
    expect(idx3).toBe(idx2 + 1)
  })
})

describe('removePartLinesCitingOnly', () => {
  it('removes a Part whose citation is exactly the dropped objective', () => {
    const result = removePartLinesCitingOnly(BODY, 'O2')
    expect(result).not.toContain('Part 2 (O2)')
    expect(result).toContain('Part 1 (O1) — outcome one.')
  })

  it('leaves a Part citing the dropped objective alongside another untouched', () => {
    const multi = [
      '## Objectives',
      '',
      'O1. First.',
      'O2. Second.',
      '',
      '## Parts',
      '',
      'Part 1 (O1, O2) — combined outcome.',
      '',
      "## Planner's rationale",
      '',
      'text'
    ].join('\n')
    const result = removePartLinesCitingOnly(multi, 'O2')
    expect(result).toContain('Part 1 (O1, O2) — combined outcome.')
  })

  it('is a no-op when the body has no `## Parts` heading', () => {
    const noParts = '## Objectives\n\nO1. First.\n'
    expect(removePartLinesCitingOnly(noParts, 'O1')).toBe(noParts)
  })

  it('leaves non-Part lines (blank lines, prose) in the section untouched', () => {
    const result = removePartLinesCitingOnly(BODY, 'O2')
    // The section's blank-line structure survives — only the matching Part
    // line itself is dropped, not the whole section collapsed.
    expect(result).toContain('## Parts')
    expect(result).toContain('Part 1 (O1) — outcome one.')
  })
})
