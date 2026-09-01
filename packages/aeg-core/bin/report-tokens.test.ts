import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hardenedMeteringDeps } from '../src/metering-io-guard'
import { main, parseArgs, resolveTranscriptPath, sanitizeKey, transcriptPointerPath } from './report-tokens'

describe('sanitizeKey / transcriptPointerPath', () => {
  it('replaces every run of non-alphanumeric characters with a single hyphen', () => {
    expect(sanitizeKey('/Users/dani/Work/Repositories/Me/attalabs')).toBe('-Users-dani-Work-Repositories-Me-attalabs')
  })

  it('squeezes a run of consecutive non-alphanumeric characters into one hyphen', () => {
    // Regression: a worktree path's `/.worktrees` segment is a `/` immediately
    // followed by a `.` — two separate non-alnum characters in a row. The
    // hook's original `tr -c 'A-Za-z0-9' '-'` mapped each individually
    // (producing `--worktrees`), diverging from this regex's single-hyphen
    // squeeze and silently breaking pointer-file lookup end to end
    // (confirmed live against a real worktree before the hook was fixed to
    // pipe through `tr -s '-'` too).
    expect(sanitizeKey('/repo/.worktrees/task/misc-hardening-v1/1')).toBe('-repo-worktrees-task-misc-hardening-v1-1')
  })

  it('builds distinct pointer paths for distinct worktree directories — never a collision', () => {
    const main = transcriptPointerPath('/repo', '/tmp')
    const worktree = transcriptPointerPath('/repo/.worktrees/task/misc-hardening-v1/1', '/tmp')
    expect(main).not.toBe(worktree)
  })
})

/**
 * `#315`: `sanitizeKey` alone collapses every run of non-alphanumeric
 * characters to one `-`, so any two paths of the shape `<prefix><non-alnum
 * run>a<non-alnum run>b` land on the identical `sanitizeKey` output —
 * `/a/b` and `/a-b` are just one instance of an unbounded family of
 * collisions, not a one-off. `transcriptPointerPath` now appends a full
 * SHA-256 digest of the untouched original value, so these tests check the
 * PATH function actually used to name pointer files, not `sanitizeKey` in
 * isolation (which is intentionally still collision-prone — see its own doc
 * comment).
 */
describe('transcriptPointerPath — collision resistance (#315)', () => {
  it("the Issue's exact example: /a/b and /a-b now produce distinct pointer paths", () => {
    const a = transcriptPointerPath('/a/b', '/tmp')
    const b = transcriptPointerPath('/a-b', '/tmp')
    expect(sanitizeKey('/a/b')).toBe(sanitizeKey('/a-b')) // sanity: still collides pre-digest
    expect(a).not.toBe(b)
  })

  it.each([
    ['/a/b', '/a_b'],
    ['/a/b', '/a..b'],
    ['/a/b', '//a/b']
  ])('%s and %s collide under sanitizeKey alone but produce distinct pointer paths', (x, y) => {
    expect(sanitizeKey(x)).toBe(sanitizeKey(y)) // sanity: these really do collide pre-digest
    expect(transcriptPointerPath(x, '/tmp')).not.toBe(transcriptPointerPath(y, '/tmp'))
  })
})

describe('resolveTranscriptPath — legacy pointer migration (#315)', () => {
  const NEW_POINTER = transcriptPointerPath('/repo', '/tmp')
  // The pre-#315 name: sanitizeKey alone, no digest — what a pointer already
  // on disk before this fix shipped (or written by a not-yet-upgraded
  // `track-transcript.sh`) is named.
  const LEGACY_POINTER = `/tmp/claude-transcript-${sanitizeKey('/repo')}.txt`

  const baseDeps = { env: { CLAUDE_PROJECT_DIR: '/repo', TMPDIR: '/tmp' }, cwd: '/repo' }

  it('finds and reads a pointer written under the OLD (legacy) name when the new one is absent — no orphaning', () => {
    const resolved = resolveTranscriptPath(undefined, {
      ...baseDeps,
      exists: (path) => path === LEGACY_POINTER,
      readFile: (path) => {
        if (path !== LEGACY_POINTER) throw new Error(`unexpected read: ${path}`)
        return 'session-legacy\t/home/user/.claude/projects/-repo/legacy.jsonl\n'
      }
    })
    expect(resolved).toBe('/home/user/.claude/projects/-repo/legacy.jsonl')
  })

  it('prefers the NEW (collision-resistant) pointer over the legacy one when both exist', () => {
    const files: Record<string, string> = {
      [NEW_POINTER]: 'session-new\t/new/transcript.jsonl\n',
      [LEGACY_POINTER]: 'session-old\t/legacy/transcript.jsonl\n'
    }
    const resolved = resolveTranscriptPath(undefined, {
      ...baseDeps,
      exists: (path) => path in files,
      readFile: (path) => files[path] as string
    })
    expect(resolved).toBe('/new/transcript.jsonl')
  })

  it('throws naming BOTH the new and legacy paths when neither pointer exists', () => {
    let message = ''
    try {
      resolveTranscriptPath(undefined, { ...baseDeps, exists: () => false, readFile: () => '' })
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain(NEW_POINTER)
    expect(message).toContain(LEGACY_POINTER)
  })
})

describe('parseArgs', () => {
  it('requires --phase and --role', () => {
    expect(() => parseArgs([])).toThrow(/Usage:/)
    expect(() => parseArgs(['--phase', '1: develop'])).toThrow(/Usage:/)
  })

  it('parses phase, role, model, and a positional transcript path', () => {
    const parsed = parseArgs([
      '--phase',
      '1: develop',
      '--role',
      'Developer',
      '--model',
      'claude-sonnet-5',
      '/tmp/t.jsonl'
    ])
    expect(parsed).toEqual({
      phase: '1: develop',
      role: 'Developer',
      model: 'claude-sonnet-5',
      transcriptPath: '/tmp/t.jsonl'
    })
  })

  it('parses the named --transcript flag identically to the positional form', () => {
    const named = parseArgs(['--phase', '1: develop', '--role', 'Developer', '--transcript', '/tmp/t.jsonl'])
    const positional = parseArgs(['--phase', '1: develop', '--role', 'Developer', '/tmp/t.jsonl'])
    expect(named.transcriptPath).toBe('/tmp/t.jsonl')
    expect(named).toEqual(positional)
  })

  it('never swallows the --transcript value as an unknown flag, whatever the argument order', () => {
    // Before `--transcript` was a declared flag it only "worked" by accident:
    // the flag itself fell through the unknown-`--` branch and its value was
    // picked up as the bare positional. That left the primary route for a
    // caller naming its own transcript undocumented and one refactor away
    // from silently breaking.
    const parsed = parseArgs(['--transcript', '/tmp/t.jsonl', '--phase', '1: develop', '--role', 'Developer'])
    expect(parsed.transcriptPath).toBe('/tmp/t.jsonl')
    expect(parsed.phase).toBe('1: develop')
  })

  it('advertises --transcript in the usage text — a primary route, not an undocumented escape hatch', () => {
    expect(() => parseArgs([])).toThrow(/--transcript/)
  })

  it('leaves model and transcriptPath undefined when omitted', () => {
    const parsed = parseArgs(['--phase', '1: review', '--role', 'Reviewer'])
    expect(parsed.model).toBeUndefined()
    expect(parsed.transcriptPath).toBeUndefined()
  })
})

describe('resolveTranscriptPath', () => {
  const baseDeps = {
    env: { CLAUDE_PROJECT_DIR: '/repo', TMPDIR: '/tmp' },
    cwd: '/repo',
    exists: (_path: string) => false,
    readFile: (_path: string) => ''
  }

  it('returns the explicit path unchanged, never touching the pointer file — path comes in, never scanned', () => {
    const exists = () => {
      throw new Error('must not check the pointer file when an explicit path is given')
    }
    const resolved = resolveTranscriptPath('/explicit/path.jsonl', { ...baseDeps, exists })
    expect(resolved).toBe('/explicit/path.jsonl')
  })

  it('reads the transcript path out of the pointer file when none is given', () => {
    const resolved = resolveTranscriptPath(undefined, {
      ...baseDeps,
      exists: (path) => path === '/tmp/claude-transcript--repo.txt',
      readFile: () => 'session-abc\t/home/user/.claude/projects/-repo/session-abc.jsonl\n'
    })
    expect(resolved).toBe('/home/user/.claude/projects/-repo/session-abc.jsonl')
  })

  it('throws — never silently falls back to a `—` line — when no pointer file exists yet', () => {
    expect(() => resolveTranscriptPath(undefined, baseDeps)).toThrow(/No transcript pointer/)
  })

  it('throws on a malformed pointer file rather than guessing a path', () => {
    expect(() =>
      resolveTranscriptPath(undefined, { ...baseDeps, exists: () => true, readFile: () => 'not-tab-separated' })
    ).toThrow(/malformed/)
  })

  it('falls back to cwd when CLAUDE_PROJECT_DIR is unset', () => {
    const resolved = resolveTranscriptPath(undefined, {
      env: { TMPDIR: '/tmp' },
      cwd: '/repo',
      exists: (path) => path === transcriptPointerPath('/repo', '/tmp'),
      readFile: () => 'session-abc\t/some/transcript.jsonl\n'
    })
    expect(resolved).toBe('/some/transcript.jsonl')
  })

  it('throws on a stale pointer — the current session id disagrees with the one the pointer was written for', () => {
    // Regression (code review, PR #800): a worktree reused across sessions
    // can hold a pointer written by a PREVIOUS session, still present
    // because the new session's own Stop hook hasn't fired yet. Silently
    // reading it would reproduce the exact wrong-session-attribution bug
    // this reporter exists to prevent, one session later.
    expect(() =>
      resolveTranscriptPath(undefined, {
        ...baseDeps,
        env: { ...baseDeps.env, CLAUDE_CODE_SESSION_ID: 'current-session' },
        exists: () => true,
        readFile: () => 'previous-session\t/home/user/.claude/projects/-repo/previous-session.jsonl\n'
      })
    ).toThrow(/stale/)
  })

  it('succeeds when the current session id matches the pointer', () => {
    const resolved = resolveTranscriptPath(undefined, {
      ...baseDeps,
      env: { ...baseDeps.env, CLAUDE_CODE_SESSION_ID: 'same-session' },
      exists: () => true,
      readFile: () => 'same-session\t/home/user/.claude/projects/-repo/same-session.jsonl\n'
    })
    expect(resolved).toBe('/home/user/.claude/projects/-repo/same-session.jsonl')
  })

  it('trusts the pointer with no staleness check when CLAUDE_CODE_SESSION_ID is unavailable', () => {
    // The env var is confirmed present in every Claude Code Bash tool call
    // but isn't part of the documented public hook JSON schema — treated as
    // a best-effort cross-check, not a hard requirement.
    const resolved = resolveTranscriptPath(undefined, {
      ...baseDeps,
      exists: () => true,
      readFile: () => 'some-session\t/home/user/.claude/projects/-repo/some-session.jsonl\n'
    })
    expect(resolved).toBe('/home/user/.claude/projects/-repo/some-session.jsonl')
  })
})

/**
 * `#328`: the real `import.meta.main` entry point must resolve the
 * transcript pointer through `hardenedMeteringDeps()`, not hand-rolled
 * `existsSync`/`readFileSync` — the same CWE-59 class `#313` closed at
 * every `resolveMeteringCapability` call site (`tokens-metering-io.test.ts`
 * is the sibling pattern this mirrors). Foreign-owner refusal is not
 * re-tested here: it's proven once, against a faked stat, in
 * `metering-io-guard.test.ts`, and is inherited automatically now that
 * this file's entry point consumes that same factory rather than
 * re-deriving its own I/O.
 */
describe('resolveTranscriptPath — real entry-point hardening (hardenedMeteringDeps)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'report-tokens-io-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const deps = () => ({
    ...hardenedMeteringDeps(),
    env: { CLAUDE_PROJECT_DIR: 'repro', TMPDIR: dir },
    cwd: dir
  })

  it('refuses a symlinked pointer file rather than following it', () => {
    const victim = join(dir, 'victim-secret.txt')
    const link = transcriptPointerPath('repro', dir)
    writeFileSync(victim, 'sess-x\t/home/user/.claude/projects/-repo/sess-x.jsonl\n')
    symlinkSync(victim, link)

    expect(() => resolveTranscriptPath(undefined, deps())).toThrow()
  })

  it('refuses a FIFO pointer file without hanging', () => {
    const fifo = transcriptPointerPath('repro', dir)
    execFileSync('mkfifo', [fifo])

    const start = Date.now()
    expect(() => resolveTranscriptPath(undefined, deps())).toThrow()
    expect(Date.now() - start).toBeLessThan(2000)
  })

  it('a legitimate pointer file still resolves correctly', () => {
    const pointer = transcriptPointerPath('repro', dir)
    writeFileSync(pointer, 'sess-x\t/home/user/.claude/projects/-repo/sess-x.jsonl\n')

    const resolved = resolveTranscriptPath(undefined, deps())
    expect(resolved).toBe('/home/user/.claude/projects/-repo/sess-x.jsonl')
  })
})

describe('main', () => {
  const runDeps = (overrides: Partial<Parameters<typeof main>[1]> = {}) => ({
    env: {},
    cwd: '/repo',
    exists: () => false,
    readFile: () => '',
    ...overrides
  })

  it('throws rather than emitting a plausible-looking `0/0/—` for a transcript with zero usable messages', () => {
    // Regression (code review, PR #800): an empty, unparseable, or
    // not-yet-flushed transcript previously formatted as an exact `0/0/—`
    // line — indistinguishable, once parsed, from a session that genuinely
    // spent zero tokens.
    expect(() =>
      main(
        ['--phase', '1: develop', '--role', 'Developer', '/tmp/empty.jsonl'],
        runDeps({ readFile: (path) => (path === '/tmp/empty.jsonl' ? '' : '') })
      )
    ).toThrow(/zero assistant messages/)
  })
})
