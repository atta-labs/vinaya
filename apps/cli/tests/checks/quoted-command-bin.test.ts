import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import type { CheckError } from '../../src/checks/contract'

// Bin-level tests for check-quoted-command.ts's own I/O wiring — the pure
// evaluator (quoted-command.ts, aeg-core) has its own dedicated,
// corpus-tested unit suite that only ever sees relative fixture paths; this
// file exercises the real `fs`/path-resolution glue the pure suite can't
// see. Review finding (this check's own first PR): the bin resolved
// `DOCTRINE_ROOT` to an ABSOLUTE local filesystem path and reported findings
// under that absolute path verbatim — every `file` field leaked the
// developer's own checkout location. The pure evaluator's tests never catch
// this class of bug by construction (their fixtures are hand-fed relative
// paths, bypassing the bin's real resolution entirely); only a real spawn
// against a real filesystem does.

const BIN = join(import.meta.dir, '..', '..', 'src', 'checks', 'bin', 'check-quoted-command.ts')

let roots: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/** `realpathSync` — macOS's tmpdir is a symlink, and `git rev-parse --show-toplevel` resolves it. */
function newRoot(name: string): string {
  const raw = join(tmpdir(), `vinaya-quoted-command-bin-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(raw, { recursive: true })
  const root = realpathSync(raw)
  roots.push(root)
  return root
}

function initRepo(root: string): void {
  git(root, ['init', '-q', '-b', 'main'])
  git(root, ['config', 'user.email', 'test@example.com'])
  git(root, ['config', 'user.name', 'Test'])
}

/**
 * `proseGates.doctrineRoot` is set to an ABSOLUTE path — the exact shape
 * `resolveDoctrineRoot()` itself produces in real use (a package-relative
 * resolution, never cwd-relative). A RELATIVE `doctrineRoot` here would
 * pass even against the pre-fix bin (Node resolves a relative `readdirSync`
 * against the child process's own `cwd`, which happens to already be the
 * fixture root) — that shape does not reproduce the leak this test exists
 * to catch. Only the absolute shape does, because that is the shape that
 * carried the real checkout path straight into every finding.
 */
function scaffoldFixture(root: string, docContent: string, citedContent: string): void {
  const doctrineRoot = join(root, 'aeg-root')
  writeFileSync(join(root, 'vinaya.config.json'), JSON.stringify({ proseGates: { doctrineRoot } }))
  mkdirSync(doctrineRoot, { recursive: true })
  writeFileSync(join(doctrineRoot, 'doc.md'), docContent)
  writeFileSync(join(root, 'cited.txt'), citedContent)
}

async function runBin(cwd: string): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const proc = Bun.spawn(['bun', BIN], { cwd, stdout: 'pipe', stderr: 'pipe', env: process.env })
  const exitCode = await proc.exited
  const stderr = await new Response(proc.stderr).text()
  const stdout = await new Response(proc.stdout).text()
  return { exitCode, stderr, stdout }
}

function parseFindings(stderr: string): CheckError[] {
  return stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CheckError)
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

describe('check-quoted-command (bin) — path relativization', () => {
  it('a finding names the doc REPO-RELATIVE, never carrying the fixture checkout absolute path', async () => {
    const root = newRoot('leak')
    initRepo(root)
    scaffoldFixture(
      root,
      '<!-- AEG:QUOTES-FILE:START:cited.txt -->`hello world`<!-- AEG:QUOTES-FILE:END -->',
      'hello there'
    )

    const { exitCode, stderr } = await runBin(root)
    expect(exitCode).toBe(0)

    const findings = parseFindings(stderr)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.file).toBe('aeg-root/doc.md')
    expect(findings[0]?.file).not.toContain(root)
    expect(findings[0]?.message).not.toContain(root)
  })

  it('a clean tree (quoted text still verbatim in the cited file) reports zero findings', async () => {
    const root = newRoot('clean')
    initRepo(root)
    scaffoldFixture(
      root,
      '<!-- AEG:QUOTES-FILE:START:cited.txt -->`hello world`<!-- AEG:QUOTES-FILE:END -->',
      'hello world'
    )

    const { exitCode, stderr } = await runBin(root)
    expect(exitCode).toBe(0)
    expect(parseFindings(stderr)).toEqual([])
  })
})

describe('check-quoted-command (bin) — path-traversal file-content oracle is closed (security finding, round 2)', () => {
  it('a `..`-traversal citedFile pointing at a real file OUTSIDE the repo is never read: zero findings, not even a mismatch, even though the quoted text does NOT match the real target', async () => {
    const root = newRoot('traversal')
    initRepo(root)

    // A real, readable file one level above the fixture repo — the exact
    // shape the reviewer reproduced against `/etc/hosts`. The marker's
    // quoted text deliberately does NOT match this file's real content —
    // an exact-match fixture would pass "zero findings" in BOTH the
    // vulnerable and fixed code (silent pass on a match is itself one of
    // the oracle's three distinguishable signals, not evidence of safety).
    // Only a genuine mismatch discriminates: vulnerable code reads the
    // escaped file and emits a real finding (the file was reached, and
    // does not contain the claimed text — an oracle bit on its own); fixed
    // code never lets the citation reach the file-read stage at all, so
    // the mismatch is never even computed.
    const secretPath = join(tmpdir(), `vinaya-secret-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
    const secretContent = 'root:x:0:0:root:/root:/bin/bash'
    writeFileSync(secretPath, secretContent)
    roots.push(secretPath)

    const traversalPath = relative(root, secretPath)
    scaffoldFixture(
      root,
      `<!-- AEG:QUOTES-FILE:START:${traversalPath} -->\`this text does not appear in the target file\`<!-- AEG:QUOTES-FILE:END -->`,
      'irrelevant — this fixture asserts the traversal target is never touched, not the in-repo cited.txt'
    )

    const { exitCode, stdout, stderr } = await runBin(root)
    expect(exitCode).toBe(0)
    expect(parseFindings(stderr)).toEqual([])
    expect(stdout).not.toContain(secretContent)
    expect(stderr).not.toContain(secretContent)
  })
})
