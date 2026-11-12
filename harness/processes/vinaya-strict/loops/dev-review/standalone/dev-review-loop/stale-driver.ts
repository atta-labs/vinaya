import type { LoopRunContext } from './run-context.js'

import { clearDriverLock } from './pause-resume.js'
import { buildReexecArgs } from './driver-helpers.js'
import { drainAllLogSinks } from './run-logging.js'
import { writeDriverLock } from './pause-resume.js'

import { computeStats } from './round-report.js'
import { logEvents } from './run-logging.js'
import { driverDecidedPauseEvents } from './round-assess.js'

/**
 * O8 (round 2 review, BLOCKER): re-read the base branch's head and
 * compare against the fixed watermark recorded at loop start. A base
 * that moved past a commit touching this driver's own code sets
 * `decision` to `pause{reason:'stale_driver'}` and returns `true` — the
 * caller's job is to stop doing whatever it was about to do and let
 * that decision reach the bottom pause-handling. Called from TWO sites,
 * not just the loop top: a clean `dispatch_reviewers` → `publish`
 * transition falls through to publish in the SAME iteration with no
 * loop-back in between (found live, round 2 review — the doc comment's
 * old claim that "every iteration is a superset of every round entry"
 * was false for exactly this transition, the common clean-round path),
 * so publish re-checks this itself rather than trusting the top-of-loop
 * check alone.
 *
 * Declared here, before the `try` below, for the same reason
 * `firstPass`/`pendingCompletionEvents` are — `runRoundLoop` (a sibling
 * function declaration) calls this, and a function declared INSIDE a
 * `try { }` block is scoped to that block, invisible outside it.
 */
export async function checkStaleDriver(c: LoopRunContext): Promise<boolean> {
  const { d, root, input, task, dispatchAgent, dispatchModel, recordDriverExited, branch, config } = c

  const currentBaseHead = d.gitRevParseOriginMain()
  if (currentBaseHead === c.baseHeadAtStart) return false
  const touching = d.gitCommitsTouchingDriverPaths(c.baseHeadAtStart, currentBaseHead)
  if (touching.length === 0) return false

  // O7: a moved base costs a restart, never a
  // hand — re-exec this same process from the updated base, reattaching
  // to the same task with the same arguments (`--resume <pr>` when this
  // run itself started that way, `--task <n>` otherwise — both forms
  // `dev-review-loop`'s own round-1 entry already treats as "attach if a
  // PR/pause state exists, start fresh otherwise"). Pausing is reserved
  // for when the re-exec attempt ITSELF fails — the pull, or the spawn —
  // never for the staleness alone.
  const pulled = d.pullDefaultBranch()
  let reexecFailureNote = ''
  if (pulled.ok) {
    // O1: hand the lock to the child BEFORE it starts, not after
    // this process happens to unwind. `spawnSync` blocks synchronously
    // until the child exits, and the success path below calls
    // `exitProcess` (real `process.exit`) — which never lets this
    // function's own caller's `finally` (the driver-lock clear at the
    // top-level `devReviewLoop` entry) run at all. Left cleared only
    // there, the still-present lock refused the child outright (found
    // live: a re-exec died to exactly this). Clearing it here,
    // synchronously, before the spawn, means the child's own entry-gate
    // lock check (`readDriverLock`/`isDriverPidAlive`) sees no lock and
    // starts; the child then writes its own lock immediately, same as
    // any fresh driver invocation.
    clearDriverLock(root, task)
    const reexecArgs = buildReexecArgs(
      { ...input, agent: dispatchAgent, ...(dispatchModel ? { model: dispatchModel } : {}) },
      task
    )
    const exitCode = d.reexecSelf(reexecArgs)
    if (exitCode !== null) {
      // A clean hand-off to the child is never a
      // `paused`/`publish` decision — nothing else traces it. `finally`
      // never runs on this path (`d.exitProcess` below is real
      // `process.exit`), so this is the only chance to write it.
      recordDriverExited('reexec', { exitCode })
      await drainAllLogSinks(c)
      d.exitProcess(exitCode)
      // `exitProcess` is typed `(code: number) => never` — real process.exit
      // never returns here. This `return` guards a test fake that records
      // the call instead of truly exiting: without it, such a fake would
      // fall through into the failure-note/pause path below with a
      // successful re-exec, logging a spurious stale_driver pause.
      return true
    }
    // O1: the spawn itself never started (`reexecSelf` returned `null`)
    // — this process is still the one driving the task, so the lock it
    // cleared above must come back, or a second invocation would see no
    // lock at all and start a genuinely concurrent driver against the
    // same outbox. Restored under the SAME `lockToken` this call
    // resolved at entry — this is still the identical process/run, so a
    // later resume attempt (if this is a driver-loop-owned call) still
    // recognizes it as its own.
    writeDriverLock(root, task, { pid: process.pid, startedAt: new Date().toISOString(), token: c.lockToken })
    reexecFailureNote = `re-exec of \`vinaya ${reexecArgs.join(' ')}\` could not even start after pulling the updated base`
  } else {
    reexecFailureNote = `could not pull the default branch to re-exec from: ${pulled.reason}`
  }

  const head = d.resolveHead(branch)
  const stats = computeStats(c, head, c.roundStartMs)
  const detail = `base moved from ${c.baseHeadAtStart} to ${currentBaseHead}, touching this driver's own code (${touching.join('; ')}) — ${reexecFailureNote}`
  await logEvents(c, driverDecidedPauseEvents(config.loopId, c.state, c.round, stats, 'stale_driver'))
  c.decision = { type: 'pause', reason: 'stale_driver', detail }
  // Cumulative, never reset by a
  // restart — see `MAX_INFRASTRUCTURE_RETRIES`'s own doc comment.
  c.infrastructureRetries += 1
  return true
}
