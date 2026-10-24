/**
 * `fenceStartedEffectsAsUncertain`'s own resilience to a concurrent
 * duplicate/replayed `--cancel` bumping the task's shared control-store
 * epoch mid-flight (code review, round 2, HIGH — `#556`): `resolveEscalation`
 * always calls `acquireOwnership` before it knows whether its own
 * resolution will be consumed or refused as a replay, so a losing call can
 * still advance the epoch a WINNING call is already fencing under. Exercised
 * here via the function's own injectable `deps` parameter — a scratch
 * `defaultControlStoreDeps(() => dir)`, never the real global
 * `~/.vinaya/control-store/`, the same isolation `effects/executor.test.ts`
 * already uses for the identical reason.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireOwnership,
  type ControlStoreDeps,
  defaultControlStoreDeps,
  newestPrincipalRulingOrdinal,
  type PauseReason,
  principalRulingMarker,
  readEffect,
  writeEffect
} from '@attalabs/aeg-core'
import {
  type DriverWatchDeps,
  type LoopDeps,
  type LoopInput,
  type LoopResult,
  readResolutionRecord,
  driverCarryArgs,
  runDriverLoop
} from '../../../src/lib/dev-review-loop'
import { MAX_AUTOMATIC_CONFLICT_REENTRIES } from '../../../src/lib/dev-review-loop/gate-reading'
import type { DispatchHandle } from '../../../src/lib/dispatch'
import { drainLogSink } from '../../../src/lib/log-sink'
import { MAX_INFRASTRUCTURE_RETRIES } from '../../../src/lib/dev-review-loop/round-assess'
import { readEscalationPacket } from '../../../src/lib/task-tools/read'
import { type RunTaskDeps, runTask } from '../../../src/lib/task-run'
import { LINUX_SANDBOX_ALLOW_UNIX_SOCKETS_ENV } from '../../../src/lib/worker-boundary'
import {
  cleanupWorlds,
  controlDir,
  type LoopWorld,
  makeInProcessDeps,
  makeWorld,
  outboxLines,
  runDriverLoopInProcess,
  runLoopInProcess,
  taskRunDir,
  withWorldEnv
} from '../dev-review-loop-harness'
import {
  consumeHostRepairPauseOnStart,
  type EscalationFacts,
  escalationIdFor,
  isAutomaticRecoveryPause,
  isHostRepairPause,
  fenceStartedEffectsAsUncertain,
  noPushResumeArgv,
  noPushResumeCommandFor,
  missingEscalationNextStep,
  PAUSE_REASON_PROFILE,
  pauseGrantsBareResume,
  postWithRetry,
  readDriverLock,
  readPauseState,
  renderNoPushStopComment,
  renderPauseComment,
  ReplayedResolutionError,
  resolveEscalation,
  writeEscalationRecord,
  writePauseState
} from '../../../src/lib/dev-review-loop/pause-resume'

let dir: string
let deps: ControlStoreDeps

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pause-resume-fence-test-'))
  deps = defaultControlStoreDeps(() => dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const TASK = 556

describe('automatic-recovery missing-escalation guidance', () => {
  const staleDriverPause = {
    task: TASK,
    round: 1,
    head: 'headsha1',
    branch: 'task/x/1',
    prNumber: 900,
    reason: 'stale_driver' as const,
    pausedAt: '2026-10-08T00:00:00.000Z',
    escalationId: `${TASK}-1-headsha1`
  }

  it('offers task run for a stale driver within its retry budget', () => {
    expect(pauseGrantsBareResume(staleDriverPause)).toBe(true)
    expect(missingEscalationNextStep(staleDriverPause)).toContain('Continue it with `vinaya task run x 1`')
  })

  it('requires a Principal decision for a stale driver past its retry budget', () => {
    const exhausted = { ...staleDriverPause, infrastructureRetries: MAX_INFRASTRUCTURE_RETRIES }
    expect(pauseGrantsBareResume(exhausted)).toBe(false)
    expect(missingEscalationNextStep(exhausted)).toContain('is a Principal decision')
  })
})

function startedEffect(deps: ControlStoreDeps, task: number, epoch: number, key: string): void {
  writeEffect(deps, task, epoch, key, {
    operation: 'pr-comment',
    target: 'pr:1',
    inputVersion: 1,
    payloadDigest: 'deadbeef',
    status: 'started',
    recordedAt: '2026-09-15T00:00:00.000Z'
  })
}

describe('fenceStartedEffectsAsUncertain', () => {
  it('marks every still-started effect uncertain when the epoch it is handed is already current', () => {
    const acquired = acquireOwnership(deps, TASK, 'cancel-a')
    const epoch = acquired.acquired ? acquired.epoch : -1
    startedEffect(deps, TASK, epoch, 'k1')
    startedEffect(deps, TASK, epoch, 'k2')

    const fenced = fenceStartedEffectsAsUncertain(TASK, epoch, deps)

    expect(fenced.sort()).toEqual(['k1', 'k2'])
    expect(readEffect(deps, TASK, 'k1')).toMatchObject({ status: 'ok', value: { status: 'uncertain' } })
    expect(readEffect(deps, TASK, 'k2')).toMatchObject({ status: 'ok', value: { status: 'uncertain' } })
  })

  it('re-acquires and completes fencing when the epoch already moved out from under it before the call even starts (the race the finding names)', () => {
    const first = acquireOwnership(deps, TASK, 'cancel-a')
    const staleEpoch = first.acquired ? first.epoch : -1
    startedEffect(deps, TASK, staleEpoch, 'k1')
    // A concurrent duplicate/replayed cancel races in and bumps the epoch
    // AFTER `resolveEscalation`'s winning call already committed to
    // `staleEpoch` for its own fencing — simulated here by simply acquiring
    // again before `fenceStartedEffectsAsUncertain` ever runs.
    acquireOwnership(deps, TASK, 'cancel-b-duplicate')

    const fenced = fenceStartedEffectsAsUncertain(TASK, staleEpoch, deps)

    expect(fenced).toEqual(['k1'])
    expect(readEffect(deps, TASK, 'k1')).toMatchObject({ status: 'ok', value: { status: 'uncertain' } })
  })

  it('is a no-op that returns an empty list when nothing is started', () => {
    const acquired = acquireOwnership(deps, TASK, 'cancel-a')
    const epoch = acquired.acquired ? acquired.epoch : -1

    expect(fenceStartedEffectsAsUncertain(TASK, epoch, deps)).toEqual([])
  })
})

/**
 * `[task-log-v1] 9` (Issue #631, O1): before this task, `renderPauseComment`
 * carried a doc comment claiming `detail` rendered for only three of
 * `PauseReason`'s twelve members — a stale claim the function's own
 * unconditional ternary never actually enforced, but which reflected a real
 * gap one level up: several reasons (`confidence`, `reappearance`, the
 * `assessRound`-decided `no_progress`, a reviewer's own `escalation`) never
 * had a `detail` computed for them at all, so they rendered with none in
 * practice. This locks the renderer itself — every `PauseReason` member,
 * given a `detail`, must render it; none may render an empty body.
 */
const ALL_PAUSE_REASONS = Object.keys(PAUSE_REASON_PROFILE) as PauseReason[]

describe('renderPauseComment (pure) — O1: every pause reason renders its detail, none renders an empty body', () => {
  it.each(ALL_PAUSE_REASONS)('reason %s carries a passed detail into the rendered comment', (reason) => {
    const body = renderPauseComment(42, reason, 'a concrete, observed fact about this pause')
    expect(body).toContain(reason)
    expect(body).toContain('a concrete, observed fact about this pause')
    expect(body).toContain('vinaya dev-review-loop --resume 42')
  })

  it.each(ALL_PAUSE_REASONS)(
    'reason %s still renders a non-empty body naming the reason with no detail at all',
    (reason) => {
      const body = renderPauseComment(42, reason)
      expect(body.trim().length).toBeGreaterThan(0)
      expect(body).toContain(reason)
      expect(body).not.toContain('undefined')
    }
  )

  it('a detail carrying an em dash does not collide with the separator between the reason and the detail', () => {
    const body = renderPauseComment(
      1,
      'no_progress',
      'round 4 findings delivered again — guard: local marker file present'
    )
    expect(body).toContain(
      'The dev-review-loop paused: no_progress — round 4 findings delivered again — guard: local marker file present.'
    )
  })

  it('renders the exact vendor and model required to resume the same execution path', () => {
    const body = renderPauseComment(682, 'infrastructure', undefined, {
      agent: 'codex',
      model: 'gpt-5.6-terra'
    })
    expect(body).toContain('vinaya dev-review-loop --resume 682 --agent codex --model gpt-5.6-terra')
  })

  it('says a running loop picks up a ruling and reserves --resume for a stopped process', () => {
    const body = renderPauseComment(682, 'escalation', 'a decision is needed')
    expect(body).toContain('loop process still running picks up a posted ruling by itself')
    expect(body).toContain('only when that process has stopped')
  })
})

describe('renderNoPushStopComment (pure) — the no-PR-yet variant carries detail the same way', () => {
  it.each(ALL_PAUSE_REASONS)('reason %s carries a passed detail into the Issue-posted comment', (reason) => {
    const body = renderNoPushStopComment(631, 'task/issue-631', reason, 'a concrete, observed fact about this pause')
    expect(body).toContain(reason)
    expect(body).toContain('a concrete, observed fact about this pause')
    expect(body).toContain('vinaya task run --issue 631')
  })

  it('names a command the reader can run verbatim — never an unfilled `<tranche>` placeholder', () => {
    const body = renderNoPushStopComment(631, 'task/issue-631', 'escalation', 'refused at the entry gate', {
      agent: 'codex',
      model: 'gpt-5.6-terra'
    })
    expect(body).toContain('vinaya task run --issue 631 --agent codex --model gpt-5.6-terra')
    expect(body).not.toContain('<tranche>')
    // The Operator's own path out of this pause, which reads the same ruling
    // off this Issue.
    expect(body).toContain('task_resume')
  })

  it('addresses a TRANCHE task by its tranche and ordinal — the `--issue` form is refused for one', () => {
    const body = renderNoPushStopComment(781, 'task/unattended-run-v1/22', 'escalation', 'refused at the entry gate', {
      agent: 'claude'
    })
    expect(body).toContain('vinaya task run unattended-run-v1 22 --agent claude')
    // The form that cannot work for this task: `--issue <n>` is the
    // tranche-LESS backlog path, refused for a `vinaya/tranche:*`-labeled
    // Issue before any run starts.
    expect(body).not.toContain('--issue 781')
  })

  /**
   * The marker the comment prints is fed back through the REAL parser the
   * authority gates use, and the assertion is the property that matters —
   * the parsed ordinal exceeds the recorded baseline. A literal string compare
   * is what let the slots be swapped: the marker is `<ref>-<ordinal>` and the
   * ordinal is the SECOND number, so a rendered `ruling:5-1` for a baseline of
   * `4` parsed as ordinal `1` and the gate refused every ruling written exactly
   * as instructed. Round-tripping cannot pass while the two disagree.
   */
  function parsedOrdinalOf(body: string): number {
    const marker = body.split('\n').find((l) => l.startsWith('<!-- aeg:principal:ruling:')) ?? ''
    return newestPrincipalRulingOrdinal([{ body: marker, author: 'principal-1' }], ['principal-1'])
  }

  it.each([0, 1, 4, 37])('names a ruling marker whose PARSED ordinal exceeds the recorded baseline %s', (baseline) => {
    const body = renderNoPushStopComment(781, 'task/unattended-run-v1/22', 'escalation', undefined, undefined, baseline)
    expect(parsedOrdinalOf(body)).toBeGreaterThan(baseline)
  })

  it('names the task as the marker reference, so the printed marker is the one `principalRulingMarker` builds', () => {
    const body = renderNoPushStopComment(781, 'task/unattended-run-v1/22', 'escalation', undefined, undefined, 4)
    expect(body).toContain(principalRulingMarker(781, 5))
  })

  it('starts the marker ordinal at one when the escalation recorded no ruling baseline', () => {
    const body = renderNoPushStopComment(781, 'task/unattended-run-v1/22', 'escalation')
    expect(parsedOrdinalOf(body)).toBe(1)
  })

  it('never prints an injectable command line for a tranche segment taken from an Issue title', () => {
    // `developerBranchFor` builds the tranche segment from the Issue title's
    // own `[^\]]+`, so it is unvalidated forge input — and this command sits
    // in a fenced block a human or an Operator agent is told to run.
    const hostile = 'task/; echo pwned | sh/22'
    const body = renderNoPushStopComment(781, hostile, 'escalation')
    const printed = body.split('\n').find((l) => l.startsWith('vinaya task run')) ?? ''
    // The payload survives as DATA — one shell-quoted argument — never as a
    // command separator and a pipe the reader's shell would act on.
    expect(printed).toBe("vinaya task run '; echo pwned | sh' 22")
    // And it is exactly the argv the launcher spawns, not a weaker rendering.
    expect(noPushResumeArgv(781, hostile)).toEqual(['task', 'run', '; echo pwned | sh', '22'])
  })
})

describe('readPauseState — a record with no pull request reads as having none', () => {
  it('round-trips a null prNumber written by the before-any-push escalation', () => {
    writePauseState(dir, {
      task: TASK,
      round: 1,
      head: 'unknown',
      branch: 'task/x/1',
      prNumber: null,
      reason: 'escalation',
      pausedAt: '2026-01-01T00:00:00.000Z'
    })
    expect(readPauseState(dir, TASK)?.prNumber).toBeNull()
  })

  it.each([-1, 0])('normalizes the %s sentinel an older producer already wrote to disk', (sentinel) => {
    // Written by hand as the old producer wrote it — a `-1` that every
    // reader's own `=== null` guard let through, into `gh pr view -1`.
    const control = join(dir, 'tasks-execution', String(TASK), 'control')
    mkdirSync(control, { recursive: true })
    writeFileSync(
      join(control, 'pause-state.json'),
      JSON.stringify({
        task: TASK,
        round: 1,
        head: 'unknown',
        branch: 'task/x/1',
        prNumber: sentinel,
        reason: 'escalation',
        pausedAt: '2026-01-01T00:00:00.000Z'
      })
    )
    expect(readPauseState(dir, TASK)?.prNumber).toBeNull()
  })

  it('leaves a real pull request number exactly as written', () => {
    writePauseState(dir, {
      task: TASK,
      round: 2,
      head: 'headsha1',
      branch: 'task/x/1',
      prNumber: 900,
      reason: 'max_rounds',
      pausedAt: '2026-01-01T00:00:00.000Z'
    })
    expect(readPauseState(dir, TASK)?.prNumber).toBe(900)
  })
})

describe('noPushResumeCommandFor / noPushResumeArgv — the address form comes from the branch', () => {
  it('shell-quotes a token the argv carries verbatim, so the printed form is that argv and not a weaker join', () => {
    // A space-joined render produced a DIFFERENT command than the one that
    // runs for any tranche carrying whitespace — the same single-builder claim
    // the module documents, broken by the rendering step rather than the argv.
    const argv = noPushResumeArgv(781, 'task/two words/22', 'claude')
    expect(argv).toEqual(['task', 'run', 'two words', '22', '--agent', 'claude'])
    expect(noPushResumeCommandFor(781, 'task/two words/22', 'claude')).toBe(
      "vinaya task run 'two words' 22 --agent claude"
    )
  })

  it('leaves an ordinary slug unquoted', () => {
    expect(noPushResumeCommandFor(781, 'task/unattended-run-v1/22', 'claude', 'opus')).not.toContain("'")
  })

  it('addresses a backlog task by its Issue number', () => {
    expect(noPushResumeCommandFor(781, 'task/issue-781')).toBe('vinaya task run --issue 781')
    expect(noPushResumeCommandFor(781, 'task/issue-781', 'claude')).toBe('vinaya task run --issue 781 --agent claude')
    expect(noPushResumeCommandFor(781, 'task/issue-781', 'codex', 'gpt-5.6-terra')).toBe(
      'vinaya task run --issue 781 --agent codex --model gpt-5.6-terra'
    )
  })

  it('addresses a tranche task by tranche and ordinal, never by `--issue`', () => {
    expect(noPushResumeCommandFor(781, 'task/unattended-run-v1/22')).toBe('vinaya task run unattended-run-v1 22')
    expect(noPushResumeCommandFor(781, 'task/unattended-run-v1/22', 'claude', 'opus')).toBe(
      'vinaya task run unattended-run-v1 22 --agent claude --model opus'
    )
  })

  it('falls back to the Issue form for a branch that parses as neither shape', () => {
    // The only address derivable from a task number alone — better than
    // emitting a malformed tranche pair from an unrecognized branch.
    expect(noPushResumeCommandFor(781, 'not-a-task-branch')).toBe('vinaya task run --issue 781')
  })

  it('renders exactly the argv the launcher spawns, so the printed command and the launch cannot diverge', () => {
    expect(noPushResumeArgv(781, 'task/unattended-run-v1/22', 'claude')).toEqual([
      'task',
      'run',
      'unattended-run-v1',
      '22',
      '--agent',
      'claude'
    ])
    expect(`vinaya ${noPushResumeArgv(781, 'task/unattended-run-v1/22', 'claude').join(' ')}`).toBe(
      noPushResumeCommandFor(781, 'task/unattended-run-v1/22', 'claude')
    )
  })
})

describe('postWithRetry (round 2/round 4 review, MINOR — carried over unaddressed until this round) — a poster() call that landed remotely but threw locally is never duplicated on retry', () => {
  const identity = { operation: 'pr-comment', target: 'pr:1', inputVersion: 1, payloadDigest: 'deadbeef' }

  afterEach(() => {
    delete process.env.VINAYA_DEV_REVIEW_LOOP_PAUSE_COMMENT_RETRY_BACKOFF_MS
    delete process.env.VINAYA_DEV_REVIEW_LOOP_PAUSE_COMMENT_RETRY_ATTEMPTS
  })

  it('reconciles before the second poster() attempt and returns the already-landed url without calling poster() again', () => {
    process.env.VINAYA_DEV_REVIEW_LOOP_PAUSE_COMMENT_RETRY_BACKOFF_MS = '0'
    let posts = 0
    let reconciles = 0
    let reportedAttempts = -1
    const url = postWithRetry(
      () => {
        posts++
        // Attempt 1: the forge accepted the write, but the response never
        // reached this process (a dropped connection, a killed process) —
        // the caller sees a thrown error even though the comment landed.
        throw new Error('response lost after the write landed')
      },
      () => {
        reconciles++
        return { outcome: 'confirmed', url: 'https://example.com/comment/already-there' }
      },
      identity,
      (n) => {
        reportedAttempts = n
      }
    )
    expect(url).toBe('https://example.com/comment/already-there')
    expect(posts).toBe(1)
    expect(reconciles).toBe(1)
    expect(reportedAttempts).toBe(1)
  })

  it('an inconclusive (ambiguous/absent) reconcile between attempts still lets an ordinary retry proceed and post again', () => {
    process.env.VINAYA_DEV_REVIEW_LOOP_PAUSE_COMMENT_RETRY_BACKOFF_MS = '0'
    let posts = 0
    let reconciles = 0
    const url = postWithRetry(
      () => {
        posts++
        if (posts === 1) throw new Error('transient failure, nothing landed')
        return 'https://example.com/comment/posted-on-retry'
      },
      () => {
        reconciles++
        return { outcome: 'absent' }
      },
      identity,
      () => {}
    )
    expect(url).toBe('https://example.com/comment/posted-on-retry')
    expect(posts).toBe(2)
    expect(reconciles).toBe(1)
  })
})

describe('round 5 review, MAJOR — createEffectExecutor is called from INSIDE the try block in both post functions', () => {
  // `createEffectExecutor` itself can throw (a contended control-store
  // epoch — `acquireOwnership` returning `acquired: false`), and a throw
  // from outside the `try` a function's own doc comment promises never
  // throws is exactly the reason-clobbering bug this fix closes: the
  // outer crash handler would catch it, log a synthetic
  // `pause{reason:'infrastructure'}`, and overwrite `writePauseState`'s
  // already-correct reason. A behavioral reproduction needs a genuine
  // control-store epoch race against the real, process-memoized runtime
  // directory these functions resolve internally (`controlStoreRoot()`),
  // which every OTHER test manipulating that state does from a spawned
  // subprocess, never in-process, for exactly that reason — this asserts
  // the code SHAPE directly instead: `createEffectExecutor` must appear
  // strictly after the function's own `try {` token, never before it.
  const source = readFileSync(
    join(import.meta.dir, '..', '..', '..', 'src', 'lib', 'dev-review-loop', 'pause-resume.ts'),
    'utf8'
  )

  function bodyOf(fnSignature: string): string {
    const start = source.indexOf(fnSignature)
    expect(start).toBeGreaterThan(-1)
    const end = source.indexOf('\nexport function ', start + fnSignature.length)
    expect(end).toBeGreaterThan(start)
    return source.slice(start, end)
  }

  it('postIssuePauseComment never calls createEffectExecutor before its own try block', () => {
    const body = bodyOf('export function postIssuePauseComment(')
    const tryIndex = body.indexOf('try {')
    const executorIndex = body.indexOf('createEffectExecutor(')
    expect(tryIndex).toBeGreaterThan(-1)
    expect(executorIndex).toBeGreaterThan(tryIndex)
  })

  it('postPauseComment never calls createEffectExecutor before its own try block', () => {
    const body = bodyOf('export function postPauseComment(')
    const tryIndex = body.indexOf('try {')
    const executorIndex = body.indexOf('createEffectExecutor(')
    expect(tryIndex).toBeGreaterThan(-1)
    expect(executorIndex).toBeGreaterThan(tryIndex)
  })
})

describe('round 5 review, MINOR — a failure that never reaches postWithRetry/reconcileRetry still reports a loggable, positive attempts count', () => {
  // Same in-process-vs-real-control-store constraint as the describe block
  // above — a genuine `'corrupt'`-record reproduction needs the real,
  // process-memoized `controlStoreRoot()`. Asserts the code shape instead:
  // neither catch block returns the raw `attempts` variable un-normalized
  // (which would still be `0` — the `infrastructure_retry` schema's
  // `positive()` constraint would refuse to log it, and `0` reads
  // identically to the harmless already-verified-skip case either way).
  const source = readFileSync(
    join(import.meta.dir, '..', '..', '..', 'src', 'lib', 'dev-review-loop', 'pause-resume.ts'),
    'utf8'
  )

  it('both catch blocks normalize a zero attempts count to a loggable positive one', () => {
    const matches = source.match(/attempts:\s*attempts\s*\|\|\s*1/g) ?? []
    expect(matches).toHaveLength(2)
  })
})

describe('PAUSE_REASON_PROFILE — every reason whose next-action mentions `detail` presumes one is rendered (O3)', () => {
  it('carries exactly the seventeen documented PauseReason members, no more, no fewer', () => {
    expect(ALL_PAUSE_REASONS.sort()).toEqual(
      [
        'escalation',
        'max_rounds',
        'no_progress',
        'confidence',
        'reappearance',
        'repeat_finding',
        'repeat_failure',
        'time_budget',
        'infrastructure',
        'no_push',
        'objectives_changed',
        'ruling_posted',
        'stale_driver',
        'brief_superseded',
        'policy_changed',
        'sandbox_refused',
        'missing_source'
      ].sort()
    )
  })
})

describe('a repeated mechanical failure is addressed to the Principal', () => {
  afterEach(cleanupWorlds)

  it('the profile names the Principal and asks for a decision on the failure in detail', () => {
    expect(PAUSE_REASON_PROFILE.repeat_failure.requestedAuthority).toBe('principal')
    expect(PAUSE_REASON_PROFILE.repeat_failure.nextActions.join(' ')).toContain('Rule on the mechanical failure')
  })

  it('a real repeat_failure pause reads principal through the escalation packet', async () => {
    const world = makeWorld({
      gate: 'red',
      failingCheckRuns: [{ id: 101, name: 'Some check', conclusion: 'failure' }]
    })
    const base = makeInProcessDeps(world)
    const result = await runLoopInProcess(
      world,
      { task: world.task, agent: 'claude' },
      {
        ...base,
        resolveHead: () => String(world.dispatchCountByRole.developer ?? 0).repeat(40),
        readFailedCheckLogTail: () => 'error: the same failure'
      }
    )

    expect(result.finalDecision).toMatchObject({ type: 'pause', reason: 'repeat_failure' })
    const packet = await withWorldEnv(world, () => readEscalationPacket(world.runtimeDir, world.task))
    expect(packet?.reason).toBe('repeat_failure')
    expect(packet?.requestedAuthority).toBe('principal')
    expect(packet?.detail).toContain('the same failure')
  })
})

/**
 * A developer launch refused before any vendor process started — the record
 * a sign-in refusal leaves behind — never blocks the task: the next run
 * dispatches a fresh developer session, and the pause a repeated refusal
 * does produce says the developer could not sign in and spends none of the
 * loop's infrastructure-retry budget, so no number of sign-in failures ever
 * forces a Principal ruling to resume.
 */
describe('a pre-spawn sign-in refusal never blocks the task', () => {
  afterEach(cleanupWorlds)

  /** The launch record `dispatchRole` leaves after refusing before spawn: terminal, reasoned, no child pid, no bound session. */
  function seedPreSpawnRefusalLaunchRecord(world: LoopWorld): void {
    const sessionsDir = join(world.runtimeDir, 'tasks-execution', String(world.task), 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
    writeFileSync(
      join(sessionsDir, 'developer-claude.json'),
      JSON.stringify({
        runId: 'run-refused',
        role: 'developer',
        agent: 'claude',
        repo: null,
        task: world.task,
        pr: null,
        round: 1,
        attempt: 1,
        effectId: 'eff-refused',
        dispatcherPid: process.pid,
        childPid: null,
        childStartedAt: null,
        childCommand: null,
        host: hostname(),
        startedAt: '2026-09-26T00:00:00.000Z',
        status: 'interrupted',
        resumeId: null,
        boundAt: null,
        finishedAt: '2026-09-26T00:00:01.000Z',
        failureReason: 'authentication-failed'
      })
    )
  }

  /** Deps whose developer dispatch is refused at sign-in, exactly as `dispatchRole` reports it; reviewers keep the world's own clean fakes. */
  function signInRefusedDeps(world: LoopWorld): Partial<LoopDeps> {
    const base = makeInProcessDeps(world)
    return {
      dispatchRole: async (role, agent, prompt, opts) => {
        if (role !== 'developer') return base.dispatchRole!(role, agent, prompt, opts)
        world.dispatchCountByRole[role] = (world.dispatchCountByRole[role] ?? 0) + 1
        return {
          exitCode: null,
          durationMs: 1,
          usage: null,
          resumeId: null,
          timedOut: false,
          failureReason: 'authentication-failed'
        }
      }
    }
  }

  function heldPauseState(world: LoopWorld): Record<string, unknown> {
    return JSON.parse(readFileSync(join(controlDir(world), 'pause-state.json'), 'utf8')) as Record<string, unknown>
  }

  it("dispatches a fresh developer session over a refused launch record, instead of pausing on the worker's lost continuity", async () => {
    const world = makeWorld()
    seedPreSpawnRefusalLaunchRecord(world)

    const result = await runLoopInProcess(world)

    expect(result.finalDecision.type).toBe('publish')
    expect(world.dispatchCountByRole.developer).toBe(1)
  })

  it('pauses saying the developer could not sign in, and every later --resume continues with no ruling — the budget is never spent', async () => {
    // The pull request already exists and its gate is red (the adopter case
    // this comes from): the developer signed in for an earlier round, so
    // this round both NEEDS a developer turn and pauses against a real PR
    // number that `--resume` can name.
    const world = makeWorld({ developerPushed: true, gate: 'red' })

    for (let attempt = 1; attempt <= MAX_INFRASTRUCTURE_RETRIES + 1; attempt++) {
      seedPreSpawnRefusalLaunchRecord(world)
      const input =
        attempt === 1
          ? { task: world.task, agent: 'claude' as const }
          : { resumePr: world.prNumber, agent: 'claude' as const }

      const result = await runLoopInProcess(world, input, signInRefusedDeps(world))

      expect(result.finalDecision).toMatchObject({ type: 'pause', reason: 'infrastructure' })
      const held = heldPauseState(world)
      expect(String(held.detail)).toContain('could not sign in')
      // Never counted: a bare `--resume` stays available because this
      // number never reaches `MAX_INFRASTRUCTURE_RETRIES`, however many
      // times the host refuses to sign in. Were it counted, the run at
      // `MAX_INFRASTRUCTURE_RETRIES + 1` would already have thrown
      // "carries no Principal ruling comment yet" instead of pausing.
      expect(held.infrastructureRetries).toBe(0)

      // An `'infrastructure'` pause deliberately keeps the driver lock
      // alive; in production the driver process itself then exits and its
      // pid dies, which is what lets the next `--resume` take over. This
      // one process never exits, so the lock is cleared here to stand in
      // for that.
      rmSync(join(taskRunDir(world), 'driver.pid.json'), { force: true })
    }

    // Dispatched afresh on every one of those runs — the refused launch
    // record never once blocked the task — and no ruling was ever posted.
    expect(world.dispatchCountByRole.developer).toBe(MAX_INFRASTRUCTURE_RETRIES + 1)
    expect(world.rulings).toEqual([])
  })

  it('an ordinary infrastructure failure still spends the budget — the exclusion is keyed on the sign-in cause alone', async () => {
    const world = makeWorld()

    const result = await runLoopInProcess(
      world,
      { task: world.task, agent: 'claude' },
      {
        dispatchRole: async (role, agent, prompt, opts) => {
          if (role !== 'developer') return makeInProcessDeps(world).dispatchRole!(role, agent, prompt, opts)
          world.dispatchCountByRole[role] = (world.dispatchCountByRole[role] ?? 0) + 1
          return { exitCode: 1, durationMs: 1, usage: null, resumeId: null, timedOut: false, failureReason: 'crash' }
        }
      }
    )

    expect(result.finalDecision).toMatchObject({ type: 'pause', reason: 'infrastructure' })
    const held = heldPauseState(world)
    expect(String(held.detail)).not.toContain('could not sign in')
    expect(held.infrastructureRetries).toBe(1)
  })
})

/**
 * A sandbox capability refusal — the dispatch refused before the agent
 * started because the agent's sandbox probe failed on this host — pauses once,
 * addressed to the Operator, and is never retried as infrastructure: the host
 * does not change by itself. Driven in-process on the real loop and the real
 * watching driver, with only the forge and the agents faked; the refusal is
 * the handle `dispatchRole` returns for it, `failureReason: 'refused'` plus
 * the typed probe result.
 */
describe('a sandbox capability refusal pauses once for the Operator and is never retried as infrastructure', () => {
  afterEach(cleanupWorlds)

  const PROBE_ERROR =
    'apply-seccomp: write /proc/self/setgroups (nested userns is capability-restricted; caller must provide CAP_SYS_ADMIN): Permission denied'

  /** Deps whose developer dispatch is refused with `refusal` merged into the handle; reviewers keep the world's own fakes. */
  function refusedDeps(world: LoopWorld, refusal: Partial<DispatchHandle>): Partial<LoopDeps> {
    const base = makeInProcessDeps(world)
    return {
      dispatchRole: async (role, agent, prompt, opts) => {
        if (role !== 'developer') return base.dispatchRole!(role, agent, prompt, opts)
        world.dispatchCountByRole[role] = (world.dispatchCountByRole[role] ?? 0) + 1
        return { exitCode: null, durationMs: 1, usage: null, resumeId: null, timedOut: false, ...refusal }
      }
    }
  }

  const sandboxRefused = (world: LoopWorld): Partial<LoopDeps> =>
    refusedDeps(world, { failureReason: 'refused', sandboxProbeRefusal: { agent: 'claude', error: PROBE_ERROR } })
  /** A refusal that carries no probe result — any other pre-spawn refusal — stays the generic, transient path. */
  const otherRefusal = (world: LoopWorld): Partial<LoopDeps> => refusedDeps(world, { failureReason: 'refused' })

  it('classifies by the typed probe result, never by the shared refused reason, and keeps the reason out of automatic recovery', () => {
    expect(isHostRepairPause('sandbox_refused')).toBe(true)
    expect(isAutomaticRecoveryPause('sandbox_refused')).toBe(false)
    expect(PAUSE_REASON_PROFILE.sandbox_refused.requestedAuthority).toBe('operator')
    const held = {
      task: TASK,
      round: 1,
      head: 'headsha1',
      branch: 'task/x/1',
      prNumber: null,
      reason: 'sandbox_refused' as const,
      pausedAt: '2026-10-10T00:00:00.000Z',
      // However many infrastructure pauses came before, this one owes no ruling.
      infrastructureRetries: MAX_INFRASTRUCTURE_RETRIES
    }
    expect(pauseGrantsBareResume(held)).toBe(true)
    expect(missingEscalationNextStep(held)).toContain('needs the host repaired, not a ruling')
  })

  it('pauses with sandbox_refused on a pull request: the packet carries the probe error and the remedy, no retry is spent, and the lock is freed', async () => {
    const world = makeWorld({ developerPushed: true, gate: 'red' })

    const result = await runLoopInProcess(world, { task: world.task, agent: 'claude' }, sandboxRefused(world))

    expect(result.finalDecision).toMatchObject({ type: 'pause', reason: 'sandbox_refused' })
    const held = readPauseState(world.runtimeDir, world.task)
    expect(held?.reason).toBe('sandbox_refused')
    expect(held?.detail).toContain(PROBE_ERROR)
    expect(held?.infrastructureRetries).toBe(0)
    // The driver ends instead of holding the task: the next start takes it.
    expect(readDriverLock(world.runtimeDir, world.task)).toBeNull()
    const packet = await withWorldEnv(world, () => readEscalationPacket(world.runtimeDir, world.task))
    expect(packet?.requestedAuthority).toBe('operator')
    expect(packet?.detail).toContain(PROBE_ERROR)
    expect(packet?.attemptedRecovery).toContain(`${LINUX_SANDBOX_ALLOW_UNIX_SOCKETS_ENV}=1`)
    const comment = world.postedComments.find((c) => c.marker === '<!-- aeg:loop:paused:sandbox_refused -->')
    expect(comment?.body).toContain('No Principal ruling is needed')
    expect(comment?.body).not.toContain('A Principal ruling is needed')
  })

  it('the watching driver never restarts it — on a pull request or before one exists', async () => {
    for (const shape of [{ developerPushed: true, gate: 'red' as const }, {}]) {
      const world = makeWorld(shape)

      const result = await runDriverLoopInProcess(world, { task: world.task, agent: 'claude' }, sandboxRefused(world))

      expect(result.finalDecision).toMatchObject({ type: 'pause', reason: 'sandbox_refused' })
      expect(world.dispatchCountByRole.developer).toBe(1)
    }
  })

  it('a transient refusal still pauses as infrastructure and the watcher retries it within the bound', async () => {
    const world = makeWorld()

    const result = await runDriverLoopInProcess(world, { task: world.task, agent: 'claude' }, otherRefusal(world))

    expect(result.finalDecision).toMatchObject({ type: 'pause', reason: 'infrastructure' })
    const held = readPauseState(world.runtimeDir, world.task)
    expect(held?.infrastructureRetries).toBe(MAX_INFRASTRUCTURE_RETRIES)
    expect(world.dispatchCountByRole.developer).toBe(MAX_INFRASTRUCTURE_RETRIES)
  })

  it('once the host is repaired, the ordinary --resume continues a pull-request pause with no ruling and records its resolution once', async () => {
    const world = makeWorld({ developerPushed: true, gate: 'red' })
    await runLoopInProcess(world, { task: world.task, agent: 'claude' }, sandboxRefused(world))
    const held = readPauseState(world.runtimeDir, world.task)!

    await runLoopInProcess(world, { resumePr: world.prNumber, agent: 'claude' })

    expect(world.dispatchCountByRole.developer).toBeGreaterThanOrEqual(2)
    expect(world.rulings).toEqual([])
    const resolution = await withWorldEnv(world, () => readResolutionRecord(world.task, held.escalationId!))
    expect(resolution).toMatchObject({
      decision: 'resume',
      authenticatedBy: 'driver-self',
      authenticatedFrom: `${world.prNumber}-host-repaired`
    })
    await withWorldEnv(world, () => {
      expect(() =>
        resolveEscalation(world.task, held.escalationId!, world.prNumber, 'resume', 'driver-self', 'replay')
      ).toThrow(ReplayedResolutionError)
    })
  })

  it('once the host is repaired, `task run` continues a pause recorded before any pull request and records its resolution once', async () => {
    const world = makeWorld()
    await runLoopInProcess(world, { task: world.task, agent: 'claude' }, sandboxRefused(world))
    const held = readPauseState(world.runtimeDir, world.task)!
    expect(held.prNumber).toBeNull()
    expect(existsSync(join(taskRunDir(world), 'driver.pid.json'))).toBe(false)
    const deps = makeInProcessDeps(world)
    const runTaskDeps: RunTaskDeps = {
      prepareTask: async () => {
        throw new Error('unused: a backlog task')
      },
      prepareIssueTask: async ({ issue }) => ({
        issue,
        brief: world.frozenBrief,
        commentUrl: 'https://example/brief',
        version: 1
      }),
      assembleAndRenderBrief: async () => {
        throw new Error('unused: a backlog task')
      },
      assembleAndRenderBriefForIssue: async () => {
        throw new Error('unused: the brief is not frozen twice')
      },
      developerBranchFor: () => world.branch,
      findOpenPrForBranch: (branch) => deps.findOpenPrForBranch!(branch),
      isDriverAlive: () => false,
      hasPauseState: (task) => readPauseState(world.runtimeDir, task) !== null,
      resolveModelForDispatch: () => undefined,
      devReviewLoop: (input) => runDriverLoopInProcess(world, input),
      resolveRepo: async () => null,
      assignIssue: () => {}
    }

    const result = await withWorldEnv(world, () => runTask({ issue: world.task, agent: 'claude' }, runTaskDeps))

    expect(result.finalDecision?.type).toBe('publish')
    expect(world.rulings).toEqual([])
    const resolution = await withWorldEnv(world, () => readResolutionRecord(world.task, held.escalationId!))
    expect(resolution).toMatchObject({ decision: 'resume', authenticatedFrom: `issue-${world.task}-host-repaired` })
    expect(await withWorldEnv(world, () => consumeHostRepairPauseOnStart(world.runtimeDir, world.task))).toBe(false)
  })
})

/**
 * Round 2 review, MAJOR: the once-only, cancel-skip and replay-skip emission
 * logic (O1/O3) had no behavioral test — only a source-text grep (the
 * producer-coverage boundary in `log-callers.test.ts`) confirmed the event
 * NAMES exist, which would still pass with the `decision === 'resume'` guard
 * or the `existedBefore` idempotency check inverted or removed. These drive
 * `writeEscalationRecord`/`resolveEscalation` directly — in-process, isolated
 * the same way `runLoopInProcess` isolates a full loop run (`withWorldEnv`,
 * `dev-review-loop-harness.ts`) — and read back the REAL logged ndjson lines
 * (`outboxLines`), never a mock of `log()`.
 */
describe('writeEscalationRecord / resolveEscalation — the handoff Log family (O1-O3)', () => {
  afterEach(cleanupWorlds)

  function escalationFacts(world: LoopWorld, overrides: Partial<EscalationFacts> = {}): EscalationFacts {
    return {
      task: world.task,
      round: 1,
      head: world.head,
      branch: world.branch,
      pr: world.prNumber,
      runId: 'run-1',
      agent: 'claude',
      reason: 'escalation',
      detail: 'a concrete, observed fact about this pause',
      briefHash: 'deadbeef',
      objectivesVersion: null,
      rulingOrdinal: 0,
      policyDigest: 'policy-digest',
      ...overrides
    }
  }

  function handoffEvents(world: LoopWorld): Array<Record<string, unknown>> {
    return outboxLines(world).filter((e) => e.kind === 'handoff')
  }

  it('O1: logs exactly one handoff raised event, carrying class/reason/requested_decision, and none again on an idempotent rerun of the identical pause', async () => {
    const world = makeWorld()
    const facts = escalationFacts(world)

    await withWorldEnv(world, async () => {
      writeEscalationRecord(facts)
      // A rerun of the SAME pause instance — identical round/head/branch/pr/
      // reason/detail — which the control store answers with the same
      // canonical escalation id (`writeEscalation`, `@attalabs/aeg-core`).
      writeEscalationRecord(facts)
      // `log()` is fire-and-forget (queued, never awaited by its own
      // caller) — drained here, still inside this world's own isolated
      // env/cwd, so the write actually lands before `outboxLines` reads it.
      await drainLogSink()
    })

    const raised = handoffEvents(world).filter((e) => e.event === 'raised')
    expect(raised).toHaveLength(1)
    expect(raised[0]).toMatchObject({
      kind: 'handoff',
      event: 'raised',
      class: 'authority',
      reason: 'escalation',
      requested_decision: 'a concrete, observed fact about this pause'
    })
  })

  it('O1: a genuinely different pause colliding on the same round/head still logs its own raised event', async () => {
    const world = makeWorld()
    const facts = escalationFacts(world)
    const collidingFacts = escalationFacts(world, { detail: 'a different pause condition, same round and head' })

    await withWorldEnv(world, async () => {
      writeEscalationRecord(facts)
      writeEscalationRecord(collidingFacts)
      await drainLogSink()
    })

    expect(handoffEvents(world).filter((e) => e.event === 'raised')).toHaveLength(2)
  })

  it('O2: resolving with `resume` logs exactly one handoff resolved event, naming the resolution and who resolved it', async () => {
    const world = makeWorld()
    const facts = escalationFacts(world)
    const escalationId = escalationIdFor(facts.task, facts.round, facts.head)

    await withWorldEnv(world, async () => {
      writeEscalationRecord(facts)
      resolveEscalation(facts.task, escalationId, facts.pr, 'resume', 'daniboomerang', `${facts.pr}-1`)
      await drainLogSink()
    })

    const resolved = handoffEvents(world).filter((e) => e.event === 'resolved')
    expect(resolved).toHaveLength(1)
    expect(resolved[0]).toMatchObject({
      kind: 'handoff',
      event: 'resolved',
      class: 'authority',
      reason: 'escalation',
      resolution: 'resume',
      resolved_by: 'daniboomerang'
    })
  })

  it('O3: a cancel records no resolved event at all, leaving the earlier raised event untouched', async () => {
    const world = makeWorld()
    const facts = escalationFacts(world)
    const escalationId = escalationIdFor(facts.task, facts.round, facts.head)

    await withWorldEnv(world, async () => {
      writeEscalationRecord(facts)
      resolveEscalation(facts.task, escalationId, facts.pr, 'cancel', 'daniboomerang', `${facts.pr}-1`)
      await drainLogSink()
    })

    expect(handoffEvents(world).filter((e) => e.event === 'resolved')).toEqual([])
    expect(handoffEvents(world).filter((e) => e.event === 'raised')).toHaveLength(1)
  })

  it('O3: a replayed resolve is refused and logs no second resolved event', async () => {
    const world = makeWorld()
    const facts = escalationFacts(world)
    const escalationId = escalationIdFor(facts.task, facts.round, facts.head)

    await withWorldEnv(world, async () => {
      writeEscalationRecord(facts)
      resolveEscalation(facts.task, escalationId, facts.pr, 'resume', 'daniboomerang', `${facts.pr}-1`)
      expect(() =>
        resolveEscalation(facts.task, escalationId, facts.pr, 'resume', 'daniboomerang', `${facts.pr}-2`)
      ).toThrow()
      await drainLogSink()
    })

    expect(handoffEvents(world).filter((e) => e.event === 'resolved')).toHaveLength(1)
  })
})

// --- issue-1621: a published pull request that falls into conflict with main ---

describe('runDriverLoop — the watching driver re-enters a published pull request that falls into conflict', () => {
  it('re-enters once with no ruling: the Developer receives the conflicting files, and the gates and both reviews run again before it publishes', async () => {
    const world = makeWorld()
    world.afterPublish = 'watch'
    const developerPrompts: string[] = []
    const base = makeInProcessDeps(world)
    const loopDeps: Partial<LoopDeps> = {
      dispatchRole: async (role, agent, prompt, opts) => {
        if (role === 'developer') {
          developerPrompts.push(prompt)
          // The conflict turn merges the default branch in and pushes a new head that merges cleanly.
          if (prompt.includes('behind the base in a way that conflicts')) {
            world.head = 'c'.repeat(40)
            world.worktreeHead = world.head
            world.mergeable = 'MERGEABLE'
            world.conflictingFiles = []
          }
        }
        return base.dispatchRole!(role, agent, prompt, opts)
      }
    }
    let ticks = 0
    const result = await runDriverLoopInProcess(world, { task: world.task, agent: 'claude' }, loopDeps, {
      sleep: async () => {
        ticks += 1
        // The default branch moves under the published pull request while the driver watches it.
        if (world.publishedRounds.length === 1 && world.mergeable === 'MERGEABLE' && ticks === 2) {
          world.mergeable = 'CONFLICTING'
          world.conflictingFiles = ['apps/cli/src/lib/x.ts']
        }
        // Once it has published again, the pull request merges.
        if (world.publishedRounds.length === 2) world.prState = 'MERGED'
      }
    })

    expect(result.finalDecision).toEqual({ type: 'publish' })
    // No ruling was posted or needed.
    expect(world.rulingOrdinal).toBe(0)
    const conflictPrompts = developerPrompts.filter((p) => p.includes('behind the base in a way that conflicts'))
    expect(conflictPrompts).toHaveLength(1)
    expect(conflictPrompts[0]).toContain('apps/cli/src/lib/x.ts')
    expect(conflictPrompts[0]).toContain('git merge --no-commit origin/main')
    // Both reviews ran again on the resolved head, and it published a second time.
    expect(world.dispatchCountByRole['code-reviewer']).toBe(2)
    expect(world.dispatchCountByRole.security).toBe(2)
    expect(world.publishedRounds).toHaveLength(2)
    // The re-entry is narrated in the Log, once.
    expect(world.watchEvents).toEqual([
      expect.objectContaining({
        event: 'conflict_reentry',
        pr: world.prNumber,
        attempt: 1,
        bound: MAX_AUTOMATIC_CONFLICT_REENTRIES
      })
    ])
    // The driver lock was held through the watch and released once the pull request merged.
    expect(readDriverLock(world.runtimeDir, world.task)).toBeNull()
  })
})

describe('runDriverLoop — the published pull request watch', () => {
  function publishedWatch(
    reads: Array<{ state: 'OPEN' | 'MERGED' | 'CLOSED'; mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' }>
  ) {
    const calls: LoopInput[] = []
    const cleared: number[] = []
    const events: unknown[] = []
    const published: LoopResult = { finalDecision: { type: 'publish' }, prNumber: 42, task: 1621 }
    // One entry per watch tick: the tick reads the state, then the mergeability of the same entry.
    let read = -1
    const current = () => reads[Math.min(read, reads.length - 1)]!
    const watch: Partial<DriverWatchDeps> = {
      devReviewLoop: async (input) => {
        calls.push(input)
        if (input.pauseOnConflict !== undefined)
          return {
            finalDecision: { type: 'pause', reason: 'repeat_failure', detail: input.pauseOnConflict },
            prNumber: 42,
            task: 1621
          }
        return published
      },
      fetchPrState: () => {
        read += 1
        return current().state
      },
      fetchMergeableState: () => current().mergeable,
      readPauseState: () => null,
      logEvent: (event) => {
        events.push(event)
      },
      clearDriverLock: (_root, task) => {
        cleared.push(task)
      },
      gitRevParseOriginMain: () => 'start',
      runtimeDir: () => '/nonexistent',
      sleep: async () => {},
      watchPollIntervalMs: 0
    }
    return { calls, cleared, events, watch }
  }

  it('keeps watching after a publish and returns it once the pull request is merged, releasing the lock', async () => {
    const h = publishedWatch([
      { state: 'OPEN', mergeable: 'MERGEABLE' },
      { state: 'OPEN', mergeable: 'MERGEABLE' },
      { state: 'MERGED', mergeable: 'MERGEABLE' }
    ])
    const result = await runDriverLoop({ task: 1621, agent: 'claude' }, {}, h.watch)
    expect(result.finalDecision).toEqual({ type: 'publish' })
    expect(h.calls).toHaveLength(1)
    expect(h.cleared).toEqual([1621])
  })

  it('ends `closed` when the published pull request is closed', async () => {
    const h = publishedWatch([{ state: 'CLOSED', mergeable: 'MERGEABLE' }])
    const result = await runDriverLoop({ task: 1621, agent: 'claude' }, {}, h.watch)
    expect(result.finalDecision).toEqual({ type: 'ended', reason: 'closed' })
    expect(h.cleared).toEqual([1621])
  })

  it('never reads UNKNOWN as a conflict: it reads again on the next poll', async () => {
    const h = publishedWatch([
      { state: 'OPEN', mergeable: 'UNKNOWN' },
      { state: 'OPEN', mergeable: 'UNKNOWN' },
      { state: 'MERGED', mergeable: 'UNKNOWN' }
    ])
    await runDriverLoop({ task: 1621, agent: 'claude' }, {}, h.watch)
    expect(h.calls).toHaveLength(1)
    expect(h.events).toEqual([])
  })

  it('re-enters as `task run` would, under its own lock token, never through --resume', async () => {
    const h = publishedWatch([
      { state: 'OPEN', mergeable: 'CONFLICTING' },
      { state: 'MERGED', mergeable: 'MERGEABLE' }
    ])
    await runDriverLoop({ task: 1621, agent: 'codex', model: 'gpt-5.6' }, {}, h.watch)
    expect(h.calls).toHaveLength(2)
    const reentry = h.calls[1]!
    expect('resumePr' in reentry).toBe(false)
    expect(reentry).toMatchObject({ task: 1621, agent: 'codex', model: 'gpt-5.6' })
    expect(reentry.retainDriverLock).toBe(h.calls[0]!.retainDriverLock)
    expect(reentry.pauseOnConflict).toBeUndefined()
  })

  it('bounds the automatic re-entries: past the bound the run pauses for a person and the watch ends', async () => {
    const h = publishedWatch([{ state: 'OPEN', mergeable: 'CONFLICTING' }])
    const result = await runDriverLoop({ task: 1621, agent: 'claude' }, {}, h.watch)
    // The first run, the bounded re-entries, then the one that pauses.
    expect(h.calls).toHaveLength(MAX_AUTOMATIC_CONFLICT_REENTRIES + 2)
    expect(h.calls.slice(1, -1).every((call) => call.pauseOnConflict === undefined)).toBe(true)
    expect(h.calls.at(-1)!.pauseOnConflict).toContain('PR #42 fell into conflict')
    expect(result.finalDecision).toMatchObject({ type: 'pause', reason: 'repeat_failure' })
    expect(h.events.map((e) => (e as { attempt: number }).attempt)).toEqual(
      Array.from({ length: MAX_AUTOMATIC_CONFLICT_REENTRIES }, (_, i) => i + 1)
    )
    expect(h.cleared).toEqual([1621])
  })

  it('hands a stale watch to a fresh WATCHING driver, after counting and narrating the re-entry, carrying the count forward', async () => {
    const h = publishedWatch([{ state: 'OPEN', mergeable: 'CONFLICTING' }])
    const reexecs: string[][] = []
    const exits: number[] = []
    let baseReads = 0
    const result = await runDriverLoop(
      { task: 1621, agent: 'claude', model: 'opus' },
      {},
      {
        ...h.watch,
        // The default branch moved over the driver's own code after it started.
        gitRevParseOriginMain: () => (baseReads++ === 0 ? 'start' : 'moved'),
        gitCommitsTouchingDriverPaths: () => ['abc apps/cli/src/lib/dev-review-loop.ts'],
        pullDefaultBranch: () => ({ ok: true }),
        reexecSelf: (args) => {
          reexecs.push(args)
          return 0
        },
        exitProcess: ((code: number) => {
          exits.push(code)
        }) as never
      },
      { conflictReentries: 1 }
    )
    expect(result.finalDecision).toEqual({ type: 'publish' })
    // Only the first run happened in this process; the re-entry is the fresh driver's.
    expect(h.calls).toHaveLength(1)
    expect(reexecs).toEqual([
      [
        'dev-review-loop',
        '--task',
        '1621',
        '--watch',
        '--conflict-reentries',
        '2',
        '--agent',
        'claude',
        '--model',
        'opus'
      ]
    ])
    expect(exits).toEqual([0])
    expect(h.events).toEqual([expect.objectContaining({ event: 'conflict_reentry', attempt: 2 })])
  })

  it('hands a stale watch whose bound is spent to a fresh driver that pauses on the conflict', async () => {
    const h = publishedWatch([{ state: 'OPEN', mergeable: 'CONFLICTING' }])
    const reexecs: string[][] = []
    let baseReads = 0
    await runDriverLoop(
      { task: 1621, agent: 'claude' },
      {},
      {
        ...h.watch,
        gitRevParseOriginMain: () => (baseReads++ === 0 ? 'start' : 'moved'),
        gitCommitsTouchingDriverPaths: () => ['abc packages/aeg-core/src/x.ts'],
        pullDefaultBranch: () => ({ ok: true }),
        reexecSelf: (args) => {
          reexecs.push(args)
          return 0
        },
        exitProcess: (() => {}) as never
      },
      { conflictReentries: MAX_AUTOMATIC_CONFLICT_REENTRIES }
    )
    expect(h.events).toEqual([])
    const args = reexecs[0]!
    expect(args.slice(0, 6)).toEqual([
      'dev-review-loop',
      '--task',
      '1621',
      '--watch',
      '--conflict-reentries',
      String(MAX_AUTOMATIC_CONFLICT_REENTRIES)
    ])
    expect(args[args.indexOf('--pause-on-conflict') + 1]).toContain('PR #42 fell into conflict')
  })

  it('a handed-off driver keeps the carried count: its next conflict counts on from it', async () => {
    const h = publishedWatch([
      { state: 'OPEN', mergeable: 'CONFLICTING' },
      { state: 'MERGED', mergeable: 'MERGEABLE' }
    ])
    await runDriverLoop({ task: 1621, agent: 'claude' }, {}, h.watch, { conflictReentries: 2 })
    expect(h.events).toEqual([expect.objectContaining({ event: 'conflict_reentry', attempt: 3 })])
  })

  it("a handed-off driver carrying the bound's pause pauses on its first run and ends its watch", async () => {
    const h = publishedWatch([{ state: 'OPEN', mergeable: 'CONFLICTING' }])
    const result = await runDriverLoop({ task: 1621, agent: 'claude' }, {}, h.watch, {
      conflictReentries: MAX_AUTOMATIC_CONFLICT_REENTRIES,
      pauseOnConflict: 'bound spent'
    })
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]!.pauseOnConflict).toBe('bound spent')
    expect(result.finalDecision).toMatchObject({ type: 'pause', reason: 'repeat_failure' })
    expect(h.cleared).toEqual([1621])
  })

  it('driverCarryArgs renders the --watch argv', () => {
    expect(driverCarryArgs({})).toEqual(['--watch', '--conflict-reentries', '0'])
    expect(driverCarryArgs({ conflictReentries: 3, pauseOnConflict: 'd' })).toEqual([
      '--watch',
      '--conflict-reentries',
      '3',
      '--pause-on-conflict',
      'd'
    ])
  })
})
