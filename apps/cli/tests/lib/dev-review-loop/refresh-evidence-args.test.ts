/**
 * `refresh_evidence`'s argv regression guard. The live macOS gate found the
 * tool invoking `vinaya pr report --write` with no body-file, which `pr
 * report`'s own usage gate rejects before touching anything
 * (`Usage: vinaya pr report [--write <body-file> | --push <pr> …]`, exit 2).
 * The fix runs `--push <prNumber>`, the forge-updating mode. These tests pin
 * the exact argv and prove the real `vinaya pr report` parser accepts it —
 * it reaches the forge step instead of the usage refusal the old shape hit.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import { prReportRefreshArgs } from '../../../src/lib/dev-review-loop.js'
import { spawnSyncBudgeted, stripVinayaEnv } from '../process-fixture.js'

const INDEX = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src', 'index.ts')
const USAGE = 'Usage: vinaya pr report [--write <body-file> | --push <pr> [--body-file <path>]]'

describe('refresh_evidence argv', () => {
  it('runs `pr report --push <prNumber>`, never the bare `--write` the usage gate rejects', () => {
    expect(prReportRefreshArgs(1055)).toEqual(['pr', 'report', '--push', '1055'])
  })

  it('the real `vinaya pr report` parser accepts the shape — it is not the usage refusal', () => {
    // A bare (non-git) temp dir: the valid `--push <n>` shape passes every
    // argument gate and reaches the live-body fetch, which fails for want of
    // a repo/remote — NOT the exit-2 usage refusal the old `--write`-with-no
    // -path shape produced. That is the whole regression. Run through the
    // shared budgeted/VINAYA_-stripped helper so this fixture leaks no runtime
    // dir into the child and is killed with a diagnostic if it ever hangs.
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-refresh-evidence-args-'))
    try {
      const result = spawnSyncBudgeted('bun', [INDEX, ...prReportRefreshArgs(1055)], {
        cwd: dir,
        encoding: 'utf8',
        env: stripVinayaEnv()
      })
      expect(result.status).not.toBe(2)
      expect(`${result.stdout}${result.stderr}`).not.toContain(USAGE)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
