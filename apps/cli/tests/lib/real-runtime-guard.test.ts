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
})
