import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acquireOwnership, readRun, readTransitions, type ControlStoreDeps } from './local'
import { defaultIsPidAlive, migrateLegacyTask } from './migration'

let storeDir: string
let legacyDir: string
let deps: ControlStoreDeps

function legacyTaskDir(task: number): string {
  const d = join(legacyDir, 'dev-review-loop', String(task))
  mkdirSync(d, { recursive: true })
  return d
}

beforeEach(() => {
  storeDir = mkdtempSync(join(tmpdir(), 'control-store-'))
  legacyDir = mkdtempSync(join(tmpdir(), 'legacy-outbox-'))
  deps = {
    root: () => storeDir,
    now: () => new Date('2026-09-14T00:00:00.000Z'),
    pid: () => 9999,
    hostname: () => 'test-host'
  }
})

afterEach(() => {
  rmSync(storeDir, { recursive: true, force: true })
  rmSync(legacyDir, { recursive: true, force: true })
})

const deadPid = 999999 // vitest's own process tree should never hold this pid
const alwaysAlive = () => true
const alwaysDead = () => false

describe('migrateLegacyTask', () => {
  it('reports nothing-to-migrate when the legacy task directory never existed', () => {
    const result = migrateLegacyTask(deps, legacyDir, 551, 'run-migrate', alwaysDead)
    expect(result).toEqual({ status: 'nothing-to-migrate', task: 551 })
  })

  it('migrates a real outbox fixture: driver.pid.json, pause-state.json, and two effect records', () => {
    const dir = legacyTaskDir(551)
    writeFileSync(
      join(dir, 'driver.pid.json'),
      JSON.stringify({ pid: deadPid, startedAt: '2026-09-13T10:00:00.000Z' }),
      'utf8'
    )
    writeFileSync(
      join(dir, 'pause-state.json'),
      JSON.stringify({
        task: 551,
        round: 2,
        head: 'deadbeef',
        branch: 'task/control-store-v1/1',
        prNumber: 601,
        reason: 'confidence',
        pausedAt: '2026-09-13T11:00:00.000Z'
      }),
      'utf8'
    )
    writeFileSync(
      join(dir, 'effect-2-reviewer-verdict.json'),
      JSON.stringify({ effectId: 'abc', status: 'posted', url: 'https://example.invalid/1' }),
      'utf8'
    )
    writeFileSync(join(dir, 'effect-2-summary.json'), JSON.stringify({ effectId: 'def', status: 'started' }), 'utf8')

    const result = migrateLegacyTask(deps, legacyDir, 551, 'run-migrate', alwaysDead)
    expect(result).toEqual({ status: 'migrated', task: 551, epoch: 1, transitionsWritten: 3 })

    const run = readRun(deps, 551, 'run-migrate')
    expect(run).toEqual({
      status: 'ok',
      value: {
        version: 1,
        kind: 'run',
        task: 551,
        runId: 'run-migrate',
        pid: deadPid,
        host: 'test-host',
        startedAt: '2026-09-13T10:00:00.000Z'
      }
    })

    const transitions = readTransitions(deps, 551, 1).map((t) => (t.status === 'ok' ? t.value.to : t))
    expect(transitions).toEqual(['paused:confidence', 'effect:2-reviewer-verdict:posted', 'effect:2-summary:started'])
  })

  it('refuses ambiguous ownership when the legacy driver pid is still live', () => {
    const dir = legacyTaskDir(552)
    writeFileSync(
      join(dir, 'driver.pid.json'),
      JSON.stringify({ pid: process.pid, startedAt: '2026-09-13T10:00:00.000Z' }),
      'utf8'
    )

    const result = migrateLegacyTask(deps, legacyDir, 552, 'run-migrate', alwaysAlive)
    expect(result.status).toBe('refused')
    expect((result as { reason: string }).reason).toMatch(/still live/)
  })

  it('refuses ambiguous ownership when the task already holds a control-store epoch', () => {
    legacyTaskDir(553)
    writeFileSync(
      join(legacyTaskDir(553), 'pause-state.json'),
      JSON.stringify({
        task: 553,
        round: 1,
        head: 'abc',
        branch: 'b',
        prNumber: 700,
        reason: 'max_rounds',
        pausedAt: '2026-09-13T11:00:00.000Z'
      }),
      'utf8'
    )
    acquireOwnership(deps, 553, 'some-earlier-run')

    const result = migrateLegacyTask(deps, legacyDir, 553, 'run-migrate', alwaysDead)
    expect(result.status).toBe('refused')
    expect((result as { reason: string }).reason).toMatch(/already has a control-store epoch/)
  })

  it('refuses rather than guesses when a legacy file is corrupt (torn write)', () => {
    const dir = legacyTaskDir(554)
    writeFileSync(join(dir, 'driver.pid.json'), '{"pid":123,"started', 'utf8')

    const result = migrateLegacyTask(deps, legacyDir, 554, 'run-migrate', alwaysDead)
    expect(result.status).toBe('refused')
    expect((result as { reason: string }).reason).toMatch(/corrupt/)
  })
})

describe('defaultIsPidAlive', () => {
  it('reads this process itself as alive', () => {
    expect(defaultIsPidAlive(process.pid)).toBe(true)
  })

  it('reads a pid with no living process as dead', () => {
    expect(defaultIsPidAlive(999999)).toBe(false)
  })
})
