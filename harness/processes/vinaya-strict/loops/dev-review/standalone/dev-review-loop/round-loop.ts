/**
 * `dev-review-loop`'s round loop — the driver's decide-act-observe cycle from the first dispatch to a publish
 * or a pause. Moved out of
 * `harness/processes/vinaya-strict/loops/dev-review/standalone/dev-review-loop.ts` verbatim, over the run's
 * `LoopRunContext`; the body is unchanged.
 */

import { assessRound } from '../../../../tools/dev-review-policy/assess-round'
import type { Observations } from '../../../../tools/dev-review-policy/types'
import { randomUUID } from 'node:crypto'
import {
  buildReviewInputManifest,
  compareManifest,
  manifestAsEchoed,
  type ReviewInputManifest
} from '../../../../tools/task-contract/review-input-manifest'
import type { EscalationRecord } from '../../../../../../kernel/connectors/checkpoint/control-store/index'
import { keepDriverLock } from './driver-lifecycle.js'
import { appendDriverLine, appendRoleLine } from '../../../../../../kernel/log/client/loop-log.js'
import { checkPremiseAtHead, pollMergeableState, renderConflictPrompt } from './gate-reading.js'
import { noPushPauseDetail, unpushedWorkResumeDetail } from './unpushed-work.js'
import { describeObjectivesEdit } from './developer-dispatch.js'
import {
  buildPriorRoundFindingsText,
  buildRoundDeferralContext,
  discardHeldVerdicts,
  persistManifestRecord,
  decideSecurityScan,
  type ReviewerPromptFacts,
  ReviewerInfrastructureFailure,
  ReviewerResultRejected,
  type RoundVerdictParse,
  type SecurityScanOutcome,
  writeHeldVerdict
} from './reviewer-dispatch.js'
import {
  buildVerifiedReviewerCandidate,
  cleanupReviewerIsolationForRound,
  writeReviewerCandidateInputs
} from './reviewer-isolation.js'
import { driverDecidedPauseEvents, MAX_GATE_STALLED_TURNS, pollUntil, routeCompletionEvents } from './round-assess.js'
import type { PremiseReassertResult } from '../../../../tools/premise-reassert-logic.js'
import { renderLiveWithdrawal, withdrawApprovedRound } from './live-check.js'
import { writeEscalationRecord, writePauseState } from './pause-resume.js'
import { absorbRateLimitedRed, withRateLimitWait } from './rate-limit-waits.js'
import { rerunFailedChecksForHead, runLiveGate, settleFirstRedRead, waitForGreenGate } from './ci-gate.js'
import { computeStats, postDeveloperRoundComment, roundConfidence } from './round-report.js'
import { ReviewerConfinementViolation, dispatchReviewer, keepSiblingVerdictOnPause } from './reviewer-turn.js'
import type { LoopRunContext } from './run-context.js'
import type { LoopResult } from '../dev-review-loop.js'

// eslint-disable-next-line no-constant-condition
export async function runRoundLoop(c: LoopRunContext): Promise<LoopResult> {
  const {
    bestEffortInputVersions,
    branch,
    checkStaleDriver,
    commitAndPushPrompt,
    config,
    d,
    deferredByRound,
    deferredEntriesForRound,
    deriveVerdictPauseDetail,
    describeConfidencePauseDetail,
    dispatchAgent,
    dispatchDeveloper,
    dispatchModel,
    failureSignaturePart,
    handoffFindings,
    input,
    issueRulingsBlock,
    log,
    logEvents,
    logPauseCommentRetryIfNotable,
    logUnpushedWorkResume,
    loopLogPath,
    pauseBoundRuling,
    persistCurrentLoopState,
    persistDeveloperHandoff,
    postUnpushedWorkResumeComment,
    publicationState,
    publishingInstructionLine,
    renderFailedCheckLog,
    repo,
    rerunHeads,
    root,
    roundReviewerSources,
    runId,
    task,
    taskClock,
    unpushedFailureMessage,
    worktreePathForBranch
  } = c

  while (true) {
    c.roleDispatchesInPass = 0
    // Checking more often than the minimum ("every round entry") is
    // strictly safer, never wrong — this runs before every iteration's
    // own dispatch/gate/publish logic.
    if (c.decision.type !== 'pause') {
      await checkStaleDriver()
    }

    if (c.decision.type === 'dispatch_developer') {
      // O2: `pendingGateRedRetry` (set below, at this round's own two `gate`
      // observation call sites — never inferred from `decision` itself,
      // since `assessGate`'s red branch returns a bare `dispatch_developer`
      // with no reason tag: `Decision`/`PauseReason` live in
      // `packages/aeg-core`, out of this task's declared Surface) is true
      // exactly when THIS dispatch is the driver sending
      // the developer back for a red mechanical gate — the one case that
      // needs the head-change wait (Traps: never re-read the gate in a
      // tight loop on an unchanged head — a real five-re-dispatches-
      // in-two-minutes failure).
      const isGateRedRetry = c.pendingGateRedRetry
      // O4/O6: a conflict-resolve retry — READ, never cleared here. Same
      // persistence discipline as `pendingGateRedRetry`: it survives a
      // bounded stall's own `continue` unchanged (this branch's own
      // `dispatch_developer` decision doesn't change either), so the NEXT
      // iteration rebuilds the SAME conflict prompt and re-runs the SAME
      // stall check, rather than falling through to a stale fallback
      // prompt and a fresh, unbounded gate-check/re-detect cycle (found
      // live: clearing it here let the loop rediscover the same conflict
      // every OTHER iteration, doubling the dispatches needed to reach the
      // bound and sending one nonsense prompt per cycle). Cleared only
      // where it's genuinely resolved — the mergeability re-reads at the
      // `dispatch_reviewers`/`publish` sites, below.
      const conflictFiles = publicationState.pendingConflictFiles
      let gateAfterUnchangedHeadRerun: Awaited<ReturnType<typeof waitForGreenGate>> | null = null
      if (!c.firstPass) {
        // O2: findings citation only makes sense on the genuine
        // review-findings path — not a conflict retry, a ruling resume,
        // or a CI-red retry, none of which ever sent the developer a
        // findings list to cite ids against.
        const isReviewFindingsRetry = conflictFiles === null && !c.resumedDispatch && !isGateRedRetry
        // O2/O3: the ids this round's handoff carries — the only ids a
        // turn result of this round may cite, listed beside the findings
        // so the Developer cites exactly these.
        const handoff = isReviewFindingsRetry ? (c.lastHandoffFindings ?? []) : []
        const prompt = [
          // A resumed pause that was raised before the pull request existed
          // keeps its ruling on the task Issue: the first Developer dispatch
          // after it carries that ruling ahead of whatever the round asks.
          c.issueRulingsOwed ? issueRulingsBlock() : null,
          conflictFiles !== null
            ? renderConflictPrompt(conflictFiles, publishingInstructionLine())
            : c.resumedDispatch
              ? `Principal ruling on this pause:\n\n${c.lastReviewContext}\n`
              : isGateRedRetry
                ? [
                    `CI is red on the last head. Failing check-run(s): ${
                      c.lastFailingChecks.length > 0 ? c.lastFailingChecks.join(', ') : '(unknown)'
                    }. Fix the failing check(s).`,
                    ...c.lastFailureLogs.map(renderFailedCheckLog)
                  ].join('\n\n')
                : // `isGateRedRetry` is false here only when this dispatch came from
                  // `assessVerdicts`' review-findings fallback, which requires
                  // `dispatch_reviewers` to have already run and set `lastReviewContext`
                  // — so it is never null in this branch (code review, round 1, MINOR:
                  // the prior 'CI was red...' fallback below this was unreachable).
                  `Round ${c.round} review findings:\n\n${c.lastReviewContext}\n`,
          handoff.length > 0
            ? `Finding ids in this handoff — cite the ones you address in your turn result's \`addressedFindingIds\`:\n${handoff.map((f) => `- ${f.id}: ${f.line}`).join('\n')}`
            : '',
          // O4: the fix publishes the SAME way for both agents — through the
          // driver-run tools, as a new commit on the SAME branch; no new PR
          // is opened (the existing one stays).
          `Address the findings above per your role doctrine (\`bun apps/cli/src/index.ts doctrine --role developer --print\`), then ${publishingInstructionLine()} Publish the fix as a new commit on this SAME branch — do not open a new pull request.`
        ]
          .filter(Boolean)
          .join('\n\n')
        // Unchanged from before this task: a head-change wait runs ONLY
        // for a CI-red retry or a conflict retry — never for the plain
        // review-findings retry, whose own next `dispatch_reviewers`
        // phase re-reads whatever head exists rather than waiting for
        // one to CHANGE (Traps: never re-read the gate in a tight loop
        // on an unchanged head — that same real failure). This case
        // adds the unpushed-work resume ONLY inside this same,
        // already-narrower scope — widening it to the review-findings
        // path would mean every existing fixture for that path (there is
        // no real push to wait for there today) would need to start
        // simulating one, well beyond this fix's own boundary.
        const headBeforeDispatch = isGateRedRetry || conflictFiles !== null ? d.resolveHead(branch) : null
        c.roundStartMs = d.now()
        await dispatchDeveloper(prompt, c.round, { answersFindings: isReviewFindingsRetry })
        c.resumedDispatch = false
        c.issueRulingsOwed = false

        // A turn whose last publication attempt a driver tool refused
        // has no push coming: one read of the head (the poll's first
        // attempt) replaces the full head-change budget, and the stall
        // below names the refusal.
        const refusedPublication = publicationState.turnPublicationRefusal
        const changedHead =
          headBeforeDispatch !== null
            ? await pollUntil(
                () => {
                  const h = d.resolveHead(branch)
                  return h !== headBeforeDispatch ? h : null
                },
                refusedPublication !== null || !publicationState.turnPublicationAttempted ? 1 : d.gatePollMaxAttempts,
                d.gatePollIntervalMs,
                d.sleep,
                'devReviewLoop: head-change wait timed out'
              ).catch(() => null)
            : 'not-applicable'

        if (headBeforeDispatch !== null && changedHead === null) {
          // Before charging this to the driver's generic
          // bounded stall counter, tell "stopped without pushing REAL
          // work" apart from a genuinely idle turn: a dirty worktree or
          // local commits ahead of the remote is real, unpushed work —
          // resumed ONCE, foreground, with a dedicated commit-and-push
          // instruction (Traps: never resume more than once for this).
          let resolvedByUnpushedResume = false
          if (!c.unpushedResumeAttempted && refusedPublication === null) {
            const unpushed = d.readUnpushedWorkDetail(worktreePathForBranch())
            if (unpushed.dirtyFiles.length > 0 || unpushed.aheadCount > 0) {
              c.unpushedResumeAttempted = true
              // A push that was made and did not land is the failure
              // this task's repeat stop exists for, so this attempt's own
              // message goes to the assessment before the resume is spent
              // — and the assessment, never this driver, decides whether
              // it has now seen the same one twice. Commits ahead of the
              // remote is what tells that case apart from a worktree the
              // developer simply never committed: the latter attempted no
              // push at all, so there is no push failure to match, and it
              // stays entirely with the one-resume-then-`no_push` rule
              // below. A first occurrence records the signature and
              // returns `dispatch_developer`, leaving that rule untouched
              // too.
              if (unpushed.aheadCount > 0) {
                const firstAttempt = assessRound(
                  c.state,
                  {
                    kind: 'mechanical_failure',
                    round: c.round,
                    failure: unpushedFailureMessage(headBeforeDispatch, unpushed),
                    stats: computeStats(c, headBeforeDispatch, c.roundStartMs)
                  },
                  taskClock()
                )
                c.state = firstAttempt.state
                await logEvents(firstAttempt.events)
                if (firstAttempt.decision.type === 'pause') {
                  c.decision = firstAttempt.decision
                  persistCurrentLoopState('pause', firstAttempt.decision.reason)
                  continue
                }
              }
              await logUnpushedWorkResume(c.round, unpushedWorkResumeDetail(unpushed))
              await postUnpushedWorkResumeComment(c.round, headBeforeDispatch, unpushed)
              await dispatchDeveloper(commitAndPushPrompt(), c.round, {})
              const resumedHead = await pollUntil(
                () => {
                  const h = d.resolveHead(branch)
                  return h !== headBeforeDispatch ? h : null
                },
                d.gatePollMaxAttempts,
                d.gatePollIntervalMs,
                d.sleep,
                'devReviewLoop: head-change wait timed out after unpushed-work resume'
              ).catch(() => null)

              if (resumedHead !== null) {
                resolvedByUnpushedResume = true
              } else {
                const stillUnpushed = d.readUnpushedWorkDetail(worktreePathForBranch())
                const stats = computeStats(c, headBeforeDispatch, c.roundStartMs)
                // The resume's own attempt, reported the same way and
                // under the same commits-ahead condition. Two attempts
                // whose failure normalises the same way are the repeat
                // this task's stop owns, and the pause names that exact
                // message; a resume that failed DIFFERENTLY — or one that
                // pushed nothing because nothing was committed — is not a
                // repeat, and falls through to the `no_push` pause exactly
                // as before.
                if (stillUnpushed.aheadCount > 0) {
                  const resumedAttempt = assessRound(
                    c.state,
                    {
                      kind: 'mechanical_failure',
                      round: c.round,
                      failure: unpushedFailureMessage(headBeforeDispatch, stillUnpushed),
                      stats
                    },
                    taskClock()
                  )
                  c.state = resumedAttempt.state
                  await logEvents(resumedAttempt.events)
                  if (resumedAttempt.decision.type === 'pause') {
                    c.decision = resumedAttempt.decision
                    persistCurrentLoopState('pause', resumedAttempt.decision.reason)
                    continue
                  }
                }
                // Nothing dirty, nothing ahead, and the remote branch
                // already at the head this turn started on: the work IS
                // pushed, so there is nothing for a Principal to rule on.
                // Decided from the worktree's own reading, never from the
                // developer's reply; it falls through to the gate and
                // reviewers exactly like a resume that moved the head.
                if (
                  stillUnpushed.dirtyFiles.length === 0 &&
                  stillUnpushed.aheadCount === 0 &&
                  d.resolveHead(branch) === headBeforeDispatch
                ) {
                  resolvedByUnpushedResume = true
                } else {
                  const detail = noPushPauseDetail(branch, stillUnpushed)
                  await logEvents(driverDecidedPauseEvents(config.loopId, c.state, c.round, stats, 'no_push'))
                  c.decision = { type: 'pause', reason: 'no_push', detail }
                  continue
                }
              }
            }
          }

          if (!resolvedByUnpushedResume) {
            // The forge, not the turn result, decides whether an unchanged
            // red head has something actionable to rerun. This shares the
            // once-per-head memory the first red read spends. A refusal or an
            // unresolved conflict keeps its existing, named stall path.
            if (
              isGateRedRetry &&
              conflictFiles === null &&
              refusedPublication === null &&
              !rerunHeads.has(headBeforeDispatch)
            ) {
              const rerun = await rerunFailedChecksForHead(
                c,
                headBeforeDispatch,
                c.round,
                'an unchanged Developer turn on a red head'
              )
              if (rerun !== null) {
                gateAfterUnchangedHeadRerun = rerun.gate
                resolvedByUnpushedResume = true
              }
            }
          }

          // The head never moved, but its CI may have: a rerun this
          // round — for a tooling report inside the turn, or any new
          // attempt the forge ran since — can have turned a failed check
          // green. So the head the developer left is read afresh, never
          // the conclusion read before the turn: green, with no premise
          // failing, proceeds to review exactly like a head that moved,
          // and is no stalled turn; otherwise the stall below is named
          // only by what fails on this head now. A refusal or an
          // unresolved conflict keeps its own named stall.
          let failingAtStall: string[] = []
          if (!resolvedByUnpushedResume && isGateRedRetry && conflictFiles === null && refusedPublication === null) {
            const gateAtStall = await waitForGreenGate(c, c.roundStartMs, headBeforeDispatch)
            const premiseAtStall = checkPremiseAtHead(c.prNumber, d.fetchPrBody)
            const premiseLinesAtStall =
              premiseAtStall !== null && !premiseAtStall.pass ? premiseAtStall.errors.map((e) => e.message) : []
            if (gateAtStall.green && premiseLinesAtStall.length === 0) {
              gateAfterUnchangedHeadRerun = gateAtStall
              resolvedByUnpushedResume = true
            } else {
              failingAtStall = [...gateAtStall.failingChecks, ...premiseLinesAtStall]
              c.lastFailingChecks = failingAtStall
              c.lastFailureLogs = gateAtStall.failureLogs
            }
          }

          if (!resolvedByUnpushedResume) {
            // The developer returned without pushing on a head that is
            // still not green — this feeds the DRIVER's own bounded stall
            // counter.
            c.gateStalledStreak += 1
            // Persisted the moment it
            // increments, not only once a pause eventually fires — a
            // kill mid-episode (the process dies before ever reaching
            // the bound below) must not hand the next attach a fresh
            // budget of `MAX_GATE_STALLED_TURNS` turns.
            persistCurrentLoopState('dispatch_developer')
            const stats = computeStats(c, headBeforeDispatch, c.roundStartMs)
            // A conflict is a named failure whether or not the file list
            // could be read — the conflict itself is the cause, and its
            // text is unchanged from before this stop existed. A red-gate
            // stall is named only by the check-runs failing on this head
            // at this read — a check whose newest attempt passed is never
            // named; with none failing, this stall has no named cause at
            // all.
            const namedFailure =
              refusedPublication !== null
                ? `publication refused: ${refusedPublication}`
                : conflictFiles !== null
                  ? `conflict never resolved (file(s): ${
                      conflictFiles.length > 0 ? conflictFiles.join(', ') : '(unknown)'
                    })`
                  : failingAtStall.length > 0
                    ? `failing check-run(s): ${failingAtStall.join(', ')}`
                    : null
            const detail = `head ${headBeforeDispatch} unchanged after dispatch; ${
              namedFailure ?? 'no named failure for this head — the developer pushed nothing for the gate to judge'
            }`
            // A stall the driver CAN name — the conflicting files, or the
            // check-runs still failing on this head — is a mechanical
            // failure like any other, and the assessment decides whether
            // this is the second attempt to end on it. A stall it cannot
            // name is not reported: an unnamed failure is not evidence of
            // a repeat, and a genuinely idle turn stays with the bounded
            // stall counter below, which is not a claim about any failure
            // at all.
            if (namedFailure !== null) {
              const stalled = assessRound(
                c.state,
                {
                  kind: 'mechanical_failure',
                  round: c.round,
                  failure: detail,
                  stats
                },
                taskClock()
              )
              c.state = stalled.state
              await logEvents(stalled.events)
              if (stalled.decision.type === 'pause') {
                c.decision = stalled.decision
                persistCurrentLoopState('pause', stalled.decision.reason)
                continue
              }
            }
            if (c.gateStalledStreak < MAX_GATE_STALLED_TURNS) {
              continue
            }
            await logEvents(driverDecidedPauseEvents(config.loopId, c.state, c.round, stats, 'infrastructure'))
            c.decision = { type: 'pause', reason: 'infrastructure', detail }
            c.infrastructureRetries += 1
            continue
          }
          // else: `resolvedByUnpushedResume` — fall through exactly like
          // a normal `changedHead !== null` success, into the
          // mergeable/gate checks below.
        }
      }
      c.firstPass = false

      // O4/O7 (round 2 review, BLOCKER): mergeability is checked BEFORE
      // the CI gate is ever waited on — `waitForGreenGate` below used to
      // run unconditionally here, so even round 1 burned the full CI poll
      // budget on a head that might already be `CONFLICTING`, and the
      // mergeability read at the `dispatch_reviewers` branch (below) never
      // ran until a whole extra iteration later. Checked here, every time
      // this branch runs (fresh round-1 entry, a conflict-retry, or a
      // genuine next round), so a conflicting head is sent back before any
      // CI wait, never after one.
      const mergeableBeforeGate = await pollMergeableState(c.prNumber, d)
      if (mergeableBeforeGate === 'CONFLICTING' && input.pauseOnConflict !== undefined) {
        // The watching driver's automatic conflict re-entries for this
        // published pull request are spent: a person decides, through
        // the ordinary pause and its comment.
        const stats = computeStats(c, d.resolveHead(branch), c.roundStartMs)
        await logEvents(driverDecidedPauseEvents(config.loopId, c.state, c.round, stats, 'repeat_failure'))
        c.decision = { type: 'pause', reason: 'repeat_failure', detail: input.pauseOnConflict }
        continue
      }
      if (mergeableBeforeGate === 'CONFLICTING') {
        publicationState.pendingConflictFiles = await withRateLimitWait(c, () =>
          d.fetchConflictingFiles('main', branch)
        )
        continue
      }
      publicationState.pendingConflictFiles = null

      // A red that is a GitHub rate limit and nothing else is waited out
      // and rerun here, before any observation: it is never the
      // Developer's, never a stall and never a mechanical retry.
      const absorbedGate = await absorbRateLimitedRed(
        c,
        gateAfterUnchangedHeadRerun ?? (await waitForGreenGate(c, c.roundStartMs))
      )
      const { gate, pauseDetail: parentRedPause } = await settleFirstRedRead(c, absorbedGate)
      if (parentRedPause !== null) {
        await logEvents(driverDecidedPauseEvents(config.loopId, c.state, c.round, gate.stats, 'infrastructure'))
        c.decision = { type: 'pause', reason: 'infrastructure', detail: parentRedPause }
        persistCurrentLoopState('pause', 'infrastructure')
        continue
      }
      // The dispatch gate's own premise re-assertion,
      // re-run against the PR's live body at this exact head — a stale
      // `Premise:` pin (a symbol the head deleted since the brief was
      // authored) is a developer finding sent back through the SAME
      // gate-red retry prompt below, never a reason for this driver to
      // exit. `reassertPrBodyPremise` returns `null` for a body with no
      // `Premise:` block at all — dormant, same as every other PR. Runs
      // on every round's gate check, which is also the first thing a
      // re-exec'd child evaluates once it reaches this same point — one
      // call site covers both "on first run and on re-exec" (Traps to
      // avoid: no separate re-exec-only path to fall out of sync with
      // this one). Best-effort, like `runEvidenceReport`: a body-fetch
      // failure here is its own infrastructure hiccup, never grounds to
      // treat the premise itself as failed.
      const premiseResult: PremiseReassertResult | null = checkPremiseAtHead(c.prNumber, d.fetchPrBody)
      const premiseFailed = premiseResult !== null && !premiseResult.pass
      const premiseFailureLines = premiseResult !== null ? premiseResult.errors.map((e) => e.message) : []
      const gateGreen = gate.green && !premiseFailed
      c.lastFailingChecks = [...gate.failingChecks, ...premiseFailureLines]
      persistDeveloperHandoff({ failingChecks: c.lastFailingChecks.filter((check) => check.length > 0) })
      c.lastFailureLogs = gate.failureLogs
      c.pendingGateRedRetry = !gateGreen
      if (c.mechanicalRetryRecoverySurvivesOneReset) {
        c.mechanicalRetryRecoverySurvivesOneReset = false
      } else {
        c.gateStalledStreak = 0
      }
      c.unpushedResumeAttempted = false
      const confidence = c.round >= 2 && gateGreen ? roundConfidence(c, c.round) : undefined
      const failureParts = gate.failingRuns.map((run) => {
        const log = gate.failureLogs.find((entry) => entry.runId === run.id) ?? null
        return failureSignaturePart(run, log?.logTail ?? null)
      })
      const failure =
        gateGreen || (failureParts.length === 0 && premiseFailureLines.length === 0)
          ? undefined
          : [...failureParts, ...premiseFailureLines].join('; ')
      const obs: Observations = {
        kind: 'gate',
        round: c.round,
        green: gateGreen,
        confidence,
        stats: gate.stats,
        ...(failure !== undefined ? { failure } : {})
      }
      const result = assessRound(c.state, obs, taskClock())
      c.state = result.state
      c.decision = result.decision
      if (c.decision.type === 'pause' && c.decision.reason === 'confidence' && c.decision.detail === undefined) {
        c.decision = { ...c.decision, detail: describeConfidencePauseDetail(confidence ?? 'absent') }
      }
      await logEvents(result.events)
      persistCurrentLoopState(c.decision.type, c.decision.type === 'pause' ? c.decision.reason : undefined)
    } else if (c.decision.type === 'ask_confidence') {
      const reaskPrompt =
        'The driver holds no accepted `completed` turn result for this round, so it has no confidence to read. Change and publish nothing; report your turn result for the work already on this branch.'
      // O1: a dispatch that only re-asks for the turn result publishes nothing.
      await dispatchDeveloper(reaskPrompt, c.round, { skipPublish: true })
      const head = d.resolveHead(branch)
      const stats = computeStats(c, head, c.roundStartMs)
      const confidence = roundConfidence(c, c.round)
      const obs: Observations = { kind: 'gate', round: c.round, green: true, confidence, stats }
      const result = assessRound(c.state, obs, taskClock())
      c.state = result.state
      c.decision = result.decision
      if (c.decision.type === 'pause' && c.decision.reason === 'confidence' && c.decision.detail === undefined) {
        c.decision = { ...c.decision, detail: describeConfidencePauseDetail(confidence) }
      }
      c.pendingGateRedRetry = false
      if (c.mechanicalRetryRecoverySurvivesOneReset) {
        c.mechanicalRetryRecoverySurvivesOneReset = false
      } else {
        c.gateStalledStreak = 0
      }
      c.unpushedResumeAttempted = false
      await logEvents(result.events)
      persistCurrentLoopState(c.decision.type, c.decision.type === 'pause' ? c.decision.reason : undefined)
    } else if (c.decision.type === 'dispatch_reviewers') {
      // O4/O7: mergeability is read BEFORE any CI
      // read or reviewer dispatch — a branch in conflict with the base
      // sends the developer back with the conflicting files named; no
      // reviewer starts and no CI is waited on for this head. Round
      // number does not advance (same discipline as the infrastructure
      // pause below — this round's reviewers never ran).
      const mergeableForReview = await pollMergeableState(c.prNumber, d)
      if (mergeableForReview === 'CONFLICTING') {
        publicationState.pendingConflictFiles = await withRateLimitWait(c, () =>
          d.fetchConflictingFiles('main', branch)
        )
        c.decision = { type: 'dispatch_developer' }
        continue
      }
      // Genuinely resolved (or never conflicting) — clear the retry flag
      // so a later conflict starts its own fresh stall count rather than
      // inheriting this one's file list.
      publicationState.pendingConflictFiles = null

      const head = d.resolveHead(branch)
      const ciConclusion = d.fetchCiConclusion(head)
      const resolvedObjectives = d.resolveIssueObjectives(task)
      // The reviewers read the rulings posted on the task Issue after its
      // newest frozen brief (each once, in posting order), then the pull
      // request's. A failed Issue read falls back to the pull request's
      // alone. The ordinal below stays read from the pull request only.
      let issueRulings: string[] = []
      try {
        issueRulings = d.fetchIssueRulingsAfterBrief(task)
      } catch (err) {
        console.error(
          `vinaya dev-review-loop: reading the task Issue's rulings failed (${err instanceof Error ? err.message : String(err)}) — reviewers get the pull request's rulings alone`
        )
      }
      const prRulings = d.fetchRulings(c.prNumber)
      const rulings = [...issueRulings, ...prRulings]
      const rulingOrdinal = d.fetchNewestRulingOrdinal(c.prNumber)
      const revision = d.fetchSourceRevision(task)
      const briefContentAtDispatch = d.fetchFrozenBrief(task)
      // The base identity this round's candidate is judged against
      // (task 5, O1; issue-657, O4) — the merge base of `head` and the
      // default branch, never the default branch's raw tip: a commit
      // that landed on the default branch after this candidate branched
      // is never part of the pull request's own diff, and judging
      // against the raw tip attributed that drift to the PR. Resolved
      // ONCE here and reused in the self-check below, so it never drifts
      // within a single round: the same treatment the policy already
      // gets (`loop.md`, "the policy is resolved once per loop run and
      // so never drifts within a single run"). A base move across
      // rounds is caught by the gate and by the existing `stale_driver`
      // guard, not by manufacturing a new mid-round pause reason.
      const baseSha = await d.gitMergeBase(head)
      // O2: the previous round's own head — the head of the manifest the
      // loop last dispatched reviewers against, read BEFORE this round's
      // manifest overwrites it below. `undefined` on the first dispatch
      // (round 1 has no previous head), so the unchanged-line rule stays
      // inactive that round. The changed lines are the diff between these
      // two heads, never the base branch (Traps to avoid).
      const previousRoundHead = c.lastDispatchedManifest?.headSha ?? null
      const manifest: ReviewInputManifest = buildReviewInputManifest({
        headSha: head,
        baseSha,
        briefContent: briefContentAtDispatch,
        objectivesVersion: resolvedObjectives.version,
        rulingOrdinal,
        pauseBoundRuling,
        policy: c.policy
      })
      c.lastDispatchedManifest = manifest
      // The branch's changed paths from its merge base, read once per
      // round: the deferral rules below and the security scan further on
      // both use this one set. `null` when unreadable — the out-of-Surface
      // rule is then inactive, and the scan sees no changed path.
      let branchChangedPaths: readonly string[] | null = null
      let branchChangedPathsError: unknown = null
      try {
        branchChangedPaths = d.gitChangedPaths ? d.gitChangedPaths(baseSha, head) : null
      } catch (err) {
        branchChangedPathsError = err
      }
      // O2/O3: the round's deferral rules — the task's `## Surface` with
      // the branch's changed paths (any round) and the changed lines since
      // the previous round's head (round 2 on). Resolved via optional deps:
      // absent in a fixture that stubs them, so every finding blocks where
      // they are not wired.
      const deferralContext = buildRoundDeferralContext({
        round: c.round,
        previousRoundHead,
        head,
        surface: d.resolveTaskSurface ? d.resolveTaskSurface(task) : null,
        changedPaths: branchChangedPaths,
        unifiedDiff: d.gitUnifiedDiff
      })
      const facts: ReviewerPromptFacts = {
        objectives: resolvedObjectives.text,
        resolvedObjectives: resolvedObjectives.objectives,
        rulings,
        ciConclusion,
        revision,
        manifest,
        policy: c.policy,
        deferralContext,
        ...roundReviewerSources(c.round)
      }

      // O1: the parent persists this round's manifest to the control store
      // BEFORE dispatching reviewers — the durable record `loop.md`'s
      // "Deferred, deliberately" paragraph named, now that the store is
      // built. Best-effort (see `persistManifestRecord`): a snapshot that
      // could not be written never fails the round; the echoed-comment
      // binding is what gates a verdict. Skipped only when the repository
      // cannot be resolved (no identity to key the record on).
      if (repo) {
        persistManifestRecord(root, task, manifest, {
          repository: `${repo.owner}/${repo.repo}`,
          pr: c.prNumber,
          branch,
          round: c.round,
          recordedAt: new Date(d.now()).toISOString()
        })
      }

      // O1/O2: the head's required CI is already green (this branch is
      // only ever entered off a `gate` observation reading `green: true`
      // — `assessRound`'s own policy) and mergeability is already
      // confirmed above — this is the earliest point the round's own
      // accepted turn results are final (their addressed finding ids and
      // reported checks), and the earliest point the evidence report can
      // run against a head that will not move again this round. Posted
      // BEFORE the reviewer dispatch below, never after: a reviewer
      // reading the PR mid-round sees the round marker comment already
      // there, exactly as it would have if the Developer had posted it.
      await postDeveloperRoundComment(c, c.round, head, manifest.pauseBoundRuling ?? null)

      // O5: an infrastructure outcome from either role (after its own
      // one-retry inside `dispatchReviewer`) is a driver-decided pause —
      // there is no `Observations` kind for it (adding one would edit
      // `packages/aeg-core`, out of this task's declared Surface) — but
      // `driverDecidedPauseEvents` logs the same
      // `stop_condition_met`/`paused`/`round_ended`/`journal_finalized`
      // events every policy-decided pause gets (a round-2 code-review MAJOR
      // finding: the driver used to build this `pause` decision by hand
      // and skip the log entirely). No verdict is held or published for
      // this round, and the round number does not advance.
      let verdicts: [{ verdict: RoundVerdictParse }, { verdict: RoundVerdictParse }] | null = null
      /** Set when one reviewer role failed while its sibling finished: names the sibling's kept verdict for the pause detail. */
      let keptSiblingNote: string | null = null
      // O1: ONE shared, read-only candidate for this round,
      // built once here — before either reviewer dispatches — from the
      // developer's own local worktree, so both roles judge byte-
      // identical content regardless of what that worktree does after
      // this copy is taken. `null` when no local worktree exists on
      // this machine (a fresh attach with nothing dispatched here yet)
      // OR the local worktree's own head no longer matches the round's
      // resolved candidate sha (round 2 review, MAJOR: a diverged local
      // worktree copied blind would hand both reviewers content the
      // manifest's `headSha` never actually pinned, with nothing else
      // in this mechanism positioned to catch it) — `dispatchReviewer`
      // then omits `cwd` entirely, the same as every round before this
      // task.
      const candidateSourceDir = worktreePathForBranch()
      // `buildVerifiedReviewerCandidate` (reviewer-isolation.ts) checks
      // the worktree's head both before AND after the copy — the local
      // worktree can advance mid-copy (round 2 review, MINOR), and a
      // candidate caught that way is discarded rather than handed to
      // both reviewers as bytes the manifest's own `headSha` never
      // actually pinned.
      const candidateDir = buildVerifiedReviewerCandidate(
        root,
        task,
        c.round,
        candidateSourceDir,
        head,
        d.readWorktreeHead
      )

      // O1: the pull request's own facts the driver stages for both
      // reviewer roles — the PR body, the unified diff of this round's
      // judged head against its base, and the prior round's held
      // findings — written ONCE per round, into `candidateDir` itself
      // (never a second readable path), BEFORE either role's own
      // scratch copy is taken below, so both roles' attempts read the
      // identical, immutable bytes (Traps to avoid). This is what lets
      // a dispatched reviewer holding no `gh` command and no forge
      // credential (O2) still read what it judges. `false` when no
      // candidate exists this round, or the staging write itself
      // failed — `dispatchReviewer` then omits the candidate-input
      // block from every attempt's prompt rather than naming a file
      // that was never written.
      const candidateInputsReady = candidateDir
        ? writeReviewerCandidateInputs(candidateDir, {
            brief: (() => {
              try {
                return d.fetchFrozenBrief(task)
              } catch (err) {
                return `(the task's frozen brief could not be fetched this round: ${err instanceof Error ? err.message : String(err)})`
              }
            })(),
            prBody: (() => {
              try {
                return d.fetchPrBody(c.prNumber)
              } catch (err) {
                return `(the pull request body could not be fetched this round: ${err instanceof Error ? err.message : String(err)})`
              }
            })(),
            diff:
              d.gitUnifiedDiff?.(baseSha, head) ??
              '(the diff of the judged head against its base could not be computed this round)',
            priorFindings: buildPriorRoundFindingsText(root, task, c.round)
          })
        : false

      // ONCE per round, after the
      // head-verified candidate is built and BEFORE either reviewer is
      // dispatched, decide the agent-config scan from the pull request's
      // changed paths and run the configured scanner on that candidate copy
      // in a constructed environment with no forge credential. The outcome
      // reaches the SECURITY prompt only (`facts.configScan` — the
      // code-reviewer never sees it) and is recorded in the driver Log; a
      // not-configured, not-applicable or failed scan is reported to the
      // reviewer and logged, and the round proceeds — never a pause.
      // The whole decision is wrapped so a scan-infrastructure error (an
      // unreadable trust anchor, a git failure resolving changed paths)
      // degrades to "the scan could not run" rather than crashing the round.
      {
        let scanOutcome: SecurityScanOutcome
        try {
          scanOutcome = decideSecurityScan({
            command: d.resolveSecurityScanCommand ? d.resolveSecurityScanCommand() : null,
            changedPaths: (() => {
              if (branchChangedPathsError !== null) throw branchChangedPathsError
              return branchChangedPaths ?? []
            })(),
            candidateDir,
            runScan: d.runSecurityScanSubprocess ?? (() => ({ ok: false, reason: 'no scanner runner is available' }))
          })
        } catch (scanErr) {
          scanOutcome = { kind: 'failed', reason: scanErr instanceof Error ? scanErr.message : String(scanErr) }
        }
        facts.configScan = scanOutcome
        const scanDetail = scanOutcome.kind === 'failed' ? `failed reason=${scanOutcome.reason}` : scanOutcome.kind
        appendRoleLine(
          loopLogPath,
          'dev-review-loop',
          `security_scan: round=${c.round} head=${head} outcome=${scanDetail}`
        )
      }

      try {
        // O1/O2: the evidence report runs IN PARALLEL with both reviewer
        // dispatches, never before or after them — reviewers dispatch on
        // the green head without waiting on the report, and the report
        // never waits on reviewers either. A report failure is logged,
        // never a pause: this task exists precisely so the loop's own
        // paperwork can never cost a round (O1's origin — a report that
        // took over ten minutes idled the session twice). The merge
        // gate's own `evidence-fresh` check is the real backstop for a
        // report that never lands.
        appendDriverLine(loopLogPath, `Reviewers starting round ${c.round}`, 'round')
        // Settled together, never `Promise.all`: one role's failure (a
        // confinement violation, an unreadable report) must not end the
        // round while its sibling is still running. The round waits for
        // both, keeps a sibling that finished (`keepSiblingVerdictOnPause`)
        // and only then raises the failure — so the cleanup below never
        // removes a scratch copy a still-running sibling works in.
        const [reviewerSettled, securitySettled, evidenceSettled] = await Promise.allSettled([
          dispatchReviewer(c, 'reviewer', c.round, facts, candidateDir, candidateInputsReady),
          dispatchReviewer(c, 'security', c.round, facts, candidateDir, candidateInputsReady),
          d.runEvidenceReport(c.prNumber, worktreePathForBranch(), branch)
        ])
        if (reviewerSettled.status === 'rejected' || securitySettled.status === 'rejected') {
          const settled = [
            { role: 'reviewer' as const, result: reviewerSettled },
            { role: 'security' as const, result: securitySettled }
          ]
          for (const { role, result } of settled) {
            if (result.status === 'fulfilled') {
              keptSiblingNote = keepSiblingVerdictOnPause(c, c.round, role, result.value.verdict)
            }
          }
          const failure = settled.find((s) => s.result.status === 'rejected')?.result as PromiseRejectedResult
          throw failure.reason
        }
        if (evidenceSettled.status === 'rejected') throw evidenceSettled.reason
        const evidenceOutcome = evidenceSettled.value
        verdicts = [reviewerSettled.value, securitySettled.value]
        if (!evidenceOutcome.ok) {
          // Logged to the driver's own role log, never a PR comment: a
          // report failure is never counted toward `no_progress` or a
          // pause (O1's whole point), and the `evidence-fresh` merge-gate
          // check is the real backstop for a block that never lands —
          // this line exists purely so a Principal reading
          // `vinaya task status --follow` can see why.
          appendRoleLine(
            loopLogPath,
            'dev-review-loop',
            `evidence_report_failed: round=${c.round} head=${head} reason=${evidenceOutcome.reason}`
          )
        }
      } catch (err) {
        if (
          !(err instanceof ReviewerInfrastructureFailure) &&
          !(err instanceof ReviewerResultRejected) &&
          !(err instanceof ReviewerConfinementViolation)
        )
          throw err
        // An invalid result is a failure
        // observation, never something a reader could mistake for a
        // clean, empty `verdicts_read` — this role never reached one, so
        // its own `role_attempt` line is the only durable record of the
        // attempt at all. `usage`/`attempt` stay honestly unavailable at
        // this generic catch site, but `effect_id`/`duration_ms` are the
        // failing attempt's own REAL values (round 2 review, MAJOR: a
        // freshly minted id here could never be joined back to the
        // `dispatch`/`role_attempt`/`usage` lines `dispatchRole` already
        // logged for that same attempt, and the whole round's elapsed
        // time is not this attempt's own duration) — carried on the
        // thrown error by `buildVerdictFromReview`'s own `handle`
        // parameter (`ReviewerResultRejected`) or the last dispatch
        // attempt in `dispatchReviewer`'s retry loop
        // (`ReviewerInfrastructureFailure`). `null` only in the
        // structurally unreachable case where no attempt ever produced
        // a handle at all.
        log({
          kind: 'role_attempt',
          event: 'attempted',
          payload: {},
          actor: err.role,
          attempt: null,
          effect_id: err.attemptEffectId ?? randomUUID(),
          model: dispatchAgent,
          outcome: err instanceof ReviewerInfrastructureFailure ? 'infrastructure_failed' : 'incomplete',
          usage: null,
          duration_ms: err.attemptDurationMs ?? d.now() - c.roundStartMs
        })
        const stats = computeStats(c, head, c.roundStartMs)
        // No round verdict exists, so the round is never closed here: no
        // `round_ended` (whose only outcome on this path would claim
        // `changes_requested` with no findings) — the resumed run reviews
        // this same round on this same head and ends it then.
        await logEvents(
          driverDecidedPauseEvents(config.loopId, c.state, c.round, stats, 'infrastructure').filter(
            (event) => event.event !== 'round_ended'
          )
        )
        c.decision = {
          type: 'pause',
          reason: 'infrastructure',
          detail: keptSiblingNote ? `${err.message} — ${keptSiblingNote}` : err.message
        }
        c.infrastructureRetries += 1
      } finally {
        // O3: this round's candidate and every scratch copy any attempt
        // created — removed the moment the round's reviewer dispatches
        // are done with it, whether the round published, paused, or is
        // about to hand another round back to the developer. Never
        // conditioned on `verdicts` being set: an infrastructure failure
        // above still built a candidate/scratch worth cleaning up.
        cleanupReviewerIsolationForRound(root, task, c.round)
      }

      if (verdicts) {
        // O2: the loop's own publication self-check — objectives may have
        // moved between the dispatch above (`facts.manifest`, captured
        // before either reviewer ran) and now, right after both finished
        // (a principal's `issue objectives edit`, a ruling, a brief
        // supersession, or — in principle — a policy change can each land
        // mid-round). Re-resolved BEFORE either verdict is held: neither
        // `verdicts` value (still in-memory only) is ever written to disk
        // on a mismatch, so "the held verdicts … are discarded" holds by
        // never holding them. `compareManifest` — the SAME comparison the
        // merge gate calls — decides this, field by field, rather than a
        // second, hand-rolled inequality check per field: the echo here
        // is simply `facts.manifest` itself, never a
        // round-trip through the rendered text (Traps to avoid — nothing
        // to trust or distrust when the value is this driver's own, still
        // in memory).
        const reassessedObjectives = await withRateLimitWait(c, () => d.resolveIssueObjectives(task))
        const reassessedRulingOrdinal = await withRateLimitWait(c, () => d.fetchNewestRulingOrdinal(c.prNumber))
        const reassessedBriefContent = await withRateLimitWait(c, () => d.fetchFrozenBrief(task))
        const currentManifest: ReviewInputManifest = buildReviewInputManifest({
          headSha: head,
          baseSha,
          briefContent: reassessedBriefContent,
          objectivesVersion: reassessedObjectives.version,
          rulingOrdinal: reassessedRulingOrdinal,
          pauseBoundRuling,
          policy: c.policy
        })
        const binding = compareManifest(manifestAsEchoed(facts.manifest), currentManifest)
        if (!binding.objectivesVersion) {
          const command = reassessedObjectives.edit
            ? describeObjectivesEdit(task, reassessedObjectives.edit)
            : `vinaya issue objectives edit ${task} ... (edit comment not found on re-read)`
          const detail = `objectives moved from ${facts.manifest.objectivesVersion ?? 'none'} to ${
            reassessedObjectives.version ?? 'none'
          } between reviewer dispatch and assessment — superseded by \`${command}\``
          const stats = computeStats(c, head, c.roundStartMs)
          await logEvents(driverDecidedPauseEvents(config.loopId, c.state, c.round, stats, 'objectives_changed'))
          c.decision = { type: 'pause', reason: 'objectives_changed', detail }
        } else if (!binding.rulingOrdinal) {
          const detail = `a new ruling landed between reviewer dispatch and assessment — ruling ordinal moved from ${facts.manifest.rulingOrdinal} to ${reassessedRulingOrdinal} — superseded by ruling ${c.prNumber}-${reassessedRulingOrdinal}`
          const stats = computeStats(c, head, c.roundStartMs)
          await logEvents(driverDecidedPauseEvents(config.loopId, c.state, c.round, stats, 'ruling_posted'))
          c.decision = { type: 'pause', reason: 'ruling_posted', detail }
        } else if (!binding.briefHash) {
          const detail = `the frozen brief was superseded between reviewer dispatch and assessment — brief hash moved from ${facts.manifest.briefHash ?? 'none'} to ${currentManifest.briefHash ?? 'none'}`
          const stats = computeStats(c, head, c.roundStartMs)
          await logEvents(driverDecidedPauseEvents(config.loopId, c.state, c.round, stats, 'brief_superseded'))
          c.decision = { type: 'pause', reason: 'brief_superseded', detail }
        } else if (!binding.policyDigest) {
          const detail = `the review policy changed between reviewer dispatch and assessment — policy digest moved from ${facts.manifest.policyDigest} to ${currentManifest.policyDigest}`
          const stats = computeStats(c, head, c.roundStartMs)
          await logEvents(driverDecidedPauseEvents(config.loopId, c.state, c.round, stats, 'policy_changed'))
          c.decision = { type: 'pause', reason: 'policy_changed', detail }
        } else {
          const [reviewer, security] = verdicts
          // Both roles genuinely finished (`Promise.all` did not reject) —
          // only now is it safe to hold either verdict on disk (O2's "nothing
          // is held … for that round" invariant; see `dispatchReviewer`'s doc
          // comment, above).
          writeHeldVerdict(root, task, c.round, 'reviewer', reviewer.verdict.rendered)
          writeHeldVerdict(root, task, c.round, 'security', security.verdict.rendered)
          // The round whose verdict is
          // now held on disk, awaiting delivery or publish — recovered
          // so a crash right after this write, before the round's own
          // outcome is even decided, is never silently forgotten.
          c.heldResultIdentity = { round: c.round, head }
          c.lastReviewContext = `${reviewer.verdict.rendered}\n\n---\n\n${security.verdict.rendered}`
          c.lastHandoffFindings = handoffFindings(c.round, reviewer.verdict.observation, security.verdict.observation)
          persistDeveloperHandoff({
            findings: c.lastHandoffFindings.map((finding) => ({ id: finding.id, description: finding.line }))
          })

          const roundVerdicts = [reviewer.verdict.observation, security.verdict.observation]
          // O1: capture this round's deferred findings WITH the reviewer
          // role now, while the verdict observations are in hand — keyed by
          // round so a re-observation replaces rather than duplicates.
          deferredByRound.set(c.round, deferredEntriesForRound(c.round, roundVerdicts))
          const obs: Observations = {
            kind: 'verdicts',
            round: c.round,
            verdicts: roundVerdicts
          }
          const result = assessRound(c.state, obs, taskClock())
          c.state = result.state
          c.decision = result.decision
          if (c.decision.type === 'pause' && c.decision.detail === undefined) {
            c.decision = {
              ...c.decision,
              detail: deriveVerdictPauseDetail(
                c.decision.reason,
                result.events,
                reviewer.verdict.observation.verdict === 'ESCALATE',
                security.verdict.observation.verdict === 'ESCALATE'
              )
            }
          }
          // issue-711 O3: `max_rounds` already carries its own detail
          // from `assessRound` ("max rounds: <n>") — the guard above
          // never touches it. Appended here, never replacing it, only
          // when the pre-loop patch-carry check (above) actually ran
          // and found a genuine mismatch — a human reading this pause
          // can tell "the cap is real, the patch changed" apart from a
          // cap that a patch-identical carry should have (and did)
          // already avoid.
          if (c.decision.type === 'pause' && c.decision.reason === 'max_rounds' && c.patchCarryNote !== null) {
            c.decision = { ...c.decision, detail: `${c.decision.detail ?? ''} — ${c.patchCarryNote}`.trim() }
          }
          // The live check runs here, on the head both reviewers just
          // approved and before the round's events are logged — never
          // earlier, since a `[live]` line runs the pull request's own
          // code with this host's sign-ins in reach. A failed line
          // withdraws the approval: the held verdicts are discarded, the
          // round ends `changes_requested` in the log rather than green,
          // and the Developer is sent back as a new round, exactly as a
          // blocking finding does, so the next head is reviewed before its
          // lines run. At the round cap the loop pauses `max_rounds`.
          let roundEvents = result.events
          if (c.decision.type === 'publish') {
            c.approvedBriefContent = reassessedBriefContent
            const liveFailures = await runLiveGate(c, head, reassessedBriefContent)
            c.liveCheckedHead = head
            if (liveFailures.length > 0) {
              const atCap = c.round >= config.maxRounds
              const withdrawn = withdrawApprovedRound(result.events, c.state, atCap)
              roundEvents = withdrawn.events
              c.state = withdrawn.state
              discardHeldVerdicts(root, task, c.round)
              c.heldResultIdentity = null
              const failedLines = liveFailures.map((f) => `\`${f.command}\` (${f.detail})`).join(', ')
              if (atCap) {
                c.decision = {
                  type: 'pause',
                  reason: 'max_rounds',
                  detail: `max rounds: ${config.maxRounds} — both reviewers approved ${head}, but its \`[live]\` line(s) failed: ${failedLines}`
                }
              } else {
                c.lastReviewContext = renderLiveWithdrawal(head, liveFailures)
                c.lastHandoffFindings = []
                persistDeveloperHandoff({ findings: [] })
                c.decision = { type: 'dispatch_developer' }
              }
            }
          }
          const routed = routeCompletionEvents(roundEvents, c.decision.type)
          c.pendingCompletionEvents = routed.toDeferUntilPublish
          await logEvents(routed.toLogNow)
          if (c.decision.type === 'dispatch_developer') c.round += 1
          persistCurrentLoopState(c.decision.type, c.decision.type === 'pause' ? c.decision.reason : undefined)
        }
      } else {
        persistCurrentLoopState(c.decision.type, c.decision.type === 'pause' ? c.decision.reason : undefined)
      }
    }

    if (c.decision.type === 'publish') {
      // A held clean verdict carried to this run (above) was approved by
      // an earlier run, which may have stopped before its live check: the
      // lines run here before it is published. The round's events were
      // logged by that run, so a failure here records nothing new in the
      // log beyond the role line; the approval is still withdrawn.
      const approvedHead = c.lastDispatchedManifest?.headSha ?? d.resolveHead(branch)
      if (c.liveCheckedHead !== approvedHead && c.approvedBriefContent === null) {
        throw new Error(`the live check has no frozen brief read for the approved head ${approvedHead}`)
      }
      const liveFailures =
        c.liveCheckedHead === approvedHead || c.approvedBriefContent === null
          ? []
          : await runLiveGate(c, approvedHead, c.approvedBriefContent)
      if (liveFailures.length > 0) {
        discardHeldVerdicts(root, task, c.round)
        c.pendingCompletionEvents = []
        c.heldResultIdentity = null
        if (c.round >= config.maxRounds) {
          await logEvents(
            driverDecidedPauseEvents(
              config.loopId,
              c.state,
              c.round,
              computeStats(c, approvedHead, c.roundStartMs),
              'max_rounds'
            )
          )
          c.decision = {
            type: 'pause',
            reason: 'max_rounds',
            detail: `max rounds: ${config.maxRounds} — both reviewers approved ${approvedHead}, but its \`[live]\` line(s) failed: ${liveFailures.map((f) => `\`${f.command}\` (${f.detail})`).join(', ')}`
          }
          persistCurrentLoopState(c.decision.type, c.decision.reason)
        } else {
          c.lastReviewContext = renderLiveWithdrawal(approvedHead, liveFailures)
          c.lastHandoffFindings = []
          persistDeveloperHandoff({ findings: [] })
          c.round += 1
          c.decision = { type: 'dispatch_developer' }
          persistCurrentLoopState(c.decision.type)
          continue
        }
      }
    }

    if (c.decision.type === 'publish') {
      // O5: mergeability is read AGAIN before
      // publication — reviewers can take long enough that a clean head
      // falls into conflict with the base while they worked. A branch
      // that fell into conflict has its held verdicts for this round
      // discarded (never published against a head that cannot merge);
      // the developer is resumed to resolve, and round does not advance,
      // so the NEXT reviewer dispatch judges the resolved head.
      const mergeableForPublish = await pollMergeableState(c.prNumber, d)
      if (mergeableForPublish === 'CONFLICTING') {
        discardHeldVerdicts(root, task, c.round)
        // This round's deferred completion events described an outcome
        // (`publish`) that is no longer real — dropped rather than logged
        // against whichever LATER round genuinely publishes next.
        c.pendingCompletionEvents = []
        publicationState.pendingConflictFiles = await withRateLimitWait(c, () =>
          d.fetchConflictingFiles('main', branch)
        )
        c.decision = { type: 'dispatch_developer' }
        // The held-verdict files this round's `heldResultIdentity` named
        // were just discarded above — nothing is held any more.
        c.heldResultIdentity = null
        persistCurrentLoopState(c.decision.type)
        continue
      }
      publicationState.pendingConflictFiles = null

      // O8 (round 2 review, BLOCKER): re-check staleness here too — a
      // clean `dispatch_reviewers` → `publish` transition reaches this
      // point in the SAME iteration, with no loop-back to the top in
      // between, so the top-of-loop check alone never catches a base that
      // moved past this driver's own code while reviewers were working.
      if (await checkStaleDriver()) {
        continue
      }

      // O1/O3: the findings this loop set aside rather than let block are
      // tracked in one backlog Issue per pull request, so they are not
      // lost once the loop closes. Opened or updated ONLY when a round
      // actually deferred something (O3: a clean run opens nothing); the
      // returned reference is linked from the published summary below.
      // Written before `publishRound` so a `gh` failure here throws into
      // the same outer catch that turns a failed publication into an
      // infrastructure pause, retried idempotently next round (O2: found
      // by its body marker, never a second Issue).
      const deferredFindings = [...deferredByRound.entries()]
        .sort(([a], [b]) => a - b)
        .flatMap(([, entries]) => entries)
      const deferredIssue =
        deferredFindings.length > 0
          ? d.writeDeferredFindingsIssue({ prNumber: c.prNumber, entries: deferredFindings })
          : undefined

      d.publishRound(root, {
        task,
        round: c.round,
        prNumber: c.prNumber,
        // issue-711 O1: the round's OWN judged head — `lastDispatchedManifest`'s
        // when one was actually dispatched or carried this run (the ONLY
        // two ways `decision.type` ever becomes `'publish'`), never a
        // live re-resolve. A live `d.resolveHead(branch)` is correct only
        // by coincidence on the ordinary same-iteration
        // `dispatch_reviewers` → `publish` path (nothing has pushed since
        // `head` was captured) and is flatly wrong on the patch-carry
        // path below: the verdict being posted there is the OLD text,
        // addressed to the OLD head, and a live head that has since
        // moved (even patch-identically) would make `publishRound`'s own
        // exact re-parse check fail.
        expectedHead: c.lastDispatchedManifest?.headSha ?? d.resolveHead(branch),
        journal: { rounds: c.state.rounds },
        policy: c.policy,
        // The manifest this round was dispatched against (O3) —
        // the pre-hold self-check already proved it did not drift before
        // either verdict was held, so binding the posted comments against
        // it is the same field-complete check the gate applies. Non-null
        // on every real path here: a `publish` decision is only ever set
        // inside the `dispatch_reviewers` branch that just assigned it,
        // or (issue-711 O1) the patch-carry check below, which assigns
        // the held verdict's OWN manifest before setting `decision`.
        manifest:
          c.lastDispatchedManifest ??
          buildReviewInputManifest({
            headSha: d.resolveHead(branch),
            baseSha: await d.gitMergeBase(d.resolveHead(branch)),
            briefContent: d.fetchFrozenBrief(task),
            objectivesVersion: d.resolveIssueObjectives(task).version,
            rulingOrdinal: d.fetchNewestRulingOrdinal(c.prNumber),
            pauseBoundRuling,
            policy: c.policy
          }),
        // O1: the backlog Issue this round's deferred findings were just
        // tracked in, so the published summary links it; `undefined` when
        // nothing was deferred (O3).
        deferredIssue
      })
      // Only now — posts confirmed, not merely attempted — does the durable
      // log get to say this run completed. A throw above (a post that
      // failed, or re-parsed dirty) skips this entirely, so the log never
      // claims `merged_ready` for a run that did not actually finish.
      await logEvents(c.pendingCompletionEvents)
      // Published — nothing is held any more.
      c.heldResultIdentity = null
      persistCurrentLoopState('publish')
      return { finalDecision: c.decision, prNumber: c.prNumber, task }
    }

    if (c.decision.type === 'pause') {
      // 'infrastructure' and 'stale_driver' are the
      // loop's own two "the mechanics stalled, not a review verdict"
      // reasons (the gate-red bound, a missing-artifact reviewer retry
      // bound, a re-exec that could not proceed) — recoverable hiccups,
      // never a human decision point. Every other reason here IS a
      // decision only a Principal can make (escalation, max_rounds,
      // confidence, reappearance, no_push, objectives_changed,
      // ruling_posted, brief_superseded, policy_changed) and clears the
      // lock exactly as before — UNLESS the caller is the watching
      // driver itself (`retainDriverLock`, issue-711 O4, code review
      // round 1, BLOCKER): it is not done at ANY pause reason, it is
      // about to poll and likely call back in here itself, so the lock
      // stays held regardless of which reason this round paused for.
      // `runDriverLoop`'s own watch loop is what releases it, once it
      // decides the task is genuinely over (merged, closed, cancelled).
      if (
        keepDriverLock({
          kind: 'pause',
          reason: c.decision.reason,
          watched: input.retainDriverLock !== undefined
        })
      ) {
        c.keepLockAlive = true
      }
      const pauseHead = d.resolveHead(branch)
      // O1: best-effort, same discipline as the crash-catch pause site —
      // written BEFORE `pause-state.json` so its own real `escalationId`
      // (code review, round 2, MEDIUM — see `writeEscalation`'s own doc
      // comment) can be carried on `PauseState`.
      let escalationRecord: EscalationRecord | null = null
      try {
        escalationRecord = writeEscalationRecord({
          task,
          round: c.round,
          head: pauseHead,
          branch,
          pr: c.prNumber > 0 ? c.prNumber : null,
          runId,
          agent: dispatchAgent,
          reason: c.decision.reason,
          detail: c.decision.detail,
          evidence: c.lastReviewContext ?? undefined,
          ...bestEffortInputVersions()
        })
      } catch {
        // Best-effort — the pause state and comment below are the
        // authoritative record.
      }
      writePauseState(root, {
        task,
        round: c.round,
        head: pauseHead,
        branch,
        // The SAME normalization the other two pause writers apply. This
        // site is only ever reached with a resolved pull request today, so
        // nothing is broken without it — but leaving it as the one writer
        // that stores `prNumber` raw made the sentinel-to-`null` conversion
        // rest entirely on `readPauseState`'s read side for this path, and
        // a future path arriving here before the pull request resolves
        // would write `-1` straight back into the record.
        prNumber: c.prNumber > 0 ? c.prNumber : null,
        reason: c.decision.reason,
        detail: c.decision.detail,
        pausedAt: new Date().toISOString(),
        agent: dispatchAgent,
        ...(dispatchModel ? { model: dispatchModel } : {}),
        escalationId: escalationRecord?.escalationId,
        infrastructureRetries: c.infrastructureRetries
      })
      // O1: `postPauseComment` never
      // throws — a post that fails even after its own bounded retry
      // reports `posted: false` rather than escaping to crash the
      // driver or reach the outer catch, which would otherwise
      // overwrite `writePauseState`'s already-correct reason, above,
      // with a synthetic 'infrastructure' one.
      //
      // The `prNumber <= 0` branch is the same one the crash handler
      // already takes, for the same reason: a comment can only be posted
      // against a pull request that exists, and this site is not
      // structurally guaranteed to have one.
      const pauseInvocation = { agent: dispatchAgent, ...(dispatchModel ? { model: dispatchModel } : {}) }
      await logPauseCommentRetryIfNotable(
        c.round,
        c.prNumber <= 0
          ? d.postIssuePauseComment(
              task,
              branch,
              c.round,
              c.decision.reason,
              c.decision.detail,
              pauseInvocation,
              escalationRecord?.rulingOrdinal
            )
          : d.postPauseComment(
              task,
              c.round,
              pauseHead,
              c.prNumber,
              c.decision.reason,
              c.decision.detail,
              pauseInvocation
            )
      )
      // Every pause, regardless of
      // which branch above decided it, funnels through here exactly
      // once before returning — the one call site that makes every
      // pause reason's final round/budget/held-result state durable.
      persistCurrentLoopState('pause', c.decision.reason)
      return { finalDecision: c.decision, prNumber: c.prNumber, task }
    }
  }
}
