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
import { isDriverPidAlive, readDriverLock, readPauseState } from './dev-review-loop/pause-resume.js'
import { runtimeDir } from './dev-review-loop/reviewer-dispatch.js'
import { markProcessUnattended } from './run-paths.js'
import {
  DispatchTaskError,
  prepareIssueTask as realPrepareIssueTask,
  prepareTask as realPrepareTask,
  resolveModelForDispatch as realResolveModelForDispatch,
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
}
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
 */
export type RunTaskResult = DriverResult & { prUrl: string | null }

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
  resolveRepo: () => realResolveRepo()
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
    'prepareTask' | 'prepareIssueTask' | 'assembleAndRenderBrief' | 'assembleAndRenderBriefForIssue'
  >
): Promise<number> {
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
      `runTask: ${taskLabel}'s developer branch \`${branch}\` already has an open pull request (#${existingPr.number}), and a driver is already running for it — refusing to start a second developer. Resume the review loop instead: \`vinaya dev-review-loop --resume ${existingPr.number}\`.`
    )
  }

  // issue-711 O5: a paused task's pull request continues from the newest
  // Principal ruling, exactly as `dev-review-loop --resume <pr>` does — it
  // never resumes the Developer's previous session by attaching fresh
  // (`{task: issue}`) instead. Gated on an open PR existing at all (a
  // pause with no PR yet is unreachable — a pause is always posted against
  // an already-open pull request) so a task that has never been paused
  // (`deps.hasPauseState` false) takes the exact same fresh-dispatch /
  // dead-lock-takeover path as before this task.
  const shouldResumeFromPause = existingPr !== null && deps.hasPauseState(issue)
  const loopResult = await deps.devReviewLoop(
    shouldResumeFromPause
      ? { resumePr: existingPr.number, agent, ...(resolvedModel ? { model: resolvedModel } : {}) }
      : { task: issue, agent, ...(resolvedModel ? { model: resolvedModel } : {}) }
  )
  const prUrl = await resolvePrUrl(deps.resolveRepo, loopResult.prNumber)
  return { ...loopResult, prUrl }
}
