import { fixtureDir } from '../../../apps/cli/tests/lib/test-temp-fixture'
import { recordedHandoff } from './handoff-fakes'
import { keepLogLocal, QUIET_FORGE_GATES, useRuntimeDir } from './round-fakes'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync, writeSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DEFAULT_REVIEW_POLICY, defaultControlStoreDeps } from '@attalabs/aeg-core'
import type { RunControl, SpawnedProcessLike } from '@atta/executor-agent-spawn'
import { fetchLoopHistory } from '../../../apps/cli/src/lib/dev-review-loop/journal-history'
import { heldVerdictPath } from '../../../apps/cli/src/lib/dev-review-loop/reviewer-dispatch'
import { createEffectExecutor, type EffectIdentity, sha256Hex } from '../../../apps/cli/src/lib/effects'
import { tasksExecutionRoot } from '../../../apps/cli/src/lib/run-paths'
import type { ActionRegistry, ProcessAction } from '../../../harness/dev-process/engine-runtime/run-process'
import type { GatePoll } from '../../../apps/cli/src/lib/dev-review-loop/gate-reading'
import { loadProcess } from '../../../harness/dev-process/loader/load-process'
import type { NodeLifecycle } from '../../../harness/dev-process/logging/translate'
import { createActions } from '../executing/actions'
import {
  type EngineForge,
  type EngineLifecycleOptions,
  liveDeveloperFacts,
  liveTaskInput,
  runEngine
} from '../bin/run-engine'

// An end-to-end replay of one task on the Engine path: the real packed Engine, the real runner
// (`runEngine`, `liveTaskInput`, `liveDeveloperFacts`), the real action bindings, the real adapters and the
// generated settings. Only the agent processes are replaced, by stdout recorded on live runs
// (fixtures/replay: Claude stream-json, Codex `exec --json`), and the forge, by the fake below. Git runs
// for real, on a temporary repository. The checks run a stand-in CLI at the repository's CLI entry.
//
// The fake forge keeps what it holds in a ledger file beside the run, so a leg started later in another process
// (the module run as a script) continues the same world. Each publication comment is posted through the shared
// effect executor with the identity the real publication gives it, the remote write landing in the ledger, so a
// leg that dies between the remote write and its local record reconciles it rather than posting it again.

const loaded = loadProcess(resolve(import.meta.dir, '..'))
const FIXTURES = join(import.meta.dir, 'fixtures', 'replay')
export const TASK = 4321
export const PR = 4242
const BRIEF = '# Frozen brief\nRewrite the one paragraph.\n\n**Revision:** abc'

export type Vendor = 'claude' | 'codex'
export type Step = 'develop' | 'code-review' | 'security-review'
const STEP_OF_ROLE: Record<string, Step> = {
  developer: 'develop',
  'code-reviewer': 'code-review',
  'security-reviewer': 'security-review'
}

export const records = (vendor: Vendor, step: Step): Record<string, unknown>[] =>
  readFileSync(join(FIXTURES, `${vendor}-${step}.jsonl`), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))

const isAgentMessage = (r: Record<string, unknown>) =>
  r.type === 'item.completed' && (r.item as { type: string }).type === 'agent_message'

/** The review a recorded reviewer stream ends with (Claude `structured_output`, Codex last `agent_message`). */
function reviewOf(vendor: Vendor, step: Step): { reviewResult: Record<string, unknown> } {
  const recs = records(vendor, step)
  if (vendor === 'claude') return recs.at(-1)?.structured_output as { reviewResult: Record<string, unknown> }
  const message = [...recs].reverse().find(isAgentMessage)
  if (message === undefined) throw new Error(`no agent_message in the ${vendor} ${step} fixture`)
  return JSON.parse((message.item as { text: string }).text)
}

/** The recorded stream with its final review replaced (a round's request-changes or a blocked review). */
function withReview(vendor: Vendor, step: Step, review: Record<string, unknown>): Record<string, unknown>[] {
  return withReviewIn(vendor, records(vendor, step), review)
}

function withReviewIn(
  vendor: Vendor,
  recs: Record<string, unknown>[],
  review: Record<string, unknown>
): Record<string, unknown>[] {
  if (vendor === 'claude')
    return [...recs.slice(0, -1), { ...recs.at(-1), structured_output: { reviewResult: review } }]
  const at = recs.length - 1 - [...recs].reverse().findIndex(isAgentMessage)
  const out = [...recs]
  out[at] = { ...recs[at], item: { ...(recs[at]?.item as object), text: JSON.stringify({ reviewResult: review }) } }
  return out
}
export const requestChanges = (vendor: Vendor) => ({
  ...reviewOf(vendor, 'code-review').reviewResult,
  status: 'completed',
  findings: [
    { severity: 'BLOCKER', file: 'docs/paragraph.md', line: 3, description: 'The paragraph still names the old gate.' }
  ]
})
export const blocked = (vendor: Vendor) => {
  const { findings: _f, objectiveResults: _o, ...rest } = reviewOf(vendor, 'code-review').reviewResult
  return {
    ...rest,
    status: 'blocked',
    blocker: { kind: 'scope_unclear', detail: 'The brief and the Surface disagree.' }
  }
}

/**
 * A reviewer's recorded stream bound to this run's review, as a live reviewer binds it: the role, head and
 * manifest digest its prompt names replace the ones the live run recorded.
 */
function boundToPrompt(vendor: Vendor, step: Step, recs: Record<string, unknown>[], prompt: string) {
  if (step === 'develop') return citingHandoff(vendor, recs, prompt)
  const binding = /headSha (\S+), and manifestDigest (\S+)\./.exec(prompt)
  if (binding === null) return recs
  const output =
    vendor === 'claude'
      ? (recs.at(-1) as { structured_output: { reviewResult: Record<string, unknown> } }).structured_output
      : (JSON.parse(([...recs].reverse().find(isAgentMessage) as { item: { text: string } }).item.text) as {
          reviewResult: Record<string, unknown>
        })
  const review = output.reviewResult
  return withReviewIn(vendor, recs, { ...review, headSha: binding[1], manifestDigest: binding[2] })
}

/** A Developer's recorded stream whose turn result cites every finding id its prompt hands over, as a live one does. */
function citingHandoff(vendor: Vendor, recs: Record<string, unknown>[], prompt: string): Record<string, unknown>[] {
  const ids = [...new Set([...prompt.matchAll(/^- (R\d+-(?:CR|SEC)-\d+)(?::|$)/gm)].map((m) => m[1]!))]
  if (ids.length === 0) return recs
  const cite = (output: { turnResult: Record<string, unknown> }) => ({
    turnResult: { ...output.turnResult, addressedFindingIds: ids }
  })
  if (vendor === 'claude') {
    const last = recs.at(-1) as { structured_output: { turnResult: Record<string, unknown> } }
    return [...recs.slice(0, -1), { ...last, structured_output: cite(last.structured_output) }]
  }
  const at = recs.length - 1 - [...recs].reverse().findIndex(isAgentMessage)
  const item = recs[at]?.item as { text: string }
  const out = [...recs]
  out[at] = { ...recs[at], item: { ...item, text: JSON.stringify(cite(JSON.parse(item.text))) } }
  return out
}

export function agent(
  lines: (prompt: string) => readonly Record<string, unknown>[],
  onPrompt: (prompt: string) => void,
  exitCode = 0
): SpawnedProcessLike {
  const close: Array<(code: number | null) => void> = []
  // Every reader gets every byte: the executor's own and the runner's driver-log tee.
  const stdout: Array<(chunk: string) => void> = []
  let prompt = ''
  return {
    stdin: {
      write: (chunk: string) => {
        prompt += String(chunk)
        return true
      },
      end: () => {
        onPrompt(prompt)
        setTimeout(() => {
          const text = `${lines(prompt)
            .map((line) => JSON.stringify(line))
            .join('\n')}\n`
          for (const listener of stdout) listener(text)
          for (const listener of close) listener(exitCode)
        }, 0)
      }
    },
    stdout: {
      on: (_event: string, listener: unknown) => {
        stdout.push(listener as (chunk: string) => void)
      }
    },
    stderr: { on: () => {} },
    on: ((event: string, listener: (code: number | null) => void) => {
      if (event === 'close') close.push(listener)
    }) as SpawnedProcessLike['on'],
    kill: () => {}
  } as unknown as SpawnedProcessLike
}

export const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=r', '-c', 'user.email=r@r', ...args], { cwd, encoding: 'utf8' }).trim()

// The stand-in CLI at `<repo>/apps/cli/src/index.ts`: records each call's argv, cwd and PR environment, and
// exits with the next code in `gate-codes.json` (the last repeats).
const FAKE_CLI = `
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const dir = ${JSON.stringify('__DIR__')}
appendFileSync(join(dir, 'cli-calls.jsonl'), JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), pr: process.env.PR_NUMBER ?? null, branch: process.env.BRANCH ?? null }) + '\\n')
const codes = JSON.parse(readFileSync(join(dir, 'gate-codes.json'), 'utf8'))
const code = codes.length > 1 ? codes.shift() : codes[0]
writeFileSync(join(dir, 'gate-codes.json'), JSON.stringify(codes))
process.stdout.write(code === 0 ? 'all checks pass\\n' : '✗ closes-n: fail\\n')
process.exit(code)
`

/** The repository and runtime directory one replayed task lives in, kept across the legs that run it. */
export interface World {
  root: string
  runtimeDir: string
  /** The repository's entries before the first leg ran. */
  before: string[]
}

/** One comment the fake forge holds: the effect key it was posted under, its target and its body's digest. */
export interface ForgeComment {
  key: string
  target: string
  payloadDigest: string
}

/** What the fake forge holds, kept in a file so a leg in another process sees what an earlier one did. */
export interface ForgeLedger {
  prOpen: boolean
  /** Each step's agent launches so far. */
  launches: Record<Step, number>
  forgeCalls: string[]
  published: Array<{ round: number; prNumber: number; expectedHead: string; heldFound: boolean }>
  /** Every publication comment the forge accepted, in order; a repeated one is a duplicate effect. */
  comments: ForgeComment[]
  /** Every Engine lifecycle event of every leg, in order. */
  nodeEvents: Array<{ type: string; nodeId: string; pid: number }>
}

const ledgerPath = (runtimeDir: string): string => join(runtimeDir, 'forge-ledger.json')

export function readLedger(runtimeDir: string): ForgeLedger {
  const path = ledgerPath(runtimeDir)
  if (!existsSync(path))
    return {
      prOpen: false,
      launches: { develop: 0, 'code-review': 0, 'security-review': 0 },
      forgeCalls: [],
      published: [],
      comments: [],
      nodeEvents: []
    }
  return JSON.parse(readFileSync(path, 'utf8')) as ForgeLedger
}

/** Changes the ledger and writes it back at once, so a leg killed right after a change still leaves it recorded. */
function updateLedger(runtimeDir: string, change: (ledger: ForgeLedger) => void): ForgeLedger {
  const ledger = readLedger(runtimeDir)
  change(ledger)
  writeFileSync(ledgerPath(runtimeDir), JSON.stringify(ledger))
  return ledger
}

/** Creates the temporary repository and runtime directory a task is replayed in. */
export function createWorld(gates: number[] = [0]): World {
  const root = realpathSync(fixtureDir('replay-repo-'))
  const runtimeDir = realpathSync(fixtureDir('replay-runtime-'))
  const cliDir = join(root, 'apps', 'cli', 'src')
  mkdirSync(cliDir, { recursive: true })
  writeFileSync(join(cliDir, 'index.ts'), FAKE_CLI.replace('__DIR__', runtimeDir))
  writeFileSync(join(runtimeDir, 'gate-codes.json'), JSON.stringify(gates))
  writeFileSync(join(root, 'docs.md'), 'old paragraph\n')
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'base')
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  return { root, runtimeDir, before: readdirSync(root).sort() }
}

/** The three comments a publication posts, in order, each an effect of its own. */
export const PUBLICATION_EFFECTS = ['reviewer-verdict', 'security-verdict', 'published-marker'] as const

/** Where around one publication comment a boundary is: before the remote write, after it but before its local record, after both. */
export const EFFECT_PHASES = ['before-commit', 'after-remote', 'after-acknowledgement'] as const

export interface Scenario {
  vendor: Vendor
  gates?: number[]
  /** The code reviewer's review per round; absent rounds replay the recorded review. */
  codeReview?: Record<number, Record<string, unknown>>
  /** Continues in a world an earlier leg ran in; absent, a new one is created. */
  world?: World
  /**
   * Told each boundary the run reaches, before what follows it happens: `node:<id>` as a step is entered (every step
   * before it is checkpointed), `effect:<round>-<comment>:<phase>` around each publication comment.
   */
  boundary?: (name: string) => void
  /** Replaces a step's nth launch (from 1) with these records and exit code; absent, the recorded stream exits 0. */
  launch?: (step: Step, attempt: number) => { records: Record<string, unknown>[]; exitCode: number } | undefined
  /** How long each publication comment's remote write takes, as a slow forge's would. */
  forgeLatencyMs?: number
  /** How the forge answers each remote write: `lost-reply` accepts the comment and loses the reply to it. */
  forgeReply?: (comment: ForgeComment, attempt: number) => 'ok' | 'lost-reply'
  /** Whether the forge's comments can be read back when an interrupted write is reconciled; absent, they can. */
  forgeReadable?: () => boolean
  /** Replaces these forge reads and writes. */
  forge?: Partial<EngineForge>
  /** The forge-gate steps' poll budget; absent, the standalone loop's. */
  gatePoll?: GatePoll
  /** Wraps each step's action, as a fault that delivers it differently would. */
  wrapAction?: (name: string, action: ProcessAction) => ProcessAction
  /** The run's control, so a scenario can halt the run at a boundary. */
  control?: RunControl
  /** The runner's lifecycle; absent, the replay's defaults. */
  lifecycle?: EngineLifecycleOptions
}

/** The body of the publication marker comment for `round` at `head`. */
const markerBody = (round: number, head: string) => `<!-- vinaya:published round=${round} head=${head} -->`

export async function replay(scenario: Scenario) {
  const world = scenario.world ?? createWorld(scenario.gates ?? [0])
  const { root, runtimeDir, before } = world
  const boundary = scenario.boundary ?? (() => {})

  const forgeCalls: string[] = []
  const published: ForgeLedger['published'] = []
  const reviewIds = (reviewOf(scenario.vendor, 'code-review').reviewResult.objectiveResults as { id: string }[]).map(
    (o) => o.id
  )
  const objectives = reviewIds.map((id) => ({ id, text: `objective ${id}` }))
  const branch = `task/issue-${TASK}`
  const worktree = join(root, '.worktrees', branch)
  const forgeCall = (call: string): void => {
    forgeCalls.push(call)
    updateLedger(runtimeDir, (ledger) => void ledger.forgeCalls.push(call))
  }
  // The publication's forge writes: each comment through the shared effect executor, keyed and identified as the
  // real publication's are, its remote write recorded in the ledger before the forge's reply is returned.
  const postComments = (round: number, prNumber: number, expectedHead: string): void => {
    const store = defaultControlStoreDeps(() => tasksExecutionRoot(runtimeDir))
    const bodies: Record<(typeof PUBLICATION_EFFECTS)[number], string> = {
      'reviewer-verdict': readFileSync(heldVerdictPath(runtimeDir, TASK, round, 'reviewer'), 'utf8'),
      'security-verdict': readFileSync(heldVerdictPath(runtimeDir, TASK, round, 'security'), 'utf8'),
      'published-marker': markerBody(round, expectedHead)
    }
    for (const effect of PUBLICATION_EFFECTS) {
      const key = `${round}-${effect}`
      const identity: EffectIdentity = {
        operation: 'pr-comment',
        target: `pr:${prNumber}`,
        inputVersion: round,
        payloadDigest: sha256Hex(bodies[effect])
      }
      const comment: ForgeComment = { key, target: identity.target, payloadDigest: identity.payloadDigest }
      const holds = (c: ForgeComment) =>
        c.key === comment.key && c.target === comment.target && c.payloadDigest === comment.payloadDigest
      const executor = createEffectExecutor(store, TASK, `replay:${TASK}:${key}`, () => {})
      let attempts = 0
      executor.execute({
        key,
        identity,
        poster: () => {
          boundary(`effect:${key}:before-commit`)
          attempts += 1
          if (scenario.forgeLatencyMs)
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, scenario.forgeLatencyMs)
          updateLedger(runtimeDir, (ledger) => void ledger.comments.push(comment))
          boundary(`effect:${key}:after-remote`)
          if (scenario.forgeReply?.(comment, attempts) === 'lost-reply')
            throw new Error(`the forge accepted ${key} but its reply was lost`)
          return `https://example.invalid/pr/${prNumber}#${key}`
        },
        reconcile: () => {
          if (scenario.forgeReadable?.() === false)
            return { outcome: 'ambiguous', reason: 'the forge could not be read' }
          return readLedger(runtimeDir).comments.some(holds)
            ? { outcome: 'confirmed', url: `https://example.invalid/pr/${prNumber}#${key}` }
            : { outcome: 'absent' }
        }
      })
      boundary(`effect:${key}:after-acknowledgement`)
    }
  }
  const forge: Partial<EngineForge> = {
    checkTaskDispatchReadiness: (b) => {
      forgeCall(`readiness ${b}`)
      return { ready: true, output: 'ready' } as never
    },
    createTaskWorktree: (b) => {
      forgeCall(`worktree ${b}`)
      // A leg that runs the step again finds the worktree an earlier leg made.
      if (existsSync(worktree)) return
      git(root, 'worktree', 'add', '-q', '-b', b, join('.worktrees', b))
      writeFileSync(join(worktree, 'docs.md'), 'new paragraph\n')
      git(worktree, 'commit', '-q', '-am', 'Docs: rewrite the paragraph')
      // Unpublished work the Developer left: the kept-work note names it.
      writeFileSync(join(worktree, 'notes.md'), 'draft\n')
    },
    // The Developer opens the pull request: none exists before its first launch.
    findOpenPrForBranch: () => (readLedger(runtimeDir).prOpen ? ({ number: PR } as never) : null),
    fetchFrozenBrief: () => BRIEF,
    resolveIssueObjectives: () =>
      ({ text: objectives.map((o) => `${o.id}. ${o.text}`).join('\n'), objectives, version: 'v1' }) as never,
    fetchNewestRulingOrdinal: () => 0,
    fetchNewestIssueRulingOrdinal: () => 0,
    fetchSourceRevision: () => 'abc',
    fetchCiConclusion: () => 'green',
    ...QUIET_FORGE_GATES,
    fetchIssueRulingsAfterBrief: () => [],
    fetchRulings: () => [],
    fetchLoopHistory: () => fetchLoopHistory(null),
    resolveHead: () => git(worktree, 'rev-parse', 'HEAD'),
    resolveDeveloperDoctrineText: async () => 'DEVELOPER DOCTRINE (replay)',
    prBody: () => `Closes #${TASK}`,
    pullRequestView: () => ({ number: PR, body: `Closes #${TASK}`, headRefOid: 'head', state: 'OPEN' }),
    publishRound: (publishRoot, input) => {
      forgeCall(`publish round ${input.round}`)
      const held = (['reviewer', 'security'] as const).every((role) =>
        existsSync(heldVerdictPath(publishRoot, TASK, input.round, role))
      )
      if (held) postComments(input.round, input.prNumber, input.expectedHead)
      const entry = { round: input.round, prNumber: input.prNumber, expectedHead: input.expectedHead, heldFound: held }
      published.push(entry)
      updateLedger(runtimeDir, (ledger) => void ledger.published.push(entry))
    },
    ...scenario.forge
  }
  const policy = () => ({ ...DEFAULT_REVIEW_POLICY, maxRounds: 4, maxTaskMinutes: 0 })
  const args = { task: TASK, agent: scenario.vendor, dryRun: false } as const
  const taskInput = await liveTaskInput(args, root, runtimeDir, 'replay-loop', {
    fetchTitle: () => 'A backlog task',
    fetchLabels: () => [],
    policy,
    forge
  })
  // The fixture repository has no installed hooks and no sandbox to probe; the preparation controls have their own tests.
  // It configures no security scan either, so the scan step never reads the trust anchor from the forge.
  taskInput.bound = {
    ...taskInput.bound,
    localGateControl: () => ({ control: 'local-gate', active: true, detail: '', remedy: '' }),
    probeAgentSandbox: async () => ({ ok: true }),
    resolveSecurityScanCommand: () => null
  }

  const spawns: Array<{ step: Step; args: string[]; env: Record<string, string | undefined>; prompt: string }> = []
  const events: Array<{ event?: string; kind?: string }> = []
  const handoff = recordedHandoff()
  let developerTurnsBegun = 0
  const developerTurnsCompleted: Array<string | null> = []
  if (scenario.gatePoll) taskInput.gatePoll = scenario.gatePoll
  // Each step is entered through its boundary, after a turn of the event loop so the checkpoint of every step
  // before it has been written.
  const steps = createActions(taskInput)
  const actions: ActionRegistry | undefined =
    scenario.boundary || scenario.wrapAction
      ? Object.fromEntries(
          Object.entries(steps).map(([name, action]) => {
            const delivered = scenario.wrapAction?.(name, action) ?? action
            return [
              name,
              async (context: Parameters<typeof action>[0]) => {
                await new Promise((resolve) => setTimeout(resolve, 0))
                boundary(`node:${context.nodeId}`)
                return delivered(context)
              }
            ]
          })
        )
      : undefined
  const result = await runEngine({
    ...(actions ? { actions } : {}),
    ...(scenario.lifecycle ? { lifecycle: scenario.lifecycle } : {}),
    ...(scenario.control ? { control: scenario.control } : {}),
    observe: (event: NodeLifecycle) => {
      if (event.type !== 'node:start' && event.type !== 'node:complete') return
      updateLedger(
        runtimeDir,
        (ledger) => void ledger.nodeEvents.push({ type: event.type, nodeId: event.nodeId, pid: process.pid })
      )
    },
    beginDeveloperTurn: async () => {
      developerTurnsBegun += 1
    },
    completeDeveloperTurn: (resumeId) => {
      developerTurnsCompleted.push(resumeId)
    },
    args,
    process: loaded,
    repoRoot: root,
    cliRoot: VINAYA_INSTALL,
    runtimeDir,
    loopId: 'replay-loop',
    taskInput,
    handoffDeps: handoff.deps,
    sink: { log: (event: never) => void events.push(event), drain: async () => {} },
    startHost: async () => ({ close: async () => {} }),
    devToolsContext: {} as never,
    out: () => {},
    developerFacts: liveDeveloperFacts({
      forge,
      policy,
      task: TASK,
      repoRoot: root,
      runtimeDir,
      branch,
      worktreePath: worktree,
      round: taskInput.reviewRound
    }),
    spawnFn: ((_command: string, spawnArgs: string[], options: { env?: Record<string, string | undefined> }) => {
      // Claude names its role's generated settings, Codex its role's output schema.
      const role = Object.keys(STEP_OF_ROLE).find((name) => spawnArgs.join(' ').includes(`/${name}/`))
      const step = STEP_OF_ROLE[role ?? ''] as Step
      boundary(`node:${step}`)
      const { launches } = updateLedger(runtimeDir, (ledger) => {
        ledger.launches[step] += 1
        if (step === 'develop') ledger.prOpen = true
      })
      const attempt = launches[step]
      // A later Developer turn publishes its fix as a new head, as a live one does.
      if (step === 'develop' && attempt > 1) {
        writeFileSync(join(worktree, 'docs.md'), `new paragraph, revision ${attempt}\n`)
        git(worktree, 'commit', '-q', '-am', `Docs: revise the paragraph (${attempt})`)
      }
      const entry = { step, args: [...spawnArgs], env: options?.env ?? {}, prompt: '' }
      spawns.push(entry)
      const replaced = scenario.launch?.(step, attempt)
      if (replaced)
        return agent(
          () => replaced.records,
          (prompt) => {
            entry.prompt = prompt
          },
          replaced.exitCode
        )
      const review = step === 'code-review' ? scenario.codeReview?.[attempt] : undefined
      const lines = review ? withReview(scenario.vendor, step, review) : records(scenario.vendor, step)
      return agent(
        (prompt) => boundToPrompt(scenario.vendor, step, lines, prompt),
        (prompt) => {
          entry.prompt = prompt
        }
      )
    }) as never
  })
  const cliCalls = existsSync(join(runtimeDir, 'cli-calls.jsonl'))
    ? readFileSync(join(runtimeDir, 'cli-calls.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { args: string[]; cwd: string; pr: string | null; branch: string | null })
    : []
  const trace = JSON.parse(readFileSync(result.tracePath, 'utf8')) as {
    outcome: string
    error?: string
    pauseReason?: string
  }
  return {
    root,
    runtimeDir,
    worktree,
    before,
    result,
    trace,
    spawns,
    forgeCalls,
    published,
    cliCalls,
    events,
    handoff,
    developerTurnsBegun,
    developerTurnsCompleted,
    world,
    ledger: readLedger(runtimeDir)
  }
}

/** A Vinaya install that is not the task's repository, as when Vinaya is adopted elsewhere. */
export const VINAYA_INSTALL = '/opt/vinaya-install'

// --- run as a script: one leg of a replayed task, in a runner process of its own ------------------

/** What a leg run as a script is told, as its one argument: the world it continues, and the boundary it stops at. */
export interface LegRequest {
  vendor: Vendor
  world: World
  /** The boundary at which the leg announces itself on stdout and then waits, never returning, to be killed. */
  holdAt?: string
}

/** The line a held leg writes, synchronously, before it waits at its boundary. */
export const HELD_AT = 'HELD AT '
/** The line a leg that ran to its end writes, with the outcome its trace records. */
export const LEG_ENDED = 'LEG ENDED '

if (import.meta.main) {
  const request = JSON.parse(process.argv[2] ?? '{}') as LegRequest
  useRuntimeDir(request.world.runtimeDir)
  keepLogLocal()
  const run = await replay({
    vendor: request.vendor,
    world: request.world,
    boundary: (name) => {
      if (name !== request.holdAt) return
      writeSync(1, `${HELD_AT}${name}\n`)
      for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)
    }
  })
  writeSync(1, `${LEG_ENDED}${JSON.stringify({ outcome: run.trace.outcome, exitCode: run.result.exitCode })}\n`)
  process.exit(0)
}
