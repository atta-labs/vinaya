import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { coreCheckRegistry } from '../../src/checks/registry'
import { runChecks } from '../../src/checks/runner'

// Bin-level tests for check-body-bare-digits.ts's Changesets-release
// exemption. This check is `ownWorkflow: true` (own-workflow.test.ts) and
// reachable in production ONLY from vinaya-body-checks.yml's
// pull_request_target job — never from vinaya-checks.yml's pull_request job,
// which cannot safely resolve this exemption (round 5, security review, PR
// #165: PR_NUMBER/BRANCH are PR-editable on that trigger, letting an
// attacker redirect the fetch to any already-approved PR). Both branch AND
// author now come from ONE live `gh pr view` fetch — no BRANCH env var is
// read at all, unlike the reverted round-3/4 version.

const BIN = join(import.meta.dir, '..', '..', 'src', 'checks', 'bin', 'check-body-bare-digits.ts')

const VIOLATING_BODY = '## Releases\n\n## @attalabs/vinaya@0.17.1\n\n- 0ee0056: Add a thing\n'

let dirs: string[] = []

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

/**
 * A fake `gh` on PATH: `gh pr view` returns the given headRefName/author in
 * one JSON payload (the new fetch shape — no separate BRANCH env). The
 * trust-anchor `gh api .../contents/vinaya.config.json --jq .content` call
 * returns `releaseActor`'s base64 content when given, else an empty config
 * (falls back to `DEFAULT_RELEASE_ACTOR`, same as a fresh adopter).
 */
function fakeGh(branch: string | null, author: string | null, releaseActor?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bare-digits-fake-gh-'))
  dirs.push(dir)
  const ghDir = join(dir, 'fakebin')
  mkdirSync(ghDir, { recursive: true })
  const authorJson = author === null ? 'null' : `{"login":${JSON.stringify(author)}}`
  const payload = JSON.stringify({ number: 1, headRefName: branch ?? '', author: JSON.parse(authorJson) })
  const configBase64 = Buffer.from(JSON.stringify(releaseActor ? { releaseActor } : {})).toString('base64')
  writeFileSync(
    join(ghDir, 'gh'),
    `#!/bin/sh\ncase "$*" in\n  "pr view "*) echo '${payload}' ;;\n  "api "*"contents/vinaya.config.json"*) echo '${configBase64}' ;;\n  *) echo '[]' ;;\nesac\n`
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

describe('check-body-bare-digits (bin) — Changesets release-PR exemption', () => {
  it('refuses bare digits on an ordinary branch — the check still works normally', async () => {
    const ghDir = fakeGh('task/some-tranche/1', 'github-actions[bot]')
    const { exitCode, stderr } = await runCheck({ PR_BODY: VIOLATING_BODY, PR_NUMBER: '1' }, ghDir)
    expect(exitCode).toBe(1)
    expect(stderr).toContain('body-bare-digits')
  })

  it('is dormant when the LIVE-FETCHED branch and author are the real release PR shape', async () => {
    const ghDir = fakeGh('changeset-release/main', 'github-actions[bot]')
    const { exitCode, stderr } = await runCheck({ PR_BODY: VIOLATING_BODY, PR_NUMBER: '1' }, ghDir)
    expect(exitCode).toBe(0)
    expect(stderr).toBe('')
  })

  it('does NOT exempt when the live-fetched author is not the bot, even on the release branch name', async () => {
    const ghDir = fakeGh('changeset-release/main', 'some-attacker')
    const { exitCode, stderr } = await runCheck({ PR_BODY: VIOLATING_BODY, PR_NUMBER: '1' }, ghDir)
    expect(exitCode).toBe(1)
    expect(stderr).toContain('body-bare-digits')
  })

  it('does NOT exempt on branch name alone — live-fetched branch differs from release branch', async () => {
    const ghDir = fakeGh('some-other-branch', 'github-actions[bot]')
    const { exitCode, stderr } = await runCheck({ PR_BODY: VIOLATING_BODY, PR_NUMBER: '1' }, ghDir)
    expect(exitCode).toBe(1)
    expect(stderr).toContain('body-bare-digits')
  })

  it('does NOT exempt when PR_NUMBER is unset — no PR to fetch branch/author for', async () => {
    const ghDir = fakeGh('changeset-release/main', 'github-actions[bot]')
    const env = { PR_BODY: VIOLATING_BODY, PR_NUMBER: undefined }
    const { exitCode, stderr } = await runCheck(env, ghDir)
    expect(exitCode).toBe(1)
    expect(stderr).toContain('body-bare-digits')
  })

  it('a PR_AUTHOR/BRANCH env var is NOT trusted — both come from the live fetch only, never env', async () => {
    // The fake `gh` reports the REAL (non-release) shape; env vars claiming
    // otherwise must not matter — this bin never reads either from env.
    const ghDir = fakeGh('some-other-branch', 'some-attacker')
    const { exitCode } = await runCheck(
      {
        PR_BODY: VIOLATING_BODY,
        PR_NUMBER: '1',
        BRANCH: 'changeset-release/main',
        PR_AUTHOR: 'github-actions[bot]'
      },
      ghDir
    )
    expect(exitCode).toBe(1)
  })
})

// Round 4's finding (code review, PR #165): a hardcoded expected author
// never matches a repo whose real release PRs are opened by a custom
// release-token owner. These prove the configurable `releaseActor` field
// closes that gap, now safely, from the trusted fetch path only.
describe('check-body-bare-digits — configurable release actor', () => {
  it('exempts on a CONFIGURED non-bot author — the real production shape (a custom release-token owner)', async () => {
    const ghDir = fakeGh('changeset-release/main', 'daniboomerang', 'daniboomerang')
    const { exitCode, stderr } = await runCheck({ PR_BODY: VIOLATING_BODY, PR_NUMBER: '1' }, ghDir)
    expect(exitCode).toBe(0)
    expect(stderr).toBe('')
  })

  it('a real non-bot release author with NO releaseActor configured stays blocked — falls back to the stock default', async () => {
    const ghDir = fakeGh('changeset-release/main', 'daniboomerang')
    const { exitCode, stderr } = await runCheck({ PR_BODY: VIOLATING_BODY, PR_NUMBER: '1' }, ghDir)
    expect(exitCode).toBe(1)
    expect(stderr).toContain('body-bare-digits')
  })

  it('a configured releaseActor does NOT exempt a DIFFERENT author — still two-factor, not author-value-agnostic', async () => {
    const ghDir = fakeGh('changeset-release/main', 'some-attacker', 'daniboomerang')
    const { exitCode, stderr } = await runCheck({ PR_BODY: VIOLATING_BODY, PR_NUMBER: '1' }, ghDir)
    expect(exitCode).toBe(1)
    expect(stderr).toContain('body-bare-digits')
  })
})

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

  it("PR_NUMBER actually reaches the check through runChecks' own env allowlist, and the exemption fires", async () => {
    const ghDir = fakeGh('changeset-release/main', 'github-actions[bot]')
    process.env.PATH = `${ghDir}:${process.env.PATH}`
    process.env.PR_BODY = VIOLATING_BODY
    process.env.PR_NUMBER = '1'

    const [outcome] = await runChecks([spec()], {
      parallel: 1,
      diffOnly: false,
      changedFiles: null,
      defaultTimeoutMs: 10_000
    })

    expect(outcome?.status).toBe('pass')
    expect(outcome?.exitCode).toBe(0)
  })

  it('the SAME violating body, ordinary branch, through the real runner — still refused', async () => {
    const ghDir = fakeGh('task/some-tranche/1', 'github-actions[bot]')
    process.env.PATH = `${ghDir}:${process.env.PATH}`
    process.env.PR_BODY = VIOLATING_BODY
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
