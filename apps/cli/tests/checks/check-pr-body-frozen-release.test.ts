import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'bun:test'

/**
 * The release-branch exemption is TWO factors, not one. A branch name is
 * contributor-controlled metadata — anyone able to push may name a branch
 * `changeset-release/main` — so a branch-only test would hand that PR a
 * standing licence to edit its own frozen body. These two cases are the
 * same body, the same comments and the same branch, differing only in who
 * opened the PR.
 */

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'checks', 'bin', 'check-pr-body-frozen.ts')

const RELEASE_BRANCH = 'changeset-release/main'
const RELEASE_ACTOR = 'github-actions[bot]'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * A `gh` stub serving this check's two calls: the `pr view` payload, and the
 * trust-anchor `api` read that resolves the configured release actor. The
 * anchor read returns empty, so `resolveReleaseActor` falls through to
 * `DEFAULT_RELEASE_ACTOR` — the real default path, not a fixture-only one.
 */
function stubPath(author: string): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'frozen-release-'))
  tempDirs.push(dir)
  const payload = JSON.stringify({
    body: '## Summary\n\nA release.\n',
    comments: [],
    headRefName: RELEASE_BRANCH,
    author: { login: author }
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

function run(author: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('bun', [BIN], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // A PR number at or above the rollout cutoff, so a missing marker
      // comment is a real `fail` rather than the grandfathered `info`.
      env: { ...process.env, PR_NUMBER: '395', ...stubPath(author) }
    })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
  }
}

describe('pr-body-frozen — the release-branch exemption is branch AND actor', () => {
  it('exempts the configured release actor on that branch — info, exit 0', () => {
    const result = run(RELEASE_ACTOR)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('is the Changesets release PR')
    expect(result.stdout).toContain('opened by the configured release actor')
  })

  it('does NOT exempt a different author on the same branch with the same body — it fails', () => {
    const result = run('drive-by-contributor')
    expect(result.status).toBe(1)
    expect(result.stdout).not.toContain('is the Changesets release PR')
    expect(result.stderr).toContain('pr-body-frozen')
  })
})
