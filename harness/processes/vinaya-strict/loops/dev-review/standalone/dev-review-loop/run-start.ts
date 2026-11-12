import type { LoopRunContext } from './run-context.js'
import type { LoopResult } from './driver-helpers.js'

import { persistCurrentLoopState } from './run-state.js'

import { latestHeldRequestChanges } from './reviewer-dispatch.js'
import { logPauseCommentRetryIfNotable } from './developer-prompts.js'

import { announcePr } from './run-logging.js'
import { reconcileDeveloperResume } from './developer-context.js'
import { applyLoopHistory } from './run-state.js'

import { runPath } from '../../../../../../kernel/run-paths.js'
import { existsSync } from 'node:fs'
import { computeStats } from './round-report.js'
import { logEvents } from './run-logging.js'
import { driverDecidedPauseEvents } from './round-assess.js'
import { ensureRunDir } from '../../../../../../kernel/run-paths.js'
import { dirname } from 'node:path'
import { writeFileSync } from 'node:fs'
import { afterDeveloperTurnBeforePrPoll } from './developer-prompts.js'

import { TaskWorktreeDivergedError } from './developer-dispatch.js'
import { writePauseState } from './pause-resume.js'

import { renderDeveloperDoctrineBlock } from './developer-dispatch.js'
import { publishingInstructionLine } from './driver-helpers.js'
import { issueRulingsBlock } from './developer-prompts.js'
import { keptWorkNote } from './developer-prompts.js'
import { turnResultInstruction } from './turn-result.js'
import { dispatchDeveloper } from './developer-turn.js'
import { DeveloperStopSignal } from './developer-dispatch.js'
import type { EscalationRecord } from '../../../../../../kernel/connectors/checkpoint/control-store/index'
import { writeEscalationRecord } from './pause-resume.js'
import { bestEffortInputVersions } from './run-state.js'
import { nextRoundNumber } from '../../../../tools/dev-review-policy/journal-reconstruction'
import type { HeldCleanVerdict } from './reviewer-dispatch.js'
import { latestHeldCleanVerdict } from './reviewer-dispatch.js'

import { withRateLimitWait } from './rate-limit-waits.js'
import type { ReviewInputManifest } from '../../../../tools/task-contract/review-input-manifest'
import { buildReviewInputManifest } from '../../../../tools/task-contract/review-input-manifest'

import { compareManifest } from '../../../../tools/task-contract/review-input-manifest'
import { manifestAsEchoed } from '../../../../tools/task-contract/review-input-manifest'

import { isConcludedJournal } from '../../../../tools/dev-review-policy/journal-reconstruction'
import { cleanupAllStagedAgentConfigs } from './reviewer-isolation.js'
import { unboundFields } from './publication.js'
import { runRoundLoop } from './round-loop.js'
import { decideStop } from './stop-decision.js'
import { classifyDriverError } from './stop-decision.js'
import { absorbGitHubOutage } from './rate-limit-waits.js'
import { absorbRateLimit } from './rate-limit-waits.js'
import { DeveloperTurnResultPause } from './turn-result.js'
import { DispatchSandboxRefused } from './round-assess.js'
import { RequiredSourcesUnavailable } from '../../../../../../kernel/tools/source-provider.js'
import type { DevReviewLoopEventInput } from '../../../../tools/dev-review-policy/types'
import { driverCrashEvents } from './round-assess.js'
import type { DriverErrorClass } from './stop-decision.js'
import { isGitHubRateLimitError } from './round-assess.js'
import { DispatchUsageLimit } from './round-assess.js'
import { usageLimitPauseDetail } from './round-assess.js'
import { rateLimitPauseDetail } from './round-assess.js'
import { RateLimitWaitsSpent } from './round-assess.js'
import type { StopEvent } from './stop-decision.js'
import { pauseForDriverError } from './stop-decision.js'
import { keepDriverLock } from './driver-lifecycle.js'
import { spendsInfrastructureRetry } from './round-assess.js'

export async function startRun(c: LoopRunContext): Promise<LoopResult> {
  const { d, root, task, branch, dispatchAgent, dispatchModel, config, runId, recordDriverExited, pauseBoundRuling } = c
  try {
    // A corrupt control-store loop-state record is refused HERE, first
    // thing inside the `try` (round 2 review, BLOCKER) — never at the
    // earlier `recoverLoopState` call site, which sits before this `try`
    // even starts and would let the throw escape uncaught. Thrown here,
    // it reaches the SAME outer `catch` below as every other setup
    // failure on this path, which decides `pause{reason:'infrastructure'}`,
    // writes the pause state, posts the pause comment, and keeps the
    // driver lock alive — never a silent crash with no forge-visible
    // trace at all.
    if (c.recoveredLoopState.status === 'corrupt') {
      throw new Error(
        `devReviewLoop: task ${task}'s control-store loop-state record is corrupt: ${c.recoveredLoopState.reason} — refusing to recover budgets from it.`
      )
    }

    // Which severities block is repository policy (task 8,
    // O1/O4) — resolved once, from the default branch, and reused for
    // every round's derivation and this run's publication self-check; the
    // gate reads the identical source (`check-review-gate.ts`). `config`
    // (built above with the repo-wide default) is corrected in place the
    // moment this succeeds — same object, every closure already holding a
    // reference to it sees the real value from here on.
    c.policy = d.reviewPolicy()
    config.maxRounds = c.policy.maxRounds
    config.maxTaskMinutes = c.policy.maxTaskMinutes
    c.repoRoot = d.repoRoot()
    c.baseHeadAtStart = d.gitRevParseOriginMain()

    // issue-812 (O1/O2): the phase this driver is taking the task over into,
    // recorded BEFORE it dispatches anything — a fresh start, a re-attach or
    // a resume all pass through here, ahead of every dispatch site below
    // (the fresh round-1 `dispatchDeveloper`, the branch-exists resume, the
    // attach redelivery, and the whole `runRoundLoop`). The bug this closes:
    // the loop writes `loop_state`/`pause-state.json` only when its phase
    // CHANGES, so a run that paused and was later taken over left `loop_state`
    // reading `phase: 'pause'` for the whole first turn of the new run — up to
    // an hour of live developing — and `task status`/`task_status` read that
    // stale phase and reported the live run as paused. The recovered round is
    // preserved (`Math.max` — the same non-regressing seed line 2888 below
    // re-applies after the held-verdict/forge-marker recovery, harmless to
    // repeat here), so this supersedes only the phase, never the round the
    // earlier run reached; budgets/held/delivered ride the same recovered
    // defaults every `persistCurrentLoopState` call already uses. The older
    // pause record itself is never touched (O2: kept as history) — while this
    // driver's lock is alive `deriveLoopState` already reads `running` over it,
    // and this write is what stops the phase column from still saying `paused`.
    // Every genuine transition below overwrites this in place, so a run that
    // goes straight to reviewers or publish records that within its own first
    // phase change.
    if (c.recoveredLoopState.status === 'ok') c.round = Math.max(c.round, c.recoveredLoopState.value.round)
    persistCurrentLoopState(c, 'dispatch_developer')

    // O8: `resumeHeadAlreadyMoved` widens this exactly like a fresh round-1
    // attach — the developer already pushed the fix a ruling asked for, so
    // this run dispatches no developer at all and goes straight to the
    // gate/reviewer path below, on the head that's already there.
    if (c.resumeFrom) {
      // O2: resuming — the PR and branch are already known (`resumeFrom`), so
      // there is no round-1 dispatch and no PR to poll for. `lastReviewContext`
      // carries the Principal's ruling(s) instead of a reviewer's findings;
      // `resumedDispatch` (below) labels the prompt accordingly, once.
      const rulings = d.fetchRulings(c.prNumber)
      c.lastReviewContext = rulings.map((r, i) => `${i + 1}. ${r}`).join('\n')
      c.lastHandoffFindings = null
      // An automatic recovery (`'infrastructure'`/`'stale_driver'`) on an
      // unmoved head owes the Developer a fix turn only when held reviewer
      // findings for THAT head exist to deliver. A pause raised in the
      // reviewer phase held none — the round never finished — so the
      // resumed run reviews the same head afresh instead of handing the
      // Developer a turn with nothing to fix.
      if (
        !c.resumeHeadAlreadyMoved &&
        (c.resumeFrom.reason === 'infrastructure' || c.resumeFrom.reason === 'stale_driver')
      ) {
        const heldFindings = latestHeldRequestChanges(root, task)
        if (heldFindings === null || heldFindings.head !== c.resumeFrom.head) {
          c.firstPass = true
          c.resumedDispatch = false
        }
      }
      // O1: the pause comment this run
      // is resuming from may never have reached the forge (a network
      // drop mid-post, or the pause path's own exhausted retry) — the
      // local record (`resumeFrom`) is what is authoritative; the
      // comment is only ever a projection of it. Re-posting here is a
      // no-op when it already landed (`postPauseComment`'s own
      // idempotent identity check reads the SAME `pause-<round>-<head>`
      // key its original post used) and posts the missing copy, once,
      // when it didn't — before this run does anything else. Skipped
      // once the head has already moved past the held pause (O8): that
      // identity is superseded by the fix already pushed, and reposting
      // here would build a DIFFERENT key (`resumeFrom.round` widened to
      // the ruling's own ordinal) than the one the original post ever
      // used, never actually completing it.
      if (!c.resumeHeadAlreadyMoved) {
        await logPauseCommentRetryIfNotable(
          c,
          c.resumeFrom.round,
          d.postPauseComment(
            task,
            c.resumeFrom.round,
            c.resumeFrom.head,
            c.prNumber,
            c.resumeFrom.reason,
            c.resumeFrom.detail,
            {
              agent: dispatchAgent,
              ...(dispatchModel ? { model: dispatchModel } : {})
            }
          )
        )
      }
    } else {
      // O4: round-1 entry — attach to an existing open PR, resume once to open
      // one on a remote branch that has none, or dispatch fresh. Checked in
      // that order: an open PR on the exact branch `developerBranchFor`
      // derives is the strongest signal (Traps: never attach to a closed or
      // merged one — `findOpenPrForBranch`'s own `--state open` filter already
      // guarantees that); only then does a remote-branch-with-no-PR check make
      // sense, since a branch with an open PR obviously also exists remotely.
      const existingPr = d.findOpenPrForBranch(branch)
      if (existingPr) {
        // Attach: no developer dispatch here at all — the recorded session is
        // read now so a LATER round's resume (if one is ever needed) resumes
        // the SAME session rather than starting fresh; round 1's own gate runs
        // next, unmodified, straight off `firstPass` — UNLESS O4 (below)
        // recovers a real round from held state.
        c.prNumber = existingPr.number
        announcePr(c)
        // O3: reconcile the prior launch before a later round resumes it —
        // an open PR means the branch is real work (`artifactsPresent`).
        reconcileDeveloperResume(c, true)
        applyLoopHistory(c)

        // O4 (task 3): a prior process may have
        // dispatched round k's reviewers, held REQUEST-CHANGES verdicts on
        // disk, and dispatched the developer — then crashed or was
        // restarted before ever observing whether the developer pushed a
        // fix. Left alone, `round` stays at its default of 1 and this
        // attach would re-run round 1's OWN gate check on a head that may
        // be several real rounds deep (previously, every attach
        // after a fix push re-delivered round 1's stale findings and
        // drifted into a confidence-collapse pause). Recovered here
        // instead, from the durable, machine-local held-verdict files.
        const held = latestHeldRequestChanges(root, task)
        if (held) {
          const currentHead = d.resolveHead(branch)
          if (currentHead !== held.head) {
            // The developer already pushed since round k's findings were
            // computed — never re-deliver round k's findings. `round` set
            // to k+1 and `firstPass` left at its default `true` (attach)
            // is exactly the existing, already-tested fallthrough: no
            // developer dispatch here, straight to round k+1's own gate
            // check, which itself decides `dispatch_reviewers` once green.
            c.round = held.round + 1
          } else {
            // Head unchanged — round k's findings were never actually
            // delivered to the developer (or the developer hasn't
            // responded yet). Never a third consecutive attempt on the
            // SAME head with no push in between: the second one reads as
            // `no_progress`, not another redelivery drifting toward a
            // confidence collapse.
            const marker = runPath(root, task, { area: 'round', round: held.round, file: 'attach-redelivered' })
            // The control-store
            // `deliveredFindings` identity backs up the SAME "already
            // delivered" fact the local marker file records — checked
            // alongside it, never instead of it, so a machine whose local
            // marker was lost (a different host, an outbox that was
            // cleaned) still refuses a second redelivery of the same
            // (round, head) pair.
            const alreadyDeliveredInStore =
              c.deliveredFindingsIdentity !== null &&
              c.deliveredFindingsIdentity.round === held.round &&
              c.deliveredFindingsIdentity.head === currentHead
            const markerPresent = existsSync(marker)
            if (markerPresent || alreadyDeliveredInStore) {
              const stats = computeStats(c, currentHead, d.now())
              await logEvents(c, driverDecidedPauseEvents(config.loopId, c.state, held.round + 1, stats, 'no_progress'))
              // O3: names WHICH of the two independent guard inputs was
              // observed true — a local marker this machine wrote
              // earlier, a control-store identity a (possibly different)
              // machine wrote — so a comment where neither actually held
              // is visibly wrong, rather than reading identically to an
              // ordinary redelivery pause.
              c.decision = {
                type: 'pause',
                reason: 'no_progress',
                detail: `round ${held.round} findings delivered again on unchanged head ${currentHead}, with no developer push since the first delivery (guard: local marker file ${markerPresent ? 'present' : 'absent'}, control-store delivered-findings identity ${alreadyDeliveredInStore ? 'matched' : 'absent'})`
              }
            } else {
              ensureRunDir(dirname(marker), root)
              writeFileSync(marker, new Date().toISOString(), 'utf8')
              c.round = held.round + 1
              c.lastReviewContext = held.rendered
              // A recovered verdict carries only its rendered text — no ids to hand over.
              c.lastHandoffFindings = null
              c.firstPass = false
              c.deliveredFindingsIdentity = { round: held.round, head: currentHead }
              persistCurrentLoopState(c, 'dispatch_developer')
            }
          }
        }
      } else {
        let branchHead: string | null = null
        try {
          branchHead = d.resolveHead(branch)
        } catch {
          branchHead = null
        }
        // A task branch whose head is contained in origin/main has no task
        // commits beyond the default branch. It is only an address
        // reservation even when main has advanced since the ref was created.
        // Recovery begins only once the task branch has moved beyond main.
        const branchHasTaskCommits = branchHead !== null && !d.gitIsAncestor(branchHead, d.gitRevParseOriginMain())
        if (branchHasTaskCommits) {
          // Crash-recovery re-entry: the branch already exists (pushed by a
          // prior process), no dispatch here. The Developer publishes through
          // the driver-run tools during its own turn (`publish_changes`,
          // `open_pull_request`), so the driver keeps no durable publication
          // record to finish on restart — any turn interrupted mid-publish is
          // re-dispatched and republishes idempotently through the tools.
          // `afterDeveloperTurnBeforePrPoll` finds the open PR (or resumes
          // once to open it, the pre-existing safety net).
          c.prNumber = await afterDeveloperTurnBeforePrPoll(c, true)
          announcePr(c)
        } else {
          // O1/O7: the branch either does not exist on the remote or is the
          // commit-free address reservation at or behind origin/main — create/reuse the task's own
          // worktree now, outside any sandbox, and push it to the remote FROM
          // that worktree, BEFORE the first Developer turn below. This is
          // what makes `devWorktreeDir` (below) non-null from round 1 on, so
          // the brief's own Step 0 can simply enter the worktree rather than
          // create it (`harness/processes/vinaya-strict/tools/task-contract/brief-render.ts`), and so a
          // dashboard reading only GitHub counts this task in flight from its
          // first minute instead of only after the Developer's first push.
          // A failed push is logged and swallowed here, never a reason the
          // loop stops: the Developer's own first push creates the same
          // remote branch later (Traps to avoid) — but a failed WORKTREE
          // creation is swallowed the same way for now, surfacing instead at
          // the Developer's own Step 0 (which can no longer fall back to
          // creating one itself), never a reason this driver turn stops.
          try {
            // An existing worktree on this commit-free branch is moved to
            // the default tip with its remote branch, so the files the
            // first turn reads are the ones the brief's pins were taken from.
            d.createTaskWorktree(branch, { branchHasTaskCommits })
            console.error(`vinaya dev-review-loop: created task worktree and branch ${branch} on origin at start`)
          } catch (err) {
            if (err instanceof TaskWorktreeDivergedError) {
              // The remote branch is ahead of the existing worktree, which
              // holds its own unpublished work: reconciling would mean
              // discarding one side, so the start pauses for the Operator
              // and dispatches no Developer.
              const detail = `the start found task branch ${err.branch} on origin at ${err.remoteHead}, while the existing worktree is at ${err.worktreeHead} and cannot fast-forward to it; reconcile the worktree with the remote branch, then resume`
              writePauseState(root, {
                task: task,
                round: c.round,
                head: err.worktreeHead,
                branch: branch,
                prNumber: null,
                reason: 'escalation',
                detail,
                pausedAt: new Date().toISOString(),
                agent: dispatchAgent,
                ...(dispatchModel ? { model: dispatchModel } : {}),
                infrastructureRetries: c.infrastructureRetries
              })
              await logPauseCommentRetryIfNotable(
                c,
                c.round,
                d.postIssuePauseComment(task, branch, c.round, 'escalation', detail, {
                  agent: dispatchAgent,
                  ...(dispatchModel ? { model: dispatchModel } : {})
                })
              )
              c.decision = { type: 'pause', reason: 'escalation', detail }
              recordDriverExited('paused')
              return { finalDecision: c.decision, prNumber: 0, task: task }
            }
            console.error(
              `vinaya dev-review-loop: could not create task worktree/branch ${branch} on origin at start: ${err instanceof Error ? err.message : String(err)} — continuing; the developer's first push will create it`
            )
          }

          // Round 1: fresh dispatch, brief read from the frozen Issue comment
          // (O1). What happens next — check, at most one resume, poll — is
          // O2/O3/O9's own job, never blind.
          const brief = d.fetchFrozenBrief(task)
          // O1/O3: a genuinely fresh (non-resumed) developer
          // session is prepended its role's short version and its two
          // checklist sections — resolved through the override-aware role
          // plan — OUTSIDE the frozen brief, so the brief text and its
          // verdict-binding hash (`briefHashOf(fetchFrozenBrief(task))`, never
          // this prompt) are untouched. A resumed session already holds this
          // from its first turn (`devResumeId !== null`) and is never
          // re-prepended (Traps to avoid). Best-effort: an unresolvable
          // doctrine dispatches the brief alone, the pre-task shape.
          let developerDoctrine: string | null = null
          if (c.devResumeId === null) {
            try {
              developerDoctrine = d.resolveDeveloperDoctrine ? await d.resolveDeveloperDoctrine() : null
            } catch {
              developerDoctrine = null
            }
          }
          // O4: round 1 publishes the SAME way for both agents — the
          // Developer calls the driver-run tools (`publish_changes` to commit
          // and push, `open_pull_request` to open the pull request from the
          // body it passes). No hand-off file and no per-agent split: the
          // publishing instruction is the one shared tool line, in the
          // preamble OUTSIDE the frozen brief — after the doctrine, before the
          // brief — so the brief stays the prompt's contiguous, byte-for-byte
          // suffix: its verdict-binding hash is computed from
          // `fetchFrozenBrief(task)`, never this prompt, and the invariant that
          // the doctrine (and now this instruction) are prepended OUTSIDE the
          // brief holds unchanged.
          const round1Prompt = [
            developerDoctrine ? renderDeveloperDoctrineBlock(developerDoctrine) : null,
            `When your work is ready, ${publishingInstructionLine()}`,
            issueRulingsBlock(c),
            keptWorkNote(c),
            turnResultInstruction(c.round),
            brief
          ]
            .filter((part): part is string => part !== null)
            .join('\n\n')
          await dispatchDeveloper(c, round1Prompt, c.round, {
            skipResumeContext: true
          })

          try {
            c.prNumber = await afterDeveloperTurnBeforePrPoll(c, false)
            announcePr(c)
          } catch (err) {
            if (!(err instanceof DeveloperStopSignal)) throw err
            // O9: no branch ever reached the remote, and the developer
            // posted a refusal/escalation instead — end the loop now, on the
            // Issue (there is no PR to comment on), never entering the poll.
            const detail = err.detail
            // O1 (round 2 review, security MEDIUM): the local record is
            // written BEFORE the post here too — this is the one pause/
            // escalation call site in this file that used to post straight
            // to the forge with no prior `writeEscalationRecord`/
            // `writePauseState`, unlike every other one. `head: 'unknown'`
            // mirrors the crash-handler's own sentinel (above) — no branch
            // ever reached the remote here, so there is no real head to
            // resolve. Best-effort exactly like the general pause branch:
            // a control-store write failure here never blocks the post.
            let escalationRecord: EscalationRecord | null = null
            try {
              escalationRecord = writeEscalationRecord({
                task: task,
                round: c.round,
                head: 'unknown',
                branch: branch,
                pr: null,
                runId: runId,
                agent: dispatchAgent,
                reason: 'escalation',
                detail,
                evidence: c.lastReviewContext ?? undefined,
                ...bestEffortInputVersions(c)
              })
            } catch {
              // Best-effort — the pause state and comment below are the
              // authoritative record; a control-store write failure here
              // never undoes them.
            }
            writePauseState(root, {
              task: task,
              round: c.round,
              head: 'unknown',
              branch: branch,
              // No pull request exists — recorded as having none, the same
              // `null` the escalation record above already writes for `pr`.
              // This used to be a `-1` sentinel, which every reader's own
              // "no pull request" guard then failed to recognize and handed
              // to `gh pr view -1` verbatim.
              prNumber: null,
              reason: 'escalation',
              detail,
              pausedAt: new Date().toISOString(),
              agent: dispatchAgent,
              ...(dispatchModel ? { model: dispatchModel } : {}),
              escalationId: escalationRecord?.escalationId,
              infrastructureRetries: c.infrastructureRetries
            })
            await logPauseCommentRetryIfNotable(
              c,
              c.round,
              d.postIssuePauseComment(
                task,
                branch,
                c.round,
                'escalation',
                detail,
                { agent: dispatchAgent, ...(dispatchModel ? { model: dispatchModel } : {}) },
                escalationRecord?.rulingOrdinal
              )
            )
            // Set `decision` before recording, so the `driver_exited`
            // event's `last_decision` names this escalation pause rather
            // than the default `dispatch_developer` this pre-round-loop path
            // never moved off.
            c.decision = { type: 'pause', reason: 'escalation', detail }
            recordDriverExited('paused')
            return { finalDecision: c.decision, prNumber: 0, task: task }
          }
        }
      }
    }

    // An attach with no locally-held request-changes file to recover
    // `round` from (`latestHeldRequestChanges`, above, returned null — a
    // different machine, or local state already cleaned) must still not
    // restart round numbering at 1 when the forge markers show real prior
    // rounds that never reached a published summary (`historyApplies` —
    // see `seedLoopHistory`'s own doc comment for why a task whose summary
    // WAS published never reaches here). The markers come from the pull
    // request's own developer round comments, never a log event. Never
    // applied to `--resume`: that round is deliberately the ruling's own
    // ordinal (O8), not the next sequential round, and `Math.max` never
    // regresses the more-precise, locally-held recovery above when both
    // agree or the local one is ahead.
    if (!c.resumeFrom && c.historyApplies) c.round = Math.max(c.round, nextRoundNumber(c.loopHistory.rounds))

    // The control store's own recovered round is the authoritative one —
    // `Math.max` only ever advances `round` here, never regresses it, so
    // every mechanism above (the ruling ordinal on `--resume`, the
    // locally-held request-changes recovery, the forge-marker fallback just
    // above) keeps winning whenever it already agrees or is ahead. What
    // this closes: a task whose held-verdict files AND forge markers are
    // both unavailable (a different machine, a GitHub read that fails, a
    // pull request whose comments were never posted) no longer silently
    // restarts numbering at 1 as long as this task's own control-store
    // record survived — the control store and the forge markers together
    // are the round-history source, never the Log.
    if (c.recoveredLoopState.status === 'ok') c.round = Math.max(c.round, c.recoveredLoopState.value.round)

    // Held back from `logEvents` until `publishRound` (below) actually
    // succeeds — `assessRound`'s one `journal_finalized`/`merged_ready` event
    // (`assess-round.ts`) always arrives bundled with a `publish` decision in
    // the SAME `result.events`, and logging it immediately, before the posts
    // it claims are done, is what let a crash mid-publish leave the durable
    // log asserting a completion the pull request never got (found by code
    // review as a MAJOR gap). Every other event in that same `result.events` — the
    // round's own `stop_condition_met`/`round_ended` — is true regardless of
    // whether publication later fails, so only this one event is deferred.

    /**
     * Round-number discipline: `round` increments ONLY when a genuine review
     * round (`dispatch_reviewers` → `verdicts`) concludes `changes_requested`
     * and hands back `dispatch_developer` for the next real round. A
     * mechanical-gate-red retry and a confidence-collapse "extra turn" (spec
     * §6.7: "may repeat once, for the same round") both resubmit the SAME
     * round number — `assessGate` itself is built for exactly this (`pending`
     * clears on both paths, and `state.extraTurnUsed` is a flat, round-
     * independent flag, so reusing the round number changes nothing about
     * whether the confidence rule's one-extra-turn bound is honored).
     * Advancing `round` on every `dispatch_developer` instead would make a
     * mechanical CI hiccup on round 1 silently start asking the round-1-never-
     * asks confidence question — a real behavioral bug, not a style choice.
     */

    /**
     * O10 (round 2 review, BLOCKER): every event this driver emits is
     * whatever `logEvents` is explicitly told to log — nothing synthesizes
     * the terminal event a genuinely uncaught error skips on its own. Left
     * alone, a crash mid-round left the log with `loop_started` and
     * `round_started` but no `paused`/`journal_finalized` at all,
     * permanently — exactly the shape O10 calls a test failure.
     * Deliberately `driverCrashEvents`, never `driverDecidedPauseEvents`:
     * the latter also fabricates a `round_ended`, wrong the moment the
     * crash strikes AFTER a real one already logged (`publishRound`
     * throwing post-green — see `driverCrashEvents`'s own doc comment).
     * Best-effort on the head: a `resolveHead` failure is itself a
     * plausible CAUSE of the crash being handled here, so this never lets
     * a secondary failure mask the original error.
     */

    // issue-711 O1/O3: a verdict judges a patch, not a head. This runs at
    // round start AND on resume — both paths (the attach branch above,
    // and the `resumePr` branch at the top of `devReviewLoop`) have
    // already converged into `round`/`branch`/`prNumber` by this point,
    // so one check covers both entry points, exactly as `check-review-gate.ts`
    // and this self-check share the SAME `compareManifest` comparison.
    // Gated on `prNumber > 0`: a task with no open PR yet has no held
    // verdict to carry (`latestHeldCleanVerdict` would read nothing
    // anyway). If the held clean verdict's own head is still bound to the
    // current one — exact identity, or a proven patch-identical rebase/
    // merge-from-base — this publishes it directly and `runRoundLoop`
    // never dispatches a fresh round. A field OTHER than head having
    // drifted (most commonly `rulingOrdinal`, the ordinary case when
    // `--resume` itself was triggered by a NEW Principal ruling) correctly
    // fails the comparison and falls through to a genuine fresh round
    // below — this never overrides an actual decision point, only a pure
    // head-address move (Traps to avoid: "carry verdicts only when every
    // other bound input … is also unchanged").
    if (c.prNumber > 0) {
      const heldClean: HeldCleanVerdict | null = latestHeldCleanVerdict(root, task)
      if (heldClean) {
        let currentHeadForCarry: string | null = null
        try {
          currentHeadForCarry = d.resolveHead(branch)
        } catch {
          // No remote head yet — nothing to carry against.
        }
        // Two guards, both required, neither redundant:
        //  - `currentHeadForCarry !== heldClean.head` — an UNCHANGED head
        //    is not this task's scope at all (O1 is about a head MOVE);
        //    the existing re-run behavior for an unmoved head — a genuine
        //    fresh round, its own `publishRound` call discovering nothing
        //    new to post via its own idempotent effect keys — is
        //    unaffected, on purpose (round 2 review: this exact path,
        //    unshortcut, is load-bearing test behavior elsewhere in this
        //    suite).
        //  - `heldClean.round === round` — `round` here already reflects
        //    every OTHER recovery this function ran above (the
        //    `historyApplies` forge-marker bump, the control-store
        //    `Math.max`); a held pair from an OLDER round than what those
        //    already established is stale — superseded by real progress
        //    since, never something to carry forward past it (the same
        //    "never falls back to an older round" discipline
        //    `latestHeldRequestChanges` already documents for its own
        //    read).
        if (currentHeadForCarry !== null && currentHeadForCarry !== heldClean.head && heldClean.round === c.round) {
          let carryBaseSha: string | null = null
          try {
            carryBaseSha = await d.gitMergeBase(currentHeadForCarry)
          } catch {
            // Unresolvable base — the comparison below fails closed on `null`.
          }
          const reassessedObjectives = d.resolveIssueObjectives(task)
          const carryBriefContent = await withRateLimitWait(c, () => d.fetchFrozenBrief(task))
          const currentManifestForCarry: ReviewInputManifest = buildReviewInputManifest({
            headSha: currentHeadForCarry,
            baseSha: carryBaseSha,
            briefContent: carryBriefContent,
            objectivesVersion: reassessedObjectives.version,
            rulingOrdinal: d.fetchNewestRulingOrdinal(c.prNumber),
            pauseBoundRuling: pauseBoundRuling,
            policy: c.policy
          })
          // A held record written before manifest v2 has no protocol or
          // pause-ruling slots. Preserve that record's legacy comparison
          // mode for recovery only; newly rendered v2 verdicts still must
          // echo both slots through the merge gate.
          const compatibleCurrentManifest: ReviewInputManifest =
            heldClean.manifest.manifestVersion === undefined
              ? {
                  headSha: currentManifestForCarry.headSha,
                  baseSha: currentManifestForCarry.baseSha,
                  briefHash: currentManifestForCarry.briefHash,
                  objectivesVersion: currentManifestForCarry.objectivesVersion,
                  rulingOrdinal: currentManifestForCarry.rulingOrdinal,
                  policyDigest: currentManifestForCarry.policyDigest
                }
              : currentManifestForCarry
          const carryBinding = compareManifest(
            manifestAsEchoed(heldClean.manifest),
            compatibleCurrentManifest,
            d.patchIdOf
          )
          if (carryBinding.bound) {
            // issue-711 O1: "publishes the held verdicts, OR treats the
            // published ones as current" — two different actions for two
            // different states, both read off the SAME `heldClean` round.
            // A round whose review has already CONCLUDED (held files are
            // never deleted after posting — see `HeldCleanVerdict`'s own doc
            // comment) must never re-run `publishRound`: its `journal`
            // argument is built from THIS process's own `state.rounds`,
            // empty here since `assessRound` never ran on this path, so a
            // genuine re-post would render a marker with no entry for
            // the round it names — a real content drift
            // `postPrCommentOnce`'s idempotency keys off, and exactly the
            // "second run posts nothing new" invariant this driver already
            // guarantees for the ordinary re-run case.
            //
            // `isConcludedJournal` is the SAME predicate `seedLoopHistory`
            // and the `--resume` replayed-resolution refusal use, so all
            // three agree about this pull request: a summary posted while
            // the gate no longer passes on the current state is NOT
            // concluded, and this path falls through to a genuine round
            // rather than treating a reopened review as published.
            const freshHistory = d.fetchLoopHistory(c.prNumber)
            if (isConcludedJournal(freshHistory)) {
              c.heldResultIdentity = null
              persistCurrentLoopState(c, 'publish')
              c.decision = { type: 'publish' }
              recordDriverExited('finished')
              // O2: the loop ends here (published) and will not resume, so
              // this task's staged per-dispatch agent-config homes are
              // removed — never on a pause, whose resume still needs them.
              cleanupAllStagedAgentConfigs(root, task)
              return { finalDecision: c.decision, prNumber: c.prNumber, task: task }
            }
            c.round = heldClean.round
            c.lastDispatchedManifest = heldClean.manifest
            c.approvedBriefContent = carryBriefContent
            c.heldResultIdentity = { round: heldClean.round, head: heldClean.head }
            c.decision = { type: 'publish' }
          } else {
            c.patchCarryNote = `held clean verdict from round ${heldClean.round} at head ${heldClean.head} does not cover the current head ${currentHeadForCarry} (unbound: ${unboundFields(carryBinding).join(', ')}) — starting a fresh round`
          }
        }
      }
    }

    // O2 (driver liveness): the one chokepoint every round-loop exit funnels through
    // — `runRoundLoop`'s own publish and decided-pause returns all land
    // here. One `driver_exited` per exit, its reason read from the actual
    // final decision (`publish` → finished, any pause → paused), guarded so
    // it never double-writes with the escalation/publish early returns
    // above or the crash `catch` below.
    // A GitHub rate limit that ends a round waits for the reset and
    // re-enters the loop on the SAME state (`decision`, `round` are this
    // closure's own); only `MAX_CONSECUTIVE_RATE_LIMIT_WAITS` waits in a row
    // with no round progress between them fall through to the outer
    // handler's pause. A connection failure to GitHub waits, unbounded,
    // until GitHub is reachable again and re-enters the same way. Every
    // other error goes there at once.
    let loopResult: LoopResult
    while (true) {
      try {
        loopResult = await runRoundLoop(c)
        break
      } catch (loopErr) {
        // Re-enter only when no role was dispatched in the iteration that
        // failed — re-entry re-runs the step `decision` names, and must
        // never dispatch a role twice. The reads that follow a dispatch
        // wait in place instead (`withRateLimitWait`); anything else that
        // lands after a dispatch pauses as it did before this wait existed.
        if (c.roleDispatchesInPass > 0) throw loopErr
        // The decision function owns the row: a connection failure to GitHub is
        // an unbounded wait here, spending no retry and asking for no ruling.
        const stop = decideStop({
          kind: 'driver_error',
          runner: 'loop',
          errorClass: classifyDriverError(loopErr),
          message: loopErr instanceof Error ? loopErr.message : String(loopErr),
          round: c.round
        })
        if (stop.type === 'wait') await absorbGitHubOutage(c, loopErr)
        else await absorbRateLimit(c, loopErr)
      }
    }
    recordDriverExited(loopResult.finalDecision.type === 'publish' ? 'finished' : 'paused')
    // O2: a published decision is the loop's genuine end — the task will
    // not resume — so this task's staged per-dispatch agent-config homes
    // (the Claude `CLAUDE_CONFIG_DIR`/Codex `CODEX_HOME` copies) are removed
    // now. A pause deliberately keeps them: its own resume, next round,
    // reads the very session store this would otherwise delete.
    if (loopResult.finalDecision.type === 'publish') cleanupAllStagedAgentConfigs(root, task)
    return loopResult
  } catch (err) {
    // A genuinely uncaught error — a gate error, a
    // dispatch error, a forge read error, any thrown exception on the
    // driver's own path — is now a decided `pause{reason:'infrastructure'}`
    // like any other infrastructure hiccup, never a re-thrown exception
    // that ends the process. `decision` (whatever it last held) is only
    // readable from inside this closure, so the trace is written here,
    // not in the outer `finally`. `keepLockAlive` (declared in the
    // enclosing `devReviewLoop`) is set here too — the same lock-stays-alive
    // treatment as the shared pause-return branch's own
    // 'infrastructure'/'stale_driver' cases below.
    // O3: a round that pauses on its turn result (`DeveloperTurnResultPause`)
    // is a decided pause, never a crash — logged as one, with its own typed
    // reason code.
    const turnResultPause = err instanceof DeveloperTurnResultPause ? err : null
    // A sandbox the host cannot run is a decided pause too, addressed to
    // the Operator — never an infrastructure crash the watcher retries.
    const sandboxRefusal = err instanceof DispatchSandboxRefused ? err : null
    // A required source the controller could not prepare is a decided
    // pause too, addressed to the Planner — never an infrastructure crash,
    // and never a turn continued on model memory.
    const missingSources = err instanceof RequiredSourcesUnavailable ? err : null
    const decidedPause = turnResultPause !== null || sandboxRefusal !== null || missingSources !== null
    if (!decidedPause) recordDriverExited('error', { error: err })
    let head = 'unknown'
    try {
      head = d.resolveHead(branch)
    } catch {
      // Left as 'unknown' — the schema only requires a string.
    }
    let decidedPauseEvents: DevReviewLoopEventInput[] | null = null
    if (decidedPause) {
      try {
        decidedPauseEvents = driverDecidedPauseEvents(
          config.loopId,
          c.state,
          c.round,
          computeStats(c, head, c.roundStartMs),
          turnResultPause?.reasonCode ?? (missingSources !== null ? 'missing_source' : 'sandbox_refused')
        )
      } catch {
        decidedPauseEvents = null
      }
    }
    await logEvents(c, decidedPauseEvents ?? driverCrashEvents(config.loopId, c.state, c.round, head))
    // `decision.detail` (below) carries the RAW error message — it lands only in this
    // MACHINE-local outbox (`writePauseState`, never posted anywhere) and
    // in `finalDecision`, which the CLI never prints past the bare reason.
    // `postPauseComment` (below) sanitizes its OWN `detail` argument
    // unconditionally now (`sanitizePublicPauseDetail`), so the raw string
    // passed here is never posted un-redacted — this call site no longer
    // needs its own separately-sanitized copy, and neither does any other
    // `postPauseComment` call in this file.
    // A sign-in refusal narrates itself (`DispatchSignInRefused`): the
    // pause a reader sees says the developer could not sign in, never
    // that an unnamed error ended the round.
    // The one decision function holds every stop: the error's class, plus
    // the detail only this closure can narrate (a usage limit's reset, a
    // rate limit's waits), goes in and the pause comes out. A connection
    // failure reaching here was not absorbed in place (a role was
    // dispatched in the iteration), so it pauses as it always did.
    // Here, as before, an error that is both a rate limit and a connection failure narrates as the rate limit.
    const classified = classifyDriverError(err)
    const errorClass: DriverErrorClass =
      missingSources !== null
        ? 'missing_source'
        : classified === 'forge_connection' && isGitHubRateLimitError(err)
          ? 'rate_limit'
          : classified
    const errorMessage = err instanceof Error ? err.message : String(err)
    const narration =
      errorClass === 'sandbox_refused' || errorClass === 'missing_source' || errorClass === 'sign_in_refused'
        ? errorMessage
        : err instanceof DispatchUsageLimit
          ? usageLimitPauseDetail(err.limit, d.now())
          : errorClass === 'rate_limit'
            ? `${rateLimitPauseDetail(
                c.round === c.roundAtLastWait ? c.rateLimitWaits : 0,
                err instanceof RateLimitWaitsSpent
                  ? err.resetEpochSeconds
                  : c.round === c.roundAtLastWait
                    ? c.lastRateLimitResetEpoch
                    : null
              )} (round ${c.round}: ${errorMessage})`
            : undefined
    const stopEvent: StopEvent = {
      kind: 'driver_error',
      runner: 'loop',
      errorClass,
      message: errorMessage,
      round: c.round,
      ...(narration !== undefined ? { narration } : {})
    }
    const decidedStop = decideStop(stopEvent)
    const stopPause = decidedStop.type === 'pause' ? decidedStop : pauseForDriverError(stopEvent)
    c.decision =
      turnResultPause !== null
        ? { type: 'pause', reason: turnResultPause.pauseReason, detail: turnResultPause.message }
        : { type: 'pause', reason: stopPause.reason, detail: stopPause.detail }
    // A host-repair pause ends this driver and frees the lock, so the
    // ordinary start can continue the task once the host is repaired.
    c.keepLockAlive = keepDriverLock({ kind: 'crash', hostRepair: sandboxRefusal !== null })
    // The SAME durable snapshot every
    // other pause reason gets, best-effort like the write itself already
    // is — a genuinely uncaught error is exactly the case this record
    // exists for, so the next attach/resume recovers this round's
    // budgets rather than starting a fresh in-memory count at zero.
    // A sign-in refusal and a GitHub rate limit spend no budget
    // (`spendsInfrastructureRetry`): a host with no credentials never
    // produced a round for that bound to bound, so no number of sign-in
    // pauses should ever demand a Principal ruling to resume past; a
    // rate limit is a wait for the reset, not a recoverable-hiccup retry.
    if (decidedPause) recordDriverExited('paused')
    else if (spendsInfrastructureRetry(err)) c.infrastructureRetries += 1
    persistCurrentLoopState(c, 'pause', c.decision.reason)
    // This bookkeeping is best-effort, never a second chance for the
    // process to crash on its way out — the ORIGINAL error is already
    // handled (this pause IS the handling); a forge write failing here
    // too (the exact fault that just took down the round, still live)
    // must never re-throw and undo it. `recordDriverExited` above already
    // follows the identical "never throws" discipline for the same
    // reason.
    try {
      // O1: the durable escalation record — best-effort (never a second
      // chance for the process to crash on its way out), written BEFORE
      // `pause-state.json` so its own real `escalationId` (code review,
      // round 2, MEDIUM: `writeEscalation` claims a disambiguating suffix
      // rather than silently overwriting a colliding, genuinely different
      // escalation) can be carried on `PauseState` for `--resume`/
      // `--cancel` to find later.
      let escalationRecord: EscalationRecord | null = null
      try {
        escalationRecord = writeEscalationRecord({
          task: task,
          round: c.round,
          head,
          branch: branch,
          pr: c.prNumber > 0 ? c.prNumber : null,
          runId: runId,
          agent: dispatchAgent,
          reason: c.decision.reason,
          detail: c.decision.detail,
          evidence: c.lastReviewContext ?? undefined,
          ...bestEffortInputVersions(c)
        })
      } catch {
        // Best-effort — the pause state and comment below are the
        // authoritative record; a control-store write failure here never
        // undoes them.
      }
      writePauseState(root, {
        task: task,
        round: c.round,
        head,
        branch: branch,
        // The SAME normalization the escalation record above already
        // applies to its own `pr` — a crash this early leaves the local
        // `prNumber` at its `-1` sentinel, and the pause record must say
        // "no pull request", not name one nothing was opened against.
        prNumber: c.prNumber > 0 ? c.prNumber : null,
        reason: c.decision.reason,
        detail: c.decision.detail,
        pausedAt: new Date().toISOString(),
        agent: dispatchAgent,
        ...(dispatchModel ? { model: dispatchModel } : {}),
        escalationId: escalationRecord?.escalationId,
        infrastructureRetries: c.infrastructureRetries
      })
      // A crash this early — setup, or a fresh round-1 task never getting
      // as far as resolving one — leaves `prNumber` at its `-1` sentinel:
      // no PR is known to exist, so a PR comment would target a number
      // nothing was ever opened against. Recorded on the task Issue
      // instead, the one forge location that is always addressable for a
      // task with no open PR yet.
      const invocation = { agent: dispatchAgent, ...(dispatchModel ? { model: dispatchModel } : {}) }
      const postResult =
        c.prNumber <= 0
          ? d.postIssuePauseComment(
              task,
              branch,
              c.round,
              c.decision.reason,
              c.decision.detail,
              invocation,
              escalationRecord?.rulingOrdinal
            )
          : d.postPauseComment(task, c.round, head, c.prNumber, c.decision.reason, c.decision.detail, invocation)
      await logPauseCommentRetryIfNotable(c, c.round, postResult)
    } catch {
      // Swallowed deliberately — see above. The role log's own
      // `driver_exited` trace (written above, unconditionally) is what a
      // Principal reads when even this best-effort post never lands.
    }
    // The catch answers with what the round loop last left in the context.
    const { decision, prNumber } = c
    return { finalDecision: decision, prNumber, task }
  }
}
