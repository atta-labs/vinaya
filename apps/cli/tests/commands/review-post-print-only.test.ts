import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'bun:test'

// `vinaya review post --print-only` (task 6, #397): renders and
// self-verifies the comment, exactly like a real post, but never calls `gh
// pr comment` — closing atta-labs/vinaya#184 (a reviewer guessed this flag
// existed, and the old command silently posted the verdict anyway). The
// `gh` stub below FAILS `pr comment` outright: if `--print-only` ever
// reaches a post, the test fails on that stub's stderr, not merely on a
// missing assertion.

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX = join(CLI_ROOT, 'src', 'index.ts')
const HEAD = 'b'.repeat(40)

type CliResult = { status: number; stdout: string; stderr: string }

function runCli(args: string[], cwd: string, env: Record<string, string | undefined>): CliResult {
  try {
    const stdout = execFileSync('bun', [INDEX, ...args], {
      cwd,
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
 * Answers `pr view --json headRefName`, `pr view --json headRefOid`,
 * `pr view --json comments` (empty — round one, no prior verdict to
 * reconcile against) and `pr view --json body` (`Closes #1` — below
 * `OBJECTIVES_SINCE_ISSUE`, so `resolveObjectivesForPr` resolves `skip` and
 * neither an `Objectives version:` line nor an `OBJECTIVES:` block renders);
 * `pr comment` exits non-zero with a distinctive stderr line, so a stray
 * real post is loud, never silent.
 *
 * `resolveHeadSha` resolves the branch name first, then its true head via
 * `git ls-remote` — which fails outright here (`cwd` is a plain tempdir,
 * not a git repo) — falling back to `gh api .../git/ref/heads/<branch>`,
 * answered below with the same `headSha`.
 */
function stubGhNoPost(headSha: string): { dir: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), 'fake-gh-print-only-'))
  const gh = join(dir, 'gh')
  writeFileSync(
    gh,
    `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  case "$*" in
    *headRefName*) echo "stub-branch"; exit 0 ;;
    *headRefOid*) echo "${headSha}"; exit 0 ;;
    *comments*) echo '{"comments": []}'; exit 0 ;;
    *body*) echo "Closes #1"; exit 0 ;;
  esac
fi
if [ "$1" = "api" ]; then
  case "$*" in
    *git/ref/heads/stub-branch*) echo "${headSha}"; exit 0 ;;
  esac
fi
if [ "$1" = "pr" ] && [ "$2" = "comment" ]; then
  echo "gh stub: pr comment reached — --print-only must never post" >&2
  exit 1
fi
exit 1
`
  )
  chmodSync(gh, 0o755)
  return { dir, env: { PATH: `${dir}:${process.env.PATH ?? ''}` } }
}

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

describe('vinaya review post --print-only (task 6, #397)', () => {
  it('renders a clean APPROVE, self-checks it, prints it, and posts nothing', () => {
    const cwd = tempDir('review-post-print-only-')
    const { dir, env } = stubGhNoPost(HEAD)
    const findingsFile = join(cwd, 'findings.txt')
    writeFileSync(findingsFile, '')
    try {
      const r = runCli(
        [
          'review',
          'post',
          '--print-only',
          '--role',
          'code-reviewer',
          '--pr',
          '1',
          '--verdict',
          'APPROVE',
          '--findings-file',
          findingsFile,
          '--brief-conformance',
          'x',
          '--spec-conformance',
          'x',
          '--scope',
          'x',
          '--tests',
          'x',
          '--docs',
          'x',
          '--task-id',
          'fix',
          '--model',
          'x',
          '--tokens-in',
          '-',
          '--tokens-out',
          '-',
          '--cost',
          '-'
        ],
        cwd,
        env
      )
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('VERDICT: APPROVE')
      expect(r.stdout).not.toContain('Posted:')
      expect(r.stderr).not.toContain('must never post')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('--json emits {posted:false, printOnly:true} rather than a url', () => {
    const cwd = tempDir('review-post-print-only-json-')
    const { dir, env } = stubGhNoPost(HEAD)
    const findingsFile = join(cwd, 'findings.txt')
    writeFileSync(findingsFile, '')
    try {
      const r = runCli(
        [
          'review',
          'post',
          '--print-only',
          '--json',
          '--role',
          'security',
          '--pr',
          '1',
          '--verdict',
          'PASS',
          '--findings-file',
          findingsFile,
          '--config-scan',
          'not-applicable',
          '--secrets',
          'x',
          '--task-id',
          'fix',
          '--model',
          'x',
          '--tokens-in',
          '-',
          '--tokens-out',
          '-',
          '--cost',
          '-'
        ],
        cwd,
        env
      )
      expect(r.status).toBe(0)
      // A trust-anchor-read warning (unrelated to --print-only; the stub
      // leaves `gh api repos/.../contents/...` unhandled on purpose) can
      // precede the JSON on stdout — parse from the envelope's own opening
      // brace, not the whole stream.
      const parsed = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')))
      expect(parsed.data.posted).toBe(false)
      expect(parsed.data.printOnly).toBe(true)
      expect(parsed.data.url).toBeUndefined()
      expect(r.stderr).not.toContain('must never post')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a missing required flag refuses --print-only the same as a real post — before any forge contact', () => {
    const cwd = tempDir('review-post-print-only-missing-flag-')
    const { dir, env } = stubGhNoPost(HEAD)
    const findingsFile = join(cwd, 'findings.txt')
    writeFileSync(findingsFile, '')
    try {
      const r = runCli(
        [
          'review',
          'post',
          '--print-only',
          '--role',
          'code-reviewer',
          '--pr',
          '1',
          '--verdict',
          'APPROVE',
          '--findings-file',
          findingsFile,
          // --brief-conformance deliberately omitted
          '--spec-conformance',
          'x',
          '--scope',
          'x',
          '--tests',
          'x',
          '--docs',
          'x',
          '--task-id',
          'fix',
          '--model',
          'x',
          '--tokens-in',
          '-',
          '--tokens-out',
          '-',
          '--cost',
          '-'
        ],
        cwd,
        env
      )
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('--brief-conformance')
      expect(r.stderr).not.toContain('must never post')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is a recognized flag — no longer refused as unknown', () => {
    const cwd = tempDir('review-post-print-only-known-flag-')
    const r = runCli(['review', 'post', '--print-only', '--role', 'bogus', '--pr', '1'], cwd, {})
    // Refused for an unrelated reason (bad --role), never "unrecognised flag".
    expect(r.stderr).not.toContain('unrecognised flag')
    expect(r.stderr).not.toContain('--print-only')
  })
})
