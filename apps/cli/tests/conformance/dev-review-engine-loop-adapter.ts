import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { buildReviewInputManifest, DEFAULT_REVIEW_POLICY, objectivesVersion } from '@attalabs/aeg-core'
import { createRunControl, type SpawnedProcessLike } from '@atta/executor-agent-spawn'
import { loadProcess } from '../../../../harness/dev-process/loader/load-process.js'
import { createActions } from '../../../../processes/vinaya/executing/actions.js'
import type { DeveloperPromptFacts } from '../../../../processes/vinaya/executing/developer-prompt.js'
import {
  liveTaskInput,
  resumeEngine,
  runEngine,
  type Agent,
  type EngineArgs,
  type EngineForge,
  type EngineRunOptions,
  type RunTrace
} from '../../../../processes/vinaya/bin/run-engine.js'
import { createDeveloperDevToolContext } from '../../src/lib/task-tools/developer-dev-tools-context.js'
import { manifestDigest } from '../../src/lib/review-result.js'
import {
  clearDriverLock,
  pauseMarker,
  readDriverLock,
  readPauseState,
  resolveEscalation,
  writeEscalationRecord
} from '../../src/lib/dev-review-loop/pause-resume.js'
import { liveHandoffDeps, type HandoffDeps } from '../../../../processes/vinaya/executing/handoff.js'
import { liveResumeDeps, type ResumeDeps } from '../../../../processes/vinaya/bin/run-lifecycle.js'
import {
  createLogSink,
  drainLogSink,
  LOG_FOLDER_ONLY_ENV,
  resetDefaultLogSinkContext,
  type LogSinkDeps
} from '../../src/lib/log-sink.js'
import { RUNTIME_DIR_ENV_KEY, resetRuntimeDirCache } from '../../src/lib/run-paths.js'
import { cleanupAllReviewerIsolationArtifacts } from '../../src/lib/dev-review-loop/reviewer-isolation.js'
import { heldVerdictPath } from '../../src/lib/dev-review-loop/reviewer-dispatch.js'
import { handoffIdsInPrompt, OWNED_ENV_KEYS } from '../lib/dev-review-loop-harness.js'
import { FIXTURE_REPO } from '../lib/process-fixture.js'
import type { Observation } from './dev-review-current-loop-adapter.js'

/**
 * The real developer-review Flow and bound actions, supplied with a temporary
 * git repository, a file-backed fake forge and vendor-shaped stub processes.
 * Only external inputs and effects are faked. The adapter never supplies a
 * decision, retry or missing control record on the Engine's behalf.
 *
 * A ruling-resumed scenario goes through the runner's `--resume` entry, which
 * authenticates the ruling and claims the resolution with the real control
 * store; a restart re-enters the start boundary with the same run files and
 * changed forge facts; cancellation requests use the runner's halt handle.
 * Missing behavior stays observable rather than being implemented by this
 * test adapter.
 */
const PROCESS = loadProcess(resolve(import.meta.dir, '../../../../processes/vinaya'))
// The task and pull request the standalone harness's world names.
const TASK = 9001
const BRANCH = `task/issue-${TASK}`
const PR = 123
const SOURCE = 'https://example.com/required-source'
const ROLES = ['developer', 'code-reviewer', 'security-reviewer'] as const
type Role = (typeof ROLES)[number]
type RecordLine = Record<string, unknown>

function append(path: string, value: unknown): void {
  appendFileSync(path, `${JSON.stringify(value)}\n`)
}
function lines(path: string): RecordLine[] {
  return existsSync(path)
    ? readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RecordLine)
    : []
}
function json(path: string): RecordLine | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as RecordLine) : null
}
function records(dir: string): RecordLine[] {
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .sort()
        .map((name) => json(join(dir, name))!)
    : []
}

/** A CLI-shaped child: delivers JSONL only after the executor closes stdin; its output may read the prompt it was given. */
const STUB_SESSIONS: Record<Role, string> = {
  developer: 'dev-session-1',
  'code-reviewer': 'rev-session-1',
  'security-reviewer': 'sec-session-1'
}

function stubAgent(
  agent: Agent,
  role: Role,
  outputFor: (prompt: string) => unknown,
  code: number,
  finish: () => Promise<void>
): SpawnedProcessLike {
  const listeners: Array<(code: number | null) => void> = []
  let stdout: ((chunk: string) => void) | undefined
  let closed = false
  let prompt = ''
  const close = (exit: number | null) => {
    if (closed) return
    closed = true
    for (const listener of listeners) listener(exit)
  }
  return {
    stdin: {
      write: (chunk: string) => {
        prompt += chunk
      },
      end: () => {
        setTimeout(async () => {
          try {
            await finish()
            if (closed) return
            const output = outputFor(prompt)
            // The sessions the standalone world names each role's dispatch with.
            const session = STUB_SESSIONS[role]
            const events =
              code !== 0
                ? []
                : agent === 'claude'
                  ? [
                      { type: 'system', session_id: session },
                      ...(output === undefined
                        ? []
                        : [{ type: 'result', session_id: session, structured_output: output }])
                    ]
                  : [
                      { type: 'thread.started', thread_id: session },
                      ...(output === undefined
                        ? []
                        : [{ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(output) } }]),
                      { type: 'turn.completed' }
                    ]
            for (const event of events) stdout?.(`${JSON.stringify(event)}\n`)
            close(code)
          } catch {
            close(1)
          }
        }, 0)
      }
    },
    stdout: { on: (_event, listener) => (stdout = listener as (chunk: string) => void) },
    stderr: { on: () => {} },
    on: ((event: string, listener: (code: number | null) => void) => {
      if (event === 'close') listeners.push(listener)
    }) as SpawnedProcessLike['on'],
    kill: () => close(null)
  } as SpawnedProcessLike
}

function roleOf(agent: Agent, args: string[], env: Record<string, string | undefined> | undefined): Role {
  const dir = agent === 'claude' ? dirname(args[args.indexOf('--settings') + 1] ?? '') : (env?.CODEX_HOME ?? '')
  const role = basename(dir)
  if (!ROLES.includes(role as Role)) throw new Error(`unrecognized ${agent} launch role: ${role}`)
  return role as Role
}

/** One isolated scenario, returning only recorded output and performed effects. */
export async function runEngineScenario(
  id: string,
  agent: Agent,
  logSink?: Partial<LogSinkDeps>
): Promise<Observation> {
  const root = mkdtempSync(join(tmpdir(), 'engine-corpus-'))
  const runtimeDir = join(root, 'runtime')
  mkdirSync(runtimeDir)
  const savedHome = process.env.CODEX_HOME
  // A stub login prevents the real role launcher from copying an operator's credential.
  const stubHome = join(root, 'stub-home')
  mkdirSync(stubHome)
  writeFileSync(join(stubHome, 'auth.json'), '{}\n')
  process.env.CODEX_HOME = stubHome
  // The handoff's control-store writes land in this scenario's runtime folder, and its Log events stay local.
  const savedRuntime = process.env[RUNTIME_DIR_ENV_KEY]
  const savedFolderOnly = process.env[LOG_FOLDER_ONLY_ENV]
  process.env[RUNTIME_DIR_ENV_KEY] = runtimeDir
  process.env[LOG_FOLDER_ONLY_ENV] = '1'
  // A recorded run names its own task and the repository the standalone harness pins, and no outer identity.
  const savedIdentity = Object.fromEntries(OWNED_ENV_KEYS.map((key) => [key, process.env[key]]))
  // A dispatched session's spool would take the default sink's lines away from this scenario's folder.
  const savedSpool = process.env.VINAYA_LOG_SPOOL_DIR
  delete process.env.VINAYA_LOG_SPOOL_DIR
  if (logSink) {
    for (const key of OWNED_ENV_KEYS) if (key !== RUNTIME_DIR_ENV_KEY) delete process.env[key]
    process.env.VINAYA_TASK = String(TASK)
    process.env.AEG_REPO = FIXTURE_REPO
  }
  resetRuntimeDirCache()
  resetDefaultLogSinkContext()
  const savedCwd = process.cwd()
  try {
    return await drive(id, agent, root, runtimeDir, logSink)
  } finally {
    process.chdir(savedCwd)
    if (savedSpool !== undefined) process.env.VINAYA_LOG_SPOOL_DIR = savedSpool
    for (const key of OWNED_ENV_KEYS) {
      if (key === RUNTIME_DIR_ENV_KEY) continue
      if (savedIdentity[key] === undefined) delete process.env[key]
      else process.env[key] = savedIdentity[key]
    }
    resetDefaultLogSinkContext()
    if (savedHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = savedHome
    if (savedRuntime === undefined) delete process.env[RUNTIME_DIR_ENV_KEY]
    else process.env[RUNTIME_DIR_ENV_KEY] = savedRuntime
    resetRuntimeDirCache()
    if (savedFolderOnly === undefined) delete process.env[LOG_FOLDER_ONLY_ENV]
    else process.env[LOG_FOLDER_ONLY_ENV] = savedFolderOnly
    cleanupAllReviewerIsolationArtifacts(runtimeDir, TASK)
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
}

async function drive(
  id: string,
  agent: Agent,
  root: string,
  runtimeDir: string,
  logSink: Partial<LogSinkDeps> | undefined
): Promise<Observation> {
  const repo = join(root, 'repo')
  mkdirSync(repo)
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=stub', '-c', 'user.email=stub@example.com', '-c', 'commit.gpgsign=false', ...args],
      { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    ).trim()
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'sample.ts'), 'export const value = 1\n')
  git('add', 'sample.ts')
  git('commit', '-q', '-m', 'base')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  const worktree = join(repo, '.worktrees', BRANCH)
  git('worktree', 'add', '-q', '-b', BRANCH, worktree)
  if (id === 'isolation-refusal') git('-C', worktree, 'checkout', '-q', '-b', 'task/other/1')
  const head = git('rev-parse', 'HEAD')
  // A recorded run works from its own repository, as the standalone harness's world does.
  if (logSink) process.chdir(repo)
  const eventFile = join(runtimeDir, 'events.jsonl')
  const effectFile = join(runtimeDir, 'forge.jsonl')
  const actionFile = join(runtimeDir, 'actions.jsonl')
  const gateState = join(root, 'gate.json')
  const gateCli = join(root, 'gate.ts')
  // The real harness.run-gates action invokes this fake external check command.
  writeFileSync(
    gateCli,
    `const gate = await Bun.file(${JSON.stringify(gateState)}).json(); console.log(gate.output); process.exit(gate.code)\n`
  )
  const red = id === 'mechanical-failure-recovers' || id === 'context-pressure'
  // As in the standalone world, this head's red gate is the forge's own failing CI check-run.
  const ciRed = id === 'mechanical-failure-repeats'
  writeFileSync(
    gateState,
    JSON.stringify({ code: red ? 1 : 0, output: red ? 'check failed: sample' : 'checks passed' })
  )
  const objectives =
    id === 'reviewer-invalidity'
      ? [
          { id: 'O1', text: 'Do the thing.' },
          { id: 'O2', text: 'Do the other thing.' }
        ]
      : [{ id: 'O1', text: 'Do the thing.' }]
  let moved = false
  let ruling = false
  let continuing = false
  const policy = {
    ...DEFAULT_REVIEW_POLICY,
    ...(id === 'bounded-exhaustion' ? { maxRounds: 1 } : {}),
    ...(id === 'context-pressure' ? { maxTaskMinutes: 1e-9 } : {})
  }
  const brief = `# Frozen brief\n\n## Objectives\n\n${objectives.map((o) => `${o.id}. ${o.text}`).join('\n')}\n\n**Revision:** ${head}\n`
  const currentObjectives = () => (moved ? [...objectives, { id: 'O2', text: 'Also do this.' }] : objectives)
  let publications = 0
  let prOpen = id === 'restart'
  const forge: EngineForge = {
    checkTaskDispatchReadiness: () => ({ ready: true, output: 'ready' }),
    createTaskWorktree: () => worktree,
    findOpenPrForBranch: () => (prOpen ? { number: PR, branch: BRANCH } : null),
    fetchFrozenBrief: () => brief,
    // Objectives that move mid-round carry the edit that moved them, as in the standalone world.
    resolveIssueObjectives: () => ({
      objectives: currentObjectives(),
      text: currentObjectives()
        .map((o) => `${o.id}. ${o.text}`)
        .join('\n'),
      version: moved ? 'midroundversion' : objectivesVersion(currentObjectives()),
      edit: moved ? { previous: objectives, now: currentObjectives(), reason: 'mid-round change' } : null
    }),
    fetchNewestRulingOrdinal: () => (ruling ? 1 : 0),
    fetchNewestIssueRulingOrdinal: () => 0,
    fetchSourceRevision: () => head,
    fetchCiConclusion: () => (!ciRed && json(gateState)?.code === 0 ? 'green' : 'red'),
    fetchIssueRulingsAfterBrief: () => [],
    fetchRulings: () => (ruling ? ['Go ahead.'] : []),
    fetchLoopHistory: () => ({
      rounds: [],
      totalWallMs: 0,
      totalFilesChanged: 0,
      summaryUrl: null,
      reviewGate: 'unknown',
      journalFinalized: null
    }),
    resolveHead: () => head,
    resolveDeveloperDoctrineText: () => Promise.resolve('Execute the frozen brief.'),
    prBody: () => `Closes #${TASK}`,
    pullRequestView: () => ({
      number: PR,
      body: `Closes #${TASK}`,
      headRefOid: head,
      state: 'OPEN',
      mergeable: id === 'stale-conflict' ? 'CONFLICTING' : 'MERGEABLE'
    }),
    fetchFailingCheckRuns: () => (ciRed ? [{ id: 1, name: 'Vinaya CI', conclusion: 'failure' }] : []) as never,
    fetchFailedCheckWorkflowRunIds: () => [],
    rerunFailedWorkflowJobs: () => {},
    fetchMergeableState: () => (id === 'stale-conflict' ? 'CONFLICTING' : 'MERGEABLE'),
    fetchConflictingFiles: () => (id === 'stale-conflict' ? ['apps/cli/src/lib/x.ts'] : []),
    postMarkedComment: (_kind, _ref, marker) => {
      append(effectFile, { kind: 'comment', marker })
      return `https://example.com/comment/${encodeURIComponent(marker)}`
    },
    publishRound: (_runtime, input) => {
      publications += 1
      append(effectFile, { kind: 'publication-started', round: input.round })
      if ((id === 'uncertain-effect-crash' || id === 'publication-replay') && publications === 1)
        throw new Error('simulated crash after the remote publish began')
      for (const role of ['reviewer', 'security'] as const) {
        const body = readFileSync(heldVerdictPath(runtimeDir, TASK, input.round, role), 'utf8')
        append(effectFile, {
          kind: 'comment',
          marker: role === 'reviewer' ? 'reviewer-verdict' : 'security-verdict',
          body
        })
      }
      append(effectFile, { kind: 'comment', marker: 'summary', round: input.round })
      append(effectFile, { kind: 'published', round: input.round })
    }
  }
  const unavailable = async (): Promise<never> => {
    throw new Error('unused fake tool')
  }
  const devTools = createDeveloperDevToolContext({
    readPublicationCheckInput: () => ({
      worktreeBranch: git('-C', worktree, 'branch', '--show-current'),
      expectedBranch: BRANCH,
      worktreeHead: head,
      recordedHead: head,
      base: head,
      expectedBase: head,
      changedPaths: [],
      surface: null
    }),
    commitAndPush: async () => {
      append(effectFile, { kind: 'commit' })
      append(effectFile, { kind: 'push' })
      return { ok: true, result: { pushedHead: head } }
    },
    validatePrBody: () => ({ ok: true }),
    openPullRequest: unavailable,
    updatePullRequestBody: unavailable,
    refreshEvidence: unavailable,
    readPullRequest: unavailable,
    runChecks: unavailable
  })
  let task: Awaited<ReturnType<typeof liveTaskInput>>
  try {
    task = await liveTaskInput({ task: TASK, agent, dryRun: false }, repo, runtimeDir, 'corpus', {
      fetchLabels: () => [],
      fetchTitle: () => 'A test task',
      policy: () => {
        if (id === 'review-policy-unreadable') throw new Error('fake: trust-anchor read failed')
        return policy
      },
      forge
    })
  } catch (error) {
    // Preparation precedes the Flow; observe its thrown refusal without inventing a run trace.
    return observeEngineRun(runtimeDir, [], error, logSink !== undefined)
  }
  task.cliEntry = gateCli
  // The corpus repository has no installed hooks and no sandbox to probe: both controls are reported active.
  task.bound = {
    ...task.bound,
    localGateControl: () => ({ control: 'local-gate', active: true, detail: '', remedy: '' }),
    probeAgentSandbox: async () => ({ ok: true })
  }
  // As in the standalone world, the brief names one required source, delivered but never read by the turn.
  if (id === 'required-source-failure')
    task.prepareSources = async () => ({
      manifest: { sources: [{ requirementText: SOURCE }] } as never,
      unavailable: []
    })
  if (id === 'context-pressure') task.clock = { elapsedMs: 1000, byPhaseMs: { dispatch_developer: 1000 } }
  const recordedActionsForRun = () =>
    Object.fromEntries(
      Object.entries(createActions(task)).map(([name, action]) => [
        name,
        async (context: Parameters<typeof action>[0]) => {
          try {
            const result = await action(context)
            append(actionFile, { node: context.nodeId, ...result })
            return result
          } catch (error) {
            append(actionFile, {
              node: context.nodeId,
              error: String(error),
              stdout: (error as { stdout?: string }).stdout
            })
            throw error
          }
        }
      ])
    )
  // The handoff's records are the real writers'; only the forge post and the Log delivery are faked.
  const handoffDeps: HandoffDeps = {
    ...liveHandoffDeps((event) => append(eventFile, event)),
    writeEscalationRecord: (facts) => {
      const record = writeEscalationRecord(facts)
      append(eventFile, { kind: 'handoff', event: 'raised' })
      return record
    },
    postPauseComment: (_task, _round, _head, _pr, reason) => {
      append(effectFile, { kind: 'comment', marker: pauseMarker(reason) })
      return { attempts: 1, posted: true }
    },
    postIssuePauseComment: (_task, _branch, _round, reason) => {
      append(effectFile, { kind: 'comment', marker: pauseMarker(reason) })
      return { attempts: 1, posted: true }
    }
  }
  const counts: Partial<Record<Role, number>> = {}
  const traces: RunTrace[] = []
  const facts = (): DeveloperPromptFacts => ({
    brief,
    objectives: { objectives, version: objectivesVersion(objectives) },
    rulings: forge.fetchRulings(PR),
    rulingOrdinal: ruling ? 1 : 0,
    policy,
    baseSha: head,
    headSha: head,
    sources: { block: id === 'required-source-failure' ? `Required sources: ${SOURCE}` : null, evidence: [] },
    round: task.reviewRound(),
    doctrine: 'Execute the frozen brief.',
    issueRulings: [],
    keptWork: null,
    resume: { task: TASK, branch: BRANCH, worktree, remoteHead: head },
    heldReview: null
  })
  const execute = async (cancel = false, args: EngineArgs = { task: TASK, agent, dryRun: false }) => {
    const control = createRunControl()
    const options: EngineRunOptions = {
      args,
      process: PROCESS,
      repoRoot: repo,
      runtimeDir,
      loopId: 'corpus',
      taskInput: task,
      handoffDeps,
      actions: recordedActionsForRun(),
      sink: recordingSink(eventFile, logSink),
      startHost: async () => ({ close: async () => {} }),
      devToolsContext: devTools,
      control,
      cancellationRequested: () => cancel,
      out: () => {},
      developerFacts: async () => facts(),
      observe: (event) => {
        if (cancel && event.type === 'node:start') control.halt('cancel')
      },
      spawnFn: (_command, args, spawnOptions) => {
        const role = roleOf(agent, args, spawnOptions?.env)
        append(effectFile, { kind: 'spawn', role })
        const attempt = (counts[role] ?? 0) + 1
        counts[role] = attempt
        let output: (prompt: string) => unknown
        const isHumanPause =
          ['human-pause', 'resume', 'cancellation', 'operator-intervention-unauthenticated'].includes(id) && !continuing
        if (role === 'developer') {
          // Like the standalone fake Developer, it cites every finding id its prompt hands over.
          output = (prompt) => ({
            turnResult: {
              schemaVersion: 1,
              status: 'completed',
              summary: 'Done.',
              confidence: 90,
              confidenceExplanation: 'the fixture work is done',
              addressedFindingIds: id === 'developer-failure' && attempt > 1 ? ['R9-XX-1'] : handoffIdsInPrompt(prompt),
              sourceUses:
                id === 'required-source-failure' ? [{ source: SOURCE, use: 'claimed without a counted read' }] : [],
              reportedChecks: null
            }
          })
        } else {
          const blocker =
            role === 'code-reviewer' &&
            (id === 'requested-changes' || id === 'developer-failure' || id === 'bounded-exhaustion') &&
            attempt === 1
          const review = {
            reviewResult: {
              schemaVersion: 1,
              role,
              status: isHumanPause && role === 'code-reviewer' ? 'blocked' : 'completed',
              headSha: head,
              manifestDigest: manifestDigest(
                buildReviewInputManifest({
                  headSha: head,
                  baseSha: head,
                  briefContent: brief,
                  objectivesVersion: objectivesVersion(objectives),
                  rulingOrdinal: ruling ? 1 : 0,
                  policy
                })
              ),
              summary: 'Stub review.',
              ...(isHumanPause && role === 'code-reviewer'
                ? { blocker: { kind: 'scope_unclear', detail: 'needs a call nobody made' } }
                : {
                    findings: blocker
                      ? [
                          {
                            severity: 'BLOCKER',
                            file: 'smoke.ts',
                            line: 1,
                            description: 'a blocking finding the developer must address'
                          }
                        ]
                      : [],
                    objectiveResults: (id === 'reviewer-invalidity' && role === 'code-reviewer'
                      ? objectives.slice(0, 1)
                      : objectives
                    ).map((o) => ({ id: o.id, status: 'MET', evidence: 'sample.ts implements the behavior.' }))
                  })
            }
          }
          output = () => (id === 'reviewer-failure' && role === 'security-reviewer' ? undefined : review)
        }
        return stubAgent(agent, role, output, id === 'provider-failure' && role === 'developer' ? 1 : 0, async () => {
          // A turn rejected for an unread source never opens the pull request, as in the standalone world.
          if (role === 'developer' && id !== 'isolation-refusal' && id !== 'required-source-failure') prOpen = true
          if (role === 'developer' && id === 'isolation-refusal')
            append(effectFile, {
              kind: 'tool-result',
              result: await devTools.publishChanges('Test(cli): Exercise publication')
            })
          if (role === 'developer' && id === 'mechanical-failure-recovers' && attempt >= 2)
            writeFileSync(gateState, JSON.stringify({ code: 0, output: 'checks passed' }))
          if (role !== 'developer' && id === 'stale-objectives') moved = true
        })
      }
    }
    const result = await runEngine(options)
    traces.push(JSON.parse(readFileSync(result.tracePath, 'utf8')) as RunTrace)
  }
  await execute()
  // A re-run is a fresh subprocess: the runner of the leg before is gone, and so is whatever lock it kept.
  const runnerGone = () => clearDriverLock(runtimeDir, TASK)
  // The forge a `--resume` reads: the real control store and pause record, a fake pull request and rulings.
  const resumeDeps: ResumeDeps = {
    ...liveResumeDeps,
    resolveEscalation: (...args) => {
      const resolved = resolveEscalation(...args)
      append(eventFile, { kind: 'handoff', event: 'resolved' })
      return resolved
    },
    fetchPrBody: forge.prBody.bind(null, PR),
    findOpenPrForBranch: forge.findOpenPrForBranch,
    fetchRulings: () => (ruling ? ['Go ahead.'] : []),
    fetchIssueRulings: () => (ruling ? ['Go ahead.'] : []),
    fetchNewestRulingOrdinal: () => (ruling ? 1 : 0),
    fetchNewestIssueRulingOrdinal: () => 0,
    fetchNewestRulingAuthor: () => (ruling ? 'principal' : null),
    fetchNewestIssueRulingAuthor: () => null
  }
  let refused: unknown
  if (id === 'publication-replay') {
    runnerGone()
    continuing = true
    await execute()
  }
  if (id === 'resume' || id === 'operator-intervention-unauthenticated') {
    runnerGone()
    continuing = true
    ruling = id === 'resume'
    try {
      await resumeEngine({
        args: { resume: PR, agent },
        runtimeDir,
        deps: resumeDeps,
        run: async (resolved) => {
          await execute(false, resolved)
          return { outcome: null, exitCode: 0, tracePath: '' }
        }
      })
    } catch (error) {
      refused = error
    }
  }
  if (id === 'cancellation') {
    runnerGone()
    ruling = true
    await execute(true)
  }
  return observeEngineRun(runtimeDir, traces, refused, logSink !== undefined)
}

/**
 * The run's sink: every event is kept for the observation and, when overrides
 * are injected, also written through the shared `createLogSink`; its drain
 * drains the default sink too, as the live runner does after a run.
 */
function recordingSink(eventFile: string, logSink: Partial<LogSinkDeps> | undefined): EngineRunOptions['sink'] {
  const shared = logSink ? createLogSink(logSink) : null
  return {
    log: (event) => {
      append(eventFile, event)
      shared?.log(event as Parameters<typeof shared.log>[0])
    },
    drain: async () => {
      if (!shared) return
      await shared.drain()
      await drainLogSink()
    }
  }
}

/** Every Log line recorded for the task under the run's own Log folder. */
function recordedLogLines(runtimeDir: string): RecordLine[] {
  const logsRoot = join(runtimeDir, 'logs')
  if (!existsSync(logsRoot)) return []
  return readdirSync(logsRoot).flatMap((segment) => lines(join(logsRoot, segment, `${TASK}.ndjson`)))
}

/** Normalize actual preparation refusals and saved run records into the shared observation. */
function observeEngineRun(
  runtimeDir: string,
  traces: RunTrace[],
  preparationError?: unknown,
  recorded = false
): Observation {
  const last = traces.at(-1)
  const recordedActions = lines(join(runtimeDir, 'actions.jsonl'))
  const assessed = recordedActions
    .filter((record) => record.node === 'assess-round' && typeof record.stdout === 'string')
    .at(-1)
  const decision = assessed
    ? (JSON.parse(String(assessed.stdout)) as { decision: { type: string; reason?: string } }).decision
    : null
  const pause = readPauseState(runtimeDir, TASK)
  const controlDir = join(runtimeDir, 'tasks-execution', String(TASK), 'control')
  const events = lines(join(runtimeDir, 'events.jsonl'))
  const effects = lines(join(runtimeDir, 'forge.jsonl'))
  const roundStartsByRound: Record<string, number> = {}
  for (const event of events)
    if (event.kind === 'dev_review_loop' && event.event === 'round_started')
      roundStartsByRound[String(event.round)] = (roundStartsByRound[String(event.round)] ?? 0) + 1
  const dispatches = (role: Role) => effects.filter((effect) => effect.kind === 'spawn' && effect.role === role).length
  return {
    decision:
      preparationError !== undefined
        ? 'refused'
        : last?.outcome === 'completed'
          ? 'publish'
          : last?.outcome === 'paused'
            ? `pause:${last.pauseReason ?? 'halt'}`
            : last?.outcome === 'cancelled'
              ? 'cancelled'
              : decision?.type === 'pause'
                ? `pause:${decision.reason}`
                : `ended:${last?.outcome}`,
    refusal:
      preparationError !== undefined
        ? preparationError instanceof Error
          ? preparationError.message
          : String(preparationError)
        : (last?.error ?? null),
    durable: {
      pauseReason: pause?.reason ?? null,
      pauseRound: pause?.round ?? null,
      infrastructureRetries: pause?.infrastructureRetries ?? null,
      // A completed saved trace is the Engine representation of the terminal publish phase.
      controlPhase:
        (json(join(controlDir, 'loop-state.json'))?.phase as string | undefined) ??
        (last?.outcome === 'completed'
          ? 'publish'
          : last?.outcome === 'paused' || decision?.type === 'pause'
            ? 'pause'
            : null),
      driverLockHeld: readDriverLock(runtimeDir, TASK) !== null,
      escalations: records(join(controlDir, 'escalation')).length,
      resolutions: records(join(controlDir, 'resolution'))
        .map((record) => String(record.decision))
        .sort()
    },
    effects: {
      publishedRounds: effects.filter((effect) => effect.kind === 'published').map((effect) => Number(effect.round)),
      markers: effects.filter((effect) => effect.kind === 'comment').map((effect) => String(effect.marker)),
      developerDispatches: dispatches('developer'),
      codeReviewerDispatches: dispatches('code-reviewer'),
      securityDispatches: dispatches('security-reviewer'),
      commits: effects.filter((effect) => effect.kind === 'commit').length,
      pushes: effects.filter((effect) => effect.kind === 'push').length,
      prOpens: effects.filter((effect) => effect.kind === 'pr-open').length
    },
    events: events.map((event) =>
      event.kind === 'dev_review_loop' ? String(event.event) : `${event.kind}:${event.event}`
    ),
    roundStartsByRound,
    journalResults: events
      .filter((event) => event.kind === 'dev_review_loop' && event.event === 'journal_finalized')
      .map((event) => String(event.result)),
    ...(recorded ? { logLines: recordedLogLines(runtimeDir) } : {})
  }
}

const IDS = [
  'clean-completion',
  'lifecycle-telemetry',
  'requested-changes',
  'mechanical-failure-repeats',
  'mechanical-failure-recovers',
  'reviewer-invalidity',
  'reviewer-failure',
  'review-policy-unreadable',
  'developer-failure',
  'provider-failure',
  'required-source-failure',
  'context-pressure',
  'bounded-exhaustion',
  'human-pause',
  'restart',
  'resume',
  'cancellation',
  'operator-intervention-unauthenticated',
  'stale-objectives',
  'stale-conflict',
  'uncertain-effect-crash',
  'publication-replay',
  'isolation-refusal'
]
export const ENGINE_SCENARIO_DRIVERS: Record<string, (agent: Agent) => Promise<Observation>> = Object.fromEntries(
  IDS.map((id) => [id, (agent: Agent) => runEngineScenario(id, agent)])
)
