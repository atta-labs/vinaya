import { execFileSync } from 'node:child_process'
import {
  chooseTests,
  type FailedTestsRecord,
  recordFromRun
} from '../../../../../apps/cli/src/lib/pre-push-failed-tests'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { compileFlow, type StepsFlow } from '@atta/engine'
import { parse } from 'yaml'
import { DEFAULT_REVIEW_POLICY, objectivesVersion, readManifest, type ReviewPolicy } from '@attalabs/aeg-core'
import type { SpawnedProcessLike } from '@atta/executor-agent-spawn'
import { loadProcess } from '../../../../../harness/dev-process/loader/load-process'
import { keepLogLocal, QUIET_FORGE_GATES, SCENARIO_ENV_KEYS, useRuntimeDir } from '../../../tests/round-fakes'
import type { ActionRegistry } from '../../../../../harness/dev-process/engine-runtime/run-process'
import {
  clearDriverLock,
  pauseMarker,
  readPauseState,
  writePauseState
} from '../../../../../apps/cli/src/lib/dev-review-loop/pause-resume'
import { controlStoreRootFor, heldVerdictPath } from '../../../../../apps/cli/src/lib/dev-review-loop/reviewer-dispatch'
import { MAX_INFRASTRUCTURE_RETRIES } from '../../../../../apps/cli/src/lib/dev-review-loop/round-assess'
import { cleanupAllReviewerIsolationArtifacts } from '../../../../../apps/cli/src/lib/dev-review-loop/reviewer-isolation'
import { readUnpushedWorkDetail } from '../../../../../apps/cli/src/lib/dev-review-loop/unpushed-work'
import { defaultDeps } from '../../../../../apps/cli/src/lib/dev-review-loop'
import {
  liveTaskInput,
  readUnpublishedWork,
  renderedFlowPath,
  runDirectory,
  runEngine,
  type Agent,
  type EngineForge,
  type RunTrace
} from '../../../bin/run-engine'
import { claimResume, liveResumeDeps, type ResumeDeps } from '../../../bin/run-lifecycle'
import { createActions } from '../../../executing/actions'
import { createV2Actions, type StagedPullRequest } from './v2-actions'
import type { DeveloperPromptFacts } from '../../../executing/developer-prompt'
import { liveHandoffDeps, type HandoffDeps } from '../../../executing/handoff'

// A world for version 2 of the developer-review Flow (review locally, push once), driven end to end on the real
// runner, the real v2 Flow and its real bound actions: a real git repository and worktree, a stand-in local check
// command, a fake forge, a fake ready push that selects tests with the pre-push hook's own re-run rule, and
// vendor-shaped stub agents. The Developer pushes every commit (a storage push moves the fake remote) and stages its
// pull request; nothing opens a pull request until the open step does. Shared by the round-flow tests and the evals.

export const PROCESS = loadProcess(resolve(import.meta.dir, '../../..'), { flow: 'v2' })
export const AGENTS: readonly Agent[] = ['claude', 'codex']
export const TASK = 7
const BRANCH = 'task/issue-7'
export const PR = 70
const ROLES = ['developer', 'code-reviewer', 'security-reviewer'] as const
type Role = (typeof ROLES)[number]

/** What one stub agent launch does: its structured output (undefined for none), its exit code, its side effects. */
interface Launch {
  output?: unknown
  exitCode?: number
  /** Runs before the output is delivered, with the prompt the launch was given. */
  act?: (prompt: string) => void
}

/** The test files the fake ready push knows; a full selection runs all three. */
export const ALL_TESTS = ['/repo/a.test.ts', '/repo/b.test.ts', '/repo/c.test.ts']

export interface Scenario {
  /** The CI conclusions read once per approved head, in turn; the last repeats. Default green. */
  ci?: Array<'green' | 'red'>
  /** The test files that fail at each ready push (1-based attempt); default none. */
  failingTests?: (readyAttempt: number) => string[]
  /** The test files the changes since a refused push affect; default none. */
  affectedSince?: string[]
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

export interface World {
  /** The pull request the Developer staged, or null. */
  staged: StagedPullRequest | null
  /** What each ready push selected, in turn. */
  readyRuns: string[][]
  /** Pull requests the open step opened. */
  prsOpened: number
  /** CI reads made. */
  ciReads: number
  /** Whether a pull request was open each time a reviewer launched. */
  prOpenAtReview: boolean[]
  /** The remote head after each Developer turn: each storage push moves it. */
  remoteAfterTurn: string[]
  /** Calls that ended storage pushes. */
  storageEnded: number
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

export interface Observed {
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

export const confident = (confidence: number | undefined, addressed: string[] = []) => ({
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
export function review(role: Role, prompt: string, world: World, changes: boolean | string, objectiveIds?: string[]) {
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
/** Call from `beforeAll`: an isolated Codex home and a local-only Log. */
export function setUpWorld(): void {
  for (const key of ['CODEX_HOME', ...SCENARIO_ENV_KEYS]) savedEnv[key] = process.env[key]
  const home = mkdtempSync(join(tmpdir(), 'round-decisions-codex-'))
  writeFileSync(join(home, 'auth.json'), '{}\n')
  process.env.CODEX_HOME = home
  keepLogLocal()
}
/** Call from `afterAll`: removes every world and restores the environment. */
export function tearDownWorld(): void {
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
}

export async function runV2(agent: Agent, scenario: Scenario = {}): Promise<Observed> {
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
    staged: null,
    readyRuns: [],
    prsOpened: 0,
    ciReads: 0,
    prOpenAtReview: [],
    remoteAfterTurn: [],
    storageEnded: 0,
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
    fetchCiConclusion: () => {
      const all = scenario.ci ?? ['green']
      const conclusion = all[Math.min(world.ciReads, all.length - 1)] ?? 'green'
      world.ciReads += 1
      return conclusion
    },
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
  const task = await liveTaskInput({ task: TASK, agent, dryRun: false, flow: 'v2' }, repo, runtimeDir, 'v2-world', {
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
  // Version 2: the staged pull request, the ready push (selecting with the pre-push hook's own re-run rule) and
  // the opening, all fake; the local checks run the stand-in check command through the real step.
  let record: FailedTestsRecord | null = null
  task.flow = 'v2'
  task.stagedPullRequest = () => world.staged
  task.v2 = {
    stagedPullRequest: () => world.staged,
    findOpenPullRequest: () => (world.prOpen ? { number: PR } : null),
    runReadyGate: ({ head }) => {
      const note = chooseTests({
        record,
        head,
        branch: BRANCH,
        recordIsAncestor: true,
        fullSelection: ALL_TESTS,
        affectedSince: record === null ? [] : (scenario.affectedSince ?? []),
        exists: () => true
      })
      world.readyRuns.push(note.selected)
      const failing = scenario.failingTests?.(world.readyRuns.length) ?? []
      const failed = note.selected.filter((file) => failing.includes(file))
      record = recordFromRun(failed.length > 0 ? 'failed' : 'passed', failed, head, BRANCH, new Date(0))
      return {
        passed: failed.length === 0,
        output: failed.map((file) => `  ${file}: fails`).join('\n'),
        selection: note,
        failed,
        wallMs: 5
      }
    },
    openPullRequest: () => {
      world.prOpen = true
      world.prsOpened += 1
      return { ok: true, pr: PR }
    },
    endStoragePushes: () => {
      world.storageEnded += 1
    }
  }
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
    Object.entries({ ...createActions(task), ...createV2Actions(task) }).map(([name, action]) => [
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
    args: { task: TASK, agent, dryRun: false, flow: 'v2' },
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
          const launch = scenario.developer?.(attempt, world)
          return (
            launch ?? {
              output: confident(90, handoffIds(prompt)),
              // A storage push of the commit, and the pull request staged rather than opened.
              act: () => {
                world.commit(true)
                world.staged = { title: 'Feat(sample): Do the thing', body: `Closes #${TASK}` }
                world.remoteAfterTurn.push(world.remote)
              }
            }
          )
        }
        world.prOpenAtReview.push(world.prOpen)
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

/** The records one step left, parsed, in the order it ran. */
export const records = (observed: Observed, node: string) =>
  observed.steps.filter((step) => step.node === node).map((step) => JSON.parse(step.stdout) as Record<string, any>)
