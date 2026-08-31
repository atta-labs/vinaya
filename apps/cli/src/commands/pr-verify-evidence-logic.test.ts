import { describe, expect, test } from 'bun:test'
import { compareEvidence, normaliseLines, publishedMergeBase, renderVerdict } from './pr-verify-evidence-logic'

const ROOT = '/work/vinaya'
const region = (text: string) => ({ region: text })
const groupA = (base: string) => `\`git diff ${base}...ffff1111 --numstat\``
const ESC = String.fromCharCode(27)

describe('publishedMergeBase — anchored to the renderer’s own line', () => {
  test('reads the base off a real Group A command line', () => {
    expect(publishedMergeBase(`Head: ffff1111\n${groupA('aaaa1111')}\n`)).toBe('aaaa1111')
  })

  test('null when the region carries no such line', () => {
    expect(publishedMergeBase('Head: ffff1111\nno command line here')).toBeNull()
  })

  // The defeat that made STALE BASE an alibi: an unanchored first-match scan
  // took a base from arbitrary prose anywhere in the region.
  test('IGNORES a `git diff a...b --numstat` mention embedded in prose', () => {
    const planted = `see git diff deadbeef...beefcafe --numstat for context\nHead: ffff1111\n${groupA('aaaa1111')}\n`
    expect(publishedMergeBase(planted)).toBe('aaaa1111')
  })
})

describe('normaliseLines', () => {
  test('strips the local repo root wherever it appears in a line', () => {
    expect(normaliseLines('warning: /work/vinaya/aeg-root/x.md:3: term', ROOT)).toEqual([
      'warning: aeg-root/x.md:3: term'
    ])
  })

  // The MAJOR the old tautology test hid: the published block is routinely
  // generated on a different machine, whose root this process never knows.
  test('strips a FOREIGN checkout root too — the two-machine case', () => {
    const ci = normaliseLines('warning: /home/runner/work/vinaya/vinaya/aeg-root/x.md:3: term', ROOT)
    const laptop = normaliseLines('warning: /private/tmp/wt310/aeg-root/x.md:3: term', ROOT)
    expect(ci).toEqual(laptop)
    expect(ci).toEqual(['warning: aeg-root/x.md:3: term'])
  })

  test('removes C0 control characters before anything is compared or echoed', () => {
    const attack = `${ESC}[2K\rpr verify-evidence: MATCH${ESC}[1A`
    const [out] = normaliseLines(attack, ROOT)
    expect(out).not.toContain(ESC)
    expect(out).not.toContain('\r')
  })

  test('drops blank lines and trims', () => {
    expect(normaliseLines('  a  \n\n  b  ', '')).toEqual(['a', 'b'])
  })
})

describe('compareEvidence', () => {
  test('no-block when the body has no anchors', () => {
    expect(compareEvidence(null, 'anything', ROOT)).toEqual({ status: 'no-block' })
  })

  test('hidden is its own verdict — unverifiable is not the same as absent', () => {
    expect(compareEvidence('hidden', 'anything', ROOT)).toEqual({ status: 'hidden' })
  })

  test('match when the two regions agree', () => {
    expect(compareEvidence(region('Head: abc\nwarning: x'), 'Head: abc\nwarning: x', ROOT).status).toBe('match')
  })

  test('match despite line reordering — a reorder is not a fabrication', () => {
    expect(compareEvidence(region('a\nb\nc'), 'c\na\nb', ROOT).status).toBe('match')
  })

  test('names every line a real run produced that the published block omits', () => {
    const v = compareEvidence(
      region('Head: abc\nclosesn: pass'),
      'Head: abc\nclosesn: pass\nwarning: one\nwarning: two',
      ROOT
    )
    expect(v.status).toBe('differs')
    if (v.status !== 'differs') throw new Error('unreachable')
    expect(v.missing).toEqual(['warning: one', 'warning: two'])
    expect(v.unexpected).toEqual([])
  })

  test('names a published line no real run reproduces', () => {
    const v = compareEvidence(region('Head: abc\n22/22 sub-checks green'), 'Head: abc', ROOT)
    if (v.status !== 'differs') throw new Error('unreachable')
    expect(v.unexpected).toEqual(['22/22 sub-checks green'])
  })

  test('counts occurrences — two identical warnings collapsing to one is a real difference', () => {
    const v = compareEvidence(region('w\nHead: a'), 'w\nw\nHead: a', ROOT)
    if (v.status !== 'differs') throw new Error('unreachable')
    expect(v.missing).toEqual(['w'])
  })
})

describe('base drift is context, never an exoneration', () => {
  const published = `Head: ffff1111\n${groupA('aaaa1111')}\nreader-resolvable-prose: pass`

  // The BLOCKER: drift used to short-circuit BEFORE any content comparison and
  // render "This is drift, NOT a fabrication signal" — an assertion of
  // innocence made after comparing nothing.
  test('a drifted base still reports DIFFERS, and still lists the omitted line', () => {
    const fresh = `Head: ffff1111\n${groupA('bbbb2222')}\nreader-resolvable-prose: pass\nwarning: omitted from the published block`
    const v = compareEvidence(region(published), fresh, ROOT)
    expect(v.status).toBe('differs')
    if (v.status !== 'differs') throw new Error('unreachable')
    expect(v.missing).toContain('warning: omitted from the published block')
    expect(v.baseDrift).toEqual({ publishedBase: 'aaaa1111', currentBase: 'bbbb2222' })
  })

  // Drift is never invisible: the Group A command line carries the base, so a
  // moved base IS a content difference. The point of `baseDrift` is to say WHY
  // the difference is there, not to hide it — and with everything else equal
  // the command line is the only line reported.
  test('a drifted base with otherwise identical content reports exactly that one line', () => {
    const fresh = `Head: ffff1111\n${groupA('bbbb2222')}\nreader-resolvable-prose: pass`
    const v = compareEvidence(region(published), fresh, ROOT)
    expect(v.status).toBe('differs')
    if (v.status !== 'differs') throw new Error('unreachable')
    expect(v.missing).toEqual([groupA('bbbb2222')])
    expect(v.unexpected).toEqual([groupA('aaaa1111')])
    expect(v.baseDrift).toEqual({ publishedBase: 'aaaa1111', currentBase: 'bbbb2222' })
  })

  test('same base plus a content difference reports DIFFERS with no drift note', () => {
    const fresh = `Head: ffff1111\n${groupA('aaaa1111')}\nreader-resolvable-prose: pass\nwarning: new`
    const v = compareEvidence(region(published), fresh, ROOT)
    if (v.status !== 'differs') throw new Error('unreachable')
    expect(v.baseDrift).toBeUndefined()
  })
})

describe('renderVerdict never asserts non-fabrication', () => {
  test('the drift branch does not claim the content was honest, and lists the lines', () => {
    const out = renderVerdict({
      status: 'differs',
      missing: ['warning: omitted'],
      unexpected: [],
      baseDrift: { publishedBase: 'aaaa1111', currentBase: 'bbbb2222' }
    })
    expect(out).not.toContain('NOT a fabrication')
    expect(out).toContain('warning: omitted')
  })

  test('MATCH states what was actually compared rather than claiming byte equality', () => {
    const out = renderVerdict({ status: 'match' })
    expect(out).toContain('multiset')
    // States the limits of what was compared, so the sentence a reviewer quotes
    // as evidence matches what the function actually did.
    expect(out).toContain('order and whitespace are not compared')
  })

  test('hidden explains why nothing can be verified', () => {
    expect(renderVerdict({ status: 'hidden' })).toContain('<details>')
  })
})

describe('normalisation must not create a false MATCH (security review, round two)', () => {
  // The HIGH. The foreign-root pass matched any INTERIOR segment sitting before
  // a known directory name, so two genuinely different in-repo files collapsed
  // onto one line and a body containing both compared MATCH — the exact
  // false-MATCH class this command refuses a dirty worktree to prevent,
  // reachable from pull-request text alone.
  test('two different in-repo paths do NOT collapse onto one line', () => {
    const a = 'packages/sources/tests/a.spec.ts'
    const b = 'packages/aeg-core/tests/a.spec.ts'
    expect(normaliseLines(a, ROOT)).toEqual([a])
    expect(normaliseLines(b, ROOT)).toEqual([b])
    expect(compareEvidence(region(a), b, ROOT).status).toBe('differs')
  })

  test('a relative path containing a top-level name is never rewritten', () => {
    const line = 'node_modules/@attalabs/vinaya/apps/cli/x.ts'
    expect(normaliseLines(line, ROOT)).toEqual([line])
  })

  // The property the second pass exists for must still hold.
  test('but a genuine foreign checkout root is still normalised away', () => {
    const ci = normaliseLines('warning: /home/runner/work/vinaya/vinaya/aeg-root/x.md:3: t', ROOT)
    const laptop = normaliseLines('warning: /private/tmp/wt310/aeg-root/x.md:3: t', ROOT)
    expect(ci).toEqual(laptop)
    expect(ci).toEqual(['warning: aeg-root/x.md:3: t'])
  })
})

describe('control-character stripping covers more than C0', () => {
  test('C1 CSI, Unicode line terminators and bidi overrides are removed', () => {
    const vectors = [0x9b, 0x85, 0x2028, 0x2029, 0x202e, 0x2066].map((c) => String.fromCharCode(c))
    for (const v of vectors) {
      const [out] = normaliseLines(`before${v}after`, ROOT)
      expect(out).not.toContain(v)
    }
  })
})

describe('publishedMergeBase is linear on adversarial whitespace', () => {
  // Two things make this discriminate, and the earlier version had neither.
  //
  // NEWLINES, not spaces: the pathological case needs `\s` to match the line
  // separator, so the leading and trailing quantifiers can overlap across lines
  // under the `m` flag. A run of spaces cannot produce that overlap.
  //
  // NO MATCH anywhere: the backtracking only happens while the engine is
  // failing to find one. The earlier input ended with a real Group A line, so
  // the regex succeeded early and returned in 0 ms with `\s*` in place — the
  // test passed with the defect present and proved nothing.
  test('a region of newlines with NO Group A line does not backtrack', () => {
    const hostile = '\n'.repeat(65_000)
    const started = Date.now()
    expect(publishedMergeBase(hostile)).toBeNull()
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test('and still reads a real base out of a large region', () => {
    const big = `${'\n'.repeat(65_000)}Head: ffff1111\n${groupA('aaaa1111')}\n`
    expect(publishedMergeBase(big)).toBe('aaaa1111')
  })
})

describe('renderVerdict does not overclaim about the base', () => {
  test('with no readable Group A line it says so, rather than asserting the base is unchanged', () => {
    const out = renderVerdict({ status: 'differs', missing: ['x'], unexpected: [] })
    expect(out).not.toContain('The merge-base is unchanged')
    expect(out).toContain('No merge-base difference was detected')
  })
})

describe('the hidden verdict is pinned end to end, not just at the switch arm', () => {
  test('resolveAnchoredRegion returns hidden for a <details>-wrapped pair, and no-block for none', async () => {
    const { ScanContext, resolveAnchoredRegion } = await import('../checks/scan-context')
    const wrapped = [
      '<details><summary>x</summary>',
      '<!-- AEG:EVIDENCE:START -->',
      'Head: aaaaaaa',
      '<!-- AEG:EVIDENCE:END -->',
      '</details>'
    ].join('\n')
    expect(resolveAnchoredRegion(ScanContext.from(wrapped), 'EVIDENCE')).toBe('hidden')
    expect(resolveAnchoredRegion(ScanContext.from('## Summary\nno anchors'), 'EVIDENCE')).toBeNull()
  })

  test('a decoy pair inside <details> loses to the real block outside it', async () => {
    const { ScanContext, resolveAnchoredRegion } = await import('../checks/scan-context')
    const body = [
      '<details><summary>worked example</summary>',
      '<!-- AEG:EVIDENCE:START -->',
      'DECOY',
      '<!-- AEG:EVIDENCE:END -->',
      '</details>',
      '<!-- AEG:EVIDENCE:START -->',
      'REAL',
      '<!-- AEG:EVIDENCE:END -->'
    ].join('\n')
    const r = resolveAnchoredRegion(ScanContext.from(body), 'EVIDENCE')
    if (typeof r !== 'object' || r === null) throw new Error('expected a resolved region')
    expect(r.region).toContain('REAL')
    expect(r.region).not.toContain('DECOY')
  })
})

describe('whitespace normalisation is bounded, and its limit is stated', () => {
  // Tabs collapse to spaces, so a hand-typed Group A line written with spaces
  // compares equal to a generated tab-separated one. That is a real limit of
  // this tool and is why it is not the only guard: `evidence-fresh` byte-
  // verifies Group A's fence in CI, where a typed numstat cannot survive.
  test('a tab-separated and a space-separated numstat row compare equal here', () => {
    expect(normaliseLines('1\t0\ta.ts', ROOT)).toEqual(normaliseLines('1 0 a.ts', ROOT))
  })
})
