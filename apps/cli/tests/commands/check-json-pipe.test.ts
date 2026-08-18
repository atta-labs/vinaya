import { beforeAll, describe, expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Regression for the pipe-vs-file stdout-flush defect (Issue #127):
 * `check.ts` wrote its `--json` payload with `process.stdout.write` and then
 * called `process.exit()` on the next line. On a PIPE, Node's stdout is
 * asynchronous, so `process.exit()` tears the process down before the
 * pending write flushes — anything above the reading pipe's buffer is lost.
 * A file redirect is synchronous and does not expose the bug at all, which
 * is exactly how it shipped undetected.
 *
 * This test therefore spawns a real `node` subprocess against the built
 * `dist/index.js` (Bun does not reproduce this bug — measured separately)
 * and captures stdout through a real OS pipe, never a file redirect and
 * never an in-process call.
 */

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DIST_INDEX = join(CLI_ROOT, 'dist', 'index.js')

// Not a claim about any pipe buffer's size — just a threshold comfortably
// above every plausible one, so the test isn't vacuous on a system with a
// larger default buffer than the one this bug was measured against.
const FINDINGS_COUNT = 4000
const MIN_PAYLOAD_BYTES = 300 * 1024

function fixtureCheckScript(): string {
  // Deliberately does NOT call process.exit() — a piped stderr write is
  // itself asynchronous, and an explicit exit here would reproduce this
  // exact bug one level down, truncating the fixture's OWN findings before
  // the runner's parent finishes reading them. Letting Node exit naturally
  // once the event loop drains is what a well-behaved check does, and is
  // exactly what this fixture needs to emit its full findings set.
  return `#!/usr/bin/env node
for (let i = 0; i < ${FINDINGS_COUNT}; i++) {
  const finding = {
    schema: 1,
    check: 'myteam/bigcheck',
    severity: 'error',
    message: 'synthetic finding #' + i + ' — ' + 'm'.repeat(140),
    agent_recovery_prompt: 'synthetic recovery prompt padding ' + 'r'.repeat(100)
  }
  process.stderr.write(JSON.stringify(finding) + '\\n')
}
`
}

function writeFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-check-json-pipe-'))
  const scriptPath = join(dir, 'bigcheck.js')
  writeFileSync(scriptPath, fixtureCheckScript(), 'utf-8')
  // A missing exec bit surfaces as EACCES, not the defect under test.
  chmodSync(scriptPath, 0o755)
  writeFileSync(
    join(dir, 'vinaya.config.json'),
    JSON.stringify({ checks: { 'myteam/bigcheck': { run: scriptPath, scope: 'full' } } }),
    'utf-8'
  )
  return dir
}

beforeAll(async () => {
  // Always rebuild rather than trusting a possibly-stale dist/ from a prior
  // session — a stale bundle would silently test the WRONG code.
  const build = Bun.spawnSync(['bun', 'run', '--cwd', CLI_ROOT, 'build'], { stdout: 'pipe', stderr: 'pipe' })
  if (build.exitCode !== 0) {
    throw new Error(`apps/cli build failed:\n${build.stderr.toString()}`)
  }
}, 120_000)

describe('vinaya check --json — pipe flush (Issue #127)', () => {
  it('emits the complete JSON payload through a real node subprocess pipe, above the pipe buffer', async () => {
    const repoDir = writeFixtureRepo()
    try {
      const proc = Bun.spawn(['node', DIST_INDEX, 'check', 'myteam/bigcheck', '--json'], {
        cwd: repoDir,
        stdout: 'pipe',
        stderr: 'pipe'
      })
      const stdout = await new Response(proc.stdout).text()
      await proc.exited

      expect(stdout.length).toBeGreaterThan(MIN_PAYLOAD_BYTES)

      const parsed = JSON.parse(stdout)
      expect(parsed.schema).toBe(1)
      expect(parsed.data.checks[0].errors.length).toBe(FINDINGS_COUNT)
    } finally {
      rmSync(repoDir, { recursive: true, force: true })
    }
  }, 30_000)
})
