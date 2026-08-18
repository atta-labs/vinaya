import { describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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
const BIN = join(REPO_ROOT, 'apps/cli/src/checks/bin/check-doc-coverage.ts')

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** A repo whose one binding has fired: the bound code changed, the doc did not. */
function repoWithFiredBinding(codeEdit: string): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), 'c5-parity-'))
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

async function runCheck(dir: string, base: string, prBody: string): Promise<number> {
  const proc = Bun.spawn(['bun', BIN], {
    cwd: dir,
    env: { ...process.env, BASE_SHA: base, PR_BODY: prBody, PR_NUMBER: '' },
    stdout: 'pipe',
    stderr: 'pipe'
  })
  return await proc.exited
}

describe('C5 Doc-neutral parity between the blocking check and verify-docs (#122)', () => {
  it('clears a comment-only change when Doc-neutral is declared', async () => {
    const { dir, base } = repoWithFiredBinding('export const x = 1\n// a clarifying comment\n')
    expect(await runCheck(dir, base, 'Doc-neutral: docs/x.md — comment-only edit')).toBe(0)
  })

  it('still rejects a substantive change that declares Doc-neutral', async () => {
    const { dir, base } = repoWithFiredBinding('export const x = 2\n')
    expect(await runCheck(dir, base, 'Doc-neutral: docs/x.md — claimed neutral')).not.toBe(0)
  })

  // The evidence diff must use the ref that actually produced the changed-file
  // list. With no `origin/main` (a local run, a shallow clone) the bins fall
  // back to `main`; a closure still holding `origin/main` diffs against a ref
  // that resolves nothing, returns null, and the declaration fails for an
  // unrelated reason. Runs with BASE_SHA unset so the fallback is exercised.
  it('clears via the fallback ref when origin/main does not exist', async () => {
    const { dir } = repoWithFiredBinding('export const x = 1\n// a clarifying comment\n')
    const proc = Bun.spawn(['bun', BIN], {
      cwd: dir,
      env: {
        ...process.env,
        BASE_SHA: '',
        PR_BODY: 'Doc-neutral: docs/x.md — comment-only edit',
        PR_NUMBER: ''
      },
      stdout: 'pipe',
      stderr: 'pipe'
    })
    expect(await proc.exited).toBe(0)
  })

  it('still fires when nothing is declared', async () => {
    const { dir, base } = repoWithFiredBinding('export const x = 2\n')
    expect(await runCheck(dir, base, '')).not.toBe(0)
  })
})
