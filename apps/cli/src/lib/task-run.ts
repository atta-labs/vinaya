/**
 * `runTask` — the one lib function `vinaya task run <tranche> <n> --agent
 * <vendor>` calls (`commands/task-run.ts`). Composes `prepareTask`
 * (`dispatch-task.js`, task 1) with `devReviewLoop` (`dev-review-loop.js`,
 * unchanged) — nothing else. `prepareTask` renders and freezes the brief and
 * starts no agent under any circumstances (its own doc comment); the loop's
 * own round-1 entry reads that frozen brief off the Issue
 * (`fetchFrozenBrief`) and is the ONLY place a developer is ever dispatched
 * from a fresh task — so a developer is started exactly once by
 * construction, never by anything this file does.
 *
 * `--agent` is never passed into `prepareTask` (Traps to avoid) — preparation
 * is agent-agnostic; only `devReviewLoop`'s own `LoopInput.agent` field
 * carries it, exactly once.
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
  devReviewLoop as realDevReviewLoop,
  findOpenPrForBranch as realFindOpenPrForBranch,
  type LoopResult
} from './dev-review-loop.js'
import { isDriverPidAlive, readDriverLock } from './dev-review-loop/pause-resume.js'
import { outboxRoot } from './dev-review-loop/reviewer-dispatch.js'
import {
  DispatchTaskError,
  prepareIssueTask as realPrepareIssueTask,
  prepareTask as realPrepareTask,
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
 * `runTask` propagates it unchanged — nothing started (O3).
 */
const ALREADY_DISPATCHED_PATTERN = /is already dispatched/

/** Pure: true iff `err` is `prepareTask`'s specific "already dispatched" refusal, never any other `DispatchTaskError`. */
export function isAlreadyDispatchedError(err: unknown): boolean {
  return err instanceof DispatchTaskError && ALREADY_DISPATCHED_PATTERN.test(err.message)
}

export type RunTaskInput = ({ tranche: string; n: number } | { issue: number }) & { agent: AgentVendor }
/**
 * `prUrl` — the published/paused PR's real `https://github.com/<owner>/<repo>/pull/<n>`
 * URL, per Issue #480's own Sizing story ("...runs the loop to publish and
 * exits zero printing the PR URL"). `LoopResult` itself carries no URL field
 * (`dev-review-loop.ts` is unmodified — out of this task's Surface), so it is
 * constructed here from `resolveRepo()` plus the loop's own `prNumber`.
 * `null` only when the repo genuinely cannot be resolved (no git remote, an
 * unparseable `AEG_REPO`) — the same tolerance `dev-review-loop.ts`'s own
 * `resolveRepo().catch(() => null)` already extends to this exact failure,
 * never a thrown error over a display-only nicety.
 */
export type RunTaskResult = LoopResult & { prUrl: string | null }

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
   * O5 (Issue #583) — true only when this task's driver lock names a
   * PID that is actually still alive. An open PR alone is no longer
   * grounds to refuse (below): a driver that crashed or was killed leaves
   * its PR behind, and this is what tells that state apart from a driver
   * genuinely still working the task.
   */
  isDriverAlive: (task: number) => boolean
  devReviewLoop: (input: { task: number; agent: AgentVendor }) => Promise<LoopResult>
  resolveRepo: () => Promise<RepoRef | null>
}

/** O5: real production check — a dead or absent lock reads `false`, exactly like `devReviewLoop`'s own entry-gate takeover check (`dev-review-loop.ts`'s `existingDriverLock`/`isDriverPidAlive`), read here from the SAME on-disk shape rather than a second one. */
function realIsDriverAlive(task: number): boolean {
  const lock = readDriverLock(outboxRoot(), task)
  return lock !== null && isDriverPidAlive(lock.pid)
}

const defaultRunTaskDeps: RunTaskDeps = {
  prepareTask: realPrepareTask,
  prepareIssueTask: realPrepareIssueTask,
  assembleAndRenderBrief: realAssembleAndRenderBrief,
  assembleAndRenderBriefForIssue: realAssembleAndRenderBriefForIssue,
  developerBranchFor: realDeveloperBranchFor,
  findOpenPrForBranch: realFindOpenPrForBranch,
  isDriverAlive: realIsDriverAlive,
  devReviewLoop: realDevReviewLoop,
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
 *    is caught and treated as "reuse, don't re-post" (O3): the Issue number
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
export async function runTask(input: RunTaskInput, deps: RunTaskDeps = defaultRunTaskDeps): Promise<RunTaskResult> {
  const { agent } = input
  const taskLabel = 'tranche' in input ? `task ${input.n} in tranche \`${input.tranche}\`` : `Issue #${input.issue}`

  let issue: number
  try {
    issue =
      'tranche' in input
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
        `runTask: ${taskLabel} was already dispatched, but re-resolving its Issue number failed:\n${rendered.missing.map((m) => `  - ${m}`).join('\n')}`
      )
    }
    issue = rendered.issue
  }

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
  // O5 (Issue #583): an open PR alone is no longer grounds to refuse — a
  // driver that crashed or was killed leaves its PR (and, sometimes, a held
  // pause) behind, and `task run --issue <n>` is the one command that
  // revives it, in ANY state, rather than pointing at `--resume` (which
  // needs a pause to resume FROM, and refuses when there is none — the
  // exact gap this closes). Only a driver ACTUALLY still running this task
  // is still refused, to avoid a genuinely concurrent second developer.
  if (existingPr && deps.isDriverAlive(issue)) {
    throw new RunTaskError(
      `runTask: ${taskLabel}'s developer branch \`${branch}\` already has an open pull request (#${existingPr.number}), and a driver is already running for it — refusing to start a second developer. Resume the review loop instead: \`vinaya dev-review-loop --resume ${existingPr.number}\`.`
    )
  }

  const loopResult = await deps.devReviewLoop({ task: issue, agent })
  const prUrl = await resolvePrUrl(deps.resolveRepo, loopResult.prNumber)
  return { ...loopResult, prUrl }
}
