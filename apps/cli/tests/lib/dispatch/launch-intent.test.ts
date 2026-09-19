/**
 * O1: launch intent is persisted BEFORE the child is spawned. Exercised
 * through the real `vinaya dispatch` CLI entry point (`execFileSync('bun',
 * [INDEX, ...])`, same discipline and the same scratch-`HOME`/non-git-`cwd`
 * reasoning as `apps/cli/tests/lib/dispatch.test.ts`'s own header): a fresh
 * subprocess per test, its own scratch `HOME` so `dispatchRole`'s durable
 * writes land in a temp `~/.vinaya`, never the developer machine's.
 *
 * The proof that intent PRECEDES spawn is observational: the fake vendor, the
 * moment it starts, reads back its own launch record and copies it to a file
 * the test inspects. If that record already exists — status `launched` — by
 * the time the child runs, the parent must have written it before spawning.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const INDEX = join(CLI_ROOT, 'src', 'index.ts')

/** `PATH` minus any dir carrying a real vendor binary — so the fake fixture, not an installed `claude`, is exercised (see `dispatch.test.ts`'s own note). */
function pathWithoutRealVendors(): string {
  const dirs = (process.env.PATH ?? '').split(':').filter(Boolean)
  return dirs.filter((d) => !['claude', 'codex', 'gemini'].some((v) => existsSync(join(d, v)))).join(':')
}

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

describe('dispatchRole — launch intent precedes spawn (O1)', () => {
  it('the launch record exists, status launched, by the time the child starts', () => {
    const home = tempDir('vinaya-launch-home-')
    const cwd = tempDir('vinaya-launch-cwd-')
    const binDir = tempDir('vinaya-launch-bin-')
    const seenRecordFile = join(cwd, 'seen-record.json')
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, 'do the thing')

    // A non-git cwd resolves `resolveRepo()` to null → the `unresolved` bucket;
    // with no `--task`/`--pr` the scope is `unscoped`. The fake copies its own
    // launch record — written before this child was spawned — to a file the
    // test reads back.
    const recordPath = join(
      home,
      '.vinaya',
      'runtime',
      'unresolved',
      'tasks-execution',
      'unscoped',
      'sessions',
      'developer-claude.json'
    )
    writeFileSync(
      join(binDir, 'claude'),
      `#!/bin/sh\ncat "${recordPath}" > "${seenRecordFile}" 2>/dev/null\ncat > /dev/null\nprintf '%s' '{"session_id":"sess-x","usage":{"input_tokens":1,"output_tokens":1}}'\nexit 0\n`
    )
    chmodSync(join(binDir, 'claude'), 0o755)

    let status = 0
    try {
      execFileSync('bun', [INDEX, 'dispatch', 'developer', '--agent', 'claude', '--prompt-file', promptFile], {
        encoding: 'utf8',
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, HOME: home, PATH: `${binDir}:${pathWithoutRealVendors()}` }
      })
    } catch (e) {
      status = (e as { status?: number }).status ?? 1
    }
    expect(status).toBe(0)

    // The child saw its own launch record — so intent was persisted before the
    // spawn, not after the child produced output.
    expect(existsSync(seenRecordFile)).toBe(true)
    const seen = JSON.parse(readFileSync(seenRecordFile, 'utf8')) as { status: string; role: string; runId: string }
    expect(seen.status).toBe('launched')
    expect(seen.role).toBe('developer')
    expect(seen.runId.length).toBeGreaterThan(0)
  })
})
