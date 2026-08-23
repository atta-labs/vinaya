import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * No tracked file may contain a NUL byte.
 *
 * A single NUL makes git classify the whole FILE as binary, and that removes it
 * from every text tool this repo's verification rests on:
 *
 *   - `git diff` reports `Bin 3715 -> 3716 bytes, 0 insertions(+), 0 deletions(-)`.
 *     A reviewer opening a PR that changes the file is shown no diff at all.
 *   - `git grep -n` answers `Binary file <path> matches` with no line number, so
 *     a sweep looking for `file:line:` hits reads it as a near-miss or drops it.
 *   - `--numstat` emits `-` for both counts, so any gate deriving line totals
 *     from it undercounts the change silently.
 *
 * This is not hypothetical. `parse-registry.ts` held a NUL sentinel written as a
 * literal control character from atta-labs/vinaya#461 until the commit that added
 * this test. For that whole period the file was invisible to `git grep`, which is
 * how a second `stripBackticks` living there survived several verification passes
 * unnoticed. Writing the sentinel as a `\\u0000` escape produces the identical
 * byte at runtime and keeps the file text.
 *
 * The check is exhaustive rather than extension-filtered: at the time it was
 * written no tracked file in the repo contained a NUL, so there is nothing to
 * exempt. A genuine binary asset landing later should be added to EXEMPT with a
 * reason, which is a deliberate act rather than a silent one.
 */
const EXEMPT: readonly string[] = []

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()

const NUL = 0

function trackedFiles(): string[] {
  const raw = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024
  }).toString('utf8')
  return raw.split(String.fromCharCode(NUL)).filter((p) => p.length > 0)
}

describe('no tracked file is binary to git', () => {
  it('finds no NUL byte in any tracked file', () => {
    const offenders: string[] = []
    for (const rel of trackedFiles()) {
      if (EXEMPT.includes(rel)) continue
      const abs = join(REPO_ROOT, rel)
      // A tracked path can be absent from the worktree (sparse checkout), or be
      // a submodule gitlink, which `ls-files` reports as an ordinary entry.
      let size: number
      try {
        const st = statSync(abs)
        if (!st.isFile()) continue
        size = st.size
      } catch {
        continue
      }
      if (size === 0) continue
      if (readFileSync(abs).includes(NUL)) offenders.push(rel)
    }
    expect(
      offenders,
      'These files contain a NUL byte, so git treats them as binary: no reviewable diff, and no line numbers from `git grep`. Write the NUL as a `\\u0000` escape in source, or add the path to EXEMPT with a reason if it is a real binary asset.'
    ).toEqual([])
  })

  it('reads a non-trivial number of files — a guard on the enumeration itself', () => {
    expect(trackedFiles().length).toBeGreaterThan(100)
  })
})
