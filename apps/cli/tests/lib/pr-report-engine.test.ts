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
import { buildPrincipalTestPlanWaitErrors } from '../../src/checks/bin/check-principal-test-plan-wait'
import { compareEvidenceBlock, EVIDENCE_PLACEHOLDER_TEXT } from '../../src/checks/evidence-fresh-logic'
import { resolveAnchoredRegion, ScanContext } from '../../src/checks/scan-context'
import { agentCommandText, extractAgentCommandLines } from '../../src/commands/pr-report'
import { buildReport, type GateRunResult, runReportForOpenPr, spliceIntoLiveBody } from '../../src/lib/pr-report-engine'

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

// ---------------------------------------------------------------------------
// The wait state a `[principal]` Test Plan box represents must not refuse this
// push. `principal-test-plan-wait` reports one all-`pending` error while the
// box is unticked and is NOT `principalOwed` (that flag would turn its red
// green at the merge gate, which is the one thing it exists to hold), so the
// write path excludes it by reading `CheckError.pending` alone
// (`isPendingOnlyFailure`, `forge-write.ts`).
//
// The real core check runs here — nothing is registered to stand in for it:
// `runReportForOpenPr` is given a real PR number, so the registry's own
// `requiresOpenPr` entries all run. Other core body checks fail in this
// fixture (no git repo, no live PR), so the assertion is about which name the
// refusal can carry, never that nothing refuses — under the old,
// `principalOwed`-gated rule this message named `principal-test-plan-wait`,
// which is exactly how a whole green loop kept its template placeholder.
// ---------------------------------------------------------------------------

const BODY_WITH_UNTICKED_PRINCIPAL = [
  'Closes #1',
  '',
  '<!-- AEG:EVIDENCE:START -->',
  EVIDENCE_PLACEHOLDER_TEXT,
  '<!-- AEG:EVIDENCE:END -->',
  '',
  '## Test Plan',
  '',
  '- [ ] [principal] Open the PR in a signed-in browser and confirm the Evidence block reads fresh',
  ''
].join('\n')

describe('runReportForOpenPr — an unticked [principal] Test Plan box never refuses the push (O1)', () => {
  it('never names principal-test-plan-wait in a refusal, though that check really does report its wait state for this body', async () => {
    // Guards the assertion below against going vacuous: the real check must
    // genuinely fail on this body, with every error `pending`.
    const waitErrors = buildPrincipalTestPlanWaitErrors(BODY_WITH_UNTICKED_PRINCIPAL, 'task/x')
    expect(waitErrors.length).toBeGreaterThan(0)
    expect(waitErrors.every((e) => e.pending === true)).toBe(true)

    const cwd = tempCwd()
    const originalCwd = process.cwd()
    process.chdir(cwd)
    try {
      const result = await buildReport({
        groupA: FIXED_GROUP_A,
        gateRunner: () => PASSING_GATES,
        groupC: { commands: [] },
        body: BODY_WITH_UNTICKED_PRINCIPAL,
        cwd
      })

      const outcome = await callNeverExiting(() =>
        runReportForOpenPr('1', BODY_WITH_UNTICKED_PRINCIPAL, result, { includeTokens: false, branch: 'task/x' })
      )

      // Asserted over the whole outcome, not only a `body-checks-refused`
      // message: this fixture (no git repo, no live PR) makes other core body
      // checks fail too, and the test must never go quietly vacuous if which
      // ones do ever changes.
      const rendered = JSON.stringify(outcome)
      expect(rendered).not.toContain('principal-test-plan-wait')
      expect(rendered).not.toContain('unticked [principal] Test Plan item')
    } finally {
      process.chdir(originalCwd)
    }
  }, 60000)
})

// ---------------------------------------------------------------------------
// O2 — the point of letting that push through: once it lands, the Principal's
// tick (which re-runs the body checks against the live body) finds a real
// block bound to the judged head, so `evidence-fresh` stays green. Graded
// with the same pure comparison the check's own bin calls, over the same
// spliced bytes `runReportForOpenPr` sends, with `hasPriorDeveloperRound:
// true` — a round HAS happened by then, which is precisely when the untouched
// placeholder stops being exempt.
// ---------------------------------------------------------------------------

describe('a pushed evidence block survives the [principal] tick — evidence-fresh stays green (O2)', () => {
  function evidenceVerdict(body: string): 'pass' | 'fail' {
    const resolved = resolveAnchoredRegion(ScanContext.from(body), 'EVIDENCE')
    if (resolved === null || resolved === 'hidden') throw new Error('fixture body has no resolvable evidence region')
    return compareEvidenceBlock(
      resolved,
      FIXED_GROUP_A.head,
      FIXED_GROUP_A.numstat,
      extractAgentCommandLines(body).map(agentCommandText),
      undefined,
      true
    ).status
  }

  const tick = (body: string): string => body.replace('- [ ] [principal]', '- [x] [principal]')

  it('the spliced body passes after the tick, where the placeholder the refusal left behind fails', async () => {
    const cwd = tempCwd()
    const result = await buildReport({
      groupA: FIXED_GROUP_A,
      gateRunner: () => PASSING_GATES,
      groupC: { commands: [] },
      body: BODY_WITH_UNTICKED_PRINCIPAL,
      cwd
    })

    const pushed = spliceIntoLiveBody(BODY_WITH_UNTICKED_PRINCIPAL, result.blockInner, {
      collected: false,
      refusal: ''
    })

    expect(evidenceVerdict(tick(pushed.body))).toBe('pass')
    // The incident this closes: the write was refused for the whole life of
    // the loop, so the tick landed on the untouched placeholder instead.
    expect(evidenceVerdict(tick(BODY_WITH_UNTICKED_PRINCIPAL))).toBe('fail')
  }, 20000)
})
