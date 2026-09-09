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

function run(args: string[]): CliResult {
  const cwd = tempDir('vinaya-dev-review-loop-cmd-cwd-')
  const home = tempDir('vinaya-dev-review-loop-cmd-home-')
  try {
    const stdout = execFileSync('bun', [INDEX, 'dev-review-loop', ...args], {
      encoding: 'utf8',
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home }
    })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
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
