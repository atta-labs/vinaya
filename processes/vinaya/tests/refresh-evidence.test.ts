import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pushedEvidenceMarker, refreshPrEvidence, type RefreshEvidenceDeps } from '../executing/refresh-evidence'

const deps = (stdout: string, status: number, calls: unknown[] = []): RefreshEvidenceDeps => ({
  cliEntry: '/repo/apps/cli/src/index.ts',
  worktreePath: '/wt',
  prNumber: () => 42,
  readHead: () => 'abc123',
  runCli: (entry, cwd, args) => {
    calls.push([entry, cwd, args])
    return { status, stdout, stderr: 'err' }
  }
})

describe('refreshPrEvidence', () => {
  test('runs pr report --push <pr> from the named CLI entry in the worktree', () => {
    const calls: unknown[] = []
    const result = refreshPrEvidence(deps('Pushed AEG:EVIDENCE block to PR 42\n', 0, calls))
    expect(calls).toEqual([['/repo/apps/cli/src/index.ts', '/wt', ['pr', 'report', '--push', '42']]])
    expect(result).toEqual({ head: 'abc123', checksPassed: true, evidence: 'Pushed AEG:EVIDENCE block to PR 42\nerr' })
  })

  test('a red gate that still pushed returns checksPassed false', () => {
    expect(refreshPrEvidence(deps('Pushed AEG:EVIDENCE block to PR 42\n', 1)).checksPassed).toBe(false)
  })

  test('no push marker throws with the output', () => {
    expect(() => refreshPrEvidence(deps('refused', 1))).toThrow('pr report --push 42 failed:\nrefusederr')
    // A marker for another pull request is not this one's push.
    expect(() => refreshPrEvidence(deps('Pushed AEG:EVIDENCE block to PR 4\n', 0))).toThrow('failed')
  })
})

describe('the push marker', () => {
  test("is the line the CLI's pr report source prints after a push", () => {
    const source = readFileSync(resolve(import.meta.dir, '../../../apps/cli/src/commands/pr-report.ts'), 'utf8')
    const printed = [...source.matchAll(/process\.stdout\.write\(`(Pushed AEG:EVIDENCE[^`]*?)\$\{(\w+)\}\\n`\)/g)]
    expect(printed.length).toBe(1)
    const [, prefix] = printed[0] as RegExpMatchArray
    expect(`${prefix}42`).toBe(pushedEvidenceMarker(42))
  })
})
