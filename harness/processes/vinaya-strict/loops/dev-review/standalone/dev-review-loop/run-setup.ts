import type { LoopRunContext } from './run-context.js'
import { resolveRepo } from '../../../../../../kernel/adapters/code-host/github/resolve-repo'
import { randomUUID } from 'node:crypto'
import { DEFAULT_REVIEW_POLICY } from '../../../../tools/task-contract/review-policy'
import { initialLoopState } from '../../../../tools/dev-review-policy/types'
import type { DeferredFindingEntry } from '../../../../tools/task-contract/forge/forge-write.js'
import { logEvents } from './run-logging.js'
import { isHostRepairPause } from './pause-resume.js'
import { recoverLoopState } from './pause-resume.js'
import { MAX_INFRASTRUCTURE_RETRIES } from './round-assess.js'
import { readEarliestOwnership } from '../../../../../../kernel/connectors/checkpoint/control-store/index'
import { defaultControlStoreDeps } from '../../../../../../kernel/connectors/checkpoint/control-store/index'
import { controlStoreRoot } from '../../../../../../kernel/effects/effects.js'
import { DeveloperDispatchHistory } from './round-assess.js'
import { createLivePublicationState } from '../../actions/live-developer-context.js'
import type { Role } from '../../../../../../kernel/log/schema'
import type { TurnWriteAttribution } from '../../../../../../kernel/isolation/worker-boundary.js'
import type { RequiredSourceManifest } from '../../../../../../kernel/source-manifest.js'
import { createDriverExitRecorder } from './driver-lifecycle.js'
import { cleanupAllReviewerIsolationArtifacts } from './reviewer-isolation.js'
import { drainAllLogSinks } from './run-logging.js'
import { emitDriverHeartbeat } from './driver-lifecycle.js'
import { DRIVER_HEARTBEAT_INTERVAL_MS } from './driver-lifecycle.js'

export async function initializeRunBody(c: LoopRunContext): Promise<void> {
  const { d, root } = c

  // `buildHeader` derives `subject.issue` (and thus the outbox file this
  // loop's OWN `log()` calls land in) purely from `env.VINAYA_TASK`
  // (`envelope.ts`'s `issueFromTask`) — never self-declared. `dispatchRole`
  // sets it on each CHILD's env already; this driver's own top-level events
  // (`loop_started`, `round_started`, …) need it on THIS process's env too,
  // or they land under the `none` bucket instead of this task's.
  process.env.VINAYA_TASK = String(c.task)

  // Primes `resolveRepo()`'s process-lifetime cache BEFORE this loop's own
  // `log()` calls start racing each other on it (see `waitForLoopLineCount`'s
  // doc comment) — every later call in this process, including the ones
  // inside `log()` itself, resolves the identical value instantly.
  c.repo = await resolveRepo().catch(() => null)

  // O6: `policy`/`repoRoot`/
  // `baseHeadAtStart` are
  // DECLARED here, at the top of this function's scope, but ASSIGNED only
  // once the widened `try` below actually runs `reviewPolicy()`/
  // `d.repoRoot()`/`d.gitRevParseOriginMain()` — each a real forge/git
  // read that can throw. Declaring them here (rather than at the point of
  // assignment, inside the try) is what lets every OTHER function in this
  // scope — `checkStaleDriver`, `dispatchDeveloper`, `runRoundLoop`, all
  // declared throughout this function — keep closing over the SAME
  // outer-scope bindings they always have; only when the values are
  // actually computed moves.

  /** O8: recorded once, at loop start — never re-derived. Re-read at every round entry (top of the `while(true)` below) and compared against this fixed watermark for commits touching `DRIVER_OWNED_PATHS`. */

  /**
   * O3: every finding id the newest handoff carried — `addressedFindingIds`
   * may name only these, on any dispatch of the round that answers it (a
   * later commit-and-push resume may cite the same ids again). Read from the
   * durable Developer handoff, which a restarted driver recovers from its
   * `loop_state` record, never from a copy this process keeps.
   */

  /** The rounds whose one red-check rerun for a `tooling_unavailable` report is spent — a second report in the same round pauses. */
  c.toolingRerunRounds = new Set<number>()

  /** The heads whose failed jobs a red read already had rerun, each once: the first-red row, an unchanged Developer turn and a `tooling_unavailable` report all spend this one memory, so no head is rerun twice. */
  c.rerunHeads = new Set<string>()

  /** The findings the newest review handed over, with the ids the Developer cites — set when a round's verdicts request changes, cleared by a ruling or a recovered verdict that carries no ids. */
  c.lastHandoffFindings = null

  c.loopOutboxPath = await d.resolveLogAppendPath(c.repo, c.task)

  c.narratedEvents = []

  // Every `log()` call this process makes from
  // here on — this driver's own `dev_review_loop` events AND every
  // `effect`/`operation` event a downstream call into `effects.ts`/
  // `broker.ts` emits (pause posts, escalation writes) — reads
  // `meta.lineage.run` from THIS env var (`log-sink.ts`'s own default
  // falls back to the process's bare `runId` only when it's unset), so
  // setting it to this run's own `loopId` is what makes "one correlated
  // history" (this task's own title) literally true: every event kind
  // this one process emits shares the same `lineage.run` value.
  c.loopId = randomUUID()

  process.env.VINAYA_RUN = c.loopId

  // O1/O2/O3: set only when nothing upstream already named a host — a
  // hook that dispatched this run (or will later shell out to one, e.g.
  // `git push` inside the loop) sets `VINAYA_HOST=hook` explicitly on its
  // own command, which overrides whatever this process inherits for that
  // one child regardless of what this line does; CI sets `GITHUB_ACTIONS`,
  // which `log-sink.ts`'s `hostFromEnv` reads before it ever looks at
  // `VINAYA_HOST` at all. Only a check genuinely started by the loop's own
  // code, with no hook and no CI runner in the way, ever reaches this
  // branch and reports `'loop'`. Restored in the outer `finally` above
  // (`prevHost`) — never left set once this driver returns.
  if (process.env.VINAYA_HOST === undefined) process.env.VINAYA_HOST = 'loop'

  c.config = {
    loopId: c.loopId,
    task: c.task,
    ...(c.taskTitle ? { title: c.taskTitle } : {}),
    // `loop_started`'s own schema constrains `policy.reviewers`/`policy.models`
    // keys to `RoleSchema` (`schema.ts`) — the DOCTRINE role vocabulary
    // (`code-reviewer`), not `VerdictObservation.role`'s separate
    // `'reviewer' | 'security'` vocabulary this driver uses everywhere else
    // for the policy's own findings/verdict shape. Using `'reviewer'` here
    // fails schema validation silently (`log()` never throws — `loop_started`
    // just never lands in the outbox; found live authoring this task).
    reviewers: ['code-reviewer', 'security'],
    // issue-661, O1: the developer's own resolved model when `runTask`
    // resolved one, else the vendor name unchanged — reviewer/security
    // model resolution is out of this task's boundary.
    models: {
      developer: c.dispatchModel ?? c.dispatchAgent,
      'code-reviewer': c.dispatchAgent,
      security: c.dispatchAgent
    },
    // O4: the repo-wide default, corrected to the REAL
    // `reviewPolicy()` value the moment the widened `try` below reads it
    // successfully (O6: `config` must be valid — never built from a
    // not-yet-read `policy` — before that read even runs, so a crash
    // reading policy itself still reports against a real `maxRounds`).
    maxRounds: DEFAULT_REVIEW_POLICY.maxRounds,
    maxTaskMinutes: DEFAULT_REVIEW_POLICY.maxTaskMinutes
  }

  c.state = initialLoopState(c.config)

  // O1: this process's own per-round deferred findings, WITH the reviewer
  // that reported each — keyed by round so a re-observed round replaces
  // rather than duplicates. Captured from the verdict observations (the one
  // place the role is still in hand) and read at publish to open/update the
  // tracking Issue. Covers exactly the live rounds this process assessed —
  // the same set the journal's own `deferred` carries, since a
  // marker-reconstructed round has no deferred detail either.
  c.deferredByRound = new Map<number, DeferredFindingEntry[]>()

  // The `resumed` observation — a genuine
  // `--resume` attach, already authenticated (`resolveEscalation`, above)
  // before this process ever re-entered the round loop. A bare
  // `'infrastructure'` recoverable-hiccup resume is never a Principal
  // decision (`resumeAuthenticatedBy` above reads `'driver-self'` for
  // exactly this reason) — `by: 'driver'` says so honestly rather than
  // claiming a ruling this process never actually read.
  if (c.resumeFrom !== null) {
    await logEvents(c, [
      {
        kind: 'dev_review_loop',
        payload: {},
        loop_id: c.config.loopId,
        event: 'resumed',
        round: c.resumeFrom.round,
        by: c.resumeFrom.reason === 'infrastructure' || isHostRepairPause(c.resumeFrom.reason) ? 'driver' : 'principal'
      }
    ])
  }

  /**
   * The round journal is the task's, not this process's — on a plain
   * attach (never a genuine round-1 dispatch, which by construction has
   * no prior round to recover), rebuild the task's prior rounds from the
   * pull request's own principal-authored forge markers before this run
   * computes one of its own. `seedLoopHistory` is called from exactly one
   * site below: the `existingPr` attach branch. Its source is the forge
   * markers alone (`fetchLoopHistory`), NEVER a log event, a flushed log
   * comment, or the telemetry outbox — the Log is telemetry and is never
   * read to recover a run.
   *
   * Deliberately NEVER called on `--resume` (round 2 review, BLOCKER):
   * `resumeFrom.round` is the exact round the paused process was on before
   * it exited — its developer round marker is already on the forge, so
   * seeding here, then letting this same resumed run recompute and append
   * that identical round number again, is the precise double-count this
   * function's own append-only `state.rounds` guards against elsewhere
   * (see below) — the attach branch never hits it because attach always
   * continues at `held.round + 1`, one past anything reconstructed, while
   * resume deliberately continues AT `resumeFrom.round` to give the
   * ruling's fix a chance in the same round. `state.rounds` starts empty on
   * resume and accumulates only the rounds this process itself computes
   * from here on.
   *
   * Applied whenever this task's review has NOT CONCLUDED —
   * `isConcludedJournal`, the SAME predicate the `--resume` replayed-
   * resolution refusal and the held-clean carry path below both call, never
   * a second hand-written test of the same field. Concluded is two facts at
   * once: the ready-for-merge SUMMARY comment is on the forge AND the review
   * gate passes against the pull request's CURRENT head, objectives version,
   * newest ruling, frozen brief and policy.
   *
   * Never gated on a round having merely decided `publish` (round 2 review,
   * BLOCKER): the control store's own `loop_state.phase` reads `'publish'`
   * the moment `assessRound` decides it, written before `publishRound` ever
   * runs, so it can never stand for "actually published." `publishRound`
   * posts the summary last, after both verdicts, so a crash mid-publish (a
   * `gh` failure) leaves NO summary and the rounds still seed — never
   * mistaking that crash for a completion, the exact case that once silently
   * dropped every round from the published table and restarted numbering at
   * `1` on the next attach.
   *
   * The gate half is what makes a REOPENED pull request seed too: a summary
   * posted for an older head, with a red gate, a ruling posted after it or a
   * superseded brief since, is not a concluded review, so its prior rounds
   * seed and the next round is numbered after the last marker on the forge
   * rather than restarting at `1` (which is what a run against exactly that
   * state did before).
   *
   * Guards the one real hazard seeding would otherwise create even when
   * genuinely concluded: `assessRound` always APPENDS to `state.rounds`
   * (`assess-round.ts`'s `buildRoundRecord` call sites), never deduplicates
   * by round number — seeding round 1's record here, then letting THIS SAME
   * run recompute round 1 live (the "rerun posts nothing twice" idempotency
   * case), would double it in the published table.
   */
  c.loopHistory = {
    rounds: [],
    totalWallMs: 0,
    totalFilesChanged: 0,
    summaryUrl: null,
    reviewGate: 'unknown',
    journalFinalized: null
  }

  /** Whether `seedLoopHistory` actually applied — the round-bump below reuses this instead of re-deriving the same "already concluded?" check a second time. */
  c.historyApplies = false

  c.round = c.resumeFrom ? c.resumeFrom.round : 1

  // The authoritative recovery read —
  // this task's control-store `loop_state` record, if one has ever been
  // persisted. `'absent'` seeds every budget at zero, exactly the prior
  // behavior for a fresh task or one that predates this mechanism.
  // `'corrupt'` is read as "nothing safe to seed FROM here" for
  // `heldResultIdentity`/`deliveredFindingsIdentity` below (identical to
  // `'absent'`'s own defaults there) — never as license to guess a real
  // budget. The actual refusal is thrown from INSIDE the `try` block below
  // (round 2 review, BLOCKER): this call site sits before that `try` even
  // starts, so a throw here would escape `devReviewLoop` uncaught instead
  // of reaching the outer `catch` that turns it into a decided
  // `pause{reason:'infrastructure'}` — the one thing every comment on this
  // path already claimed it did. THAT catch persists whatever this
  // process's own `infrastructureRetries` variable holds at the moment of
  // the throw (`persistCurrentLoopState`) — so seeding it at `0` for
  // `'corrupt'`, the same default `'absent'` gets, would silently WRITE
  // BACK a healed, zeroed budget over the very record just refused as
  // untrustworthy (round 2 review, security HIGH: "a corrupted record
  // self-heals to a low count"). `infrastructureRetries` alone therefore
  // seeds `'corrupt'` at `MAX_INFRASTRUCTURE_RETRIES` — already "at the
  // bound," a real, JSON-safe number (unlike `--resume`'s own in-memory-only
  // `Number.POSITIVE_INFINITY` comparison, this value IS persisted) that
  // forces the next `--resume` to require a ruling rather than granting a
  // fresh bare-command allowance off a corruption-erased count.
  c.recoveredLoopState = recoverLoopState(c.task)

  // The two repeat detectors survive this process boundary, because this
  // process may BE one: `checkStaleDriver` re-execs the driver mid-loop with
  // no in-memory handoff, and an attach starts from nothing. Seeded here
  // rather than inside `initialLoopState` (which is pure, and has no store
  // to read); absent, or a record written before this field existed, leaves
  // both empty — the pre-existing behaviour, never a false match.
  if (c.recoveredLoopState.status === 'ok' && c.recoveredLoopState.value.repeatMemory !== null) {
    c.state = {
      ...c.state,
      lastBlockingFindings: c.recoveredLoopState.value.repeatMemory.blockingFindings,
      lastFailure: c.recoveredLoopState.value.repeatMemory.lastFailure
    }
  }

  /**
   * O2: never reset by a restart — seeded from the control store, never
   * hardcoded to `0` the way a fresh in-memory run otherwise would be.
   * Floored against `resumeFrom.infrastructureRetries` (round 3 review,
   * MAJOR): on `--resume`, `resumeFrom` is the SAME `pause-state.json`
   * record the gate check above (`infrastructureRetriesSoFar`) already
   * floors its own comparison against — a different write path than
   * `persistLoopState`'s control-store one, so a control-store write that
   * has been silently failing for this task's whole life still leaves this
   * count recoverable there. Without this floor, a resume this process
   * legitimately reaches (bare, or ruling-backed) would reseed its OWN
   * live counter at the control store's understated reading, then persist
   * THAT lower number back into `pause-state.json` on its next pause —
   * overwriting the one independent record the gate depends on with a
   * value lower than the truth, reopening the exact unbounded-resume hole
   * the ruling ordered closed. `resumeFrom` is `null` on a fresh
   * (non-resume) start, where `?? 0` makes this `Math.max` a no-op.
   */
  c.infrastructureRetries = Math.max(
    c.recoveredLoopState.status === 'ok'
      ? c.recoveredLoopState.value.budgets.infrastructureRetries
      : c.recoveredLoopState.status === 'corrupt'
        ? MAX_INFRASTRUCTURE_RETRIES
        : 0,
    c.resumeFrom?.infrastructureRetries ?? 0
  )

  /** O1/O3: the round whose verdict is currently held on disk, awaiting delivery or publish — recovered so a crash between holding a verdict and delivering/publishing it is never silently forgotten. */
  c.heldResultIdentity = c.recoveredLoopState.status === 'ok' ? c.recoveredLoopState.value.heldResult : null

  /** O3: the round+head whose findings have already been delivered to the developer once — recovered so a later attach never redelivers the same pair, even when the local `round-<k>-attach-redelivered` marker file this same identity backs up is itself lost. */
  c.deliveredFindingsIdentity =
    c.recoveredLoopState.status === 'ok' ? c.recoveredLoopState.value.deliveredFindings : null

  /**
   * The newest review's unresolved findings and the newest gate read's
   * failing checks, carried in the `loop_state` record so every Developer
   * continuation packet is read back from that record rather than from this
   * process's memory. Seeded from the record, so a restarted driver carries
   * the same handoff forward instead of overwriting it with nothing.
   */
  c.developerHandoff =
    c.recoveredLoopState.status === 'ok' && c.recoveredLoopState.value.developerHandoff !== null
      ? c.recoveredLoopState.value.developerHandoff
      : { findings: [], failingChecks: [] }

  /**
   * When the loop FIRST started on this task, as the durable control records
   * report it — carried forward unchanged by every driver as the task's own
   * origin timestamp (`task status`, the recovery record). It no longer sets
   * the time budget's clock: the budget counts active phase time, not age
   * (`taskClock`/`activeBudgetMs`), so a restart resetting this would not
   * reset the budget. It is still resolved from the oldest durable record so
   * the origin a reader sees does not jump forward on a takeover. Resolved
   * once, here, in falling order of authority:
   *
   *   1. the recovered `loop_state` record's own `taskStartedAt`, written by
   *      the first driver to persist state for this task and carried forward
   *      unchanged by every later one (including this one, below);
   *   2. failing that, the earliest ownership epoch's `acquiredAt` — created
   *      with `O_EXCL` and never overwritten, so it is the oldest durable
   *      timestamp the store holds for this task. An epoch is claimed the
   *      first time the task writes anything durable, so the real start is at
   *      or before it: the budget then fires no earlier than it should, which
   *      is the safe direction to be wrong in;
   *   3. failing both — a task with no durable record at all, which is a task
   *      starting now — this instant.
   *
   * A corrupt `loop_state` record never reaches here: it is refused inside
   * the `try` below before any of this is read.
   */
  c.taskStartedAt = (() => {
    if (c.recoveredLoopState.status === 'ok' && c.recoveredLoopState.value.taskStartedAt !== null) {
      return c.recoveredLoopState.value.taskStartedAt
    }
    try {
      const earliest = readEarliestOwnership(defaultControlStoreDeps(controlStoreRoot), c.task)
      if (earliest !== null) return earliest.acquiredAt
    } catch {
      // A store this process cannot read is not a reason to refuse a round —
      // it only costs the budget its earlier floor, and the fallback below
      // starts the clock now rather than inventing a start.
    }
    return new Date().toISOString()
  })()

  /**
   * Milliseconds recorded against each phase so far, seeded from the
   * recovered record so a restart continues one accounting rather than
   * starting a second. This map IS the budget's clock now: `taskClock` sums
   * its ACTIVE phases into `elapsedMs` (`activeBudgetMs`), so a thin
   * breakdown — a run whose earlier phases were recorded by a driver that has
   * since died — is measured by the active time it can still account for, and
   * simply reports less about where the rest went.
   */
  c.phaseMs = c.recoveredLoopState.status === 'ok' ? { ...c.recoveredLoopState.value.phaseMs } : {}

  /** The phase this process is currently in, and when it entered it — the open interval `taskClock` closes when it reports, and `persistCurrentLoopState` folds into `phaseMs` on every phase change. */
  c.currentPhase = null

  c.currentPhaseSince = Date.now()

  c.devResumeId = null

  // Ruling 986-1: the developer dispatch-success history — "has any dispatch
  // succeeded" (the resume-escalation gate) and "did a strictly-earlier
  // round succeed" (the "worked last round, broke now" product escalation,
  // as opposed to a same-round follow-up resume failing after this round's
  // own dispatch succeeded), both off ONE latched first-success round so
  // they can never drift. See `DeveloperDispatchHistory`'s own doc comment.
  c.devDispatchHistory = new DeveloperDispatchHistory()

  c.lastReviewContext = null

  // The manifest the most recent `dispatch_reviewers` round was dispatched
  // against (O3) — hoisted here so the sibling `publish` block can
  // bind the posted verdicts against it with the SAME `compareManifest` the
  // gate uses. Set the moment the manifest is built, read only at publish.

  /**
   * issue-711 O3: set by the pre-loop patch-carry check (below) whenever a
   * held clean verdict existed but did not bind to the current head —
   * named in a later `max_rounds` pause's own detail so a human reading
   * it can tell "the cap is genuine, the patch really did change" apart
   * from "the patch-carry check silently missed a real match." `null`
   * whenever no held clean verdict was ever found (the ordinary case).
   */
  c.patchCarryNote = null

  c.resumedDispatch = c.resumeFrom !== null

  /** O3: the last red gate's failing check-run names, for the next gate-red dispatch prompt and, if it stalls, the pause detail. */
  c.lastFailingChecks = []

  c.lastFailureLogs = []

  /** O2: true iff the current `dispatch_developer` decision came from a red gate (never inferred from `decision` itself — see this branch's own comment, below). Reset to `false` by every genuine `gate` observation. */
  c.pendingGateRedRetry = false

  /** O2: consecutive gate-red developer turns that produced no push on one head — reset to 0 by every genuine `gate` observation. Seeded from the control store, never hardcoded to `0`, so a kill mid-stall-episode resumes the SAME count rather than a fresh budget. */
  c.gateStalledStreak = c.recoveredLoopState.status === 'ok' ? c.recoveredLoopState.value.budgets.mechanicalRetries : 0

  /**
   * O2: a recovered, non-zero `gateStalledStreak` must survive exactly
   * ONE "genuine gate observation" reset — the very first one this
   * process makes, which on an attach or a fresh `--resume` is ALSO this
   * process's first gate check ever, indistinguishable in memory from a
   * truly fresh situation unless this flag says otherwise. Consumed
   * (never reset back to `true`) the first time either reset site below
   * runs; every later genuine observation resets to `0` exactly as
   * before. A task with no recovered budget (`gateStalledStreak` seeded
   * at `0`) never sets this at all — resetting `0` to `0` is a no-op, so
   * this flag changes nothing for a genuinely fresh task.
   */
  c.mechanicalRetryRecoverySurvivesOneReset = c.gateStalledStreak > 0

  /** O2: true once this stall episode has already used its one unpushed-work resume — reset alongside `gateStalledStreak`, by every genuine `gate` observation, so a LATER stall gets its own resume. */
  c.unpushedResumeAttempted = false

  /** The developer stop identity captured right before the current Developer dispatch. */
  c.turnPreStop = null

  /**
   * What one Developer turn's publication carries from tool call to tool
   * call, owned by the shared live Developer context: the worktree head
   * captured right before the dispatch (`turnPreHead`, `null` when no
   * worktree exists yet), the branch's recorded base and fast-forward tip,
   * the conflicting files the next dispatch's prompt names, the last push
   * refusal, and whether the turn attempted a publication and how its last
   * attempt ended.
   */
  c.publicationState = createLivePublicationState(
    c.recoveredLoopState.status === 'ok' ? c.recoveredLoopState.value.publicationExpectedBase : null
  )

  /**
   * O1/O2: the protected-path hashes taken right before a dispatch
   * (`snapshotTurnConfinement`, below) — compared again once that SAME
   * dispatch returns, before its own publication/trust decision ever runs;
   * the control-store entry is re-baselined after each driver tool call
   * the turn makes (`startTurnWriteAttribution`). Keyed by role, never a single shared slot: `code-reviewer` and
   * `security` dispatch CONCURRENTLY in one `Promise.all`, and a shared
   * scalar here let the second snapshot silently overwrite the first, so
   * both roles' checks ran against whichever role's entries/baseline
   * happened to be written last (round 2 review, MAJOR). No entry for a
   * role before its first dispatch of the loop, and no entry whenever
   * `protectedPathsForTurn` resolves to no entries for it (never treated
   * as "unchanged" by omission; the comparison below is simply a no-op in
   * that case).
   */
  c.turnConfinementByRole = new Map<Role, TurnWriteAttribution>()

  /** Each round's prepared required-source manifest, prepared once per round by this driver process (`prepareRoundSources`). */
  c.preparedSourcesByRound = new Map<number, RequiredSourceManifest>()

  c.worktreeDependenciesInstalled = false

  /** O7: at most this many times the publication step re-asks the same Developer session to fix a missing header or a failed check before leaving the unmoved head to the poll/`no_push` safety net. */
  c.MAX_PUBLISH_REASKS = 2

  c.roundStartMs = d.now()

  c.decision = { type: 'dispatch_developer' }

  // A driver that exits without ever recording a real
  // `paused`/`publish` decision still leaves ONE trace — inside this
  // task's Surface, so this is the role log `task status --follow`
  // already tails, never a second journal family (Traps to avoid). A
  // forge journal event for the same exit needs a `packages/aeg-core`
  // schema change, out of this task's declared Surface, and is left for a
  // later task with that Surface.
  // `exitTraceWritten` guards every call site below (reexec success, an
  // uncaught error, a process signal, and a normal publish/pause return)
  // from ever firing twice for the same exit.
  // O1 (driver liveness): set once the heartbeat is started below, cleared here first
  // so the timer is stopped before any `driver_exited` is written (Traps)
  // and a stray heartbeat can never land after the exit line.
  c.stopHeartbeat = () => {}

  c.recordDriverExited = createDriverExitRecorder({
    loopId: c.config.loopId,
    task: c.task,
    loopLogPath: c.loopLogPath,
    describeDecision: () => (c.decision.type === 'pause' ? `pause(${c.decision.reason})` : c.decision.type),
    stopHeartbeat: () => c.stopHeartbeat(),
    log: c.log
  })

  // Registered once `decision`/`loopLogPath` both exist, so a signal
  // arriving mid-round can still name a real last decision rather than
  // reading the TDZ. `process.exit` here (not `d.exitProcess`, which
  // exists for testability, not for a real signal — no fixture drives a
  // real OS signal) is deliberate: without it, a second delivery of the
  // same signal would be Node's own default (immediate termination,
  // uncatchable) rather than this line ever finishing its write.
  // O1 (widened after a round-3 review found a MAJOR/HIGH gap):
  // `terminateInFlightLaunchesOnShutdown` runs FIRST, before either the
  // exit trace or `process.exit` — it terminates whichever role's
  // dispatched child is genuinely in flight (developer, or either
  // reviewer, dispatched concurrently) and marks its launch record
  // `interrupted`, so a killed driver leaves no orphan and no stale
  // `'launched'` record for the next start to trip over.
  process.on('SIGTERM', async () => {
    d.terminateInFlightLaunchesOnShutdown(c.task, c.dispatchAgent, c.repo)
    cleanupAllReviewerIsolationArtifacts(root, c.task)
    c.recordDriverExited('signal', { exitCode: 143 })
    // O3: this driver's own sink may still have a `log()` call in flight
    // (`context()` unresolved, or a webhook drain still running) — a bare
    // `process.exit` here tears the process down with no microtask
    // draining, which would silently drop it. Awaited once, on the way
    // out, never per event.
    await drainAllLogSinks(c)
    process.exit(143)
  })

  process.on('SIGINT', async () => {
    d.terminateInFlightLaunchesOnShutdown(c.task, c.dispatchAgent, c.repo)
    cleanupAllReviewerIsolationArtifacts(root, c.task)
    c.recordDriverExited('signal', { exitCode: 130 })
    await drainAllLogSinks(c)
    process.exit(130)
  })

  // O1 (driver liveness): the Log's one positive "this loop is running" signal. A
  // Developer turn can run for an hour with no other Log event, and a loop
  // in its first turn or one that died before pushing looks the same as a
  // finished one from the Log alone — so a heartbeat says "still alive"
  // and carries where the loop is (round/phase) and its PR once one
  // exists. Fire-and-forget: `log` never throws and a failed delivery is
  // dropped like any other event (Traps) — the callback never blocks or
  // fails the round, and a build/emit fault is swallowed rather than left
  // to crash the timer. Started here, once the signal handlers and
  // `decision`/`loopLogPath` exist, so it covers even the first Developer
  // turn; stopped by `recordDriverExited` before any exit line. The
  // production timer is `.unref()`'d, so it never keeps the process alive.
  c.emitHeartbeat = (): void =>
    emitDriverHeartbeat({
      loopId: c.config.loopId,
      task: c.task,
      round: c.round,
      phase: c.currentPhase,
      prNumber: c.prNumber,
      log: c.log
    })

  c.stopHeartbeat = d.setHeartbeat(c.emitHeartbeat, DRIVER_HEARTBEAT_INTERVAL_MS)

  // Round 2 review, BLOCKER: `firstPass`/`pendingCompletionEvents` are
  // declared here, in this function's own scope — never inside the `try`
  // block opened just below — because `runRoundLoop` (a sibling function
  // declaration that closes over both as mutable state) needs them
  // visible from OUTSIDE that block; a `let` inside `try { }` is scoped to
  // that block alone and would be invisible to a function declared beside
  // it, even though function declarations themselves hoist.
  c.firstPass = !c.resumeFrom || c.resumeHeadAlreadyMoved

  c.pendingCompletionEvents = []

  /** The head whose `[live]` lines this run already ran right after its approval — the publish step runs them only for a carried verdict. */
  c.liveCheckedHead = null

  /** The frozen brief this run last read (`withRateLimitWait`) for the head it approved — what the live check reads its `[live]` lines from. */
  c.approvedBriefContent = null
}
