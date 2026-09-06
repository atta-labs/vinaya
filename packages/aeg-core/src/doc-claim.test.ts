import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  checkDocClaims,
  evaluateClaimBindings,
  findClaimBindings,
  findMalformedClaimMarkers,
  type DocClaimSourceFile
} from './doc-claim'

const reader = (files: Record<string, string>) => (path: string) => files[path] ?? null

describe('findClaimBindings — marker discovery', () => {
  it('parses the markdown form and reports the marker line', () => {
    const content = [
      'Intro.',
      '',
      '<!-- AEG:CLAIM: src/a.ts contains:function windows( -->',
      'The bound sentence.'
    ].join('\n')
    const bindings = findClaimBindings([{ path: 'aeg-root/x.md', content }])

    expect(bindings).toHaveLength(1)
    expect(bindings[0]).toEqual({
      file: 'aeg-root/x.md',
      line: 3,
      assertion: { kind: 'contains', path: 'src/a.ts', value: 'function windows(' }
    })
  })

  it('parses both source-comment forms — a `//` line and a `*` block-comment line', () => {
    const content = [
      '/**',
      ' * AEG:CLAIM: src/b.ts absent:legacyFlag',
      ' * The bound sentence.',
      ' */',
      '// AEG:CLAIM: src/c.ts contains:export function f(',
      'const x = 1'
    ].join('\n')
    const bindings = findClaimBindings([{ path: 'apps/cli/src/d.ts', content }])

    expect(bindings.map((b) => [b.line, b.assertion.kind, b.assertion.path, b.assertion.value])).toEqual([
      [2, 'absent', 'src/b.ts', 'legacyFlag'],
      [5, 'contains', 'src/c.ts', 'export function f(']
    ])
  })

  it('parses a sha256 marker', () => {
    const content = `<!-- AEG:CLAIM: src/a.ts sha256:${'a'.repeat(64)} -->\nSentence.`
    const bindings = findClaimBindings([{ path: 'aeg-root/x.md', content }])

    expect(bindings[0]?.assertion).toEqual({ kind: 'sha256', path: 'src/a.ts', value: 'a'.repeat(64) })
  })

  it('keeps every marker in a stack of several before one paragraph', () => {
    const content = [
      '<!-- AEG:CLAIM: src/a.ts contains:firstFiveLines -->',
      '<!-- AEG:CLAIM: src/b.ts contains:renderEscalationComment -->',
      'One sentence resting on two facts.'
    ].join('\n')
    const bindings = findClaimBindings([{ path: 'aeg-root/x.md', content }])

    expect(bindings.map((b) => b.assertion.path)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('ignores a marker inside a fenced block — documentation showing the grammar is not a claim', () => {
    const content = [
      'The grammar is:',
      '',
      '```markdown',
      '<!-- AEG:CLAIM: <path> contains:<literal> -->',
      '```',
      '',
      'Prose resumes.'
    ].join('\n')

    expect(findClaimBindings([{ path: 'aeg-root/documentation-coherence.md', content }])).toEqual([])
    expect(findMalformedClaimMarkers([{ path: 'aeg-root/documentation-coherence.md', content }])).toEqual([])
  })
})

describe('findMalformedClaimMarkers', () => {
  it('reports a marker announcing itself that parses as neither form', () => {
    const content = ['<!-- AEG:CLAIM: src/a.ts holds:something -->', 'Sentence.'].join('\n')
    const findings = findMalformedClaimMarkers([{ path: 'aeg-root/x.md', content }])

    expect(findings).toHaveLength(1)
    expect(findings[0]?.line).toBe(1)
    expect(findings[0]?.message).toContain('parses as neither form')
  })

  it('reports a marker missing its literal', () => {
    const findings = findMalformedClaimMarkers([
      { path: 'apps/cli/src/a.ts', content: '// AEG:CLAIM: src/a.ts contains:' }
    ])

    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('binds nothing')
  })

  it('yields no binding for a malformed marker', () => {
    expect(findClaimBindings([{ path: 'aeg-root/x.md', content: '<!-- AEG:CLAIM: src/a.ts holds:x -->' }])).toEqual([])
  })
})

describe('evaluateClaimBindings — the predicate, through an injected reader', () => {
  const bindings = (content: string, path = 'aeg-root/x.md') => findClaimBindings([{ path, content }])

  it('passes when the cited file still holds the literal', () => {
    const found = bindings('<!-- AEG:CLAIM: src/a.ts contains:function firstFiveLines( -->\nReads five lines.')
    const findings = evaluateClaimBindings(found, reader({ 'src/a.ts': 'function firstFiveLines(c: string) {}' }))

    expect(findings).toEqual([])
  })

  it('reports when the cited file no longer holds the literal', () => {
    const found = bindings('<!-- AEG:CLAIM: src/a.ts contains:function firstThreeLines( -->\nReads three lines.')
    const findings = evaluateClaimBindings(found, reader({ 'src/a.ts': 'function firstFiveLines(c: string) {}' }))

    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('no longer holds')
    expect(findings[0]?.message).toContain('never reword an unbound claim')
  })

  it('reports a missing cited file rather than passing it silently', () => {
    const found = bindings('<!-- AEG:CLAIM: src/gone.ts contains:anything -->\nSentence.')
    const findings = evaluateClaimBindings(found, reader({}))

    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('could not be read')
  })

  it('honours an absent pin, and reports it when the literal reappears', () => {
    const found = bindings('<!-- AEG:CLAIM: src/a.ts absent:legacyFlag -->\nNo longer supported.')

    expect(evaluateClaimBindings(found, reader({ 'src/a.ts': 'const x = 1' }))).toEqual([])
    expect(evaluateClaimBindings(found, reader({ 'src/a.ts': 'const legacyFlag = 1' }))).toHaveLength(1)
  })

  it('names the pin as stale, and says to update it, when a sha256 binding no longer matches', () => {
    const found = bindings(`<!-- AEG:CLAIM: src/a.ts sha256:${'b'.repeat(64)} -->\nSentence.`)
    const findings = evaluateClaimBindings(found, reader({ 'src/a.ts': 'contents' }))

    expect(findings[0]?.message).toContain('update the pin in this same PR')
  })

  it('passes a sha256 binding that still matches, hashing the file as it actually is', () => {
    const body = '<!-- AEG:CLAIM: src/a.ts contains:x -->\ncontents'
    const digest = createHash('sha256').update(body).digest('hex')
    const found = bindings(`<!-- AEG:CLAIM: src/a.ts sha256:${digest} -->\nSentence.`)

    expect(evaluateClaimBindings(found, reader({ 'src/a.ts': body }))).toEqual([])
  })

  it('refuses a self-satisfying marker whose only evidence is the marker text itself', () => {
    const content = ['<!-- AEG:CLAIM: aeg-root/x.md contains:AEG:CLAIM -->', 'Markers exist.'].join('\n')
    const found = bindings(content)
    const findings = evaluateClaimBindings(found, reader({ 'aeg-root/x.md': content }))

    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('no longer holds')
  })

  it('refuses a cited path that escapes the repository, without reading anything', () => {
    const found = bindings('<!-- AEG:CLAIM: ../../etc/hosts contains:localhost -->\nSentence.')
    let read = false
    const findings = evaluateClaimBindings(found, () => {
      read = true
      return 'localhost'
    })

    expect(read).toBe(false)
    expect(findings[0]?.message).toContain('not a repo-root-relative path')
  })
})

describe('checkDocClaims — both phases in one call', () => {
  it('returns malformed markers and broken bindings together', () => {
    const files: DocClaimSourceFile[] = [
      { path: 'aeg-root/x.md', content: '<!-- AEG:CLAIM: src/a.ts holds:x -->' },
      { path: 'aeg-root/y.md', content: '<!-- AEG:CLAIM: src/a.ts contains:gone -->' }
    ]
    const { findings, bindingCount } = checkDocClaims(files, reader({ 'src/a.ts': 'present' }))

    expect(bindingCount).toBe(1)
    expect(findings.map((f) => f.file)).toEqual(['aeg-root/x.md', 'aeg-root/y.md'])
  })

  it('is silent on a corpus with no markers at all', () => {
    expect(checkDocClaims([{ path: 'aeg-root/x.md', content: 'Ordinary prose.' }], reader({}))).toEqual({
      findings: [],
      bindingCount: 0
    })
  })
})
