import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'

const BIN = join(import.meta.dir, '../../src/checks/bin/check-review-gate.ts')

/**
 * `check-review-gate` binds its verdict to the branch's TRUE head (Issue
 * `#402` O1), never to `gh pr view`'s `headRefOid`, which can lag a push.
 * This spins up a real throwaway repo with an `origin` remote (self-
 * referential, the same trick `check-evidence-fresh`'s own tests use) so
 * `git ls-remote` resolves a genuine, newer sha than the `headRefOid` the
 * stubbed `gh` deliberately returns stale.
 */
describe('check-review-gate — binds to the true branch head, not a stale headRefOid', () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('resolves check-runs against the newer git ls-remote sha and warns on the headRefOid disagreement', async () => {
    dir = mkdtempSync(join(tmpdir(), 'review-gate-truehead-'))
    const g = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
    g(['init', '-q', '-b', 'work'])
    g(['config', 'user.email', 't@example.com'])
    g(['config', 'user.name', 'test'])
    writeFileSync(join(dir, 'a.txt'), 'old\n')
    g(['add', '-A'])
    g(['commit', '-qm', 'old'])
    const oldSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()

    // The push `gh pr view`'s cached `headRefOid` hasn't caught up with yet.
    writeFileSync(join(dir, 'a.txt'), 'old\nnew\n')
    g(['add', '-A'])
    g(['commit', '-qm', 'new'])
    const newSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()

    g(['remote', 'add', 'origin', dir])
    // `resolveBaseSha` now fails closed on an unresolvable base tip (round 2
    // review, security MEDIUM) — the PR fixture below names `baseRefName:
    // 'main'`, so a real `main` ref must exist for `git ls-remote` to
    // resolve, or this test's own head-mismatch assertion would never be
    // reached.
    g(['branch', 'main'])

    const markerFile = join(dir, 'check-runs-sha.txt')
    const ghDir = join(dir, 'fakebin')
    execFileSync('mkdir', ['-p', ghDir])
    const ghPath = join(ghDir, 'gh')
    writeFileSync(
      ghPath,
      `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
if (args[0] === 'pr' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({
    number: 1,
    comments: [],
    labels: [],
    headRefName: 'work',
    headRefOid: ${JSON.stringify(oldSha)},
    baseRefName: 'main',
    body: ''
  }))
  process.exit(0)
}
if (args[0] === 'api' && String(args[1]).includes('/check-runs')) {
  const sha = String(args[1]).split('/commits/')[1].split('/check-runs')[0]
  writeFileSync(${JSON.stringify(markerFile)}, sha)
  process.stdout.write('')
  process.exit(0)
}
process.stderr.write('gh stub: unhandled invocation: ' + args.join(' ') + '\\n')
process.exit(1)
`
    )
    chmodSync(ghPath, 0o755)

    const proc = Bun.spawn(['bun', BIN], {
      cwd: dir,
      env: { ...process.env, PATH: `${ghDir}:${process.env.PATH}`, PR_NUMBER: '1' },
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const stderr = await new Response(proc.stderr).text()
    await proc.exited

    expect(readFileSync(markerFile, 'utf8')).toBe(newSha)
    expect(stderr).toContain('disagrees with the true head')
    expect(stderr).toContain(oldSha)
    expect(stderr).toContain(newSha)
  })

  /**
   * Round 2 review, security MEDIUM: `resolveBaseSha` used to return `null`
   * on a genuine resolution failure (both `git ls-remote` and the forge's
   * ref API failing), and that `null` was passed straight through as
   * `baseSha: null` — which `compareManifest`'s own `isBoundToBase` reads as
   * "nothing to bind against", silently reverting this check to its
   * pre-task, base-blind behavior on a transient hiccup. It now fails
   * closed the same way an unresolvable HEAD already does, above.
   */
  it('fails closed (severity:infra) when the base branch tip cannot be resolved, rather than silently skipping the base binding', async () => {
    dir = mkdtempSync(join(tmpdir(), 'review-gate-nobase-'))
    const g = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
    g(['init', '-q', '-b', 'work'])
    g(['config', 'user.email', 't@example.com'])
    g(['config', 'user.name', 'test'])
    writeFileSync(join(dir, 'a.txt'), 'content\n')
    g(['add', '-A'])
    g(['commit', '-qm', 'initial'])
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
    g(['remote', 'add', 'origin', dir])
    // Deliberately NO `main` branch/ref anywhere — `baseRefName` below names
    // a base that does not exist, so both `git ls-remote` and the stubbed
    // `gh api .../git/ref/heads/main` (unhandled by the stub, below) fail to
    // resolve it.

    const ghDir = join(dir, 'fakebin')
    execFileSync('mkdir', ['-p', ghDir])
    const ghPath = join(ghDir, 'gh')
    writeFileSync(
      ghPath,
      `#!/usr/bin/env bun
const args = process.argv.slice(2)
if (args[0] === 'pr' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({
    number: 1,
    comments: [],
    labels: [],
    headRefName: 'work',
    headRefOid: ${JSON.stringify(sha)},
    baseRefName: 'main',
    body: ''
  }))
  process.exit(0)
}
if (args[0] === 'api' && String(args[1]).includes('/check-runs')) {
  process.stdout.write('{"id":1,"name":"ci","status":"completed","conclusion":"success"}\\n')
  process.exit(0)
}
process.stderr.write('gh stub: unhandled invocation: ' + args.join(' ') + '\\n')
process.exit(1)
`
    )
    chmodSync(ghPath, 0o755)

    const proc = Bun.spawn(['bun', BIN], {
      cwd: dir,
      env: { ...process.env, PATH: `${ghDir}:${process.env.PATH}`, PR_NUMBER: '1' },
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited

    expect(exitCode).toBe(1)
    expect(stderr).toContain('severity:infra')
    expect(stderr).toContain('base branch')
    expect(stderr).toContain('main')
  })
})
