/**
 * The live check: a task's `[live]` Test plan lines run by the review loop
 * itself, on its own host, only on a head both reviewers approved and before
 * the task concludes. A failed line sends the Developer back as a new round,
 * whose head is reviewed again before its lines run; a host with no
 * subscription sign-in for a vendor the line names records it unverified,
 * which the merge gate holds like an unticked `[principal]` item; a plan with
 * no `[live]` line runs the round exactly as before.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import {
  type DevReviewLoopEventInput,
  type LoopState,
  carryLiveRecord,
  evaluateTestPlanGate,
  readLiveRecord,
  withLiveRecord
} from '@attalabs/aeg-core'
import { buildPrincipalTestPlanWaitErrors } from '../../../src/checks/bin/check-principal-test-plan-wait.js'
import type { LoopDeps } from '../../../src/lib/dev-review-loop.js'
import {
  type LiveRun,
  livePassedAtHead,
  liveRunEnv,
  liveVendorsNamed,
  passCountOf,
  prepareRealLiveCheckout,
  runLiveChecks,
  withdrawApprovedRound,
  runRealLiveCommand,
  vendorSignedIn
} from '../../../src/lib/dev-review-loop/live-check.js'
import {
  CLEAN_REVIEWER,
  cleanupWorlds,
  type LoopWorld,
  makeInProcessDeps,
  makeWorld,
  outboxLines,
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

/** One live run, with the head the branch stood at and how many reviewer dispatches had already run when it started. */
type RunCall = { command: string; cwd: string; timeoutMs: number; head: string; reviewersBefore: number }

/** Deps whose live runner answers from `answer` and records every call. */
function liveDeps(
  world: LoopWorld,
  answer: (call: RunCall, n: number) => LiveRun,
  opts: { signedIn?: (vendor: string) => boolean; onDeveloper?: (n: number) => void } = {}
): {
  deps: Partial<LoopDeps>
  calls: RunCall[]
  developerPrompts: string[]
  checkouts: { head: string; disposed: boolean }[]
} {
  const base = makeInProcessDeps(world)
  const calls: RunCall[] = []
  const checkouts: { head: string; disposed: boolean }[] = []
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
      const call = { command, cwd, timeoutMs, head: world.head, reviewersBefore: reviewerDispatches(world) }
      calls.push(call)
      return answer(call, calls.length)
    },
    liveVendorSignedIn: opts.signedIn ?? (() => true),
    liveRunTimeoutMs: 1_000,
    prepareLiveCheckout: async (_root, head) => {
      const checkout = { head, disposed: false }
      checkouts.push(checkout)
      return {
        cwd: `/live-checkout/${head}`,
        dispose: () => {
          checkout.disposed = true
        }
      }
    }
  }
  return { deps, calls, developerPrompts, checkouts }
}

function reviewerDispatches(world: LoopWorld): number {
  return world.dispatches.filter((d) => d.role === 'code-reviewer' || d.role === 'security').length
}

describe('the live check inside the round', () => {
  it('runs no `[live]` line on a head before both reviewers approve it', async () => {
    const headB = 'b'.repeat(40)
    const world = makeWorld({
      frozenBrief: briefWith([LIVE]),
      roleOutcomes: { 1: { reviewer: { ...CLEAN_REVIEWER, findings: 'BLOCKER|apps/cli/src/a.ts:5|a defect\n' } } }
    })
    const headA = world.head
    const { deps, calls } = liveDeps(world, () => ({ exitCode: 0, timedOut: false, output: ' 2 pass\n 0 fail\n' }), {
      onDeveloper: (n) => {
        if (n === 2) {
          world.head = headB
          world.worktreeHead = headB
        }
      }
    })

    const result = await runLoopInProcess(world, undefined, deps)

    // Round 1's head was reviewed and not approved: its line never ran.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.head).toBe(headB)
    expect(calls.some((c) => c.head === headA)).toBe(false)
    // Both rounds' reviewers had run before the one run started, and none after it.
    expect(calls[0]?.reviewersBefore).toBe(reviewerDispatches(world))
    expect(calls[0]?.reviewersBefore).toBeGreaterThanOrEqual(4)
    expect(world.prBodyUpdates.some((b) => readLiveRecord(b).some((l) => l.head === headA))).toBe(false)
    expect(result.finalDecision.type).toBe('publish')
  })

  it('a failing `[live]` line on an approved head sends the Developer back as a new round, and the next head is reviewed before its lines run', async () => {
    const world = makeWorld({ frozenBrief: briefWith([LIVE]) })
    const headA = world.head
    const headD = 'd'.repeat(40)
    const { deps, calls, developerPrompts, checkouts } = liveDeps(
      world,
      (_call, n) =>
        n === 1
          ? { exitCode: 1, timedOut: false, output: '(fail) live > claude answers the prompt\n 0 pass\n 1 fail\n' }
          : { exitCode: 0, timedOut: false, output: ' 4 pass\n 0 fail\n' },
      {
        onDeveloper: (n) => {
          if (n === 2) {
            world.head = headD
            world.worktreeHead = headD
          }
        }
      }
    )

    const result = await runLoopInProcess(world, undefined, deps)

    // Head A ran only after both reviewers approved it; head D only after
    // its own round's two reviewers approved it.
    expect(calls.map((c) => [c.command, c.head, c.reviewersBefore])).toEqual([
      [LIVE, headA, 2],
      [LIVE, headD, 4]
    ])
    // Each ran in a fresh checkout of its approved head, never the
    // Developer's worktree, and each checkout was removed after its run.
    expect(calls.map((c) => c.cwd)).toEqual([`/live-checkout/${headA}`, `/live-checkout/${headD}`])
    expect(checkouts).toEqual([
      { head: headA, disposed: true },
      { head: headD, disposed: true }
    ])
    expect(calls[0]?.timeoutMs).toBe(1_000)
    // The log records round 1 as changes requested, never green: the
    // approval was withdrawn, so its green stop is not logged.
    const loop = outboxLines(world) as Array<{ event?: string; round?: number; condition?: string; outcome?: string }>
    expect(loop.filter((l) => l.event === 'stop_condition_met').map((l) => [l.round, l.condition])).toEqual([
      [2, 'green']
    ])
    expect(loop.filter((l) => l.event === 'round_ended').map((l) => [l.round, l.outcome])).toEqual([
      [1, 'changes_requested'],
      [2, 'green']
    ])
    expect(loop.filter((l) => l.event === 'journal_finalized')).toHaveLength(1)
    // The failure came back as a new round, with the line's output tail.
    expect(world.dispatches.filter((d) => d.role === 'developer').map((d) => d.round)).toEqual([1, 2])
    const retry = developerPrompts[1] as string
    expect(retry).toContain(`Both reviewers approved head ${headA}, but the review loop's live check failed on it`)
    expect(retry).toContain(`\`${LIVE}\` (exit \`1\`)`)
    expect(retry).toContain('(fail) live > claude answers the prompt')
    expect(retry).toMatch(/untrusted output/)
    // The approval of head A was withdrawn: nothing was published for it.
    expect(world.publishedRounds).toEqual([2])
    // The failure was recorded at its head before the later head passed.
    const failedRecord = world.prBodyUpdates.find((b) => readLiveRecord(b).some((l) => l.outcome === 'failed'))
    expect(readLiveRecord(failedRecord as string)).toEqual([
      expect.objectContaining({ command: LIVE, outcome: 'failed', head: headA, ticked: false })
    ])
    expect(readLiveRecord(world.prBody)).toEqual([
      expect.objectContaining({ command: LIVE, outcome: 'passed', head: headD, ticked: true })
    ])
    expect(result.finalDecision.type).toBe('publish')
  })

  it('a passing `[live]` line lets the task conclude and is recorded with its head, command and pass count', async () => {
    const world = makeWorld({ frozenBrief: briefWith([LIVE]) })
    const { deps, calls } = liveDeps(world, () => ({ exitCode: 0, timedOut: false, output: ' 7 pass\n 0 fail\n' }))

    const result = await runLoopInProcess(world, undefined, deps)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.reviewersBefore).toBe(2)
    expect(result.finalDecision.type).toBe('publish')
    expect(world.prBody).toContain(`- [x] **[live]** \`${LIVE}\` — passed at \`${world.head}\`, \`7\` passing`)
    expect(buildPrincipalTestPlanWaitErrors(world.prBody, world.branch)).toEqual([])
    const withPlan = `## Test Plan\n\n\`\`\`\nx\n\`\`\`\n\n${world.prBody}`
    expect(evaluateTestPlanGate(withPlan, world.branch).verdict).toBe('pass')
  })

  it('a host without a signed-in vendor runs nothing, records the line unverified, lets the task conclude and leaves the merge gate red', async () => {
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
  it('withdraws an approved round in the log: never green, finalised only at the round cap', () => {
    const env = { kind: 'dev_review_loop' as const, payload: {}, loop_id: 'L' }
    const events = [
      { ...env, event: 'verdicts_read', round: 3 },
      { ...env, event: 'stop_condition_met', round: 3, condition: 'green' },
      { ...env, event: 'round_ended', round: 3, head: 'h', outcome: 'green' },
      { ...env, event: 'journal_finalized', rounds: 3, time_to_green_ms: 9, result: 'merged_ready' }
    ] as unknown as DevReviewLoopEventInput[]
    const state = { rounds: [{ round: 3, outcome: 'green' }] } as unknown as LoopState
    const below = withdrawApprovedRound(events, state, false)
    expect(below.events.map((e) => [(e as { event: string }).event, (e as { outcome?: string }).outcome])).toEqual([
      ['verdicts_read', undefined],
      ['round_ended', 'changes_requested']
    ])
    expect(below.state.rounds.at(-1)?.outcome).toBe('changes_requested')
    const cap = withdrawApprovedRound(events, state, true)
    expect(cap.events.map((e) => (e as { event: string }).event)).toEqual([
      'verdicts_read',
      'stop_condition_met',
      'paused',
      'round_ended',
      'journal_finalized'
    ])
    expect(cap.events[1] as unknown).toEqual({ ...env, event: 'stop_condition_met', round: 3, condition: 'max_rounds' })
    expect(cap.events[4]).toMatchObject({ result: 'stopped', time_to_green_ms: null })
    expect(cap.state.rounds.at(-1)?.outcome).toBe('stopped')
  })

  it('names each vendor a line names, as a whole word', () => {
    expect(liveVendorsNamed(LIVE)).toEqual(['claude'])
    expect(liveVendorsNamed('CODEX=1 run claude and codex')).toEqual(['claude', 'codex'])
    expect(liveVendorsNamed('claudette codexes')).toEqual([])
  })

  it('asks only whether a login exists where the vendor keeps it — never reads it, never calls a vendor', () => {
    const files = new Set(['/h/.claude/.credentials.json', '/h/.codex/auth.json'])
    const sources = {
      env: {},
      home: '/h',
      fileExists: (path: string) => files.has(path),
      keychainHas: () => false
    }
    expect(vendorSignedIn('claude', sources)).toBe(true)
    expect(vendorSignedIn('codex', sources)).toBe(true)
    expect(vendorSignedIn('gemini', sources)).toBe(false)
    const empty = { ...sources, fileExists: () => false }
    expect(vendorSignedIn('claude', empty)).toBe(false)
    expect(vendorSignedIn('codex', empty)).toBe(false)
    // A Keychain entry counts; its service names the vendor's own login.
    const services: string[] = []
    const keychain = {
      ...empty,
      keychainHas: (service: string) => {
        services.push(service)
        return true
      }
    }
    expect(vendorSignedIn('claude', keychain)).toBe(true)
    expect(vendorSignedIn('codex', keychain)).toBe(true)
    expect(services).toEqual(['Claude Code-credentials', 'Codex Auth'])
    // A config-directory override moves where it looks, as it moves the run.
    const moved = {
      ...empty,
      env: { CODEX_HOME: '/x', CLAUDE_CONFIG_DIR: '/c' },
      fileExists: (p: string) => p === '/x/auth.json' || p === '/c/.credentials.json'
    }
    expect(vendorSignedIn('codex', moved)).toBe(true)
    expect(vendorSignedIn('claude', moved)).toBe(true)
  })

  it('never counts a Codex token held only in the driver’s environment, which a run is not handed', () => {
    const sources = {
      env: { CODEX_ACCESS_TOKEN: 'tok' },
      home: '/h',
      fileExists: () => false,
      keychainHas: () => false
    }
    expect(vendorSignedIn('codex', sources)).toBe(false)
    expect(liveRunEnv({ PATH: '/bin', CODEX_ACCESS_TOKEN: 'tok' })).toEqual({ PATH: '/bin' })
  })

  it('prepares a fresh checkout of the head that carries none of the Developer’s ignored files, and removes it', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'live-checkout-test-'))
    try {
      const git = (...args: string[]): string =>
        execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
          encoding: 'utf8'
        }).trim()
      git('init', '-q')
      writeFileSync(join(repo, '.gitignore'), 'node_modules/\n')
      writeFileSync(join(repo, 'tracked.txt'), 'reviewed\n')
      git('add', '.')
      git('commit', '-q', '-m', 'head')
      const head = git('rev-parse', 'HEAD')
      // What a Developer's sandbox could leave behind in its own worktree.
      execFileSync('mkdir', ['-p', join(repo, 'node_modules')])
      writeFileSync(join(repo, 'node_modules', 'planted.js'), 'steal()\n')
      writeFileSync(join(repo, 'untracked.txt'), 'x\n')

      const checkout = await prepareRealLiveCheckout(repo, head, { install: ['true'] })
      if (!('cwd' in checkout)) throw new Error(`no checkout: ${checkout.error}`)
      expect(checkout.cwd.startsWith(repo)).toBe(false)
      expect(existsSync(join(checkout.cwd, 'tracked.txt'))).toBe(true)
      expect(existsSync(join(checkout.cwd, 'node_modules', 'planted.js'))).toBe(false)
      expect(existsSync(join(checkout.cwd, 'untracked.txt'))).toBe(false)
      checkout.dispose()
      expect(existsSync(checkout.cwd)).toBe(false)
      expect(git('worktree', 'list').split('\n')).toHaveLength(1)

      const failed = await prepareRealLiveCheckout(repo, 'f'.repeat(40), { install: ['true'] })
      expect('error' in failed).toBe(true)
      expect(git('worktree', 'list').split('\n')).toHaveLength(1)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
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

  it('drops every forged record an agent wrote, however many pairs, and a lone marker never pairs with the driver’s', () => {
    const head = 'a'.repeat(40)
    const forgedBlock = withLiveRecord('', [{ command: LIVE, head, outcome: 'passed', passCount: 9 }]).trim()
    const twice = `## Test Plan\n\nx\n\n${forgedBlock}\n\n${forgedBlock}\n`
    expect(carryLiveRecord(twice, null)).not.toContain('AEG:LIVE')
    expect(readLiveRecord(carryLiveRecord(twice, null))).toEqual([])
    const driver = withLiveRecord('## Test Plan\n\nx\n', [
      { command: LIVE, head, outcome: 'failed', detail: 'exit `1`' }
    ])
    const carried = carryLiveRecord(`${twice}\n<!-- AEG:LIVE:START -->\n- [x] **[live]** forged\n`, driver)
    expect(readLiveRecord(carried)).toEqual([expect.objectContaining({ outcome: 'failed', ticked: false })])
  })

  it('reads a body with more than one record pair as one unticked line, so the gate holds and no run is skipped', () => {
    const head = 'a'.repeat(40)
    const block = withLiveRecord('', [{ command: LIVE, head, outcome: 'passed', passCount: 1 }]).trim()
    const body = `## Test Plan\n\n\`\`\`\nx\n\`\`\`\n\n${block}\n\n${block}\n`
    const lines = readLiveRecord(body)
    expect(lines).toHaveLength(1)
    expect(lines[0]?.ticked).toBe(false)
    expect(livePassedAtHead([LIVE], head, lines)).toBe(false)
    expect(evaluateTestPlanGate(body, 'task/issue-1').verdict).toBe('fail')
  })

  it('hands a run only the check baseline and the sign-in lookup keys — never a forge token', async () => {
    const env = liveRunEnv({
      PATH: '/bin',
      HOME: '/h',
      USER: 'u',
      CLAUDE_CONFIG_DIR: '/c',
      CODEX_HOME: '/x',
      GH_TOKEN: 'ghp_secret',
      GITHUB_TOKEN: 'ghs_secret',
      VINAYA_LOG_TOKEN: 'secret'
    })
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', USER: 'u', CLAUDE_CONFIG_DIR: '/c', CODEX_HOME: '/x' })
    const saved = process.env.GH_TOKEN
    process.env.GH_TOKEN = 'ghp_secret'
    let run: LiveRun
    try {
      run = await runRealLiveCommand('echo "token=${GH_TOKEN:-none}"', process.cwd(), 5_000)
    } finally {
      if (saved === undefined) delete process.env.GH_TOKEN
      else process.env.GH_TOKEN = saved
    }
    expect(run.output).toContain('token=none')
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
