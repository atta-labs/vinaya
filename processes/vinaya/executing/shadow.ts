import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { devToolError, type DevToolContext } from '../../../apps/cli/src/lib/task-tools/dev-tools-server'
import type { BoundFunctions } from './actions'
import type { HandoffDeps } from './handoff'

// Shadow mode: an Engine run of a real task that does the work — the Developer and both reviewers dispatched, the
// gates run, the round decided — and makes no effect anywhere another run or a person would see it. It is not a
// flag the live writers check: every function a run reaches that writes to the forge or to the shared repository
// is classified here, and a shadow run is built with a refusing recorder in that function's place, so the live
// writer is not in the run's registry at all. Every other function is a read, or writes only beneath the run's own
// runtime directory and worktree copy, which a shadow run owns apart from the live run beside it.

/**
 * How shadow mode treats one function a run can reach:
 * - `effect` — writes to the forge or the shared repository (a push, a comment, a pull-request or Issue write, a CI
 *   rerun, a worktree on the live checkout); a shadow run replaces it with a recorder that refuses and records.
 * - `read` — reads forge or repository state; a shadow run reads what the live run reads.
 * - `run-local` — writes only beneath the run's own runtime directory or worktree, or runs a local process there.
 */
export type ShadowClass = 'effect' | 'read' | 'run-local'

/** Every function the Engine actions reach through `task.bound`, classified. A key missing here fails to compile. */
export const BOUND_FUNCTION_CLASSES = {
  checkTaskDispatchReadiness: 'read',
  createTaskWorktree: 'effect',
  fetchSourceRevision: 'read',
  pullRequestView: 'read',
  findOpenPrForBranch: 'read',
  readWorktreeHead: 'read',
  writeHeldVerdict: 'run-local',
  publishRound: 'effect',
  resolveSecurityScanCommand: 'read',
  runSecurityScan: 'run-local',
  changedPaths: 'read',
  fetchPrBody: 'read',
  updatePrBody: 'effect',
  runLiveCommand: 'run-local',
  liveVendorSignedIn: 'read',
  liveRunTimeoutMs: 'read',
  prepareLiveCheckout: 'run-local',
  discardHeldVerdicts: 'run-local',
  writeDeferredFindingsIssue: 'effect',
  cleanupAllReviewerIsolationArtifacts: 'run-local',
  localGateControl: 'read',
  probeAgentSandbox: 'run-local',
  fetchCiConclusion: 'read',
  fetchFailingCheckRuns: 'read',
  fetchFailedCheckWorkflowRunIds: 'read',
  rerunFailedWorkflowJobs: 'effect',
  fetchMergeableState: 'read',
  fetchConflictingFiles: 'read',
  postMarkedComment: 'effect'
} as const satisfies { readonly [K in keyof BoundFunctions]-?: ShadowClass }

/** Every writer and poster a pause hands off to, classified. The control-store records go under the run's own runtime directory. */
export const HANDOFF_DEP_CLASSES = {
  writeEscalationRecord: 'run-local',
  writePauseState: 'run-local',
  readPauseState: 'read',
  postPauseComment: 'effect',
  postIssuePauseComment: 'effect',
  bindPauseToPullRequest: 'run-local',
  log: 'run-local',
  report: 'run-local',
  sleepSync: 'run-local'
} as const satisfies { readonly [K in keyof HandoffDeps]-?: ShadowClass }

/** Every Developer tool the driver serves, classified: the four publication tools are the Developer's forge writes. */
export const DEV_TOOL_CLASSES = {
  publishChanges: 'effect',
  openPullRequest: 'effect',
  updatePullRequestBody: 'effect',
  refreshEvidence: 'effect',
  readPullRequest: 'read',
  runChecks: 'run-local',
  fetchDocumentation: 'read',
  readSource: 'read'
} as const satisfies { readonly [K in keyof DevToolContext]-?: ShadowClass }

type EffectKey<Classes> = { [K in keyof Classes]: Classes[K] extends 'effect' ? K : never }[keyof Classes]

/** The names a classification table marks `effect`. */
export function effectKeys(classes: Readonly<Record<string, ShadowClass>>): string[] {
  return Object.entries(classes)
    .filter(([, kind]) => kind === 'effect')
    .map(([name]) => name)
}

/**
 * What a classification table misses against the names a registry declares: each declared name it does not
 * classify, and each name it classifies that the registry no longer declares.
 */
export function classificationGaps(
  declared: readonly string[],
  classes: Readonly<Record<string, ShadowClass>>
): { unclassified: string[]; stale: string[] } {
  const classified = Object.keys(classes)
  return {
    unclassified: declared.filter((name) => !classified.includes(name)).sort(),
    stale: classified.filter((name) => !declared.includes(name)).sort()
  }
}

/** One effect a shadow run refused: the registry it was reached through, the function, and its arguments in brief. */
export interface RefusedAttempt {
  registry: 'bound' | 'handoff' | 'dev-tool'
  name: string
  at: string
  args: unknown[]
}

export interface ShadowRecorder {
  /** Records one refused attempt; never performs it. */
  refuse: (registry: RefusedAttempt['registry'], name: string, args: readonly unknown[]) => void
  /** Every attempt this run's directory has recorded, oldest first, across every leg of the run. */
  attempts: () => RefusedAttempt[]
}

const ARG_TEXT_LIMIT = 200

/** An argument as the refused-attempt list keeps it: long text cut, functions named, the rest as JSON allows. */
function briefArg(value: unknown): unknown {
  if (typeof value === 'string') return value.length > ARG_TEXT_LIMIT ? `${value.slice(0, ARG_TEXT_LIMIT)}…` : value
  if (typeof value === 'function') return '[function]'
  try {
    const text = JSON.stringify(value)
    if (text === undefined) return null
    return text.length > ARG_TEXT_LIMIT ? `${text.slice(0, ARG_TEXT_LIMIT)}…` : JSON.parse(text)
  } catch {
    return String(value)
  }
}

/** A recorder appending each refused attempt, one JSON line each, to `path`. */
export function createShadowRecorder(path: string, now: () => Date = () => new Date()): ShadowRecorder {
  return {
    refuse: (registry, name, args) => {
      mkdirSync(dirname(path), { recursive: true })
      const attempt: RefusedAttempt = { registry, name, at: now().toISOString(), args: args.map(briefArg) }
      appendFileSync(path, `${JSON.stringify(attempt)}\n`, { mode: 0o600 })
    },
    attempts: () =>
      existsSync(path)
        ? readFileSync(path, 'utf8')
            .split('\n')
            .filter((line) => line.trim() !== '')
            .map((line) => JSON.parse(line) as RefusedAttempt)
        : []
  }
}

const SHADOW_REFUSAL = 'shadow mode refuses every forge effect'

/**
 * The refusing recorders for every `effect` bound function. Each records the attempt and performs nothing; a
 * caller that needs an answer gets one that names no real effect, so the run's own work goes on around it. A CI
 * rerun is refused by throwing, which the gate step already reads as a rerun the forge refused.
 */
export function boundFunctionRecorders(
  recorder: ShadowRecorder
): Pick<BoundFunctions, EffectKey<typeof BOUND_FUNCTION_CLASSES>> {
  const refuse = (name: EffectKey<typeof BOUND_FUNCTION_CLASSES>, args: readonly unknown[]) =>
    recorder.refuse('bound', name, args)
  return {
    createTaskWorktree: (...args) => refuse('createTaskWorktree', args),
    publishRound: (...args) => refuse('publishRound', args),
    updatePrBody: async (...args) => refuse('updatePrBody', args),
    writeDeferredFindingsIssue: (...args) => {
      refuse('writeDeferredFindingsIssue', args)
      return { issue: 0 }
    },
    rerunFailedWorkflowJobs: (...args) => {
      refuse('rerunFailedWorkflowJobs', args)
      throw new Error(`rerunFailedWorkflowJobs: ${SHADOW_REFUSAL}`)
    },
    postMarkedComment: (...args) => {
      refuse('postMarkedComment', args)
      return `shadow-refused:${String(args[2])}`
    }
  }
}

/** The run's bound functions with every `effect` one replaced by its refusing recorder; reads and run-local functions are kept. */
export function shadowBoundFunctions(
  bound: Partial<BoundFunctions> | undefined,
  recorder: ShadowRecorder
): Partial<BoundFunctions> {
  const kept = Object.fromEntries(
    Object.entries(bound ?? {}).filter(([name]) => BOUND_FUNCTION_CLASSES[name as keyof BoundFunctions] !== 'effect')
  ) as Partial<BoundFunctions>
  return { ...kept, ...boundFunctionRecorders(recorder) }
}

/** A pause's handoff with its two forge posts replaced by refusing recorders; the control-store records are kept. */
export function shadowHandoffDeps(deps: HandoffDeps, recorder: ShadowRecorder): HandoffDeps {
  return {
    ...deps,
    postPauseComment: (...args) => {
      recorder.refuse('handoff', 'postPauseComment', args)
      return { attempts: 0, posted: false }
    },
    postIssuePauseComment: (...args) => {
      recorder.refuse('handoff', 'postIssuePauseComment', args)
      return { attempts: 0, posted: false }
    }
  }
}

/**
 * The Developer's tool context with its four publication tools replaced by refusing recorders. A refused call
 * answers as a structured refusal the agent reads like any other; reads and the checks are kept.
 */
export function shadowDevToolContext(context: DevToolContext, recorder: ShadowRecorder): DevToolContext {
  const refused =
    (name: EffectKey<typeof DEV_TOOL_CLASSES>) =>
    async (...args: unknown[]) => {
      recorder.refuse('dev-tool', name, args)
      return {
        ok: false as const,
        error: devToolError(
          'policy_refusal',
          'never',
          'not_started',
          'shadow-mode',
          `${name} is refused: this is a shadow run, and ${SHADOW_REFUSAL}.`,
          'Finish the turn without publishing; the live run beside this one publishes the work.'
        )
      }
    }
  return {
    ...context,
    publishChanges: refused('publishChanges'),
    openPullRequest: refused('openPullRequest'),
    updatePullRequestBody: refused('updatePullRequestBody'),
    refreshEvidence: refused('refreshEvidence')
  }
}

/** The path a directory is known by: its real path once it exists, else its absolute one. */
function canonical(path: string): string {
  const absolute = resolve(path)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

/** Why a shadow run may not use `shadowDir`, or null when it may: it must never be the task's live runtime directory. */
export function shadowRuntimeDirRefusal(shadowDir: string, liveRuntimeDir: string): string | null {
  if (canonical(shadowDir) !== canonical(liveRuntimeDir)) return null
  return `the shadow runtime directory ${shadowDir} is the task's live runtime directory; a shadow run needs a directory of its own`
}

/** What a finished shadow run leaves in its own runtime directory: its decision and every effect it refused. */
export interface ShadowRecord {
  task: number
  loopId: string
  /** How the run ended: `completed`, `paused`, `failed` … as its trace records it. */
  outcome: string
  pauseReason: string | null
  /** The round decision the assessment recorded, or null when no round was assessed. */
  decision: { type: string; reason?: string } | null
  exitCode: number
  refused: RefusedAttempt[]
}

/** The shadow record's file under the run's own directory. */
export const shadowRecordPath = (runDir: string): string => join(runDir, 'shadow.json')

/** The refused-attempt list's file under the run's own directory. */
export const refusedAttemptsPath = (runDir: string): string => join(runDir, 'shadow-refused.jsonl')

export function writeShadowRecord(runDir: string, record: ShadowRecord): string {
  mkdirSync(runDir, { recursive: true })
  const path = shadowRecordPath(runDir)
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  return path
}
