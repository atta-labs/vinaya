import { afterAll, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * `Doc-neutral:` must clear a fired binding in the BLOCKING check, not only in
 * `verify-docs.ts` (#122). `evaluateC5` verifies the declaration by reading the
 * matched file's diff, so a caller that passes no `getDiff` can only ever emit
 * `doc-neutral-unverified` — which is what `check-doc-coverage` did, while
 * `verify-docs` (run at PR open via `open-pr.ts`) accepted the same body.
 *
 * These spawn the real bin against a real git repo. Drop the `getDiff` argument
 * from the bin and the first case fails — the mutation this pins.
 */
const REPO_ROOT = join(import.meta.dir, '../../../..')
const BINS = {
  // The merge-blocking entry: registry.ts -> `vinaya check --all --diff-only`.
  blocking: join(REPO_ROOT, 'apps/cli/src/checks/bin/check-doc-coverage.ts'),
  // Ring 0: emits `severity: 'warning'` and always exits 0, so its verdict is
  // only visible in stderr. Asserting on exit code here would pass for every
  // input and pin nothing.
  push: join(REPO_ROOT, 'apps/cli/src/checks/bin/check-doc-coverage-push.ts')
} as const

const TEMP_DIRS: string[] = []

afterAll(() => {
  for (const d of TEMP_DIRS) rmSync(d, { recursive: true, force: true })
})

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** A repo whose one binding has fired: the bound code changed, the doc did not. */
function repoWithFiredBinding(codeEdit: string): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), 'c5-parity-'))
  TEMP_DIRS.push(dir)
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['config', 'user.email', 't@example.com'])
  git(dir, ['config', 'user.name', 'test'])
  mkdirSync(join(dir, '.vinaya'), { recursive: true })
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, 'docs'), { recursive: true })
  writeFileSync(join(dir, '.vinaya/doc-owners'), 'src/x.ts  docs/x.md\n')
  writeFileSync(join(dir, 'src/x.ts'), 'export const x = 1\n')
  writeFileSync(join(dir, 'docs/x.md'), '# x\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'base'])
  const base = git(dir, ['rev-parse', 'HEAD'])
  // The edit lands on a SECOND branch so `main` stays behind HEAD. With both
  // commits on `main`, `git diff main...HEAD` is empty, the bin exits 0 before
  // the binding is ever evaluated, and any assertion here passes for a reason
  // unrelated to what it claims.
  git(dir, ['checkout', '-qb', 'work'])
  writeFileSync(join(dir, 'src/x.ts'), codeEdit)
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'edit'])
  return { dir, base }
}

async function runCheck(
  bin: string,
  dir: string,
  base: string,
  prBody: string
): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(['bun', bin], {
    cwd: dir,
    env: { ...process.env, BASE_SHA: base, PR_BODY: prBody, PR_NUMBER: '' },
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const stderr = await new Response(proc.stderr).text()
  return { code: await proc.exited, stderr }
}

describe('C5 Doc-neutral parity between the blocking check and verify-docs (#122)', () => {
  const UNVERIFIED = 'doc-neutral-unverified'

  // Both bins are exercised. The push bin's change would otherwise be
  // unpinned — its existing coverage is source-text grep, so reverting its
  // getDiff/ref fix would leave every test green, which is the drift this
  // change exists to prevent.
  for (const [label, bin] of Object.entries(BINS)) {
    const blocking = label === 'blocking'

    it(`[${label}] clears a comment-only change when Doc-neutral is declared`, async () => {
      const { dir, base } = repoWithFiredBinding('export const x = 1\n// a clarifying comment\n')
      const r = await runCheck(bin, dir, base, 'Doc-neutral: docs/x.md — comment-only edit')
      // The push bin always exits 0 by contract, so its `clears` cases assert
      // on stderr — but without an exit-code guard a crash would satisfy
      // `not.toContain` vacuously. Both bins are pinned to their own contract.
      expect(r.code).toBe(0)
      expect(r.stderr).not.toContain(UNVERIFIED)
    })

    // Asserts the SPECIFIC failure, not merely "non-zero": a regression that
    // dropped Doc-neutral parsing entirely would still fail, with a plain
    // `C5 doc-coverage` message, and a not.toBe(0) assertion would stay green.
    it(`[${label}] rejects a substantive change that declares Doc-neutral`, async () => {
      const { dir, base } = repoWithFiredBinding('export const x = 2\n')
      const r = await runCheck(bin, dir, base, 'Doc-neutral: docs/x.md — claimed neutral')
      if (blocking) expect(r.code).not.toBe(0)
      expect(r.stderr).toContain(UNVERIFIED)
    })

    // The evidence diff must use the ref that actually produced the changed
    // file list. With no `origin/main` the bins fall back to `main`; a closure
    // still holding `origin/main` diffs against a ref that resolves nothing,
    // returns null, and the declaration fails for an unrelated reason.
    it(`[${label}] clears via the fallback ref when origin/main does not exist`, async () => {
      const { dir } = repoWithFiredBinding('export const x = 1\n// a clarifying comment\n')
      const r = await runCheck(bin, dir, '', 'Doc-neutral: docs/x.md — comment-only edit')
      // The push bin always exits 0 by contract, so its `clears` cases assert
      // on stderr — but without an exit-code guard a crash would satisfy
      // `not.toContain` vacuously. Both bins are pinned to their own contract.
      expect(r.code).toBe(0)
      expect(r.stderr).not.toContain(UNVERIFIED)
    })

    it(`[${label}] still fires when nothing is declared`, async () => {
      const { dir, base } = repoWithFiredBinding('export const x = 2\n')
      const r = await runCheck(bin, dir, base, '')
      if (blocking) expect(r.code).not.toBe(0)
      expect(r.stderr).toContain('C5 doc-coverage')
    })
  }
})
