import type { LoopRunContext } from './run-context.js'
import { withBeyondSurfaceRecord as sharedWithBeyondSurfaceRecord } from '../../actions/live-developer-context.js'
import { syncBeyondSurfaceRecord as sharedSyncBeyondSurfaceRecord } from '../../actions/live-developer-context.js'
import { recordDeveloperModelRun } from './developer-dispatch.js'
import { readDeveloperModelRuns } from './developer-dispatch.js'
import { writeDeveloperModelRuns } from './developer-dispatch.js'

import { withDeveloperModelsLine } from './developer-dispatch.js'
import { appendRoleLine } from '../../../../../../kernel/log/client/loop-log.js'
import type { PublicationRefusal } from './git-defaults.js'
import { publishingInstructionLine } from './driver-helpers.js'

import { readPublicationBase as sharedReadPublicationBase } from '../../actions/live-developer-context.js'
import { resolvePublicationBase as sharedResolvePublicationBase } from '../../actions/live-developer-context.js'
import type { DevToolContext } from '../../../../../../kernel/tools/dev-tools-server.js'
import { attributeDriverToolCalls as sharedAttributeDriverToolCalls } from '../../actions/live-developer-context.js'
import { sourceStoreDir } from '../../../../../../kernel/source-manifest.js'
import { sourceReceiptsPath } from '../../../../../../kernel/source-manifest.js'
import type { ReviewerSourceFacts } from './reviewer-dispatch.js'
import { readRequiredSourceManifest } from '../../../../../../kernel/source-manifest.js'
import { reviewerSourceFacts } from './reviewer-dispatch.js'
import { sourceUsesFromRecords } from './turn-result.js'
import { readTurnResultRecords } from './turn-result.js'
import type { BridgeInvocation } from '../../../../../../kernel/tools/dev-tools-registration.js'
import { existsSync } from 'node:fs'
import { worktreePathForBranch } from './developer-prompts.js'
import { createReadSourceTool } from '../../../../../../kernel/tools/read-source.js'
import { gitObjectReader } from '../../../../../../kernel/tools/source-provider.js'
import { devToolsSocketPath } from '../../../../../../kernel/tools/dev-tools-registration.js'
import { reviewerDevToolContext } from '../../../../../../kernel/tools/dev-tools-server.js'
import type { RequiredSourceManifest } from '../../../../../../kernel/source-manifest.js'

import { extractSourceRevision } from '../../../../tools/task-contract/brief-render'

import { realSourceProviderDeps } from '../../../../../../kernel/tools/source-provider.js'
import { prepareSources } from '../../../../../../kernel/tools/source-provider.js'
import { RequiredSourcesUnavailable } from '../../../../../../kernel/tools/source-provider.js'
import type { LivePublicationScope } from '../../actions/live-developer-context.js'
import { createLiveDeveloperContext } from '../../actions/live-developer-context.js'
import { ownChangesRangeBase } from './git-defaults.js'
import { defaultGitWorktreeUntrackedPaths } from './git-defaults.js'
import { worktreeCheckEnv } from './developer-defaults.js'
import { publishDeveloperTurn as sharedPublishDeveloperTurn } from '../../actions/live-developer-context.js'

import { noPushPauseDetail } from './unpushed-work.js'
import { publicationRefusal } from './developer-defaults.js'
import { recoverDeveloperLaunch } from './developer-dispatch.js'
import { LaunchContinuityLost } from './developer-dispatch.js'
import { freshDispatchLogLine } from './developer-dispatch.js'

/**
 * `body` with its `VINAYA:BEYOND-SURFACE` block rewritten to list every path
 * the task branch changed (from its merge base, the same three-dot diff
 * the `surface-scope` check reads) that the task's Surface does not cover
 * — the driver's own marked region, replaced on every body write the way
 * the `**For:**` line is, so an agent edit to it never survives. The
 * block is written empty when the Surface, the head or the merge base
 * cannot be read, so a list the agent wrote never survives a read failure.
 */
export async function withBeyondSurfaceRecord(c: LoopRunContext, body: string): Promise<string> {
  return sharedWithBeyondSurfaceRecord(liveContextScope(c), body)
}

/** Rewrite the open pull request's `VINAYA:BEYOND-SURFACE` block after the branch moved — a no-op with no open pull request or no change to the block. Never throws: a failed write is logged, and the next body write records it. */
export async function syncBeyondSurfaceRecord(c: LoopRunContext, pr: number | null): Promise<void> {
  return sharedSyncBeyondSurfaceRecord(liveContextScope(c), pr)
}

export async function recordDeveloperModel(c: LoopRunContext, roundNum: number): Promise<void> {
  const { d, root, task, dispatchModel, dispatchAgent, branch, repo, loopLogPath } = c

  const recorded = recordDeveloperModelRun(readDeveloperModelRuns(root, task), dispatchModel ?? dispatchAgent, roundNum)
  writeDeveloperModelRuns(root, task, recorded)
  try {
    const pr = c.prNumber > 0 ? c.prNumber : (d.findOpenPrForBranch(branch)?.number ?? null)
    if (pr === null) return
    const body = d.fetchPrBody(pr)
    const next = await withBeyondSurfaceRecord(c, withDeveloperModelsLine(body, recorded))
    if (next !== body) await d.updatePrBody({ prNumber: pr, body: next, repo: repo })
  } catch (err) {
    appendRoleLine(
      loopLogPath,
      'dev-review-loop',
      `for_line_update_failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

export function publicationRefusalPrompt(c: LoopRunContext, refusal: PublicationRefusal): string {
  return [
    `The driver's publication check \`${refusal.check}\` refused your previous turn:`,
    refusal.reason,
    `Fix the problem above and end your turn — ${publishingInstructionLine()}`
  ].join('\n\n')
}

/**
 * O7: read the task branch's base (its merge base with the default
 * branch) for `worktreeHead`, recording nothing — the publication check
 * compares it against the base recorded before the attempt, so a refused
 * attempt never moves that expectation. Never throws.
 */
export async function readPublicationBase(c: LoopRunContext, worktreeHead: string | null): Promise<string | null> {
  return sharedReadPublicationBase(liveContextScope(c), worktreeHead)
}

/** Reads the base and records it as the expected base when none is recorded or it descends from the recorded one (`resolvePublicationBase`). */
export async function resolvePublicationBase(c: LoopRunContext, worktreeHead: string | null): Promise<string | null> {
  return sharedResolvePublicationBase(liveContextScope(c), worktreeHead)
}

/**
 * O2/O3: the gate-backed `DevToolContext` this turn's driver-run server
 * answers — the seven tools bound to the loop's own publication machinery,
 * each behind the gates publishing already has (`createDeveloperDevToolContext`).
 * Built fresh per dispatch so every read is current; the gates
 * (commit-header, publication-preconditions, PR-body, protected-path,
 * pre-push) run in THIS driver process, outside the agent's sandbox, so the
 * agent holds no forge credential of its own (O4). The forge-touching side
 * effects are the injected `d.*` closures the harness fakes (O5).
 */
/**
 * O1: the four dev-tools calls that write effect and ownership records
 * into the control store (commit and push, open pull request, replace the
 * body, refresh evidence) run inside the Developer's
 * `TurnWriteAttribution.driverToolCall`, so those records are attributed
 * to the driver, while a control-store write the worker made between tool
 * calls is still reported by `checkTurnConfinement`. `fetchDocumentation`
 * is wrapped too: it appends a read receipt, a protected path the driver
 * writes, so the receipt is the driver's. `readPullRequest` and
 * `runChecks` write no control record and stay unwrapped: wrapping a call
 * widens the window in which a concurrent worker write is attributed to
 * the driver, and `runChecks` can run long.
 */
export function attributeDriverToolCalls(c: LoopRunContext, context: DevToolContext): DevToolContext {
  return sharedAttributeDriverToolCalls(context, (call) => {
    const attribution = c.turnConfinementByRole.get('developer')
    return attribution ? attribution.driverToolCall(call) : call()
  })
}

/** This task's controller-owned source store — the required-source manifest, its snapshots and every delivery receipt, under `control/`. */
export function sourceStoreForTask(c: LoopRunContext): string {
  const { root, task } = c

  return sourceStoreDir(root, task)
}

/** This task's delivery receipts — written only by the controller and its `fetch_documentation` tool; completion reads nothing else. */
export function documentationReceiptsPathForTask(c: LoopRunContext): string {
  return sourceReceiptsPath(sourceStoreForTask(c))
}

/**
 * What both reviewers of `roundNum` are told about its required sources:
 * the manifest the round's Developer was given — this process's own, or
 * the one in the store when a fresh process attached to the round — and
 * the citations of the round's newest accepted `completed` turn result.
 * Nothing when there is no manifest or it names no source.
 */
export function roundReviewerSources(c: LoopRunContext, roundNum: number): { requiredSources?: ReviewerSourceFacts } {
  const { root, task } = c

  const manifest = c.preparedSourcesByRound.get(roundNum) ?? readRequiredSourceManifest(sourceStoreForTask(c))
  if (manifest === null || manifest.sources.length === 0) return {}
  return {
    requiredSources: reviewerSourceFacts(manifest, sourceUsesFromRecords(readTurnResultRecords(root, task, roundNum)))
  }
}

/**
 * Starts one reviewer's own tool server — `read_source` over the manifest
 * its prompt names, served for that reviewer's role only — and returns
 * the bridge its session registers. `null` when the round has no
 * required source: that reviewer is dispatched with no tool server, as
 * before. Each role gets its own socket, since both reviewers run at once.
 */
export async function startReviewerSourceTools(
  c: LoopRunContext,
  dispatchRoleName: 'code-reviewer' | 'security',
  sources: ReviewerSourceFacts | undefined
): Promise<{ bridge: BridgeInvocation; close: () => Promise<void> } | null> {
  const { d, repo, task } = c

  if (sources === undefined || sources.sources.length === 0) return null
  const worktree = existsSync(worktreePathForBranch(c)) ? worktreePathForBranch(c) : process.cwd()
  const readSource = createReadSourceTool({
    storeDir: sourceStoreForTask(c),
    manifestDigest: sources.manifestDigest,
    readObject: d.readSourceObject ?? gitObjectReader(worktree)
  })
  return d.startDevTools({
    socketPath: devToolsSocketPath(`${repo ? `${repo.owner}/${repo.repo}` : 'local'}:${task}:${dispatchRoleName}`),
    context: reviewerDevToolContext(readSource),
    role: dispatchRoleName
  })
}

/**
 * Prepares the round's required sources — once per round in this driver
 * process, so every round and every resume (a fresh process) prepares
 * them again, and a re-ask inside one round reuses the round's manifest.
 * Repository sources are pinned at the frozen brief's own base revision,
 * falling back to the worktree's head when the brief names none. Throws
 * `RequiredSourcesUnavailable` when any required source is unavailable,
 * which the loop turns into a `missing_source` pause: the turn never
 * starts on model memory in its place.
 */
export async function prepareRoundSources(c: LoopRunContext, roundNum: number): Promise<RequiredSourceManifest> {
  const { d, task } = c

  const cached = c.preparedSourcesByRound.get(roundNum)
  if (cached !== undefined) return cached
  const brief = d.fetchFrozenBrief(task)
  const worktree = existsSync(worktreePathForBranch(c)) ? worktreePathForBranch(c) : null
  const base = extractSourceRevision(brief) ?? (worktree !== null ? d.readWorktreeHead(worktree) : null)
  const deps = realSourceProviderDeps(worktree ?? process.cwd(), d.fetchDocumentationDeps)
  const prepared = await prepareSources({
    brief,
    round: roundNum,
    base,
    storeDir: sourceStoreForTask(c),
    deps: d.readSourceObject ? { ...deps, readObject: d.readSourceObject } : deps
  })
  if (prepared.unavailable.length > 0) throw new RequiredSourcesUnavailable(prepared.unavailable)
  c.preparedSourcesByRound.set(roundNum, prepared.manifest)
  return prepared.manifest
}

export function liveContextScope(c: LoopRunContext): LivePublicationScope {
  const { d, root, task, branch, repo, loopLogPath, publicationState } = c

  return {
    d,
    task: task,
    branch: branch,
    repo: repo,
    worktree: worktreePathForBranch(c),
    runtimeRoot: root,
    loopLogPath: loopLogPath,
    state: publicationState
  }
}

export function buildDeveloperDevToolContext(c: LoopRunContext, roundNum: number): DevToolContext {
  const { dispatchAgent } = c

  return createLiveDeveloperContext({
    ...liveContextScope(c),
    agent: dispatchAgent,
    round: () => roundNum,
    helpers: { ownChangesRangeBase, defaultGitWorktreeUntrackedPaths, worktreeCheckEnv }
  })
}

/**
 * O1/O2/O3/O4/O5/O7: the driver's own publication of a Developer turn —
 * run right after every dispatch returns and before any poll. Commits the
 * uncommitted changes under the Developer's validated header (O2, recording
 * the SHA before the push, O8), pushes the task branch through the Broker
 * (O3), and opens the pull request from the body file when none is open
 * (O3) — each a no-op when there is nothing new to do (O5). The
 * pre-publication checks (O7) run before any commit or credential use. A
 * failed check or invalid/missing header is a reask; a refused push (O4)
 * records the hook's own text in `lastPushRefusal` for the existing
 * mechanical-failure path and returns `push_refused`.
 */
export async function publishDeveloperTurn(c: LoopRunContext, _roundNum: number): Promise<PublishTurnResult> {
  const { d, branch, task } = c

  // O4: the driver no longer commits, pushes or opens a pull request on its
  // own after a turn. The Developer publishes through the driver-run tools
  // (`publish_changes`, `open_pull_request`, `update_pull_request_body`,
  // `refresh_evidence`) DURING its turn — each running IN THIS driver,
  // behind the very gates this step used to run (commit-header,
  // publication-preconditions, protected-path, pre-push, PR-body;
  // `createDeveloperDevToolContext`). This step only DETECTS work the turn
  // left unpublished and re-asks the SAME session to call the tool; it
  // writes nothing to the forge itself.
  return sharedPublishDeveloperTurn({
    worktreePath: worktreePathForBranch(c),
    branch: branch,
    turnPreStop: c.turnPreStop,
    findOpenPullRequest: () => d.findOpenPrForBranch(branch),
    readUnpushedWork: d.readUnpushedWorkDetail,
    fetchDeveloperStop: () => d.fetchDeveloperStop(task),
    noPushDetail: noPushPauseDetail,
    refusal: publicationRefusal
  }) as PublishTurnResult
}

/**
 * O3: reconcile the developer's prior launch before resuming it, at every
 * seam that used to read the durable resume record blind. A prior launch
 * whose child is still running, or one whose required session is gone,
 * both throw `LaunchContinuityLost` — the loop's own outer handler turns it
 * into a decided `pause{reason:'infrastructure'}` (`harness/processes/vinaya-strict/loops/dev-review/loop.md`),
 * so a second worker never races the first and a lost session pauses
 * explicitly instead of silently starting fresh. A recoverable session
 * (now including one bound on an INTERRUPTED attempt — O1) sets
 * `devResumeId` to the exact session. A launch that ended without ever
 * binding a session is `fresh`, never a pause: there is no session and
 * no turn state to lose, so the round dispatches a fresh developer
 * session (a sign-in failure used to block the task here forever).
 * `none` — no launch record, the
 * common case, and the only case every existing fixture reaches with its
 * scratch `$HOME` — falls back to the durable resume-record read the loop
 * already used, unchanged.
 */
export function reconcileDeveloperResume(c: LoopRunContext, artifactsPresent: boolean): void {
  const { d, task, dispatchAgent, repo, loopLogPath } = c

  const recon = recoverDeveloperLaunch(task, dispatchAgent, repo, { artifactsPresent })
  if (recon.kind === 'live') {
    throw new LaunchContinuityLost(
      `a prior dispatched developer launch (pid ${recon.record.childPid}) is still running for task ${task} — refusing to start a second worker on the same task`
    )
  }
  if (recon.kind === 'pause') throw new LaunchContinuityLost(recon.detail)
  if (recon.kind === 'resume') {
    c.devResumeId = recon.resumeId
    return
  }
  if (recon.kind === 'fresh') {
    // A launch that ended before binding a session (a refusal before
    // spawn, a signal, a sign-in failure) — narrated in this driver's
    // own role log with its outcome and reason, never a pause: no session
    // ever existed, so the dispatch below simply starts a fresh one. Falls
    // through to the same resume-record read as 'none': that record is the
    // bound-session view of this very launch record, so it reads `null`
    // here and leaves whatever session an EARLIER attempt bound intact
    // rather than throwing continuity away on this attempt's account.
    appendRoleLine(loopLogPath, 'dev-review-loop', freshDispatchLogLine(recon))
  }
  // 'none' | 'finished' | 'fresh' — no continuity-required session to reconcile;
  // fall back to the durable resume-record read the loop already used.
  const rec = d.readResumeRecord(task, dispatchAgent, repo)
  if (rec) c.devResumeId = rec.resumeId
}

export type PublishTurnResult = { kind: 'nothing' } | { kind: 'published' } | PublicationRefusal
