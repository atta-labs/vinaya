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
import { mkdtempSync, rmSync } from 'node:fs'
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
})

describe('renderNoPushStopComment (pure) — the no-PR-yet variant carries detail the same way', () => {
  it.each(ALL_PAUSE_REASONS)('reason %s carries a passed detail into the Issue-posted comment', (reason) => {
    const body = renderNoPushStopComment(631, reason, 'a concrete, observed fact about this pause')
    expect(body).toContain(reason)
    expect(body).toContain('a concrete, observed fact about this pause')
    expect(body).toContain('vinaya task run <tranche> 631')
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
