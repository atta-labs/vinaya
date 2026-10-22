import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  assessRound,
  type LoopState,
  type Observations,
  type TaskClock,
  type VerdictObservation
} from '@attalabs/aeg-core'
import type { StepNodeResult } from '@atta/executor-agent-spawn'
import { generateClaudeSettings } from '../../../harness/adapters/agents/claude-code/settings'
import { generateCodexConfig } from '../../../harness/adapters/agents/codex/config'
import { loadRoleGrants, ROLE_NAMES } from '../../../harness/adapters/agents/manifest'
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
import { defaultRunWorktreeChecks, handoffFindings } from '../../../apps/cli/src/lib/dev-review-loop'
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
  /** Repository root the bound functions run from. */
  root: string
  branch: string
  issueNumber: number
  worktreePath: string
  developerContext: DeveloperTurnSchemaContext
  /** The loop state `assessRound` starts from; each assessment replaces it. */
  loopState: LoopState
  clock?: TaskClock
  /** The round's review round number, as `handoffFindings` counts it. */
  reviewRound: () => number
  /** What the round's gate and verdicts amount to, read from the recorded results. */
  observe: (results: Readonly<Record<string, StepNodeResult>>) => Observations
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

const ok = (stdout = ''): { exitCode: number; stdout: string } => ({ exitCode: 0, stdout })

/** The final structured record an agent step reported, or undefined for a step that is not one. */
export function agentOutput(results: Readonly<Record<string, StepNodeResult>>, step: string): unknown {
  const result = results[step]
  if (result?.kind !== 'agent-spawn') return undefined
  return result.events[result.events.length - 1]
}

/** The gate step's recorded exit result is red when it did not exit zero. */
export function isGateRed(examined: StepNodeResult): boolean {
  return examined.exitCode !== 0
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
      const readiness = checkTaskDispatchReadiness(task.branch)
      if (!readiness.ready) return { exitCode: 1, stdout: readiness.output }
      createTaskWorktree(task.branch)
      return ok(readiness.output)
    }
  },
  'vinaya.reconcile-external-state': {
    adapts: [findOpenPrForBranch],
    build: (task) => () => ok(JSON.stringify(findOpenPrForBranch(task.branch)))
  },
  'vinaya.prepare-sources': {
    adapts: [fetchSourceRevision],
    build: (task) => () => ok(fetchSourceRevision(task.issueNumber))
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
    adapts: [defaultRunWorktreeChecks],
    build: (task) => async () => {
      const gates = await defaultRunWorktreeChecks(task.worktreePath)
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
        write(task.root, task.issueNumber, round, role, task.renderVerdict(role, review))
      return ok()
    }
  },
  'vinaya.assess-round': {
    adapts: [assessRound],
    build: (task) => {
      let state = task.loopState
      return (context) => {
        const assessment = assessRound(state, task.observe(context.results), task.clock)
        state = assessment.state
        const { decision, events } = assessment
        // The Log events the assessment produced travel in the step's result; the log producers read them back.
        const stdout = JSON.stringify({ decision, events })
        if (decision.type === 'pause') {
          throw Object.assign(new Error(`The round paused for a human: ${decision.reason}`), { stdout })
        }
        return { exitCode: decision.type === 'publish' ? 0 : 1, stdout }
      }
    }
  },
  'vinaya.build-revision-handoff': {
    adapts: [handoffFindings],
    build: (task) => (context) =>
      ok(JSON.stringify(handoffFindings(task.reviewRound(), ...task.verdicts(context.results))))
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
      publish(task.root, task.publish({ prNumber: pr.number, expectedHead, round: task.reviewRound() }))
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
}): RoleLauncher {
  const launchers: Record<string, ReturnType<typeof createRoleLauncher>> = {}
  for (const role of ROLE_NAMES) {
    const grants = loadRoleGrants(join(executing, role, 'grants.yaml'))
    const outputSchemaPath = join(executing, role, 'output.schema.json')
    const generatedDir = join(options.generatedRoot, role)
    const paths: GeneratorPaths = {
      generatedDir,
      outputSchemaPath,
      outputSchema: JSON.parse(readFileSync(outputSchemaPath, 'utf8')),
      mcpCommand: options.mcpCommand,
      variables: options.variables
    }
    const generated: GeneratedAgentConfig =
      options.vendor === 'claude-code' ? generateClaudeSettings(grants, paths) : generateCodexConfig(grants, paths)
    launchers[role] = createRoleLauncher(generated, { generatedDir, allowedPermissions: [`${role}/grants.yaml`] })
  }
  return launchers
}
