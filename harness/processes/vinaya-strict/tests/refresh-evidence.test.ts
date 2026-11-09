import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pushedEvidenceMarker, refreshPrEvidence, type RefreshEvidenceDeps } from '../executing/refresh-evidence'
import { programFile } from '../tools/programs'
import { fixtureDir } from '../../../kernel/conformance/unit/test-temp-fixture'
import { refreshEvidenceStep, type TaskInput } from '../executing/actions'

const deps = (stdout: string, status: number, calls: unknown[] = []): RefreshEvidenceDeps => ({
  worktreePath: '/wt',
  prNumber: () => 42,
  readHead: () => 'abc123',
  runCli: (entry, cwd, args) => {
    calls.push([entry, cwd, args])
    return { status, stdout, stderr: 'err' }
  }
})

describe('refreshPrEvidence', () => {
  test('runs the pr report program with --push <pr> in the worktree', () => {
    const calls: unknown[] = []
    const result = refreshPrEvidence(deps('Pushed VINAYA:EVIDENCE block to PR 42\n', 0, calls))
    expect(calls).toEqual([[programFile('pr-report'), '/wt', ['--push', '42']]])
    expect(result).toEqual({
      head: 'abc123',
      checksPassed: true,
      evidence: 'Pushed VINAYA:EVIDENCE block to PR 42\nerr'
    })
  })

  test('a red gate that still pushed returns checksPassed false', () => {
    expect(refreshPrEvidence(deps('Pushed VINAYA:EVIDENCE block to PR 42\n', 1)).checksPassed).toBe(false)
  })

  test('no push marker throws with the output', () => {
    expect(() => refreshPrEvidence(deps('refused', 1))).toThrow('pr report --push 42 failed:\nrefusederr')
    // A marker for another pull request is not this one's push.
    expect(() => refreshPrEvidence(deps('Pushed VINAYA:EVIDENCE block to PR 4\n', 0))).toThrow('failed')
  })
})

describe('the Evidence refresh step on a resumed round', () => {
  const stepFor = (head: () => string, base: () => string, writes: string[]) => {
    const runtimeDir = fixtureDir('refresh-evidence-')
    const task = {
      runtimeDir,
      issueNumber: 7,
      branch: 'task/t/7',
      worktreePath: '/wt',
      remoteHead: () => head(),
      bound: {
        readWorktreeHead: () => head(),
        findOpenPrForBranch: () => ({ number: 42, branch: 'task/t/7' }),
        readComparisonBase: () => base(),
        evidenceRetrySleep: () => {},
        refreshPrEvidence: () => {
          writes.push(head())
          return { head: head(), checksPassed: true }
        }
      }
    } as unknown as TaskInput
    return () => refreshEvidenceStep(task, { results: {} } as never)
  }

  test('a completed write is not repeated for the same head and comparison, and is for a changed one', () => {
    const writes: string[] = []
    let head = 'h1'
    let base = 'b1'
    const run = stepFor(
      () => head,
      () => base,
      writes
    )
    expect(JSON.parse(run().stdout)).toMatchObject({ evidence: 'written' })
    expect(JSON.parse(run().stdout)).toMatchObject({ evidence: 'reused' })
    expect(writes).toEqual(['h1'])
    head = 'h2'
    expect(JSON.parse(run().stdout)).toMatchObject({ evidence: 'written' })
    base = 'b2'
    expect(JSON.parse(run().stdout)).toMatchObject({ evidence: 'written' })
    expect(writes).toEqual(['h1', 'h2', 'h2'])
  })

  test('a red local gate or an unpushed head writes nothing', () => {
    const writes: string[] = []
    const run = stepFor(
      () => 'h1',
      () => 'b1',
      writes
    )
    const red = refreshEvidenceStep(
      { bound: {}, worktreePath: '/wt' } as unknown as TaskInput,
      {
        results: { 'run-mechanical-gates': { exitCode: 1 } }
      } as never
    )
    expect(JSON.parse(red.stdout)).toMatchObject({ evidence: 'skipped' })
    expect(run().exitCode).toBe(0)
  })
})

describe('the push marker', () => {
  test("is the line the CLI's pr report source prints after a push", () => {
    const source = readFileSync(resolve(import.meta.dir, '../tools/pr-report/bin/pr-report.ts'), 'utf8')
    const printed = [...source.matchAll(/process\.stdout\.write\(`(Pushed VINAYA:EVIDENCE[^`]*?)\$\{(\w+)\}\\n`\)/g)]
    expect(printed.length).toBe(1)
    const [, prefix] = printed[0] as RegExpMatchArray
    expect(`${prefix}42`).toBe(pushedEvidenceMarker(42))
  })
})
