import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSyncBudgeted, stripVinayaEnv } from '../lib/process-fixture'

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

// Issue #660, O3 — this process's own VINAYA_* environment is stripped
// before the fixture's own `env` is applied, so the spawned `vinaya log
// flush` can only ever resolve its runtime directory from the isolated
// $HOME below; bounded by an explicit budget that throws with the child's
// own captured stdout/stderr on expiry, rather than a bare timeout.
function runCli(args: string[], cwd: string, env: Record<string, string | undefined>): CliResult {
  return spawnSyncBudgeted(
    'bun',
    [INDEX, ...args],
    { encoding: 'utf8', cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...stripVinayaEnv(), ...env } },
    undefined,
    'vinaya log flush'
  )
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
 * A plain string existing-comment defaults to `daniboomerang` — this repo's
 * hardcoded `PRINCIPAL_ALLOWLIST` fallback (`loadTrustAnchorConfig` returns
 * `null` here: the stub has no `gh api repos/.../contents/vinaya.config.json`
 * handler, an unhandled call the loader's own catch turns into that
 * fallback) — so the existing "already posted" idempotency test keeps
 * exercising a TRUSTED marker without change. Pass `{ body, author }`
 * explicitly (e.g. `author: 'someone-else'`) to exercise an UNTRUSTED one.
 */
type ExistingComment = string | { body: string; author: string | null }

/**
 * A `gh` stub handling `issue comment <n> --body-file <f>`, `pr comment <n>
 * --body-file <f>`, and `pr view <n> --json body`. Every posted body is
 * appended to `bodiesLogPath`, chunk-separated, so a test can inspect the
 * exact marker/fence a temp file carried before this command deletes it.
 * `failFlagPath`, when the file exists, makes every comment call fail.
 * `failAfterNComments` makes the (N+1)th comment call (across issue/pr
 * comment combined) fail while every call up to and including the Nth
 * succeeds — the "chunk 1 succeeds, chunk 2 fails" story.
 */

function stubGh(opts: {
  prBody?: string
  failFlagPath?: string
  failAfterNComments?: number
  existingComments?: ExistingComment[]
}): {
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
  const failAfterN = opts.failAfterNComments ?? -1
  writeFileSync(bodiesLogPath, '')
  writeFileSync(callsLogPath, '')
  writeFileSync(counterPath, '0')
  const comments = (opts.existingComments ?? []).map((c) => {
    const { body, author } = typeof c === 'string' ? { body: c, author: 'daniboomerang' } : c
    return { body, author: author === null ? null : { login: author } }
  })
  // Both `--json body` (issueFromPr) and `--json comments` (the idempotency
  // read) read this same object; extra keys are harmless to either reader.
  writeFileSync(prBodyPath, JSON.stringify({ body: opts.prBody ?? '', comments }))
  const gh = join(dir, 'gh')
  writeFileSync(
    gh,
    `#!/bin/sh
echo "$@" >> "${callsLogPath}"
if [ "$1$2" = "issuecomment" ] || [ "$1$2" = "prcomment" ]; then
  if [ -f "${failFlagPath}" ]; then
    echo "simulated gh failure: rate limited" >&2
    exit 1
  fi
  next=$(( $(cat "${counterPath}") + 1 ))
  if [ ${failAfterN} -ge 0 ] && [ "$next" -gt ${failAfterN} ]; then
    echo "simulated gh failure: rate limited" >&2
    exit 1
  fi
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  cat "${prBodyPath}"
  exit 0
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

  it('gh succeeds on chunk 1 and fails on chunk 2: chunk 1 is truncated, chunk 2 remains, refused names the failing range (code review BLOCKER 3, PR #439)', () => {
    const cwd = tempDir('log-flush-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-flush-home-')
    const gh = stubGh({ failAfterNComments: 1 })

    const original = [ndjsonLine('rX', 0, 111), ndjsonLine('rY', 0, 111)]
    seedOutbox(home, 111, original)

    const r = runCli(['log', 'flush', '--issue', '111'], cwd, { HOME: home, ...gh.env })

    expect(r.status).toBe(2)
    const finding = JSON.parse(r.stderr.trim().split('\n')[0] as string)
    expect(finding.check).toBe('log-flush-gh-failed')
    expect(finding.message).toContain('rY')

    const chunks = chunksOf(readFileSync(gh.bodiesLogPath, 'utf8'))
    expect(chunks.length).toBe(1)
    expect(chunks[0]).toContain('<!-- aeg:log:rX:0-0 -->')

    const lines = readFileSync(outboxPath(home, 111), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    // Chunk 1 (rX) truncated away; chunk 2 (rY) — never confirmed posted — remains, plus the audit trail.
    expect(lines[0]).toEqual(JSON.parse(original[1] as string))
    expect(lines[1].event).toBe('validated')
    expect(lines[2].event).toBe('refused')
    expect(lines[2].reason).toContain('rY')
  })

  it("a seq gap inside chunk 1 (log-sink.ts's synchronous seq++ can consume a seq with no line ever written) never drops chunk 2's line when chunk 2 fails to post (code review MAJOR, round 2, Issue #562)", () => {
    const cwd = tempDir('log-flush-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-flush-home-')
    const gh = stubGh({ failAfterNComments: 1 })

    // Chunk 1 (run rG) covers only 2 PHYSICAL lines (seq 0 and seq 2 — seq 1
    // was consumed by the sink's seq++ but its line never landed) — its
    // seqTo-seqFrom span is 3, one more than its true line count. Chunk 2
    // (run rZ) is a single, unrelated line that fails to post. A
    // `seqTo - seqFrom + 1`-based line count would overcount chunk 1 by one
    // and truncate chunk 2's never-posted line right along with it.
    const original = [ndjsonLine('rG', 0, 112), ndjsonLine('rG', 2, 112), ndjsonLine('rZ', 0, 112)]
    seedOutbox(home, 112, original)

    const r = runCli(['log', 'flush', '--issue', '112'], cwd, { HOME: home, ...gh.env })

    expect(r.status).toBe(2)
    const finding = JSON.parse(r.stderr.trim().split('\n')[0] as string)
    expect(finding.check).toBe('log-flush-gh-failed')
    expect(finding.message).toContain('rZ')

    const chunks = chunksOf(readFileSync(gh.bodiesLogPath, 'utf8'))
    expect(chunks.length).toBe(1)
    expect(chunks[0]).toContain('<!-- aeg:log:rG:0-2 -->')

    const lines = readFileSync(outboxPath(home, 112), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    // Chunk 1 (rG, both lines) truncated away; chunk 2 (rZ) — never
    // confirmed posted — survives, exactly, plus the audit trail. A
    // seq-based miscount would have silently dropped it here.
    expect(lines[0]).toEqual(JSON.parse(original[2] as string))
    expect(lines[1].event).toBe('validated')
    expect(lines[2].event).toBe('refused')
    expect(lines[2].reason).toContain('rZ')
  })

  it('refuses a corrupt outbox line (fails full schema re-validation) without posting or truncating anything (security review MEDIUM 2, PR #439)', () => {
    const cwd = tempDir('log-flush-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-flush-home-')
    const gh = stubGh({})

    const corrupt = JSON.stringify({ meta: { schema: 1, run_id: 'rF', seq: 0 }, kind: 'forge_write' })
    seedOutbox(home, 222, [corrupt])

    const r = runCli(['log', 'flush', '--issue', '222'], cwd, { HOME: home, ...gh.env })

    expect(r.status).toBe(2)
    const finding = JSON.parse(r.stderr.trim().split('\n')[0] as string)
    expect(finding.check).toBe('log-flush-corrupt-line')

    expect(readFileSync(outboxPath(home, 222), 'utf8')).toBe(`${corrupt}\n`)
    expect(readFileSync(gh.callsLogPath, 'utf8')).toBe('')
  })

  it('re-redacts an outbox line before posting, even one that was never redacted on disk (second check-moment, security review MEDIUM 2, PR #439)', () => {
    const cwd = tempDir('log-flush-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-flush-home-')
    const gh = stubGh({})

    const secret = `ghp_${'a'.repeat(36)}`
    const unredacted = JSON.stringify({
      meta: {
        schema: 1,
        ts: '2026-09-06T00:00:00.000Z',
        run_id: 'rG',
        seq: 0,
        repo: null,
        vinaya: '0.0.0',
        doctrine: 'unknown',
        host: 'cli',
        machine: 'deadbeef'
      },
      subject: { issue: 333, role: 'developer' },
      kind: 'forge_write',
      event: 'refused',
      payload: {},
      op: 'issue.comment',
      target: { issue: 333 },
      reason: `gh: authentication failed for token ${secret}`
    })
    seedOutbox(home, 333, [unredacted])

    const r = runCli(['log', 'flush', '--issue', '333'], cwd, { HOME: home, ...gh.env })

    expect(r.status).toBe(0)
    const posted = readFileSync(gh.bodiesLogPath, 'utf8')
    expect(posted).not.toContain(secret)
    expect(posted).toContain('<redacted>')
  })
})

describe('vinaya log flush — idempotency across a lost acknowledgement (task-log-v1 task 2, #562, O2)', () => {
  it('a chunk whose marker already exists on the forge is acknowledged (truncated), never re-posted', () => {
    const cwd = tempDir('log-flush-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-flush-home-')
    // A prior attempt posted this chunk, then died before truncating: its
    // marker is already on the Issue.
    const gh = stubGh({ existingComments: ['<!-- aeg:log:rH:0-0 -->\n\n```ndjson\n{}\n```'] })

    seedOutbox(home, 444, [ndjsonLine('rH', 0, 444)])

    const r = runCli(['log', 'flush', '--issue', '444'], cwd, { HOME: home, ...gh.env })

    expect(r.status).toBe(0)
    // No comment was posted — the already-accepted chunk was skipped.
    const calls = readFileSync(gh.callsLogPath, 'utf8')
    expect(calls).toContain('issue view 444')
    expect(calls).not.toContain('issue comment')
    // Nothing was posted to the bodies log either.
    expect(readFileSync(gh.bodiesLogPath, 'utf8').trim()).toBe('')

    // The already-accepted original line was truncated; only this run's own
    // validated/written audit lines remain.
    const remaining = readFileSync(outboxPath(home, 444), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    expect(remaining.map((l) => l.event)).toEqual(['validated', 'written'])
    expect(remaining[remaining.length - 1].comment_ids).toEqual([])
  })

  it('a marker posted by a NON-principal is never trusted — the chunk is posted anyway, not silently truncated (security review, round 2)', () => {
    const cwd = tempDir('log-flush-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-flush-home-')
    // Anyone who can comment on the target can read a past chunk's plaintext
    // run_id and forge its own `<!-- aeg:log:... -->` marker for the next
    // unposted range. Only a marker from an allowlisted principal may be
    // trusted as proof of a real prior post.
    const gh = stubGh({
      existingComments: [{ body: '<!-- aeg:log:rH:0-0 -->\n\n```ndjson\n{}\n```', author: 'someone-else' }]
    })

    seedOutbox(home, 445, [ndjsonLine('rH', 0, 445)])

    const r = runCli(['log', 'flush', '--issue', '445'], cwd, { HOME: home, ...gh.env })

    expect(r.status).toBe(0)
    // The forged marker was ignored — the chunk was posted for real, not
    // skipped as if it had already landed.
    const calls = readFileSync(gh.callsLogPath, 'utf8')
    expect(calls).toContain('issue comment')
    const chunks = chunksOf(readFileSync(gh.bodiesLogPath, 'utf8'))
    expect(chunks.length).toBe(1)
    expect(chunks[0]).toContain('<!-- aeg:log:rH:0-0 -->')
  })
})

describe('tailHasOwnLine — the race-condition correlation (code review BLOCKER 2, PR #439)', () => {
  it("ignores a concurrent process's matching-shape line carrying a DIFFERENT run_id, and finds this call's own line once it lands", async () => {
    const { tailHasOwnLine } = await import('../../src/lib/log-flush')
    const home = tempDir('log-flush-race-')
    const path = join(home, 'outbox.ndjson')
    writeFileSync(path, '')
    const priorSize = 0
    const expected = { event: 'written' as const, op: 'issue.comment' as const, target: { issue: 1 } }

    const decoy = `${JSON.stringify({ meta: { run_id: 'concurrent-process-run-id' }, kind: 'forge_write', event: 'written', op: 'issue.comment', target: { issue: 1 } })}\n`
    writeFileSync(path, decoy, { flag: 'a' })
    expect(tailHasOwnLine(path, priorSize, 'my-own-run-id', expected)).toBe(false)

    const ownLine = `${JSON.stringify({ meta: { run_id: 'my-own-run-id' }, kind: 'forge_write', event: 'written', op: 'issue.comment', target: { issue: 1 } })}\n`
    writeFileSync(path, ownLine, { flag: 'a' })
    expect(tailHasOwnLine(path, priorSize, 'my-own-run-id', expected)).toBe(true)
  })
})
