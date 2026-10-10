import { describe, expect, it } from 'vitest'
import {
  PATTERN_EXEMPT,
  PLAN_ON_DISK_PATTERNS,
  RETIRED_EXEMPT_SUBSTRINGS,
  RETIRED_PATTERNS,
  scanRetiredVocabulary
} from './retired-vocabulary'

/**
 * Unlike `retired-vocabulary.test.ts` (which proves the vitest suite's own
 * `grep -E` patterns against the real repo tree), this proves the pure,
 * zero-I/O `scanRetiredVocabulary` evaluator this task's CheckSpec adapter
 * calls — synthetic in-memory files only, same charter as
 * `reader-resolvable-prose.test.ts`.
 */
describe('scanRetiredVocabulary', () => {
  it('flags a real instance of every pattern — the gate can see what it bans', () => {
    const samples: Record<string, string> = {
      '\\bD-[0-9]{3}\\b': 'see D-097 for the rule',
      'D-(###|NNN|nnn|xxx)': 'a Tier 3 change requiring a D-###',
      'decision (entry|logged)': 'every Tier 3 change needs a decision entry',
      'decision-log entry': 'requires a decision-log entry',
      'decision log entry': 'requires a decision log entry',
      'decision log(s|ged|ging)?([^a-z]|$)': 'read the decision log first',
      'decision-log': 'a decision-log entry is required',
      'decision entr': 'add a decision entry',
      'decisions? (are |is )?logged': 'why decisions are logged',
      'log entries': 'Type 1 decisions without log entries',
      'decisions\\.md': 'log it to decisions.md',
      'decisions-legacy': 'a task updates docs/decisions-legacy.md',
      CONTRADICTION: 'open a ## CONTRADICTION — <topic> entry',
      'assumes Tier 3': 'verify-docs assumes Tier 3 when no tier is declared',
      'Lock: ?YES': 'D-035 (`Lock: YES`)',
      'Lock: ?NO': 'a `Lock: NO` decision is just as committed',
      'lock approvals?': 'the Principal grants lock approval',
      'approves locks': 'the Principal approves locks',
      'Conforms to lock': 'Conforms to lock: yes',
      'Challenges lock': 'Challenges lock: no',
      checkDecisionNumbersFresh: 'checkDecisionNumbersFresh refuses the branch',
      'roles/team-leader\\.md': 'see roles/team-leader.md',
      '\\(,': 'a rationale block (, point-of-power principle) shipped once',
      ',\\)': 'the seam contract (planner-brief contract,) named here',
      '\\(\\.\\)': 'forces every agent back for the rules. (.)',
      '[Tt]opology files?': 'the Planner edits the thin topology file at plan time',
      'aeg-root/tranches/': 'every active tranche file sits in aeg-root/tranches/',
      'aeg-project/': 'append the retrospective to aeg-project/lessons.md'
    }

    for (const pattern of RETIRED_PATTERNS) {
      const sample = samples[pattern]
      expect(sample, `no sample for pattern ${pattern} — add one`).toBeDefined()
      const findings = scanRetiredVocabulary([{ path: 'aeg-root/some-doc.md', content: sample as string }])
      expect(
        findings.some((f) => f.pattern === pattern),
        `pattern never matched its own sample: ${pattern}`
      ).toBe(true)
    }
  })

  it('never matches "decision logic" — ordinary English stays legal', () => {
    const findings = scanRetiredVocabulary([
      { path: 'aeg-root/some-doc.md', content: 'all decision logic lives in the evaluator' }
    ])
    expect(findings).toEqual([])
  })

  it('skips a file whose path carries a RETIRED_EXEMPT_SUBSTRINGS entry', () => {
    const findings = scanRetiredVocabulary([
      { path: 'aeg-root/tranches/completed/old-tranche.md', content: 'a decision-log entry is required' }
    ])
    expect(findings).toEqual([])
  })

  it("skips a file whose path carries that pattern's own PATTERN_EXEMPT entry", () => {
    expect(PATTERN_EXEMPT['decisions-legacy']).toContain('docs-index.md')
    const findings = scanRetiredVocabulary([
      { path: 'docs-index.md', content: 'see docs/decisions-legacy.md for history' }
    ])
    expect(findings).toEqual([])
  })

  it('reports the real file and 1-indexed line of a match', () => {
    const findings = scanRetiredVocabulary([
      { path: 'aeg-root/glossary.md', content: 'line one\nline two\napproves locks\n' }
    ])
    expect(findings).toEqual([
      {
        file: 'aeg-root/glossary.md',
        line: 3,
        pattern: 'approves locks',
        message: expect.stringContaining('retired AEG mechanism')
      }
    ])
  })

  it('flags the plan-on-disk layout in any doctrine page but the tranche model', () => {
    const content = [
      'Topology files list the edges.',
      'the archive is aeg-root/tranches/completed/',
      'state lives under aeg-project/state.md'
    ].join('\n')
    const findings = scanRetiredVocabulary([{ path: '/repo/aeg-root/state-machine.md', content }])
    expect(findings.map((f) => [f.line, f.pattern])).toEqual([
      [1, '[Tt]opology files?'],
      [2, 'aeg-root/tranches/'],
      [3, 'aeg-project/']
    ])
  })

  it('exempts the tranche model by file for the plan-on-disk patterns, and for nothing else', () => {
    for (const pattern of PLAN_ON_DISK_PATTERNS) expect(PATTERN_EXEMPT[pattern]).toEqual(['/tranche-model.md'])
    const content = [
      '## 4. The thin tranche file — retired',
      'There is no topology file, and aeg-root/tranches/ holds nothing but the archive; aeg-project/ is gone.',
      'see the approves locks rule'
    ].join('\n')
    const findings = scanRetiredVocabulary([{ path: '/repo/aeg-root/tranche-model.md', content }])
    expect(findings.map((f) => [f.line, f.pattern])).toEqual([[3, 'approves locks']])
  })

  it("RETIRED_EXEMPT_SUBSTRINGS exempts this module's own file — it legitimately carries every pattern as data", () => {
    expect(RETIRED_EXEMPT_SUBSTRINGS.some((e) => 'packages/aeg-core/src/retired-vocabulary.ts'.includes(e))).toBe(true)
  })
})
