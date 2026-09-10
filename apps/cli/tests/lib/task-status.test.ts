/**
 * `task-status.ts`'s pure outbox-reading half — `deriveLoopState`,
 * `renderTaskStatusRow` — both take an explicit `root`, so these run
 * in-process against a plain temp directory rather than a subprocess with a
 * faked `$HOME` (unlike `dev-review-loop.test.ts`'s own driver-lock tests,
 * which must use a subprocess because `dev-review-loop.ts` reads
 * `outboxRoot()` — a module-level constant frozen at first import —
 * internally).
 *
 * The forge-reading half (`listOpenTaskIssues`, `hasFrozenBrief`,
 * `findPrForTask`) shells out to real `gh` and is exercised instead through
 * the CLI end-to-end, in `apps/cli/tests/commands/task-status.test.ts`.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deriveLoopState, renderTaskStatusRow, type TaskStatusRow } from '../../src/lib/task-status.js'

const TASK = 515

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-task-status-'))
  tempDirs.push(dir)
  return dir
}

function taskDir(root: string, task: number): string {
  return join(root, 'dev-review-loop', String(task))
}

function writeOutboxFile(root: string, task: number, name: string, content: string): void {
  const dir = taskDir(root, task)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), content, 'utf8')
}

/** A pid that has definitely already exited — `spawnSync` blocks until the child is gone before returning its pid (`dev-review-loop.test.ts`'s own `deadPid`). */
function deadPid(): number {
  const r = spawnSync('true', [])
  if (typeof r.pid !== 'number') throw new Error('spawnSync did not report a pid')
  return r.pid
}

describe('deriveLoopState', () => {
  it('reports no_driver when the outbox carries nothing for this task', () => {
    const root = tempDir()
    expect(deriveLoopState(root, TASK)).toEqual({ kind: 'no_driver' })
  })

  it('reports running with the driver pid when the lock names a live process', () => {
    const root = tempDir()
    writeOutboxFile(
      root,
      TASK,
      'driver.pid.json',
      JSON.stringify({ pid: process.pid, startedAt: '2026-09-10T00:00:00.000Z' })
    )
    expect(deriveLoopState(root, TASK)).toEqual({
      kind: 'running',
      pid: process.pid,
      startedAt: '2026-09-10T00:00:00.000Z'
    })
  })

  it('treats a dead pid record as absent, never as running', () => {
    const root = tempDir()
    writeOutboxFile(
      root,
      TASK,
      'driver.pid.json',
      JSON.stringify({ pid: deadPid(), startedAt: '2026-09-10T00:00:00.000Z' })
    )
    expect(deriveLoopState(root, TASK)).toEqual({ kind: 'no_driver' })
  })

  it('reports paused with the reason from the pause record when no driver is running', () => {
    const root = tempDir()
    writeOutboxFile(
      root,
      TASK,
      'pause-state.json',
      JSON.stringify({
        task: TASK,
        round: 2,
        head: 'abc123',
        branch: 'task/task-run-v1/14',
        prNumber: 517,
        reason: 'escalation',
        pausedAt: '2026-09-10T00:00:00.000Z'
      })
    )
    expect(deriveLoopState(root, TASK)).toEqual({ kind: 'paused', reason: 'escalation', detail: undefined, round: 2 })
  })

  it('reports published when the newest round posted both verdict effect markers', () => {
    const root = tempDir()
    writeOutboxFile(root, TASK, 'effect-1-reviewer-verdict.json', JSON.stringify({ effectId: 'a', status: 'posted' }))
    writeOutboxFile(root, TASK, 'effect-1-security-verdict.json', JSON.stringify({ effectId: 'b', status: 'posted' }))
    expect(deriveLoopState(root, TASK)).toEqual({ kind: 'published', round: 1 })
  })

  it("does not report published when only one of the round's two markers posted", () => {
    const root = tempDir()
    writeOutboxFile(root, TASK, 'effect-1-reviewer-verdict.json', JSON.stringify({ effectId: 'a', status: 'posted' }))
    writeOutboxFile(root, TASK, 'effect-1-security-verdict.json', JSON.stringify({ effectId: 'b', status: 'started' }))
    expect(deriveLoopState(root, TASK)).toEqual({ kind: 'no_driver' })
  })

  it('prefers published over a pause record superseded by a later publish', () => {
    const root = tempDir()
    // Paused at round 2 — resumed since, and round 3 published cleanly. The
    // pause-state.json file is never cleared on resume (today's outbox
    // shape), so this is the exact staleness `deriveLoopState`'s own doc
    // comment names.
    writeOutboxFile(
      root,
      TASK,
      'pause-state.json',
      JSON.stringify({
        task: TASK,
        round: 2,
        head: 'abc123',
        branch: 'task/task-run-v1/14',
        prNumber: 517,
        reason: 'escalation',
        pausedAt: '2026-09-10T00:00:00.000Z'
      })
    )
    writeOutboxFile(root, TASK, 'effect-3-reviewer-verdict.json', JSON.stringify({ effectId: 'a', status: 'posted' }))
    writeOutboxFile(root, TASK, 'effect-3-security-verdict.json', JSON.stringify({ effectId: 'b', status: 'posted' }))
    expect(deriveLoopState(root, TASK)).toEqual({ kind: 'published', round: 3 })
  })

  it('still reports the pause when it is newer than the latest publish', () => {
    const root = tempDir()
    writeOutboxFile(root, TASK, 'effect-1-reviewer-verdict.json', JSON.stringify({ effectId: 'a', status: 'posted' }))
    writeOutboxFile(root, TASK, 'effect-1-security-verdict.json', JSON.stringify({ effectId: 'b', status: 'posted' }))
    writeOutboxFile(
      root,
      TASK,
      'pause-state.json',
      JSON.stringify({
        task: TASK,
        round: 2,
        head: 'def456',
        branch: 'task/task-run-v1/14',
        prNumber: 517,
        reason: 'max_rounds',
        pausedAt: '2026-09-10T00:00:00.000Z'
      })
    )
    expect(deriveLoopState(root, TASK)).toEqual({
      kind: 'paused',
      reason: 'max_rounds',
      detail: undefined,
      round: 2
    })
  })
})

describe('renderTaskStatusRow', () => {
  const base: Omit<TaskStatusRow, 'state' | 'pr'> = { tranche: 'task-run-v1', id: '14', issue: 515 }

  it('renders running with the pid', () => {
    const row: TaskStatusRow = { ...base, pr: { number: 517 }, state: { kind: 'running', pid: 4242, startedAt: 'x' } }
    expect(renderTaskStatusRow(row)).toBe('[task-run-v1] 14 — Issue #515 — PR #517 — running (pid 4242)')
  })

  it('renders paused with the reason', () => {
    const row: TaskStatusRow = {
      ...base,
      pr: { number: 517 },
      state: { kind: 'paused', reason: 'escalation', round: 2 }
    }
    expect(renderTaskStatusRow(row)).toBe('[task-run-v1] 14 — Issue #515 — PR #517 — paused (escalation)')
  })

  it('renders published', () => {
    const row: TaskStatusRow = { ...base, pr: { number: 517 }, state: { kind: 'published', round: 1 } }
    expect(renderTaskStatusRow(row)).toBe('[task-run-v1] 14 — Issue #515 — PR #517 — published')
  })

  it('renders no driver with no PR yet', () => {
    const row: TaskStatusRow = { ...base, pr: null, state: { kind: 'no_driver' } }
    expect(renderTaskStatusRow(row)).toBe('[task-run-v1] 14 — Issue #515 — PR — — no driver')
  })
})
