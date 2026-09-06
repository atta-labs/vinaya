import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `vinaya log flush` end to end (task 2, Issue #405), against a `gh` stub on
 * `PATH` — the same discipline `pr-create-brief-comment.test.ts` and
 * `milestone.test.ts` use. `HOME` is pointed at a scratch dir so the outbox
 * lives under a throwaway `~/.vinaya/outbox/`, and the CLI's `cwd` is a real
 * (but unpushed) git repo with an `origin` remote, so `resolveRepo()`
 * resolves the same `owner-repo` directory name the sink itself would use.
 */

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX = join(CLI_ROOT, 'src', 'index.ts')
const OWNER_REPO_DIR = 'test-owner-test-repo'

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

function initGitRepo(cwd: string): void {
  execFileSync('git', ['init', '--quiet'], { cwd })
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:test-owner/test-repo.git'], { cwd })
}

function outboxPath(home: string, issue: number | 'none'): string {
  return join(home, '.vinaya', 'outbox', OWNER_REPO_DIR, `${issue}.ndjson`)
}

function seedOutbox(home: string, issue: number, lines: string[]): string {
  const p = outboxPath(home, issue)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, `${lines.join('\n')}\n`)
  return p
}

function ndjsonLine(runId: string, seq: number, issue: number): string {
  return JSON.stringify({
    meta: {
      schema: 1,
      ts: '2026-09-06T00:00:00.000Z',
      run_id: runId,
      seq,
      repo: null,
      vinaya: '0.0.0',
      doctrine: 'unknown',
      host: 'cli',
      machine: 'deadbeef'
    },
    subject: { issue, role: 'developer' },
    kind: 'forge_write',
    event: 'validated',
    payload: {},
    op: 'issue.comment',
    target: { issue }
  })
}

/**
 * A `gh` stub handling `issue comment <n> --body-file <f>`, `pr comment <n>
 * --body-file <f>`, and `pr view <n> --json body`. Every posted body is
 * appended to `bodiesLogPath`, chunk-separated, so a test can inspect the
 * exact marker/fence a temp file carried before this command deletes it.
 * `failFlagPath`, when the file exists, makes every comment call fail.
 */
function stubGh(opts: { prBody?: string; failFlagPath?: string }): {
  env: Record<string, string>
  bodiesLogPath: string
  callsLogPath: string
  failFlagPath: string
} {
  const dir = tempDir('log-flush-gh-')
  const bodiesLogPath = join(dir, 'bodies.log')
  const callsLogPath = join(dir, 'calls.log')
  const counterPath = join(dir, 'counter')
  const prBodyPath = join(dir, 'pr-body.json')
  const failFlagPath = opts.failFlagPath ?? join(dir, 'FAIL')
  writeFileSync(bodiesLogPath, '')
  writeFileSync(callsLogPath, '')
  writeFileSync(counterPath, '0')
  writeFileSync(prBodyPath, JSON.stringify({ body: opts.prBody ?? '' }))
  const gh = join(dir, 'gh')
  writeFileSync(
    gh,
    `#!/bin/sh
echo "$@" >> "${callsLogPath}"
if [ -f "${failFlagPath}" ] && { [ "$1$2" = "issuecomment" ] || [ "$1$2" = "prcomment" ]; }; then
  echo "simulated gh failure: rate limited" >&2
  exit 1
fi
if [ "$1" = "issue" ] && [ "$2" = "comment" ]; then
  n=$3
  bodyFile="$5"
  echo "----CHUNK----" >> "${bodiesLogPath}"
  cat "$bodyFile" >> "${bodiesLogPath}"
  c=$(( $(cat "${counterPath}") + 1 ))
  echo "$c" > "${counterPath}"
  echo "https://github.com/test-owner/test-repo/issues/$n#issuecomment-900$c"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "comment" ]; then
  n=$3
  bodyFile="$5"
  echo "----CHUNK----" >> "${bodiesLogPath}"
  cat "$bodyFile" >> "${bodiesLogPath}"
  c=$(( $(cat "${counterPath}") + 1 ))
  echo "$c" > "${counterPath}"
  echo "https://github.com/test-owner/test-repo/pull/$n#issuecomment-900$c"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  cat "${prBodyPath}"
  exit 0
fi
echo "unhandled gh: $*" >&2
exit 1
`
  )
  chmodSync(gh, 0o755)
  return { env: { PATH: `${dir}:${process.env.PATH ?? ''}` }, bodiesLogPath, callsLogPath, failFlagPath }
}

function chunksOf(bodiesLog: string): string[] {
  return bodiesLog
    .split('----CHUNK----\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

describe('vinaya log flush --issue', () => {
  it('splits an outbox with two interleaved run_ids into contiguous-per-run chunks with exact marker lines, and leaves only its own validated/written lines behind', () => {
    const cwd = tempDir('log-flush-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-flush-home-')
    const gh = stubGh({})

    seedOutbox(home, 555, [
      ndjsonLine('rA', 0, 555),
      ndjsonLine('rA', 1, 555),
      ndjsonLine('rB', 0, 555),
      ndjsonLine('rA', 2, 555)
    ])

    const r = runCli(['log', 'flush', '--issue', '555'], cwd, { HOME: home, ...gh.env })

    expect(r.status).toBe(0)

    const chunks = chunksOf(readFileSync(gh.bodiesLogPath, 'utf8'))
    expect(chunks.length).toBe(3)
    expect(chunks[0]).toContain('<!-- aeg:log:rA:0-1 -->')
    expect(chunks[1]).toContain('<!-- aeg:log:rB:0-0 -->')
    expect(chunks[2]).toContain('<!-- aeg:log:rA:2-2 -->')
    // Never a range spanning the gap the interleaved rB line opened.
    expect(chunks.join('\n')).not.toContain('aeg:log:rA:0-2')

    const remaining = readFileSync(outboxPath(home, 555), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    expect(remaining.length).toBe(2)
    expect(remaining[0].event).toBe('validated')
    expect(remaining[1].event).toBe('written')
    expect(remaining[1].comment_ids.length).toBe(3)
    expect(remaining[1].target).toEqual({ issue: 555 })
  })

  it('a gh failure leaves every original line in place, appends validated/refused, and exits 2', () => {
    const cwd = tempDir('log-flush-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-flush-home-')
    const failFlag = join(tempDir('log-flush-flag-'), 'FAIL')
    writeFileSync(failFlag, '1')
    const gh = stubGh({ failFlagPath: failFlag })

    const original = [ndjsonLine('rC', 0, 777), ndjsonLine('rC', 1, 777)]
    seedOutbox(home, 777, original)

    const r = runCli(['log', 'flush', '--issue', '777'], cwd, { HOME: home, ...gh.env })

    expect(r.status).toBe(2)
    const finding = JSON.parse(r.stderr.trim().split('\n')[0] as string)
    expect(finding.check).toBe('log-flush-gh-failed')
    expect(finding.message).toContain('rate limited')

    const lines = readFileSync(outboxPath(home, 777), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    expect(lines.length).toBe(4)
    expect(lines[0]).toEqual(JSON.parse(original[0] as string))
    expect(lines[1]).toEqual(JSON.parse(original[1] as string))
    expect(lines[2].event).toBe('validated')
    expect(lines[3].event).toBe('refused')
    expect(lines[3].reason).toContain('rate limited')
  })

  it('a zero-line (missing) outbox is a clean no-op', () => {
    const cwd = tempDir('log-flush-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-flush-home-')
    const gh = stubGh({})

    const r = runCli(['log', 'flush', '--issue', '999'], cwd, { HOME: home, ...gh.env })

    expect(r.status).toBe(0)
    expect(r.stdout).toContain('nothing to flush')
  })

  it('refuses when both --issue and --pr are given', () => {
    const cwd = tempDir('log-flush-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-flush-home-')
    const gh = stubGh({})

    const r = runCli(['log', 'flush', '--issue', '1', '--pr', '1'], cwd, { HOME: home, ...gh.env })

    expect(r.status).toBe(2)
    expect(r.stderr).toContain('exactly one of --issue or --pr')
  })

  it('refuses when neither --issue nor --pr is given', () => {
    const cwd = tempDir('log-flush-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-flush-home-')
    const gh = stubGh({})

    const r = runCli(['log', 'flush'], cwd, { HOME: home, ...gh.env })

    expect(r.status).toBe(2)
    expect(r.stderr).toContain('exactly one of --issue or --pr')
  })
})

describe('vinaya log flush --pr', () => {
  it("resolves the Issue through a stubbed `gh pr view`'s Closes #N, flushes that Issue's outbox, and posts on the PR", () => {
    const cwd = tempDir('log-flush-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-flush-home-')
    const gh = stubGh({ prBody: 'Closes #888\n\n## Summary\n\nSomething.' })

    seedOutbox(home, 888, [ndjsonLine('rD', 0, 888)])

    const r = runCli(['log', 'flush', '--pr', '42'], cwd, { HOME: home, ...gh.env })

    expect(r.status).toBe(0)
    const calls = readFileSync(gh.callsLogPath, 'utf8')
    expect(calls).toContain('pr view 42')
    expect(calls).toContain('pr comment 42')
    expect(calls).not.toContain('issue comment')

    const remaining = readFileSync(outboxPath(home, 888), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    expect(remaining[remaining.length - 1].event).toBe('written')
    expect(remaining[remaining.length - 1].target).toEqual({ pr: 42 })
  })

  it('refuses with a check error naming the missing line when the PR body carries no Closes #N', () => {
    const cwd = tempDir('log-flush-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-flush-home-')
    const gh = stubGh({ prBody: 'No closing reference here.' })

    const r = runCli(['log', 'flush', '--pr', '42'], cwd, { HOME: home, ...gh.env })

    expect(r.status).toBe(2)
    const finding = JSON.parse(r.stderr.trim().split('\n')[0] as string)
    expect(finding.check).toBe('log-flush-pr-closes-n')
    expect(finding.message).toContain('Closes #N')
  })
})

describe('vinaya log flush — defeat cases', () => {
  it('refuses a single outbox line larger than the comment limit, naming its seq, and never splits it', () => {
    const cwd = tempDir('log-flush-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-flush-home-')
    const gh = stubGh({})

    const big = 'x'.repeat(70_000)
    const huge = JSON.stringify({
      meta: {
        schema: 1,
        ts: '2026-09-06T00:00:00.000Z',
        run_id: 'rE',
        seq: 0,
        repo: null,
        vinaya: '0.0.0',
        doctrine: 'unknown',
        host: 'cli',
        machine: 'deadbeef'
      },
      subject: { issue: 321, role: 'developer' },
      kind: 'forge_write',
      event: 'refused',
      payload: {},
      op: 'issue.comment',
      target: { issue: 321 },
      reason: big
    })
    seedOutbox(home, 321, [huge])

    const r = runCli(['log', 'flush', '--issue', '321'], cwd, { HOME: home, ...gh.env })

    expect(r.status).toBe(2)
    const finding = JSON.parse(r.stderr.trim().split('\n')[0] as string)
    expect(finding.check).toBe('log-flush-line-too-large')
    expect(finding.message).toContain('seq 0')

    // Untouched — refused before any post was attempted.
    expect(readFileSync(outboxPath(home, 321), 'utf8')).toBe(`${huge}\n`)
    expect(readFileSync(gh.callsLogPath, 'utf8')).toBe('')
  })

  it('a symlinked outbox is refused the same way the sink refuses to write one', () => {
    const cwd = tempDir('log-flush-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-flush-home-')
    const gh = stubGh({})

    const p = outboxPath(home, 654)
    mkdirSync(dirname(p), { recursive: true })
    const evilTarget = join(tempDir('log-flush-evil-'), 'evil')
    writeFileSync(evilTarget, 'not an outbox')
    execFileSync('ln', ['-s', evilTarget, p])

    const r = runCli(['log', 'flush', '--issue', '654'], cwd, { HOME: home, ...gh.env })

    expect(r.status).toBe(2)
    const finding = JSON.parse(r.stderr.trim().split('\n')[0] as string)
    expect(finding.check).toBe('log-flush-symlink')
  })
})
