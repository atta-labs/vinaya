import { fixtureDir } from '../../../../../apps/cli/tests/lib/test-temp-fixture'
import { execFileSync } from 'node:child_process'
import {
  chooseTests,
  type FailedTestsRecord,
  recordFromRun
} from '../../../../../apps/cli/src/lib/pre-push-failed-tests'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import {
  DEFAULT_READY_PUSH_TIMEOUT_MINUTES,
  DEFAULT_REVIEW_POLICY,
  objectivesVersion,
  type ReviewPolicy
} from '@attalabs/aeg-core'
import { createRunControl, type SpawnedProcessLike } from '@atta/executor-agent-spawn'
import { loadProcess } from '../../../../../harness/dev-process/loader/load-process'
import { keepLogLocal, QUIET_FORGE_GATES, SCENARIO_ENV_KEYS, useRuntimeDir } from '../../../tests/round-fakes'
import type { ActionRegistry } from '../../../../../harness/dev-process/engine-runtime/run-process'
import { pauseMarker, writePauseState } from '../../../../../apps/cli/src/lib/dev-review-loop/pause-resume'
import { cleanupAllReviewerIsolationArtifacts } from '../../../../../apps/cli/src/lib/dev-review-loop/reviewer-isolation'
import { parseMergeTreeConflictFiles } from '../../../../../apps/cli/src/lib/dev-review-loop/gate-reading'
import {
  liveTaskInput,
  runEngine,
  type Agent,
  type EngineForge,
  type EngineRunOptions,
  type RunTrace
} from '../../../bin/run-engine'
import { createActions } from '../../../executing/actions'
import { createV2Actions, type StagedPullRequest, type V2Functions } from './v2-actions'
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
  evidenceResult?: (attempt: number) => Awaited<ReturnType<NonNullable<V2Functions['writeEvidence']>>>
  /** Wall clock used by the version 2 actions. */
  now?: () => number
  /** The CI conclusions read once per approved head, in turn; the last repeats. Default green. */
  ci?: Array<'green' | 'red'>
  /** The failed check runs a red CI read names; default none. */
  failingRuns?: Array<{ name: string; id: number; detail?: string }>
  /** A failed job's failure lines by run id; null stands for an unreadable log. Default none read. */
  jobExcerpts?: Record<number, string | null>
  /** The test files that fail at each ready push (1-based attempt); default none. */
  failingTests?: (readyAttempt: number) => string[]
  /** Whether the ready push at this attempt (1-based) runs past its deadline; default never. */
  readyTimesOut?: (readyAttempt: number) => boolean
  /** The test files the changes since a refused push affect; default none. */
  affectedSince?: string[]
  /** The gate results in turn; the last repeats. */
  gates?: Array<{ code: number; output: string }>
  policy?: Partial<ReviewPolicy>
  clock?: { elapsedMs: number; byPhaseMs: Record<string, number> }
  /** The Developer's launches in turn, by attempt (1-based); the default publishes a new head and reports confidence 90. */
  developer?: (attempt: number, world: World) => Launch | undefined
  /** Deletes this test's Developer socket marker during this launch, exercising same-turn host replacement. */
  loseDeveloperToolsAt?: number
  /** A reviewer's launches, by role and attempt; the default approves every objective, bound to its prompt. */
  reviewer?: (role: Role, attempt: number, world: World, prompt: string) => Launch | 'approve' | 'request-changes'
  /** Runs after the named step's action, with the world. */
  after?: Partial<Record<string, (world: World) => void>>
  /** Infrastructure retries an earlier pause of the task already spent. */
  priorRetries?: number
  /** A run that finds the pull request already open, at this review round. */
  attachAtRound?: number
  /** End one driver after this checkpointed step, then construct a fresh task input and resume it. */
  restartAfter?: { step: string; beforeResume: () => void }
  /** Runs once the world is built, before the driver starts: commits on the task branch, a moved default branch. */
  setUp?: (world: World) => void
  /**
   * The forge's mergeability of the open pull request, given the answer real git gives for the remote head against
   * the default branch (`git merge-tree`); default that answer.
   */
  mergeable?: (fromGit: 'MERGEABLE' | 'CONFLICTING', world: World) => 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  /** Whether the version 2 open-pull-request lookup fails (answers none) at this moment; default never. */
  pullRequestLookupFails?: (world: World) => boolean
}

export interface World {
  /** The pull request the Developer staged, or null. */
  staged: StagedPullRequest | null
  /** What each ready push selected, in turn. */
  readyRuns: string[][]
  /** Pull requests the open step opened. */
  prsOpened: number
  /** Approved heads whose verdicts have been published. */
  verdictHeads: string[]
  /** CI reads made. */
  ciReads: number
  /** Whether a pull request was open each time a reviewer launched. */
  prOpenAtReview: boolean[]
  /** The remote head after each Developer turn: each storage push moves it. */
  remoteAfterTurn: string[]
  /** Calls that ended storage pushes. */
  storageEnded: number
  /** The pull request and head of each Evidence block the loop wrote. */
  evidenceWrites: Array<{ pr: number; head: string }>
  evidenceLogs: string[]
  evidenceWaits: number[]
  /** The body each opening was given. */
  openedBodies: string[]
  /** Whether each ready push was handed the run's abort signal. */
  readySignals: boolean[]
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
  /** The default branch's tip (`origin/main`). */
  mainTip: () => string
  /** Commits a change to the default branch that conflicts with the task branch's, and moves `origin/main` to it. */
  moveMain: () => string
  /**
   * Merges the default branch's tip (or `target`) into the worktree with `git merge --no-commit`, resolves the
   * conflict, commits the merge and, when `push` is set, moves the remote head to it as the turn's push.
   */
  mergeMain: (push: boolean, target?: string) => string
  /** The local check runs made before each Developer launch, in turn. */
  gateRunsAtDeveloper: number[]
  /** The mergeability reads the fake forge answered, in turn. */
  mergeableReads: string[]
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
  driverLegs: number
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
  const home = fixtureDir('round-decisions-codex-')
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
  const root = fixtureDir('round-decisions-')
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
  let mainMoves = 0
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
    evidenceWrites: [],
    evidenceLogs: [],
    evidenceWaits: [],
    openedBodies: [],
    readySignals: [],
    prsOpened: 0,
    verdictHeads: [],
    ciReads: 0,
    prOpenAtReview: [],
    remoteAfterTurn: [],
    storageEnded: 0,
    gateRunsAtDeveloper: [],
    mergeableReads: [],
    git: (...args) => git('-C', worktree, ...args),
    commit: (push) => {
      commits += 1
      writeFileSync(join(worktree, 'sample.ts'), `export const value = ${commits + 1}\n`)
      git('-C', worktree, 'commit', '-q', '-am', `change ${commits}`)
      const head = git('-C', worktree, 'rev-parse', 'HEAD')
      if (push) world.remote = head
      return head
    },
    mainTip: () => git('rev-parse', 'refs/remotes/origin/main'),
    moveMain: () => {
      mainMoves += 1
      writeFileSync(join(repo, 'sample.ts'), `export const value = 'main ${mainMoves}'\n`)
      git('commit', '-q', '-am', `main moves ${mainMoves}`)
      git('update-ref', 'refs/remotes/origin/main', 'HEAD')
      return git('rev-parse', 'HEAD')
    },
    mergeMain: (push, target) => {
      // A conflicting merge exits non-zero and leaves the conflict in the index for the resolution below.
      try {
        git('-C', worktree, 'merge', '--no-commit', '--no-ff', target ?? world.mainTip())
      } catch {}
      commits += 1
      writeFileSync(join(worktree, 'sample.ts'), `export const value = ${commits + 1}\n`)
      git('-C', worktree, 'add', 'sample.ts')
      git('-C', worktree, 'commit', '-q', '--no-edit')
      const head = git('-C', worktree, 'rev-parse', 'HEAD')
      if (push) {
        world.remote = head
        world.remoteAfterTurn.push(head)
      }
      return head
    }
  }
  /** Real git's answer for the remote head against the default branch, as the forge would compute it. */
  const mergeableFromGit = (): 'MERGEABLE' | 'CONFLICTING' => {
    try {
      git('merge-tree', '--write-tree', 'refs/remotes/origin/main', world.remote)
      return 'MERGEABLE'
    } catch {
      return 'CONFLICTING'
    }
  }
  const conflictingFromGit = (): string[] => {
    try {
      git('merge-tree', '--write-tree', 'refs/remotes/origin/main', world.remote)
      return []
    } catch (error) {
      return parseMergeTreeConflictFiles(String((error as { stdout?: unknown }).stdout ?? ''))
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
    // The forge's mergeability and conflicting files, as real git computes them for the remote head.
    fetchMergeableState: () => {
      const read = scenario.mergeable?.(mergeableFromGit(), world) ?? mergeableFromGit()
      world.mergeableReads.push(read)
      return read
    },
    fetchConflictingFiles: () => conflictingFromGit(),
    fetchFailingCheckRuns: () => (scenario.failingRuns ?? []).map((run) => ({ ...run, startedAt: null })),
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
    publishRound: (_runtime, input) => {
      world.verdictHeads.push(input.expectedHead)
      published.push(input as unknown as Record<string, unknown>)
    }
  }
  let record: FailedTestsRecord | null = null
  const makeTask = async () => {
    const fresh = await liveTaskInput({ task: TASK, agent, dryRun: false, flow: 'v2' }, repo, runtimeDir, 'v2-world', {
      fetchLabels: () => [],
      fetchTitle: () => 'A test task',
      policy: () => policy,
      forge,
      repository: 'attalabs/round-decisions'
    })
    fresh.cliEntry = gateCli
    fresh.bound = {
      ...fresh.bound,
      localGateControl: () => ({ control: 'local-gate', active: true, detail: '', remedy: '' }),
      probeAgentSandbox: async () => ({ ok: true })
    }
    if (scenario.clock) fresh.clock = scenario.clock
    // A mergeability the forge never resolves spends its poll budget at once.
    fresh.gatePoll = { gatePollMaxAttempts: 2, gatePollIntervalMs: 0, sleep: async () => {} }
    // Version 2: the staged pull request, the ready push (selecting with the pre-push hook's own re-run rule) and
    // the opening, all fake; the local checks run the stand-in check command through the real step.
    fresh.flow = 'v2'
    fresh.stagedPullRequest = () => world.staged
    fresh.v2 = {
      now: scenario.now,
      readMainTip: () => world.mainTip(),
      readCheckExcerpt: (jobId) => scenario.jobExcerpts?.[jobId] ?? null,
      stagedPullRequest: () => world.staged,
      findOpenPullRequest: () => (world.prOpen && !scenario.pullRequestLookupFails?.(world) ? { number: PR } : null),
      runReadyGate: ({ head, signal }) => {
        world.readySignals.push(signal !== undefined)
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
        if (scenario.readyTimesOut?.(world.readyRuns.length)) {
          // A stopped run leaves no complete failure record: the next ready push runs its full selection.
          record = null
          return {
            passed: false,
            output: 'timed out',
            selection: null,
            failed: 'all',
            wallMs: 5,
            timedOut: true,
            limitMinutes: policy.readyPushTimeoutMinutes ?? DEFAULT_READY_PUSH_TIMEOUT_MINUTES,
            selectedCount: note.selected.length
          }
        }
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
      openPullRequest: (staged) => {
        world.openedBodies.push(staged.body)
        world.prOpen = true
        world.prsOpened += 1
        return { ok: true, pr: PR }
      },
      endStoragePushes: () => {
        world.storageEnded += 1
      },
      log: (line) => {
        world.evidenceLogs.push(line)
      },
      sleep: async (ms) => {
        world.evidenceWaits.push(ms)
      },
      writeEvidence: ({ pr, head }) => {
        world.evidenceWrites.push({ pr, head })
        return scenario.evidenceResult?.(world.evidenceWrites.length) ?? { ok: true }
      }
    }
    return fresh
  }
  let task = await makeTask()
  scenario.setUp?.(world)
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
  let control = createRunControl()
  let interrupted = false
  const actions = (): ActionRegistry =>
    Object.fromEntries(
      Object.entries({ ...createActions(task), ...createV2Actions(task) }).map(([name, action]) => [
        name,
        async (context: Parameters<typeof action>[0]) => {
          const result = await action(context)
          steps.push({ node: context.nodeId, exitCode: result.exitCode, stdout: result.stdout ?? '' })
          scenario.after?.[context.nodeId]?.(world)
          if (!interrupted && scenario.restartAfter?.step === context.nodeId) {
            interrupted = true
            control.halt('the driver stopped mid-round')
          }
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
  const sockets = new Map<string, string>()
  const engineOptions = (): EngineRunOptions => ({
    args: { task: TASK, agent, dryRun: false, flow: 'v2' },
    process: PROCESS,
    repoRoot: repo,
    runtimeDir,
    loopId: 'round-decisions',
    taskInput: task,
    handoffDeps,
    actions: actions(),
    control,
    sink: { log: (event) => void rawEvents.push(event as Record<string, unknown>), drain: async () => {} },
    ...(scenario.loseDeveloperToolsAt === undefined ? {} : { hostKey: `world-${basename(root)}` }),
    startHost: async ({ socketPath, role }) => {
      if (scenario.loseDeveloperToolsAt === undefined) return { close: async () => {} }
      mkdirSync(dirname(socketPath), { recursive: true })
      writeFileSync(socketPath, 'listening')
      sockets.set(role, socketPath)
      return {
        close: async () => {
          rmSync(socketPath, { force: true })
        }
      }
    },
    devToolsContext: {} as never,
    out: () => {},
    developerFacts: async () => facts(),
    spawnFn: (_command, args, options) => {
      const role = roleOf(agent, args, options?.env)
      spawns[role] += 1
      const attempt = spawns[role]
      if (role === 'developer' && attempt === scenario.loseDeveloperToolsAt)
        rmSync(sockets.get('developer')!, { force: true })
      const sessionId = `${agent}-${role}-${attempt}`
      launchDirectories[role].push(options?.cwd ?? '')
      sessionIds[role].push(sessionId)
      return stubChild(agent, sessionId, (prompt) => {
        prompts[role].push(prompt)
        if (role === 'developer') {
          world.gateRunsAtDeveloper.push(
            existsSync(join(root, 'gate-runs')) ? Number(readFileSync(join(root, 'gate-runs'), 'utf8')) : 0
          )
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
  let driverLegs = 1
  let result = await runEngine(engineOptions())
  if (scenario.restartAfter) {
    if (!interrupted || result.exitCode !== 2) throw new Error('the first driver did not stop at its checkpoint')
    scenario.restartAfter.beforeResume()
    task = await makeTask()
    control = createRunControl()
    driverLegs += 1
    result = await runEngine(engineOptions())
  }
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
    outcome: trace.outcome === 'paused' ? `pause:${trace.pauseReason}` : trace.outcome,
    driverLegs
  }
}

/** The records one step left, parsed, in the order it ran. */
export const records = (observed: Observed, node: string) =>
  observed.steps.filter((step) => step.node === node).map((step) => JSON.parse(step.stdout) as Record<string, any>)
