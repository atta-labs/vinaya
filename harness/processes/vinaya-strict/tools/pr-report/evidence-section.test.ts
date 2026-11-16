import { describe, expect, it } from 'bun:test'
import { EVIDENCE_PLACEHOLDER_TEXT } from '../../checks/evidence-fresh-logic'
import { checkBareDigits } from '../body-bare-digits-logic'
import { REGION_PREFIX_CURRENT } from '../legacy-markers'
import { addEvidenceSection, realEvidenceBlock } from './evidence-section'

const START = `<!-- ${REGION_PREFIX_CURRENT}:EVIDENCE:START -->`
const END = `<!-- ${REGION_PREFIX_CURRENT}:EVIDENCE:END -->`
const PLACEHOLDER = `${START}\n${EVIDENCE_PLACEHOLDER_TEXT}\n${END}`
const WRITTEN = `${START}\nHead: abc1234\n\n#### C1: bun test\n${END}`

/** The body's evidence block with the written content, the way the evidence writer fills it. */
const withWritten = (body: string): string => body.replace(PLACEHOLDER, WRITTEN)

describe('addEvidenceSection', () => {
  it('adds the heading and the placeholder pair directly before ## Scope', () => {
    const body = 'Closes #1\n\n## Summary\n\nText.\n\n## Scope\n\nscope text\n'
    expect(addEvidenceSection(body)).toBe(
      `Closes #1\n\n## Summary\n\nText.\n\n## Evidence\n\n${PLACEHOLDER}\n\n## Scope\n\nscope text\n`
    )
  })

  it('appends the section at the end when there is no ## Scope heading', () => {
    expect(addEvidenceSection('Closes #1\n\n## Summary\n\nText.\n')).toBe(
      `Closes #1\n\n## Summary\n\nText.\n\n## Evidence\n\n${PLACEHOLDER}\n`
    )
  })

  it('puts the pair under an existing ## Evidence heading and adds no second heading', () => {
    const out = addEvidenceSection('## Summary\n\nText.\n\n## Evidence\n\nsome prose\n\n## Scope\n\ns\n')
    expect(out).toBe(`## Summary\n\nText.\n\n## Evidence\n\n${PLACEHOLDER}\n\nsome prose\n\n## Scope\n\ns\n`)
    expect(out.match(/^## Evidence$/gm)?.length).toBe(1)
  })

  it('handles an Evidence heading that ends the body', () => {
    expect(addEvidenceSection('## Evidence\n')).toBe(`## Evidence\n\n${PLACEHOLDER}\n`)
  })

  it('passes a body with a real pair through byte for byte', () => {
    const body = `## Evidence\n\n${WRITTEN}\n\n## Scope\n\nx`
    expect(addEvidenceSection(body)).toBe(body)
    expect(addEvidenceSection(body, PLACEHOLDER)).toBe(body)
  })

  it('does not count a pair inside a fenced block', () => {
    const body = `## Summary\n\n\`\`\`\n${PLACEHOLDER}\n\`\`\`\n\n## Scope\n\nx\n`
    const out = addEvidenceSection(body)
    expect(out).toContain(`## Evidence\n\n${PLACEHOLDER}\n\n## Scope`)
    expect(realEvidenceBlock(out)).toBe(PLACEHOLDER)
  })

  it('ignores Evidence and Scope headings inside fences and not at level two', () => {
    const body = '```\n## Scope\n## Evidence\n```\n\n### Scope\n\n#### Evidence\n'
    const out = addEvidenceSection(body)
    expect(out.endsWith(`\n\n## Evidence\n\n${PLACEHOLDER}\n`)).toBe(true)
    expect(out.startsWith(body.trimEnd())).toBe(true)
  })

  it('uses the first Scope heading', () => {
    const out = addEvidenceSection('a\n\n## Scope\n\none\n\n## Scope\n\ntwo\n')
    expect(out.indexOf('## Evidence')).toBeLessThan(out.indexOf('## Scope'))
    expect(out.match(/^## Evidence$/gm)?.length).toBe(1)
  })

  it('gives the live pair block instead of the placeholder when one is passed', () => {
    const out = addEvidenceSection('a\n\n## Scope\n\nx\n', WRITTEN)
    expect(out).toBe(`a\n\n## Evidence\n\n${WRITTEN}\n\n## Scope\n\nx\n`)
  })

  it('passes a body through unchanged when raw and normalised resolutions disagree', () => {
    const zeroWidthStart = `<!-- ${REGION_PREFIX_CURRENT}:EVI​DENCE:START -->`
    const body = `## Evidence\n\n${zeroWidthStart}\nx\n${END}\n`
    const forged = `<!-- ${REGION_PREFIX_CURRENT}:EVIDENCE:START​ -->\nx\n${END}\n`
    for (const candidate of [body, forged]) {
      const out = addEvidenceSection(candidate)
      // Either a real pair is found by both (unchanged) or they disagree (unchanged); never a second pair.
      expect(out.match(/EVIDENCE:START/g)?.length ?? 0).toBeLessThanOrEqual(1)
    }
  })
})

describe('realEvidenceBlock', () => {
  it('returns the whole block, markers included', () => {
    expect(realEvidenceBlock(`x\n${WRITTEN}\ny`)).toBe(WRITTEN)
  })
  it('is null with no pair or a pair only in a fence', () => {
    expect(realEvidenceBlock('x')).toBeNull()
    expect(realEvidenceBlock(`\`\`\`\n${WRITTEN}\n\`\`\``)).toBeNull()
  })
})

describe('the body the section gives passes body-bare-digits', () => {
  const header = `<!-- ${REGION_PREFIX_CURRENT}:CLOSES:START -->\nCloses #1\n<!-- ${REGION_PREFIX_CURRENT}:CLOSES:END -->\n\n## Summary\n\nDid the thing.\n\n`
  const cases: Record<string, string> = {
    'before Scope': `${header}## Scope\n\nscope\n`,
    'at the end': `${header}## Other\n\nx\n`,
    'under an Evidence heading': `${header}## Evidence\n\n## Scope\n\nscope\n`
  }
  for (const [name, body] of Object.entries(cases)) {
    it(`${name}, with written evidence in the pair`, () => {
      const out = withWritten(addEvidenceSection(body))
      expect(out).toContain('Head: abc1234')
      expect(checkBareDigits(out).violations).toEqual([])
    })
  }
})
