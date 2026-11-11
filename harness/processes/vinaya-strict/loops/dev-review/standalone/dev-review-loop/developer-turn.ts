import type { LoopRunContext } from './run-context.js'
import type { DispatchHandle } from '../../dispatch/dispatch.js'
import { existsSync } from 'node:fs'
import { worktreePathForBranch } from './developer-prompts.js'

import { appendDriverLine } from '../../../../../../kernel/log/client/loop-log.js'
import { handoffFindingIds } from './run-state.js'
import { recordDeveloperModel } from './developer-context.js'
import { prepareRoundSources } from './developer-context.js'
import { injectedDeliveryReceipts } from '../../../../../../kernel/source-manifest.js'
import { appendSourceDeliveryReceipt } from '../../../../../../kernel/source-manifest.js'
import { documentationReceiptsPathForTask } from './developer-context.js'
import { requiredSourcesPromptBlock } from '../../../../../../kernel/source-manifest.js'

import { buildDeveloperFullPacket } from '../../../../tools/task-contract/context-packet.js'
import { briefHash as briefHashOf } from '../../../../tools/task-contract/review-input-manifest'

import { policyDigest as policyDigestOf } from '../../../../tools/task-contract/review-input-manifest'
import { publishingInstructionLine } from './driver-helpers.js'
import { buildDeveloperDeltaPacket } from '../../../../tools/task-contract/context-packet.js'
import { developerContinuationFacts } from './developer-defaults.js'
import { recoverLoopState } from './pause-resume.js'
import { renderContextPacket } from '../../../../tools/task-contract/context-packet.js'
import { resumeContextBlock } from './developer-prompts.js'
import { switchedAgentContextBlock } from './developer-prompts.js'
import { turnResultInstruction } from './turn-result.js'
import { mergeMovedDefaultBranch as sharedMergeMovedDefaultBranch } from '../../actions/live-developer-context.js'
import { liveContextScope } from './developer-context.js'
import { renderConflictPrompt } from './gate-reading.js'
import { resolvePublicationBase } from './developer-context.js'
import { persistCurrentLoopState } from './run-state.js'

import { snapshotTurnConfinement } from './turn-confinement.js'
import { ensureRunDir } from '../../../../../../kernel/run-paths.js'
import { runPath } from '../../../../../../kernel/run-paths.js'

import { writeFileSync } from 'node:fs'
import { surfaceOpenedAgentConfigPaths } from './driver-helpers.js'
import { devToolsSocketPath } from '../../../../../../kernel/tools/dev-tools-registration.js'
import { attributeDriverToolCalls } from './developer-context.js'
import { buildDeveloperDevToolContext } from './developer-context.js'
import { withPromptFile } from './developer-dispatch.js'
import { MAX_INFRASTRUCTURE_RETRIES } from './round-assess.js'
import { gatePollEnvOverride } from './runtime-defaults.js'
import { reconcileDeveloperResume } from './developer-context.js'
import { logEvents } from './run-logging.js'
import { assertDispatchOrEscalate } from './round-assess.js'
import { recordDeveloperAttempt } from '../../../../tools/dev-review-policy/assess-round'

import type { PublicationRefusal } from './git-defaults.js'
import { checkTurnConfinement } from './turn-confinement.js'
import { developerScanTexts } from './turn-confinement.js'
import { describeTurnConfinementViolation } from './turn-confinement.js'
import { waitOutRateLimitForToolingReport } from './developer-result.js'
import { rerunRedCheckForToolingReport } from './ci-gate.js'
import { reportsTestFailure } from './developer-result.js'
import { endsInEscalation } from './developer-result.js'
import { publishDeveloperTurn } from './developer-context.js'
import { PublicationRefusalPause } from './developer-defaults.js'
import { publicationRefusalPrompt } from './developer-context.js'
import { settleTurnResult } from './developer-result.js'

export async function dispatchDeveloperOnce(
  c: LoopRunContext,
  promptText: string,
  roundNum: number,
  opts: { skipResumeContext?: boolean; developerFiles?: readonly string[] }
): Promise<DispatchHandle> {
  const { d, root, branch, loopLogPath, dispatchModel, dispatchAgent, task, publicationState, repo, config } = c

  const isResume = c.devResumeId !== null
  // A branch that holds task commits on the remote while this machine has no
  // worktree for it (a task continued from another machine) gets its
  // worktree from the pushed head now; a failure throws, which pauses as an
  // infrastructure pause rather than dispatching a Developer with no worktree.
  if (!existsSync(worktreePathForBranch(c))) {
    let remoteBranchHead: string | null = null
    try {
      remoteBranchHead = d.resolveHead(branch)
    } catch {
      remoteBranchHead = null
    }
    // A pushed head this machine has never fetched cannot be an ancestor of
    // its default branch, so an ancestry check that cannot resolve it means
    // the branch holds task commits.
    let hasTaskCommits = remoteBranchHead !== null
    if (remoteBranchHead !== null) {
      try {
        hasTaskCommits = !d.gitIsAncestor(remoteBranchHead, d.gitRevParseOriginMain())
      } catch {
        hasTaskCommits = true
      }
    }
    if (hasTaskCommits) {
      try {
        d.createTaskWorktreeFromRemote(branch)
      } catch (err) {
        throw new Error(
          `could not create the task worktree for branch ${branch} at ${worktreePathForBranch(c)} from origin: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  }
  // The worktree's own dependencies are installed once per driver process,
  // before the Developer's model is recorded or any prompt is built, so the
  // first command resolves inside the worktree. A failure throws and pauses
  // as an infrastructure pause; it is never logged and continued.
  if (!c.worktreeDependenciesInstalled && existsSync(worktreePathForBranch(c))) {
    const installStartedAt = d.now()
    d.installWorktreeDependencies(worktreePathForBranch(c))
    // Only a return reaches this line, so the log never claims a ready
    // worktree that then pauses.
    appendDriverLine(
      loopLogPath,
      `Worktree dependencies ready in ${worktreePathForBranch(c)} after ${((d.now() - installStartedAt) / 1000).toFixed(1)}s`,
      'done'
    )
    c.worktreeDependenciesInstalled = true
  }
  // This is the same handoff the controller uses in settleTurnResult.
  // Passing it into the launcher makes the vendor schema turn-specific.
  const turnResultKnownFindingIds = handoffFindingIds(c)
  await recordDeveloperModel(c, roundNum)
  appendDriverLine(loopLogPath, `Developer starting round ${roundNum} with ${dispatchModel ?? dispatchAgent}`, 'round')
  // The round's required sources are prepared, and the repository ones
  // recorded as injected, by the controller before every dispatch — the
  // first prompt, every later round, every resume and every re-ask —
  // and before this turn's protected-path snapshot, so the controller's
  // own writes to its source store are never read as the worker's.
  const sourceManifest = await prepareRoundSources(c, roundNum)
  for (const receipt of injectedDeliveryReceipts(sourceManifest, new Date(d.now()).toISOString())) {
    appendSourceDeliveryReceipt(documentationReceiptsPathForTask(c), receipt)
  }
  const sourcesBlock = requiredSourcesPromptBlock(sourceManifest)
  const packetHead =
    c.prNumber > 0 ? d.resolveHead(branch) : (d.readWorktreeHead(worktreePathForBranch(c)) ?? d.gitRevParseOriginMain())
  const packetBase = await d.gitMergeBase(packetHead)
  const packetObjectives = d.resolveIssueObjectives(task)
  const packetRulings = c.prNumber > 0 ? d.fetchRulings(c.prNumber) : d.fetchIssueRulingsAfterBrief(task)
  const packetBrief = d.fetchFrozenBrief(task)
  const retainedPacket = buildDeveloperFullPacket({
    brief: packetBrief ?? promptText,
    briefDigest: briefHashOf(packetBrief),
    objectives: packetObjectives.objectives.map((o) => `${o.id}: ${o.text}`).join('\n'),
    objectivesVersion: packetObjectives.version ?? 'none',
    rulings: packetRulings,
    rulingOrdinal: c.prNumber > 0 ? d.fetchNewestRulingOrdinal(c.prNumber) : packetRulings.length,
    policyDigest: policyDigestOf(c.policy),
    baseSha: packetBase,
    headSha: packetHead,
    preparedSources: sourceManifest.sources.map((source) => ({
      ref: `source:${source.sourceId}`,
      version: source.contentDigest ?? source.snapshotRef ?? 'unavailable'
    })),
    capabilities: ['Execute only this frozen brief on the task branch.', publishingInstructionLine()],
    toolCatalog: [
      'fetch_documentation',
      'run_checks',
      'publish_changes',
      'open_pull_request',
      'update_pull_request_body',
      'refresh_evidence',
      'read_pull_request'
    ],
    expectedResult: 'DeveloperTurnResult schema version 1',
    budgets: [`review rounds: ${c.policy.maxRounds}`, `task minutes: ${c.policy.maxTaskMinutes}`],
    stopConditions: ['Honor every stop condition in the frozen brief.']
  })
  // A continuation is built from the durable records alone: the
  // unresolved findings and failing checks from the `loop_state` record,
  // and the prior session from the bound resume record (`devResumeId`),
  // so a restarted driver builds the same packet. Nothing recorded reads
  // as nothing recorded, never as invented text.
  const packet = opts.skipResumeContext
    ? retainedPacket
    : buildDeveloperDeltaPacket({
        retainedPacket,
        previousSessionId: c.devResumeId,
        changedFacts: [{ ref: 'head', version: `sha:${packetHead}` }],
        ...developerContinuationFacts(recoverLoopState(task)),
        constraints: ['Continue the same frozen brief on the same task branch.', publishingInstructionLine()]
      })
  const packetBlock = renderContextPacket(packet)
  const promptPreamble =
    packetBrief !== null && promptText.endsWith(packetBrief) ? promptText.slice(0, -packetBrief.length).trimEnd() : null
  const promptBrief = promptPreamble === null ? promptText : packetBrief
  // O4: no bare-forge-command rule rides the prompt any longer — the
  // Developer holds no `gh`/`git push` credential and publishes only
  // through the driver-run tools, so there is no excluded command to run
  // on its own line. The brief stays the prompt's contiguous suffix.
  // O1: every prompt but round 1's (whose preamble carries it ahead of the
  // brief, which stays the prompt's contiguous suffix) ends with what the
  // turn ends with — its structured turn result. The required-source
  // block leads every prompt, so it never splits the brief.
  const fullPrompt = opts.skipResumeContext
    ? [sourcesBlock, promptPreamble, packetBlock, promptBrief]
        .filter((part): part is string => part !== null && part.length > 0)
        .join('\n\n')
    : [
        sourcesBlock,
        promptPreamble,
        packetBlock,
        resumeContextBlock(c),
        c.agentSwitched ? await switchedAgentContextBlock(c, promptText) : null,
        promptBrief,
        turnResultInstruction(roundNum)
      ]
        .filter((part): part is string => part !== null && part.length > 0)
        .join('\n\n')
  let dispatchPrompt = fullPrompt
  // O1/O3: confine the Developer to
  // its own worktree — this driver's own round-1 `createTaskWorktree`
  // call (above, in the branch-creation branch) or the from-remote creation
  // at the top of this function already created it, so this is non-null in
  // the normal case. `null` only when the branch is a commit-free address
  // reservation whose own worktree creation failed — where
  // `dispatchRole` falls back to the repo root instead (its own doc
  // comment on `unattended`) rather than refusing.
  const devWorktreeDir = existsSync(worktreePathForBranch(c)) ? worktreePathForBranch(c) : null
  // O7: the head the Developer starts this turn from — its own worktree's
  // HEAD, when one exists — recorded so the publication step can confirm
  // the Developer left its work uncommitted (the head did not move). A
  // fresh round-1 turn whose worktree the Developer's own Step 0 is still
  // creating records `null`, and the head check is then inactive.
  // The default branch is merged in BEFORE the head is read, so the base
  // check sees the merge as part of the turn's starting point; a conflict
  // is aborted and its files lead this turn's prompt instead.
  const defaultMerge = devWorktreeDir ? sharedMergeMovedDefaultBranch(liveContextScope(c)) : { conflictFiles: null }
  if (defaultMerge.conflictFiles !== null) {
    dispatchPrompt = [renderConflictPrompt(defaultMerge.conflictFiles, publishingInstructionLine()), fullPrompt].join(
      '\n\n'
    )
  }
  publicationState.turnPreHead = devWorktreeDir ? d.readWorktreeHead(devWorktreeDir) : null
  publicationState.turnPublicationRefusal = null
  publicationState.turnPublicationAttempted = false
  const priorBase = publicationState.publicationExpectedBase
  await resolvePublicationBase(c, publicationState.turnPreHead)
  if (publicationState.publicationExpectedBase !== priorBase)
    persistCurrentLoopState(c, c.currentPhase ?? 'dispatch_developer')
  c.turnPreStop = d.fetchDeveloperStop(task)?.identity ?? null
  // O1/O2: the protected-path snapshot this turn's after-dispatch check
  // (`dispatchDeveloper`, below) compares against — taken here, right
  // before the dispatch, never from a cached copy (Traps to avoid).
  snapshotTurnConfinement(c, 'developer', roundNum)
  // O1/O3: this round's Developer folder — the dispatch-readiness result
  // staged below and the driver's own turn-result records — the parent directory must
  // exist before dispatch, both so a confined Write's own
  // `fs.realpathSync(path.dirname(filePath))` resolves and so a
  // Seatbelt-confined child's `mkdirSync(dirname(path), { recursive:
  // true })` needs only the pre-existing traversal grant.
  ensureRunDir(runPath(root, task, { area: 'developer', round: roundNum }), root)
  // Principal ruling: the driver, never the Developer's own sandbox,
  // runs this task's dispatch-readiness gate — found live, CI, Linux:
  // a `gh` call either `check dispatch-readiness` or `verify-dispatch.ts`
  // makes is spawned by a `bun` process, never typed directly, so it
  // runs INSIDE Claude's sandbox, where the forge token file is denied
  // (`isolation.md` §4a), and both exit 1. Staged here, before every
  // dispatch (round 1, a resume, a reask alike), so the Developer reads
  // a driver-confirmed verdict instead of re-deriving one it cannot
  // actually reach. A NOT READY verdict refuses this turn outright —
  // the same uncaught-error-to-`pause{reason:'infrastructure'}` path
  // every other driver-side gate failure in this file already takes.
  const dispatchReadinessPath = runPath(root, task, {
    area: 'developer',
    round: roundNum,
    file: 'dispatch-readiness.txt'
  })
  const dispatchReadiness = d.checkTaskDispatchReadiness(branch)
  writeFileSync(dispatchReadinessPath, dispatchReadiness.output)
  if (!dispatchReadiness.ready) {
    throw new Error(
      `dispatch-readiness gate failed for branch '${branch}' — staged at ${dispatchReadinessPath}:\n${dispatchReadiness.output}`
    )
  }
  // O3: resolved fresh per dispatch, the same "never cached across a
  // round" posture `resolveTaskSurface` already has at its two existing
  // call sites (the publication precondition checks) — a Surface a
  // Principal edits mid-task is picked up by the very next dispatch.
  const agentConfigOpened = surfaceOpenedAgentConfigPaths(
    d.resolveTaskSurface ? d.resolveTaskSurface(task) : null,
    dispatchAgent
  )
  // O2: start the driver-run dev-tools MCP host for THIS turn, on a stable
  // per-task socket, serving the gate-backed context the seven tools answer.
  // It runs OUTSIDE the agent's sandbox, in this driver process; the agent
  // reaches it only through the bridge passed below, the one part that runs
  // inside the sandbox. Closed in the `finally` after the turn.
  const devToolsSocket = devToolsSocketPath(`${repo ? `${repo.owner}/${repo.repo}` : 'local'}:${task}`)
  const devToolsHost = await d.startDevTools({
    socketPath: devToolsSocket,
    context: attributeDriverToolCalls(c, buildDeveloperDevToolContext(c, roundNum))
  })
  const attemptDispatch = (): Promise<DispatchHandle> =>
    withPromptFile(dispatchPrompt, (promptFile) =>
      d.dispatchRole('developer', dispatchAgent, dispatchPrompt, {
        task: task,
        round: roundNum,
        turnResultKnownFindingIds,
        resumeId: c.devResumeId ?? undefined,
        promptFile,
        roleLogPath: loopLogPath,
        ...(devWorktreeDir ? { cwd: devWorktreeDir } : {}),
        ...(opts.developerFiles && opts.developerFiles.length > 0 ? { developerFiles: opts.developerFiles } : {}),
        // issue-661, O1: `runTask`'s own resolved model, spent here and
        // only here — `dispatchRole`'s own `resolvedModel` log line
        // already reports `requested:<model>` vs `'default'`, so no
        // separate log line is needed on this side.
        ...(dispatchModel ? { model: dispatchModel } : {}),
        agentConfigOpened,
        // O2: the per-dispatch dev-tools registration — Claude via
        // `--strict-mcp-config --mcp-config`, Codex via its staged
        // `config.toml` (`dispatch.ts`). The one way the Developer
        // publishes, reads its PR and runs checks.
        devToolsBridge: devToolsHost.bridge,
        unattended: true
      })
    )
  try {
    let handle = await attemptDispatch()
    // O2: the launcher's own
    // `'connection-failed'` classification means the vendor could not be
    // reached — never a developer decision. Wait and re-dispatch the SAME
    // session, bounded by the existing infrastructure-retry budget
    // (`MAX_INFRASTRUCTURE_RETRIES`, shared with every other
    // infrastructure-class hiccup this task hits), before this ever
    // reaches `assertDispatchOrEscalate`'s stop-and-escalate/pause path —
    // a network drop that recovers on retry must never become a decided
    // stop the developer itself never made. `reconcileDeveloperResume`
    // picks the exact session back up from the durable launch record,
    // which binds one the instant the vendor stream reports it, even on
    // an attempt this connection failure interrupted mid-turn — the
    // returned `handle` itself always carries `resumeId: null` on a
    // failure path (`dispatch.ts`), so this is the only way to recover it.
    let connectionRetryAttempts = 0
    while (handle.failureReason === 'connection-failed' && c.infrastructureRetries < MAX_INFRASTRUCTURE_RETRIES) {
      c.infrastructureRetries += 1
      connectionRetryAttempts += 1
      await d.sleep(gatePollEnvOverride('VINAYA_DEV_REVIEW_LOOP_CONNECTION_RETRY_BACKOFF_MS', 5_000))
      reconcileDeveloperResume(c, false)
      handle = await attemptDispatch()
    }
    // O3: one typed event per retry episode, naming the failure kind, the
    // total attempts made, and whether a later attempt eventually
    // recovered — never one line per attempt, and never logged at all for
    // the common case (no connection failure this dispatch).
    //
    // round 2 review, MAJOR: `outcome` reads off whether the LAST attempt
    // still carries ANY `failureReason`, never specifically
    // `'connection-failed'` — the retry loop's own condition only re-enters
    // on `'connection-failed'`, so its exit can land on a genuine success
    // (`handle.failureReason` undefined: `'recovered'`) OR on the bound
    // being exhausted while still `'connection-failed'` OR on a retried
    // attempt that failed for a DIFFERENT reason (crash/timeout/refused/
    // signal/unbound) — every one of those non-success cases is
    // `'exhausted'`, never silently reported as `'recovered'`.
    if (connectionRetryAttempts > 0) {
      await logEvents(c, [
        {
          kind: 'dev_review_loop' as const,
          payload: {},
          loop_id: config.loopId,
          event: 'infrastructure_retry' as const,
          round: roundNum,
          failure_kind: 'developer_connection' as const,
          attempts: connectionRetryAttempts + 1,
          outcome: handle.failureReason ? 'exhausted' : 'recovered'
        }
      ])
    }
    await assertDispatchOrEscalate(
      handle,
      dispatchAgent,
      isResume,
      c.devDispatchHistory.hasSucceeded,
      'the developer',
      c.devDispatchHistory.succeededBeforeRound(roundNum)
    )
    if (!handle.failureReason) {
      c.devDispatchHistory.recordSuccess(roundNum)
      if (handle.resumeId) c.devResumeId = handle.resumeId
      c.agentSwitched = false
      // A Developer attempt finished: the failure the loop last recorded
      // now has an attempt after it, so reading it again is a repeat. The
      // next loop-state write carries it — a pause's included — and none
      // is made here: this runs before the after-turn confinement check,
      // which would read a control-store write as the Developer's own.
      c.state = recordDeveloperAttempt(c.state)
    }
    return handle
  } finally {
    // O2: tear down the driver-run host after the turn — the next dispatch
    // starts a fresh one on the same stable socket (`startDevToolsHost`
    // unlinks a stale socket file first).
    await devToolsHost.close()
  }
}

/**
 * O1: every Developer dispatch, followed by the driver publishing what the
 * turn left — committing the uncommitted changes under the header the
 * Developer wrote, pushing the task branch and opening the pull request
 * when none is open (`publishDeveloperTurn`), BEFORE any poll starts. A
 * publication the Developer must fix first (a missing/invalid commit
 * header, a failed pre-publication check, O2/O7) sends the turn back to
 * the SAME session naming the problem, up to `MAX_PUBLISH_REASKS` times;
 * after that the unmoved head is left to the existing poll/`no_push`
 * safety net. A refused push (O4) is left committed-but-unpushed and
 * carried by that same existing mechanical-failure path, never re-asked
 * here. `opts.skipPublish` — a dispatch that only answers a confidence
 * question (O1) — publishes nothing.
 */
export async function dispatchDeveloper(
  c: LoopRunContext,
  prompt: string,
  roundNum: number,
  opts: {
    skipResumeContext?: boolean
    developerFiles?: readonly string[]
    skipPublish?: boolean
    publicationRefusal?: PublicationRefusal
    /** This dispatch hands the Developer review findings to answer (O2: `addressedFindingIds` is then required). */
    answersFindings?: boolean
  } = {}
): Promise<DispatchHandle> {
  let currentPrompt = prompt
  let publishReasks = 0
  let testFailureReasks = 0
  let publicationRefusals = opts.publicationRefusal ? 1 : 0
  let previousPublicationRefusal: string | null = opts.publicationRefusal?.signature ?? null
  while (true) {
    const handle = await dispatchDeveloperOnce(c, currentPrompt, roundNum, opts)
    // A dispatch whose own turn failed publishes nothing — there is no
    // trusted output to check or commit.
    if (handle.failureReason) return handle
    // O1/O2: every Developer turn is checked, including a
    // `skipPublish` re-ask for the turn result — that result is still
    // trusted by `assessRound` to decide pause-or-proceed, so its turn is
    // checked the same as a publishing turn; it is simply never
    // published. Refused BEFORE any commit or credential use — the same
    // "before any commit or credential use" discipline
    // `checkPublicationPreconditions` already applies, below, to the
    // branch/head/Surface checks. A violation is a reask, bounded the
    // same way a bad commit header already is; it never reaches
    // `publishDeveloperTurn`, so nothing this turn touched is ever
    // committed or pushed.
    const confinement = checkTurnConfinement(c, 'developer', developerScanTexts(c, handle))
    if (confinement.changedPaths.length > 0 || confinement.credentialFindings.length > 0) {
      if (publishReasks >= c.MAX_PUBLISH_REASKS) return handle
      publishReasks += 1
      currentPrompt = [
        'Your previous turn was refused by the driver — the after-turn confinement check (isolation.md) found:',
        describeTurnConfinementViolation(c, confinement),
        `Fix the problem above and end your turn — ${publishingInstructionLine()}`
      ].join('\n\n')
      continue
    }
    // A `tooling_unavailable` block that coincides with a spent GitHub
    // rate limit is waited out and re-dispatched, never paused for a
    // ruling. The cause is read from the forge — the head's failed jobs,
    // then this host's own budget — never from the blocker's prose.
    const rateLimitWait = await waitOutRateLimitForToolingReport(c, handle, roundNum, opts.answersFindings === true)
    if (rateLimitWait !== null) {
      currentPrompt = [
        'Your previous turn reported `blocked` with reason `tooling_unavailable` while a GitHub rate limit was spent.',
        rateLimitWait.kind === 'checks'
          ? `CI's token on the pull request's head was out of budget. The driver waited for its reset, reran the failed jobs${
              rateLimitWait.runIds.length > 0
                ? ` of workflow run${rateLimitWait.runIds.length === 1 ? '' : 's'} ${rateLimitWait.runIds.join(', ')}`
                : ''
            } and waited for the gate: it now reads ${rateLimitWait.ciConclusion}.`
          : "The driver's own GitHub token was out of budget. The driver waited for its reset.",
        'A GitHub rate limit is never yours to escalate. Continue the task without pausing.',
        `End your turn — ${publishingInstructionLine()}`
      ].join('\n\n')
      continue
    }
    // A `tooling_unavailable` block on a pull request whose head has a
    // failed mechanical check run gets that run's failed jobs rerun once
    // per round, the gate waited for, and the turn re-dispatched. Keyed on
    // the forge's check runs, never on the blocker's prose.
    if (!c.toolingRerunRounds.has(roundNum)) {
      const rerun = await rerunRedCheckForToolingReport(c, handle, roundNum, opts.answersFindings === true)
      if (rerun !== null) {
        c.toolingRerunRounds.add(roundNum)
        currentPrompt = [
          "Your previous turn reported `blocked` with reason `tooling_unavailable`, and the pull request's head had a failed check run.",
          `The driver reran the failed jobs of workflow run${rerun.runIds.length === 1 ? '' : 's'} ${rerun.runIds.join(', ')} and waited for the gate: it now reads ${rerun.ciConclusion}.`,
          rerun.failingChecks.length > 0
            ? `Still failing:\n${rerun.failingChecks.map((check) => `- ${check}`).join('\n')}`
            : 'No mechanical check is failing now.',
          'Continue the task without pausing. This is the one allowed rerun for that report in this round.',
          `End your turn — ${publishingInstructionLine()}`
        ].join('\n\n')
        continue
      }
    }
    // A first `test_failure` block gets one re-ask, without a check: the
    // driver cannot judge a test claim mechanically. A second one pauses.
    if (testFailureReasks < 1 && reportsTestFailure(c, handle, roundNum, opts.answersFindings === true)) {
      testFailureReasks += 1
      currentPrompt = [
        'Your previous turn reported `blocked` with reason `test_failure`.',
        "A failing test is the Developer's to fix: read what it says and fix the code or the test. CI on the pull request's head is the authority for a test that fails only inside your sandbox, so a sandbox-only failure is not a block.",
        'Report `blocked` again only if the same test also fails on `origin/main` in a clean checkout. This is the one allowed re-ask for that report.',
        `End your turn — ${publishingInstructionLine()}`
      ].join('\n\n')
      continue
    }
    // A dispatch that only re-asks for the turn result (O1) is now
    // confirmed clean and publishes nothing.
    // A turn that ends `blocked` or `needs_ruling` is read BEFORE the
    // publication check: its work stays as it is and the round pauses for
    // the Principal (`settleTurnResult` names the unpublished work), so
    // the driver never first asks it to publish.
    if (!opts.skipPublish && !endsInEscalation(c, handle, roundNum, opts.answersFindings === true)) {
      const published = await publishDeveloperTurn(c, roundNum)
      if (published.kind !== 'published' && published.kind !== 'nothing') {
        publicationRefusals += 1
        if (published.signature === previousPublicationRefusal || publicationRefusals >= c.MAX_PUBLISH_REASKS) {
          throw new PublicationRefusalPause(published.check, published.errorLine)
        }
        previousPublicationRefusal = published.signature
        currentPrompt = publicationRefusalPrompt(c, published)
        continue
      }
    }
    // O3: the turn has ended for good — its result is settled now, after
    // every publication it earned, so a rejected result never repeats one.
    await settleTurnResult(c, handle, roundNum, opts.answersFindings === true)
    return handle
  }
}
