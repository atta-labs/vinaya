import { describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCliChecks } from './run-checks'

// A stand-in CLI entry: prints its argv tail, cwd and the PR variable, and exits with FAKE_EXIT.
function fakeCli(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-cli-'))
  const entry = join(dir, 'index.ts')
  writeFileSync(
    entry,
    `process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), pr: process.env.PR_NUMBER ?? null }))
process.stderr.write('done')
process.exit(Number(process.env.FAKE_EXIT ?? 0))
`
  )
  return entry
}

describe('runCliChecks', () => {
  test('runs check --all from the named entry in the worktree, env merged over the process env', async () => {
    const worktree = realpathSync(mkdtempSync(join(tmpdir(), 'checks-wt-')))
    const result = await runCliChecks(fakeCli(), worktree, { PR_NUMBER: '42', FAKE_EXIT: '0' })
    expect(result.passed).toBe(true)
    const printed = JSON.parse(result.output.replace(/done$/, ''))
    expect(printed).toEqual({ args: ['check', '--all'], cwd: worktree, pr: '42' })
    expect(result.output.endsWith('done')).toBe(true)
  })

  test('a non-zero exit is a failed gate with its output', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'checks-wt-'))
    const result = await runCliChecks(fakeCli(), worktree, { FAKE_EXIT: '3' })
    expect(result.passed).toBe(false)
    expect(result.output).toContain('"args":["check","--all"]')
  })
})

describe('runCli', () => {
  test('passes the given args and returns status, stdout and stderr apart', async () => {
    const { runCli } = await import('./run-checks')
    const worktree = mkdtempSync(join(tmpdir(), 'cli-wt-'))
    const res = runCli(fakeCli(), worktree, ['pr', 'report', '--push', '5'], { FAKE_EXIT: '2' })
    expect(res.status).toBe(2)
    expect(JSON.parse(res.stdout).args).toEqual(['pr', 'report', '--push', '5'])
    expect(res.stderr).toBe('done')
  })
})
