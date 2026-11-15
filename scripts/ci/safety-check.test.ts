import { describe, expect, it } from 'bun:test'
import type { ReadRecord } from '@attalabs/test-selection'
import {
  type ChangeResult,
  judgeMisses,
  junitSuiteOf,
  missEvidence,
  mutationTexts,
  reportLines,
  type TreeName,
  unmeasuredReason,
  vitestFailureTexts
} from './safety-check.ts'

/** Recorded outcomes: which tests fail alone on which tree. */
function recorded(outcomes: Record<TreeName, string[]>) {
  const calls: Array<{ tree: TreeName; tests: string[] }> = []
  const failAlone = async (tree: TreeName, tests: string[]) => {
    calls.push({ tree, tests })
    return new Set(tests.filter((t) => outcomes[tree].includes(t)))
  }
  return { failAlone, calls }
}

describe('judgeMisses', () => {
  const selected = new Set(['kept.test.ts'])

  it('counts a reproduced failure outside the selection that passes on the unmutated head as a miss', async () => {
    const { failAlone } = recorded({ mutated: ['left-out.test.ts'], head: [] })
    expect(await judgeMisses({ failed: ['left-out.test.ts'], selected, failAlone })).toEqual([
      { test: 'left-out.test.ts', verdict: 'miss' }
    ])
  })

  it('does not count a failure that passes when run alone on the mutated tree', async () => {
    const { failAlone, calls } = recorded({ mutated: [], head: [] })
    expect(await judgeMisses({ failed: ['flaky.test.ts'], selected, failAlone })).toEqual([
      { test: 'flaky.test.ts', verdict: 'not-reproduced' }
    ])
    // A test that did not reproduce is never rerun on the head.
    expect(calls.map((c) => c.tree)).toEqual(['mutated'])
  })

  it('does not count a test that already fails alone on the unmutated head', async () => {
    const { failAlone } = recorded({ mutated: ['broken.test.ts'], head: ['broken.test.ts'] })
    expect(await judgeMisses({ failed: ['broken.test.ts'], selected, failAlone })).toEqual([
      { test: 'broken.test.ts', verdict: 'already-failing' }
    ])
  })

  it('never judges, or reruns, a failure inside the selection', async () => {
    const { failAlone, calls } = recorded({ mutated: ['kept.test.ts'], head: [] })
    expect(await judgeMisses({ failed: ['kept.test.ts'], selected, failAlone })).toEqual([])
    expect(calls).toEqual([])
  })

  it('reruns only the failures outside the selection, and on the head only those that reproduced', async () => {
    const { failAlone, calls } = recorded({
      mutated: ['a.test.ts', 'b.test.ts', 'kept.test.ts'],
      head: ['b.test.ts']
    })
    const judged = await judgeMisses({
      failed: ['kept.test.ts', 'c.test.ts', 'b.test.ts', 'a.test.ts', 'a.test.ts'],
      selected,
      failAlone
    })
    expect(judged).toEqual([
      { test: 'a.test.ts', verdict: 'miss' },
      { test: 'b.test.ts', verdict: 'already-failing' },
      { test: 'c.test.ts', verdict: 'not-reproduced' }
    ])
    expect(calls).toEqual([
      { tree: 'mutated', tests: ['a.test.ts', 'b.test.ts', 'c.test.ts'] },
      { tree: 'head', tests: ['a.test.ts', 'b.test.ts'] }
    ])
  })
})

describe('unmeasuredReason', () => {
  const record = { schema: 'x', schemaVersion: 2, commit: 'c', platform: 'linux', tests: {} } as unknown as ReadRecord

  it('reports a change with no reachable record as unmeasured, with why', () => {
    expect(unmeasuredReason({ record: null, recordNote: 'no run for c', mutated: 3 })).toContain('no run for c')
  })

  it('reports a change the mutation tool changed nothing of as unmeasured', () => {
    expect(unmeasuredReason({ record, recordNote: '', mutated: 0 })).toContain('changed no function')
  })

  it('measures a change that has a record and a mutation', () => {
    expect(unmeasuredReason({ record, recordNote: '', mutated: 1 })).toBeNull()
  })
})

describe('mutation evidence', () => {
  it('reads the mutation text out of a JUnit failure message, entities decoded', () => {
    const xml = '<failure type="Error" message="mutate-changes: src/a.ts:12 Foo.&lt;anonymous&gt;&#10;    at run"/>'
    expect(mutationTexts(xml)).toEqual(['src/a.ts:12 Foo.<anonymous>'])
  })

  it('reads it out of a Vitest JSON report by file', () => {
    const json = JSON.stringify({
      testResults: [
        {
          name: '/root/pkg/a.test.ts',
          assertionResults: [{ failureMessages: ['Error: mutate-changes: pkg/a.ts:3 f\n at x'] }]
        },
        { name: '/root/pkg/b.test.ts', assertionResults: [] }
      ]
    })
    const texts = vitestFailureTexts(json, '/root')
    expect(mutationTexts(texts.get('pkg/a.test.ts') ?? '')).toEqual(['pkg/a.ts:3 f'])
    expect(texts.has('pkg/b.test.ts')).toBe(false)
  })

  const mutation = {
    mutated: [
      { file: 'src/a.ts', functions: [{ name: 'f', line: 4, functionLine: 3 }] },
      { file: 'src/b.ts', functions: [{ name: 'g', line: 9, functionLine: 8 }] }
    ]
  }

  it('names the line the failure message carries', () => {
    expect(missEvidence({ messages: 'mutate-changes: src/b.ts:9 g', reads: ['src/a.ts'], mutation })).toBe(
      'src/b.ts:9 g'
    )
  })

  it('otherwise names the mutated functions in the files the test read', () => {
    const text = missEvidence({ messages: 'expected 1 to be 2', reads: ['src/a.ts', 'README.md'], mutation })
    expect(text).toContain('src/a.ts:4 f')
    expect(text).not.toContain('src/b.ts')
  })

  it('names every mutated function when no record says what the test read', () => {
    const text = missEvidence({ messages: undefined, reads: undefined, mutation })
    expect(text).toContain('src/a.ts:4 f')
    expect(text).toContain('src/b.ts:9 g')
  })
})

describe('junitSuiteOf', () => {
  const xml =
    '<testsuites><testsuite name="a.test.ts" tests="1"><failure message="mutate-changes: src/a.ts:1 f"/></testsuite>' +
    '<testsuite name="b.test.ts" tests="1"><failure message="mutate-changes: src/b.ts:2 g"/></testsuite></testsuites>'

  it('keeps only the suite of the named file', () => {
    expect(mutationTexts(junitSuiteOf(xml, 'b.test.ts', false))).toEqual(['src/b.ts:2 g'])
  })

  it('gives nothing for a file with no suite unless the group holds only that file', () => {
    expect(junitSuiteOf(xml, 'c.test.ts', false)).toBe('')
    expect(junitSuiteOf(xml, 'c.test.ts', true)).toBe(xml)
  })
})

describe('reportLines', () => {
  const base: ChangeResult = {
    head: 'abcdef0123456789',
    subject: 'Fix(x): thing',
    selected: 12,
    total: 340,
    unmeasured: null,
    misses: [],
    notMisses: []
  }

  it('reports the selected count against the suite size for every change', () => {
    expect(reportLines(base)[0]).toContain('selected 12 of 340 tests')
  })

  it('names each miss and its mutated line', () => {
    const lines = reportLines({ ...base, misses: [{ test: 'a.test.ts', evidence: 'src/a.ts:4 f' }] })
    expect(lines[0]).toContain('MISS abcdef012345')
    expect(lines[1]).toBe('  a.test.ts: src/a.ts:4 f')
  })

  it('never reports an unmeasured change as passing', () => {
    const [line] = reportLines({ ...base, unmeasured: 'no read record is reachable' })
    expect(line).toStartWith('UNMEASURED')
    expect(line).not.toStartWith('ok')
  })
})
