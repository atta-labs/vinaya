import type { AgentVendor } from '../../dispatch/dispatch.js'
import { fetchPrBody } from './developer-dispatch.js'
import { taskFromPrBody } from './developer-dispatch.js'
import { readPauseState } from './pause-resume.js'
import { fetchRulings } from './developer-dispatch.js'
import { fetchNewestRulingOrdinal } from './developer-dispatch.js'
import { fetchNewestRulingAuthor } from './developer-dispatch.js'
import { fetchIssueRulings } from './developer-dispatch.js'
import { fetchNewestIssueRulingOrdinal } from './developer-dispatch.js'
import { fetchNewestIssueRulingAuthor } from './developer-dispatch.js'
import { findOpenPrForBranch } from './developer-dispatch.js'
import { runtimeDir } from './reviewer-dispatch.js'
import type { LogSinkDeps } from '../../../../../../kernel/log/log-sink.js'
import { resolveRepo } from '../../../../../../kernel/adapters/code-host/github/resolve-repo'
import { resolveVinayaLogAppendPath } from '../../../../integration/log/log-sink-factory.js'
import { defaultSleep } from './runtime-defaults.js'
import { defaultTerminateInFlightLaunchesOnShutdown } from './runtime-defaults.js'
import { markProcessUnattended } from '../../../../../../kernel/run-paths.js'
import { bindPauseToPullRequest } from './pause-resume.js'
import { escalationPrOf } from './pause-resume.js'
import { escalationIdFor } from './pause-resume.js'
import { readEscalationRecord } from './pause-resume.js'
import { isAgentVendor } from '../../dispatch/dispatch.js'
import type { ResolveEscalationResult } from './pause-resume.js'
import { resolveEscalation } from './pause-resume.js'
import { WrongTargetResolutionError } from './pause-resume.js'
import { StaleEscalationError } from './pause-resume.js'
import { ReplayedResolutionError } from './pause-resume.js'
import { missingEscalationNextStep } from './pause-resume.js'
import { cleanupAllStagedAgentConfigs } from './reviewer-isolation.js'
import { fenceStartedEffectsAsUncertain } from './pause-resume.js'
import { randomUUID } from 'node:crypto'
import type { DevReviewLoopEventInput } from '../../../../tools/dev-review-policy/types'
import { sizeOfSafe } from './round-assess.js'
import { createVinayaLogSink } from '../../../../integration/log/log-sink-factory.js'
import { waitForOwnLoopLine } from './round-assess.js'

// --- cancel (O3) -------------------------------------------------------

/**
 * A cancel names EITHER the paused run's pull request (`cancelPr`, the
 * ordinary case — the task itself is derived from that pull request's own
 * `Closes #N`) or, for a pause recorded before any pull request existed, the
 * task directly (`cancelTask`): there is no pull request body to derive a task
 * from, and no pull request to read a ruling off, so that pause is addressed
 * and authenticated through its own Issue. Passing the absent pull request as
 * a `-1` sentinel is what made such a pause uncancellable.
 */
export type CancelInput = { agent: AgentVendor } & ({ cancelPr: number } | { cancelTask: number })

export type CancelResult = { task: number; escalationId: string; fencedEffectKeys: string[] }

export type CancelDeps = {
  fetchPrBody: typeof fetchPrBody
  taskFromPrBody: typeof taskFromPrBody
  readPauseState: typeof readPauseState
  fetchRulings: typeof fetchRulings
  fetchNewestRulingOrdinal: typeof fetchNewestRulingOrdinal
  fetchNewestRulingAuthor: typeof fetchNewestRulingAuthor
  /** The Issue-target ruling readers — used only for a pause that has no pull request, and gated by the identical principal allowlist their pull-request siblings above apply (`developer-dispatch.ts`). */
  fetchIssueRulings: typeof fetchIssueRulings
  fetchNewestIssueRulingOrdinal: typeof fetchNewestIssueRulingOrdinal
  fetchNewestIssueRulingAuthor: typeof fetchNewestIssueRulingAuthor
  /** The open pull request on a branch — what a `--cancel <pr>` against a pause recorded before any pull request existed checks before binding the pause to it. */
  findOpenPrForBranch: typeof findOpenPrForBranch
  runtimeDir: () => string
  resolveLogAppendPath: (repo: { owner: string; repo: string } | null, issue: number) => string | Promise<string>
  /** Overrides for the cancel event's own sink (`createVinayaLogSink`); absent, the sink's defaults. */
  logSink?: Partial<LogSinkDeps>
  resolveRepo: () => Promise<{ owner: string; repo: string } | null>
  terminateInFlightLaunchesOnShutdown: (
    task: number,
    agent: AgentVendor,
    repo: { owner: string; repo: string } | null
  ) => void
  sleep: (ms: number) => Promise<void>
}

export function defaultCancelDeps(): CancelDeps {
  return {
    fetchPrBody,
    taskFromPrBody,
    readPauseState,
    fetchRulings,
    fetchNewestRulingOrdinal,
    fetchNewestRulingAuthor,
    fetchIssueRulings,
    fetchNewestIssueRulingOrdinal,
    fetchNewestIssueRulingAuthor,
    findOpenPrForBranch,
    runtimeDir,
    resolveLogAppendPath: resolveVinayaLogAppendPath,
    resolveRepo: () => resolveRepo().catch(() => null),
    sleep: defaultSleep,
    terminateInFlightLaunchesOnShutdown: defaultTerminateInFlightLaunchesOnShutdown
  }
}

/**
 * O3: cancels a PAUSED run's own escalation — "resume or cancel only their
 * intended run" is this function's own half of that sentence, the mirror of
 * `devReviewLoop`'s `--resume` path above. Never re-enters the round loop
 * (a cancelled run has nothing left to continue): it authenticates the same
 * way `--resume` does (a principal-authored ruling comment on the PR — "the
 * Operator cannot author a ruling," Traps to avoid), consumes the SAME
 * `resolveEscalation` single-consumption guard (so a paused escalation
 * cannot be BOTH resumed and cancelled, nor cancelled twice), requests
 * termination of whichever role is genuinely in flight through task 3's own
 * identity-checked shutdown path (a safe no-op when nothing is), and fences
 * any effect record left `'started'` — a late-arriving reviewer result, or
 * an in-flight forge post — as `'uncertain'` under the SAME epoch the
 * resolution was just consumed under, so a write still trying to complete
 * against the now-superseded epoch is refused by `StaleEpochWriteError` the
 * instant it tries, never silently landing after cancellation.
 */
export async function cancelDevReviewLoop(input: CancelInput, deps: Partial<CancelDeps> = {}): Promise<CancelResult> {
  // Round 2 review (MAJOR) / security review (MEDIUM): a driver runs with no
  // human watching, so it must resolve `runtimeDir` through the
  // default-branch gate rather than trusting the working tree. Marked FIRST,
  // before any path is resolved and before anything is dispatched, so the
  // classification is already true for this process and for every child that
  // inherits its environment.
  markProcessUnattended()
  const d: CancelDeps = { ...defaultCancelDeps(), ...deps }
  // A no-pull-request cancel is addressed by its task directly; every other
  // one derives the task from the pull request it names, unchanged.
  let cancelPr: number | null = null
  let task: number
  if ('cancelPr' in input) {
    cancelPr = input.cancelPr
    const derived = d.taskFromPrBody(d.fetchPrBody(cancelPr))
    if (derived === null) {
      throw new Error(
        `devReviewLoop --cancel: PR #${cancelPr}'s body carries no \`Closes #N\` reference — cannot derive its task.`
      )
    }
    task = derived
  } else {
    task = input.cancelTask
  }
  /** `PR #<n>`, or the task's own Issue for a pause that never had one — the one phrase every refusal below names its target by. */
  const targetLabel = cancelPr === null ? `Issue #${task}` : `PR #${cancelPr}`
  const root = d.runtimeDir()
  let held = d.readPauseState(root, task)
  if (!held) {
    throw new Error(
      `devReviewLoop --cancel: no held pause state found for task ${task} (${targetLabel}) — nothing to cancel.`
    )
  }
  // A pause recorded before any pull request existed is bound to the task's
  // pull request opened since — the same binding `--resume` makes, under the
  // same proof: the open pull request on the pause's own branch, whose body
  // closes this task.
  const openPrOnBranch = cancelPr !== null && held.prNumber === null ? d.findOpenPrForBranch(held.branch) : null
  if (cancelPr !== null && openPrOnBranch?.number === cancelPr) {
    held = bindPauseToPullRequest(root, held, cancelPr)
  }
  // A bound pause still answers to its task directly, as it did before it was
  // bound — its escalation names no pull request.
  const targetsHeld = held.prNumber === cancelPr || (cancelPr === null && escalationPrOf(held) === null)
  if (!targetsHeld) {
    throw new Error(
      `devReviewLoop --cancel: task ${task}'s held pause state names PR #${held.prNumber ?? '(none)'}, not ${targetLabel}. ${
        held.prNumber !== null
          ? `Cancel it with \`vinaya-dev-review-loop --cancel ${held.prNumber}\`.`
          : openPrOnBranch
            ? `It paused before any pull request existed, and the open pull request on its branch \`${held.branch}\` is PR #${openPrOnBranch.number} — cancel it with \`vinaya-dev-review-loop --cancel ${openPrOnBranch.number}\`.`
            : `It paused before any pull request existed and none is open on its branch \`${held.branch}\` now — cancel it with the Operator's \`task_cancel\` for task ${task}.`
      }`
    )
  }
  /** The pull request this pause's escalation and ruling belong to — `null` for one raised before any pull request existed, bound since or not. */
  const escalationPr = escalationPrOf(held)
  /** Where this pause's own comment, and so its ruling, was posted. */
  const rulingLabel = escalationPr === null ? `Issue #${task}` : `PR #${escalationPr}`
  // The ruling is read from wherever this pause's own comment was posted — the
  // pull request when one exists, the task Issue when the pause predates one.
  // Same parser, same principal allowlist, either way
  // (`developer-dispatch.ts`'s own `fetchIssueRulings`).
  const rulings = escalationPr === null ? d.fetchIssueRulings(task) : d.fetchRulings(escalationPr)
  if (rulings.length === 0) {
    throw new Error(
      `devReviewLoop --cancel: ${rulingLabel} carries no Principal ruling comment yet — nothing authenticates this cancel. Cancelling task ${task} needs a Principal ruling posted on ${rulingLabel} first.`
    )
  }
  // See the identical comment on the `--resume` path above.
  const escalationId = held.escalationId ?? escalationIdFor(task, held.round, held.head)
  // Code review, round 2, MAJOR: the operator-typed `--agent` flag used to
  // decide what gets terminated with nothing persisted to check it against.
  // The escalation record now carries the agent the run was ACTUALLY
  // dispatched under (`EscalationFacts.agent`, written at pause time) — read
  // (peeked, never consumed) BEFORE `resolveEscalation` below so a mismatch
  // is refused before the resolution is ever consumed, not after: a
  // mistyped or stale `--agent` must never leave a genuine cancel decision
  // silently recorded while still refusing to act on it. `undefined` only
  // for an escalation record written before this field existed; that legacy
  // case falls back to trusting the operator-supplied value, same as before
  // this fix.
  const peekedEscalation = readEscalationRecord(task, escalationId)
  const dispatchedAgent = peekedEscalation?.agent
  if (dispatchedAgent !== undefined && dispatchedAgent !== input.agent) {
    throw new Error(
      `devReviewLoop --cancel: task ${task}'s escalation was dispatched under agent '${dispatchedAgent}', not '${input.agent}' — refusing to terminate under the wrong agent. Retry with --agent ${dispatchedAgent}.`
    )
  }
  const terminateAgent: AgentVendor =
    dispatchedAgent !== undefined && isAgentVendor(dispatchedAgent) ? dispatchedAgent : input.agent
  const authenticatedBy =
    (escalationPr === null ? d.fetchNewestIssueRulingAuthor(task) : d.fetchNewestRulingAuthor(escalationPr)) ??
    'unknown-principal'
  // `<pr>-<ordinal>` for a pull-request ruling; `issue-<n>-<ordinal>` for one
  // read off the task Issue, so a resolution record names WHERE its decision
  // was read from and never reads as a pull request number that does not exist.
  const authenticatedFrom =
    escalationPr === null
      ? `issue-${task}-${d.fetchNewestIssueRulingOrdinal(task)}`
      : `${escalationPr}-${d.fetchNewestRulingOrdinal(escalationPr)}`
  let resolved: ResolveEscalationResult
  try {
    resolved = resolveEscalation(task, escalationId, escalationPr, 'cancel', authenticatedBy, authenticatedFrom)
  } catch (err) {
    if (
      err instanceof WrongTargetResolutionError ||
      err instanceof StaleEscalationError ||
      err instanceof ReplayedResolutionError
    ) {
      // Mutate the message in place and rethrow the SAME instance — a caller
      // (`task_cancel`'s handler) that needs `instanceof` to tell a replayed
      // cancel apart from a wrong-target/stale one must still be able to,
      // which a fresh `new Error(...)` here would silently lose (code review,
      // MAJOR: this used to throw a plain `Error`, so `instanceof
      // ReplayedResolutionError` downstream could never match a real
      // duplicate cancel request going through this function).
      err.message = `devReviewLoop --cancel: ${err.message}${
        err instanceof StaleEscalationError ? `. ${missingEscalationNextStep(held)}` : ''
      }`
      throw err
    }
    throw err
  }
  const repo = await d.resolveRepo()
  d.terminateInFlightLaunchesOnShutdown(task, terminateAgent, repo)
  // O2: a cancel is terminal — the loop will not resume — so this task's
  // staged per-dispatch agent-config homes are removed, the same end-of-loop
  // cleanup the published path performs.
  cleanupAllStagedAgentConfigs(root, task)
  const fencedEffectKeys = fenceStartedEffectsAsUncertain(task, resolved.epoch)

  // The `cancelled` terminal observation — this
  // command is its own process, with no `LoopConfig.loopId` carried over
  // from whatever run it is cancelling (never persisted anywhere to
  // recover), so it mints one of its own, the same fresh-`loop_id`-per-
  // process convention every other pause/crash event already follows for a
  // NEW process that was never part of the original loop run. `VINAYA_TASK`
  // is set first so this line (and its own `lineage.run`, via
  // `process.env.VINAYA_RUN` below) files under the SAME task outbox every
  // other event for this task already lands in, never the `none` bucket —
  // and restored in the `finally` below, the SAME save/restore-around-one-
  // call discipline `log-flush.ts`'s `logForFlush` already uses. This
  // function is a one-shot CLI command's own process (safe to mutate for its
  // remaining lifetime either way) but is ALSO called in-process, unchanged,
  // from `task-tools/cancel.ts` inside the shared, multi-task `vinaya
  // task-tools serve` MCP server (round 2 security review, HIGH): leaving
  // these globals mutated after this call returns would silently misattribute
  // every later `log()` call in that process — including a completely
  // different task's own `task_resume` — into THIS task's outbox, exactly
  // the fabricated cross-task history O1/O3 forbid.
  const prevTask = process.env.VINAYA_TASK
  const prevRun = process.env.VINAYA_RUN
  process.env.VINAYA_TASK = String(task)
  const cancelLoopId = randomUUID()
  process.env.VINAYA_RUN = cancelLoopId
  const cancelEvent: DevReviewLoopEventInput = {
    kind: 'dev_review_loop',
    payload: {},
    loop_id: cancelLoopId,
    event: 'cancelled',
    round: held.round,
    by: 'principal'
  }
  const cancelOutboxPath = await d.resolveLogAppendPath(repo, task)
  const priorSize = sizeOfSafe(cancelOutboxPath)
  // Its own sink, bound to the SAME repo `cancelOutboxPath` was resolved
  // for, never the process-wide default: the default resolves its repo and
  // destination once, on its first write, so in a long-lived process whose
  // first write resolved another repo this line would land away from
  // `cancelOutboxPath` and the wait below would run out its bound.
  const cancelSink = createVinayaLogSink({ ...d.logSink, resolveRepo: async () => repo })
  try {
    cancelSink.log(cancelEvent)
    await waitForOwnLoopLine(cancelOutboxPath, priorSize, cancelSink.runId, cancelEvent, d.sleep)
    await cancelSink.drain()
  } finally {
    if (prevTask === undefined) delete process.env.VINAYA_TASK
    else process.env.VINAYA_TASK = prevTask
    if (prevRun === undefined) delete process.env.VINAYA_RUN
    else process.env.VINAYA_RUN = prevRun
  }

  return { task, escalationId, fencedEffectKeys }
}
