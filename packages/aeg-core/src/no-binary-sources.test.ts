import { execFileSync } from 'node:child_process'
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * No tracked file is binary to git — neither a NUL byte nor a `.gitattributes`
 * `binary` marking.
 *
 * A NUL byte makes git classify the whole FILE as binary, and that removes it
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
 * literal control character for a real stretch of history until the commit that added
 * this test. For that whole period the file was invisible to `git grep`, which is
 * how a second `stripBackticks` living there survived several verification passes
 * unnoticed. Writing the sentinel as a `\\u0000` escape produces the identical
 * byte at runtime and keeps the file text.
 *
 * A `.gitattributes` `binary` marking reproduces the identical hole without a
 * NUL byte anywhere in the file: `git grep` answers `Binary file … matches`
 * with no line number purely because the attribute says so (a real finding)
 * — the original NUL-only assertion never consulted it, so a file
 * marked this way stayed invisible to this gate while its own docstring
 * (honestly) never claimed to catch it.
 *
 * Both sweeps are exhaustive rather than extension-filtered: at the time this
 * was written no tracked file in the repo tripped either one, so there is
 * nothing to exempt. A genuine binary asset landing later should be added to
 * EXEMPT with a reason, which is a deliberate act rather than a silent one.
 */
const EXEMPT: readonly string[] = []

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()

const NUL = 0

function trackedFiles(repoRoot: string = REPO_ROOT): string[] {
  const raw = execFileSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024
  }).toString('utf8')
  return raw.split(String.fromCharCode(NUL)).filter((p) => p.length > 0)
}

/**
 * Every tracked path whose `binary` gitattribute is explicitly `set`, via one
 * batched `git check-attr --stdin -z` call — not one subprocess per file.
 * Measured live against this repo's ~500 tracked files: the batched form
 * runs in single-digit milliseconds; a naive per-file `execFileSync` loop
 * over the same set takes seconds. That gap is the whole reason this widens
 * the assertion instead of only renaming it (that same finding's stop
 * condition on real per-file cost).
 */
function gitattributesBinaryOffenders(files: string[], repoRoot: string = REPO_ROOT): string[] {
  if (files.length === 0) return []
  const input = files.map((f) => `${f}\0`).join('')
  const out = execFileSync('git', ['check-attr', '--stdin', '-z', 'binary'], {
    cwd: repoRoot,
    input,
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'utf8'
  })
  const fields = out.split(String.fromCharCode(NUL)).filter((f) => f.length > 0)
  const offenders: string[] = []
  for (let i = 0; i + 2 < fields.length + 1; i += 3) {
    const [path, , value] = [fields[i], fields[i + 1], fields[i + 2]]
    if (value === 'set' && path !== undefined) offenders.push(path)
  }
  return offenders
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
        // `lstat`, not `stat`: a tracked symlink is a link, and following one
        // reads a file outside the worktree that git does not track.
        const st = lstatSync(abs)
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

  // Counting what `ls-files` LISTS proves nothing: a sparse checkout lists
  // every path and reads none, so the sweep above would pass vacuously. This
  // counts files actually opened.
  it('actually reads a non-trivial number of files — a guard on the sweep, not the listing', () => {
    let read = 0
    for (const rel of trackedFiles()) {
      const abs = join(REPO_ROOT, rel)
      try {
        if (!lstatSync(abs).isFile()) continue
      } catch {
        continue
      }
      readFileSync(abs)
      read++
    }
    expect(read).toBeGreaterThan(100)
  })

  it('finds no tracked file marked binary in .gitattributes', () => {
    const files = trackedFiles().filter((rel) => !EXEMPT.includes(rel))
    const offenders = gitattributesBinaryOffenders(files)
    expect(
      offenders,
      "These files are marked `binary` in .gitattributes, so git treats them as binary even though no byte in them is a NUL: no reviewable diff, and `git grep` answers 'Binary file … matches' with no line number. Remove the attribute, or add the path to EXEMPT with a reason if it is a real binary asset."
    ).toEqual([])
  })
})

describe('gitattributesBinaryOffenders — the live case Finding 3 exists to close', () => {
  let scratchRepo: string

  beforeEach(() => {
    scratchRepo = mkdtempSync(join(tmpdir(), 'aeg-no-binary-sources-'))
    execFileSync('git', ['init', '--quiet'], { cwd: scratchRepo })
  })

  afterEach(() => {
    rmSync(scratchRepo, { recursive: true, force: true })
  })

  it('catches a file marked binary in .gitattributes even though it contains no NUL byte', () => {
    writeFileSync(join(scratchRepo, 'notes.txt'), 'plain text, no NUL byte anywhere in here\n', 'utf8')
    writeFileSync(join(scratchRepo, '.gitattributes'), 'notes.txt binary\n', 'utf8')
    execFileSync('git', ['add', '.'], { cwd: scratchRepo })

    // Reproduces the hole the docstring above describes: `git grep` exits 0
    // (a match WAS found) but prints no line number — it reports the file as
    // binary instead, exactly as if it held a real NUL byte. Proves this is
    // the same class of hole, not a cosmetic difference.
    const grepOutput = execFileSync('git', ['grep', '-n', 'plain text'], { cwd: scratchRepo, encoding: 'utf8' })
    expect(grepOutput).toMatch(/Binary file .* matches/)

    const offenders = gitattributesBinaryOffenders(trackedFiles(scratchRepo), scratchRepo)
    expect(offenders).toEqual(['notes.txt'])
  })

  it('does not flag an ordinary tracked text file with no .gitattributes at all', () => {
    writeFileSync(join(scratchRepo, 'notes.txt'), 'plain text\n', 'utf8')
    execFileSync('git', ['add', '.'], { cwd: scratchRepo })
    expect(gitattributesBinaryOffenders(trackedFiles(scratchRepo), scratchRepo)).toEqual([])
  })
})
