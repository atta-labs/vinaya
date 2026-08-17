import { execFileSync, execSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadTrancheSweep } from './verify-coherence'

/**
 * The two git readers spawn `git` with an argv array, never a shell string
 * (security pass round 3, MEDIUM 2).
 *
 * `listDirAtRef` and `readFileAtRef` interpolate a ref and a path into git's
 * own `<ref>:<path>` operand. One of those paths is assembled from a Milestone
 * title, which anyone with write access to the repo chooses; the refs are
 * code-supplied today, but the property that makes both safe is the spawn
 * form, not the current call sites — and call sites move, as this task's own
 * three enumeration rewrites show.
 *
 * Each case feeds a live command-substitution payload through one of the two
 * sinks and asserts the command did not run. The final case is the instrument
 * check: it runs the identical payload through a shell string and asserts the
 * marker DOES appear, so a green result above cannot be an inert payload.
 */

const marker = (name: string): string => join(tmpdir(), `aeg-shell-safety-${process.pid}-${name}`)

/** `git`-legal on its own; a command substitution only if something hands it to a shell. */
const payloadFor = (path: string): string => `$(touch ${path})`

const SLUG = 'zzz-shell-safety-fixture'
const ACTIVE_PATH = `aeg-root/tranches/${SLUG}.md`

/** A commit on top of `origin/main` carrying one synthetic topology file. */
function commitWithTrancheFile(): string {
  const indexFile = execFileSync('mktemp', { encoding: 'utf8' }).trim()
  const env = { ...process.env, GIT_INDEX_FILE: indexFile }
  const content = ['# Tranche: synthetic', '', 'Lifecycle: active', '', 'Goal: shell-safety fixture.', ''].join('\n')

  execFileSync('git', ['read-tree', 'origin/main'], { env })
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { input: content, encoding: 'utf8', env })
    .toString()
    .trim()
  execFileSync('git', ['update-index', '--add', '--cacheinfo', `100644,${blob},${ACTIVE_PATH}`], { env })
  const tree = execFileSync('git', ['write-tree'], { env, encoding: 'utf8' }).trim()
  const commit = execFileSync('git', ['commit-tree', tree, '-p', 'origin/main', '-m', 'shell-safety fixture'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_INDEX_FILE: indexFile,
      GIT_AUTHOR_NAME: 'AEG test fixture',
      GIT_AUTHOR_EMAIL: 'aeg-test-fixture@localhost',
      GIT_COMMITTER_NAME: 'AEG test fixture',
      GIT_COMMITTER_EMAIL: 'aeg-test-fixture@localhost'
    }
  }).trim()
  execFileSync('rm', ['-f', indexFile])
  return commit
}

describe('the sweep spawns git, never a shell', () => {
  it('does not execute a payload reaching the directory listing', async () => {
    const path = marker('ls-tree')
    rmSync(path, { force: true })

    // `baseRef` reaches `listDirAtRef(ref, relDir)` — the enumeration sink.
    const sweep = await loadTrancheSweep(null, SLUG, `origin/main${payloadFor(path)}`)

    expect(existsSync(path)).toBe(false)
    // An unresolvable ref is simply an empty listing, the same as an absent directory.
    expect(sweep.files.filter((f) => f.slug === SLUG)).toHaveLength(0)
  }, 60_000)

  it('does not execute a payload reaching the file read', async () => {
    const path = marker('show')
    rmSync(path, { force: true })
    const base = commitWithTrancheFile()

    // The head ref reaches `readFileAtRef(ref, relPath)` — the content sink —
    // because the candidate is enumerated from the (clean) base ref and then
    // read from the (hostile) head ref.
    const sweep = await loadTrancheSweep(
      { prHeadSha: `${base}${payloadFor(path)}`, touchedFiles: new Set([ACTIVE_PATH]) },
      SLUG,
      base
    )

    expect(existsSync(path)).toBe(false)
    // Unreadable at the head reads as "removed by this PR", not as content.
    expect(sweep.files.filter((f) => f.slug === SLUG)).toHaveLength(0)
  }, 60_000)

  it('instrument check — the same payload does run when a shell string is used', () => {
    const path = marker('control')
    rmSync(path, { force: true })

    try {
      execSync(`git ls-tree --name-only origin/main${payloadFor(path)}:aeg-root`, { stdio: 'ignore' })
    } catch {
      // git's own exit code is irrelevant: the substitution runs before git does.
    }

    expect(existsSync(path)).toBe(true)
    rmSync(path, { force: true })
  })
})
