import { execFileSync } from 'node:child_process'
import { programCommandLine } from '../../../tools/programs.js'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'bun:test'

/** The default branch's `vinaya.config.json` every `gh` stub here serves to the Principal read (`gh api repos/<owner>/<repo>/contents/vinaya.config.json`), base64-encoded as the contents API returns it. */
const PRINCIPALS_CONFIG_B64 = Buffer.from(JSON.stringify({ principals: ['daniboomerang'] })).toString('base64')

// `vinaya review post --print-only` (task 6, #397): renders and
// self-verifies the comment, exactly like a real post, but never calls `gh
// pr comment` — closing atta-labs/vinaya#184 (a reviewer guessed this flag
// existed, and the old command silently posted the verdict anyway). The
// `gh` stub below FAILS `pr comment` outright: if `--print-only` ever
// reaches a post, the test fails on that stub's stderr, not merely on a
// missing assertion.

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..', 'apps', 'cli')
const INDEX = join(CLI_ROOT, 'src', 'index.ts')
const HEAD = 'b'.repeat(40)
const BASE = 'a'.repeat(40)

type CliResult = { status: number; stdout: string; stderr: string }

/**
 * Runs `review post` the way a hand reviewer does: the judged manifest is
 * exported first (`--export-manifest`, no forge write) and passed to the post as
 * `--manifest-file`. A call that already carries one of those flags, names no
 * `--pr`, or whose export is refused runs exactly as given.
 */
function runCli(args: string[], cwd: string, env: Record<string, string | undefined>): CliResult {
  const prIndex = args.indexOf('--pr')
  if (prIndex === -1 || args.includes('--manifest-file') || args.includes('--export-manifest')) {
    return runCliRaw(args, cwd, env)
  }
  const exported = runCliRaw(['review', 'post', '--export-manifest', '--pr', String(args[prIndex + 1])], cwd, env)
  if (exported.status !== 0) return runCliRaw(args, cwd, env)
  const file = join(mkdtempSync(join(tmpdir(), 'judged-manifest-')), 'manifest.json')
  writeFileSync(file, exported.stdout)
  return runCliRaw([...args, '--manifest-file', file], cwd, env)
}

function runCliRaw(args: string[], cwd: string, env: Record<string, string | undefined>): CliResult {
  try {
    const stdout = execFileSync('bun', programCommandLine(args) ?? [INDEX, ...args], {
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
 * reconcile against), `pr view --json body` (`Closes #1` — below
 * `OBJECTIVES_SINCE_ISSUE`, so `resolveObjectivesForPr` resolves `skip` and
 * neither an `Objectives version:` line nor an `OBJECTIVES:` block renders)
 * and `issue view --json comments` (empty — `resolveBriefHashForPr`, task 4,
 * `#478`, O1, always reaches this call since `Closes #1` names a real Issue;
 * no principal-authored frozen brief here is the legitimate "nothing to
 * bind against yet" case, so `Brief hash:` renders `(none)`, never a
 * refusal); `pr comment` exits non-zero with a distinctive stderr line, so a
 * stray real post is loud, never silent.
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
if [ "$1" = "api" ] && [ "\${2#*contents/vinaya.config.json}" != "$2" ]; then echo '${PRINCIPALS_CONFIG_B64}'; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  case "$*" in
    *baseRefName*) echo "main"; exit 0 ;;
    *headRefName*) echo "stub-branch"; exit 0 ;;
    *headRefOid*) echo "${headSha}"; exit 0 ;;
    *comments*) echo '{"comments": []}'; exit 0 ;;
    *body*) echo "Closes #1"; exit 0 ;;
  esac
fi
if [ "$1" = "api" ]; then
  case "$*" in
    *git/ref/heads/stub-branch*) echo "${headSha}"; exit 0 ;;
    *git/ref/heads/main*) echo "${BASE}"; exit 0 ;;
  esac
fi
if [ "$1" = "api" ]; then
  case "$2" in
    repos/*/issues/*/comments*) echo '[]'; exit 0 ;;
  esac
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  case "$*" in
    *comments*) echo '{"comments": []}'; exit 0 ;;
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
  return { dir, env: { PATH: `${dir}:${process.env.PATH ?? ''}`, GITHUB_REPOSITORY: 'acme/widget' } }
}

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  // The Objectives cutover now comes from `vinaya.config.json` (`gateCutovers`,
  // an absent key = no cutover, O1). These tests use a `Closes #1` PR and rely
  // on #1 being PRE-cutover (objectives grading skipped); this repo's own
  // historical cutover restores that when the command reads config from cwd.
  writeFileSync(
    join(dir, 'vinaya.config.json'),
    JSON.stringify({ gateCutovers: { objectivesSinceIssue: 404 } }),
    'utf8'
  )
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

// The judged manifest snapshot (#1853): a hand reviewer exports the review
// input before reading it and the post echoes that snapshot, succeeding only
// while every current binding still matches.
describe('vinaya review post — the judged manifest snapshot', () => {
  const OTHER_HEAD = 'c'.repeat(40)

  function postArgs(role: 'code-reviewer' | 'security', findingsFile: string, extra: string[]): string[] {
    const common = ['--task-id', 'fix', '--model', 'x', '--tokens-in', '-', '--tokens-out', '-', '--cost', '-']
    const roleArgs =
      role === 'code-reviewer'
        ? ['--brief-conformance', 'x', '--spec-conformance', 'x', '--scope', 'x', '--tests', 'x', '--docs', 'x']
        : ['--config-scan', 'not-applicable', '--secrets', 'x']
    return [
      'review',
      'post',
      '--print-only',
      '--role',
      role,
      '--pr',
      '1',
      '--findings-file',
      findingsFile,
      ...roleArgs,
      ...common,
      ...extra
    ]
  }

  function exportSnapshot(cwd: string, env: Record<string, string | undefined>): { file: string; text: string } {
    const exported = runCliRaw(['review', 'post', '--export-manifest', '--pr', '1'], cwd, env)
    expect(exported.status).toBe(0)
    const file = join(cwd, 'judged-manifest.json')
    writeFileSync(file, exported.stdout)
    return { file, text: exported.stdout }
  }

  it('--export-manifest prints the canonical manifest and writes nothing', () => {
    const cwd = tempDir('review-post-export-')
    const { dir, env } = stubGhNoPost(HEAD)
    try {
      const { text } = exportSnapshot(cwd, env)
      const manifest = JSON.parse(text)
      expect(manifest.manifestVersion).toBe(2)
      expect(manifest.headSha).toBe(HEAD)
      expect(manifest.baseSha).toBe(BASE)
      expect(manifest.briefHash).toBeNull()
      expect(manifest.rulingOrdinal).toBe(0)
      expect(manifest.pauseBoundRuling).toBeNull()
      expect(manifest.policyDigest).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  for (const role of ['code-reviewer', 'security'] as const) {
    it(`${role}: a post without --manifest-file is refused before any forge contact`, () => {
      const cwd = tempDir('review-post-no-manifest-')
      const { dir, env } = stubGhNoPost(HEAD)
      const findings = join(cwd, 'findings.txt')
      writeFileSync(findings, '')
      try {
        const r = runCliRaw(postArgs(role, findings, ['--verdict', role === 'security' ? 'PASS' : 'APPROVE']), cwd, env)
        expect(r.status).not.toBe(0)
        expect(r.stderr).toContain('--manifest-file')
        expect(r.stderr).not.toContain('must never post')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it(`${role}: a snapshot of an older head is refused — current values are never stamped onto it`, () => {
      const cwd = tempDir('review-post-stale-head-')
      const first = stubGhNoPost(HEAD)
      const second = stubGhNoPost(OTHER_HEAD)
      const findings = join(cwd, 'findings.txt')
      writeFileSync(findings, '')
      try {
        const { file } = exportSnapshot(cwd, first.env)
        const r = runCliRaw(postArgs(role, findings, ['--manifest-file', file]), cwd, second.env)
        expect(r.status).not.toBe(0)
        expect(r.stderr).toContain('no longer matches')
        expect(r.stderr).toContain('head')
        expect(r.stdout).not.toContain('VERDICT')
        expect(r.stderr).not.toContain('must never post')
      } finally {
        rmSync(first.dir, { recursive: true, force: true })
        rmSync(second.dir, { recursive: true, force: true })
      }
    })
  }

  it('a snapshot whose pause-bound ruling differs from the current one is refused', () => {
    const cwd = tempDir('review-post-stale-pause-')
    const { dir, env } = stubGhNoPost(HEAD)
    const findings = join(cwd, 'findings.txt')
    writeFileSync(findings, '')
    try {
      const { text } = exportSnapshot(cwd, env)
      const edited = {
        ...JSON.parse(text),
        pauseBoundRuling: { rulingId: 'pr:1:ruling:1', pauseId: 'p1', contentDigest: 'd'.repeat(64) }
      }
      const file = join(cwd, 'edited.json')
      writeFileSync(file, JSON.stringify(edited))
      const r = runCliRaw(postArgs('code-reviewer', findings, ['--manifest-file', file]), cwd, env)
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('pauseBoundRuling')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  const BAD_SNAPSHOTS: ReadonlyArray<[string, (m: Record<string, unknown>) => Record<string, unknown>, string]> = [
    ['an unsupported manifest version', (m) => ({ ...m, manifestVersion: 3 }), 'unsupported'],
    [
      'a missing binding',
      (m) => {
        const { baseSha: _omitted, ...rest } = m
        return rest
      },
      'missing `baseSha`'
    ],
    ['an unknown field', (m) => ({ ...m, protocol: 1 }), 'unsupported field'],
    ['an abbreviated head', (m) => ({ ...m, headSha: 'bbbbbbb' }), 'full 40-hex'],
    ['a malformed policy digest', (m) => ({ ...m, policyDigest: 'x' }), 'policyDigest']
  ]
  for (const [name, mutate, expected] of BAD_SNAPSHOTS) {
    it(`${name} is refused before any forge contact`, () => {
      const cwd = tempDir('review-post-bad-manifest-')
      const { dir, env } = stubGhNoPost(HEAD)
      const findings = join(cwd, 'findings.txt')
      writeFileSync(findings, '')
      try {
        const { text } = exportSnapshot(cwd, env)
        const file = join(cwd, 'bad.json')
        writeFileSync(file, JSON.stringify(mutate(JSON.parse(text))))
        const r = runCliRaw(postArgs('code-reviewer', findings, ['--manifest-file', file]), cwd, env)
        expect(r.status).not.toBe(0)
        expect(r.stderr).toContain(expected)
        expect(r.stderr).not.toContain('must never post')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }

  for (const role of ['code-reviewer', 'security'] as const) {
    it(`${role}: a current snapshot is echoed — version, pause-bound ruling and base render from it`, () => {
      const cwd = tempDir('review-post-echo-')
      const { dir, env } = stubGhNoPost(HEAD)
      const findings = join(cwd, 'findings.txt')
      writeFileSync(findings, '')
      try {
        const { file } = exportSnapshot(cwd, env)
        const r = runCliRaw(postArgs(role, findings, ['--manifest-file', file]), cwd, env)
        expect(r.status).toBe(0)
        expect(r.stdout).toContain(`Judged head: ${HEAD}`)
        expect(r.stdout).toContain(`Judged base: ${BASE}`)
        expect(r.stdout).toContain('Manifest version: 2')
        expect(r.stdout).toContain('Pause-bound ruling: (none)')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }

  it('--export-manifest refuses to run beside a verdict or a snapshot', () => {
    const cwd = tempDir('review-post-export-alone-')
    const { dir, env } = stubGhNoPost(HEAD)
    try {
      const r = runCliRaw(['review', 'post', '--export-manifest', '--pr', '1', '--verdict', 'APPROVE'], cwd, env)
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('--export-manifest')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
