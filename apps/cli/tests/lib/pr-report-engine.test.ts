/**
 * `runReportForOpenPr`'s push runs inside the developer-review loop's own
 * long-lived driver process — `runBodyChecks` (`forge-write.ts`) refusing
 * via `refuse()`'s direct `process.exit(1)` there would kill the whole
 * driver mid-round, not just this one push. `runReportForOpenPr` now goes
 * through `collectBodyCheckErrors` (the non-refusing half `runBodyChecks`
 * itself delegates to) instead, so it never reaches a line that could exit
 * the process at all. These tests exercise the real body-check registry (a
 * config-registered `validates: 'body'` fixture check that always refuses —
 * `fake-always-refuse-body-check.cjs`), proving the refusal comes back as
 * an ordinary `EvidenceReportOutcome`, and that an EARLIER, pre-existing
 * refusal path (`spliceIntoLiveBody`'s own `'splice-refused'`) is untouched.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildReport, type GateRunResult, runReportForOpenPr } from '../../src/lib/pr-report-engine'

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ALWAYS_REFUSE_BODY_CHECK = join(CLI_ROOT, 'tests', 'fixtures', 'forge', 'fake-always-refuse-body-check.cjs')

const FIXED_GROUP_A = { head: 'a'.repeat(40), base: 'b'.repeat(40), numstat: '' }
const PASSING_GATES: GateRunResult = { outcomes: [], failed: false }

class ExitCalled extends Error {
  constructor(public code: number | undefined) {
    super(`process.exit(${code})`)
  }
}

/**
 * Regression guard: if `runReportForOpenPr` (or anything it calls) ever
 * reaches the REAL `process.exit` again, this turns that into a thrown,
 * catchable error instead of actually killing the test runner — so a
 * regression fails this specific assertion loudly rather than aborting the
 * whole suite.
 */
async function callNeverExiting<T>(fn: () => Promise<T>): Promise<T> {
  const originalExit = process.exit
  process.exit = ((code?: number) => {
    throw new ExitCalled(code)
  }) as never
  try {
    return await fn()
  } finally {
    process.exit = originalExit
  }
}

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-pr-report-engine-'))
  tempDirs.push(dir)
  return dir
}

describe('runReportForOpenPr — a body-check refusal returns an outcome, never exits (O1)', () => {
  it("never reaches refuse()'s real process.exit(1) — returns 'body-checks-refused' carrying the same findings instead of the process dying mid-push", async () => {
    const cwd = tempCwd()
    writeFileSync(
      join(cwd, 'vinaya.config.json'),
      JSON.stringify({
        briefSchema: { pr: { sections: [] } },
        checks: {
          'fixture/always-refuse-body': {
            run: 'node',
            args: [ALWAYS_REFUSE_BODY_CHECK],
            scope: 'full',
            validates: 'body'
          }
        }
      })
    )
    const originalCwd = process.cwd()
    process.chdir(cwd)
    try {
      const result = await buildReport({
        groupA: FIXED_GROUP_A,
        gateRunner: () => PASSING_GATES,
        groupC: { commands: [] },
        body: 'Closes #1',
        cwd
      })
      const preEditBody = ['<!-- AEG:EVIDENCE:START -->', 'old', '<!-- AEG:EVIDENCE:END -->'].join('\n')

      const outcome = await callNeverExiting(() =>
        runReportForOpenPr('1', preEditBody, result, { includeTokens: false, branch: 'task/x' })
      )

      expect(outcome.kind).toBe('body-checks-refused')
      if (outcome.kind === 'body-checks-refused') {
        expect(outcome.message).toContain('fixture/always-refuse-body')
        expect(outcome.message).toContain('fake-always-refuse-body: fixture forces a body-check refusal')
      }
    } finally {
      process.chdir(originalCwd)
    }
  }, 20000)
})

describe('runReportForOpenPr — pre-existing outcome paths are unchanged (O3 boundary check)', () => {
  it("a live body with no AEG:EVIDENCE anchor pair still returns 'splice-refused' — the earliest refusal step, untouched by this task's change", async () => {
    const cwd = tempCwd()
    const originalCwd = process.cwd()
    process.chdir(cwd)
    try {
      const result = await buildReport({
        groupA: FIXED_GROUP_A,
        gateRunner: () => PASSING_GATES,
        groupC: { commands: [] },
        body: 'Closes #1',
        cwd
      })
      const outcome = await callNeverExiting(() =>
        runReportForOpenPr('1', 'no evidence anchors here', result, { includeTokens: false, branch: 'task/x' })
      )
      expect(outcome.kind).toBe('splice-refused')
    } finally {
      process.chdir(originalCwd)
    }
  }, 20000)
})
