import type { LoopRunContext } from './run-context.js'
import { taskFromPrBody } from './developer-dispatch.js'

import { readPauseState } from './pause-resume.js'
import { crossRunnerRefusal } from '../../run-control/task-run-engine.js'

import { noPushResumeCommandFor } from './pause-resume.js'
import { bindPauseToPullRequest } from './pause-resume.js'
import { escalationPrOf } from './pause-resume.js'
import { isAgentVendor } from '../../dispatch/dispatch.js'
import type { AgentVendor } from '../../dispatch/dispatch.js'
import { readDeveloperModelRuns } from './developer-dispatch.js'
import { writeDeveloperModelRuns } from './developer-dispatch.js'
import { recoverLoopState } from './pause-resume.js'
import { isHostRepairPause } from './pause-resume.js'
import { MAX_INFRASTRUCTURE_RETRIES } from './round-assess.js'
import { escalationIdFor } from './pause-resume.js'
import { readEscalationRecord } from './pause-resume.js'
import { StaleEscalationError } from './pause-resume.js'
import { missingEscalationNextStep } from './pause-resume.js'

import { resolveEscalation } from './pause-resume.js'
import { WrongTargetResolutionError } from './pause-resume.js'
import { ReplayedResolutionError } from './pause-resume.js'
import { readDriverLock } from './pause-resume.js'
import { isDriverPidAlive } from './pause-resume.js'
import { concludedLoopRefusal } from '../../../../tools/dev-review-policy/journal-reconstruction'

import { pauseBoundRulingFromResolution } from '../../../../tools/task-contract/review-input-manifest'
import { readResolutionRecord } from './pause-resume.js'

import { writePauseState } from './pause-resume.js'

import { issueTitleOrNone } from './developer-dispatch.js'

import { createVinayaLogSink } from '../../../../integration/log/log-sink-factory.js'
import { loopLogPathFor } from '../../../../../../kernel/log/client/loop-log.js'
import { appendRunStartMarker } from '../../../../../../kernel/log/client/loop-log.js'
import { randomUUID } from 'node:crypto'
import { printDriverLockLine } from './pause-resume.js'
import { clearDriverLock } from './pause-resume.js'
import { acquireDriverLockAtomic } from './pause-resume.js'
import { writeDriverLock } from './pause-resume.js'
import { cleanupAllReviewerIsolationArtifacts } from './reviewer-isolation.js'
import { consumeHostRepairPauseOnStart } from './pause-resume.js'
import { drainAllLogSinks } from './run-logging.js'

export async function initializeRunEntry(c: LoopRunContext): Promise<void> {
  const { d, root, input } = c

  /** The task Issue's title, from the one Issue read this run makes at loop start; `loop_started` records it. */

  c.prNumber = -1
  // resolved below, before any use — never read while -1
  c.resumeFrom = null

  c.dispatchAgent = input.agent ?? 'claude'

  c.dispatchModel = input.model

  /** True when `--resume` named a different agent than the one the task ran on: the first Developer turn then opens a fresh session, so it is handed the brief and the task's state. */
  c.agentSwitched = false

  /** O8: true when `--resume` found the head already moved past the pause-time head — a ruling followed by a fix push, the normal case. Widens `firstPass` below so the loop skips redispatching the developer (it already acted) and goes straight to the gate/reviewer path on the new head. */
  c.resumeHeadAlreadyMoved = false

  /** True when `--resume` continues a pause raised before the pull request existed and bound to it since: its ruling is on the task Issue (`escalationPrOf`), so the next Developer dispatch on the pull request is handed the Issue's rulings after the frozen brief. */
  c.issueRulingsOwed = false

  /** The Principal ruling that authenticated the pause this run resumed. */
  c.pauseBoundRuling = null

  if ('resumePr' in input) {
    const resumePr = input.resumePr
    const closesTask = taskFromPrBody(d.fetchPrBody(resumePr))
    if (closesTask === null) {
      throw new Error(
        `devReviewLoop --resume: PR #${resumePr}'s body carries no \`Closes #N\` reference — cannot derive its task.`
      )
    }
    let held = readPauseState(root, closesTask)
    if (!held) {
      throw new Error(
        `devReviewLoop --resume: no held pause state found for task ${closesTask} (PR #${resumePr}) — nothing to resume.`
      )
    }
    // A pause the Engine runner recorded is the Engine's to continue, never this loop's.
    const otherRunner = crossRunnerRefusal(closesTask, 'standalone', root)
    if (otherRunner !== null) throw new Error(`devReviewLoop --resume: ${otherRunner}`)
    if (held.prNumber === null) {
      // A pause recorded before any pull request existed, with one open now:
      // bound to it first, so this run — and every later reader — continues on
      // that pull request. Only to the open pull request on the pause's OWN
      // branch, whose body closes this task (`closesTask`, above); never to
      // another one. The escalation record keeps naming no pull request, and
      // `escalationPrOf` keeps its ruling on the task Issue.
      const openPr = d.findOpenPrForBranch(held.branch)
      if (openPr?.number !== resumePr) {
        throw new Error(
          `devReviewLoop --resume: task ${closesTask}'s held pause state records no pull request — it paused before one existed — and PR #${resumePr} is not the open pull request on its branch \`${held.branch}\`. Continue it with \`${openPr ? `vinaya-dev-review-loop --resume ${openPr.number}` : noPushResumeCommandFor(closesTask, held.branch, held.agent, held.model)}\`.`
        )
      }
      held = bindPauseToPullRequest(root, held, resumePr)
      console.error(
        `vinaya dev-review-loop: task ${closesTask}'s pause, recorded before any pull request existed, is now bound to PR #${resumePr}.`
      )
    }
    if (held.prNumber !== resumePr) {
      throw new Error(
        `devReviewLoop --resume: task ${closesTask}'s held pause state names PR #${held.prNumber}, not PR #${resumePr}. Resume it with \`vinaya-dev-review-loop --resume ${held.prNumber}\`.`
      )
    }
    /** The pull request this pause's escalation and ruling belong to — `null` for a pause bound after it was raised, whose ruling is on the task Issue. */
    const escalationPr = escalationPrOf(held)
    c.issueRulingsOwed = escalationPr === null
    if (held.agent !== undefined && !isAgentVendor(held.agent)) {
      throw new Error(
        `devReviewLoop --resume: held pause state carries invalid agent '${held.agent}' — expected claude or codex.`
      )
    }
    if (!input.agent && !held.agent) {
      throw new Error(
        'devReviewLoop --resume: this legacy pause state does not record an agent; retry once with --agent <claude|codex>.'
      )
    }
    // An explicit `--agent` that differs from the recorded one continues the
    // task on that agent: its sessions are its own, so it starts fresh on the
    // same branch and worktree. The recorded model belongs to the old vendor
    // and is never carried over.
    c.agentSwitched = input.agent !== undefined && held.agent !== undefined && input.agent !== held.agent
    c.dispatchAgent = input.agent ?? (held.agent as AgentVendor)
    process.env.VINAYA_RUNTIME = c.dispatchAgent
    c.dispatchModel = c.agentSwitched ? input.model : (input.model ?? held.model)
    if (readDeveloperModelRuns(root, closesTask).length === 0 && held.agent !== undefined) {
      writeDeveloperModelRuns(root, closesTask, [
        { model: held.model ?? held.agent, firstRound: 1, lastRound: held.round }
      ])
    }
    // O5: an automatic-recovery (`'infrastructure'` or `'stale_driver'`)
    // pause is the driver's own recoverable hiccup, never a human decision
    // point —
    // `--resume` continues it on the bare command, no Principal ruling
    // required. Every OTHER pause reason is unchanged: a genuine decision
    // point still refuses to resume without one.
    // Bounded, and the bound is READ from
    // the control store rather than reset by this restart — a task that
    // keeps hitting `'infrastructure'`/`'stale_driver'` and getting resumed
    // past it forever, with no genuine review round in between, exhausts
    // this bare-command allowance and starts requiring a ruling like any
    // other reason. `'corrupt'` is read as "budget unknown, be
    // conservative" here — never as `0` — so a control-store read failure
    // can never itself grant an unbounded bare-command resume. Floored
    // against `held.infrastructureRetries` (round 2 review, security HIGH):
    // `held` is `writePauseState`'s own plain `writeFileSync` record, a
    // different write path than `persistLoopState`'s control-store one, so
    // a `persistLoopState` write that silently failed at the very pause
    // `held` itself records still leaves this floor intact — the
    // control-store read alone can no longer heal a real count down to `0`
    // (or any lower number) just because its own write never landed.
    const recoveredForResume = recoverLoopState(closesTask)
    const controlStoreInfrastructureRetries =
      recoveredForResume.status === 'ok'
        ? recoveredForResume.value.budgets.infrastructureRetries
        : recoveredForResume.status === 'corrupt'
          ? Number.POSITIVE_INFINITY
          : 0
    const infrastructureRetriesSoFar = Math.max(controlStoreInfrastructureRetries, held.infrastructureRetries ?? 0)
    // A host-repair pause (`sandbox_refused`) is no automatic recovery — the
    // watcher never resumes it — but the ordinary start continues it with no
    // ruling once the host is repaired, and outside the retry bound: it
    // never spent one.
    const hostRepairResume = isHostRepairPause(held.reason)
    const bareAutomaticResume =
      hostRepairResume ||
      ((held.reason === 'infrastructure' || held.reason === 'stale_driver') &&
        infrastructureRetriesSoFar < MAX_INFRASTRUCTURE_RETRIES)
    // `held.escalationId` is the escalation's OWN real id — a disambiguating
    // suffix when `writeEscalation` had to claim one (code review, round 2,
    // MEDIUM); the natural key is still correct whenever no collision ever
    // happened, and for a `PauseState` written before this field existed.
    const resumeEscalationId = held.escalationId ?? escalationIdFor(closesTask, held.round, held.head)
    // A pause that needs a ruling, whose escalation has no durable record, is
    // refused HERE, before any ruling is asked for: no ruling can be bound to
    // a missing record, so a refusal naming "post a ruling, then `--resume`"
    // would name a `--resume` that refuses again. It names the Principal
    // decision instead. A bare automatic resume needs no record and goes
    // on (`StaleEscalationError`, below).
    if (!bareAutomaticResume && readEscalationRecord(closesTask, resumeEscalationId) === null) {
      const stale = new StaleEscalationError(
        closesTask,
        resumeEscalationId,
        'no escalation record was ever written for it, or it could not be read'
      )
      throw new Error(`devReviewLoop --resume: ${stale.message}. ${missingEscalationNextStep(held, false)}`)
    }
    // A bound pause's ruling is read where its own comment was posted — the
    // task Issue — by the same parser under the same principal allowlist.
    const rulingSource = escalationPr === null ? `Issue #${closesTask}` : `PR #${resumePr}`
    const rulings = bareAutomaticResume
      ? []
      : escalationPr === null
        ? d.fetchIssueRulings(closesTask)
        : d.fetchRulings(resumePr)
    if (!bareAutomaticResume && rulings.length === 0) {
      throw new Error(
        `devReviewLoop --resume: ${rulingSource} carries no Principal ruling comment yet — nothing to resume from. Continuing task ${closesTask} needs a Principal ruling posted on ${rulingSource}; then run \`vinaya-dev-review-loop --resume ${resumePr}\`.` +
          (held.reason === 'infrastructure' || held.reason === 'stale_driver'
            ? ` (task ${closesTask} has hit ${infrastructureRetriesSoFar} infrastructure/stale_driver pause(s) — at or past the bound of ${MAX_INFRASTRUCTURE_RETRIES}, a ruling is required even for this reason.)`
            : '')
      )
    }
    // O2: the authenticated resolution — consumed at most once
    // (`resolveEscalation`), refusing a wrong-target, stale, or replayed
    // attempt before this run ever re-enters the round loop. An
    // `'infrastructure'`/`'stale_driver'` resume carries no ruling (above),
    // so it authenticates as the driver's own recoverable-hiccup recovery
    // rather than a principal decision — still consumed at most once, so a
    // duplicate bare `--resume` against the SAME held hiccup is refused too.
    const resumeAuthenticatedBy =
      held.reason === 'infrastructure' || held.reason === 'stale_driver' || hostRepairResume
        ? 'driver-self'
        : ((escalationPr === null ? d.fetchNewestIssueRulingAuthor(closesTask) : d.fetchNewestRulingAuthor(resumePr)) ??
          'unknown-principal')
    const resumeAuthenticatedFrom = hostRepairResume
      ? `${resumePr}-host-repaired`
      : held.reason === 'infrastructure' || held.reason === 'stale_driver'
        ? `${resumePr}-infrastructure-retry`
        : escalationPr === null
          ? `issue-${closesTask}-${d.fetchNewestIssueRulingOrdinal(closesTask)}`
          : `${resumePr}-${d.fetchNewestRulingOrdinal(resumePr)}`
    let attachAfterReplayedResolution = false
    try {
      resolveEscalation(
        closesTask,
        resumeEscalationId,
        escalationPr,
        'resume',
        resumeAuthenticatedBy,
        resumeAuthenticatedFrom
      )
    } catch (err) {
      if (err instanceof WrongTargetResolutionError) {
        throw new Error(`devReviewLoop --resume: ${err.message}`)
      }
      if (err instanceof StaleEscalationError) {
        // A bare infrastructure resume asks no Principal for anything, so an
        // escalation record that was never written leaves nothing to
        // authenticate — only the one-driver-per-task lock to respect, which
        // the entry gate below still enforces. It continues from the pull
        // request's current state, the same attach a fresh `--task <n>` takes.
        // Every pause that needs a ruling still refuses: without the record,
        // no ruling can be bound to it.
        if (!bareAutomaticResume) {
          throw new Error(`devReviewLoop --resume: ${err.message}. ${missingEscalationNextStep(held, false)}`)
        }
        attachAfterReplayedResolution = true
      } else {
        if (!(err instanceof ReplayedResolutionError)) throw err
        // An escalation that already carries a consumed resolution
        // is not necessarily a replay attempt to refuse — the run that
        // consumed it may itself have ended (a crash, or a later pause that
        // collided back onto the SAME natural key — `sameEscalationInstance`,
        // `control-store/local.ts`, treats a same-round/head/branch/pr/reason/
        // detail repeat as a rerun of the identical instance, so its own
        // `pause-state.json` write never advances past the already-consumed
        // id) before the task's review actually concluded. The storage
        // guarantee still binds exactly as before whenever a driver still
        // holds the task (Traps to avoid: never weakened for that case) — that
        // branch refuses first, in the storage layer's own words, and is
        // untouched by everything below.
        //
        // A review that is GENUINELY concluded — its summary on the forge AND
        // the review gate passing against the pull request's current head,
        // objectives version, newest ruling, frozen brief and policy
        // (`isConcludedJournal`) — is refused too, but named for what it is:
        // there is nothing left for a `--resume` to attach to, and the
        // consumed-resolution text describes a storage mechanism the reader
        // never asked about. `concludedLoopRefusal` renders that reason.
        //
        // What no longer refuses: a summary posted for an older head, with a
        // Principal ruling posted after it, a superseded brief, or a red gate.
        // Each of those is a review the forge says is NOT finished, and each
        // one used to exit here on the summary alone — observed on an adopter
        // pull request that could not be resumed at all. Those continue from
        // the pull request's CURRENT state instead, the same attach a fresh
        // `--task <n>` takes onto an already-open PR — never fabricating a
        // second resolution (Traps to avoid), and never re-deriving a
        // round/head from this stale record.
        const existingLock = readDriverLock(root, closesTask)
        const driverIsLive = existingLock !== null && isDriverPidAlive(existingLock.pid)
        // The live driver may be this very run: a watching driver whose bare
        // retry of an infrastructure hiccup consumed the resolution, then
        // failed before its round began (GitHub unreachable, say). Its next
        // retry is the same driver following its own consumed resolution,
        // under its own lock token, still inside the retry bound — never a
        // second driver, so it attaches instead of being refused as a replay.
        const ownBareRetry =
          bareAutomaticResume &&
          !hostRepairResume &&
          input.retainDriverLock !== undefined &&
          existingLock?.token === input.retainDriverLock &&
          err.existing?.authenticatedBy === 'driver-self'
        if ((driverIsLive && !ownBareRetry) || err.existing?.decision !== 'resume') {
          throw new Error(`devReviewLoop --resume: ${err.message}`)
        }
        const concludedRefusal = concludedLoopRefusal(d.fetchLoopHistory(resumePr))
        if (concludedRefusal !== null) {
          throw new Error(`devReviewLoop --resume: ${concludedRefusal}`)
        }
        attachAfterReplayedResolution = true
      }
    }
    // Bind the resumed run to the resolution that was actually consumed,
    // including replay attachment after a driver crash. A newer forge ruling
    // must never replace the ruling that authenticated this pause.
    // The slot is read from that consumed resolution alone; the digest is
    // taken over the one ruling comment that identity names, and a
    // ruling that cannot be found refuses the resume rather than binding
    // another ruling's text to the consumed identity.
    try {
      c.pauseBoundRuling = pauseBoundRulingFromResolution(
        readResolutionRecord(closesTask, resumeEscalationId),
        d.fetchRulingText
      )
    } catch (err) {
      throw new Error(`devReviewLoop --resume: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (c.agentSwitched) {
      // The resume is accepted: the held record names the agent that runs
      // from here on, so the Operator's read and the next printed resume
      // command follow it.
      const { model: _heldModel, ...heldWithoutModel } = held
      writePauseState(root, {
        ...heldWithoutModel,
        agent: c.dispatchAgent,
        ...(c.dispatchModel ? { model: c.dispatchModel } : {})
      })
    }
    // A bound pause attaches too: it was raised before the pull request
    // existed, so it holds no pull-request round or head to resume AT — the
    // open pull request's own state is where this run picks up.
    if (attachAfterReplayedResolution || held.boundAt !== undefined) {
      c.task = held.task
      c.branch = held.branch
    } else {
      const currentHead = d.resolveHead(held.branch)
      // O8: a moved head is accepted, never refused, once a ruling exists —
      // "a ruling followed by a fix push is the normal case." The ruling is
      // itself the round-cap override it declares: the round counter
      // restarts at the ruling's own newest ordinal (`fetchNewestRulingOrdinal`,
      // the same integer `ruling_posted` mid-round invalidation already reads)
      // rather than continuing from `held.round`, which may already sit past
      // `MAX_ROUNDS` and would otherwise re-trigger the very pause this
      // `--resume` exists to lift. An `'infrastructure'` resume carries no
      // ruling to re-derive that override from, so a moved head there just
      // keeps `held.round` — the same round this pause interrupted.
      c.resumeHeadAlreadyMoved = currentHead !== held.head
      c.task = held.task
      c.branch = held.branch
      c.prNumber = held.prNumber
      c.resumeFrom =
        c.resumeHeadAlreadyMoved && rulings.length > 0 ? { ...held, round: d.fetchNewestRulingOrdinal(resumePr) } : held
    }
    // A resumed run derives no branch, so it makes no Issue read on the way in: its one title read is this one, and a
    // read that fails records no title rather than refusing the resume.
    c.taskTitle = issueTitleOrNone(c.task, d.fetchIssueTitle)
  } else {
    c.task = input.task
    // A tranche task's branch derivation reads the title, and hands it back here, so the loop records it without a
    // second read. A backlog task's derivation reads no title: its one title read is the one below.
    let titleRead = false
    c.branch = d.developerBranchFor(c.task, (n) => {
      titleRead = true
      const title = d.fetchIssueTitle(n)
      c.taskTitle = title
      return title
    })
    if (!titleRead) c.taskTitle = issueTitleOrNone(c.task, d.fetchIssueTitle)
    process.env.VINAYA_RUNTIME = c.dispatchAgent
  }

  // O1: this run's own narration begins here, before the start-of-run
  // sweep below ever makes a forge lookup — the log sink (and this
  // process's own `runId`) is created now, rather than inside
  // `runDevReviewLoopBody` below (its later, original home), so the
  // run-start marker and a line saying the sweep is running land in the
  // loop log AND on stderr first. A driver that still has many folders
  // left to classify must never look silent while it works through them.
  const sink = createVinayaLogSink(d.logSink)
  c.log = sink.log
  c.runId = sink.runId
  c.drainLoopLogSink = sink.drain

  if (!process.env.VINAYA_RUN_ID) process.env.VINAYA_RUN_ID = c.runId

  // O3: two independent sink instances can both have a `log()` call in
  // flight when this driver is about to exit — this closure's own
  // `createVinayaLogSink()` instance above (the round/pause events `logEvents`
  // emits) and the module-level default sink (`../../../../../kernel/log/log-sink.js`'s plain
  // `log`/`drainLogSink`), which `effects.ts`'s `EffectExecutor` writes
  // its `attempted`/`observed`/`verified` lines through instead — a
  // separate sink built by the installed factory, with its own `pendingWrites`/
  // `drainChain`, that this closure's own `drain()` cannot see. Every abrupt
  // exit below drains both, never just the one this closure happens to own;
  // a default sink no `log()` has built yet has nothing in flight to drain.

  // `loopLogPathFor`'s own `repo` parameter never affects the path it
  // returns (kept on the signature only for callers that already resolved
  // one) — passing `null` here means this marker never waits on
  // `resolveRepo()`, which only runs later, inside the body.
  c.loopLogPath = loopLogPathFor(null, c.task)

  appendRunStartMarker(c.loopLogPath, {
    role: 'dev-review-loop',
    pid: process.pid,
    runId: c.runId,
    resumed: 'resumePr' in input
  })

  // The same keep-policy `vinaya task sweep` runs on demand, started here
  // but never awaited before dispatch (O2) — `excludeScope` (this run's OWN
  // task) is the guard against a race this exact invocation could otherwise
  // lose to itself: were the forge to report this task finished (a stale
  // read, or a genuine race against an external close), the sweep must
  // never remove the very folder this run is about to write its driver
  // lock and control-store records into. A sweep failure is reported to
  // this run's own stderr and ignored — never a reason the run itself
  // stops (Traps to avoid: a housekeeping pass must never gate the loop it
  // runs alongside). Awaited once, in the `finally` below, so the process
  // never exits while it is still mid-removal.
  c.sweepDone = d.sweepTasksAtStart(c.task)

  // O1/O2: one driver per task — checked before any dispatch, a live record
  // refuses this start outright; a dead one (crashed prior driver) is taken
  // over rather than left blocking forever (Traps to avoid: no lease, no
  // timestamp expiry — liveness is the only test).
  //
  // issue-711 O4 (code review round 1, BLOCKER/MEDIUM; round 2, MAJOR/
  // security LOW): a lock naming THIS process's own pid is treated as
  // already mine — never refused, never re-raced — ONLY when its `token`
  // ALSO matches the one `retainDriverLock` carries. A bare pid match is
  // NOT proof of ownership on its own: the OS can reissue a crashed
  // driver's exact pid to a fresh, unrelated `devReviewLoop` invocation for
  // the SAME task, and that invocation's pid would match the stale lock's
  // pid too, with no continuity of ownership behind it at all. `lockToken`
  // is resolved ONCE, here, for this whole call: the caller's own token
  // when this is a driver-loop re-entry (`retainDriverLock`), else a fresh
  // one — used at every point in THIS call that (re)writes the lock, so a
  // takeover, a race-fallback write, and the stale-driver re-exec's own
  // restore (below) all agree on the identity this run claims.
  c.lockToken = input.retainDriverLock ?? randomUUID()

  c.existingDriverLock = readDriverLock(root, c.task)

  c.ownsExistingLock =
    c.existingDriverLock?.pid === process.pid &&
    c.existingDriverLock.token !== undefined &&
    input.retainDriverLock !== undefined &&
    c.existingDriverLock.token === input.retainDriverLock

  if (!c.ownsExistingLock) {
    // A same-pid lock that fails the token check above falls through to
    // exactly this same path a genuinely different pid would — its own
    // liveness probe (`process.kill(pid, 0)`) reads `true` for THIS
    // process's own pid unconditionally, so a same-pid/different-token
    // lock is refused here, never silently taken over: safer than risking
    // a genuine double-owner, and resolved the moment this exact process
    // eventually exits and frees the pid for a later, ordinary takeover.
    if (c.existingDriverLock && isDriverPidAlive(c.existingDriverLock.pid)) {
      const message = `refuses to start for task ${c.task} — a driver is already running (pid ${c.existingDriverLock.pid}, started ${c.existingDriverLock.startedAt})`
      printDriverLockLine(message)
      throw new Error(`devReviewLoop: ${message}`)
    }
    if (c.existingDriverLock) {
      printDriverLockLine(
        `task ${c.task}'s driver lock names pid ${c.existingDriverLock.pid} (started ${c.existingDriverLock.startedAt}), which is no longer alive — taking over`
      )
      clearDriverLock(root, c.task)
    }
    const claimed = acquireDriverLockAtomic(root, c.task, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      token: c.lockToken
    })
    if (!claimed) {
      // Lost a genuine race for a lock nobody held a moment ago — a second,
      // concurrent start (fresh or a takeover) won the exclusive create
      // first. Re-read: a live, different pid is refused exactly like the
      // ordinary case above; anything else (the winner's own process died
      // between its write and this read, or this read raced a takeover
      // still in flight) is a vanishingly narrow residual this single,
      // best-effort retry closes rather than looping forever over it.
      const racedLock = readDriverLock(root, c.task)
      if (racedLock && racedLock.pid !== process.pid && isDriverPidAlive(racedLock.pid)) {
        const message = `refuses to start for task ${c.task} — a driver is already running (pid ${racedLock.pid}, started ${racedLock.startedAt})`
        printDriverLockLine(message)
        throw new Error(`devReviewLoop: ${message}`)
      }
      writeDriverLock(root, c.task, { pid: process.pid, startedAt: new Date().toISOString(), token: c.lockToken })
    }
  }

  // O3: restart cleanliness — a crashed or killed prior run's own
  // reviewer candidate/scratch directories never leak into this run. Safe
  // on a fresh task (nothing to remove) and mid-recovery from a stale lock
  // (above): this run builds its own artifacts for whichever round it
  // reaches first and never reads a prior run's leftovers.
  cleanupAllReviewerIsolationArtifacts(root, c.task)

  // A host-repair pause recorded before any pull request existed is
  // continued by this same start: its resolution is recorded once, under the
  // lock just taken, so the same packet is never consumed twice. (A pause on
  // a pull request is resolved by the `--resume` entry above.)
  if (!('resumePr' in input)) consumeHostRepairPauseOnStart(root, c.task)

  // True only for the two pause reasons that are
  // themselves an infrastructure/re-exec hiccup, never a human decision
  // point ('infrastructure', 'stale_driver') — set at the single shared
  // pause-return branch and at the outer crash catch below, both of which
  // this variable is declared ahead of so either closure can set it. Every
  // OTHER pause reason (escalation, max_rounds, confidence, reappearance,
  // no_push, objectives_changed, ruling_posted, brief_superseded,
  // policy_changed) is a genuine decision point a Principal must act on —
  // those clear the lock exactly as before, unchanged.
  c.keepLockAlive = false

  // GitHub rate-limit waiting (see `absorbRateLimit`, below, where `round` is
  // in scope). `roleDispatchesInPass` counts role dispatches since the round
  // loop's current iteration began: re-entering the round loop after a
  // dispatch already ran would dispatch that role a second time, so a rate
  // limit that lands after one is never re-entered — the reads that follow a
  // dispatch wait in place instead (`withRateLimitWait`).
  c.roleDispatchesInPass = 0

  c.rateLimitWaits = 0

  c.roundAtLastWait = -1

  // The reset (epoch seconds) the last rate-limit wait slept to — what a
  // rate-limit pause records, so the watching driver resumes after it.
  c.lastRateLimitResetEpoch = null

  // A connection failure to GitHub waits in place too (`absorbGitHubOutage`):
  // these count only the re-runs GitHub answered the first check for.
  c.answeredConnectionRetries = 0

  c.roundAtLastConnectionRetry = -1

  const realDispatchRoleForCount = d.dispatchRole

  d.dispatchRole = ((...args: Parameters<typeof realDispatchRoleForCount>) => {
    c.roleDispatchesInPass += 1
    return realDispatchRoleForCount(...args)
  }) as typeof realDispatchRoleForCount

  // O1/O3: captured BEFORE `runDevReviewLoopBody` ever sets
  // `process.env.VINAYA_HOST` (below, alongside its own `VINAYA_RUN`
  // assignment) — `undefined` when nothing upstream named a host, a real
  // value when a hook already set `'hook'` (never overwritten; see the
  // assignment's own comment) or this run is itself a child of another
  // host this process inherited. Restored unconditionally in this `finally`,
  // the same save/restore-around-one-call discipline `cancelDevReviewLoop`
  // already uses for `VINAYA_TASK`/`VINAYA_RUN`, so a caller that stays
  // alive past this call — a test runner, `task-tools serve`'s shared
  // process — never keeps reading `'loop'` for work this call never did.
  c.prevHost = process.env.VINAYA_HOST

  // The pull request number reaches the log sink through `VINAYA_PR`, set the
  // moment this driver has a pull request and restored here — the same
  // save/restore as `VINAYA_HOST`. Cleared first, so a number inherited from
  // another task's environment is never recorded against this one.
  c.prevPr = process.env.VINAYA_PR

  delete process.env.VINAYA_PR
}

export async function finishRun(c: LoopRunContext): Promise<void> {
  const { root } = c

  if (c.prevPr === undefined) delete process.env.VINAYA_PR
  else process.env.VINAYA_PR = c.prevPr
  // O3: every pause decision (including an uncaught error, converted to
  // `pause{reason:'infrastructure'}` by `runDevReviewLoopBody`'s own crash
  // catch) and every clean publish all return through here — the ONE
  // place this covers both exits the objective names. The caller
  // (`devReviewLoopCommand`) calls `process.exit(1)` on a pause AFTER
  // this promise resolves, so draining here, before that return, is what
  // makes both log sinks land everything first.
  if (c.prevHost === undefined) delete process.env.VINAYA_HOST
  else process.env.VINAYA_HOST = c.prevHost
  await drainAllLogSinks(c)
  // O2/Traps: the sweep was never awaited before dispatch, but a run
  // that is about to exit must "let it finish… cleanly" rather than
  // leave a removal partway done — `sweepDone` never rejects (its own
  // doc comment), so this is safe unconditionally, including while a
  // real error is already propagating out of the `try`.
  await c.sweepDone
  // An infrastructure/stale_driver pause deliberately leaves the lock
  // in place — this run is not "done," it is a live process that hit a
  // recoverable hiccup, and a cleared lock here would misrepresent that
  // as a settled, resume-able-by-hand pause identical to a genuine
  // Principal-decision one. Every other exit (publish, an explicit stop,
  // or any other pause reason) clears it exactly as before.
  if (!c.keepLockAlive) clearDriverLock(root, c.task)
}
