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
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPrincipalTestPlanWaitErrors } from '../../src/checks/bin/check-principal-test-plan-wait'
import { compareEvidenceBlock, EVIDENCE_PLACEHOLDER_TEXT } from '../../src/checks/evidence-fresh-logic'
import { resolveAnchoredRegion, ScanContext } from '../../src/checks/scan-context'
import { agentCommandText, extractAgentCommandLines } from '../../src/commands/pr-report'
import { checkBareDigits } from '../../src/checks/body-bare-digits-logic'
import {
  buildReport,
  commandRunsCheckAll,
  computeGroupC,
  DeferredEvidenceError,
  type DeferredGroupCDeps,
  describeReuse,
  type GateRunResult,
  type GroupC,
  groupCFailed,
  recordGreenTestRun,
  renderGroupC,
  resolveDeferredGroupC,
  runReportForOpenPr,
  spliceIntoLiveBody,
  type TestRunCacheRecord,
  testRunCacheKey
} from '../../src/lib/pr-report-engine'
import { readyCiPlanCommand } from '../../src/lib/pre-push-ready-policy'
import { isNativeRunCommand, nativeRunCommand, REPOSITORY_LOCAL_RUN } from '../../src/lib/pre-push-test-runner'

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

      const outcome = await callNeverExiting(() => runReportForOpenPr('1', preEditBody, result, { branch: 'task/x' }))

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
        runReportForOpenPr('1', 'no evidence anchors here', result, { branch: 'task/x' })
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
        runReportForOpenPr('1', BODY_WITH_UNTICKED_PRINCIPAL, result, { branch: 'task/x' })
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

    const pushed = spliceIntoLiveBody(BODY_WITH_UNTICKED_PRINCIPAL, result.blockInner)

    expect(evidenceVerdict(tick(pushed))).toBe('pass')
    // The incident this closes: the write was refused for the whole life of
    // the loop, so the tick landed on the untouched placeholder instead.
    expect(evidenceVerdict(tick(BODY_WITH_UNTICKED_PRINCIPAL))).toBe('fail')
  }, 20000)
})

// ---------------------------------------------------------------------------
// A Test-plan command whose result was reused from a cached green run gets a
// prose note after its fence naming that run — its record time, its source,
// and, for a per-file hit, how many files it covered. Those digits sit in
// ordinary prose inside the `AEG:EVIDENCE` region, where `body-bare-digits`
// exempts only the `Head:`/`Summary:` lines and the headings: unbackticked,
// `pr report --write`/`--push` refused the very body it had just generated,
// on the ordinary path (the pre-push hook writes that cache on the one push
// every Developer makes). The check below is the REAL check over a REAL
// generated block — never a regex of this test's own.
// ---------------------------------------------------------------------------

describe('the evidence block a reused Test-plan entry produces passes body-bare-digits (O1)', () => {
  const REUSED_FILES = Array.from(
    { length: 14 },
    (_, i) => `/repo/apps/cli/tests/lib/f${String.fromCharCode(97 + i)}.test.ts`
  )
  const PER_FILE_HIT = { recordedAt: '2026-09-26T04:45:06.812Z', source: 'pre-push', files: REUSED_FILES }
  const EXACT_COMMAND_HIT = { recordedAt: '2026-09-26T04:45:06.812Z', source: 'pr-report' }

  // `body-bare-digits` blanks an `AEG:EVIDENCE` region's `Head:` line and its
  // headings only when the region sits under its own canonical `## Evidence`
  // section (`isInCanonicalSection`) — so the block is graded where a real PR
  // body carries it, spliced into a live body, never as a bare string.
  const LIVE_BODY = [
    '## Evidence',
    '',
    '<!-- AEG:EVIDENCE:START -->',
    EVIDENCE_PLACEHOLDER_TEXT,
    '<!-- AEG:EVIDENCE:END -->',
    ''
  ].join('\n')

  async function bodyWithReuseNote(reusedFrom: string): Promise<string> {
    const groupC: GroupC = {
      commands: [
        {
          command: 'bun test apps/cli/tests/lib/pr-report-engine.test.ts',
          output: '14 pass, 0 fail',
          exitCode: 0,
          timedOut: false,
          overflowed: false,
          reusedFrom
        },
        {
          command: 'bun apps/cli/src/index.ts check --all',
          output: 'all checks green',
          exitCode: 0,
          timedOut: false,
          overflowed: false
        }
      ]
    }
    const result = await buildReport({
      groupA: FIXED_GROUP_A,
      gateRunner: () => PASSING_GATES,
      groupC,
      body: LIVE_BODY,
      cwd: tempCwd()
    })
    return spliceIntoLiveBody(LIVE_BODY, result.blockInner)
  }

  it('a per-file hit names its run — time, source and file count — with every digit inside a code span', async () => {
    const body = await bodyWithReuseNote(describeReuse(PER_FILE_HIT))

    // The note keeps every fact a reviewer judges the evidence by.
    expect(body).toContain('Reused from a green run recorded `2026-09-26T04:45:06.812Z` (pre-push)')
    expect(body).toContain('`covering 14 file(s)` including every file this command names')
    expect(checkBareDigits(body).violations).toEqual([])
  }, 20000)

  it('an exact-command hit — no file count at all — also passes', async () => {
    const body = await bodyWithReuseNote(describeReuse(EXACT_COMMAND_HIT))

    expect(body).toContain('Reused from a green run recorded `2026-09-26T04:45:06.812Z` (pr-report) — not re-run.')
    expect(checkBareDigits(body).violations).toEqual([])
  }, 20000)

  it('the unbackticked note this replaced really is refused — the assertions above have teeth', async () => {
    const body = await bodyWithReuseNote(
      `a green run recorded ${PER_FILE_HIT.recordedAt} (${PER_FILE_HIT.source}), covering ${REUSED_FILES.length} file(s) including every file this command names`
    )

    const refused = checkBareDigits(body).violations
    expect(refused.length).toBeGreaterThan(0)
    expect(refused.some((v) => v.text.startsWith('_Reused from a green run recorded'))).toBe(true)
  }, 20000)
})

describe('a Test-plan entry that really ran renders exactly as before (O2)', () => {
  it('no reuse note, and the heading/fence shape is byte-identical', () => {
    const groupC: GroupC = {
      commands: [
        {
          command: 'bun test apps/cli/tests/lib/pr-report-engine.test.ts',
          output: '14 pass, 0 fail',
          exitCode: 0,
          timedOut: false,
          overflowed: false
        }
      ]
    }

    expect(renderGroupC(groupC)).toBe(
      [
        '### Group C — Test Plan commands',
        '',
        '#### C1: `bun test apps/cli/tests/lib/pr-report-engine.test.ts`',
        '',
        '```',
        '14 pass, 0 fail',
        '```'
      ].join('\n')
    )
  })
})

// ---------------------------------------------------------------------------
// #788 — a Test Plan naming `check --all` can never record it passing while
// `evidence-fresh` inside that Group C run grades the very AEG:EVIDENCE block
// this same report is about to write. Group C leaves `evidence-fresh` out of
// exactly those runs (O1), says so on one line (O2), and touches nothing else
// (O3). The exclusion travels as an env var into the spawned `vinaya check`,
// never by rewriting the recorded command text.
// ---------------------------------------------------------------------------

describe('commandRunsCheckAll — which Group C commands drop evidence-fresh (#788)', () => {
  it('is true for a `check --all` invocation however the binary is spelled', () => {
    expect(commandRunsCheckAll('bun apps/cli/src/index.ts check --all')).toBe(true)
    expect(commandRunsCheckAll('vinaya check --all')).toBe(true)
    expect(commandRunsCheckAll('vinaya check --all --diff-only')).toBe(true)
  })

  it('is false for anything that is not a bare `check` + `--all` pair', () => {
    // A different command entirely.
    expect(commandRunsCheckAll('bun test apps/cli/tests/lib/pr-report-engine.test.ts')).toBe(false)
    // A single check named on its own is not `--all` — never excluded (O3).
    expect(commandRunsCheckAll('vinaya check evidence-fresh')).toBe(false)
    // Token-exact: `checking`/`--all-of-them` are not `check`/`--all`.
    expect(commandRunsCheckAll('echo checking --all-of-them')).toBe(false)
  })
})

describe('renderGroupC — the O2 omission note for a `check --all` run (#788)', () => {
  const CHECK_ALL: GroupC['commands'][number] = {
    command: 'bun apps/cli/src/index.ts check --all',
    output: 'all checks green',
    exitCode: 0,
    timedOut: false,
    overflowed: false
  }

  it('names the omission and why, appended BELOW the fence so the fence is byte-identical', () => {
    const plain = renderGroupC({ commands: [CHECK_ALL] })
    const omitted = renderGroupC({ commands: [{ ...CHECK_ALL, omittedEvidenceFresh: true }] })

    // The whole plain render — heading, fence, output — is an exact prefix of
    // the omitted one: the note adds only trailing prose, changing no byte a
    // fresh run of the same command would have produced (and none
    // `evidence-fresh`'s own `#### C<n>:` heading attestation reads).
    expect(omitted.startsWith(plain)).toBe(true)
    const note = omitted.slice(plain.length)
    expect(note).toContain('`evidence-fresh` was left out of this run')
    expect(note).toContain("CI's own `vinaya check --all --diff-only` is its authoritative run")
  })

  it('a run WITHOUT the flag renders exactly as before — no note (O3)', () => {
    expect(renderGroupC({ commands: [CHECK_ALL] })).not.toContain('was left out of this run')
  })

  it('the note passes body-bare-digits once spliced into a real live body (O2)', async () => {
    const LIVE_BODY = [
      '## Evidence',
      '',
      '<!-- AEG:EVIDENCE:START -->',
      EVIDENCE_PLACEHOLDER_TEXT,
      '<!-- AEG:EVIDENCE:END -->',
      ''
    ].join('\n')
    const result = await buildReport({
      groupA: FIXED_GROUP_A,
      gateRunner: () => PASSING_GATES,
      groupC: { commands: [{ ...CHECK_ALL, omittedEvidenceFresh: true }] },
      body: LIVE_BODY,
      cwd: tempCwd()
    })
    const spliced = spliceIntoLiveBody(LIVE_BODY, result.blockInner)
    expect(spliced).toContain('`evidence-fresh` was left out of this run')
    expect(checkBareDigits(spliced).violations).toEqual([])
  }, 20000)
})

describe('computeGroupC — the exclusion reaches only the `check --all` command (#788)', () => {
  // Two Test Plan commands, each echoing `$VINAYA_CHECK_EXCLUDE` so its own
  // spawned environment is observable in its recorded output. Only the first
  // is a `check --all` command, so only its spawn should carry the exclusion.
  const BODY = [
    '## Test Plan',
    '',
    '```',
    'echo check --all exclude=$VINAYA_CHECK_EXCLUDE → prints evidence-fresh',
    'echo probe exclude=$VINAYA_CHECK_EXCLUDE → prints nothing',
    '```',
    ''
  ].join('\n')

  it('the `check --all` command sees evidence-fresh excluded and is flagged; the other sees nothing', async () => {
    const groupC = await computeGroupC(BODY, tempCwd())
    expect(groupC.commands).toHaveLength(2)

    // The `check --all` command: env carried the exclusion, and the result is
    // flagged so `renderGroupC` can state it (O1, O2).
    expect(groupC.commands[0]?.omittedEvidenceFresh).toBe(true)
    expect(groupC.commands[0]?.output).toBe('check --all exclude=evidence-fresh')

    // The other command: the exclusion env was never set for it, so the
    // variable expands to empty — never leaked from the sibling command (O3).
    expect(groupC.commands[1]?.omittedEvidenceFresh).toBeFalsy()
    expect(groupC.commands[1]?.output).toBe('probe exclude=')
  }, 20000)
})

describe('the report engine on a head whose tests are deferred to required CI', () => {
  const POLICY = { mode: 'ci' as const, workflow: '.github/workflows/ci.yml', check: 'Vinaya CI' }
  const HEAD = 'c'.repeat(40)
  const RECORD = {
    version: 1 as const,
    kind: 'ready' as const,
    head: HEAD,
    branch: 'task/issue-1',
    runId: 'r',
    workflow: POLICY.workflow,
    check: POLICY.check,
    recordedAt: 'now'
  }
  const ciLine = readyCiPlanCommand(POLICY)
  const store = () => {
    const records = new Map<string, TestRunCacheRecord>()
    return {
      get: (key: string) => records.get(key),
      set: (key: string, record: TestRunCacheRecord) => void records.set(key, record)
    }
  }
  const deps = (over: Partial<DeferredGroupCDeps> = {}): DeferredGroupCDeps => ({
    readHead: async () => HEAD,
    readRecord: () => RECORD,
    readPolicy: () => POLICY,
    ...over
  })

  it('an ordinary head (no record, no required-CI line) is not deferred: the ordinary path runs', async () => {
    expect(
      await resolveDeferredGroupC(['bun run test'], undefined, store(), deps({ readRecord: () => null }))
    ).toBeNull()
  })

  it('the required-CI line is pending — never a pass, never a failure — and renders so', async () => {
    const groupC = await resolveDeferredGroupC([ciLine], undefined, store(), deps())
    expect(groupC?.commands).toEqual([
      expect.objectContaining({
        command: ciLine,
        exitCode: null,
        pendingCi: { workflow: POLICY.workflow, check: POLICY.check, head: HEAD }
      })
    ])
    expect(groupCFailed(groupC as GroupC)).toBe(false)
    const rendered = renderGroupC(groupC as GroupC)
    expect(rendered).toContain(`#### C1: \`${ciLine}\``)
    expect(rendered).toContain('[pending in required CI]')
    expect(rendered).not.toContain('[exit')
  })

  it.each([
    ['another head’s record (or none)', { readRecord: () => null }, 'no deferred-tests record names head'],
    [
      'a policy that no longer opts in',
      { readPolicy: () => ({ mode: 'local' as const }) },
      'no longer names that check'
    ],
    ['a policy for another check', { readPolicy: () => ({ ...POLICY, check: 'Other' }) }, 'no longer names that check'],
    [
      'a failed policy read',
      {
        readPolicy: () => {
          throw new Error('offline')
        }
      },
      'could not be read'
    ]
  ])('refuses on %s', async (_name, over, message) => {
    await expect(resolveDeferredGroupC([ciLine], undefined, store(), deps(over))).rejects.toThrow(message)
  })

  it('a deferred head refuses a body that dropped the line, or carries a line for another check', async () => {
    await expect(resolveDeferredGroupC(['bun run test'], undefined, store(), deps())).rejects.toThrow(
      'must carry exactly one'
    )
    await expect(
      resolveDeferredGroupC([readyCiPlanCommand({ ...POLICY, check: 'Other' })], undefined, store(), deps())
    ).rejects.toThrow('must carry exactly one')
  })

  it('a named explicit command outside CI selection with no receipt is refused, never discharged as pending CI', async () => {
    await expect(
      resolveDeferredGroupC([ciLine, 'cd apps/cli && bun test tests/x.test.ts'], undefined, store(), deps())
    ).rejects.toThrow(DeferredEvidenceError)
  })
})

describe('the native selected suite: composed only from its context-bound receipt', () => {
  const CONTEXT = 'e'.repeat(64)
  const command = nativeRunCommand(CONTEXT, ['apps/cli/tests/a.test.ts@default', 'packages/x/b.test.ts@default'])
  const body = ['## Test Plan', '', '```', `${command} → every selected test passes`, '```', ''].join('\n')
  const store = () => {
    const records = new Map<string, TestRunCacheRecord>()
    return {
      get: (key: string) => records.get(key),
      set: (key: string, record: TestRunCacheRecord) => void records.set(key, record)
    }
  }
  function repo(): string {
    const dir = tempCwd()
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, stdio: 'ignore' })
    writeFileSync(join(dir, 'f.txt'), 'x\n')
    git('init', '-q', '-b', 'task/x/1')
    git('add', '.')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base')
    return dir
  }

  it('the aggregate command names its context and identities, and parses back', () => {
    expect(isNativeRunCommand(command)).toBe(true)
    expect(isNativeRunCommand('bun test --timeout=30000 -- ./a.test.ts')).toBe(false)
    expect(isNativeRunCommand(nativeRunCommand('short', ['a@default']))).toBe(false)
    expect(isNativeRunCommand(`bun ${REPOSITORY_LOCAL_RUN} exact --context ${CONTEXT} --`)).toBe(false)
  })

  it('a receipt recorded under the command’s own context composes; nothing runs', async () => {
    const dir = repo()
    const cache = store()
    expect(await recordGreenTestRun(command, ' 2 pass', dir, 'pre-push', cache, { context: CONTEXT })).toBe(true)
    const groupC = await computeGroupC(body, dir, {}, cache)
    expect(groupC.commands).toHaveLength(1)
    expect(groupC.commands[0]).toMatchObject({ command, exitCode: 0, output: ' 2 pass' })
    expect(groupC.commands[0]?.reusedFrom).toBeDefined()
    expect(groupCFailed(groupC)).toBe(false)
  })

  it('no receipt, an unqualified one, or one filed under another context is reported not run, never a pass', async () => {
    const dir = repo()
    // An entry written before contexts were recorded: the exact key, no context.
    const legacy = store()
    legacy.set((await testRunCacheKey(command, dir)) as string, {
      output: ' 2 pass',
      exitCode: 0,
      timedOut: false,
      overflowed: false,
      recordedAt: '2026-10-01T00:00:00.000Z',
      source: 'pre-push'
    })
    expect(await recordGreenTestRun(command, ' 2 pass', dir, 'pre-push', store())).toBe(false)
    for (const cache of [store(), legacy]) {
      const groupC = await computeGroupC(body, dir, {}, cache)
      expect(groupC.commands[0]).toMatchObject({ command, exitCode: null, receiptMissing: true })
      expect(groupCFailed(groupC)).toBe(true)
      expect(renderGroupC(groupC)).toContain('[not run: no matching receipt]')
    }
    const other = store()
    expect(await recordGreenTestRun(command, ' 2 pass', dir, 'pre-push', other, { context: 'f'.repeat(64) })).toBe(
      false
    )
    expect((await computeGroupC(body, dir, {}, other)).commands[0]?.receiptMissing).toBe(true)
  })

  it('a receipt for one state never stands for another tree', async () => {
    const dir = repo()
    const cache = store()
    await recordGreenTestRun(command, ' 2 pass', dir, 'pre-push', cache, { context: CONTEXT })
    writeFileSync(join(dir, 'f.txt'), 'changed\n')
    expect((await computeGroupC(body, dir, {}, cache)).commands[0]?.receiptMissing).toBe(true)
  })
})
