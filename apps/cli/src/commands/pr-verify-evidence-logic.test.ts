import { describe, expect, test } from 'bun:test'
import { compareEvidence, extractEvidenceRegion, normaliseLines } from './pr-verify-evidence-logic'

const wrap = (inner: string) => `intro\n<!-- AEG:EVIDENCE:START -->\n${inner}\n<!-- AEG:EVIDENCE:END -->\noutro`

describe('extractEvidenceRegion', () => {
  test('returns null when the body carries no anchors', () => {
    expect(extractEvidenceRegion('## Summary\nno block here')).toBeNull()
  })

  test('returns null when only the opening anchor is present', () => {
    expect(extractEvidenceRegion('<!-- AEG:EVIDENCE:START -->\nHead: abc')).toBeNull()
  })

  test('returns the text between the anchors', () => {
    expect(extractEvidenceRegion(wrap('Head: abc123'))?.trim()).toBe('Head: abc123')
  })
})

describe('normaliseLines', () => {
  test('strips the repo root wherever it appears, not only at line start', () => {
    const out = normaliseLines('warning: /work/vinaya/aeg-root/enforcement.md:30: uses coined term', '/work/vinaya')
    expect(out).toEqual(['warning: aeg-root/enforcement.md:30: uses coined term'])
  })

  test('tolerates a trailing separator on the root', () => {
    expect(normaliseLines('/work/vinaya/a.md', '/work/vinaya/')).toEqual(['a.md'])
  })

  test('drops blank lines and trims', () => {
    expect(normaliseLines('  a  \n\n\n  b  ', '')).toEqual(['a', 'b'])
  })
})

describe('compareEvidence', () => {
  const root = '/work/vinaya'

  test('no-block when the published body has no anchors', () => {
    expect(compareEvidence(null, 'anything', root)).toEqual({ status: 'no-block' })
  })

  test('match when the regions agree', () => {
    expect(compareEvidence('Head: abc\nwarning: x', 'Head: abc\nwarning: x', root).status).toBe('match')
  })

  // The three false-difference sources measured against a real pull request.
  test('match despite absolute paths differing between checkouts', () => {
    const published = 'warning: /work/vinaya/a.md:1: term'
    const fresh = 'warning: /private/tmp/wt304/a.md:1: term'
    // Each side is normalised against the root it was produced under; here the
    // caller's root strips the published side and the fresh side is already
    // relative after its own root is removed upstream.
    expect(compareEvidence(published, 'warning: a.md:1: term', root).status).toBe('match')
    expect(fresh).toContain('wt304')
  })

  test('match despite line reordering — a reorder is not a fabrication', () => {
    expect(compareEvidence('a\nb\nc', 'c\na\nb', root).status).toBe('match')
  })

  test('DIFFERS and names every line a real run produced that the block omits', () => {
    const published = 'Head: abc\nclosesn: pass'
    const fresh = 'Head: abc\nclosesn: pass\nwarning: enforcement.md:30: Brief\nwarning: enforcement.md:8: Provenance'
    const v = compareEvidence(published, fresh, root)
    expect(v.status).toBe('differs')
    if (v.status !== 'differs') throw new Error('unreachable')
    expect(v.missing).toEqual(['warning: enforcement.md:30: Brief', 'warning: enforcement.md:8: Provenance'])
    expect(v.unexpected).toEqual([])
  })

  test('DIFFERS and names a published line no real run reproduces', () => {
    const v = compareEvidence('Head: abc\n22/22 sub-checks green', 'Head: abc', root)
    expect(v.status).toBe('differs')
    if (v.status !== 'differs') throw new Error('unreachable')
    expect(v.unexpected).toEqual(['22/22 sub-checks green'])
  })

  test('counts occurrences — two identical warnings collapsing to one is a real difference', () => {
    const v = compareEvidence('w\nHead: a', 'w\nw\nHead: a', root)
    expect(v.status).toBe('differs')
    if (v.status !== 'differs') throw new Error('unreachable')
    expect(v.missing).toEqual(['w'])
  })
})
