import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  acquireOwnership,
  appendTransition,
  attemptEpochClaim,
  InvalidEffectKeyError,
  InvalidRunIdError,
  readCurrentOwnership,
  readEffect,
  readInput,
  readRun,
  readTransitions,
  StaleEpochWriteError,
  writeEffect,
  writeInput,
  writeRun,
  type ControlStoreDeps
} from './local'

// This suite is entirely aeg-core / node:fs — nothing here ever reaches the
// Vinaya Log sink (`apps/cli/src/lib/log-sink.ts` lives in a different
// package and is never imported from this directory), so every fault
// fixture below runs with telemetry disabled by construction, not by an
// env flag that would need remembering.

let dir: string
let deps: ControlStoreDeps
let clock: Date

function makeDeps(): ControlStoreDeps {
  return {
    root: () => dir,
    now: () => clock,
    pid: () => 4242,
    hostname: () => 'test-host'
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'control-store-test-'))
  clock = new Date('2026-09-14T00:00:00.000Z')
  deps = makeDeps()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('acquireOwnership', () => {
  it('grants epoch 1 to the first caller on a task with no history', () => {
    const result = acquireOwnership(deps, 551, 'run-a')
    expect(result).toMatchObject({ acquired: true, epoch: 1 })
    expect(readCurrentOwnership(deps, 551).epoch).toBe(1)
  })

  it('simultaneous acquisition: two callers racing from the same observed epoch — exactly one wins', () => {
    // Two real OS processes racing both call `readCurrentOwnership`, both
    // see epoch 0 (neither has written yet), and both go on to compute the
    // same next epoch — which reduces to two calls of `attemptEpochClaim`
    // with the identical epoch argument, deterministically reproducible
    // here without needing true concurrency: two controllers racing for
    // one run, exactly one winning the epoch.
    const first = attemptEpochClaim(deps, 551, 1, 'run-a')
    const second = attemptEpochClaim(deps, 551, 1, 'run-b')

    const winners = [first, second].filter((r) => r.outcome === 'won')
    const losers = [first, second].filter((r) => r.outcome === 'lost')
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(losers[0]).toMatchObject({ outcome: 'lost', record: { epoch: 1, ownerId: 'run-a' } })
    expect(readCurrentOwnership(deps, 551).epoch).toBe(1)
  })

  it('a later acquisition after a real completed run is a takeover, not a race loss', () => {
    acquireOwnership(deps, 551, 'run-a')
    const second = acquireOwnership(deps, 551, 'run-b')
    expect(second).toMatchObject({ acquired: true, epoch: 2 })
  })

  it('reclaims a corrupt epoch slot left by an interrupted write, rather than deadlocking on it forever', () => {
    // Simulate a crash that left a torn write in the exact epoch-1 slot a
    // fresh acquisition would try next: not valid JSON, so the strict
    // parser reads it as corrupt, never as a live owner.
    mkdirSync(join(dir, '551', 'ownership'), { recursive: true })
    writeFileSync(join(dir, '551', 'ownership', 'epoch-000001.json'), '{"version":1,"kind":"ow', 'utf8')

    const result = acquireOwnership(deps, 551, 'run-a')
    expect(result).toMatchObject({ acquired: true, epoch: 1 })
  })
})

describe('interrupted write — a torn record is refused as corrupt, never read as absent', () => {
  it('for a run record', () => {
    acquireOwnership(deps, 551, 'run-a')
    mkdirSync(join(dir, '551', 'run'), { recursive: true })
    writeFileSync(join(dir, '551', 'run', 'run-a.json'), '{"version":1,"kind":"run","task":551,', 'utf8')

    const result = readRun(deps, 551, 'run-a')
    expect(result.status).toBe('corrupt')
  })

  it('for an ownership record read back directly', () => {
    mkdirSync(join(dir, '551', 'ownership'), { recursive: true })
    writeFileSync(join(dir, '551', 'ownership', 'epoch-000001.json'), 'not json at all', 'utf8')

    const current = readCurrentOwnership(deps, 551)
    expect(current.epoch).toBe(0)
    expect(current.record).toBeNull()
    expect(current.corruptEpochs).toEqual([1])
  })
})

describe('stale writes are refused inside the store', () => {
  it('writeRun refuses an epoch that is no longer current', () => {
    const first = acquireOwnership(deps, 551, 'run-a')
    expect(first.acquired).toBe(true)
    acquireOwnership(deps, 551, 'run-b') // takes over — epoch 2 is now current

    expect(() =>
      writeRun(deps, 551, 1, { runId: 'run-a', pid: 100, host: 'box', startedAt: clock.toISOString() })
    ).toThrow(StaleEpochWriteError)
  })

  it('writeInput refuses a stale epoch the same way', () => {
    acquireOwnership(deps, 551, 'run-a')
    acquireOwnership(deps, 551, 'run-b')

    expect(() =>
      writeInput(deps, 551, 1, { runId: 'run-a', source: 'fresh', pr: null, round: 0, recordedAt: clock.toISOString() })
    ).toThrow(StaleEpochWriteError)
  })

  it('appendTransition refuses a stale epoch the same way', () => {
    acquireOwnership(deps, 551, 'run-a')
    acquireOwnership(deps, 551, 'run-b')

    expect(() => appendTransition(deps, 551, 1, { from: 'active', to: 'paused', at: clock.toISOString() })).toThrow(
      StaleEpochWriteError
    )
  })

  it('a write at the CURRENT epoch succeeds and reads back', () => {
    const acquired = acquireOwnership(deps, 551, 'run-a')
    expect(acquired.acquired).toBe(true)
    const epoch = acquired.acquired ? acquired.epoch : -1

    writeRun(deps, 551, epoch, { runId: 'run-a', pid: 100, host: 'box', startedAt: clock.toISOString() })
    writeInput(deps, 551, epoch, {
      runId: 'run-a',
      source: 'fresh',
      pr: null,
      round: 0,
      recordedAt: clock.toISOString()
    })
    const t1 = appendTransition(deps, 551, epoch, { from: 'active', to: 'dispatched', at: clock.toISOString() })
    const t2 = appendTransition(deps, 551, epoch, {
      from: 'dispatched',
      to: 'paused',
      at: clock.toISOString(),
      detail: 'confidence'
    })

    expect(readRun(deps, 551, 'run-a')).toEqual({
      status: 'ok',
      value: {
        version: 1,
        kind: 'run',
        task: 551,
        runId: 'run-a',
        pid: 100,
        host: 'box',
        startedAt: clock.toISOString()
      }
    })
    expect(readInput(deps, 551, 'run-a').status).toBe('ok')

    const transitions = readTransitions(deps, 551, epoch)
    expect(transitions.map((t) => (t.status === 'ok' ? t.value : t))).toEqual([t1, t2])
    expect(t1.seq).toBe(0)
    expect(t2.seq).toBe(1)
  })
})

describe('a runId cannot escape the task directory', () => {
  it('writeRun refuses a runId shaped like a path traversal, and writes nothing outside the task directory', () => {
    const acquired = acquireOwnership(deps, 551, 'run-a')
    expect(acquired.acquired).toBe(true)
    const epoch = acquired.acquired ? acquired.epoch : -1
    const escapeAttempt = '../../../../../../tmp/control-store-escape'

    expect(() =>
      writeRun(deps, 551, epoch, { runId: escapeAttempt, pid: 1, host: 'box', startedAt: clock.toISOString() })
    ).toThrow(InvalidRunIdError)
    expect(existsSync(join(dir, 'tmp', 'control-store-escape.json'))).toBe(false)
    expect(existsSync('/tmp/control-store-escape.json')).toBe(false)
  })

  it('writeInput and the readRun/readInput counterparts refuse the same shape', () => {
    const acquired = acquireOwnership(deps, 551, 'run-a')
    const epoch = acquired.acquired ? acquired.epoch : -1
    const escapeAttempt = '../escaped'

    expect(() =>
      writeInput(deps, 551, epoch, {
        runId: escapeAttempt,
        source: 'fresh',
        pr: null,
        round: 0,
        recordedAt: clock.toISOString()
      })
    ).toThrow(InvalidRunIdError)
    expect(() => readRun(deps, 551, escapeAttempt)).toThrow(InvalidRunIdError)
    expect(() => readInput(deps, 551, escapeAttempt)).toThrow(InvalidRunIdError)
  })

  it('an absolute path as runId is refused the same way', () => {
    expect(() => readRun(deps, 551, '/etc/passwd')).toThrow(InvalidRunIdError)
  })

  it('an ordinary runId (letters, digits, dot, underscore, hyphen) is unaffected', () => {
    const acquired = acquireOwnership(deps, 551, 'run-a')
    const epoch = acquired.acquired ? acquired.epoch : -1
    expect(() =>
      writeRun(deps, 551, epoch, { runId: 'run-a.1_ok', pid: 1, host: 'box', startedAt: clock.toISOString() })
    ).not.toThrow()
  })
})

describe('writeEffect / readEffect', () => {
  it('writes at the current epoch and reads back the same record', () => {
    const acquired = acquireOwnership(deps, 552, 'run-a')
    const epoch = acquired.acquired ? acquired.epoch : -1

    const record = writeEffect(deps, 552, epoch, 'round-1-summary', {
      operation: 'pr-comment',
      target: 'pr:600',
      inputVersion: 1,
      payloadDigest: 'deadbeef',
      status: 'started',
      recordedAt: clock.toISOString()
    })

    expect(readEffect(deps, 552, 'round-1-summary')).toEqual({ status: 'ok', value: record })
  })

  it('is refused (StaleEpochWriteError) once the caller no longer holds the current epoch', () => {
    const first = acquireOwnership(deps, 552, 'run-a')
    expect(first.acquired).toBe(true)
    acquireOwnership(deps, 552, 'run-b') // takes over

    expect(() =>
      writeEffect(deps, 552, 1, 'round-1-summary', {
        operation: 'pr-comment',
        target: 'pr:600',
        inputVersion: 1,
        payloadDigest: 'deadbeef',
        status: 'started',
        recordedAt: clock.toISOString()
      })
    ).toThrow(StaleEpochWriteError)
  })

  it('reports absent when nothing was ever written for a key', () => {
    expect(readEffect(deps, 552, 'never-written')).toEqual({ status: 'absent' })
  })

  it('refuses an unsafe key the same way an unsafe runId is refused', () => {
    const acquired = acquireOwnership(deps, 552, 'run-a')
    const epoch = acquired.acquired ? acquired.epoch : -1

    expect(() =>
      writeEffect(deps, 552, epoch, '../escaped', {
        operation: 'pr-comment',
        target: 'pr:600',
        inputVersion: 1,
        payloadDigest: 'deadbeef',
        status: 'started',
        recordedAt: clock.toISOString()
      })
    ).toThrow(InvalidEffectKeyError)
    expect(() => readEffect(deps, 552, '../escaped')).toThrow(InvalidEffectKeyError)
  })
})
