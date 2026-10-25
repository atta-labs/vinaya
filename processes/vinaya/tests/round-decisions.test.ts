import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { compileFlow, type StepsFlow } from '@atta/engine'
import { parse } from 'yaml'
import { DEFAULT_REVIEW_POLICY, objectivesVersion, readManifest, type ReviewPolicy } from '@attalabs/aeg-core'
import type { SpawnedProcessLike } from '@atta/executor-agent-spawn'
import { loadProcess } from '../../../harness/dev-process/loader/load-process'
import { keepLogLocal, QUIET_FORGE_GATES, SCENARIO_ENV_KEYS, useRuntimeDir } from './round-fakes'
import type { ActionRegistry } from '../../../harness/dev-process/engine-runtime/run-process'
import {
  clearDriverLock,
  pauseMarker,
  readPauseState,
  writePauseState
} from '../../../apps/cli/src/lib/dev-review-loop/pause-resume'
import { controlStoreRootFor, heldVerdictPath } from '../../../apps/cli/src/lib/dev-review-loop/reviewer-dispatch'
import { MAX_INFRASTRUCTURE_RETRIES } from '../../../apps/cli/src/lib/dev-review-loop/round-assess'
import { cleanupAllReviewerIsolationArtifacts } from '../../../apps/cli/src/lib/dev-review-loop/reviewer-isolation'
import { readUnpushedWorkDetail } from '../../../apps/cli/src/lib/dev-review-loop/unpushed-work'
import { defaultDeps } from '../../../apps/cli/src/lib/dev-review-loop'
import {
  liveTaskInput,
  readUnpublishedWork,
  renderedFlowPath,
  runDirectory,
  runEngine,
  type Agent,
  type EngineForge,
  type RunTrace
} from '../bin/run-engine'
import { claimResume, liveResumeDeps, type ResumeDeps } from '../bin/run-lifecycle'
import { createActions } from '../executing/actions'
import type { DeveloperPromptFacts } from '../executing/developer-prompt'
import { liveHandoffDeps, type HandoffDeps } from '../executing/handoff'

// The round decisions of the Engine Flow's actions, each driven end to end on the real runner, Flow and bound
// actions: a real git repository and worktree, a stand-in check command, a file-backed fake forge and
// vendor-shaped stub agents. Every decision is the shared assessment's; these tests only arrange the inputs and
// read what the run did. Each case runs once with the Claude stub agent and once with the Codex stub agent.

const PROCESS = loadProcess(resolve(import.meta.dir, '..'))
const AGENTS: readonly Agent[] = ['claude', 'codex']
const TASK = 7
const BRANCH = 'task/issue-7'
const PR = 70
const ROLES = ['developer', 'code-reviewer', 'security-reviewer'] as const
type Role = (typeof ROLES)[number]

/** What one stub agent launch does: its structured output (undefined for none), its exit code, its side effects. */
interface Launch {
  output?: unknown
  exitCode?: number
  /** Runs before the output is delivered, with the prompt the launch was given. */
  act?: (prompt: string) => void
}

interface Scenario {
  /** The gate results in turn; the last repeats. */
  gates?: Array<{ code: number; output: string }>
  policy?: Partial<ReviewPolicy>
  clock?: { elapsedMs: number; byPhaseMs: Record<string, number> }
  /** The Developer's launches in turn, by attempt (1-based); the default publishes a new head and reports confidence 90. */
  developer?: (attempt: number, world: World) => Launch
  /** A reviewer's launches, by role and attempt; the default approves every objective, bound to its prompt. */
  reviewer?: (role: Role, attempt: number, world: World, prompt: string) => Launch | 'approve' | 'request-changes'
  /** Runs after the named step's action, with the world. */
  after?: Partial<Record<string, (world: World) => void>>
  /** Infrastructure retries an earlier pause of the task already spent. */
  priorRetries?: number
  /** A run that finds the pull request already open, at this review round. */
  attachAtRound?: number
}

interface World {
  repo: string
  worktree: string
  runtimeDir: string
  /** The branch head on the fake remote. */
  remote: string
  rulingOrdinal: number
  objectives: Array<{ id: string; text: string }>
  /** The Developer opens the pull request on its first turn: none is open before it. */
  prOpen: boolean
  git: (...args: string[]) => string
  /** Commits a change in the worktree and, when `push` is set, moves the remote head to it. */
  commit: (push: boolean) => string
}

interface Observed {
  trace: RunTrace
  world: World
  spawns: Record<Role, number>
  prompts: Record<Role, string[]>
  launchDirectories: Record<Role, string[]>
  sessionIds: Record<Role, string[]>
  /** Every Log event the run wrote, as `<kind>/<event>`. */
  events: string[]
  rawEvents: Array<Record<string, unknown>>
  /** The recorded result of each step, in the order the steps ran. */
  steps: Array<{ node: string; exitCode: number; stdout: string }>
  markers: string[]
  published: Array<Record<string, unknown>>
  gateRuns: number
  outcome: string
}

const confident = (confidence: number | undefined, addressed: string[] = []) => ({
  turnResult: {
    schemaVersion: 1,
    status: 'completed',
    summary: 'Done.',
    ...(confidence === undefined ? {} : { confidence }),
    confidenceExplanation: 'Stub result.',
    addressedFindingIds: addressed,
    sourceUses: [],
    reportedChecks: null
  }
})

const handoffIds = (prompt: string): string[] => [
  ...new Set([...prompt.matchAll(/^- (R\d+-(?:CR|SEC)-\d+)(?::|$)/gm)].map((m) => m[1]!))
]

/** The CLI-shaped child a vendor launches: its stream is delivered after the executor closes stdin. */
function stubChild(agent: Agent, sessionId: string, launch: (prompt: string) => Launch): SpawnedProcessLike {
  const closeListeners: Array<(code: number | null) => void> = []
  let stdout: ((chunk: string) => void) | undefined
  let prompt = ''
  return {
    stdin: {
      write: (chunk: string) => {
        prompt += chunk
      },
      end: () => {
        setTimeout(() => {
          const { output, exitCode = 0, act } = launch(prompt)
          act?.(prompt)
          const lines =
            agent === 'claude'
              ? [
                  { type: 'system', session_id: sessionId },
                  ...(output === undefined
                    ? []
                    : [{ type: 'result', session_id: sessionId, structured_output: output }])
                ]
              : [
                  { type: 'thread.started', thread_id: sessionId },
                  ...(output === undefined
                    ? []
                    : [{ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(output) } }]),
                  { type: 'turn.completed' }
                ]
          if (exitCode === 0) for (const line of lines) stdout?.(`${JSON.stringify(line)}\n`)
          for (const listener of closeListeners) listener(exitCode)
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

function roleOf(agent: Agent, args: readonly string[], env: Record<string, string | undefined> | undefined): Role {
  const marker =
    agent === 'claude' ? (args[args.indexOf('--settings') + 1] ?? '') : `${env?.CODEX_HOME ?? ''}/role-settings.json`
  const role = ROLES.find((name) => marker.includes(`/generated/${name}/`))
  if (role === undefined) throw new Error(`unrecognized ${agent} launch: ${marker}`)
  return role
}

/** A reviewer's result bound to the head and manifest its prompt names, as a live reviewer binds it. */
function review(role: Role, prompt: string, world: World, changes: boolean | string, objectiveIds?: string[]) {
  const binding = /headSha (\S+), and manifestDigest (\S+)\./.exec(prompt)
  return {
    reviewResult: {
      schemaVersion: 1,
      role,
      status: 'completed',
      headSha: binding?.[1] ?? 'unbound',
      manifestDigest: binding?.[2] ?? 'unbound',
      summary: 'Stub review.',
      findings: changes
        ? [
            {
              severity: 'BLOCKER',
              file: 'sample.ts',
              line: 1,
              description: typeof changes === 'string' ? changes : 'a blocking finding to address'
            }
          ]
        : [],
      objectiveResults: (objectiveIds ?? world.objectives.map((o) => o.id)).map((id) => ({
        id,
        status: 'MET',
        evidence: 'sample.ts implements the behavior.'
      }))
    }
  }
}

const savedEnv: Record<string, string | undefined> = {}
const roots: string[] = []
beforeAll(() => {
  for (const key of ['CODEX_HOME', ...SCENARIO_ENV_KEYS]) savedEnv[key] = process.env[key]
  const home = mkdtempSync(join(tmpdir(), 'round-decisions-codex-'))
  writeFileSync(join(home, 'auth.json'), '{}\n')
  process.env.CODEX_HOME = home
  keepLogLocal()
})
afterAll(() => {
  // Best-effort: a reviewer's read-only candidate copy is cleared first, as the runner clears it.
  for (const root of roots) {
    cleanupAllReviewerIsolationArtifacts(join(root, 'runtime'), TASK)
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    } catch {}
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  useRuntimeDir(null)
})

async function run(agent: Agent, scenario: Scenario = {}): Promise<Observed> {
  const root = mkdtempSync(join(tmpdir(), 'round-decisions-'))
  roots.push(root)
  const runtimeDir = join(root, 'runtime')
  mkdirSync(runtimeDir)
  useRuntimeDir(runtimeDir)
  const repo = join(root, 'repo')
  mkdirSync(repo)
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'sample.ts'), 'export const value = 1\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  const worktree = join(repo, '.worktrees', BRANCH)
  git('worktree', 'add', '-q', '-b', BRANCH, worktree)
  let commits = 0
  const world: World = {
    repo,
    worktree,
    runtimeDir,
    remote: git('rev-parse', 'HEAD'),
    rulingOrdinal: 0,
    objectives: [{ id: 'O1', text: 'Do the thing.' }],
    prOpen: false,
    git: (...args) => git('-C', worktree, ...args),
    commit: (push) => {
      commits += 1
      writeFileSync(join(worktree, 'sample.ts'), `export const value = ${commits + 1}\n`)
      git('-C', worktree, 'commit', '-q', '-am', `change ${commits}`)
      const head = git('-C', worktree, 'rev-parse', 'HEAD')
      if (push) world.remote = head
      return head
    }
  }
  // The stand-in check command the real gate step runs, with the next result in turn.
  const gates = join(root, 'gates.json')
  const gateCli = join(root, 'gate.ts')
  writeFileSync(gates, JSON.stringify(scenario.gates ?? [{ code: 0, output: 'checks passed' }]))
  writeFileSync(
    gateCli,
    `const all = await Bun.file(${JSON.stringify(gates)}).json(); const [next] = all; if (all.length > 1) await Bun.write(${JSON.stringify(gates)}, JSON.stringify(all.slice(1))); await Bun.write(${JSON.stringify(join(root, 'gate-runs'))}, String(Number(await Bun.file(${JSON.stringify(join(root, 'gate-runs'))}).text().catch(() => '0')) + 1)); console.log(next.output); process.exit(next.code)\n`
  )
  const policy: ReviewPolicy = { ...DEFAULT_REVIEW_POLICY, ...scenario.policy }
  const brief = `# Frozen brief\n\n## Objectives\n\nO1. Do the thing.\n\n**Revision:** ${world.remote}\n`
  const published: Array<Record<string, unknown>> = []
  const markers: string[] = []
  const forge: Partial<EngineForge> = {
    checkTaskDispatchReadiness: () => ({ ready: true, output: 'ready' }),
    createTaskWorktree: () => worktree,
    findOpenPrForBranch: () => (world.prOpen ? { number: PR, branch: BRANCH } : null),
    fetchFrozenBrief: () => brief,
    resolveIssueObjectives: () => ({
      objectives: world.objectives,
      text: world.objectives.map((o) => `${o.id}. ${o.text}`).join('\n'),
      version: objectivesVersion(world.objectives),
      edit: null
    }),
    fetchNewestRulingOrdinal: () => world.rulingOrdinal,
    fetchNewestIssueRulingOrdinal: () => 0,
    fetchSourceRevision: () => 'revision',
    fetchCiConclusion: () => 'green',
    ...QUIET_FORGE_GATES,
    fetchIssueRulingsAfterBrief: () => [],
    fetchRulings: () => [],
    fetchLoopHistory: () => ({
      rounds: [],
      totalWallMs: 0,
      totalFilesChanged: 0,
      summaryUrl: null,
      reviewGate: 'unknown',
      journalFinalized: null
    }),
    resolveHead: () => world.remote,
    resolveDeveloperDoctrineText: () => Promise.resolve('Execute the frozen brief.'),
    prBody: () => `Closes #${TASK}`,
    pullRequestView: () => ({ number: PR, body: `Closes #${TASK}`, headRefOid: world.remote, state: 'OPEN' }),
    publishRound: (_runtime, input) => void published.push(input as unknown as Record<string, unknown>)
  }
  const task = await liveTaskInput({ task: TASK, agent, dryRun: false }, repo, runtimeDir, 'round-decisions', {
    fetchLabels: () => [],
    fetchTitle: () => 'A test task',
    policy: () => policy,
    forge,
    repository: 'attalabs/round-decisions'
  })
  task.cliEntry = gateCli
  task.bound = {
    ...task.bound,
    localGateControl: () => ({ control: 'local-gate', active: true, detail: '', remedy: '' }),
    probeAgentSandbox: async () => ({ ok: true })
  }
  if (scenario.clock) task.clock = scenario.clock
  if (scenario.attachAtRound !== undefined) {
    world.prOpen = true
    task.seedRound?.(scenario.attachAtRound)
  }
  if (scenario.priorRetries !== undefined)
    writePauseState(runtimeDir, {
      task: TASK,
      round: 1,
      head: world.remote,
      branch: BRANCH,
      prNumber: PR,
      reason: 'infrastructure',
      detail: 'an earlier pause',
      pausedAt: new Date().toISOString(),
      agent,
      infrastructureRetries: scenario.priorRetries
    })
  const steps: Observed['steps'] = []
  const actions: ActionRegistry = Object.fromEntries(
    Object.entries(createActions(task)).map(([name, action]) => [
      name,
      async (context: Parameters<typeof action>[0]) => {
        const result = await action(context)
        steps.push({ node: context.nodeId, exitCode: result.exitCode, stdout: result.stdout ?? '' })
        scenario.after?.[context.nodeId]?.(world)
        return result
      }
    ])
  )
  const handoffDeps: HandoffDeps = {
    ...liveHandoffDeps(() => {}),
    postPauseComment: (_task, _round, _head, _pr, reason) => {
      markers.push(pauseMarker(reason))
      return { attempts: 1, posted: true }
    },
    postIssuePauseComment: (_task, _branch, _round, reason) => {
      markers.push(pauseMarker(reason))
      return { attempts: 1, posted: true }
    }
  }
  const spawns: Record<Role, number> = { developer: 0, 'code-reviewer': 0, 'security-reviewer': 0 }
  const prompts: Record<Role, string[]> = { developer: [], 'code-reviewer': [], 'security-reviewer': [] }
  const launchDirectories: Record<Role, string[]> = { developer: [], 'code-reviewer': [], 'security-reviewer': [] }
  const sessionIds: Record<Role, string[]> = { developer: [], 'code-reviewer': [], 'security-reviewer': [] }
  const rawEvents: Array<Record<string, unknown>> = []
  const facts = (): DeveloperPromptFacts => ({
    brief,
    objectives: { objectives: world.objectives, version: objectivesVersion(world.objectives) },
    rulings: [],
    rulingOrdinal: world.rulingOrdinal,
    policy,
    baseSha: world.remote,
    headSha: world.remote,
    sources: { block: null, evidence: [] },
    round: task.reviewRound(),
    doctrine: 'Execute the frozen brief.',
    issueRulings: [],
    keptWork: null,
    resume: { task: TASK, branch: BRANCH, worktree, remoteHead: world.remote },
    heldReview: null
  })
  const result = await runEngine({
    args: { task: TASK, agent, dryRun: false },
    process: PROCESS,
    repoRoot: repo,
    runtimeDir,
    loopId: 'round-decisions',
    taskInput: task,
    handoffDeps,
    actions,
    sink: { log: (event) => void rawEvents.push(event as Record<string, unknown>), drain: async () => {} },
    startHost: async () => ({ close: async () => {} }),
    devToolsContext: {} as never,
    out: () => {},
    developerFacts: async () => facts(),
    spawnFn: (_command, args, options) => {
      const role = roleOf(agent, args, options?.env)
      spawns[role] += 1
      const attempt = spawns[role]
      const sessionId = `${agent}-${role}-${attempt}`
      launchDirectories[role].push(options?.cwd ?? '')
      sessionIds[role].push(sessionId)
      return stubChild(agent, sessionId, (prompt) => {
        prompts[role].push(prompt)
        if (role === 'developer') {
          world.prOpen = true
          const launch = scenario.developer?.(attempt, world)
          return (
            launch ?? {
              output: confident(90, handoffIds(prompt)),
              act: () => world.commit(true)
            }
          )
        }
        const chosen = scenario.reviewer?.(role, attempt, world, prompt) ?? 'approve'
        if (chosen === 'approve' || chosen === 'request-changes')
          return { output: review(role, prompt, world, chosen === 'request-changes') }
        return chosen
      })
    }
  })
  const trace = JSON.parse(readFileSync(result.tracePath, 'utf8')) as RunTrace
  const gateRuns = existsSync(join(root, 'gate-runs')) ? Number(readFileSync(join(root, 'gate-runs'), 'utf8')) : 0
  return {
    trace,
    world,
    spawns,
    prompts,
    launchDirectories,
    sessionIds,
    rawEvents,
    events: rawEvents.map((event) => `${String(event.kind)}/${String(event.event)}`),
    steps,
    markers,
    published,
    gateRuns,
    outcome: trace.outcome === 'paused' ? `pause:${trace.pauseReason}` : trace.outcome
  }
}

function camelize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelize)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
        camelize(item)
      ])
    )
  return value
}

/** The records one step left, parsed, in the order it ran. */
const records = (observed: Observed, node: string) =>
  observed.steps.filter((step) => step.node === node).map((step) => JSON.parse(step.stdout) as Record<string, any>)

test("the standalone loop's unpushed-work dependency is the shared reader itself", () => {
  expect(defaultDeps().readUnpushedWorkDetail).toBe(readUnpushedWorkDetail)
})

test('the Engine runner reads unpushed work with the standalone reader, and nothing for a worktree that is gone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'round-decisions-reader-'))
  roots.push(dir)
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
      cwd: dir,
      encoding: 'utf8'
    })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'a.txt'), 'a\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  writeFileSync(join(dir, 'draft.ts'), 'draft\n')
  expect(readUnpublishedWork(dir)).toEqual(readUnpushedWorkDetail(dir))
  expect(readUnpublishedWork(dir)?.dirtyFiles).toEqual(['draft.ts'])
  expect(readUnpublishedWork(join(dir, 'missing'))).toBeNull()
})

for (const agent of AGENTS) {
  describe(`the red gate is a gate observation (${agent})`, () => {
    test('the same normalized failure twice ends repeat_failure, and no reviewer runs', async () => {
      const observed = await run(agent, {
        // The two failures differ only in their volatile tokens: a duration and a clock time.
        gates: [
          { code: 1, output: 'check failed: sample.test.ts (1200ms) at 10:01:02' },
          { code: 1, output: 'check failed: sample.test.ts (980ms) at 10:04:11' }
        ]
      })
      expect(observed.outcome).toBe('pause:repeat_failure')
      expect(readPauseState(observed.world.runtimeDir, TASK)?.detail).toContain('check failed: sample.test.ts (980ms)')
      expect(observed.spawns['code-reviewer']).toBe(0)
      expect(observed.spawns.developer).toBe(2)
      expect(observed.markers).toEqual([pauseMarker('repeat_failure')])
      expect(observed.events).toContain('dev_review_loop/stop_condition_met')
    })

    test('an unreviewed round is recorded with its reason, and the round starts once', async () => {
      const observed = await run(agent, {
        gates: [
          { code: 1, output: 'check failed: lint' },
          { code: 0, output: 'checks passed' }
        ]
      })
      expect(observed.outcome).toBe('completed')
      const [red] = records(observed, 'assess-gate')
      expect(red?.decision).toMatchObject({ type: 'dispatch_developer' })
      expect(red?.state.rounds).toEqual([
        expect.objectContaining({ round: 1, notReviewed: 'checks_red', countsBySeverity: {} })
      ])
      const roundEnds = observed.rawEvents.filter((event) => event.event === 'round_ended')
      expect(roundEnds[0]).toMatchObject({ round: 1, outcome: 'changes_requested' })
      expect(observed.rawEvents.filter((event) => event.event === 'round_started')).toHaveLength(1)
      expect(observed.published.map((input) => input.round)).toEqual([1])
    })

    test('the task time budget is checked on a gate observation', async () => {
      const observed = await run(agent, {
        policy: { maxTaskMinutes: 1 },
        clock: { elapsedMs: 120_000, byPhaseMs: { developing: 120_000 } },
        gates: [{ code: 1, output: 'check failed: lint' }]
      })
      expect(observed.outcome).toBe('pause:time_budget')
      expect(observed.spawns['code-reviewer']).toBe(0)
      expect(records(observed, 'assess-gate')[0]?.state.rounds).toEqual([
        expect.objectContaining({ notReviewed: 'time_budget' })
      ])
    })

    test('the task time budget is checked on a mechanical-failure observation', async () => {
      let elapsedMs = 0
      const clock = {
        get elapsedMs() {
          return elapsedMs
        },
        byPhaseMs: {}
      }
      const observed = await run(agent, {
        policy: { maxTaskMinutes: 1 },
        clock: clock as never,
        gates: [{ code: 1, output: 'check failed: lint' }],
        developer: (attempt, world) =>
          attempt === 1
            ? { output: confident(90), act: () => world.commit(true) }
            : {
                // A commit that never reached the remote: a push that did not land.
                output: confident(90),
                act: () => {
                  world.commit(false)
                  world.git('branch', '--set-upstream-to', 'main')
                  elapsedMs = 120_000
                }
              }
      })
      expect(observed.outcome).toBe('pause:time_budget')
      expect(records(observed, 'validate-developer-output').at(-1)?.decision).toMatchObject({
        type: 'pause',
        reason: 'time_budget'
      })
    })
  })

  describe(`Developer output and confidence are the assessment's decisions (${agent})`, () => {
    test('an invalid turn result earns one correction turn, then pauses infrastructure, never a thrown error', async () => {
      const observed = await run(agent, {
        developer: () => ({ output: { turnResult: { schemaVersion: 1, status: 'completed' } } })
      })
      expect(observed.outcome).toBe('pause:infrastructure')
      expect(observed.trace.error).toBeUndefined()
      expect(observed.spawns.developer).toBe(2)
      expect(observed.spawns['code-reviewer']).toBe(0)
      expect(observed.prompts.developer[1]).toContain('The driver rejected your turn result')
      expect(records(observed, 'validate-developer-output').map((record) => record.decision.type)).toEqual([
        'correction',
        'pause'
      ])
    })

    test('a corrected turn result stands, and the round goes on to its reviewers', async () => {
      const observed = await run(agent, {
        developer: (attempt, world) =>
          attempt === 1
            ? { output: { turnResult: { schemaVersion: 1, status: 'completed' } }, act: () => world.commit(true) }
            : { output: confident(90) }
      })
      expect(observed.outcome).toBe('completed')
      expect(observed.spawns.developer).toBe(2)
      expect(observed.published.map((input) => input.round)).toEqual([1])
    })

    test('a confidence below 50 earns one extra Developer turn, with no reviewer that round', async () => {
      const observed = await run(agent, {
        reviewer: (role, attempt) => (role === 'code-reviewer' && attempt === 1 ? 'request-changes' : 'approve'),
        developer: (attempt, world) => ({
          output: confident(attempt === 2 ? 30 : 90, attempt === 2 ? ['R1-CR-1'] : []),
          act: () => world.commit(true)
        })
      })
      expect(observed.outcome).toBe('completed')
      const decisions = records(observed, 'assess-gate').map((record) => record.decision)
      expect(decisions).toEqual([
        { type: 'dispatch_reviewers' },
        { type: 'dispatch_developer', reason: 'confidence' },
        { type: 'dispatch_reviewers' }
      ])
      expect(observed.spawns.developer).toBe(3)
      expect(observed.spawns['code-reviewer']).toBe(2)
    })

    test('a first missing confidence asks again without re-running the gate', async () => {
      // A run that attaches to its open pull request in round 2 holds no accepted turn result to read.
      const observed = await run(agent, { attachAtRound: 2, developer: () => ({ output: confident(80) }) })
      expect(observed.outcome).toBe('completed')
      expect(records(observed, 'assess-gate').map((record) => record.decision.type)).toEqual([
        'ask_confidence',
        'dispatch_reviewers'
      ])
      expect(observed.spawns.developer).toBe(1)
      expect(observed.prompts.developer[0]).toContain('report your turn result for the work already on this branch')
      // The re-asked turn changed nothing, so the head's gate result stands as read.
      expect(observed.gateRuns).toBe(1)
      expect(observed.published.map((input) => input.round)).toEqual([2])
    })
  })

  describe(`a reviewer with no usable review is retried fresh (${agent})`, () => {
    test('two attempts use distinct scratch directories and session ids, and the retry stands', async () => {
      const observed = await run(agent, {
        reviewer: (role, attempt, world) =>
          role === 'code-reviewer' && attempt === 1
            ? {
                output: { reviewResult: { ...review(role, '', world, false).reviewResult, role: 'security-reviewer' } }
              }
            : 'approve'
      })
      expect(observed.outcome).toBe('completed')
      expect(observed.spawns['code-reviewer']).toBe(2)
      expect(new Set(observed.launchDirectories['code-reviewer']).size).toBe(2)
      expect(new Set(observed.sessionIds['code-reviewer']).size).toBe(2)
      const reviewerTrace = JSON.stringify(observed.trace.steps.filter((step) => step.nodeId === 'code-review'))
      for (const sessionId of observed.sessionIds['code-reviewer']) expect(reviewerTrace).toContain(sessionId)
      expect(records(observed, 'validate-reviewer-outputs').map((record) => record.next)).toEqual(['retry', 'hold'])
    })

    test('a crashed reviewer is classified and retried; a second crash pauses with nothing held and the round unchanged', async () => {
      const observed = await run(agent, {
        reviewer: (role) => (role === 'security-reviewer' ? { exitCode: 3 } : 'approve')
      })
      expect(observed.outcome).toBe('pause:infrastructure')
      expect(observed.trace.error).toBeUndefined()
      expect(observed.spawns['security-reviewer']).toBe(2)
      const held = readPauseState(observed.world.runtimeDir, TASK)
      expect(held).toMatchObject({ reason: 'infrastructure', round: 1, infrastructureRetries: 1 })
      expect(held?.detail).toContain('exited with code 3')
      expect(existsSync(heldVerdictPath(observed.world.runtimeDir, TASK, 1, 'reviewer'))).toBe(false)
      expect(observed.events).toContain('role_attempt/attempted')
      expect(observed.events).not.toContain('dev_review_loop/verdicts_read')
    })
  })

  describe(`the review inputs are re-read before the verdicts are held (${agent})`, () => {
    test('a head that moved while the reviewers ran discards both verdicts and dispatches them again', async () => {
      const observed = await run(agent, {
        reviewer: (role, attempt, world, prompt) =>
          role === 'security-reviewer' && attempt === 1
            ? { output: review(role, prompt, world, false), act: () => world.commit(true) }
            : 'approve'
      })
      expect(observed.outcome).toBe('completed')
      expect(observed.spawns['code-reviewer']).toBe(2)
      const validated = records(observed, 'validate-reviewer-outputs')
      expect(validated.map((record) => record.next)).toEqual(['redispatch', 'hold'])
      expect(validated[0]?.decision.detail).toContain('headSha')
      // The verdicts held and published are the second dispatch's, bound to the head that stood.
      const dispatches = records(observed, 'dispatch-reviewers')
      expect(dispatches.map((record) => record.attempt)).toEqual([1, 1])
      expect(dispatches[1]?.inputs.manifest.headSha).toBe(observed.world.remote)
      expect(observed.published[0]?.manifest).toEqual(dispatches[1]?.inputs.manifest)
    })

    test('objectives that moved while the reviewers ran discard both verdicts and pause objectives_changed', async () => {
      const observed = await run(agent, {
        reviewer: (role, attempt, world, prompt) =>
          role === 'security-reviewer' && attempt === 1
            ? {
                output: review(role, prompt, world, false),
                act: () => world.objectives.push({ id: 'O2', text: 'Also do this.' })
              }
            : 'approve'
      })
      expect(observed.outcome).toBe('pause:objectives_changed')
      expect(existsSync(heldVerdictPath(observed.world.runtimeDir, TASK, 1, 'reviewer'))).toBe(false)
      expect(observed.events).not.toContain('dev_review_loop/verdicts_read')
      expect(observed.markers).toEqual([pauseMarker('objectives_changed')])
    })
  })

  describe(`committed but unpushed work is resumed once, then no_push (${agent})`, () => {
    test('the first turn is resumed with the commit-and-push instructions, the second pauses no_push', async () => {
      const observed = await run(agent, {
        gates: [{ code: 1, output: 'check failed: lint' }],
        developer: (attempt, world) =>
          attempt === 1
            ? { output: confident(90), act: () => world.commit(true) }
            : // Work left in the worktree, never published: the remote head does not move.
              { output: confident(90), act: () => writeFileSync(join(world.worktree, 'draft.ts'), 'draft\n') }
      })
      expect(observed.outcome).toBe('pause:no_push')
      expect(observed.spawns.developer).toBe(3)
      expect(observed.prompts.developer[2]).toContain('Your previous turn left work that is not yet on the remote.')
      expect(observed.events.filter((name) => name === 'dev_review_loop/unpushed_work_resume')).toHaveLength(1)
      const detail = readPauseState(observed.world.runtimeDir, TASK)?.detail ?? ''
      expect(detail).toContain(`branch ${BRANCH}`)
      expect(detail).toContain('draft.ts')
      expect(observed.markers).toEqual([pauseMarker('no_push')])
    })

    test('a resume that published the work goes on to the gate and the reviewers', async () => {
      const observed = await run(agent, {
        gates: [
          { code: 1, output: 'check failed: lint' },
          { code: 0, output: 'checks passed' }
        ],
        developer: (attempt, world) =>
          attempt === 2
            ? { output: confident(90), act: () => writeFileSync(join(world.worktree, 'draft.ts'), 'draft\n') }
            : {
                output: confident(90),
                act: () => {
                  if (attempt === 3) world.git('add', '-A')
                  world.commit(true)
                }
              }
      })
      expect(observed.outcome).toBe('completed')
      expect(observed.spawns.developer).toBe(3)
      expect(observed.spawns['code-reviewer']).toBe(1)
    })
  })

  describe(`stalled no-push turns are bounded (${agent})`, () => {
    test('two stalled turns with no named failure pause infrastructure through the assessment', async () => {
      const observed = await run(agent, {
        // A red gate that names nothing: the stalls can only be counted, never matched as a repeat.
        gates: [{ code: 1, output: '' }],
        developer: (attempt, world) =>
          attempt === 1 ? { output: confident(90), act: () => world.commit(true) } : { output: confident(90) }
      })
      expect(observed.outcome).toBe('pause:infrastructure')
      expect(observed.spawns.developer).toBe(3)
      expect(observed.spawns['code-reviewer']).toBe(0)
      const held = readPauseState(observed.world.runtimeDir, TASK)
      expect(held?.detail).toContain('unchanged after dispatch')
      expect(held?.infrastructureRetries).toBe(1)
      const stalls = records(observed, 'assess-gate').slice(1)
      expect(stalls.map((record) => record.decision.type)).toEqual(['dispatch_developer', 'pause'])
    })

    test('a stalled turn the gate names twice is the repeat_failure stop', async () => {
      const observed = await run(agent, {
        gates: [{ code: 1, output: 'check failed: lint' }],
        developer: (attempt, world) =>
          attempt === 1 ? { output: confident(90), act: () => world.commit(true) } : { output: confident(90) }
      })
      expect(observed.outcome).toBe('pause:repeat_failure')
      expect(readPauseState(observed.world.runtimeDir, TASK)?.detail).toContain('unchanged after dispatch')
    })

    test('bare retries stop at five: the fifth infrastructure pause needs a ruling to resume', async () => {
      const stalled = (priorRetries: number) =>
        run(agent, {
          priorRetries,
          gates: [{ code: 1, output: '' }],
          developer: (attempt, world) =>
            attempt === 1 ? { output: confident(90), act: () => world.commit(true) } : { output: confident(90) }
        })
      const resume = (observed: Observed) => {
        clearDriverLock(observed.world.runtimeDir, TASK)
        const deps: ResumeDeps = {
          ...liveResumeDeps,
          fetchPrBody: () => `Closes #${TASK}`,
          findOpenPrForBranch: () => ({ number: PR, branch: BRANCH }),
          fetchRulings: () => [],
          fetchIssueRulings: () => [],
          fetchNewestRulingOrdinal: () => 0,
          fetchNewestIssueRulingOrdinal: () => 0,
          fetchNewestRulingAuthor: () => null,
          fetchNewestIssueRulingAuthor: () => null
        }
        return () => claimResume(observed.world.runtimeDir, { pr: PR, agent }, deps)
      }
      const fourth = await stalled(MAX_INFRASTRUCTURE_RETRIES - 2)
      expect(readPauseState(fourth.world.runtimeDir, TASK)?.infrastructureRetries).toBe(MAX_INFRASTRUCTURE_RETRIES - 1)
      expect(resume(fourth)()).toMatchObject({ task: TASK, agent })
      const fifth = await stalled(MAX_INFRASTRUCTURE_RETRIES - 1)
      expect(readPauseState(fifth.world.runtimeDir, TASK)?.infrastructureRetries).toBe(MAX_INFRASTRUCTURE_RETRIES)
      expect(resume(fifth)).toThrow()
    })
  })

  describe(`the Flow's round ceilings are the review policy's (${agent})`, () => {
    const ceilings = (observed: Observed): number[] => {
      const path = renderedFlowPath(runDirectory(observed.world.runtimeDir, TASK))
      const flow = parse(readFileSync(path, 'utf8')) as { steps: Array<{ decision?: { max_revisions: number } }> }
      // The rendered Flow is the one the Engine compiles: it must compile, and its ceilings are its decisions'.
      expect(compileFlow(camelize(flow) as StepsFlow, 'compiles').graph.nodes).toBeDefined()
      return flow.steps.flatMap((step) => (step.decision ? [step.decision.max_revisions] : []))
    }

    test('with maxRounds 2, every ceiling is 2 and a green round at the cap publishes', async () => {
      const observed = await run(agent, {
        policy: { maxRounds: 2 },
        reviewer: (role, attempt) => (role === 'code-reviewer' && attempt === 1 ? 'request-changes' : 'approve')
      })
      expect(ceilings(observed)).toEqual([2, 2, 2, 2, 2, 2, 2, 2])
      expect(observed.outcome).toBe('completed')
      expect(observed.published.map((input) => input.round)).toEqual([2])
    })

    test('with maxRounds 2, a round at the cap that is not green pauses max_rounds', async () => {
      // A new blocking finding each round, so the round cap and not a repeated finding ends the run.
      const observed = await run(agent, {
        policy: { maxRounds: 2 },
        reviewer: (role, attempt, world, prompt) =>
          role === 'code-reviewer' ? { output: review(role, prompt, world, `blocking finding ${attempt}`) } : 'approve'
      })
      expect(observed.outcome).toBe('pause:max_rounds')
      expect(observed.published).toEqual([])
    })

    test('changing maxRounds changes the ceilings the Engine compiles and runs', async () => {
      // Every Developer turn fails the gate differently, so no repeat stop: only the ceiling ends the run.
      let gate = 0
      const failing = (maxRounds: number) =>
        run(agent, {
          policy: { maxRounds },
          gates: Array.from({ length: 8 }, () => {
            gate += 1
            return { code: 1, output: `check failed: case ${gate}` }
          }),
          developer: (_attempt, world) => ({ output: confident(90), act: () => world.commit(true) })
        })
      const two = await failing(2)
      const three = await failing(3)
      expect(ceilings(two)).toEqual([2, 2, 2, 2, 2, 2, 2, 2])
      expect(ceilings(three)).toEqual([3, 3, 3, 3, 3, 3, 3, 3])
      expect(two.outcome).toBe('exhausted')
      expect(three.outcome).toBe('exhausted')
      // The spent budget is a durable pause: its comment asks for the ruling that continues the run.
      expect(two.markers).toEqual([pauseMarker('max_rounds')])
      expect(three.markers).toEqual([pauseMarker('max_rounds')])
      expect(two.spawns.developer).toBe(3)
      expect(three.spawns.developer).toBe(4)
    })
  })

  describe(`one review-input snapshot per round (${agent})`, () => {
    test('prompts, held verdicts and publish read the snapshot, persisted once, after the head and rulings move', async () => {
      const observed = await run(agent, {
        after: {
          // Once both verdicts are held, the head and the rulings move before the round is published.
          'validate-reviewer-outputs': (world) => {
            world.rulingOrdinal = 4
            world.commit(true)
          }
        }
      })
      expect(observed.outcome).toBe('completed')
      const [dispatched] = records(observed, 'dispatch-reviewers')
      const snapshot = dispatched?.inputs.manifest
      expect(snapshot.rulingOrdinal).toBe(0)
      for (const role of ['code-reviewer', 'security-reviewer'] as const)
        expect(observed.prompts[role][0]).toContain(`headSha ${snapshot.headSha}`)
      expect(readFileSync(heldVerdictPath(observed.world.runtimeDir, TASK, 1, 'reviewer'), 'utf8')).toContain(
        `Judged head: ${snapshot.headSha}`
      )
      expect(observed.published[0]?.manifest).toEqual(snapshot)
      expect(snapshot.headSha).not.toBe(observed.world.remote)
      const persisted = readManifest({ root: () => controlStoreRootFor(observed.world.runtimeDir) }, TASK, 1)
      expect(persisted.status).toBe('ok')
      if (persisted.status === 'ok')
        expect(persisted.value).toMatchObject({
          round: 1,
          pr: PR,
          branch: BRANCH,
          repository: 'attalabs/round-decisions',
          headSha: snapshot.headSha,
          baseSha: snapshot.baseSha,
          briefHash: snapshot.briefHash,
          objectivesVersion: snapshot.objectivesVersion,
          rulingOrdinal: 0,
          policyDigest: snapshot.policyDigest
        })
    })
  })
}
