import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DEFAULT_REVIEW_POLICY, initialLoopState, objectivesVersion, type VerdictObservation } from '@attalabs/aeg-core'
import { createRunControl, type SpawnedProcessLike, type StepNodeResult } from '@atta/executor-agent-spawn'
import type { ActionRegistry } from '../../../harness/dev-process/engine-runtime/run-process'
import { loadProcess } from '../../../harness/dev-process/loader/load-process'
import { resolveRoleDoctrineText } from '../../../apps/cli/src/roles/plan'
import { cleanupAllReviewerIsolationArtifacts } from '../../../apps/cli/src/lib/dev-review-loop/reviewer-isolation'
import { ENGINE_SCENARIO_DRIVERS } from '../../../apps/cli/tests/conformance/dev-review-engine-loop-adapter'
import { runEngine, liveTaskInput, type Agent, type EngineRunOptions } from '../bin/run-engine'
import { createActions, type TaskInput } from '../executing/actions'
import { developerPrompt, type DeveloperPromptFacts } from '../executing/developer-prompt'
import { createVinayaLogProducers } from '../executing/log-events'
import { recordedHandoff } from './handoff-fakes'

const PROCESS = loadProcess(resolve(import.meta.dir, '..'))
const AGENTS: readonly Agent[] = ['claude', 'codex']

// --- the world ----------------------------------------------------------------

/** A git repository whose `origin/main` sits one commit behind HEAD, so a round's diff can be read. */
function worktree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'completion-wt-'))
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q')
  writeFileSync(join(dir, 'a.txt'), 'a\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  writeFileSync(join(dir, 'b.txt'), 'b\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'change')
  return dir
}

const approving: VerdictObservation[] = [
  { role: 'reviewer', verdict: 'APPROVE', objectives: [], findings: [] },
  { role: 'security', verdict: 'PASS', objectives: [], findings: [] }
]

/** Approving verdicts of which the code reviewer set one finding aside rather than let it block. */
const approvingWithDeferral: VerdictObservation[] = [
  {
    role: 'reviewer',
    verdict: 'APPROVE',
    objectives: [],
    findings: [
      {
        id: 'F1',
        severity: 'MINOR',
        state: 'open',
        description: 'rename the helper',
        location: 'b.txt:1',
        deferred: 'outside the task Surface'
      }
    ]
  } as unknown as VerdictObservation,
  approving[1] as VerdictObservation
]

const briefWith = (live: readonly string[]): string =>
  `# Frozen brief\n\n## 9. Test Plan\n\n\`\`\`\nbun test a.test.ts → 0 fail\n\`\`\`\n\n${live.map((line) => `- **[live]** ${line}`).join('\n')}\n`

interface Scenario {
  /** The `[live]` Test Plan lines of the frozen brief. */
  live?: readonly string[]
  /** The exit codes the live runs return in turn; the last repeats. */
  liveExits?: readonly number[]
  maxRounds?: number
  publishFails?: boolean
  verdicts?: VerdictObservation[]
  scanCommand?: readonly string[] | null
  /** Every vendor has a subscription sign-in on the host. */
  signedIn?: boolean
}

const mech = (exitCode: number, stdout = '') => ({ kind: 'mechanical', exitCode, stdout }) as unknown as StepNodeResult

/** A CLI-shaped child that exits cleanly after its stdin closes. */
function stubChild(agent: Agent): SpawnedProcessLike {
  const closeListeners: Array<(code: number | null) => void> = []
  let stdout: ((chunk: string) => void) | undefined
  const lines =
    agent === 'claude'
      ? ['{"type":"system","session_id":"s"}', '{"type":"result","session_id":"s"}']
      : ['{"type":"thread.started","thread_id":"s"}', '{"type":"turn.completed"}']
  return {
    stdin: {
      write: () => {},
      end: () => {
        setTimeout(() => {
          for (const line of lines) stdout?.(`${line}\n`)
          for (const listener of closeListeners) listener(0)
        }, 0)
      }
    },
    stdout: { on: (_event, listener) => (stdout = listener as (chunk: string) => void) },
    stderr: { on: () => {} },
    on: ((event: string, listener: (code: number | null) => void) => {
      if (event === 'close') closeListeners.push(listener)
    }) as SpawnedProcessLike['on'],
    kill: () => {
      for (const listener of closeListeners) listener(null)
    }
  } as SpawnedProcessLike
}

/** Everything one run of the Flow did that a test reads back. */
interface Observed {
  outcome: string
  /** `publish`, `dispose`, `live:<command>`, `scan` and the Log events, in the order they happened. */
  timeline: string[]
  journalResults: string[]
  spawns: string[]
  pauses: string[]
  prBody: string
  issues: Array<{ prNumber: number; entries: unknown[] }>
  publishedWith: unknown[]
  scans: Array<{ command: readonly string[]; cwd: string }>
  discarded: number[]
  results: Record<string, { exitCode: number; stdout: string }>
}

async function runFlow(agent: Agent, scenario: Scenario = {}): Promise<Observed> {
  const root = mkdtempSync(join(tmpdir(), 'completion-run-'))
  const runtimeDir = join(root, 'runtime')
  mkdirSync(runtimeDir)
  const savedHome = process.env.CODEX_HOME
  // A stub login keeps the Codex role launcher from copying an operator's credential.
  const stubHome = join(root, 'stub-home')
  mkdirSync(stubHome)
  writeFileSync(join(stubHome, 'auth.json'), '{}\n')
  process.env.CODEX_HOME = stubHome
  const wt = worktree()
  try {
    let round = 1
    const timeline: string[] = []
    const spawns: string[] = []
    const scans: Observed['scans'] = []
    const issues: Observed['issues'] = []
    const publishedWith: unknown[] = []
    const discarded: number[] = []
    const liveExits = [...(scenario.liveExits ?? [0])]
    let prBody = 'Closes #9'
    const verdicts = scenario.verdicts ?? approving
    const task = {
      runtimeDir,
      cliEntry: '',
      branch: 'task/issue-9',
      issueNumber: 9,
      worktreePath: wt,
      repoRoot: wt,
      developerContext: { knownFindingIds: [], requiredSources: [] },
      loopState: initialLoopState({
        loopId: 'completion',
        task: 9,
        reviewers: ['reviewer', 'security'],
        models: {},
        maxRounds: scenario.maxRounds ?? 5,
        maxTaskMinutes: 0
      }),
      reviewRound: () => round,
      seedRound: (next: number) => {
        round = Math.max(round, next)
      },
      observe: () => ({ kind: 'verdicts', round, verdicts }),
      verdicts: () => {
        round += 1
        return verdicts
      },
      publish: (at: Record<string, unknown>) => ({ task: 9, ...at }),
      renderVerdict: () => 'rendered verdict',
      frozenBrief: () => briefWith(scenario.live ?? []),
      candidateDir: () => wt,
      inputVersions: () => ({ briefHash: null, objectivesVersion: null, rulingOrdinal: 0, policyDigest: 'test' }),
      bound: {
        findOpenPrForBranch: () => ({ number: 70, branch: 'task/issue-9' }),
        fetchPrBody: () => prBody,
        updatePrBody: async (input: { body: string }) => {
          prBody = input.body
        },
        publishRound: (_root: string, input: unknown) => {
          timeline.push('publish')
          publishedWith.push(input)
          if (scenario.publishFails) throw new Error('the publication broke')
        },
        resolveSecurityScanCommand: () => scenario.scanCommand ?? null,
        changedPaths: () => ['.claude/settings.json'],
        runSecurityScan: (command: readonly string[], cwd: string) => {
          timeline.push('scan')
          scans.push({ command, cwd })
          return { ok: true as const, output: 'scanner findings' }
        },
        liveVendorSignedIn: () => scenario.signedIn ?? true,
        runLiveCommand: async (command: string) => {
          timeline.push(`live:${command}`)
          const exitCode = liveExits.length > 1 ? (liveExits.shift() as number) : (liveExits[0] ?? 0)
          return { exitCode, timedOut: false, output: exitCode === 0 ? '1 pass' : 'live case failed' }
        },
        liveRunTimeoutMs: 1000,
        prepareLiveCheckout: async () => ({ cwd: wt, dispose: () => void timeline.push('dispose') }),
        discardHeldVerdicts: (_root: string, _task: number, discardedRound: number) =>
          void discarded.push(discardedRound),
        writeDeferredFindingsIssue: (input: { prNumber: number; entries: unknown[] }) => {
          issues.push(input)
          return { issue: 55 }
        }
      }
    } as unknown as TaskInput
    const real = createActions(task)
    const results: Observed['results'] = {}
    const completionSteps = new Set([
      'vinaya.classify-gate-result',
      'vinaya.run-security-scan',
      'vinaya.dispatch-reviewers',
      'vinaya.assess-round',
      'vinaya.build-revision-handoff',
      'vinaya.run-live-checks',
      'vinaya.classify-live-result',
      'harness.publish'
    ])
    const actions: ActionRegistry = Object.fromEntries(
      [
        'vinaya.prepare-run',
        'vinaya.reconcile-external-state',
        'vinaya.prepare-sources',
        'vinaya.choose-start',
        'vinaya.validate-developer-output',
        'harness.run-gates',
        'vinaya.validate-reviewer-outputs',
        ...completionSteps
      ].map((name) => [
        name,
        async (context) => {
          const action = completionSteps.has(name) ? real[name]! : async () => ({ exitCode: 0, stdout: '' })
          const result = await action(context)
          results[context.nodeId] = { exitCode: result.exitCode, stdout: result.stdout ?? '' }
          return result
        }
      ])
    )
    const handoff = recordedHandoff()
    const events: Array<{ kind: string; event: string; [field: string]: unknown }> = []
    const options: EngineRunOptions = {
      args: { task: 9, agent, dryRun: false },
      process: PROCESS,
      repoRoot: wt,
      runtimeDir,
      loopId: 'completion',
      taskInput: task,
      handoffDeps: handoff.deps,
      actions,
      sink: {
        log: (event: unknown) => {
          const logged = event as (typeof events)[number]
          events.push(logged)
          timeline.push(`${logged.kind}:${logged.event}${logged.result ? `:${logged.result}` : ''}`)
        },
        drain: async () => {}
      },
      startHost: async () => ({ close: async () => {} }),
      devToolsContext: {} as never,
      control: createRunControl(),
      out: () => {},
      spawnFn: (_command, args, spawnOptions) => {
        const dir =
          agent === 'claude'
            ? dirname(args[args.indexOf('--settings') + 1] ?? '')
            : (spawnOptions?.env?.CODEX_HOME ?? '')
        spawns.push(basename(dir))
        timeline.push(`spawn:${basename(dir)}`)
        return stubChild(agent)
      }
    }
    const result = await runEngine(options)
    return {
      outcome: (JSON.parse(readFileSync(result.tracePath, 'utf8')) as { outcome: string }).outcome,
      timeline,
      journalResults: events.filter((e) => e.event === 'journal_finalized').map((e) => String(e.result)),
      spawns,
      pauses: handoff.calls.filter((call) => call.startsWith('escalation:')),
      prBody,
      issues,
      publishedWith,
      scans,
      discarded,
      results
    }
  } finally {
    if (savedHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = savedHome
    rmSync(root, { recursive: true, force: true })
    rmSync(wt, { recursive: true, force: true })
  }
}

const developerSpawns = (observed: Observed) => observed.spawns.filter((role) => role === 'developer').length

// --- O1: the live check -------------------------------------------------------

describe.each(AGENTS)('the live-check step (%s)', (agent) => {
  test('a plan with no [live] line runs nothing and publishes', async () => {
    const observed = await runFlow(agent)
    expect(observed.outcome).toBe('completed')
    expect(observed.timeline.filter((entry) => entry.startsWith('live:'))).toEqual([])
    expect(observed.timeline).toContain('publish')
  })

  test('a passing line runs after both reviewers approve, before publish, and is recorded on the pull request', async () => {
    const observed = await runFlow(agent, { live: ['bun test live.test.ts'] })
    expect(observed.outcome).toBe('completed')
    const order = observed.timeline.filter((entry) => entry === 'live:bun test live.test.ts' || entry === 'publish')
    expect(order).toEqual(['live:bun test live.test.ts', 'publish'])
    const liveAt = observed.timeline.indexOf('live:bun test live.test.ts')
    expect(observed.timeline.indexOf('spawn:code-reviewer')).toBeLessThan(liveAt)
    expect(observed.timeline.indexOf('spawn:security-reviewer')).toBeLessThan(liveAt)
    expect(observed.prBody).toContain('bun test live.test.ts')
    expect(developerSpawns(observed)).toBe(1)
  })

  test('a failing line withdraws the approval and goes back to the Developer; the next head passes and publishes once', async () => {
    const observed = await runFlow(agent, { live: ['bun test live.test.ts'], liveExits: [1, 0] })
    expect(observed.outcome).toBe('completed')
    expect(developerSpawns(observed)).toBe(2)
    expect(observed.discarded).toEqual([1])
    expect(observed.timeline.filter((entry) => entry === 'publish')).toHaveLength(1)
    // The withdrawn round ends changes_requested with no green stop, and the journal closes once, merged_ready.
    const rounds = observed.timeline.filter((entry) => entry.startsWith('dev_review_loop:round_ended'))
    expect(rounds).toHaveLength(2)
    expect(observed.journalResults).toEqual(['merged_ready'])
  })

  test('a failing line at the round cap pauses through the handoff, closing the journal stopped', async () => {
    const observed = await runFlow(agent, { live: ['bun test live.test.ts'], liveExits: [1], maxRounds: 1 })
    expect(observed.outcome).toBe('paused')
    expect(observed.pauses).toEqual(['escalation:max_rounds'])
    expect(observed.timeline).not.toContain('publish')
    expect(observed.journalResults).toEqual(['stopped'])
    expect(developerSpawns(observed)).toBe(1)
  })

  test('a line the host cannot run is recorded unverified, not failed, and does not hold the round', async () => {
    const observed = await runFlow(agent, { live: ['bun test claude-live.test.ts'], signedIn: false })
    expect(observed.outcome).toBe('completed')
    expect(observed.timeline.filter((entry) => entry.startsWith('live:'))).toEqual([])
    expect(observed.prBody).toContain('unverified')
    expect(observed.timeline).toContain('publish')
  })
})

test('the Developer is told which live line failed and shown its output tail', () => {
  const facts = {
    brief: 'brief',
    objectives: { objectives: [], version: 'v' },
    rulings: [],
    rulingOrdinal: 0,
    policy: DEFAULT_REVIEW_POLICY,
    baseSha: 'b'.repeat(40),
    headSha: 'h'.repeat(40),
    sources: { block: null, evidence: [] },
    round: 2,
    doctrine: null,
    issueRulings: [],
    keptWork: null,
    resume: { task: 9, branch: 'task/issue-9', worktree: '/wt', remoteHead: null },
    heldReview: null
  } as unknown as DeveloperPromptFacts
  const failed = (head: string) => ({
    develop: mech(0),
    'run-mechanical-gates': mech(0),
    'run-live-checks': mech(
      1,
      JSON.stringify({ head, withdrawal: 'the live check failed: `bun test live.test.ts` (exit `1`)' })
    )
  })
  expect(developerPrompt('', facts, failed('h'.repeat(40)))).toContain('`bun test live.test.ts` (exit `1`)')
  // A live failure recorded for an earlier head is not this turn's reason.
  expect(developerPrompt('', facts, failed('o'.repeat(40)))).not.toContain('the live check failed')
})

// --- O2: the journal closes from the publish step -----------------------------

describe.each(AGENTS)('the journal (%s)', (agent) => {
  test('merged_ready follows a successful publish, and exactly once', async () => {
    const observed = await runFlow(agent)
    expect(observed.journalResults).toEqual(['merged_ready'])
    expect(observed.timeline.indexOf('publish')).toBeLessThan(
      observed.timeline.indexOf('dev_review_loop:journal_finalized:merged_ready')
    )
  })

  test('a publish that fails writes no merged_ready; its leg ends stopped', async () => {
    const observed = await runFlow(agent, { publishFails: true })
    expect(observed.outcome).not.toBe('completed')
    expect(observed.journalResults).toEqual(['stopped'])
    expect(observed.timeline).not.toContain('dev_review_loop:journal_finalized:merged_ready')
  })

  test('after the pause, a later successful publish writes the one merged_ready', async () => {
    const replayed = await ENGINE_SCENARIO_DRIVERS['publication-replay']!(agent)
    expect(replayed.journalResults).toEqual(['stopped', 'merged_ready'])
    expect(replayed.effects.developerDispatches).toBe(1)
    const crashed = await ENGINE_SCENARIO_DRIVERS['uncertain-effect-crash']!(agent)
    expect(crashed.journalResults).toEqual(['stopped'])
  })
})

describe('the journal producers', () => {
  const close = { kind: 'dev_review_loop', event: 'journal_finalized', result: 'merged_ready' }
  const gate = { kind: 'dev_review_loop', event: 'gate_result_read', head: 'h1' }
  const assessed = (decision: unknown) => ({
    exitCode: 0,
    stdout: JSON.stringify({ decision, events: [gate, close], state: {} })
  })

  test('the assessment alone never emits the close, whatever the decision', () => {
    const producers = createVinayaLogProducers({ loopId: 'l', task: 9 })
    const context = (steps: Record<string, { exitCode: number; stdout: string }>) =>
      ({ nodeId: 'assess-round', runId: 'r', attempt: 1, steps }) as never
    const published = producers.nodeCompleted!(context({ 'assess-round': assessed({ type: 'publish' }) }))
    expect((published as unknown as Array<{ event: string }>).map((e) => e.event)).toEqual([])
  })
})

// --- O3: the security scan ----------------------------------------------------

describe.each(AGENTS)('the security scan (%s)', (agent) => {
  test('with a configured command it runs once, before either reviewer, over the candidate copy', async () => {
    const observed = await runFlow(agent, { scanCommand: ['npx', '--yes', 'scanner@1.0.0', 'scan'] })
    expect(observed.scans).toHaveLength(1)
    expect(observed.scans[0]?.command).toEqual(['npx', '--yes', 'scanner@1.0.0', 'scan'])
    expect(JSON.parse(observed.results['run-security-scan']?.stdout ?? '{}')).toEqual({
      kind: 'ran',
      output: 'scanner findings'
    })
    expect(observed.spawns.indexOf('code-reviewer')).toBeGreaterThan(-1)
    expect(observed.timeline.indexOf('scan')).toBeGreaterThan(-1)
  })

  test('with no command configured nothing runs', async () => {
    const observed = await runFlow(agent, { scanCommand: null })
    expect(observed.scans).toEqual([])
    expect(JSON.parse(observed.results['run-security-scan']?.stdout ?? '{}')).toEqual({ kind: 'not_configured' })
  })
})

// --- O4: the deferred-findings Issue ------------------------------------------

describe.each(AGENTS)('the deferred-findings Issue (%s)', (agent) => {
  test('a round that set a finding aside has the publish step open the one Issue and link it', async () => {
    const observed = await runFlow(agent, { verdicts: approvingWithDeferral })
    expect(observed.outcome).toBe('completed')
    expect(observed.issues).toHaveLength(1)
    expect(observed.issues[0]?.prNumber).toBe(70)
    expect(observed.issues[0]?.entries).toEqual([
      {
        round: 1,
        reviewer: 'reviewer',
        severity: 'MINOR',
        location: 'b.txt:1',
        reason: 'outside the task Surface',
        description: 'rename the helper'
      }
    ])
    expect((observed.publishedWith[0] as { deferredIssue?: unknown }).deferredIssue).toEqual({ issue: 55 })
  })

  test('a round that set nothing aside opens nothing', async () => {
    const observed = await runFlow(agent)
    expect(observed.issues).toEqual([])
    expect(observed.publishedWith[0]).not.toHaveProperty('deferredIssue')
  })
})

// --- O7: the role doctrine and the scan in the reviewer prompts ---------------

describe.each(AGENTS)('the reviewer prompts (%s)', (agent) => {
  async function prompts(resolveReviewerDoctrine?: (role: 'reviewer' | 'security') => Promise<string | null>) {
    const repo = mkdtempSync(join(tmpdir(), 'completion-prompt-'))
    const runtimeDir = join(repo, 'runtime')
    mkdirSync(runtimeDir)
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
        cwd: repo,
        encoding: 'utf8'
      }).trim()
    git('init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'sample.ts'), 'export const value = 1\n')
    git('add', 'sample.ts')
    git('commit', '-q', '-m', 'base')
    git('update-ref', 'refs/remotes/origin/main', 'HEAD')
    const worktreePath = join(repo, '.worktrees', 'task/issue-7')
    git('worktree', 'add', '-q', '-b', 'task/issue-7', worktreePath)
    const objectives = [{ id: 'O1', text: 'Do the thing.' }]
    try {
      const input = await liveTaskInput({ task: 7, agent, dryRun: false }, repo, runtimeDir, 'completion', {
        fetchLabels: () => [],
        fetchTitle: () => 'A test task',
        policy: () => DEFAULT_REVIEW_POLICY,
        ...(resolveReviewerDoctrine ? { resolveReviewerDoctrine } : {}),
        forge: {
          findOpenPrForBranch: () => ({ number: 70, branch: 'task/issue-7' }),
          fetchFrozenBrief: () => '# Frozen brief\n',
          resolveIssueObjectives: () => ({
            objectives,
            text: 'O1. Do the thing.',
            version: objectivesVersion(objectives),
            edit: null
          }),
          fetchNewestRulingOrdinal: () => 0,
          fetchSourceRevision: () => 'abc',
          fetchCiConclusion: () => 'green',
          fetchIssueRulingsAfterBrief: () => [],
          fetchRulings: () => [],
          prBody: () => 'Closes #7'
        }
      })
      const results = { 'run-security-scan': mech(0, JSON.stringify({ kind: 'ran', output: 'SCAN-OUTPUT-MARK' })) }
      return {
        reviewer: await input.reviewerPrompt!('reviewer', results),
        security: await input.reviewerPrompt!('security', results)
      }
    } finally {
      cleanupAllReviewerIsolationArtifacts(runtimeDir, 7)
      rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  }

  test('each prompt carries its role doctrine and only the security prompt carries the scan', async () => {
    const { reviewer, security } = await prompts(async (role) => `DOCTRINE-FOR-${role.toUpperCase()}`)
    expect(reviewer).toContain('DOCTRINE-FOR-REVIEWER')
    expect(security).toContain('DOCTRINE-FOR-SECURITY')
    expect(security).toContain('SCAN-OUTPUT-MARK')
    expect(reviewer).not.toContain('SCAN-OUTPUT-MARK')
    expect(reviewer).not.toContain('AGENT-CONFIG SCAN')
  })

  test('by default the doctrine is the one the standalone loop injects', async () => {
    const { reviewer, security } = await prompts()
    const [forReviewer, forSecurity] = [
      await resolveRoleDoctrineText('reviewer'),
      await resolveRoleDoctrineText('security')
    ]
    expect(forReviewer).not.toBeNull()
    expect(forSecurity).not.toBeNull()
    expect(reviewer).toContain(forReviewer as string)
    expect(security).toContain(forSecurity as string)
  })
})
