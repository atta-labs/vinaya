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
    import { failureCheckName, fetchCiConclusion, fetchFailingCheckRuns, fetchMergeableState } from ${JSON.stringify(GATE_READING)}
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
  case "$2" in *actions/runs*) exit 0 ;; esac
  printf '%s\\n' '{"id":1,"name":"evidence-fresh","status":"completed","conclusion":"failure","started_at":"2026-09-14T10:00:00Z"}'
  printf '%s\\n' '{"id":2,"name":"evidence-fresh","status":"completed","conclusion":"success","started_at":"2026-09-14T10:05:00Z"}'
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
  case "$2" in *actions/runs*) exit 0 ;; esac
  printf '%s\\n' '{"id":5,"name":"evidence-fresh","status":"completed","conclusion":"success","started_at":"2026-09-14T10:00:00Z"}'
  printf '%s\\n' '{"id":1,"name":"evidence-fresh","status":"completed","conclusion":"failure","started_at":"2026-09-14T10:05:00Z"}'
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
    expect(JSON.parse(runs as string)).toEqual([{ name: 'evidence-fresh', id: 1, startedAt: '2026-09-14T10:05:00Z' }])
  })
})

describe('failureCheckName — the stable part of a repeat-failure signature (#1227)', () => {
  it('keeps a check name while excluding its per-attempt run identity', () => {
    const dir = tempDir('vinaya-gh-failure-name-')
    writeFakeGh(dir, 'exit 0')
    const r = runGateReading(
      dir,
      `console.log(failureCheckName({ name: 'Sandbox conformance (macOS)', id: 113692204562, startedAt: '2026-10-09T05:59:00Z' }))`
    )
    expect(r.stderr).toBe('')
    expect(r.stdout.trim()).toBe('Sandbox conformance (macOS)')
  })
})

describe("principal-test-plan-wait exclusion (O3): its own red is the Principal's wait, not a failure to fix", () => {
  it('the ONLY red check-run being principal-test-plan-wait reads as green CI, with nothing failing — no developer round would be dispatched', () => {
    const dir = tempDir('vinaya-gh-principal-wait-only-')
    writeFakeGh(
      dir,
      `
if [ "$1" = "api" ]; then
  case "$2" in *actions/runs*) exit 0 ;; esac
  printf '%s\\n' '{"id":1,"name":"vinaya check principal-test-plan-wait","status":"completed","conclusion":"failure","started_at":"2026-09-21T10:00:00Z"}'
  printf '%s\\n' '{"id":2,"name":"evidence-fresh","status":"completed","conclusion":"success","started_at":"2026-09-21T10:00:00Z"}'
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

  it('every OTHER red check-run still reads red and still names its failure — the exclusion is scoped to this one name', () => {
    const dir = tempDir('vinaya-gh-other-red-')
    writeFakeGh(
      dir,
      `
if [ "$1" = "api" ]; then
  case "$2" in *actions/runs*) exit 0 ;; esac
  printf '%s\\n' '{"id":1,"name":"vinaya check principal-test-plan-wait","status":"completed","conclusion":"failure","started_at":"2026-09-21T10:00:00Z"}'
  printf '%s\\n' '{"id":2,"name":"evidence-fresh","status":"completed","conclusion":"failure","started_at":"2026-09-21T10:00:00Z"}'
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
    expect(JSON.parse(runs as string)).toEqual([{ name: 'evidence-fresh', id: 2, startedAt: '2026-09-21T10:00:00Z' }])
  })
})

/**
 * A fake `gh` answering the three reads the CI reader makes: the check-runs
 * list, the workflow-runs list, and a failed run's jobs.
 */
function fakeGhReading(opts: { checkRuns: object[]; workflowRuns: object[] | 'fail'; jobs?: string[] }): string {
  const lines = (items: object[]): string => items.map((i) => `printf '%s\\n' '${JSON.stringify(i)}'`).join('\n  ')
  return `
case "$2" in
  *actions/runs/*/jobs*)
  ${(opts.jobs ?? []).map((c) => `printf '%s\\n' '${c}'`).join('\n  ')}
  exit 0 ;;
  *actions/runs*)
  ${opts.workflowRuns === 'fail' ? 'echo boom >&2; exit 1' : `${lines(opts.workflowRuns)}\n  exit 0`} ;;
  *check-runs*)
  ${lines(opts.checkRuns)}
  exit 0 ;;
esac
exit 1
`
}

const PASSING_JOBS = [
  { id: 11, name: 'lint', status: 'completed', conclusion: 'success', started_at: '2026-10-08T10:00:00Z' },
  { id: 12, name: 'typecheck', status: 'completed', conclusion: 'success', started_at: '2026-10-08T10:00:00Z' },
  { id: 13, name: 'build', status: 'completed', conclusion: 'success', started_at: '2026-10-08T10:00:00Z' }
]

function ciRun(over: Record<string, unknown>): object {
  return {
    id: 123,
    name: 'CI',
    workflow_id: 7,
    status: 'completed',
    conclusion: 'failure',
    created_at: '2026-10-08T10:00:00Z',
    run_started_at: '2026-10-08T10:00:00Z',
    ...over
  }
}

function readCi(dir: string): { conclusion: string; runs: unknown } {
  const r = runGateReading(
    dir,
    `console.log(fetchCiConclusion(${JSON.stringify(HEAD)})); console.log(JSON.stringify(fetchFailingCheckRuns(${JSON.stringify(HEAD)})))`
  )
  expect(r.stderr).toBe('')
  const [conclusion, runs] = r.stdout.trim().split('\n')
  return { conclusion: conclusion as string, runs: JSON.parse(runs as string) }
}

describe('workflow-run conclusion — a failed run reads red even when every job that exists passed', () => {
  it('the outage case: a CI run ended failure, only its passing jobs were created, so the head reads red and names the run', () => {
    const dir = tempDir('vinaya-gh-wf-outage-')
    writeFakeGh(dir, fakeGhReading({ checkRuns: PASSING_JOBS, workflowRuns: [ciRun({})], jobs: ['success'] }))
    const { conclusion, runs } = readCi(dir)
    expect(conclusion).toBe('red')
    expect(runs).toEqual([
      {
        name: 'CI',
        id: 123,
        startedAt: '2026-10-08T10:00:00Z',
        detail: 'workflow CI run 123 ended failure with no failing job — its jobs were not all created'
      }
    ])
  })

  it('a run that failed through a failing job names the workflow, run and conclusion without the no-job note', () => {
    const dir = tempDir('vinaya-gh-wf-failing-job-')
    writeFakeGh(
      dir,
      fakeGhReading({
        checkRuns: PASSING_JOBS,
        workflowRuns: [ciRun({ conclusion: 'timed_out' })],
        jobs: ['timed_out']
      })
    )
    const { conclusion, runs } = readCi(dir)
    expect(conclusion).toBe('red')
    expect(runs).toMatchObject([{ detail: 'workflow CI run 123 ended timed_out' }])
  })

  it('startup_failure with no check-run at all reads red, not pending', () => {
    const dir = tempDir('vinaya-gh-wf-startup-')
    writeFakeGh(
      dir,
      fakeGhReading({ checkRuns: [], workflowRuns: [ciRun({ conclusion: 'startup_failure' })], jobs: [] })
    )
    expect(readCi(dir).conclusion).toBe('red')
  })

  it('a re-run of the same workflow that succeeded reads green', () => {
    const dir = tempDir('vinaya-gh-wf-rerun-')
    writeFakeGh(
      dir,
      fakeGhReading({
        checkRuns: PASSING_JOBS,
        workflowRuns: [
          ciRun({}),
          ciRun({
            id: 124,
            conclusion: 'success',
            created_at: '2026-10-08T10:30:00Z',
            run_started_at: '2026-10-08T10:30:00Z'
          })
        ]
      })
    )
    const { conclusion, runs } = readCi(dir)
    expect(conclusion).toBe('green')
    expect(runs).toEqual([])
  })

  it('a workflow run still in progress reads pending, never green', () => {
    const dir = tempDir('vinaya-gh-wf-pending-')
    writeFakeGh(
      dir,
      fakeGhReading({
        checkRuns: PASSING_JOBS,
        workflowRuns: [ciRun({ status: 'in_progress', conclusion: null })]
      })
    )
    expect(readCi(dir).conclusion).toBe('pending')
  })

  it('a failed read of the workflow runs reads pending, never green or red', () => {
    const dir = tempDir('vinaya-gh-wf-readfail-')
    writeFakeGh(dir, fakeGhReading({ checkRuns: PASSING_JOBS, workflowRuns: 'fail' }))
    const r = runGateReading(dir, `console.log(fetchCiConclusion(${JSON.stringify(HEAD)}))`, {
      VINAYA_DEV_REVIEW_LOOP_GH_RETRY_BACKOFF_MS: '0'
    })
    expect(r.stdout.trim()).toBe('pending')
  })

  it("the review gate's, on-verdict and body-checks workflow runs are not CI: their failure does not make the head red", () => {
    const dir = tempDir('vinaya-gh-wf-excluded-')
    writeFakeGh(
      dir,
      fakeGhReading({
        checkRuns: PASSING_JOBS,
        workflowRuns: [
          ciRun({ id: 1, name: 'Vinaya Review Gate', workflow_id: 1 }),
          ciRun({ id: 2, name: 'Vinaya Review Gate (on verdict)', workflow_id: 2 }),
          ciRun({ id: 3, name: 'Vinaya Body Checks', workflow_id: 3, status: 'in_progress', conclusion: null }),
          ciRun({ id: 4, conclusion: 'success' })
        ]
      })
    )
    const { conclusion, runs } = readCi(dir)
    expect(conclusion).toBe('green')
    expect(runs).toEqual([])
  })

  it('managed workflows are told apart by their workflow file, because GitHub reports their per-pull-request run name as `name`', () => {
    const dir = tempDir('vinaya-gh-wf-run-name-')
    const sha = '568abd8d4e882c8e3151e8bf4fd6e001bacb7ea7'
    writeFakeGh(
      dir,
      fakeGhReading({
        checkRuns: PASSING_JOBS,
        workflowRuns: [
          ciRun({
            id: 1,
            name: `Vinaya Review Gate PR #1189 @ ${sha}`,
            path: '.github/workflows/vinaya-review.yml',
            workflow_id: 1
          }),
          ciRun({
            id: 2,
            name: `Vinaya Body Checks PR #1189 @ ${sha}`,
            path: '.github/workflows/vinaya-body-checks.yml',
            workflow_id: 2
          }),
          ciRun({
            id: 3,
            name: 'Vinaya Review Gate (on verdict)',
            path: '.github/workflows/vinaya-review-verdict.yml',
            workflow_id: 3
          }),
          ciRun({ id: 4, conclusion: 'success', path: '.github/workflows/ci.yml' })
        ]
      })
    )
    const { conclusion, runs } = readCi(dir)
    expect(conclusion).toBe('green')
    expect(runs).toEqual([])
  })

  it('a failed CI run still reads red beside excluded managed workflows that carry a per-pull-request run name', () => {
    const dir = tempDir('vinaya-gh-wf-run-name-ci-red-')
    writeFakeGh(
      dir,
      fakeGhReading({
        checkRuns: PASSING_JOBS,
        workflowRuns: [
          ciRun({
            id: 1,
            name: 'Vinaya Review Gate PR #1176 @ 7f9aacd5',
            path: '.github/workflows/vinaya-review.yml',
            workflow_id: 1
          }),
          ciRun({ path: '.github/workflows/ci.yml' })
        ],
        jobs: ['success']
      })
    )
    const { conclusion, runs } = readCi(dir)
    expect(conclusion).toBe('red')
    expect(runs).toMatchObject([{ name: 'CI', id: 123 }])
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
