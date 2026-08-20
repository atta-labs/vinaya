import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { coreCheckRegistry } from '../../src/checks/registry'
import { runChecks } from '../../src/checks/runner'

// Bin-level tests, deliberately separate from body-bare-digits.test.ts (which
// exercises the pure checkBareDigits() logic only) — the Changesets-release
// skip lives in the bin's own main(), and its author half is a live `gh pr
// view` fetch (round 3 fix — an env var here would sit behind a required,
// non-bypassable status check), so it can only be proven by actually
// spawning the bin with a fake `gh` on PATH, not by injecting env values.

const BIN = join(import.meta.dir, '..', '..', 'src', 'checks', 'bin', 'check-body-bare-digits.ts')

const VIOLATING_BODY = '## Releases\n\n## @attalabs/vinaya@0.17.1\n\n- 0ee0056: Add a thing\n'

let dirs: string[] = []

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

/** A fake `gh` on PATH: `gh pr view` returns the given author. */
function fakeGh(author: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'bare-digits-fake-gh-'))
  dirs.push(dir)
  const ghDir = join(dir, 'fakebin')
  mkdirSync(ghDir, { recursive: true })
  const authorJson = author === null ? 'null' : `{"login":${JSON.stringify(author)}}`
  writeFileSync(join(ghDir, 'gh'), `#!/bin/sh\necho '{"author":${authorJson}}'\n`)
  chmodSync(join(ghDir, 'gh'), 0o755)
  return ghDir
}

async function runCheck(
  env: Record<string, string | undefined>,
  ghDir: string
): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn(['bun', BIN], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, PATH: `${ghDir}:${process.env.PATH}`, ...env }
  })
  const exitCode = await proc.exited
  const stderr = await new Response(proc.stderr).text()
  return { exitCode, stderr }
}

describe('check-body-bare-digits (bin) — Changesets release-PR exemption', () => {
  it('refuses bare digits on an ordinary branch — the check still works normally', async () => {
    const ghDir = fakeGh('github-actions[bot]')
    const { exitCode, stderr } = await runCheck(
      { PR_BODY: VIOLATING_BODY, BRANCH: 'task/some-tranche/1', PR_NUMBER: '1' },
      ghDir
    )
    expect(exitCode).toBe(1)
    expect(stderr).toContain('body-bare-digits')
  })

  it('is dormant when the LIVE-FETCHED author is the real bot, on the release branch', async () => {
    const ghDir = fakeGh('github-actions[bot]')
    const { exitCode, stderr } = await runCheck(
      { PR_BODY: VIOLATING_BODY, BRANCH: 'changeset-release/main', PR_NUMBER: '1' },
      ghDir
    )
    expect(exitCode).toBe(0)
    expect(stderr).toBe('')
  })

  it('does NOT exempt when the live-fetched author is not the bot, even on the release branch name', async () => {
    const ghDir = fakeGh('some-attacker')
    const { exitCode, stderr } = await runCheck(
      { PR_BODY: VIOLATING_BODY, BRANCH: 'changeset-release/main', PR_NUMBER: '1' },
      ghDir
    )
    expect(exitCode).toBe(1)
    expect(stderr).toContain('body-bare-digits')
  })

  it('a PR_AUTHOR env var is NOT trusted — the exact hole round 2 would have reopened on a required gate', async () => {
    // The fake `gh` reports the REAL (non-bot) author; a hardcoded PR_AUTHOR
    // env var claiming the bot's identity must not matter — this bin never
    // reads that variable at all.
    const ghDir = fakeGh('some-attacker')
    const { exitCode } = await runCheck(
      {
        PR_BODY: VIOLATING_BODY,
        BRANCH: 'changeset-release/main',
        PR_NUMBER: '1',
        PR_AUTHOR: 'github-actions[bot]'
      },
      ghDir
    )
    expect(exitCode).toBe(1)
  })

  it('does NOT exempt when PR_NUMBER is unset — no PR to fetch an author for', async () => {
    const ghDir = fakeGh('github-actions[bot]')
    const env = { PR_BODY: VIOLATING_BODY, BRANCH: 'changeset-release/main', PR_NUMBER: undefined }
    const { exitCode, stderr } = await runCheck(env, ghDir)
    expect(exitCode).toBe(1)
    expect(stderr).toContain('body-bare-digits')
  })

  it('still runs when BRANCH is unset — the skip is a specific match, not "any missing branch"', async () => {
    const ghDir = fakeGh('github-actions[bot]')
    const env = { PR_BODY: VIOLATING_BODY, BRANCH: undefined, PR_NUMBER: '1' }
    const { exitCode, stderr } = await runCheck(env, ghDir)
    expect(exitCode).toBe(1)
    expect(stderr).toContain('body-bare-digits')
  })
})

// Round 2's fix passed every test above and still didn't work in real CI:
// PR_NUMBER wasn't declared in the registry's env allowlist, so the runner
// silently stripped it before the check ever ran — the exemption never
// fired, and code review found it by reading the registry, not by running
// anything. The tests above spawn the bin directly with a hand-built env,
// bypassing the runner's own filtering entirely — proving the bin's logic
// is correct, never proving the declared env actually reaches it. This
// block closes that gap: same fixtures, but through the REAL runChecks +
// coreCheckRegistry() path, so a future missing-declaration regression
// fails a test instead of shipping silently broken again.
describe('check-body-bare-digits — through the REAL runner, not a direct spawn', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  function spec() {
    const found = coreCheckRegistry().find((s) => s.name === 'body-bare-digits')
    if (!found) throw new Error('coreCheckRegistry() no longer registers "body-bare-digits"')
    return found
  }

  it('PR_NUMBER and BRANCH both actually reach the check through runChecks’ own env allowlist', async () => {
    const ghDir = fakeGh('github-actions[bot]')
    process.env.PATH = `${ghDir}:${process.env.PATH}`
    process.env.PR_BODY = VIOLATING_BODY
    process.env.BRANCH = 'changeset-release/main'
    process.env.PR_NUMBER = '1'

    const [outcome] = await runChecks([spec()], {
      parallel: 1,
      diffOnly: false,
      changedFiles: null,
      defaultTimeoutMs: 10_000
    })

    // If PR_NUMBER (or BRANCH) were silently stripped by a missing registry
    // declaration, this would come back 'fail' — the exemption never fires
    // without both actually reaching the child process.
    expect(outcome?.status).toBe('pass')
    expect(outcome?.exitCode).toBe(0)
  })

  it('the SAME violating body, ordinary branch, through the real runner — still refused', async () => {
    const ghDir = fakeGh('github-actions[bot]')
    process.env.PATH = `${ghDir}:${process.env.PATH}`
    process.env.PR_BODY = VIOLATING_BODY
    process.env.BRANCH = 'task/some-tranche/1'
    process.env.PR_NUMBER = '1'

    const [outcome] = await runChecks([spec()], {
      parallel: 1,
      diffOnly: false,
      changedFiles: null,
      defaultTimeoutMs: 10_000
    })

    expect(outcome?.status).toBe('fail')
  })
})
