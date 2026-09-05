import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'bun:test'

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

function runCli(args: string[], cwd: string, env: Record<string, string | undefined>): CliResult {
  try {
    const stdout = execFileSync('bun', [INDEX, ...args], {
      encoding: 'utf8',
      cwd,
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
 * A `gh` stub answering `pr view <n> --json comments` from a fixture JSON
 * file (never inline-echoed — avoids shell-quoting a JSON string) and
 * `pr comment <n> --body-file <path>` by appending the posted body to a log,
 * one entry per call, then printing `commentUrl`.
 */
function stubGh(
  commentsJson: unknown,
  commentUrl: string,
  login = 'daniboomerang'
): { path: Record<string, string>; commentsLogPath: string } {
  const dir = tempDir('pr-rule-stub-')
  const commentsJsonPath = join(dir, 'comments.json')
  const commentsLogPath = join(dir, 'posted.log')
  writeFileSync(commentsJsonPath, JSON.stringify(commentsJson))
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
  cat "${commentsJsonPath}"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "comment" ]; then
  bodyFile="$5"
  echo "PR:$3" >> "${commentsLogPath}"
  cat "$bodyFile" >> "${commentsLogPath}"
  echo "---" >> "${commentsLogPath}"
  echo "${commentUrl}"
  exit 0
fi
exit 1
`
  )
  chmodSync(gh, 0o755)
  return { path: { PATH: `${dir}:${process.env.PATH ?? ''}` }, commentsLogPath }
}

function writeFixture(dir: string, name: string, content: string): string {
  const p = join(dir, name)
  writeFileSync(p, content)
  return p
}

describe('vinaya pr rule', () => {
  it('requires --file', () => {
    const repo = tempDir('pr-rule-repo-')
    const r = runCli(['pr', 'rule', '1'], repo, {})
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('--file')
  })

  it('refuses a file whose first line is a plain VERDICT — nothing posted', () => {
    const repo = tempDir('pr-rule-repo-')
    const filePath = writeFixture(repo, 'ruling.md', 'VERDICT: APPROVE\n\nSome ruling text.\n')
    const { path, commentsLogPath } = stubGh({ comments: [] }, 'https://github.com/acme/widget/pull/1#issuecomment-1')

    const r = runCli(['pr', 'rule', '1', '--file', filePath], repo, path)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('verdict')
    expect(readFileSync(commentsLogPath, 'utf-8')).toBe('')
  })

  it('refuses a bolded VERDICT line — the extractor tolerates emphasis', () => {
    const repo = tempDir('pr-rule-repo-')
    const filePath = writeFixture(repo, 'ruling.md', '**VERDICT: PASS**\n\nSecurity ruling text.\n')
    const { path, commentsLogPath } = stubGh({ comments: [] }, 'https://github.com/acme/widget/pull/1#issuecomment-1')

    const r = runCli(['pr', 'rule', '1', '--file', filePath], repo, path)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('verdict')
    expect(readFileSync(commentsLogPath, 'utf-8')).toBe('')
  })

  it('refuses a VERDICT line on line 9 only — still a whole-body candidate', () => {
    const repo = tempDir('pr-rule-repo-')
    const lines = ['Ruling preamble.', '', 'More context.', '', 'Still more.', '', 'And more.', '', 'VERDICT: APPROVE']
    const filePath = writeFixture(repo, 'ruling.md', `${lines.join('\n')}\n`)
    const { path, commentsLogPath } = stubGh({ comments: [] }, 'https://github.com/acme/widget/pull/1#issuecomment-1')

    const r = runCli(['pr', 'rule', '1', '--file', filePath], repo, path)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('verdict')
    expect(readFileSync(commentsLogPath, 'utf-8')).toBe('')
  })

  it('allows a blockquoted VERDICT mention — the extractor ignores it, and the gate does too', () => {
    const repo = tempDir('pr-rule-repo-')
    const filePath = writeFixture(
      repo,
      'ruling.md',
      'The reviewer wrote:\n\n> VERDICT: PASS\n\nThe Principal overrules that reading for reason X.\n'
    )
    const { path, commentsLogPath } = stubGh({ comments: [] }, 'https://github.com/acme/widget/pull/1#issuecomment-1')

    const r = runCli(['pr', 'rule', '1', '--file', filePath], repo, path)
    expect(r.status).toBe(0)
    // `.trim()` alone isn't enough: an unresolvable trust-anchor repo (no git
    // remote in this tempDir) prints its own warning line to stdout first.
    expect(r.stdout.trim().split('\n').pop()).toBe('https://github.com/acme/widget/pull/1#issuecomment-1')
    const posted = readFileSync(commentsLogPath, 'utf-8')
    expect(posted).toContain('<!-- aeg:principal:ruling:1-1 -->')
    expect(posted).toContain('> VERDICT: PASS')
  })

  it('refuses a first line reading as an escalation', () => {
    const repo = tempDir('pr-rule-repo-')
    const filePath = writeFixture(repo, 'ruling.md', 'ESCALATE: severity: strategy\n\nSomething is contested.\n')
    const { path, commentsLogPath } = stubGh({ comments: [] }, 'https://github.com/acme/widget/pull/1#issuecomment-1')

    const r = runCli(['pr', 'rule', '1', '--file', filePath], repo, path)
    expect(r.status).toBe(1)
    expect(readFileSync(commentsLogPath, 'utf-8')).toBe('')
  })

  it('numbers the marker from existing ruling comments on the forge, never a local counter', () => {
    const repo = tempDir('pr-rule-repo-')
    const filePath = writeFixture(repo, 'ruling.md', 'The scope changes to include the migration script.\n')
    const { path, commentsLogPath } = stubGh(
      { comments: [{ body: '<!-- aeg:principal:ruling:1-1 -->\nEarlier ruling.\n' }, { body: 'unrelated comment' }] },
      'https://github.com/acme/widget/pull/1#issuecomment-9'
    )

    const r = runCli(['pr', 'rule', '1', '--file', filePath], repo, path)
    expect(r.status).toBe(0)
    const posted = readFileSync(commentsLogPath, 'utf-8')
    expect(posted).toContain('<!-- aeg:principal:ruling:1-2 -->')
  })

  it('refuses a non-numeric PR ref before ever checking who is authenticated', () => {
    const repo = tempDir('pr-rule-repo-')
    const filePath = writeFixture(repo, 'ruling.md', 'Scope clarified.\n')
    // No gh on PATH at all — a working `gh` should never be reached for a
    // malformed ref; format is validated purely from argv first.
    const r = runCli(['pr', 'rule', 'https://github.com/acme/widget/pull/1', '--file', filePath], repo, {})
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('bare PR number')
  })

  it('refuses when the authenticated actor is not an allowlisted principal — nothing posted', () => {
    const repo = tempDir('pr-rule-repo-')
    const filePath = writeFixture(repo, 'ruling.md', 'Scope clarified.\n')
    const { path, commentsLogPath } = stubGh(
      { comments: [] },
      'https://github.com/acme/widget/pull/1#issuecomment-1',
      'some-random-collaborator'
    )

    const r = runCli(['pr', 'rule', '1', '--file', filePath], repo, path)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('Principal-only')
    expect(readFileSync(commentsLogPath, 'utf-8')).toBe('')
  })
})
