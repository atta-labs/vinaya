import { recordedHandoff } from './handoff-fakes'
import { QUIET_FORGE_GATES } from './round-fakes'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DEFAULT_REVIEW_POLICY } from '@attalabs/aeg-core'
import type { SpawnedProcessLike } from '@atta/executor-agent-spawn'
import { fetchLoopHistory } from '../../../apps/cli/src/lib/dev-review-loop/journal-history'
import { heldVerdictPath } from '../../../apps/cli/src/lib/dev-review-loop/reviewer-dispatch'
import { loadProcess } from '../../../harness/dev-process/loader/load-process'
import { type EngineForge, liveDeveloperFacts, liveTaskInput, runEngine } from '../bin/run-engine'

// An end-to-end replay of one task on the Engine path: the real packed Engine, the real runner
// (`runEngine`, `liveTaskInput`, `liveDeveloperFacts`), the real action bindings, the real adapters and the
// generated settings. Only the agent processes are replaced, by stdout recorded on live runs
// (fixtures/replay: Claude stream-json, Codex `exec --json`), and the forge, by the fake below. Git runs
// for real, on a temporary repository. The checks run a stand-in CLI at the repository's CLI entry.

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
  onPrompt: (prompt: string) => void
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
          for (const listener of close) listener(0)
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

export interface Scenario {
  vendor: Vendor
  gates?: number[]
  /** The code reviewer's review per round; absent rounds replay the recorded review. */
  codeReview?: Record<number, Record<string, unknown>>
}

export async function replay(scenario: Scenario) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'replay-repo-')))
  const runtimeDir = realpathSync(mkdtempSync(join(tmpdir(), 'replay-runtime-')))
  const cliDir = join(root, 'apps', 'cli', 'src')
  mkdirSync(cliDir, { recursive: true })
  writeFileSync(join(cliDir, 'index.ts'), FAKE_CLI.replace('__DIR__', runtimeDir))
  writeFileSync(join(runtimeDir, 'gate-codes.json'), JSON.stringify(scenario.gates ?? [0]))
  writeFileSync(join(root, 'docs.md'), 'old paragraph\n')
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'base')
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  const before = readdirSync(root).sort()

  const forgeCalls: string[] = []
  const published: Array<{ round: number; prNumber: number; expectedHead: string; heldFound: boolean }> = []
  const reviewIds = (reviewOf(scenario.vendor, 'code-review').reviewResult.objectiveResults as { id: string }[]).map(
    (o) => o.id
  )
  const objectives = reviewIds.map((id) => ({ id, text: `objective ${id}` }))
  const branch = `task/issue-${TASK}`
  const worktree = join(root, '.worktrees', branch)
  // The Developer opens the pull request: none exists before its first launch.
  let prOpen = false
  const forge: Partial<EngineForge> = {
    checkTaskDispatchReadiness: (b) => {
      forgeCalls.push(`readiness ${b}`)
      return { ready: true, output: 'ready' } as never
    },
    createTaskWorktree: (b) => {
      forgeCalls.push(`worktree ${b}`)
      git(root, 'worktree', 'add', '-q', '-b', b, join('.worktrees', b))
      writeFileSync(join(worktree, 'docs.md'), 'new paragraph\n')
      git(worktree, 'commit', '-q', '-am', 'Docs: rewrite the paragraph')
      // Unpublished work the Developer left: the kept-work note names it.
      writeFileSync(join(worktree, 'notes.md'), 'draft\n')
    },
    findOpenPrForBranch: () => (prOpen ? ({ number: PR } as never) : null),
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
      forgeCalls.push(`publish round ${input.round}`)
      const held = (['reviewer', 'security'] as const).every((role) =>
        existsSync(heldVerdictPath(publishRoot, TASK, input.round, role))
      )
      published.push({
        round: input.round,
        prNumber: input.prNumber,
        expectedHead: input.expectedHead,
        heldFound: held
      })
    }
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
  taskInput.bound = {
    ...taskInput.bound,
    localGateControl: () => ({ control: 'local-gate', active: true, detail: '', remedy: '' }),
    probeAgentSandbox: async () => ({ ok: true })
  }

  const spawns: Array<{ step: Step; args: string[]; env: Record<string, string | undefined>; prompt: string }> = []
  const rounds: Record<Step, number> = { develop: 0, 'code-review': 0, 'security-review': 0 }
  const events: Array<{ event?: string; kind?: string }> = []
  const handoff = recordedHandoff()
  let developerTurnsBegun = 0
  const developerTurnsCompleted: Array<string | null> = []
  const result = await runEngine({
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
      rounds[step] += 1
      if (step === 'develop') prOpen = true
      // A later Developer turn publishes its fix as a new head, as a live one does.
      if (step === 'develop' && rounds.develop > 1) {
        writeFileSync(join(worktree, 'docs.md'), `new paragraph, revision ${rounds.develop}\n`)
        git(worktree, 'commit', '-q', '-am', `Docs: revise the paragraph (${rounds.develop})`)
      }
      const entry = { step, args: [...spawnArgs], env: options?.env ?? {}, prompt: '' }
      spawns.push(entry)
      const review = step === 'code-review' ? scenario.codeReview?.[rounds[step]] : undefined
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
    developerTurnsCompleted
  }
}

/** A Vinaya install that is not the task's repository, as when Vinaya is adopted elsewhere. */
export const VINAYA_INSTALL = '/opt/vinaya-install'
