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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireOwnership,
  type ControlStoreDeps,
  defaultControlStoreDeps,
  type PauseReason,
  readEffect,
  writeEffect
} from '@attalabs/aeg-core'
import {
  fenceStartedEffectsAsUncertain,
  PAUSE_REASON_PROFILE,
  postWithRetry,
  renderNoPushStopComment,
  renderPauseComment
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
})

describe('renderNoPushStopComment (pure) — the no-PR-yet variant carries detail the same way', () => {
  it.each(ALL_PAUSE_REASONS)('reason %s carries a passed detail into the Issue-posted comment', (reason) => {
    const body = renderNoPushStopComment(631, reason, 'a concrete, observed fact about this pause')
    expect(body).toContain(reason)
    expect(body).toContain('a concrete, observed fact about this pause')
    expect(body).toContain('vinaya task run <tranche> 631')
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
  it('carries exactly the twelve documented PauseReason members, no more, no fewer', () => {
    expect(ALL_PAUSE_REASONS.sort()).toEqual(
      [
        'escalation',
        'max_rounds',
        'no_progress',
        'confidence',
        'reappearance',
        'infrastructure',
        'no_push',
        'objectives_changed',
        'ruling_posted',
        'stale_driver',
        'brief_superseded',
        'policy_changed'
      ].sort()
    )
  })
})
