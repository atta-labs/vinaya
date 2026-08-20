import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'

// Bin-level tests proving check-review-gate.ts's Changesets-release
// exemption reads the PR author from a live `gh pr view` fetch, never from
// an env var — the exact class of hole "three rounds of the same bug"
// (review-gate.ts's own module comment on `principals`) documents, and
// the one the first version of this exemption would have reopened (security
// review, PR #165): a `pull_request`-triggered workflow runs the PR's own
// copy of its YAML, so any env var this check trusted could be a hardcoded
// literal an attacker's own workflow file chose to set.

const BIN = join(import.meta.dir, '..', '..', 'src', 'checks', 'bin', 'check-review-gate.ts')
const HEAD = 'a'.repeat(40)

let dirs: string[] = []

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

/** A fake `gh` on PATH: `gh pr view` returns the given author; anything else (the waiver timeline fetch) returns empty. */
function fakeGh(author: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'review-gate-fake-gh-'))
  dirs.push(dir)
  const ghDir = join(dir, 'fakebin')
  mkdirSync(ghDir, { recursive: true })
  const authorJson = author === null ? 'null' : `{"login":${JSON.stringify(author)}}`
  const payload = JSON.stringify({
    number: 1,
    comments: [],
    labels: [],
    headRefOid: HEAD,
    author: JSON.parse(authorJson)
  })
  writeFileSync(
    join(ghDir, 'gh'),
    `#!/bin/sh\ncase "$*" in\n  "pr view "*) echo '${payload}' ;;\n  *) echo '[]' ;;\nesac\n`
  )
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

describe('check-review-gate (bin) — Changesets release-PR exemption', () => {
  it('is dormant when the LIVE-FETCHED author is the real bot, on the release branch', async () => {
    const ghDir = fakeGh('github-actions[bot]')
    const { exitCode, stderr } = await runCheck({ BRANCH: 'changeset-release/main', PR_NUMBER: '1' }, ghDir)
    expect(exitCode).toBe(0)
    expect(stderr).toBe('')
  })

  it('does NOT exempt when the live-fetched author is not the bot, even on the release branch name', async () => {
    const ghDir = fakeGh('some-attacker')
    const { exitCode } = await runCheck({ BRANCH: 'changeset-release/main', PR_NUMBER: '1' }, ghDir)
    // Falls through to the real gate — fails without a clean verdict/waiver present.
    expect(exitCode).toBe(1)
  })

  it('a PR_AUTHOR env var is NOT trusted — the exact hole a naive fix would reopen', async () => {
    // The fake `gh` reports the REAL (non-bot) author; an attacker's own
    // workflow YAML setting PR_AUTHOR to the bot's name as a hardcoded
    // literal must not matter, because this check never reads that env var.
    const ghDir = fakeGh('some-attacker')
    const { exitCode } = await runCheck(
      { BRANCH: 'changeset-release/main', PR_NUMBER: '1', PR_AUTHOR: 'github-actions[bot]' },
      ghDir
    )
    expect(exitCode).toBe(1)
  })
})
