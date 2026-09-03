import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'bun:test'

/**
 * `vinaya pr refreeze <n> --reason <text>` (task 12, #387) end to end,
 * against a `gh` stub on `PATH` — the same discipline
 * `check-test-plan-identity.test.ts`/`review-status.test.ts` use, since
 * `pr refreeze` shells to `gh api user`, `gh pr view`, and `gh pr comment`
 * directly. The trust-anchor read (`gh api repos/.../contents/...`) is left
 * UNHANDLED by the stub on purpose — it fails, `loadTrustAnchorConfig`
 * catches that and returns `null`, and `resolvePrincipalAllowlist(null)`
 * falls back to the hardcoded `PRINCIPAL_ALLOWLIST` (`['daniboomerang']`),
 * which is the identity these tests exercise against.
 */

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

function runCli(args: string[], env: Record<string, string | undefined>): CliResult {
  try {
    const stdout = execFileSync('bun', [INDEX, ...args], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env }
    })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
  }
}

/**
 * A `gh` stub answering `api user` with `login`, `pr view <n> --json body`
 * with `body`, and recording every `pr comment` invocation's `--body-file`
 * content to `commentsLog` for the test to inspect afterward. Everything
 * else (the trust-anchor read) exits non-zero.
 */
function stubGh(login: string, body: string): { path: Record<string, string>; commentsLogPath: string } {
  const dir = tempDir('pr-refreeze-stub-')
  const commentsLogPath = join(dir, 'comments.log')
  writeFileSync(commentsLogPath, '')
  const gh = join(dir, 'gh')
  writeFileSync(
    gh,
    `#!/bin/sh
if [ "$1" = "api" ] && [ "$2" = "user" ]; then
  echo "${login}"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  cat <<'JSON'
{"body": ${JSON.stringify(body)}}
JSON
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "comment" ]; then
  # args: pr comment <n> --body-file <path>
  bodyFile="$5"
  echo "PR:$3" >> "${commentsLogPath}"
  cat "$bodyFile" >> "${commentsLogPath}"
  echo "---" >> "${commentsLogPath}"
  exit 0
fi
exit 1
`
  )
  chmodSync(gh, 0o755)
  return { path: { PATH: `${dir}:${process.env.PATH ?? ''}` }, commentsLogPath }
}

const BASE_BODY = ['## Summary', '', 'Touches aeg-core and cli.', '', '## Scope', '', '**Tier:** 1'].join('\n')

describe('vinaya pr refreeze', () => {
  it('refuses with usage when no PR number is given', () => {
    const r = runCli(['pr', 'refreeze'], {})
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('Usage: vinaya pr refreeze')
  })

  it('refuses with usage when --reason is missing', () => {
    const r = runCli(['pr', 'refreeze', '42'], {})
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('--reason')
  })

  it('refuses when the running gh identity is not on the principal allowlist', () => {
    const { path } = stubGh('an-attacker', BASE_BODY)
    const r = runCli(['pr', 'refreeze', '42', '--reason', 'fix a typo'], path)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('not on the principal allowlist')
  })

  it('posts a fresh aeg:body-hash marker and the reason when the identity is allowlisted', () => {
    const { path, commentsLogPath } = stubGh('daniboomerang', BASE_BODY)
    const r = runCli(['pr', 'refreeze', '42', '--reason', 'fix a wrong Tier'], path)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Refroze PR 42')
    const posted = readFileSync(commentsLogPath, 'utf8')
    expect(posted).toContain('PR:42')
    expect(posted).toMatch(/<!-- aeg:body-hash:[0-9a-f]{64} -->/)
    expect(posted).toContain('fix a wrong Tier')
  })
})
