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
  readEffect,
  writeEffect
} from '@attalabs/aeg-core'
import { fenceStartedEffectsAsUncertain } from '../../../src/lib/dev-review-loop/pause-resume'

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
