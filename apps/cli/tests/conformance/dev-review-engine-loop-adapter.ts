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
import { createHash } from 'node:crypto'
import { hostname, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import {
  buildReviewInputManifest,
  type ControlStoreDeps,
  DEFAULT_REVIEW_POLICY,
  defaultControlStoreDeps,
  objectivesVersion
} from '@attalabs/aeg-core'
import { createRunControl, type SpawnedProcessLike } from '@atta/executor-agent-spawn'
import { loadProcess } from '../../../../harness/dev-process/loader/load-process.js'
import { setEngineLogIdentity } from '../../../../processes/vinaya/bin/engine-log-identity.js'
import { LOG_IDENTITY_ENV_KEYS } from '../../src/lib/dispatch.js'
import { createActions } from '../../../../processes/vinaya/executing/actions.js'
import type { DeveloperPromptFacts } from '../../../../processes/vinaya/executing/developer-prompt.js'
import { probeAgentSandbox, type SandboxProbeRun } from '../../src/lib/worker-boundary.js'
import type { DevToolContext } from '../../src/lib/task-tools/dev-tools-server.js'
import {
  liveDeveloperFacts,
  liveTaskInput,
  resumeEngine,
  runEngine,
  runShadowEngine,
  type Agent,
  type EngineArgs,
  type EngineForge,
  type EngineRunOptions,
  type RunTrace,
  isAgentLaunchEvent
} from '../../../../processes/vinaya/bin/run-engine.js'
import { createDeveloperDevToolContext } from '../../src/lib/task-tools/developer-dev-tools-context.js'
import { manifestDigest } from '../../src/lib/review-result.js'
import {
  clearDriverLock,
  pauseMarker,
  readDriverLock,
  readPauseState,
  resolveEscalation,
  writeDriverLock,
  writeEscalationRecord
} from '../../src/lib/dev-review-loop/pause-resume.js'
import { liveHandoffDeps, type HandoffDeps } from '../../../../processes/vinaya/executing/handoff.js'
import {
  abortableSleep,
  liveResumeDeps,
  type ResumeDeps,
  type RulingWatch
} from '../../../../processes/vinaya/bin/run-lifecycle.js'
import { cancelDevReviewLoop, taskFromPrBody } from '../../src/lib/dev-review-loop.js'
import {
  createLogSink,
  drainLogSink,
  LOG_FOLDER_ONLY_ENV,
  resetDefaultLogSinkContext,
  type LogSinkDeps
} from '../../src/lib/log-sink.js'
import { RUNTIME_DIR_ENV_KEY, resetRuntimeDirCache, tasksExecutionRoot } from '../../src/lib/run-paths.js'
import { createEffectExecutor, type EffectIdentity, type EffectReconciler, sha256Hex } from '../../src/lib/effects.js'
import { createTaskCancelHandler } from '../../src/lib/task-tools/cancel.js'
import { readTaskRunner } from '../../src/lib/task-run-engine.js'
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
 * changed forge facts; a cancellation is the Operator's shared cancel, run
 * beside a paused run whose own ruling watch then ends it.
 * Missing behavior stays observable rather than being implemented by this
 * test adapter.
 */
const PROCESS = loadProcess(resolve(import.meta.dir, '../../../../processes/vinaya'))
// The task and pull request the standalone harness's world names.
const TASK = 9001
/** The task every Engine scenario runs. */
export const ENGINE_SCENARIO_TASK = TASK
const BRANCH = `task/issue-${TASK}`
const PR = 123
const SOURCE = 'https://example.com/required-source'
const ROLES = ['developer', 'code-reviewer', 'security-reviewer'] as const
type Role = (typeof ROLES)[number]
type RecordLine = Record<string, unknown>

/**
 * The faults no corpus scenario produces, each run through the same world as a corpus scenario: only the faked
 * external input the fault names differs.
 */
export const FAULT_IDS = [
  'developer-process-death',
  'reviewer-process-death',
  'stream-truncation',
  'malformed-stream-lines',
  'provider-timeout',
  'stale-head',
  'source-mutation',
  'reviewer-cross-talk',
  'controller-secret',
  'confinement-missing',
  'confinement-fails-on-first-use'
]
/** Where a fault run keeps the prompts it handed each role, and the source reads each role made, in its runtime directory. */
export const PROMPTS_FILE = 'prompts.jsonl'
export const SOURCE_READS_FILE = 'source-reads.jsonl'
/** The repository source a source mutation's brief names. */
export const PINNED_SOURCE = '`sample.ts`'
/** The head a stale-head run's reviewers judged: one the branch has moved on from, never the round's head. */
export const STALE_HEAD = 'f'.repeat(40)
/** A provider-timeout run's Developer ceiling, in milliseconds. */
export const PROVIDER_TIMEOUT_MS = 500
/** Reasoning a controller-secret run's Developer streams, and controller-held values its environment carries. */
export const REASONING_CANARY = 'raw-reasoning-canary-7f3a'
export const CONTROLLER_SECRETS: Readonly<Record<string, string>> = {
  GH_TOKEN: 'ghp_controllerSecretCanary0001',
  GITHUB_TOKEN: 'ghs_controllerSecretCanary0002',
  VINAYA_LOG_TOKEN: 'log-token-controller-canary-0003'
}

/**
 * The in-flight Engine runs the backend-selection suite rolls back: one in each pause kind (a Principal ruling, an
 * automatic recovery, an Operator's host repair), one stopped mid-Developer turn, one stopped mid-review and one with
 * an uncertain publication. Each ends its first leg in that state and is then continued or terminated and restarted.
 */
export const IN_FLIGHT_KINDS = [
  'principal-ruling-pause',
  'automatic-recovery-pause',
  'operator-remediation-pause',
  'mid-developer-turn',
  'mid-review',
  'uncertain-effect'
] as const
export type InFlightKind = (typeof IN_FLIGHT_KINDS)[number]
/** The runs whose controller is stopped through the leg's run control while a role's turn is still running. */
const STOPPED_MID_TURN: Partial<Record<string, Role>> = {
  'mid-developer-turn': 'developer',
  'mid-review': 'code-reviewer'
}
/** A pid no process holds: the one an exited runner's kept driver lock names. */
const EXITED_PID = 2 ** 22 + 1
/** The key and identity the uncertain-effect run's publication is recorded under, before it is attempted. */
export const PUBLICATION_EFFECT_KEY = 'publication-round-1'
function publicationIdentity(round: number): EffectIdentity {
  return {
    operation: 'pr-comment',
    target: `pr:${PR}`,
    inputVersion: round,
    payloadDigest: sha256Hex(`round ${round}`)
  }
}

/** The stream each role's stub ends with, by run: a fault touches only the role and the attempts it names. */
function streamOf(id: string, role: Role, attempt: number): StubStream {
  if (STOPPED_MID_TURN[id] === role && attempt === 1) return 'hang'
  if (id === 'developer-process-death' && role === 'developer' && attempt === 1) return 'death'
  if (id === 'reviewer-process-death' && role === 'security-reviewer') return 'death'
  if (id === 'stream-truncation' && role === 'developer') return 'truncated'
  if (id === 'malformed-stream-lines' && role === 'developer') return 'malformed'
  if (id === 'provider-timeout' && role === 'developer') return 'hang'
  return 'normal'
}

/**
 * What the host's sandbox probe reports in a confinement fault, in each vendor's own shape: a host with no
 * confinement at all, whose sandbox never starts, and a host whose sandbox starts and fails the probe's command.
 */
const REFUSED_SANDBOX_PROBES: Record<string, (agent: 'claude' | 'codex') => SandboxProbeRun> = {
  'confinement-missing': (agent) =>
    agent === 'claude'
      ? claudeProbeToolResult('sandbox unavailable: bubblewrap (bwrap) is not installed on this host')
      : { exitCode: 127, stdout: '', stderr: 'bwrap: command not found', timedOut: false },
  'confinement-fails-on-first-use': (agent) =>
    agent === 'claude'
      ? claudeProbeToolResult('bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted')
      : { exitCode: 1, stdout: '', stderr: 'bwrap: setting up uid map: Permission denied', timedOut: false }
}

function claudeProbeToolResult(error: string): SandboxProbeRun {
  const toolResult = {
    type: 'user',
    message: { content: [{ type: 'tool_result', content: error, is_error: true }] }
  }
  return { exitCode: 0, stdout: `${JSON.stringify(toolResult)}\n`, stderr: '', timedOut: false }
}

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
/** Every file under a run's runtime directory, by relative path, with its content's digest. */
export function runtimeSnapshot(runtimeDir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile())
        out[relative(runtimeDir, path)] = createHash('sha256').update(readFileSync(path)).digest('hex')
    }
  }
  walk(runtimeDir)
  return out
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

/**
 * How a stub's process ends its stream: a normal turn; a death mid-turn (its session opened, then killed by a
 * signal, no result); its last line cut short; its result line replaced by lines that are not JSON; or no
 * output and no exit at all, until the executor kills it. A stub may also stream the vendor's own reasoning
 * event, carrying `reasoning`, before its result.
 */
export type StubStream = 'normal' | 'death' | 'truncated' | 'malformed' | 'hang'

/** Lines a malformed stream carries in place of its result line. */
export const MALFORMED_STREAM_LINES = ['{"type": "result", "structured_output": {"turnResult":', 'not json at all']

function stubAgent(
  agent: Agent,
  role: Role,
  outputFor: (prompt: string) => unknown,
  code: number,
  finish: () => Promise<void>,
  stream: StubStream = 'normal',
  reasoning?: string
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
            if (closed || stream === 'hang') return
            const output = outputFor(prompt)
            // The sessions the standalone world names each role's dispatch with.
            const session = STUB_SESSIONS[role]
            const opening =
              agent === 'claude'
                ? { type: 'system', session_id: session }
                : { type: 'thread.started', thread_id: session }
            const thinking =
              reasoning === undefined
                ? []
                : agent === 'claude'
                  ? [
                      {
                        type: 'assistant',
                        session_id: session,
                        message: { content: [{ type: 'thinking', thinking: reasoning }] }
                      }
                    ]
                  : [{ type: 'item.completed', item: { type: 'reasoning', text: reasoning } }]
            const result =
              output === undefined
                ? []
                : agent === 'claude'
                  ? [{ type: 'result', session_id: session, structured_output: output }]
                  : [{ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(output) } }]
            const closing = agent === 'claude' ? [] : [{ type: 'turn.completed' }]
            if (stream === 'death') {
              stdout?.(`${JSON.stringify(opening)}\n`)
              close(null)
              return
            }
            const lines =
              code !== 0 ? [] : [opening, ...thinking, ...result, ...closing].map((event) => JSON.stringify(event))
            if (stream === 'truncated') {
              const last = lines.pop() ?? ''
              lines.push(last.slice(0, Math.floor(last.length / 2)))
              stdout?.(lines.join('\n'))
            } else if (stream === 'malformed') {
              const resultAt = 1 + thinking.length
              lines.splice(resultAt, result.length, ...MALFORMED_STREAM_LINES)
              for (const line of lines) stdout?.(`${line}\n`)
            } else for (const line of lines) stdout?.(`${line}\n`)
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

/** What a scenario's inspection reads of the run before its files are removed. */
export interface EngineScenarioRun {
  runtimeDir: string
  task: number
  pr: number
  agent: Agent
}

/**
 * An in-flight run, once its first leg has ended in its in-flight state: what continues it on the Engine, the
 * forge-fake ledger and its reconciler, and the shared cancel the Operator would run against it.
 */
export interface InFlightEngineRun extends EngineScenarioRun {
  kind: InFlightKind
  /** Continues the run on the Engine as its own runner does: the ruling, the repaired host or a re-entry. */
  continueOnEngine: () => Promise<void>
  /** Every effect the forge fake performed, in order. */
  ledger: () => RecordLine[]
  /** Reads the ledger for an effect's identity: confirmed when its publication is there, absent when not. */
  reconcile: EffectReconciler
  /** The Operator's `task_cancel` over this run's records, a Principal's cancel ruling posted. */
  cancel: ReturnType<typeof createTaskCancelHandler>
  controlStore: ControlStoreDeps
}

/** A scenario run in shadow mode (`runShadowEngine`), beside a live run whose runtime directory is `liveRuntimeDir`. */
export interface EngineShadowMode {
  liveRuntimeDir: string
}

/**
 * One isolated scenario, returning only recorded output and performed effects. `inspect` runs once the scenario
 * has ended, while its run files are still there, inside the scenario's own environment. Given `shadow`, every run
 * of the scenario is a shadow run; the scenario's world and its fakes are the same.
 */
export async function runEngineScenario(
  id: string,
  agent: Agent,
  logSink?: Partial<LogSinkDeps>,
  inspect?: (run: EngineScenarioRun) => Promise<void> | void,
  shadow?: EngineShadowMode,
  between?: (run: InFlightEngineRun) => Promise<void>
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
  for (const key of OWNED_ENV_KEYS) if (key !== RUNTIME_DIR_ENV_KEY) delete process.env[key]
  process.env.VINAYA_TASK = String(TASK)
  process.env.AEG_REPO = FIXTURE_REPO
  // The run names its producer as the live Engine runner does before its first event.
  setEngineLogIdentity(PROCESS, agent)
  resetRuntimeDirCache()
  resetDefaultLogSinkContext()
  const savedCwd = process.cwd()
  // A controller-secret run's controller holds secrets in its own environment, as a live runner's does.
  const savedSecrets = Object.fromEntries(Object.keys(CONTROLLER_SECRETS).map((key) => [key, process.env[key]]))
  if (id === 'controller-secret') Object.assign(process.env, CONTROLLER_SECRETS)
  try {
    const observation = await drive(id, agent, root, runtimeDir, logSink, shadow, between)
    await inspect?.({ runtimeDir, task: TASK, pr: PR, agent })
    return observation
  } finally {
    process.chdir(savedCwd)
    for (const [key, value] of Object.entries(savedSecrets)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
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
  logSink: Partial<LogSinkDeps> | undefined,
  shadow: EngineShadowMode | undefined,
  between: ((run: InFlightEngineRun) => Promise<void>) | undefined
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
  const promptFile = join(runtimeDir, PROMPTS_FILE)
  const sourceFile = join(runtimeDir, SOURCE_READS_FILE)
  // The reviewer hosts' contexts the Engine starts, by host role: a reviewer stub reads its sources through them.
  const reviewerContexts = new Map<string, DevToolContext>()
  const eventFile = join(runtimeDir, 'events.jsonl')
  const effectFile = join(runtimeDir, 'forge.jsonl')
  const actionFile = join(runtimeDir, 'actions.jsonl')
  const controlStore = defaultControlStoreDeps(() => tasksExecutionRoot(runtimeDir))
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
  // A source mutation's brief names one repository source, pinned at the revision the brief records.
  const documentation = id === 'source-mutation' ? `\n## Documentation\n\n- ${PINNED_SOURCE} — the value (O1)\n` : ''
  const brief = `# Frozen brief\n\n## Objectives\n\n${objectives.map((o) => `${o.id}. ${o.text}`).join('\n')}\n\n**Revision:** ${head}\n${documentation}`
  // A stale head: both reviewers return verdicts bound to a head the branch has since moved on from.
  const judgedHead = id === 'stale-head' ? STALE_HEAD : head
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
    fetchSettledCiConclusion: () => (!ciRed && json(gateState)?.code === 0 ? 'green' : 'red'),
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
      // A rate limit refuses the first publication before any of it is attempted.
      if (id === 'automatic-recovery-pause' && publications === 1)
        throw new Error('API rate limit exceeded: the publication was refused before it began')
      const publish = () => {
        append(effectFile, { kind: 'publication-started', round: input.round })
        if (
          (id === 'uncertain-effect-crash' || id === 'publication-replay' || id === 'uncertain-effect') &&
          publications === 1
        )
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
        return `https://example.com/pull/${PR}#round-${input.round}`
      }
      if (id !== 'uncertain-effect') {
        publish()
        return
      }
      // Its identity is recorded before the write, through the shared executor, as the live publication's is.
      createEffectExecutor(controlStore, TASK, `engine-corpus:${TASK}:publication`, () => {}).execute({
        key: PUBLICATION_EFFECT_KEY,
        identity: publicationIdentity(input.round),
        poster: publish,
        reconcile: reconcileOnLedger
      })
    }
  }
  /** A publication's identity is on the ledger once that round's publication is recorded there. */
  const reconcileOnLedger: EffectReconciler = (identity) =>
    identity.target === `pr:${PR}` &&
    lines(effectFile).some((effect) => effect.kind === 'published' && effect.round === identity.inputVersion)
      ? { outcome: 'confirmed', url: `https://example.com/pull/${PR}#round-${identity.inputVersion}` }
      : { outcome: 'absent' }
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
    if (logSink) await drainLogSink()
    return observeEngineRun(runtimeDir, [], error, logSink)
  }
  task.cliEntry = gateCli
  // The corpus repository has no installed hooks and no sandbox to probe: both controls are reported active.
  task.bound = {
    ...task.bound,
    localGateControl: () => ({ control: 'local-gate', active: true, detail: '', remedy: '' }),
    probeAgentSandbox: async (plan) => {
      // An Operator's host repair is a host whose confinement was missing, then installed before the run continues.
      const refusedProbe = continuing
        ? undefined
        : REFUSED_SANDBOX_PROBES[id === 'operator-remediation-pause' ? 'confinement-missing' : id]
      // A confinement fault runs the real probe reader over the host's refused probe, as on a Linux host.
      return refusedProbe
        ? probeAgentSandbox(plan, { platform: 'linux', run: async () => refusedProbe(plan.agent) })
        : { ok: true }
    }
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
  /** The run control of the leg running now: the one a run stopped mid-turn is halted through. */
  let legControl: ReturnType<typeof createRunControl> | null = null
  const execute = async (args: EngineArgs = { task: TASK, agent, dryRun: false }, watch?: RulingWatch) => {
    const control = createRunControl()
    legControl = control
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
      startHost: async (host) => {
        if (host.role !== 'developer') reviewerContexts.set(host.role, host.context)
        return { close: async () => {} }
      },
      devToolsContext: devTools,
      control,
      ...(watch || id === 'provider-timeout'
        ? {
            lifecycle: {
              ...(watch ? { watch } : {}),
              ...(id === 'provider-timeout' ? { dispatchConfig: { timeoutMs: PROVIDER_TIMEOUT_MS } } : {})
            }
          }
        : {}),
      out: () => {},
      developerFacts:
        id === 'source-mutation'
          ? async () => {
              const live = await liveDeveloperFacts({
                forge,
                policy: () => policy,
                task: TASK,
                repoRoot: repo,
                runtimeDir,
                branch: BRANCH,
                worktreePath: worktree,
                round: task.reviewRound
              })()
              append(sourceFile, { role: 'developer', evidence: live.sources.evidence })
              return live
            }
          : async () => facts(),
      spawnFn: (_command, args, spawnOptions) => {
        const role = roleOf(agent, args, spawnOptions?.env)
        append(effectFile, { kind: 'spawn', role })
        const attempt = (counts[role] ?? 0) + 1
        counts[role] = attempt
        let output: (prompt: string) => unknown
        const stream = streamOf(id, role, attempt)
        const isHumanPause =
          [
            'human-pause',
            'resume',
            'cancellation',
            'operator-intervention-unauthenticated',
            'principal-ruling-pause'
          ].includes(id) && !continuing
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
                id === 'required-source-failure'
                  ? [{ source: SOURCE, use: 'claimed without a counted read' }]
                  : id === 'source-mutation'
                    ? [{ source: PINNED_SOURCE, use: 'read the pinned value' }]
                    : [],
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
              // Cross-talk: the code reviewer hands back the security reviewer's verdict as its own.
              role: id === 'reviewer-cross-talk' && role === 'code-reviewer' ? 'security-reviewer' : role,
              status: isHumanPause && role === 'code-reviewer' ? 'blocked' : 'completed',
              headSha: judgedHead,
              manifestDigest: manifestDigest(
                buildReviewInputManifest({
                  headSha: judgedHead,
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
        const answer = output
        // A fault run keeps every prompt it handed a role, for its inspection.
        output = (prompt) => {
          if (FAULT_IDS.includes(id)) append(promptFile, { role, prompt })
          return answer(prompt)
        }
        return stubAgent(
          agent,
          role,
          output,
          id === 'provider-failure' && role === 'developer' ? 1 : 0,
          async () => {
            // The controller is stopped through the leg's run control while this turn still runs.
            if (stream === 'hang' && STOPPED_MID_TURN[id] === role) legControl?.halt('the controller stopped mid-turn')
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
            // The source moves on the default branch after the Developer's turn: the brief's pin stays where it was.
            if (role === 'developer' && id === 'source-mutation' && attempt === 1) {
              writeFileSync(join(repo, 'sample.ts'), 'export const value = 2\n')
              git('commit', '-q', '-am', 'mutate the source')
              git('update-ref', 'refs/remotes/origin/main', 'HEAD')
            }
            if (role !== 'developer' && id === 'source-mutation') {
              const host = role === 'code-reviewer' ? 'code-reviewer' : 'security'
              const read = await reviewerContexts.get(host)?.readSource?.({ sourceId: 'sample.ts' })
              append(sourceFile, { role, read: read ?? null })
            }
          },
          stream,
          id === 'controller-secret' ? REASONING_CANARY : undefined
        )
      }
    }
    const result = shadow
      ? await runShadowEngine({ ...options, liveRuntimeDir: shadow.liveRuntimeDir })
      : await runEngine(options)
    traces.push(JSON.parse(readFileSync(result.tracePath, 'utf8')) as RunTrace)
  }
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
    fetchNewestIssueRulingAuthor: () => null,
    fetchPrState: () => 'OPEN'
  }
  /**
   * The run pauses for the Principal and watches for the decision; the Operator's shared cancel, beside it,
   * consumes the cancel resolution and fences the started effects, and the run's watch reads it and ends.
   */
  const cancelInItsWatch = async () => {
    const watching = execute(undefined, { deps: resumeDeps, pollMs: 20, sleep: abortableSleep })
    for (let i = 0; i < 500 && readPauseState(runtimeDir, TASK) === null; i++)
      await new Promise((r) => setTimeout(r, 10))
    const cancelSink = logSink ?? ownLogFolder(runtimeDir)
    await cancelOnTheOperatorsBehalf(operatorsCancelSink(cancelSink))
    await watching
    for (const line of recordedLogLines(cancelSink)) if (line.event === 'cancelled') append(eventFile, line)
  }
  /**
   * The cancel's own Log line, written through the shared sink to this scenario's folder, as a separate process's:
   * its sink reads none of the run's own Log identity (its host, its pull request, its runner, process and runtime).
   */
  const operatorsCancelSink = (cancelSink: Partial<LogSinkDeps>): Partial<LogSinkDeps> => ({
    ...cancelSink,
    env: () => {
      const env = { ...process.env }
      delete env.VINAYA_HOST
      delete env.VINAYA_PR
      for (const key of LOG_IDENTITY_ENV_KEYS) delete env[key]
      return env
    }
  })
  const cancelOnTheOperatorsBehalf = (cancelSink: Partial<LogSinkDeps>) =>
    cancelDevReviewLoop(
      { cancelPr: PR, agent },
      {
        fetchPrBody: forge.prBody.bind(null, PR),
        taskFromPrBody,
        readPauseState,
        fetchRulings: () => ['Cancel it.'],
        fetchNewestRulingOrdinal: () => 1,
        fetchNewestRulingAuthor: () => 'principal',
        runtimeDir: () => runtimeDir,
        resolveRepo: async () => null,
        logSink: cancelSink,
        terminateInFlightLaunchesOnShutdown: () => {},
        sleep: (ms) => new Promise((r) => setTimeout(r, ms > 0 ? 1 : 0))
      }
    )
  if (id === 'cancellation') await cancelInItsWatch()
  else await execute()
  if (between) {
    // The leg's runner has exited: a driver lock it kept for an automatic recovery names its exited pid.
    const kept = readDriverLock(runtimeDir, TASK)
    if (kept !== null && kept.pid === process.pid) writeDriverLock(runtimeDir, TASK, { ...kept, pid: EXITED_PID })
    const continueOnEngine = async () => {
      runnerGone()
      continuing = true
      if (id !== 'principal-ruling-pause') return execute()
      ruling = true
      await resumeEngine({
        args: { resume: PR, agent },
        runtimeDir,
        deps: resumeDeps,
        run: async (resolved) => {
          await execute(resolved)
          return { outcome: null, exitCode: 0, tracePath: '' }
        }
      })
    }
    // The Principal's cancel ruling is posted where the pause's own comment was: the pull request or the task Issue.
    const cancelRuling = { rulings: () => ['Cancel it.'], ordinal: () => 1, author: () => 'principal' }
    const cancel = createTaskCancelHandler({
      runtimeDir: () => runtimeDir,
      resolveIssueForRef: () => TASK,
      fetchRulings: cancelRuling.rulings,
      fetchNewestRulingOrdinal: cancelRuling.ordinal,
      fetchIssueRulings: cancelRuling.rulings,
      fetchNewestIssueRulingOrdinal: cancelRuling.ordinal,
      cancelDevReviewLoop: (input) =>
        cancelDevReviewLoop(input, {
          fetchPrBody: forge.prBody.bind(null, PR),
          taskFromPrBody,
          readPauseState,
          findOpenPrForBranch: forge.findOpenPrForBranch,
          fetchRulings: cancelRuling.rulings,
          fetchNewestRulingOrdinal: cancelRuling.ordinal,
          fetchNewestRulingAuthor: cancelRuling.author,
          fetchIssueRulings: cancelRuling.rulings,
          fetchNewestIssueRulingOrdinal: cancelRuling.ordinal,
          fetchNewestIssueRulingAuthor: cancelRuling.author,
          runtimeDir: () => runtimeDir,
          resolveRepo: async () => null,
          logSink: operatorsCancelSink(logSink ?? ownLogFolder(runtimeDir)),
          terminateInFlightLaunchesOnShutdown: () => {},
          sleep: (ms) => new Promise((r) => setTimeout(r, ms > 0 ? 1 : 0))
        }),
      hostname,
      log: () => {},
      runner: readTaskRunner
    })
    await between({
      kind: id as InFlightKind,
      runtimeDir,
      task: TASK,
      pr: PR,
      agent,
      continueOnEngine,
      ledger: () => lines(effectFile),
      reconcile: reconcileOnLedger,
      cancel,
      controlStore
    })
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
          await execute(resolved)
          return { outcome: null, exitCode: 0, tracePath: '' }
        }
      })
    } catch (error) {
      refused = error
    }
  }
  // The default sink's lines (the handoff records) drain last, as the live runner drains them after a run.
  if (logSink) await drainLogSink()
  return observeEngineRun(runtimeDir, traces, refused, logSink)
}

/**
 * The run's sink: every event is kept for the observation and, when overrides
 * are injected, also written through the shared `createLogSink`.
 */
function recordingSink(eventFile: string, logSink: Partial<LogSinkDeps> | undefined): EngineRunOptions['sink'] {
  const shared = logSink ? createLogSink(logSink) : null
  return {
    log: (event) => {
      // An agent launch's own lines are the dispatch's, never the loop's: the standalone side's in-process dispatch
      // writes none, so the replay judges the loop's lines on both runners and leaves the launch's out of both.
      if (isAgentLaunchEvent(event as { kind?: unknown; actor?: unknown })) return
      append(eventFile, event)
      shared?.log(event as Parameters<typeof shared.log>[0])
    },
    drain: async () => {
      await shared?.drain()
    }
  }
}

/** A sink recording to the scenario's own Log folder, for a run given no sink of its own. */
function ownLogFolder(runtimeDir: string): Partial<LogSinkDeps> {
  const folder = { kind: 'folder' as const, folder: join(runtimeDir, 'cancel-logs') }
  return { resolveLogDestination: () => folder, unresolvedLogDestination: () => folder }
}

/** Every Log line the injected sink recorded for the task, read from the folder that sink names. */
function recordedLogLines(logSink: Partial<LogSinkDeps>): RecordLine[] {
  const destination = logSink.unresolvedLogDestination?.(process.env)
  if (destination?.kind !== 'folder') return []
  const logsRoot = destination.folder
  if (!existsSync(logsRoot)) return []
  return readdirSync(logsRoot).flatMap((segment) => lines(join(logsRoot, segment, `${TASK}.ndjson`)))
}

/** Normalize actual preparation refusals and saved run records into the shared observation. */
function observeEngineRun(
  runtimeDir: string,
  traces: RunTrace[],
  preparationError?: unknown,
  logSink?: Partial<LogSinkDeps>
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
  // Each step's time (`phase_time`) is a measurement only the Engine writes, never a round fact the corpus judges.
  const events = lines(join(runtimeDir, 'events.jsonl')).filter((event) => event.event !== 'phase_time')
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
    ...(logSink ? { logLines: recordedLogLines(logSink) } : {})
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
/**
 * One in-flight run: its first leg ends in the kind's in-flight state, `between` continues or ends it, and the
 * observation is taken once `between` returns. `inspect` runs after, while the run's files are still there.
 */
export function runInFlightEngineRun(
  kind: InFlightKind,
  agent: Agent,
  between: (run: InFlightEngineRun) => Promise<void>,
  inspect?: (run: EngineScenarioRun) => Promise<void> | void
): Promise<Observation> {
  return runEngineScenario(kind, agent, undefined, inspect, undefined, between)
}

export const ENGINE_SCENARIO_DRIVERS: Record<string, (agent: Agent) => Promise<Observation>> = Object.fromEntries(
  IDS.map((id) => [id, (agent: Agent) => runEngineScenario(id, agent)])
)
