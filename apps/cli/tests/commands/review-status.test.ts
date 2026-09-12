import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'bun:test'

/**
 * `vinaya review status <pr>` end-to-end, against a `gh` stub on `PATH`.
 *
 * The two lines this command prints are the whole contract — the state line
 * and, only when the branch is behind, the merge-first line — plus the exit
 * code a script gates on. Every case below asserts the actual printed text,
 * not a paraphrase of it.
 */

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX = join(CLI_ROOT, 'src', 'index.ts')
const HEAD = 'abc1234def5678901234567890abcdef12345678'
const OLD_HEAD = '9999999888888887777777766666665555555544'

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
      cwd: CLI_ROOT,
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
 * A `gh` + `git` pair on `PATH`, serving one canned `pr view` payload and one
 * canned `rev-list --count`. Stubbing `git` too is what makes the behind-main
 * line testable at all: the real repo's own distance from `origin/main` is
 * not a fact a unit test may depend on.
 */
function stubPath(pr: unknown, behind: number): Record<string, string> {
  const dir = tempDir('fake-forge-')
  const gh = join(dir, 'gh')
  writeFileSync(
    gh,
    `#!/bin/sh\nif [ "$1" = "pr" ] && [ "$2" = "view" ]; then\n  cat <<'JSON'\n${JSON.stringify(pr)}\nJSON\n  exit 0\nfi\necho "gh stub: unhandled: $*" >&2\nexit 1\n`
  )
  chmodSync(gh, 0o755)
  const git = join(dir, 'git')
  writeFileSync(git, `#!/bin/sh\nif [ "$1" = "rev-list" ]; then\n  echo ${behind}\n  exit 0\nfi\nexit 1\n`)
  chmodSync(git, 0o755)
  return { PATH: `${dir}:${process.env.PATH ?? ''}` }
}

/**
 * The command's own output lines, with the shared trust-anchor helper's
 * fallback warning dropped. `loadTrustAnchorConfig` writes that line to
 * stdout whenever it cannot resolve the repo identity — which a `gh` stub on
 * `PATH` never can — and it belongs to that helper, not to this command's
 * contract.
 */
function statusLines(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('⚠ could not read the trust-anchor config'))
}

function verdict(head: string, findings: string[] = [], value = 'REQUEST CHANGES'): string {
  return [`VERDICT: ${value}`, '', `Judged head: ${head}`, '', 'FINDINGS:', ...findings].join('\n')
}

function principalComment(body: string) {
  return { body, author: { login: 'daniboomerang' } }
}

function roundComment(n: number): { body: string; author: { login: string } } {
  return principalComment(`Head: ${HEAD}\n\n<!-- aeg:developer:round-${n} -->\n\nAll green.`)
}

/**
 * A `gh` + `git` pair like `stubPath`, but also serving `gh api
 * repos/<repo>/contents/vinaya.config.json --jq .content` — the trust-anchor
 * read `resolveReviewPolicy` (O4, `#543`) is now sourced through — so a test
 * can prove `reviewPolicy.maxRounds` from repo config is actually honored,
 * not the module's own retired `MAX_ROUNDS = 3` constant. `GITHUB_REPOSITORY`
 * is set so `trustAnchorRepo()` never falls through to a real `git remote`
 * call.
 */
function stubPathWithConfig(pr: unknown, behind: number, config: unknown): Record<string, string> {
  const dir = tempDir('fake-forge-config-')
  const gh = join(dir, 'gh')
  const contentB64 = Buffer.from(JSON.stringify(config), 'utf-8').toString('base64')
  writeFileSync(
    gh,
    [
      '#!/bin/sh',
      'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then',
      "  cat <<'JSON'",
      JSON.stringify(pr),
      'JSON',
      '  exit 0',
      'fi',
      'if [ "$1" = "api" ]; then',
      `  echo '${contentB64}'`,
      '  exit 0',
      'fi',
      'echo "gh stub: unhandled: $*" >&2',
      'exit 1',
      ''
    ].join('\n')
  )
  chmodSync(gh, 0o755)
  const git = join(dir, 'git')
  writeFileSync(git, `#!/bin/sh\nif [ "$1" = "rev-list" ]; then\n  echo ${behind}\n  exit 0\nfi\nexit 1\n`)
  chmodSync(git, 0o755)
  return { PATH: `${dir}:${process.env.PATH ?? ''}`, GITHUB_REPOSITORY: 'acme/repo' }
}

describe('vinaya review status', () => {
  it('prints CONTINUE and no behind-main line, exit 0, when the loop is converging at head', () => {
    const env = stubPath(
      {
        comments: [principalComment(verdict(HEAD, ['1. [MAJOR] a.ts:1 — F1 correctness: x']))],
        headRefOid: HEAD,
        baseRefName: 'main'
      },
      0
    )
    const result = runCli(['review', 'status', '381'], env)
    expect(statusLines(result.stdout)).toEqual(['CONTINUE'])
    expect(result.stdout).not.toContain('behind main')
    expect(result.status).toBe(0)
  })

  it('prints the behind-main line and exits non-zero when the branch is behind its base', () => {
    const env = stubPath({ comments: [], headRefOid: HEAD, baseRefName: 'main' }, 4)
    const result = runCli(['review', 'status', '381'], env)
    expect(statusLines(result.stdout)).toEqual(['CONTINUE', 'behind main by 4 — merge first'])
    expect(result.status).toBe(1)
  })

  it('names the unknown distance rather than printing nothing, when git cannot measure it', () => {
    const dir = tempDir('fake-forge-nogit-')
    const gh = join(dir, 'gh')
    const pr = { comments: [], headRefOid: HEAD, baseRefName: 'main' }
    writeFileSync(
      gh,
      `#!/bin/sh\nif [ "$1" = "pr" ] && [ "$2" = "view" ]; then\n  cat <<'JSON'\n${JSON.stringify(pr)}\nJSON\n  exit 0\nfi\nexit 1\n`
    )
    chmodSync(gh, 0o755)
    // `git rev-list` fails here — an unfetched base, a shallow clone. The
    // distance is unknown, which is not the same fact as "not behind".
    const git = join(dir, 'git')
    writeFileSync(git, '#!/bin/sh\nexit 128\n')
    chmodSync(git, 0o755)
    const result = runCli(['review', 'status', '381'], { PATH: `${dir}:${process.env.PATH ?? ''}` })
    expect(statusLines(result.stdout)).toEqual(['CONTINUE', 'behind main: unknown — fetch origin/main first'])
    expect(result.status).toBe(1)
  })

  it('prints PAUSE with the reason and the finding id, exit non-zero', () => {
    const env = stubPath(
      {
        comments: [
          principalComment(verdict(OLD_HEAD, ['1. [MAJOR] a.ts:1 — F1 correctness resolved: x'])),
          principalComment(`Head: ${HEAD}\n\n<!-- aeg:developer:round-1 -->`),
          principalComment(verdict(HEAD, ['1. [MAJOR] a.ts:1 — F1 correctness reproduced: x']))
        ],
        headRefOid: HEAD,
        baseRefName: 'main'
      },
      0
    )
    const result = runCli(['review', 'status', '381'], env)
    expect(statusLines(result.stdout)).toEqual(['PAUSE: reappearance F1'])
    expect(result.status).toBe(1)
  })

  it('prints the push-after-verdict fact when the newest verdict judged a superseded head with no answer since', () => {
    const env = stubPath(
      {
        comments: [principalComment(verdict(OLD_HEAD, ['1. [MAJOR] a.ts:1 — F1 correctness: x']))],
        headRefOid: HEAD,
        baseRefName: 'main'
      },
      0
    )
    const result = runCli(['review', 'status', '381'], env)
    expect(statusLines(result.stdout)).toEqual(['push after verdict — re-review required'])
    expect(result.status).toBe(1)
  })

  it('refuses with usage, exit 2, when no PR number is given', () => {
    const result = runCli(['review', 'status'], stubPath({}, 0))
    expect(result.stderr).toContain('Usage: vinaya review status <pr-number>')
    expect(result.status).toBe(2)
  })

  it('reads reviewPolicy.maxRounds from repo config instead of a hardcoded cap (#543 O4)', () => {
    const threeRoundHistory = [
      principalComment(verdict('1111111', ['1. [MAJOR] a.ts:1 — F1 correctness: x'])),
      roundComment(1),
      principalComment(
        verdict('2222222', ['1. [MAJOR] a.ts:1 — F1 correctness resolved: x', '2. [MAJOR] a.ts:2 — F2 correctness: y'])
      ),
      roundComment(2),
      principalComment(verdict(HEAD, ['2. [MAJOR] a.ts:2 — F2 correctness resolved: y']))
    ]
    const pr = { comments: threeRoundHistory, headRefOid: HEAD, baseRefName: 'main' }

    // No config on the default branch (the `gh` stub 404s the `api` call
    // exactly like `stubPath`'s does): the default `DEFAULT_MAX_ROUNDS` of 3
    // applies, and a 3-round history PAUSEs.
    const defaultResult = runCli(['review', 'status', '381'], stubPath(pr, 0))
    expect(statusLines(defaultResult.stdout)).toEqual(['PAUSE: max-rounds'])
    expect(defaultResult.status).toBe(1)

    // The SAME 3-round history, with repo config raising `reviewPolicy.maxRounds`
    // to 5: the loop has not reached the configured cap, so it CONTINUEs —
    // proving this command reads the resolved policy, not a retired constant.
    const configuredResult = runCli(
      ['review', 'status', '381'],
      stubPathWithConfig(pr, 0, { reviewPolicy: { maxRounds: 5 } })
    )
    expect(statusLines(configuredResult.stdout)).toEqual(['CONTINUE'])
    expect(configuredResult.status).toBe(0)
  })

  it('refuses with exit 2 — never a status line — when `gh pr view` cannot answer', () => {
    const dir = tempDir('fake-gh-broken-')
    const gh = join(dir, 'gh')
    writeFileSync(gh, '#!/bin/sh\necho "gh: unreachable (test stub)" >&2\nexit 1\n')
    chmodSync(gh, 0o755)
    const result = runCli(['review', 'status', '381'], { PATH: `${dir}:${process.env.PATH ?? ''}` })
    expect(result.stdout).not.toContain('CONTINUE')
    expect(result.stderr).toContain('Could not read PR #381')
    expect(result.status).toBe(2)
  })
})
