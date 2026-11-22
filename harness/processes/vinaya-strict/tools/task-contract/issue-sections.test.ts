import { describe, expect, it } from 'vitest'
import { checkKnownIssueSections, ISSUE_SECTIONS, RATIONALE_FIELD_SPECS } from './issue-sections'

const RATIONALE = '**Boundary** — Do the thing.\n\n**Traps to avoid** — Do NOT skip the test.\n'

describe('checkKnownIssueSections', () => {
  it('refuses an unlisted level-two heading by name, printing the known headings and the two places for the content', () => {
    const r = checkKnownIssueSections(
      `## Objectives\n\nO1. x\n\n## Planner's rationale\n\n${RATIONALE}\n## Developer notes\n\nstuff\n`
    )
    expect(r.status).toBe('fail')
    expect(r.errors.length).toBe(1)
    const [message] = r.errors as [string]
    expect(message).toContain('`## Developer notes`')
    for (const s of ISSUE_SECTIONS) expect(message).toContain(`\`## ${s.heading}\``)
    expect(message).toContain('rationale field')
    expect(message).toContain('listed under `## Documentation`')
  })

  it('accepts a level-two heading that appears only inside a fenced block', () => {
    const body = `## Objectives\n\nO1. x\n\n\`\`\`md\n## Developer notes\n\`\`\`\n\n${RATIONALE}`
    expect(checkKnownIssueSections(body).status).toBe('pass')
  })

  it('accepts the rationale section under whatever heading it carries', () => {
    for (const heading of ["Planner's rationale", 'Task Issue — Planner rationale', 'Why this shape']) {
      expect(checkKnownIssueSections(`## ${heading}\n\n${RATIONALE}`).status).toBe('pass')
    }
  })

  it('accepts a level-two heading that is itself a rationale field label', () => {
    expect(checkKnownIssueSections('## Boundary\n\nDo the thing.\n').status).toBe('pass')
  })

  it.each(['Premises', 'Origin', 'Check decisions', 'Covering checks'])('accepts `## %s`', (heading) => {
    expect(checkKnownIssueSections(`## ${heading}\n\ncontent\n`).status).toBe('pass')
  })

  it('matches a heading without regard to letter case, and ignores level-three headings', () => {
    expect(checkKnownIssueSections('## TEST PLAN\n\nx\n\n### Developer notes\n\ny\n').status).toBe('pass')
  })

  it('marks every entry carried or staying on the Issue, and the checks sections as carried', () => {
    for (const s of ISSUE_SECTIONS) {
      expect(['carried', 'stays-on-issue']).toContain(s.disposition)
      expect(s.disposition === 'carried').toBe(s.briefPart !== undefined)
    }
    const staying = ISSUE_SECTIONS.filter((s) => s.disposition === 'stays-on-issue').map((s) => s.heading)
    expect(staying).toEqual(['Origin'])
    for (const heading of ['Check decisions', 'Covering checks']) {
      const entry = ISSUE_SECTIONS.find((s) => s.heading === heading)
      expect(entry?.disposition).toBe('carried')
      expect(entry?.briefPart).toBe('## Check decisions')
    }
  })

  it('lists the eight rationale fields', () => {
    expect(RATIONALE_FIELD_SPECS.length).toBe(8)
  })
})
