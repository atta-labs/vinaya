import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `vinaya log collect-artifact` end to end — the trusted collector's own half. Same `gh`-stub-on-PATH
 * discipline as `log-flush.test.ts`, since this command's success path
 * ends by calling the SAME `flushOutbox` that command already exercises;
 * what these tests prove is the layer in FRONT of it: a downloaded
 * artifact is validated (schema, size, redaction, repo provenance) before
 * a single byte of it ever reaches `flushOutbox`/`gh`.
 */

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const INDEX = join(CLI_ROOT, 'src', 'index.ts')
const REPO = 'test-owner/test-repo'

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

function metaV1(runId: string, seq: number, repo: string | null = REPO): Record<string, unknown> {
  return {
    schema: 1,
    ts: '2026-09-15T00:00:00.000Z',
    run_id: runId,
    seq,
    repo,
    vinaya: '0.0.0',
    doctrine: 'unknown',
    host: 'ci',
    machine: 'deadbeef'
  }
}

function gateChecked(meta: Record<string, unknown>, issue: number | null): Record<string, unknown> {
  return {
    meta,
    subject: { issue, role: 'developer' },
    kind: 'gate',
    event: 'checked',
    payload: {},
    check: 'typecheck',
    check_version: null,
    policy_version: null,
    input_fingerprint: null,
    outcome: 'pass'
  }
}

function writeArtifact(dir: string, lines: unknown[]): string {
  const p = join(dir, 'artifact.ndjson')
  writeFileSync(p, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)
  return p
}

/** A `gh` stub handling `pr view <n> --json body` and `pr comment <n> --body-file <f>` — the two calls `collectTaskLogArtifact`'s success path makes through `flushOutbox`. */
function stubGh(opts: { prBody?: string; existingComments?: Array<{ body: string; author: string | null }> }): {
  env: Record<string, string>
  bodiesLogPath: string
  callsLogPath: string
} {
  const dir = tempDir('log-collect-gh-')
  const bodiesLogPath = join(dir, 'bodies.log')
  const callsLogPath = join(dir, 'calls.log')
  const prBodyPath = join(dir, 'pr-body.json')
  writeFileSync(bodiesLogPath, '')
  writeFileSync(callsLogPath, '')
  // `--json comments` shapes each comment's author as `{ login }`, never a
  // bare string — the same normalization `log-flush.test.ts`'s own stub
  // applies, load-bearing here since `existingLogMarkers` reads
  // `comment.author?.login`.
  const comments = (opts.existingComments ?? []).map((c) => ({
    body: c.body,
    author: c.author === null ? null : { login: c.author }
  }))
  writeFileSync(prBodyPath, JSON.stringify({ body: opts.prBody ?? '', comments }))
  const gh = join(dir, 'gh')
  writeFileSync(
    gh,
    `#!/bin/sh
echo "$@" >> "${callsLogPath}"
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  cat "${prBodyPath}"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "comment" ]; then
  n=$3
  bodyFile="$5"
  echo "----CHUNK----" >> "${bodiesLogPath}"
  cat "$bodyFile" >> "${bodiesLogPath}"
  echo "https://github.com/test-owner/test-repo/pull/$n#issuecomment-9001"
  exit 0
fi
echo "unhandled gh: $*" >&2
exit 1
`
  )
  chmodSync(gh, 0o755)
  return { env: { PATH: `${dir}:${process.env.PATH ?? ''}` }, bodiesLogPath, callsLogPath }
}

function chunksOf(bodiesLog: string): string[] {
  return bodiesLog
    .split('----CHUNK----\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

describe('vinaya log collect-artifact — missing/unreadable artifact', () => {
  it('a missing artifact file is a clean no-op — nothing to validate, gh never invoked', () => {
    const cwd = tempDir('log-collect-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-collect-home-')
    const gh = stubGh({})
    const missing = join(tempDir('log-collect-missing-'), 'does-not-exist.ndjson')

    const r = runCli(['log', 'collect-artifact', missing, '--pr', '10', '--repo', REPO], cwd, { HOME: home, ...gh.env })

    expect(r.status).toBe(0)
    expect(r.stdout).toContain('could not read artifact')
    expect(readFileSync(gh.callsLogPath, 'utf8').trim()).toBe('')
  })
})

describe('vinaya log collect-artifact — malicious/forged artifact rejected (O2)', () => {
  it('an artifact declaring a different repo (a forged/mismatched provenance claim) is entirely rejected — no chunk published, gh never posts', () => {
    const cwd = tempDir('log-collect-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-collect-home-')
    const gh = stubGh({ prBody: 'Closes #564' })
    const dir = tempDir('log-collect-artifact-')
    const artifact = writeArtifact(dir, [gateChecked(metaV1('r1', 0, 'someone-else/fork'), 564)])

    const r = runCli(['log', 'collect-artifact', artifact, '--pr', '10', '--repo', REPO], cwd, {
      HOME: home,
      ...gh.env
    })

    expect(r.status).toBe(0)
    expect(r.stdout).toContain('published 0 chunk(s), 1 gap(s)')
    expect(r.stdout).toContain('provenance mismatch')
    // The comment-posting half of gh is never reached — nothing valid to
    // publish, so `flushOutbox` never even opens the local outbox.
    const calls = readFileSync(gh.callsLogPath, 'utf8')
    expect(calls).not.toContain('pr comment')
  })

  it("an artifact that is not valid JSON at all — a malicious contributor's own executable-shaped content — is a gap, never executed, never posted", () => {
    const cwd = tempDir('log-collect-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-collect-home-')
    const gh = stubGh({ prBody: 'Closes #564' })
    const dir = tempDir('log-collect-artifact-')
    const artifact = join(dir, 'artifact.ndjson')
    writeFileSync(artifact, '#!/bin/sh\nrm -rf / --no-preserve-root\n')

    const r = runCli(['log', 'collect-artifact', artifact, '--pr', '10', '--repo', REPO], cwd, {
      HOME: home,
      ...gh.env
    })

    expect(r.status).toBe(0)
    expect(r.stdout).toContain('published 0 chunk(s)')
    expect(r.stdout).toContain('gap: invalid record')
    expect(readFileSync(gh.callsLogPath, 'utf8')).not.toContain('pr comment')
  })

  it('an oversized artifact is rejected whole, before any line is parsed', () => {
    const cwd = tempDir('log-collect-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-collect-home-')
    const gh = stubGh({ prBody: 'Closes #564' })
    const dir = tempDir('log-collect-artifact-')
    const artifact = join(dir, 'artifact.ndjson')
    writeFileSync(artifact, 'x'.repeat(9 * 1024 * 1024))

    const r = runCli(['log', 'collect-artifact', artifact, '--pr', '10', '--repo', REPO], cwd, {
      HOME: home,
      ...gh.env
    })

    expect(r.status).toBe(0)
    expect(r.stdout).toContain('artifact rejected for size')
    expect(readFileSync(gh.callsLogPath, 'utf8')).not.toContain('pr comment')
  })
})

describe('vinaya log collect-artifact — valid artifact publishes through the existing flushOutbox path', () => {
  it('a well-formed, correctly-provenanced artifact is validated then published via flushOutbox, reusing its chunking/marker machinery', () => {
    const cwd = tempDir('log-collect-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-collect-home-')
    const gh = stubGh({ prBody: 'Closes #564' })
    const dir = tempDir('log-collect-artifact-')
    const artifact = writeArtifact(dir, [gateChecked(metaV1('r1', 0), 564), gateChecked(metaV1('r1', 1), 564)])

    const r = runCli(['log', 'collect-artifact', artifact, '--pr', '10', '--repo', REPO], cwd, {
      HOME: home,
      ...gh.env
    })

    expect(r.status).toBe(0)
    expect(r.stdout).toContain('published 1 chunk(s), 0 gap(s)')
    const chunks = chunksOf(readFileSync(gh.bodiesLogPath, 'utf8'))
    expect(chunks.length).toBe(1)
    expect(chunks[0]).toContain('<!-- aeg:log:r1:0-1 -->')
  })

  it('a mixed artifact publishes the valid lines while reporting the invalid ones as gaps — never all-or-nothing', () => {
    const cwd = tempDir('log-collect-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-collect-home-')
    const gh = stubGh({ prBody: 'Closes #564' })
    const dir = tempDir('log-collect-artifact-')
    const p = join(dir, 'artifact.ndjson')
    writeFileSync(
      p,
      [
        JSON.stringify(gateChecked(metaV1('r1', 0), 564)),
        'not json',
        JSON.stringify(gateChecked(metaV1('r1', 1, 'fork/evil'), 564))
      ].join('\n')
    )

    const r = runCli(['log', 'collect-artifact', p, '--pr', '10', '--repo', REPO], cwd, { HOME: home, ...gh.env })

    expect(r.status).toBe(0)
    expect(r.stdout).toContain('published 1 chunk(s), 2 gap(s)')
    const chunks = chunksOf(readFileSync(gh.bodiesLogPath, 'utf8'))
    expect(chunks.length).toBe(1)
    expect(chunks[0]).toContain('<!-- aeg:log:r1:0-0 -->')
  })
})

describe('vinaya log collect-artifact — retry/dedup (O3)', () => {
  it('re-collecting the SAME artifact from a fresh runner (a real retry: a new ephemeral job, the same forge state) posts nothing new', () => {
    // Every real collector run starts on a FRESH GitHub Actions runner —
    // there is no local outbox carried over between separate job runs, only
    // whatever already landed on the forge. This test models that
    // faithfully: two separate `HOME`s (two separate ephemeral runners),
    // the same artifact, and — on the second run — the marker the first
    // run's real post already left on the forge.
    const artifact = writeArtifact(tempDir('log-collect-artifact-'), [gateChecked(metaV1('r1', 0), 564)])

    const cwd1 = tempDir('log-collect-cwd-')
    initGitRepo(cwd1)
    const home1 = tempDir('log-collect-home-')
    const gh1 = stubGh({ prBody: 'Closes #564' })
    const r1 = runCli(['log', 'collect-artifact', artifact, '--pr', '10', '--repo', REPO], cwd1, {
      HOME: home1,
      ...gh1.env
    })
    expect(r1.status).toBe(0)
    expect(r1.stdout).toContain('published 1 chunk(s), 0 gap(s)')

    // Simulated retry: a fresh runner (new cwd, new HOME), the SAME
    // artifact bytes, against a forge that already carries the marker
    // run 1's real post left — the exact shape `existingLogMarkers` reads.
    const cwd2 = tempDir('log-collect-cwd-')
    initGitRepo(cwd2)
    const home2 = tempDir('log-collect-home-')
    const gh2 = stubGh({
      prBody: 'Closes #564',
      existingComments: [{ body: '<!-- aeg:log:r1:0-0 -->\n\n```ndjson\n{}\n```\n', author: 'daniboomerang' }]
    })
    const r2 = runCli(['log', 'collect-artifact', artifact, '--pr', '10', '--repo', REPO], cwd2, {
      HOME: home2,
      ...gh2.env
    })

    expect(r2.status).toBe(0)
    expect(r2.stdout).toContain('published 0 chunk(s), 0 gap(s)')
    // Acknowledged (truncated), never re-posted — flushOutbox's own O2
    // idempotency, reused unmodified.
    expect(readFileSync(gh2.callsLogPath, 'utf8')).not.toContain('pr comment')
  })
})
