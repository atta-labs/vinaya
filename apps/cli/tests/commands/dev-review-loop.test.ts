/**
 * `vinaya dev-review-loop` argv/refusal layer (dev-review-loop-v1 task 5,
 * `#415`) — mirrors `dispatch.test.ts`'s own lib-vs-command split:
 * `devReviewLoop`'s real dispatch/round-loop behavior is
 * `apps/cli/tests/lib/dev-review-loop.test.ts`'s job; this file only checks
 * that missing/invalid `--task`/`--agent` refuse by name before any dispatch
 * is attempted. Same fresh-subprocess discipline as `dispatch.test.ts` (a
 * scratch `HOME`, a scratch non-git `cwd`).
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX = join(CLI_ROOT, 'src', 'index.ts')

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

type CliResult = { status: number; stdout: string; stderr: string }

/**
 * Issue #660, O3 round 3 (security review, HIGH) — `devReviewLoop`'s own
 * `runtimeDirForThisRepo()` resolves unconditionally at the top of the call,
 * before any dispatch, the exact same `VINAYA_RUNTIME_DIR`-leak/no-budget
 * pattern already fixed in the sibling
 * `apps/cli/tests/lib/dev-review-loop.test.ts` (`fixtureChildEnv`) was left
 * unfixed here even though this file exercises the same call path.
 *
 * `AEG_REPO` is stripped alongside every `VINAYA_*` key (round 5, security
 * LOW) for the same reason `fixtureChildEnv` strips it there: a real value
 * inherited from a dispatched session's own environment would steer this
 * fixture's repo-segment resolution away from the `unresolved` bucket this
 * scratch, non-git `cwd` assumes. `PATH` is deliberately left untouched,
 * unlike that reference helper — one case below (`does not require --task
 * when --resume is given`) explicitly depends on the REAL ambient `PATH` so
 * `devReviewLoop` reaches a real `git`/`gh` failure past argv parsing.
 */
function stripVinayaEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env }
  for (const key of Object.keys(out)) {
    if (key.startsWith('VINAYA_')) delete out[key]
  }
  delete out.AEG_REPO
  // Left in place, a leaked GITHUB_ACTIONS makes a spawned child's own
  // log() resolve its destination to 'none' (log-sink.ts's
  // resolveLogDestinationFrom) instead of the folder/server a test expects
  // — the same leak #721 fixed for the in-process loop harness.
  delete out.GITHUB_ACTIONS
  return out
}

const SUBPROCESS_BUDGET_MS = 18_000

function run(args: string[]): CliResult {
  const cwd = tempDir('vinaya-dev-review-loop-cmd-cwd-')
  const home = tempDir('vinaya-dev-review-loop-cmd-home-')
  try {
    const stdout = execFileSync('bun', [INDEX, 'dev-review-loop', ...args], {
      encoding: 'utf8',
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...stripVinayaEnv(process.env), HOME: home },
      timeout: SUBPROCESS_BUDGET_MS,
      killSignal: 'SIGKILL'
    })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string; signal?: string | null }
    if (err.signal) {
      throw new Error(
        `vinaya dev-review-loop subprocess killed by ${err.signal} after exceeding its ${SUBPROCESS_BUDGET_MS}ms budget ` +
          `(args: ${args.join(' ')})\n--- stdout ---\n${err.stdout ?? ''}\n--- stderr ---\n${err.stderr ?? ''}`
      )
    }
    return { status: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
  }
}

describe('vinaya dev-review-loop — argv refusals', () => {
  it('refuses when --task is missing', () => {
    const r = run(['--agent', 'claude'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/--task <n> is required/)
  })

  it('refuses when --task is not a positive integer', () => {
    const r = run(['--task', 'nope', '--agent', 'claude'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/--task <n> is required/)
  })

  it('refuses when --agent is missing and no config fallback exists', () => {
    const r = run(['--task', '415'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/--agent <claude\|codex\|gemini> is required/)
  })

  // task-run-v1 task 15, O1: `--issue <n>` is `--task <n>`'s exact synonym —
  // it parses past the "--task is required" refusal, reaching the next gate
  // (--agent), the same way --task itself does.
  it('accepts --issue as a synonym for --task', () => {
    const r = run(['--issue', '415'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).not.toMatch(/--task <n> is required/)
    expect(r.stderr).toMatch(/--agent <claude\|codex\|gemini> is required/)
  })

  it('refuses an invalid --agent vendor', () => {
    const r = run(['--task', '415', '--agent', 'chatgpt'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/invalid vendor 'chatgpt'/)
  })

  it('refuses when --resume is not a positive integer PR number', () => {
    const r = run(['--resume', 'nope', '--agent', 'claude'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/--resume <pr> requires a positive integer PR number/)
  })

  it('does not require --task when --resume is given', () => {
    // No fake `gh`/`git` on PATH here — `devReviewLoop` itself will fail
    // trying to resolve the PR, but that failure happens INSIDE the lib
    // call, well past this file's job (argv parsing/refusal only). The
    // point of this test is narrower: `--task` is not required for this
    // command to accept `--resume` and proceed past argv parsing.
    const r = run(['--resume', '123', '--agent', 'claude'])
    expect(r.stderr).not.toMatch(/--task <n> is required/)
  })
})
