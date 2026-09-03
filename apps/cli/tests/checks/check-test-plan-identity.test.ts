import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'bun:test'

/**
 * `PR_NUMBER` and `PR_BODY` are two independent env vars, and nothing
 * upstream guarantees they describe the same pull request. These two cases
 * are the identical ticked body and the identical round comment, differing
 * only in whether the PR the comment was fetched from is the PR that body
 * belongs to.
 */

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'checks', 'bin', 'check-test-plan.ts')

const TICKED_BODY = ['## Test Plan', '', '- [x] **[agent]** `bun run test` → green.'].join('\n')
const ROUND_COMMENT = 'Head: abc1234\n\n<!-- aeg:developer:round-1 -->\n\nAll green.'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A `gh` stub whose `pr view` returns `servedBody` plus one allowlisted round comment. */
function stubPath(servedBody: string): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'test-plan-identity-'))
  tempDirs.push(dir)
  const payload = JSON.stringify({
    body: servedBody,
    comments: [{ body: ROUND_COMMENT, author: { login: 'daniboomerang' } }]
  })
  const gh = join(dir, 'gh')
  writeFileSync(
    gh,
    `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  cat <<'JSON'
${payload}
JSON
  exit 0
fi
if [ "$1" = "api" ]; then
  exit 1
fi
echo "gh stub: unhandled: $*" >&2
exit 1
`
  )
  chmodSync(gh, 0o755)
  return { PATH: `${dir}:${process.env.PATH ?? ''}` }
}

function run(servedBody: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('bun', [BIN], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PR_NUMBER: '395',
        PR_BODY: TICKED_BODY,
        BRANCH: 'task/review-convergence-v1/8',
        ...stubPath(servedBody)
      }
    })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
  }
}

describe('test-plan — the round comment must belong to the PR whose body is graded', () => {
  it('counts the round comment when the fetched PR is the one PR_BODY came from', () => {
    // Ticks and anchored regions are normalised away by `authoredRegion`, so
    // an untidy tick difference between the two reads is not a mismatch.
    const result = run(TICKED_BODY.replace('- [x]', '- [ ]'))
    expect(result.status).toBe(0)
  })

  it('treats the count as zero, and says why, when the fetched PR is a different one', () => {
    const result = run('## Test Plan\n\n- [x] **[agent]** some other PR entirely.\n')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('does not match the PR_BODY this check was given')
    expect(result.stderr).toContain('describe different pull requests')
    // Still the `pending` class: the tick is unbacked FOR THIS BODY.
    expect(result.stderr).toContain('"pending":true')
  })
})
