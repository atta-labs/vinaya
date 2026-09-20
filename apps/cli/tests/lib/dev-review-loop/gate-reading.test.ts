/**
 * Unit tests for `gate-reading.ts`'s own two seams (task `#595`):
 *
 *   - O3: `fetchMechanicalCheckRuns`'s dedupe reads the newest `started_at`
 *     per check-run name, not the highest `id`.
 *   - O5: `sh()`'s `gh`-only retry — a transient failure is retried, with
 *     backoff, before it counts as a real failure; a persistent one still
 *     throws after the bound.
 *
 *   - O1/O3 (`driver-lifecycle-v1` task 2, `#607`): `fetchFailingCheckRuns`
 *     carries each failing run's own id and `started_at` alongside its
 *     name — the identity a pause built from it can be audited against —
 *     and, because it reads the same already-deduped list, a failure a
 *     later same-named run has superseded with a pass never appears in it.
 *
 * Faked at the `$PATH` boundary (a real, tiny, executable `gh` stand-in) and
 * run in a genuinely FRESH `bun` subprocess with that `$PATH` baked into its
 * own spawn-time `env` — never a runtime `process.env.PATH` mutation of
 * THIS test process. `execFileSync` under Bun resolves the executable
 * against the env captured at process start, not a later in-process
 * mutation of `process.env.PATH` (found live authoring this file — a
 * runtime-mutated `PATH` silently kept resolving the real, machine-installed
 * `gh`). Same discipline `detect.test.ts`'s own `withFakeBin` already uses
 * for a different reason (a module-scope function reference race); the
 * mechanism here is a subprocess for a different reason again.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSyncBudgeted, stripVinayaEnv } from '../process-fixture'

const GATE_READING = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'src',
  'lib',
  'dev-review-loop',
  'gate-reading.ts'
)

const HEAD = 'a'.repeat(40)

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function writeFakeGh(dir: string, script: string): void {
  const file = join(dir, 'gh')
  writeFileSync(file, `#!/bin/sh\n${script}\n`)
  chmodSync(file, 0o755)
}

/**
 * Runs `snippet` (a bare expression statement using `fetchCiConclusion` /
 * `fetchFailingCheckRuns` / `fetchMergeableState`, already in scope) as a
 * fresh `bun -e` subprocess, with `binDir` prepended to that subprocess's
 * OWN spawn-time `PATH` — never this test process's `process.env.PATH`.
 *
 * Issue #660, O3 (round 4 review, round 5 Principal ruling) — this
 * process's own `VINAYA_*` environment is stripped before `PATH`/`extraEnv`
 * are applied, and the subprocess is bounded by an explicit budget that
 * throws with its own captured stdout/stderr on expiry, rather than a bare
 * timeout.
 */
function runGateReading(
  binDir: string,
  snippet: string,
  extraEnv: Record<string, string> = {}
): { status: number; stdout: string; stderr: string } {
  const script = `
    import { fetchCiConclusion, fetchFailingCheckRuns, fetchMergeableState } from ${JSON.stringify(GATE_READING)}
    ${snippet}
  `
  return spawnSyncBudgeted(
    'bun',
    ['-e', script],
    { encoding: 'utf8', env: { ...stripVinayaEnv(), PATH: `${binDir}:${process.env.PATH ?? ''}`, ...extraEnv } },
    undefined,
    'gate-reading bun -e'
  )
}

describe('fetchMechanicalCheckRuns dedupe — O3 (#595): newest started_at wins, not the highest id', () => {
  it('an older-id, newer-started_at success wins over an older-started_at failure', () => {
    const dir = tempDir('vinaya-gh-dedupe-')
    writeFakeGh(
      dir,
      `
if [ "$1" = "api" ]; then
  printf '%s\\n' '{"id":1,"name":"token-report","status":"completed","conclusion":"failure","started_at":"2026-09-14T10:00:00Z"}'
  printf '%s\\n' '{"id":2,"name":"token-report","status":"completed","conclusion":"success","started_at":"2026-09-14T10:05:00Z"}'
  exit 0
fi
exit 1
`
    )
    const r = runGateReading(
      dir,
      `console.log(fetchCiConclusion(${JSON.stringify(HEAD)})); console.log(JSON.stringify(fetchFailingCheckRuns(${JSON.stringify(HEAD)})))`
    )
    expect(r.stderr).toBe('')
    const [conclusion, runs] = r.stdout.trim().split('\n')
    expect(conclusion).toBe('green')
    expect(JSON.parse(runs as string)).toEqual([])
  })

  it('the reverse order (the NEWER started_at is the failure, but carries the LOWER id) reads red', () => {
    const dir = tempDir('vinaya-gh-dedupe-reverse-')
    writeFakeGh(
      dir,
      `
if [ "$1" = "api" ]; then
  printf '%s\\n' '{"id":5,"name":"token-report","status":"completed","conclusion":"success","started_at":"2026-09-14T10:00:00Z"}'
  printf '%s\\n' '{"id":1,"name":"token-report","status":"completed","conclusion":"failure","started_at":"2026-09-14T10:05:00Z"}'
  exit 0
fi
exit 1
`
    )
    const r = runGateReading(
      dir,
      `console.log(fetchCiConclusion(${JSON.stringify(HEAD)})); console.log(JSON.stringify(fetchFailingCheckRuns(${JSON.stringify(HEAD)})))`
    )
    expect(r.stderr).toBe('')
    const [conclusion, runs] = r.stdout.trim().split('\n')
    expect(conclusion).toBe('red')
    // O3 (`#607`): the surviving run is named by id and started_at, not just
    // by check name — the audit trail a pause detail is later built from.
    expect(JSON.parse(runs as string)).toEqual([{ name: 'token-report', id: 1, startedAt: '2026-09-14T10:05:00Z' }])
  })
})

describe('sh (gh reads) — O5 (#595): every gh read retries three times, with backoff, before counting as a failure', () => {
  it('a fake gh failing twice then succeeding produces no error at all', () => {
    const dir = tempDir('vinaya-gh-retry-')
    const counterPath = join(dir, 'attempts')
    writeFileSync(counterPath, '0')
    writeFakeGh(
      dir,
      `
N=$(cat "${counterPath}")
N=$((N + 1))
echo "$N" > "${counterPath}"
if [ "$N" -lt 3 ]; then
  echo "transient failure" >&2
  exit 1
fi
echo '{"mergeable":"MERGEABLE"}'
exit 0
`
    )
    const r = runGateReading(dir, 'console.log(fetchMergeableState(123))', {
      VINAYA_DEV_REVIEW_LOOP_GH_RETRY_BACKOFF_MS: '1'
    })
    expect(r.stderr).toBe('')
    expect(r.stdout.trim()).toBe('MERGEABLE')
  })

  it('a fake gh failing every time still throws once all three attempts are exhausted', () => {
    const dir = tempDir('vinaya-gh-retry-always-')
    writeFakeGh(dir, `echo "always fails" >&2\nexit 1\n`)
    const r = runGateReading(dir, 'fetchMergeableState(123)', {
      VINAYA_DEV_REVIEW_LOOP_GH_RETRY_BACKOFF_MS: '1'
    })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('fetchMergeableState')
  })
})
