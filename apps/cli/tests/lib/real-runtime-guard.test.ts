/**
 * Guard: no test in this suite may create or change a file under the REAL
 * per-repository runtime directory (`~/.vinaya/runtime/<owner>-<repo>`).
 * Leaks of that kind outlive the test run — they showed up as task folders
 * numbered like fixtures (9, 9001, 9201) that the start-up sweep then logged
 * forge errors for on every loop start.
 *
 * The whole-run check lives in `test-env-preload.ts` (an `afterAll` every test
 * process loads, so every CI shard and every local run fails on a leak). This
 * file is that observer's own test, plus a mid-run check whose TITLE names any
 * leaked path — a failing run's summary lists titles, not assertion output.
 */
import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exemptPrefixes, PROCESS_START_MS, realRuntimeDir, touchedSince } from './real-runtime-guard-core'

/** Taken at module load so the test's own TITLE names the leaked paths. */
const leakedAtLoad = touchedSince(realRuntimeDir(), PROCESS_START_MS, exemptPrefixes(process.env))
const TITLE = 'no test so far has written into the real runtime directory'
const title = leakedAtLoad.length > 0 ? `${TITLE} — LEAKED: ${leakedAtLoad.join(' ').slice(0, 800)}` : TITLE

describe('real runtime directory guard', () => {
  it(title, () => {
    expect(touchedSince(realRuntimeDir(), PROCESS_START_MS, exemptPrefixes(process.env))).toEqual([])
  })

  it('detects a write newer than the cutoff and ignores exempt paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'real-runtime-guard-'))
    try {
      mkdirSync(join(root, 'tasks-execution', '7'), { recursive: true })
      mkdirSync(join(root, 'tasks-execution', '9'), { recursive: true })
      writeFileSync(join(root, 'tasks-execution', '7', 'a'), 'x')
      writeFileSync(join(root, 'tasks-execution', '9', 'b'), 'x')
      const found = touchedSince(root, Date.now() - 60_000, [join('tasks-execution', '7')])
      expect(found).toContain(join('tasks-execution', '9', 'b'))
      expect(found.some((p) => p.startsWith(join('tasks-execution', '7')))).toBe(false)
      expect(touchedSince(root, Date.now() + 60_000, [])).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not flag a directory whose only change is an exempt entry added inside it', () => {
    const root = mkdtempSync(join(tmpdir(), 'real-runtime-guard-'))
    try {
      mkdirSync(join(root, 'tasks-execution', 'old'), { recursive: true })
      const cutoff = Date.now() + 1000
      Bun.sleepSync(1100)
      mkdirSync(join(root, 'tasks-execution', '7'))
      writeFileSync(join(root, 'tasks-execution', '7', 'a'), 'x')
      expect(touchedSince(root, cutoff, [join('tasks-execution', '7')])).toEqual([])
      // the same directory created after the cutoff, not exempt, is flagged
      expect(touchedSince(root, cutoff, [])).toEqual([join('tasks-execution', '7'), join('tasks-execution', '7', 'a')])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('exempts a task whose lock names a running process, not one whose pid is dead', () => {
    const root = mkdtempSync(join(tmpdir(), 'real-runtime-guard-'))
    try {
      // an unused pid: spawn-and-reap a child, whose pid is then free
      const dead = Bun.spawnSync(['true']).pid
      const lock = (pid: number) => JSON.stringify({ pid, startedAt: new Date().toISOString(), token: 't' })
      for (const [task, pid] of [
        ['live', process.pid],
        ['stale', dead]
      ] as const) {
        mkdirSync(join(root, 'tasks-execution', task), { recursive: true })
        mkdirSync(join(root, 'logs'), { recursive: true })
        writeFileSync(join(root, 'tasks-execution', task, 'driver.pid.json'), lock(pid))
        writeFileSync(join(root, 'tasks-execution', task, 'state'), 'x')
        writeFileSync(join(root, 'logs', `${task}.ndjson`), 'x')
      }
      writeFileSync(join(root, 'logs', 'other.ndjson'), 'x')
      const found = touchedSince(root, Date.now() - 60_000, [])
      expect(found.some((p) => p.includes('live'))).toBe(false)
      expect(found).toContain(join('tasks-execution', 'stale', 'state'))
      expect(found).toContain(join('logs', 'stale.ndjson'))
      expect(found).toContain(join('logs', 'other.ndjson'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
