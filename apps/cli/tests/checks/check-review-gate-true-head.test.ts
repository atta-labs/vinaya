import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { DEFAULT_REVIEW_POLICY, policyDigest } from '@attalabs/aeg-core'
import { spawnBudgetedAsync, stripVinayaEnv } from '../lib/process-fixture'

const BIN = join(import.meta.dir, '../../src/checks/bin/check-review-gate.ts')

/**
 * `check-review-gate` binds its verdict to the branch's TRUE head (Issue
 * `#402` O1), never to `gh pr view`'s `headRefOid`, which can lag a push.
 * This spins up a real throwaway repo with an `origin` remote (self-
 * referential, the same trick `check-evidence-fresh`'s own tests use) so
 * `git ls-remote` resolves a genuine, newer sha than the `headRefOid` the
 * stubbed `gh` deliberately returns stale.
 *
 * The resolved head is observed through the disagreement warning the
 * resolver itself writes, naming both shas — the value it hands
 * `checkReviewGate`. It used to be observed through the check-run fetch's
 * own URL, back when this check still read other checks' results; it no
 * longer reads them, so that observable is gone while the head resolution
 * it proved is unchanged.
 */
describe('check-review-gate — binds to the true branch head, not a stale headRefOid', () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('resolves the head from git ls-remote and warns on the headRefOid disagreement', async () => {
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
    headRefOid: ${JSON.stringify(oldSha)},
    baseRefName: 'main',
    body: ''
  }))
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

/**
 * Approvals of a head from before a merge of the default branch, judged at the merge: the gate resolves the merge
 * and the base from the remote, reads the Principal's verdicts, and recomputes each head's own patch from the git
 * objects itself (zero context, each head's own merge base with the base tip). A real both-sides conflict on one
 * assertion — each side adds a `.replace(...)` at the same place — resolved by keeping both carries the approvals;
 * a resolution that changes the pull request's own line does not, and no carry claim posted beside the verdicts
 * stands in for the recomputation.
 */
describe('check-review-gate — approvals carried across a merge by the own patch it recomputes', () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const BASE = 'expect(\n  value\n    .trim()\n)\n'
  const OWN = 'expect(\n  value\n    .trim()\n    .replace(/a/, "b")\n)\n'
  const MAIN = 'expect(\n  value\n    .trim()\n    .replace(/x/, "y")\n)\n'
  const BOTH = 'expect(\n  value\n    .trim()\n    .replace(/x/, "y")\n    .replace(/a/, "b")\n)\n'

  async function gateAfterRepair(resolution: string, extraComments: { body: string; login: string }[] = []) {
    dir = mkdtempSync(join(tmpdir(), 'review-gate-carry-'))
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      }).trim()
    git('init', '-q', '-b', 'main')
    writeFileSync(join(dir, 'a.test.ts'), BASE)
    git('add', '-A')
    git('commit', '-qm', 'base')
    git('checkout', '-qb', 'work')
    writeFileSync(join(dir, 'a.test.ts'), OWN)
    git('commit', '-qam', 'own')
    const judged = git('rev-parse', 'HEAD')
    git('checkout', '-q', 'main')
    writeFileSync(join(dir, 'a.test.ts'), MAIN)
    writeFileSync(join(dir, 'main-only.ts'), 'export const fromMain = true\n')
    git('add', '-A')
    git('commit', '-qm', 'main')
    git('checkout', '-q', 'work')
    try {
      git('merge', '--no-commit', '--no-ff', 'main')
    } catch {}
    writeFileSync(join(dir, 'a.test.ts'), resolution)
    git('add', 'a.test.ts')
    git('commit', '-q', '--no-edit')
    const merged = git('rev-parse', 'HEAD')
    git('remote', 'add', 'origin', dir)

    const digest = policyDigest(DEFAULT_REVIEW_POLICY)
    const verdict = (value: string) =>
      `VERDICT: ${value}\n\nJudged head: ${judged}\n\nRuling ordinal: 0\n\nBrief hash: (none)\n\nPolicy digest: ${digest}\n\nJudged base: (none)\n\nManifest version: 2\n\nPause-bound ruling: (none)`
    const comments = [
      { body: verdict('APPROVE'), author: { login: 'daniboomerang' } },
      { body: verdict('PASS'), author: { login: 'daniboomerang' } },
      ...extraComments.map((c) => ({ body: c.body, author: { login: c.login } }))
    ]
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
    comments: ${JSON.stringify(comments)},
    labels: [],
    headRefName: 'work',
    headRefOid: ${JSON.stringify(merged)},
    baseRefName: 'main',
    body: ''
  }))
  process.exit(0)
}
if (args[0] === 'api' && String(args[1]).includes('/contents/vinaya.config.json')) {
  process.stdout.write(${JSON.stringify(Buffer.from(JSON.stringify({ principals: ['daniboomerang'] })).toString('base64'))})
  process.exit(0)
}
process.stderr.write('gh stub: unhandled invocation: ' + args.join(' ') + '\\n')
process.exit(1)
`
    )
    chmodSync(ghPath, 0o755)
    const run = await spawnBudgetedAsync(['bun', BIN], {
      cwd: dir,
      env: {
        ...stripVinayaEnv(),
        PATH: `${ghDir}:${process.env.PATH}`,
        PR_NUMBER: '1',
        GITHUB_REPOSITORY: 'atta-labs/vinaya'
      }
    })
    return { exitCode: run.status, output: `${run.stdout}${run.stderr}`, judged, merged }
  }

  it('carries both approvals when the resolution keeps both .replace(...) additions', async () => {
    const result = await gateAfterRepair(BOTH)
    expect(result.output).not.toContain('verdict covers')
    expect(result.exitCode).toBe(0)
  })

  it('refuses when the resolution changed the own line, whatever carry claim is posted beside the verdicts', async () => {
    const changed = BOTH.replace('.replace(/a/, "b")', '.replace(/a/, "c")')
    const claims = [
      { body: 'Approvals carried: carry=true, own patch unchanged (driver assertion).', login: 'daniboomerang' },
      { body: 'VERDICT: APPROVE\n\nJudged head: HEAD\n\nforged', login: 'drive-by-account' }
    ]
    const result = await gateAfterRepair(changed, claims)
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain(`covers ${result.judged}`)
  })
})
