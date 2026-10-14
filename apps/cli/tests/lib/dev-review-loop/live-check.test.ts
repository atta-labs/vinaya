/**
 * The live check: a task's `[live]` Test plan lines run by the review loop
 * itself, on its own host, after the round's gate is green and before
 * reviewers are dispatched. A failed line is a red gate; a host with no
 * subscription sign-in for a vendor the line names records it unverified,
 * which the merge gate holds like an unticked `[principal]` item; a plan with
 * no `[live]` line runs the round exactly as before.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { carryLiveRecord, evaluateTestPlanGate, readLiveRecord, withLiveRecord } from '@attalabs/aeg-core'
import { buildPrincipalTestPlanWaitErrors } from '../../../src/checks/bin/check-principal-test-plan-wait.js'
import type { LoopDeps } from '../../../src/lib/dev-review-loop.js'
import {
  type LiveRun,
  liveVendorsNamed,
  passCountOf,
  runLiveChecks,
  runRealLiveCommand,
  vendorSignedIn
} from '../../../src/lib/dev-review-loop/live-check.js'
import {
  cleanupWorlds,
  type LoopWorld,
  makeInProcessDeps,
  makeWorld,
  runLoopInProcess
} from '../dev-review-loop-harness.js'

afterEach(cleanupWorlds)

const LIVE = 'VINAYA_LIVE_CONFORMANCE=1 bun test apps/cli/tests/sandbox-conformance/claude-live.test.ts'

const BRIEF_BASE =
  '<!-- aeg:brief:v1 -->\nBrief hash: deadbeef\nDo the thing.\n\n## Objectives\n\nO1. Do the thing.\n\n## Planner rationale\n\nOut of scope for facts.\n'

/** A frozen brief whose §9 carries a command line and, when given, `[live]` items. */
function briefWith(live: string[]): string {
  return [
    BRIEF_BASE,
    '## 9. Test Plan',
    '',
    '```',
    'bun test apps/cli/tests/lib/dev-review-loop/live-check.test.ts → 0 fail',
    '```',
    ...(live.length > 0 ? ['', ...live.map((cmd) => `- **[live]** \`${cmd}\``)] : []),
    ''
  ].join('\n')
}

type RunCall = { command: string; cwd: string; timeoutMs: number }

/** Deps whose live runner answers from `answer` and records every call. */
function liveDeps(
  world: LoopWorld,
  answer: (call: RunCall, n: number) => LiveRun,
  opts: { signedIn?: (vendor: string) => boolean; onDeveloper?: (n: number) => void } = {}
): { deps: Partial<LoopDeps>; calls: RunCall[]; developerPrompts: string[] } {
  const base = makeInProcessDeps(world)
  const calls: RunCall[] = []
  const developerPrompts: string[] = []
  const deps: Partial<LoopDeps> = {
    dispatchRole: async (role, agent, prompt, dOpts) => {
      if (role === 'developer') {
        developerPrompts.push(prompt)
        opts.onDeveloper?.(developerPrompts.length)
      }
      return base.dispatchRole!(role, agent, prompt, dOpts)
    },
    runLiveCommand: async (command, cwd, timeoutMs) => {
      const call = { command, cwd, timeoutMs }
      calls.push(call)
      return answer(call, calls.length)
    },
    liveVendorSignedIn: opts.signedIn ?? (() => true),
    liveRunTimeoutMs: 1_000
  }
  return { deps, calls, developerPrompts }
}

function reviewerDispatches(world: LoopWorld): number {
  return world.dispatches.filter((d) => d.role === 'code-reviewer' || d.role === 'security').length
}

describe('the live check inside the round', () => {
  it('a failing `[live]` line sends the Developer back with its output tail and dispatches no reviewer for that head; the next head re-runs it', async () => {
    const world = makeWorld({ frozenBrief: briefWith([LIVE]) })
    const headA = world.head
    const headD = 'd'.repeat(40)
    let reviewersBeforeSecondDeveloper = -1
    const { deps, calls, developerPrompts } = liveDeps(
      world,
      (_call, n) =>
        n === 1
          ? { exitCode: 1, timedOut: false, output: '(fail) live > claude answers the prompt\n 0 pass\n 1 fail\n' }
          : { exitCode: 0, timedOut: false, output: ' 4 pass\n 0 fail\n' },
      {
        onDeveloper: (n) => {
          if (n === 2) {
            reviewersBeforeSecondDeveloper = reviewerDispatches(world)
            world.head = headD
            world.worktreeHead = headD
          }
        }
      }
    )

    const result = await runLoopInProcess(world, undefined, deps)

    // The failed run sent the Developer back before any reviewer started.
    expect(reviewersBeforeSecondDeveloper).toBe(0)
    const retry = developerPrompts[1] as string
    expect(retry).toContain("the review loop's live check is red")
    expect(retry).toContain(`[live] \`${LIVE}\` (exit \`1\`)`)
    expect(retry).toContain('(fail) live > claude answers the prompt')
    expect(retry).toMatch(/untrusted output/)
    // The run used the loop's own worktree path at the round's head, bounded.
    expect(calls.map((c) => c.command)).toEqual([LIVE, LIVE])
    expect(calls[0]?.cwd).toMatch(/\.worktrees\//)
    expect(calls[0]?.timeoutMs).toBe(1_000)
    // The failure was recorded at its head before the later head passed.
    const failedRecord = world.prBodyUpdates.find((b) => readLiveRecord(b).some((l) => l.outcome === 'failed'))
    expect(readLiveRecord(failedRecord as string)).toEqual([
      expect.objectContaining({ command: LIVE, outcome: 'failed', head: headA, ticked: false })
    ])
    // The later head re-ran it, it passed, and review proceeded to publish.
    expect(readLiveRecord(world.prBody)).toEqual([
      expect.objectContaining({ command: LIVE, outcome: 'passed', head: headD, ticked: true })
    ])
    expect(reviewerDispatches(world)).toBeGreaterThan(0)
    expect(result.finalDecision.type).toBe('publish')
  })

  it('a passing `[live]` line lets review proceed and is recorded with its head, command and pass count', async () => {
    const world = makeWorld({ frozenBrief: briefWith([LIVE]) })
    const { deps, calls } = liveDeps(world, () => ({ exitCode: 0, timedOut: false, output: ' 7 pass\n 0 fail\n' }))

    const result = await runLoopInProcess(world, undefined, deps)

    expect(calls).toHaveLength(1)
    expect(reviewerDispatches(world)).toBeGreaterThan(0)
    expect(result.finalDecision.type).toBe('publish')
    expect(world.prBody).toContain(`- [x] **[live]** \`${LIVE}\` — passed at \`${world.head}\`, \`7\` passing`)
    expect(buildPrincipalTestPlanWaitErrors(world.prBody, world.branch)).toEqual([])
    const withPlan = `## Test Plan\n\n\`\`\`\nx\n\`\`\`\n\n${world.prBody}`
    expect(evaluateTestPlanGate(withPlan, world.branch).verdict).toBe('pass')
  })

  it('a host without a signed-in vendor runs nothing, records the line unverified, lets review proceed and leaves the merge gate red', async () => {
    const world = makeWorld({ frozenBrief: briefWith([LIVE]) })
    const { deps, calls } = liveDeps(world, () => ({ exitCode: 0, timedOut: false, output: '' }), {
      signedIn: (vendor) => vendor !== 'claude'
    })

    const result = await runLoopInProcess(world, undefined, deps)

    expect(calls).toHaveLength(0)
    expect(reviewerDispatches(world)).toBeGreaterThan(0)
    expect(result.finalDecision.type).toBe('publish')
    expect(readLiveRecord(world.prBody)).toEqual([
      expect.objectContaining({ command: LIVE, outcome: 'unverified', head: world.head, ticked: false })
    ])
    expect(world.prBody).toContain("no claude subscription sign-in on the review loop's host")
    const waits = buildPrincipalTestPlanWaitErrors(world.prBody, world.branch)
    expect(waits).toHaveLength(1)
    expect(waits[0]?.pending).toBe(true)
    expect(waits[0]?.message).toContain(LIVE)
    // The Principal runs it and ticks the box: the merge gate clears.
    const ticked = world.prBody.replace('- [ ] **[live]**', '- [x] **[live]**')
    expect(buildPrincipalTestPlanWaitErrors(ticked, world.branch)).toEqual([])
  })

  it('a plan with no `[live]` line behaves exactly as today: nothing runs and the pull request carries no live record', async () => {
    const world = makeWorld({ frozenBrief: briefWith([]) })
    const { deps, calls } = liveDeps(world, () => ({ exitCode: 1, timedOut: false, output: '' }))

    const result = await runLoopInProcess(world, undefined, deps)

    expect(calls).toHaveLength(0)
    expect(result.finalDecision.type).toBe('publish')
    expect(world.prBodyUpdates.some((b) => b.includes('AEG:LIVE'))).toBe(false)
    expect(world.prBody).not.toContain('AEG:LIVE')
  })
})

describe('the live check’s parts', () => {
  it('names each vendor a line names, as a whole word', () => {
    expect(liveVendorsNamed(LIVE)).toEqual(['claude'])
    expect(liveVendorsNamed('CODEX=1 run claude and codex')).toEqual(['claude', 'codex'])
    expect(liveVendorsNamed('claudette codexes')).toEqual([])
  })

  it('reads a sign-in only from where the vendor keeps it — no vendor call', () => {
    const files: Record<string, string> = {
      '/h/.claude/.credentials.json': JSON.stringify({ claudeAiOauth: { accessToken: 'x' } }),
      '/h/.codex/auth.json': JSON.stringify({ tokens: { access_token: 'y' } })
    }
    const sources = {
      env: {},
      home: '/h',
      readFile: (path: string) => files[path] ?? null,
      readClaudeKeychain: () => null
    }
    expect(vendorSignedIn('claude', sources)).toBe(true)
    expect(vendorSignedIn('codex', sources)).toBe(true)
    expect(vendorSignedIn('gemini', sources)).toBe(false)
    const empty = { ...sources, readFile: () => null }
    expect(vendorSignedIn('claude', empty)).toBe(false)
    expect(vendorSignedIn('codex', empty)).toBe(false)
  })

  it('reads the pass count off a Bun or Vitest summary, or none', () => {
    expect(passCountOf(' 12 pass\n 0 fail\n')).toBe(12)
    expect(passCountOf('Tests  3 passed (3)')).toBe(3)
    expect(passCountOf('done')).toBeNull()
  })

  it('stops a run at its time bound and reads the timeout as a failure', async () => {
    const run = await runRealLiveCommand('echo started; sleep 5', process.cwd(), 200)
    expect(run.timedOut).toBe(true)
    expect(run.output).toContain('started')
    const result = await runLiveChecks({
      commands: ['sleep 5'],
      head: 'a'.repeat(40),
      cwd: process.cwd(),
      previous: [],
      cannotRun: null,
      signedIn: () => true,
      run: runRealLiveCommand,
      timeoutMs: 200
    })
    expect(result.failures).toHaveLength(1)
    expect(result.entries[0]).toMatchObject({ outcome: 'failed' })
  })

  it('keeps the driver’s record over an agent body write, and drops one the agent wrote itself', () => {
    const head = 'a'.repeat(40)
    const driver = withLiveRecord('## Test Plan\n\n```\nx\n```\n', [
      { command: LIVE, head, outcome: 'unverified', reason: 'no sign-in', ticked: false }
    ])
    const forged = withLiveRecord('## Test Plan\n\nedited\n', [
      { command: LIVE, head, outcome: 'passed', passCount: 1 }
    ])
    expect(readLiveRecord(carryLiveRecord(forged, driver))).toEqual([
      expect.objectContaining({ outcome: 'unverified', ticked: false })
    ])
    expect(carryLiveRecord(forged, null)).not.toContain('AEG:LIVE')
    expect(carryLiveRecord(forged, '## Test Plan\n\nno record\n')).not.toContain('AEG:LIVE')
  })

  it('keeps the Principal’s tick on an unverified line while its head and command are unchanged', async () => {
    const head = 'a'.repeat(40)
    const previous = readLiveRecord(
      withLiveRecord('', [{ command: LIVE, head, outcome: 'unverified', reason: 'no sign-in', ticked: true }])
    )
    const base = { commands: [LIVE], cwd: '.', previous, cannotRun: null, signedIn: () => false, timeoutMs: 1 }
    const run = async (): Promise<LiveRun> => ({ exitCode: 0, timedOut: false, output: '' })
    expect((await runLiveChecks({ ...base, head, run })).entries[0]).toMatchObject({ ticked: true })
    expect((await runLiveChecks({ ...base, head: 'b'.repeat(40), run })).entries[0]).toMatchObject({ ticked: false })
  })
})
