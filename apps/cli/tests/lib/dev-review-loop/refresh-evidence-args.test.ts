/**
 * `refresh_evidence`'s argv regression guard. The live macOS gate found the
 * tool invoking `vinaya pr report --write` with no body-file, which `pr
 * report`'s own usage gate rejects before touching anything
 * (`Usage: vinaya pr report [--write <body-file> | --push <pr> …]`, exit 2).
 * The fix runs `--push <prNumber>`, the forge-updating mode. These tests pin
 * the exact argv and prove the real `vinaya pr report` parser accepts it —
 * it reaches the forge step instead of the usage refusal the old shape hit.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import { prReportRefreshArgs } from '../../../src/lib/dev-review-loop.js'

const INDEX = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src', 'index.ts')
const USAGE = 'Usage: vinaya pr report [--write <body-file> | --push <pr> [--body-file <path>]]'

type CliResult = { status: number; stdout: string; stderr: string }

function runCli(args: string[], cwd: string): CliResult {
  try {
    const stdout = execFileSync('bun', [INDEX, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env
    })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
  }
}

describe('refresh_evidence argv', () => {
  it('runs `pr report --push <prNumber>`, never the bare `--write` the usage gate rejects', () => {
    expect(prReportRefreshArgs(1055)).toEqual(['pr', 'report', '--push', '1055'])
  })

  it('the real `vinaya pr report` parser accepts the shape — it is not the usage refusal', () => {
    // A bare (non-git) temp dir: the valid `--push <n>` shape passes every
    // argument gate and reaches the live-body fetch, which fails for want of
    // a repo/remote (exit 1) — NOT the exit-2 usage refusal the old
    // `--write`-with-no-path shape produced. That is the whole regression.
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-refresh-evidence-args-'))
    try {
      const result = runCli(prReportRefreshArgs(1055), dir)
      expect(result.status).not.toBe(2)
      expect(`${result.stdout}${result.stderr}`).not.toContain(USAGE)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
