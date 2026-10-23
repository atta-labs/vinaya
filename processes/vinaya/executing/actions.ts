import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  assessRound,
  type LoopState,
  type Observations,
  type ReviewInputManifest,
  type TaskClock,
  type VerdictObservation
} from '@attalabs/aeg-core'
import type { StepNodeResult } from '@atta/executor-agent-spawn'
import { generateClaudeSettings } from '../../../harness/adapters/agents/claude-code/settings'
import { generateCodexConfig } from '../../../harness/adapters/agents/codex/config'
import { loadRoleGrants, ROLE_NAMES, withModel } from '../../../harness/adapters/agents/manifest'
import { structuredResult } from '../../../harness/adapters/agents/structured-result'
import { pullRequestCheckEnv, type PullRequestView } from './pull-request-env'
import type { Handoff, InputVersions } from './handoff'
import { runCliChecks } from '../../../harness/gates/run-checks'
import type { GeneratedAgentConfig, GeneratorPaths } from '../../../harness/adapters/agents/policy'
import {
  createRoleLauncher,
  type ActionContext,
  type ActionRegistry,
  type DecisionRegistry,
  type ProcessAction,
  type RoleLauncher
} from '../../../harness/dev-process/engine-runtime/run-process'
import {
  checkTaskDispatchReadiness,
  createTaskWorktree,
  fetchSourceRevision,
  findOpenPrForBranch
} from '../../../apps/cli/src/lib/dev-review-loop/developer-dispatch'
import { publishRound, type PublishInput } from '../../../apps/cli/src/lib/dev-review-loop/publication'
import { handoffFindings } from '../../../apps/cli/src/lib/dev-review-loop'
import { readWorktreeHead } from '../../../apps/cli/src/lib/dev-review-loop/gate-reading'
import { writeHeldVerdict } from '../../../apps/cli/src/lib/dev-review-loop/reviewer-dispatch'
import {
  parseDeveloperTurnResult,
  type DeveloperTurnSchemaContext
} from '../../../apps/cli/src/lib/developer-turn-result'
import { parseReviewResult, type ReviewResult } from '../../../apps/cli/src/lib/review-result'

// The mechanical actions, decisions and role launchers of the developer
// review Flow. Each action adapts one function the review loop already
// has; the adaptation here is only argument and result shaping, exercised
// with stubs.

/** What the bound functions need that the recorded step results cannot supply. */
export interface TaskInput {
  /** The runtime directory run files go under (`<runtimeDir>/tasks-execution/<task>/…`), never the repository. */
  runtimeDir: string
  /** The CLI entry script whose `check --all` the gate step runs. */
  cliEntry: string
  branch: string
  issueNumber: number
  worktreePath: string
  developerContext: DeveloperTurnSchemaContext
  /** The loop state the first `assessRound` starts from; later assessments start from the previous assessment's recorded state. */
  loopState: LoopState
  clock?: TaskClock
  /** The round's review round number, as `handoffFindings` counts it. */
  reviewRound: () => number
  /** Moves the review round forward to `round` (never back), for a run that continues rounds the forge already holds. */
  seedRound?: (round: number) => void
  /** The review-input manifest of the task head as it stands now, or null when it cannot be built. */
  currentManifest?: () => ReviewInputManifest | null
  /** What the round's gate and verdicts amount to, read from the recorded results. */
  observe: (results: Readonly<Record<string, StepNodeResult>>) => Observations
  /** The reviewer prompt for `role`, built over this round's staged candidate (absent in stub runs). */
  reviewerPrompt?: (role: 'reviewer' | 'security') => string
  /** The reviewers' verdicts for the round, read from the recorded results. */
  verdicts: (results: Readonly<Record<string, StepNodeResult>>) => readonly VerdictObservation[]
  /**
   * The `publishRound` input for the pull request and judged head found when the step runs: the
   * pull request does not exist when the task starts, and the head moves with every revision.
   */
  publish: (at: PublishTarget) => PublishInput
  /** Renders one reviewer's validated result as the comment text held for publication. */
  renderVerdict: (role: HeldVerdictRole, review: ReviewResult) => string
  /** Replacements for the forge and filesystem functions the actions call, for a run that must not reach them. */
  bound?: Partial<BoundFunctions>
  /** The one function every pausing exit calls; the runner supplies it, bound to its run control. */
  handoff?: Handoff
  /** The brief, objectives, ruling and policy versions an escalation record binds its ruling to; throws when they cannot be read. */
  inputVersions?: () => InputVersions
}

/** What only the moment of publication knows. */
export interface PublishTarget {
  prNumber: number
  expectedHead: string
  round: number
}

export type HeldVerdictRole = 'reviewer' | 'security'

/** The functions whose results depend on state that changes during the run. */
export interface BoundFunctions {
  checkTaskDispatchReadiness: typeof checkTaskDispatchReadiness
  createTaskWorktree: typeof createTaskWorktree
  fetchSourceRevision: typeof fetchSourceRevision
  /** Reads the branch's pull request for the checks' environment (`pullRequestCheckEnv`). */
  pullRequestView: (branch: string) => PullRequestView
  findOpenPrForBranch: typeof findOpenPrForBranch
  readWorktreeHead: typeof readWorktreeHead
  writeHeldVerdict: typeof writeHeldVerdict
  publishRound: typeof publishRound
}

interface Binding {
  /** The functions this action adapts, by identity. */
  adapts: readonly ((...args: never[]) => unknown)[]
  build: (task: TaskInput) => ProcessAction
}

/**
 * The gate observation for `round`, read from the recorded gate step's result (green when it exited zero,
 * its wall time) and the task worktree's diff against main, with the Developer's stated confidence.
 * Throws when the gate step has no recorded result, or recorded a red one: the Flow reaches the
 * assessment only after a green gate, so a red one here is a wiring fault, never a judgement.
 */
export function gateObservation(
  worktreePath: string,
  round: number,
  results: Readonly<Record<string, StepNodeResult>>
): Observations {
  const gate = results['run-mechanical-gates']
  if (!gate) throw new Error('assess-round found no recorded result for the gate step run-mechanical-gates')
  const green = gate.exitCode === 0
  if (!green) throw new Error(`assess-round reached after a red gate (run-mechanical-gates exited ${gate.exitCode})`)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: worktreePath, encoding: 'utf8' }).trim()
  const head = git('rev-parse', 'HEAD')
  const baseHead = git('merge-base', 'origin/main', head)
  const short = git('diff', '--shortstat', baseHead, head)
  const count = (pattern: RegExp) => Number(pattern.exec(short)?.[1] ?? 0)
  const turn = agentOutput(results, 'develop') as {
    turnResult?: { confidence?: number; confidenceExplanation?: string }
  }
  const value = turn?.turnResult?.confidence
  return {
    kind: 'gate',
    round,
    green,
    confidence: typeof value === 'number' ? { value, reason: turn.turnResult?.confidenceExplanation } : 'absent',
    stats: {
      baseHead,
      head,
      filesChanged: count(/(\d+) files? changed/),
      insertions: count(/(\d+) insertions?/),
      deletions: count(/(\d+) deletions?/),
      wallMs: gate.kind === 'mechanical' ? gate.durationMs : 0
    }
  }
}

const MAP_TAG = '__map'

/** Loop state as JSON: its maps travel as tagged entry lists, the only part JSON cannot carry. */
export function encodeLoopState(state: LoopState): string {
  return JSON.stringify(state, (_key, value) => (value instanceof Map ? { [MAP_TAG]: [...value.entries()] } : value))
}

export function decodeLoopState(text: string): LoopState {
  return JSON.parse(text, (_key, value) =>
    value !== null && typeof value === 'object' && Array.isArray((value as Record<string, unknown>)[MAP_TAG])
      ? new Map((value as Record<string, [unknown, unknown][]>)[MAP_TAG])
      : value
  ) as LoopState
}

/**
 * The loop state the next assessment starts from: the state recorded in the previous assessment's step result,
 * or `initial` before any assessment ran. The recorded state is the checkpointed one, so a resumed run carries it
 * forward; a round number below `initial`'s never replaces it. A recorded result with no readable state throws,
 * since falling back to `initial` would silently restart the round count.
 */
export function carriedLoopState(results: Readonly<Record<string, StepNodeResult>>, initial: LoopState): LoopState {
  const previous = results['assess-round']
  if (!previous || !('stdout' in previous)) return initial
  let recorded: LoopState | undefined
  try {
    const parsed = JSON.parse(String(previous.stdout)) as { state?: unknown }
    if (parsed.state !== undefined) recorded = decodeLoopState(JSON.stringify(parsed.state))
  } catch {
    // Reported below with the rest of the unreadable cases.
  }
  if (!recorded) throw new Error('assess-round found a previous assessment result with no readable loop state')
  return roundOf(recorded) < roundOf(initial) ? initial : recorded
}

const roundOf = (state: LoopState): number => Math.max(state.rounds.length, state.pending?.round ?? 0)

const ok = (stdout = ''): { exitCode: number; stdout: string } => ({ exitCode: 0, stdout })

/** The final structured record an agent step reported, or undefined for a step that is not one. */
export function agentOutput(results: Readonly<Record<string, StepNodeResult>>, step: string): unknown {
  const result = results[step]
  if (result?.kind !== 'agent-spawn') return undefined
  return structuredResult(result.events)
}

/** The gate step's recorded exit result is red when it did not exit zero. */
export function isGateRed(examined: StepNodeResult): boolean {
  return examined.exitCode !== 0
}

/** The reconcile step's exit code when no pull request is open for the branch yet. */
export const EXIT_NO_OPEN_PR = 0
/** The reconcile step's exit code when a pull request is already open for the branch. */
export const EXIT_OPEN_PR = 1

/** The start decision's predicate: the Developer is due only when the reconcile step found no open pull request. */
export function isDevelopmentDue(examined: StepNodeResult): boolean {
  return examined.exitCode === EXIT_NO_OPEN_PR
}

/** The assessment step's recorded exit result asks for a revision when it did not exit zero. */
export function isRevisionRequested(examined: StepNodeResult): boolean {
  return examined.exitCode !== 0
}

/** Records whether the gate step ended red; the decision on this step reads the gate's own exit result. */
export function classifyGateResult(context: ActionContext): { exitCode: number; stdout: string } {
  const gate = context.results['run-mechanical-gates']
  if (!gate) throw new Error('classify-gate-result ran before the gate step recorded a result')
  return ok(isGateRed(gate) ? 'red' : 'green')
}

/** Records that both reviewers are due; the reviewer steps themselves launch after this one. */
export function dispatchReviewers(): { exitCode: number; stdout: string } {
  return ok('code-review,security-review')
}

export const ACTION_BINDINGS: Readonly<Record<string, Binding>> = {
  'vinaya.prepare-run': {
    adapts: [checkTaskDispatchReadiness, createTaskWorktree],
    build: (task) => () => {
      const readiness = (task.bound?.checkTaskDispatchReadiness ?? checkTaskDispatchReadiness)(task.branch)
      if (!readiness.ready) return { exitCode: 1, stdout: readiness.output }
      ;(task.bound?.createTaskWorktree ?? createTaskWorktree)(task.branch)
      return ok(readiness.output)
    }
  },
  'vinaya.reconcile-external-state': {
    adapts: [findOpenPrForBranch],
    build: (task) => () => {
      const open = (task.bound?.findOpenPrForBranch ?? findOpenPrForBranch)(task.branch)
      // The exit code is what the start decision reads: zero when no pull request is open yet.
      return { exitCode: open === null ? EXIT_NO_OPEN_PR : EXIT_OPEN_PR, stdout: JSON.stringify(open) }
    }
  },
  // The branch point itself is the Flow's decision on the reconcile step's result; this step records that it ran.
  'vinaya.choose-start': { adapts: [], build: () => () => ok() },
  'vinaya.prepare-sources': {
    adapts: [fetchSourceRevision],
    build: (task) => () => ok((task.bound?.fetchSourceRevision ?? fetchSourceRevision)(task.issueNumber))
  },
  'vinaya.validate-developer-output': {
    adapts: [parseDeveloperTurnResult],
    build: (task) => (context) => {
      const validation = parseDeveloperTurnResult(agentOutput(context.results, 'develop'), task.developerContext)
      // The Flow has no human-handoff step, so an invalid turn ends the run as failed.
      if (!validation.ok)
        throw new Error(`Developer output failed ${validation.stage} validation: ${validation.errors.join('; ')}`)
      return ok()
    }
  },
  'harness.run-gates': {
    adapts: [runCliChecks],
    build: (task) => async () => {
      const gates = await runCliChecks(
        task.cliEntry,
        task.worktreePath,
        pullRequestCheckEnv(task.branch, task.bound?.pullRequestView)
      )
      return { exitCode: gates.passed ? 0 : 1, stdout: gates.output }
    }
  },
  'vinaya.classify-gate-result': { adapts: [classifyGateResult], build: () => classifyGateResult },
  'vinaya.dispatch-reviewers': { adapts: [dispatchReviewers], build: () => dispatchReviewers },
  'vinaya.validate-reviewer-outputs': {
    adapts: [parseReviewResult, writeHeldVerdict],
    build: (task) => (context) => {
      const write = task.bound?.writeHeldVerdict ?? writeHeldVerdict
      const held: Array<[HeldVerdictRole, ReviewResult]> = []
      for (const [step, role] of [
        ['code-review', 'reviewer'],
        ['security-review', 'security']
      ] as const) {
        const validation = parseReviewResult(agentOutput(context.results, step))
        if (!validation.ok)
          throw new Error(`${step} output failed ${validation.stage} validation: ${validation.errors.join('; ')}`)
        held.push([role, validation.result])
      }
      // Nothing is held until both verdicts validated, so a round never holds one reviewer's verdict alone.
      const round = task.reviewRound()
      for (const [role, review] of held)
        write(task.runtimeDir, task.issueNumber, round, role, task.renderVerdict(role, review))
      return ok()
    }
  },
  'vinaya.assess-round': {
    adapts: [assessRound],
    build: (task) => {
      return (context) => {
        let state = carriedLoopState(context.results, task.loopState)
        // assessRound reads a round as a gate observation, then the verdicts; the Flow reaches this step only
        // after a green gate, so the gate observation is recorded here first when the state has no pending round.
        const observation = task.observe(context.results)
        const gateEvents: unknown[] = []
        if (observation.kind === 'verdicts' && (state.pending === null || state.pending.round !== observation.round)) {
          const gate = assessRound(
            state,
            gateObservation(task.worktreePath, observation.round, context.results),
            task.clock
          )
          state = gate.state
          gateEvents.push(...gate.events)
        }
        const assessment = assessRound(state, observation, task.clock)
        state = assessment.state
        const { decision } = assessment
        // The gate's events come first, as the standalone loop records them, then the verdicts'.
        const events = [...gateEvents, ...assessment.events]
        // The Log events the assessment produced travel in the step's result; the log producers read them back.
        const stdout = JSON.stringify({ decision, events, state: JSON.parse(encodeLoopState(state)) })
        if (decision.type === 'pause') {
          // The pause is a decision, not a failure: it is handed off and the run halts at this step's boundary.
          if (!task.handoff) throw new Error('assess-round decided a pause but no handoff is wired to make it durable')
          task.handoff.pause({ reason: decision.reason, detail: decision.detail ?? decision.reason })
        }
        return { exitCode: decision.type === 'publish' ? 0 : 1, stdout }
      }
    }
  },
  'vinaya.build-revision-handoff': {
    adapts: [handoffFindings],
    build: (task) => (context) => {
      // Only a revise decision starts a new round; on publish the held verdicts stay bound to this round.
      const assessed = context.results['assess-round']
      const stdout = assessed && 'stdout' in assessed ? String(assessed.stdout) : ''
      let decision: string | undefined
      try {
        decision = (JSON.parse(stdout) as { decision?: { type?: string } }).decision?.type
      } catch (error) {
        throw new Error(
          `build-revision-handoff could not read the assess-round decision: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      if (typeof decision !== 'string')
        throw new Error(
          `build-revision-handoff found no decision type in the assess-round output: ${stdout.slice(0, 200)}`
        )
      if (decision === 'publish') return ok()
      return ok(JSON.stringify(handoffFindings(task.reviewRound(), ...task.verdicts(context.results))))
    }
  },
  'harness.publish': {
    adapts: [publishRound],
    build: (task) => () => {
      const findPr = task.bound?.findOpenPrForBranch ?? findOpenPrForBranch
      const readHead = task.bound?.readWorktreeHead ?? readWorktreeHead
      const publish = task.bound?.publishRound ?? publishRound
      const pr = findPr(task.branch)
      if (pr === null) throw new Error(`harness.publish found no open pull request for branch ${task.branch}`)
      const expectedHead = readHead(task.worktreePath)
      if (expectedHead === null) throw new Error(`harness.publish could not read the head of ${task.worktreePath}`)
      publish(task.runtimeDir, task.publish({ prNumber: pr.number, expectedHead, round: task.reviewRound() }))
      return ok()
    }
  }
}

/** The action registry for one task: each binding's action, built over that task's input. */
export function createActions(task: TaskInput): ActionRegistry {
  return Object.fromEntries(Object.entries(ACTION_BINDINGS).map(([name, binding]) => [name, binding.build(task)]))
}

/** Deciding step id to its boolean, read from the examined step's exit result. */
export const decisions: DecisionRegistry = {
  'choose-start': isDevelopmentDue,
  'classify-gate-result': isGateRed,
  'build-revision-handoff': isRevisionRequested
}

const executing = join(import.meta.dir)

/** Role launchers from the roles' grants files, one generated settings set per role under `generatedRoot`. */
export function createRoleLaunchers(options: {
  vendor: 'claude-code' | 'codex'
  generatedRoot: string
  variables?: Record<string, string>
  mcpCommand?: string
  /** A role-specific bridge command; takes precedence over the shared command. */
  mcpCommands?: Readonly<Record<string, string>>
  /** Replaces a `process-supplied` model in every role's grants for this run. */
  model?: string
  /** Claude's sandbox may use Unix sockets (the Linux host opt-in); the Codex adapter has no such filter. */
  allowUnixSockets?: boolean
  /** Copy the operator's Codex subscription login into each Codex role's generated CODEX_HOME (a live run). */
  stageCodexLogin?: boolean
  /** The ceiling in milliseconds each role launches with, by role name; a role absent from it keeps the executor's own bound. */
  timeouts?: Readonly<Record<string, number>>
}): RoleLauncher {
  const launchers: Record<string, ReturnType<typeof createRoleLauncher>> = {}
  for (const role of ROLE_NAMES) {
    const grants = withModel(loadRoleGrants(join(executing, role, 'grants.yaml')), options.model)
    const outputSchemaPath = join(executing, role, 'output.schema.json')
    const generatedDir = join(options.generatedRoot, role)
    const paths: GeneratorPaths = {
      generatedDir,
      outputSchemaPath,
      outputSchema: JSON.parse(readFileSync(outputSchemaPath, 'utf8')),
      mcpCommand: options.mcpCommands?.[role] ?? options.mcpCommand,
      variables: options.variables,
      allowUnixSockets: options.allowUnixSockets
    }
    const generated: GeneratedAgentConfig =
      options.vendor === 'claude-code' ? generateClaudeSettings(grants, paths) : generateCodexConfig(grants, paths)
    launchers[role] = createRoleLauncher(generated, {
      generatedDir,
      allowedPermissions: [`${role}/grants.yaml`],
      stageCodexLogin: options.stageCodexLogin === true,
      ...(options.timeouts?.[role] === undefined ? {} : { timeoutMs: options.timeouts[role] })
    })
  }
  return launchers
}
