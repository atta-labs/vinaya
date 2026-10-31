import { fixtureDir } from '../../../../apps/cli/tests/lib/test-temp-fixture'
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import type { Checkpoint } from '@langchain/langgraph'
import { writeDriverLock, writePauseState } from '../../../../apps/cli/src/lib/dev-review-loop/pause-resume'
import { SqliteCheckpointer } from '../../../../harness/dev-process/engine-runtime/sqlite-checkpointer'
import { checkpointPath, runDirectory } from '../../bin/run-engine'
import { runIdentityOfTask } from '../../bin/run-lifecycle'
import { drainReport, renderDrainReport } from './drain-check'

// The drain check reads only the host's runtime directory: none of these tasks has an open Issue anywhere, and every
// run they hold is still found. A live driver lock, a held pause and an Engine checkpoint short of its terminal step
// each block a move; an Engine run at its terminal step is history and blocks nothing.

const DRAIN_CHECK = join(import.meta.dir, 'drain-check.ts')
const LIVE = 11
const PAUSED = 12
const UNFINISHED = 13
const FINISHED = 14
const ABANDONED = 15
const DEAD_PID = 999_999

/** Writes one checkpoint for the task's run through the runtime's checkpointer; `outcome` marks it terminal. */
async function plantCheckpoint(runtimeDir: string, task: number, outcome?: Record<string, unknown>): Promise<void> {
  const identity = runIdentityOfTask(task)
  const saver = new SqliteCheckpointer({ path: checkpointPath(runDirectory(runtimeDir, task)), revision: 'abc' })
  try {
    const checkpoint: Checkpoint = {
      v: 1,
      id: '1f000000-0000-6000-8000-000000000001',
      ts: '2026-01-01T00:00:00.000Z',
      channel_values: { runId: identity.runId, results: {}, ...(outcome ? { outcome } : {}) },
      channel_versions: {},
      versions_seen: {},
      pending_sends: []
    }
    await saver.put({ configurable: { thread_id: identity.threadId, checkpoint_ns: '' } }, checkpoint, {
      source: 'loop',
      step: 1,
      parents: {}
    } as never)
  } finally {
    saver.close()
  }
}

async function plantedHost(): Promise<string> {
  const runtimeDir = fixtureDir('drain-check-')
  writeDriverLock(runtimeDir, LIVE, { pid: process.pid, startedAt: '2026-01-01T00:00:00.000Z' })
  writePauseState(runtimeDir, {
    task: PAUSED,
    round: 1,
    head: 'abc',
    branch: `task/issue-${PAUSED}`,
    prNumber: null,
    reason: 'missing_source',
    pausedAt: '2026-01-01T00:00:00.000Z',
    agent: 'codex'
  })
  await plantCheckpoint(runtimeDir, UNFINISHED)
  await plantCheckpoint(runtimeDir, FINISHED, { reason: 'completed', at: '2026-01-01T00:00:00.000Z' })
  writeDriverLock(runtimeDir, ABANDONED, { pid: DEAD_PID, startedAt: '2026-01-01T00:00:00.000Z' })
  return runtimeDir
}

const alive = (pid: number): boolean => pid === process.pid

describe('the drain check', () => {
  test('reports a live lock, a pause state and an unfinished checkpoint for tasks whose Issues are closed', async () => {
    const report = await drainReport(await plantedHost(), { isPidAlive: alive })
    const byTask = new Map(report.entries.map((entry) => [entry.task, entry]))
    expect(byTask.get(LIVE)?.state).toBe('live')
    expect(byTask.get(LIVE)?.found.join()).toContain(`a live driver lock (pid ${process.pid}`)
    expect(byTask.get(PAUSED)?.state).toBe('resumable')
    expect(byTask.get(PAUSED)?.found.join()).toContain('a pause state (missing_source, round 1, on codex)')
    expect(byTask.get(UNFINISHED)?.state).toBe('resumable')
    expect(byTask.get(UNFINISHED)?.found.join()).toContain('an Engine run whose checkpoint is not at a terminal step')
    expect(byTask.get(ABANDONED)?.state).toBe('resumable')
    expect(byTask.get(ABANDONED)?.found.join()).toContain('a driver lock whose process is gone')
    expect(report.blocked).toBe(true)
  })

  test('separates completed history from live and resumable runs', async () => {
    const report = await drainReport(await plantedHost(), { isPidAlive: alive })
    const finished = report.entries.find((entry) => entry.task === FINISHED)
    expect(finished?.state).toBe('completed')
    expect(finished?.found.join()).toContain('an Engine run at a terminal step (completed')
    const lines = renderDrainReport(report)
    expect(lines).toContain('live runs: 1')
    expect(lines).toContain('resumable runs: 3')
    expect(lines).toContain('completed history: 1')
    expect(lines.at(-1)).toContain('NOT DRAINED')
  })

  test('a host holding only completed history is drained', async () => {
    const runtimeDir = fixtureDir('drain-check-history-')
    await plantCheckpoint(runtimeDir, FINISHED, { reason: 'completed', at: '2026-01-01T00:00:00.000Z' })
    const report = await drainReport(runtimeDir, { isPidAlive: alive })
    expect(report.blocked).toBe(false)
    expect(renderDrainReport(report).at(-1)).toBe('drained: no live or resumable run')
  })

  test('the command exits non-zero while any live or resumable run exists, and zero once drained', async () => {
    const run = (runtimeDir: string) =>
      spawnSync(process.execPath, [DRAIN_CHECK, '--runtime-dir', runtimeDir], { encoding: 'utf8' })
    const blocked = run(await plantedHost())
    expect(blocked.status).toBe(1)
    expect(blocked.stdout).toContain(`task ${PAUSED}: a pause state`)
    expect(blocked.stdout).toContain(`task ${UNFINISHED}: an Engine run whose checkpoint is not at a terminal step`)
    const drained = run(fixtureDir('drain-check-empty-'))
    expect(drained.status).toBe(0)
    expect(drained.stdout).toContain('drained: no live or resumable run')
  }, 30_000)
})
