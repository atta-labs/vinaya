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

import {
  type AssembleAndRenderBriefResult,
  assembleAndRenderBrief as realAssembleAndRenderBrief
} from './brief-assembly.js'
import type { AgentVendor } from './dispatch.js'
import {
  developerBranchFor as realDeveloperBranchFor,
  devReviewLoop as realDevReviewLoop,
  findOpenPrForBranch as realFindOpenPrForBranch,
  type LoopResult
} from './dev-review-loop.js'
import { DispatchTaskError, prepareTask as realPrepareTask, type PrepareTaskResult } from './dispatch-task.js'

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

export type RunTaskInput = { tranche: string; n: number; agent: AgentVendor }
export type RunTaskResult = LoopResult

/**
 * Injection seam for `apps/cli/tests/lib/task-run.test.ts` — same convention
 * `dispatch-task.ts`'s own `DispatchTaskDeps`/`PrepareTaskDeps` already use.
 * `prepareTask` and `devReviewLoop` are the two real functions this task's
 * Surface calls unmodified; every field defaults to them.
 */
export type RunTaskDeps = {
  prepareTask: (input: { tranche: string; n: number }) => Promise<PrepareTaskResult>
  assembleAndRenderBrief: (tranche: string, taskId: string) => Promise<AssembleAndRenderBriefResult>
  developerBranchFor: (issueNumber: number) => string
  findOpenPrForBranch: (branch: string) => OpenPrRef | null
  devReviewLoop: (input: { task: number; agent: AgentVendor }) => Promise<LoopResult>
}

const defaultRunTaskDeps: RunTaskDeps = {
  prepareTask: realPrepareTask,
  assembleAndRenderBrief: realAssembleAndRenderBrief,
  developerBranchFor: realDeveloperBranchFor,
  findOpenPrForBranch: realFindOpenPrForBranch,
  devReviewLoop: realDevReviewLoop
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
  const { tranche, n, agent } = input

  let issue: number
  try {
    const prep = await deps.prepareTask({ tranche, n })
    issue = prep.issue
  } catch (err) {
    if (!isAlreadyDispatchedError(err)) throw err
    const rendered = await deps.assembleAndRenderBrief(tranche, String(n))
    if (!rendered.ok) {
      throw new RunTaskError(
        `runTask: task ${n} in tranche \`${tranche}\` was already dispatched, but re-resolving its Issue number failed:\n${rendered.missing.map((m) => `  - ${m}`).join('\n')}`
      )
    }
    issue = rendered.issue
  }

  const branch = deps.developerBranchFor(issue)
  const existingPr = deps.findOpenPrForBranch(branch)
  if (existingPr) {
    throw new RunTaskError(
      `runTask: task ${n} in tranche \`${tranche}\`'s developer branch \`${branch}\` already has an open pull request (#${existingPr.number}) — refusing to start a second developer. Resume the review loop instead: \`vinaya dev-review-loop --resume ${existingPr.number}\`.`
    )
  }

  return deps.devReviewLoop({ task: issue, agent })
}
