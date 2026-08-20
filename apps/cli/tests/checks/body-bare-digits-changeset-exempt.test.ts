import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'

// Bin-level tests, deliberately separate from body-bare-digits.test.ts (which
// exercises the pure checkBareDigits() logic only) — the Changesets-release
// skip lives in the bin's own main(), reading process.env.BRANCH directly,
// so it can only be proven by actually spawning the bin.

const BIN = join(import.meta.dir, '..', '..', 'src', 'checks', 'bin', 'check-body-bare-digits.ts')

const VIOLATING_BODY = '## Releases\n\n## @attalabs/vinaya@0.17.1\n\n- 0ee0056: Add a thing\n'

async function runCheck(env: Record<string, string | undefined>): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn(['bun', BIN], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env }
  })
  const exitCode = await proc.exited
  const stderr = await new Response(proc.stderr).text()
  return { exitCode, stderr }
}

describe('check-body-bare-digits (bin) — Changesets release-PR exemption', () => {
  it('refuses bare digits on an ordinary branch — the check still works normally', async () => {
    const { exitCode, stderr } = await runCheck({ PR_BODY: VIOLATING_BODY, BRANCH: 'task/some-tranche/1' })
    expect(exitCode).toBe(1)
    expect(stderr).toContain('body-bare-digits')
  })

  it('is dormant on the Changesets release branch — same violating body, exits 0', async () => {
    const { exitCode, stderr } = await runCheck({ PR_BODY: VIOLATING_BODY, BRANCH: 'changeset-release/main' })
    expect(exitCode).toBe(0)
    expect(stderr).toBe('')
  })

  it('still runs when BRANCH is unset — the skip is a specific match, not "any missing branch"', async () => {
    const env = { PR_BODY: VIOLATING_BODY, BRANCH: undefined }
    const { exitCode, stderr } = await runCheck(env)
    expect(exitCode).toBe(1)
    expect(stderr).toContain('body-bare-digits')
  })
})
