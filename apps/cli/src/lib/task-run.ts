/**
 * `runTask` — the one lib function `vinaya task run <tranche> <n> --agent
 * <vendor>` calls (`commands/task-run.ts`). Composes `prepareTask`
 * (`dispatch-task.js`, task 1) with `devReviewLoop` (`dev-review-loop.js`)
 * — nothing else. `prepareTask` renders and freezes the brief and
 * starts no agent under any circumstances (its own doc comment); the loop's
 * own round-1 entry reads that frozen brief off the Issue
 * (`fetchFrozenBrief`) and is the ONLY place a developer is ever dispatched
 * from a fresh task — so a developer is started exactly once by
 * construction, never by anything this file does.
 *
 * `--agent` is never passed into `prepareTask` (Traps to avoid) — preparation
 * is agent-agnostic; only `devReviewLoop`'s own `LoopInput.agent` field
 * carries it, exactly once. `LoopInput.model` (issue-661, O1) carries the
 * SAME resolution: `runTask` resolves it once, right here, and
 * `devReviewLoop`'s own developer dispatch is the only place it is spent.
 */

import { defaultControlStoreDeps, readResolution, type ResolutionRecord } from '@attalabs/aeg-core'
import { resolveRepo as realResolveRepo, type RepoRef } from '@attalabs/aeg-forge-state'
import {
  type AssembleAndRenderBriefResult,
  assembleAndRenderBrief as realAssembleAndRenderBrief,
  assembleAndRenderBriefForIssue as realAssembleAndRenderBriefForIssue
} from './brief-assembly.js'
import type { AgentVendor } from './dispatch.js'
import {
  developerBranchFor as realDeveloperBranchFor,
  type DriverResult,
  findOpenPrForBranch as realFindOpenPrForBranch,
  type LoopInput,
  runDriverLoop as realRunDriverLoop
} from './dev-review-loop.js'
import {
  escalationIdFor,
  isDriverPidAlive,
  noPushResumeArgv,
  noPushResumeCommandFor,
  type PauseState,
  ReplayedResolutionError,
  readDriverLock,
  readEscalationRecord,
  readPauseState,
  resolveEscalation
} from './dev-review-loop/pause-resume.js'
import { runtimeDir } from './dev-review-loop/reviewer-dispatch.js'
import { readTurnResultRecords, type TurnResultRecord } from './dev-review-loop/turn-result.js'
import { markProcessUnattended, tasksExecutionRoot } from './run-paths.js'
import {
  type DispatchAuthorization,
  DispatchTaskError,
  gradeWidenedSurface as realGradeWidenedSurface,
  type PrepareTaskOrIssueInput,
  prepareIssueTask as realPrepareIssueTask,
  prepareTask as realPrepareTask,
  prepareTaskOrIssue as realPrepareTaskOrIssue,
  resolveDispatchAuthorization as realResolveDispatchAuthorization,
  resolveModelForDispatch as realResolveModelForDispatch,
  runIssueWriteGate as realRunIssueWriteGate,
  type PrepareTaskResult
} from './dispatch-task.js'

/** `findOpenPrForBranch`'s own return shape, never redeclared — `dev-review-loop.ts`'s private `PrRef` type stays unexported (loop internals are out of this task's Surface); `ReturnType` derives the identical shape from the real function instead. */
type OpenPrRef = NonNullable<ReturnType<typeof realFindOpenPrForBranch>>

/** Thrown for every refusal `runTask` itself decides (the open-PR guard) — a
 * direct caller (a test, `taskRunCommand`) catches it like any `Error`; the
 * command lets it propagate to `index.ts`'s own top-level catch. */
export class RunTaskError extends Error {}

/**
 * `prepareTask`'s own fixed wording for its "already dispatched" refusal
 * (`dispatch-task.ts`'s `findExistingV1Comment` guard) — the only one of its
 * refusal messages `runTask` must treat as "reuse, don't re-post" rather than
 * a hard stop. Already load-bearing on this exact text in
 * `apps/cli/tests/lib/dispatch-task.test.ts`, so it is stable, not a new
 * coupling this task introduces. Every other `DispatchTaskError` (a render
 * refusal, an authorization refusal) means preparation itself refused and
 * `runTask` propagates it unchanged — nothing started.
 */
const ALREADY_DISPATCHED_PATTERN = /is already dispatched/

/** Pure: true iff `err` is `prepareTask`'s specific "already dispatched" refusal, never any other `DispatchTaskError`. */
export function isAlreadyDispatchedError(err: unknown): boolean {
  return err instanceof DispatchTaskError && ALREADY_DISPATCHED_PATTERN.test(err.message)
}

/**
 * `model` — O1 (issue-661): an explicit model the operator names on the
 * command line. Wins over everything else; when absent, `runTask` resolves
 * the Issue's own "Suggested agent-class" rationale through
 * `resolveModelForDispatch` (the SAME class-to-model table `task dispatch`
 * already uses), and falls back to the vendor's own default when neither
 * yields one.
 */
export type RunTaskInput = ({ tranche: string; n: number } | { issue: number }) & {
  agent: AgentVendor
  model?: string
  /**
   * `--widen-surface <glob,...> --reason <text>`: continue a pre-pull-request
   * escalation whose Developer asked for `widen_surface` — supersede the
   * frozen brief with these globs added to `## Surface`, record that as the
   * escalation's resolution, grade the widened Issue through the write gate,
   * then start the run (`widenSurfaceBeforeRun`).
   */
  widenSurface?: WidenSurfaceRequest
}

/** The globs a widen-surface continuation adds to `## Surface` `in:`, and the reason its superseding brief records. */
export type WidenSurfaceRequest = { globs: string[]; reason: string }
/**
 * `prUrl` — the published/paused PR's real `https://github.com/<owner>/<repo>/pull/<n>`
 * URL, per this module's own Sizing story ("...runs the loop to publish and
 * exits zero printing the PR URL"). Neither `LoopResult` nor `DriverResult`
 * carries a URL field of its own, so it is constructed here from
 * `resolveRepo()` plus the loop's own `prNumber`. `null` only when the repo
 * genuinely cannot be resolved (no git remote, an unparseable `AEG_REPO`) —
 * the same tolerance `dev-review-loop.ts`'s own `resolveRepo().catch(() =>
 * null)` already extends to this exact failure, never a thrown error over a
 * display-only nicety.
 *
 * issue-711 O4: `LoopResult` widened to `DriverResult` — `runTask` now
 * composes the watching driver (`runDriverLoop`), never `devReviewLoop`
 * directly, so its own final decision can also read `'ended'` (the pull
 * request merged, closed, or was cancelled while this run watched a pause)
 * alongside the pre-existing `'publish'`/`'pause'`.
 *
 * `branch` — the developer branch this run actually resolved and ran on
 * (`developerBranchFor(issue)`, below), surfaced so the exit summary's
 * continuation command for a pre-first-push pause (`prNumber <= 0`, no PR to
 * anchor a `--resume` to) is rendered from the SAME `noPushResumeArgv` builder
 * the pause comment uses — `task run <tranche> <n>` for a tranche task,
 * `task run --issue <n>` for a backlog one — rather than a second, drifting
 * copy that hardcoded one form (round 2 review). Reusing the already-resolved
 * value adds no forge read.
 */
export type RunTaskResult = DriverResult & { prUrl: string | null; branch: string }

/**
 * Injection seam for `apps/cli/tests/lib/task-run.test.ts` — same convention
 * `dispatch-task.ts`'s own `DispatchTaskDeps`/`PrepareTaskDeps` already use.
 * `prepareTask` and `devReviewLoop` are the two real functions this task's
 * Surface calls unmodified; every field defaults to them.
 */
export type RunTaskDeps = {
  prepareTask: (input: { tranche: string; n: number }) => Promise<PrepareTaskResult>
  prepareIssueTask: (input: { issue: number }) => Promise<PrepareTaskResult>
  assembleAndRenderBrief: (tranche: string, taskId: string) => Promise<AssembleAndRenderBriefResult>
  assembleAndRenderBriefForIssue: (issueNumber: number) => Promise<AssembleAndRenderBriefResult>
  developerBranchFor: (issueNumber: number) => string
  findOpenPrForBranch: (branch: string) => OpenPrRef | null
  /**
   * True only when this task's driver lock names a
   * PID that is actually still alive. An open PR alone is no longer
   * grounds to refuse (below): a driver that crashed or was killed leaves
   * its PR behind, and this is what tells that state apart from a driver
   * genuinely still working the task.
   */
  isDriverAlive: (task: number) => boolean
  /**
   * issue-711 O5: true only when a pause is currently held for this task —
   * read from the SAME local record `devReviewLoop`'s own `--resume` entry
   * reads (`readPauseState`, `pause-resume.ts`). A task that was never
   * paused reads `false` here forever (the record is written only on a
   * pause), so the ordinary fresh-dispatch/dead-lock-takeover path below is
   * unchanged for it. A task whose most recent pause has already been
   * resumed and concluded still reads `true` — `devReviewLoop`'s own
   * `--resume` entry self-heals that case (`ReplayedResolutionError` ->
   * `attachAfterReplayedResolution`, continuing from the PR's current state
   * exactly like a fresh `--task <n>` attach) rather than needing a second,
   * independent staleness check duplicated here.
   */
  hasPauseState: (task: number) => boolean
  /**
   * O1: the SAME class-to-model resolution `task dispatch` already uses
   * (`dispatch-task.ts`'s `resolveModelForDispatch`) — an explicit model
   * wins outright (never re-derived), absent that the Issue's own
   * "Suggested agent-class" rationale resolves through this vendor's
   * class-to-model table, `undefined` when neither yields one.
   */
  resolveModelForDispatch: (agent: AgentVendor, issue: number, explicitModel: string | undefined) => string | undefined
  /**
   * issue-711 O5: widened from `{ task, agent, model? }` to the full
   * `LoopInput` union — the paused-PR redirect below now calls this with
   * `{ resumePr, agent, model? }` too. issue-711 O4: its return type
   * widened from `LoopResult` to `DriverResult` — the real default is now
   * `runDriverLoop` (the watching driver), never `devReviewLoop` directly,
   * so `runTask` itself never hands back to an operator's own `--resume`
   * for the ordinary case; the field keeps this name for every existing
   * caller/fixture (this file's own doc comment, `task-run.test.ts`)
   * rather than a rename that touches nothing behavioural.
   */
  devReviewLoop: (input: LoopInput) => Promise<DriverResult>
  resolveRepo: () => Promise<RepoRef | null>
  /** The widen-surface continuation's own seams, read only when `RunTaskInput.widenSurface` is given; absent, the real ones. */
  widen?: WidenSurfaceDeps
}

/**
 * The records a widen-surface continuation is judged against, all local: the
 * held pause, whether its escalation was durably recorded, the resolution
 * already consumed for it (if any), and the Developer's turn-result records
 * for the paused round.
 */
export type WidenSurfaceFacts = {
  pause: PauseState | null
  escalationRecorded: boolean
  resolution: ResolutionRecord | null
  turnResults: readonly TurnResultRecord[]
}

export type WidenSurfaceDeps = {
  readFacts: (issue: number) => WidenSurfaceFacts
  /** The Principal allowlist check `task brief --supersede` already applies; its login is the resolution's `authenticatedBy`. */
  resolveAuthorization: () => DispatchAuthorization
  /** Grades the widened body and writes nothing (`dispatch-task.ts`'s `gradeWidenedSurface`). */
  gradeWidenedSurface: (issue: number, globs: string[], retryCommand: string) => Promise<void>
  /** `task brief --supersede --surface-in`'s own lib path: widens `## Surface`, re-renders and posts the next frozen brief. */
  supersede: (input: PrepareTaskOrIssueInput) => Promise<PrepareTaskResult>
  /** Consumes the escalation's single resolution (`resolveEscalation`, decision `resume`). */
  recordResolution: (issue: number, escalationId: string, authenticatedBy: string, authenticatedFrom: string) => void
  /** The write gate over the Issue's live body — the widened one, once the supersede has written it. */
  runIssueWriteGate: (issue: number, retryCommand: string) => Promise<void>
}

/** The real production check — a dead or absent lock reads `false`, exactly like `devReviewLoop`'s own entry-gate takeover check (`dev-review-loop.ts`'s `existingDriverLock`/`isDriverPidAlive`), read here from the SAME on-disk shape rather than a second one. */
function realIsDriverAlive(task: number): boolean {
  const lock = readDriverLock(runtimeDir(), task)
  return lock !== null && isDriverPidAlive(lock.pid)
}

/** issue-711 O5: the real production check — reads the SAME on-disk `pause-state.json` `devReviewLoop`'s own `--resume` entry reads, rather than a second copy. */
function realHasPauseState(task: number): boolean {
  return readPauseState(runtimeDir(), task) !== null
}

/** The same control-store root `task_resume` derives from the runtime directory, so both read and consume one escalation's records. */
function controlStoreDepsFor(root: string) {
  return defaultControlStoreDeps(() => tasksExecutionRoot(root))
}

function realReadWidenSurfaceFacts(issue: number): WidenSurfaceFacts {
  const root = runtimeDir()
  const pause = readPauseState(root, issue)
  if (pause === null) return { pause, escalationRecorded: false, resolution: null, turnResults: [] }
  const escalationId = pause.escalationId ?? escalationIdFor(issue, pause.round, pause.head)
  const store = controlStoreDepsFor(root)
  const resolution = readResolution(store, issue, escalationId)
  return {
    pause,
    escalationRecorded: readEscalationRecord(issue, escalationId, store) !== null,
    resolution: resolution.status === 'ok' ? resolution.value : null,
    turnResults: readTurnResultRecords(root, issue, pause.round)
  }
}

const defaultWidenSurfaceDeps: WidenSurfaceDeps = {
  readFacts: realReadWidenSurfaceFacts,
  resolveAuthorization: realResolveDispatchAuthorization,
  gradeWidenedSurface: realGradeWidenedSurface,
  supersede: realPrepareTaskOrIssue,
  recordResolution: (issue, escalationId, authenticatedBy, authenticatedFrom) => {
    resolveEscalation(
      issue,
      escalationId,
      null,
      'resume',
      authenticatedBy,
      authenticatedFrom,
      controlStoreDepsFor(runtimeDir())
    )
  },
  runIssueWriteGate: realRunIssueWriteGate
}

/** Exported for `task-run-background.ts`'s own `resolveIssueForRunTask` call — the same real preparation functions, never a second copy. */
export const defaultRunTaskDeps: RunTaskDeps = {
  prepareTask: realPrepareTask,
  prepareIssueTask: realPrepareIssueTask,
  assembleAndRenderBrief: realAssembleAndRenderBrief,
  assembleAndRenderBriefForIssue: realAssembleAndRenderBriefForIssue,
  developerBranchFor: realDeveloperBranchFor,
  findOpenPrForBranch: realFindOpenPrForBranch,
  isDriverAlive: realIsDriverAlive,
  hasPauseState: realHasPauseState,
  resolveModelForDispatch: realResolveModelForDispatch,
  devReviewLoop: realRunDriverLoop,
  resolveRepo: () => realResolveRepo(),
  widen: defaultWidenSurfaceDeps
}

/** `null` on any resolution failure — a display-only nicety never worth failing `runTask` over. */
async function resolvePrUrl(resolveRepo: () => Promise<RepoRef | null>, prNumber: number): Promise<string | null> {
  const repo = await resolveRepo().catch(() => null)
  return repo ? `https://github.com/${repo.owner}/${repo.repo}/pull/${prNumber}` : null
}

/**
 * O1/O2/O3 — the entire composition. In order:
 *
 * 1. `deps.prepareTask` — renders, refuses on any gap (propagated as-is:
 *    "refused before any agent starts", O3), and posts the frozen brief on a
 *    fresh task. Its ONE other refusal shape — the brief is already frozen —
 *    is caught and treated as "reuse, don't re-post": the Issue number
 *    is re-resolved via the same read-only render `prepareTask` itself just
 *    ran, never by writing anything a second time.
 * 2. The developer's branch (`developerBranchFor`, never guessed) is checked
 *    for an already-open pull request. One exists only when an EARLIER,
 *    separate dispatch (the deprecated `task dispatch --agent`, or a prior
 *    `task run`) already started a developer outside this call — `runTask`
 *    refuses rather than silently taking it over (O3's third refusal).
 * 3. `deps.devReviewLoop` is called exactly once — the loop's own round-1
 *    entry is what actually starts (or attaches to) the developer; this
 *    function makes no dispatch decision of its own (Traps to avoid).
 */
/** `RunTaskInput`'s own label for error text — a task ordinal or a bare Issue reference, whichever form the caller used. */
export function taskLabelFor(input: RunTaskInput): string {
  return 'tranche' in input ? `task ${input.n} in tranche \`${input.tranche}\`` : `Issue #${input.issue}`
}

/**
 * O1 — the driver's first log line: which model this run resolved, and why
 * (Traps to avoid: an operator's stray env var must never silently win, so
 * this names the precedence that actually applied). Pure, so the three
 * shapes (explicit, class-mapped, absent) are fixture-tested with no
 * `console` capture.
 */
export function describeModelResolution(explicitModel: string | undefined, resolvedModel: string | undefined): string {
  if (explicitModel !== undefined) return `model ${explicitModel} (explicit --model)`
  if (resolvedModel !== undefined) return `model ${resolvedModel} (Issue's suggested agent-class)`
  return 'vendor default model (no --model given, no agent-class mapping for this vendor)'
}

/**
 * The preparation half of `runTask` — render/freeze the brief and resolve
 * the real forge Issue number, tolerating the "already dispatched" refusal
 * by re-resolving through the same read-only render rather than treating it
 * as a hard stop (see `runTask`'s own doc comment, step 1). Factored out so
 * `startBackgroundRun` (`task-run-background.ts`) can resolve the SAME
 * issue number before acquiring controller ownership,
 * without duplicating this exact retry shape or calling `devReviewLoop`
 * itself — background start never starts a developer in this process; the
 * detached child it launches does that, through its OWN call to `runTask`.
 */
export async function resolveIssueForRunTask(
  input: RunTaskInput,
  deps: Pick<
    RunTaskDeps,
    | 'prepareTask'
    | 'prepareIssueTask'
    | 'assembleAndRenderBrief'
    | 'assembleAndRenderBriefForIssue'
    | 'developerBranchFor'
    | 'findOpenPrForBranch'
    | 'isDriverAlive'
    | 'widen'
  >
): Promise<number> {
  if (input.widenSurface) return widenSurfaceBeforeRun(input, input.widenSurface, deps)
  try {
    return 'tranche' in input
      ? (await deps.prepareTask({ tranche: input.tranche, n: input.n })).issue
      : (await deps.prepareIssueTask({ issue: input.issue })).issue
  } catch (err) {
    if (!isAlreadyDispatchedError(err)) throw err
    const rendered =
      'tranche' in input
        ? await deps.assembleAndRenderBrief(input.tranche, String(input.n))
        : await deps.assembleAndRenderBriefForIssue(input.issue)
    if (!rendered.ok) {
      throw new RunTaskError(
        `runTask: ${taskLabelFor(input)} was already dispatched, but re-resolving its Issue number failed:\n${rendered.missing.map((m) => `  - ${m}`).join('\n')}`
      )
    }
    return rendered.issue
  }
}

export async function runTask(input: RunTaskInput, deps: RunTaskDeps = defaultRunTaskDeps): Promise<RunTaskResult> {
  // Round 2 review (MAJOR) / security review (MEDIUM): a driver runs with no
  // human watching, so it must resolve `runtimeDir` through the
  // default-branch gate rather than trusting the working tree. Marked FIRST,
  // before any path is resolved and before anything is dispatched, so the
  // classification is already true for this process and for every child that
  // inherits its environment.
  markProcessUnattended()
  const { agent, model: explicitModel } = input
  const taskLabel = taskLabelFor(input)
  const issue = await resolveIssueForRunTask(input, deps)

  // O1: resolved once, right after the Issue number is known and before
  // anything else — logged as the very first line THIS invocation prints,
  // ahead of any line `devReviewLoop` writes of its own.
  const resolvedModel = deps.resolveModelForDispatch(agent, issue, explicitModel)
  console.error(`vinaya task run: ${taskLabel} — ${describeModelResolution(explicitModel, resolvedModel)}`)

  // Round 2 security review, LOW: this check-then-act read has a real, accepted
  // race window — two concurrent `runTask` calls for the same task can both
  // read no open PR here and both proceed. O3's own guarantee names the
  // SEQUENTIAL case (`task dispatch` then a later `task run`), which this
  // closes completely; closing the concurrent case too needs a forge-side
  // atomic reservation or a cross-process lock, both new infrastructure this
  // "thin composition" task's Surface never named. `devReviewLoop`'s own
  // round-1 entry re-reads this same fact immediately before it would ever
  // dispatch fresh, narrowing the real double-dispatch window to the few
  // milliseconds between this read and that one, on both sides of the race.
  const branch = deps.developerBranchFor(issue)
  const existingPr = deps.findOpenPrForBranch(branch)
  // An open PR alone is no longer grounds to refuse — a
  // driver that crashed or was killed leaves its PR (and, sometimes, a held
  // pause) behind, and `task run --issue <n>` is the one command that
  // revives it, in ANY state, rather than pointing at `--resume` (which
  // needs a pause to resume FROM, and refuses when there is none). Only a
  // driver ACTUALLY still running this task is still refused, to avoid a
  // genuinely concurrent second developer.
  if (existingPr && deps.isDriverAlive(issue)) {
    throw new RunTaskError(
      `runTask: ${taskLabel}'s developer branch \`${branch}\` already has an open pull request (#${existingPr.number}), and a driver is already running for it — refusing to start a second developer. Nothing needs running: that driver continues the task by itself, and \`vinaya task status\` shows where it is.`
    )
  }

  // issue-711 O5: a paused task's pull request continues from the newest
  // Principal ruling, exactly as `dev-review-loop --resume <pr>` does — it
  // never resumes the Developer's previous session by attaching fresh
  // (`{task: issue}`) instead. Gated on an open PR existing at all, so a task
  // that has never been paused (`deps.hasPauseState` false) takes the exact
  // same fresh-dispatch / dead-lock-takeover path as before this task. A
  // pause recorded before any pull request existed takes this route too once
  // one is open: `--resume` binds it to that pull request first
  // (`bindPauseToPullRequest`) and continues from it. With no pull request
  // open yet, such a pause continues through the fresh-attach route below.
  const shouldResumeFromPause = existingPr !== null && deps.hasPauseState(issue)
  const loopResult = await deps.devReviewLoop(
    shouldResumeFromPause
      ? { resumePr: existingPr.number, agent, ...(resolvedModel ? { model: resolvedModel } : {}) }
      : { task: issue, agent, ...(resolvedModel ? { model: resolvedModel } : {}) }
  )
  const prUrl = await resolvePrUrl(deps.resolveRepo, loopResult.prNumber)
  return { ...loopResult, prUrl, branch }
}

// --- widen-surface continuation ---------------------------------------------

/** A token that needs no shell quoting — every real tranche slug, agent, model and repository path. */
const SHELL_SAFE_WORD = /^[A-Za-z0-9._@%+=:,/*-]+$/

function shellWord(token: string): string {
  return SHELL_SAFE_WORD.test(token) ? token : `'${token.replaceAll("'", `'\\''`)}'`
}

/** A backticked token in the Developer's own words that reads as a repository path or glob — relative, no `..`. */
const REQUESTED_GLOB = /^[A-Za-z0-9._@*-][A-Za-z0-9._@*/-]*$/

/**
 * The Developer's widen-surface request, when the paused round's newest
 * accepted turn result is a `needs_ruling` whose decisions include
 * `widen_surface`; `null` otherwise. The turn-result grammar carries no glob
 * field, so the globs are the backticked repository paths the Developer named
 * in its question and summary — possibly none, in which case the command a
 * reader is shown keeps a placeholder for the Planner to fill.
 */
export function widenSurfaceRequestOf(records: readonly TurnResultRecord[]): { globs: string[] } | null {
  const accepted = records.filter((r) => r.outcome === 'accepted' && r.result !== null)
  const newest = accepted[accepted.length - 1]?.result
  if (newest?.status !== 'needs_ruling') return null
  if (!newest.rulingRequest.decisions.includes('widen_surface')) return null
  const text = `${newest.rulingRequest.question}\n${newest.summary}`
  const globs = [...text.matchAll(/`([^`\s]+)`/g)]
    .map((m) => m[1] as string)
    .filter((t) => t.includes('/') && !t.includes('..') && REQUESTED_GLOB.test(t))
  return { globs: [...new Set(globs)] }
}

/**
 * The one Planner command that continues a pre-pull-request widen-surface
 * escalation — `task run` in whichever address form this task's branch takes
 * (`noPushResumeArgv`, the builder every other pre-pull-request continuation
 * uses), with the requested globs and a reason placeholder, and the agent and
 * model the paused run was dispatched under.
 */
export function widenSurfaceCommandFor(
  task: number,
  branch: string,
  globs: readonly string[],
  agent?: string,
  model?: string
): string {
  const argv = [
    ...noPushResumeArgv(task, branch),
    '--widen-surface',
    globs.length > 0 ? globs.join(',') : '<glob,...>',
    '--reason',
    '<why the Surface widens>',
    ...(agent ? ['--agent', agent] : []),
    ...(model ? ['--model', model] : [])
  ]
  return `vinaya ${argv.map(shellWord).join(' ')}`
}

/**
 * The widen-surface command for a held pause, when it is one this command
 * answers — a pre-pull-request escalation whose paused round's accepted
 * Developer result asks for `widen_surface`; `null` for any other pause. One
 * reader for the escalation packet's permitted next actions and the
 * Operator's resume refusal, so both name the same command.
 */
export function widenSurfaceContinuationFor(root: string, pause: PauseState): string | null {
  if (pause.prNumber !== null || pause.reason !== 'escalation') return null
  const request = widenSurfaceRequestOf(readTurnResultRecords(root, pause.task, pause.round))
  return request === null
    ? null
    : widenSurfaceCommandFor(pause.task, pause.branch, request.globs, pause.agent, pause.model)
}

/** This invocation's own command line, named as the retry in the write gate's findings. */
function widenRetryCommand(input: RunTaskInput, request: WidenSurfaceRequest): string {
  const address =
    'tranche' in input
      ? ['task', 'run', input.tranche, String(input.n)]
      : ['task', 'run', '--issue', String(input.issue)]
  const argv = [...address, '--widen-surface', request.globs.join(','), '--reason', request.reason]
  return `vinaya ${argv.map(shellWord).join(' ')}`
}

/**
 * Which held pause this continuation answers, or a refusal naming why it
 * answers none: no pause, a pause that has a pull request (its continuation
 * is the ruling on that pull request), a pause that is not a Developer's
 * `widen_surface` request, an escalation never durably recorded, or one whose
 * resolution is already consumed — the replay of a widening already done.
 */
export function widenSurfaceEscalationOf(
  issue: number,
  label: string,
  facts: WidenSurfaceFacts,
  openPr: number | null
): { escalationId: string; pause: PauseState } {
  const { pause } = facts
  if (pause === null) {
    throw new RunTaskError(
      `runTask: ${label} holds no paused run — \`--widen-surface\` answers a widen-surface escalation, and there is none to answer. Widen a frozen brief that no escalation asked for with \`vinaya task brief … --supersede --reason <text> --surface-in <glob,...>\`.`
    )
  }
  const pr = pause.prNumber ?? openPr
  if (pr !== null) {
    throw new RunTaskError(
      `runTask: ${label}'s pause has pull request #${pr} — its continuation is a Principal ruling on that pull request (\`vinaya pr rule ${pr} --file <ruling>\`), never \`--widen-surface\`, which answers only a pause raised before any pull request existed.`
    )
  }
  const request = pause.reason === 'escalation' ? widenSurfaceRequestOf(facts.turnResults) : null
  if (request === null) {
    throw new RunTaskError(
      `runTask: ${label}'s pause (reason \`${pause.reason}\`, round ${pause.round}) is not a widen-surface escalation — the round's accepted Developer result asks for no \`widen_surface\` decision. Continue it with \`${noPushResumeCommandFor(issue, pause.branch, pause.agent, pause.model)}\` once its own ruling is settled.`
    )
  }
  const escalationId = pause.escalationId ?? escalationIdFor(issue, pause.round, pause.head)
  if (facts.resolution !== null) {
    throw new RunTaskError(
      `runTask: ${label}'s escalation '${escalationId}' already has a consumed '${facts.resolution.decision}' resolution (by ${facts.resolution.authenticatedBy}, from ${facts.resolution.authenticatedFrom}) — replay refused; the Surface is not widened twice. Continue the task with \`${noPushResumeCommandFor(issue, pause.branch, pause.agent, pause.model)}\`.`
    )
  }
  if (!facts.escalationRecorded) {
    throw new RunTaskError(
      `runTask: ${label}'s escalation '${escalationId}' has no durable record, so its widening cannot be recorded as its resolution — refused before anything was superseded.`
    )
  }
  return { escalationId, pause }
}

/**
 * The widen-surface continuation, before the run starts. Every refusal comes
 * first and writes nothing: the Principal allowlist, a driver still alive for
 * the task, a pause that is not a pre-pull-request widen-surface escalation
 * (or whose resolution is already consumed), and the widened body failing the
 * write gate — graded here, read-only, with `widenSurfaceInLine`'s own
 * refusal and the gate's findings passed through verbatim. Then, in order:
 *
 * 1. the supersede (`task brief --supersede --surface-in`'s own lib path),
 *    which widens the Issue and returns the posted comment of the next frozen
 *    brief — nothing later runs until it has;
 * 2. that widening recorded as the escalation's resolution, so the same
 *    command run again is a replay, refused above;
 * 3. the write gate over the Issue's live, now-widened body;
 *
 * and `runTask` then starts the run from the newest brief. This never edits
 * any other Issue field: a gate finding names the field the Planner edits
 * first.
 */
async function widenSurfaceBeforeRun(
  input: RunTaskInput,
  request: WidenSurfaceRequest,
  deps: Pick<
    RunTaskDeps,
    'assembleAndRenderBrief' | 'developerBranchFor' | 'findOpenPrForBranch' | 'isDriverAlive' | 'widen'
  >
): Promise<number> {
  const label = taskLabelFor(input)
  const retryCommand = widenRetryCommand(input, request)
  const widen = deps.widen ?? defaultWidenSurfaceDeps

  const { authorized, login } = widen.resolveAuthorization()
  if (!authorized || login === null) {
    throw new RunTaskError(
      login === null
        ? `runTask: could not resolve the identity \`gh\` is authenticated as — widening ${label}'s Surface is Principal-only, refused.`
        : `runTask: \`${login}\` is not on the Principal allowlist — widening ${label}'s Surface is Principal-only, refused.`
    )
  }

  let issue: number
  if ('tranche' in input) {
    const rendered = await deps.assembleAndRenderBrief(input.tranche, String(input.n))
    if (!rendered.ok) {
      throw new RunTaskError(
        `runTask: could not resolve ${label}'s Issue:\n${rendered.missing.map((m) => `  - ${m}`).join('\n')}`
      )
    }
    issue = rendered.issue
  } else {
    issue = input.issue
  }

  if (deps.isDriverAlive(issue)) {
    throw new RunTaskError(
      `runTask: a driver is still running ${label} — refused before anything was superseded. Widening a Surface answers a paused run; \`vinaya task status\` shows where the live one is.`
    )
  }

  const openPr = deps.findOpenPrForBranch(deps.developerBranchFor(issue))
  const { escalationId } = widenSurfaceEscalationOf(issue, label, widen.readFacts(issue), openPr?.number ?? null)

  try {
    await widen.gradeWidenedSurface(issue, request.globs, retryCommand)
  } catch (err) {
    throw new RunTaskError(
      `runTask: refused before anything was superseded — the widened \`## Surface\` does not pass:\n${err instanceof Error ? err.message : String(err)}`
    )
  }

  const superseded = await widen.supersede({
    ...('tranche' in input ? { tranche: input.tranche, n: input.n } : { issue: input.issue }),
    supersede: { reason: request.reason, surfaceIn: request.globs }
  })
  console.error(
    `vinaya task run: ${label} — brief superseded to v${superseded.version} with \`## Surface\` widened by ${request.globs.join(', ')}: ${superseded.commentUrl}`
  )

  try {
    widen.recordResolution(issue, escalationId, login, `widen-surface:${superseded.commentUrl}`)
  } catch (err) {
    if (err instanceof ReplayedResolutionError) {
      throw new RunTaskError(
        `runTask: ${err.message}. The brief was superseded (${superseded.commentUrl}), but another continuation consumed this escalation first — the run was not started from here.`
      )
    }
    throw err
  }

  await widen.runIssueWriteGate(issue, retryCommand)
  return issue
}
