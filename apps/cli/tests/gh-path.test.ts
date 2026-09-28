// issue #836 — `vinaya` finds `gh` at its standard install locations when
// started with a PATH that lacks it.
//
// Two layers, matching the fix's own two halves:
//
//   - The pure planner (`planGhPathFix`/`ensureGhOnPath`, `src/lib/gh-path.ts`)
//     is proved directly: PATH already finds `gh` → left byte-for-byte
//     unchanged (O3); `gh` absent but a standard folder holds it → that folder
//     is APPENDED, never prepended, never reordering existing entries (O1);
//     `gh` nowhere → the searched folders are named (O2).
//
//   - The wiring is proved by a REAL CLI subprocess (`vinaya doctor --json`)
//     started with a trimmed PATH — one that genuinely lacks `gh` — and a fake
//     `gh` in a temporary folder standing in for a standard install location
//     via the `VINAYA_GH_STANDARD_DIRS` seam. This runs identically on Linux CI
//     and macOS: it never depends on the host actually having Homebrew or a
//     real `gh` at `/opt/homebrew/bin`.
import { afterEach, describe, expect, it } from 'bun:test'
import {
  accessSync,
  chmodSync,
  constants,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { ensureGhOnPath, GH_STANDARD_DIRS_ENV, planGhPathFix } from '../src/lib/gh-path'
import { spawnSyncBudgeted, stripVinayaEnv } from './lib/process-fixture'

const CLI_ENTRY = join(import.meta.dir, '..', 'src', 'index.ts')

const tempDirs: string[] = []
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** An empty temp folder — a PATH/standard entry that holds no `gh`. */
function emptyDir(): string {
  return tmp('gh-path-empty-')
}

/** A temp folder holding an executable file named `gh` (never actually run — resolution only checks existence + the executable bit). */
function ghDir(): string {
  const dir = tmp('gh-path-bin-')
  const p = join(dir, 'gh')
  writeFileSync(p, '#!/bin/sh\nexit 0\n')
  chmodSync(p, 0o755)
  return dir
}

describe('planGhPathFix / ensureGhOnPath (issue #836)', () => {
  it('leaves a PATH that already finds gh unchanged (O3)', () => {
    const onPath = ghDir()
    const env: NodeJS.ProcessEnv = { PATH: onPath, [GH_STANDARD_DIRS_ENV]: ghDir() }
    const plan = planGhPathFix(env)
    expect(plan.kind).toBe('already-on-path')
    if (plan.kind === 'already-on-path') expect(plan.dir).toBe(onPath)

    const before = env.PATH
    ensureGhOnPath(env)
    expect(env.PATH).toBe(before)
  })

  it('appends a standard folder holding gh, never reordering existing entries (O1)', () => {
    const existing = emptyDir()
    const standard = ghDir()
    const env: NodeJS.ProcessEnv = { PATH: existing, [GH_STANDARD_DIRS_ENV]: standard }
    const plan = planGhPathFix(env)
    expect(plan.kind).toBe('added')
    if (plan.kind === 'added') {
      expect(plan.dir).toBe(standard)
      // Appended after the existing entry, which stays first and intact.
      expect(plan.newPath).toBe(`${existing}${delimiter}${standard}`)
    }

    ensureGhOnPath(env)
    expect(env.PATH).toBe(`${existing}${delimiter}${standard}`)
  })

  it('reports the folders it searched when gh is nowhere (O2)', () => {
    const standard = emptyDir()
    const env: NodeJS.ProcessEnv = { PATH: emptyDir(), [GH_STANDARD_DIRS_ENV]: standard }
    const plan = planGhPathFix(env)
    expect(plan.kind).toBe('not-found')
    if (plan.kind === 'not-found') expect(plan.searched).toEqual([standard])

    const before = env.PATH
    ensureGhOnPath(env)
    expect(env.PATH).toBe(before)
  })

  it('prefers a gh already on PATH over a standard folder (O3)', () => {
    const onPath = ghDir()
    const standard = ghDir()
    const env: NodeJS.ProcessEnv = { PATH: onPath, [GH_STANDARD_DIRS_ENV]: standard }
    const plan = planGhPathFix(env)
    expect(plan.kind).toBe('already-on-path')
    if (plan.kind === 'already-on-path') expect(plan.dir).toBe(onPath)
  })
})

// ---------------------------------------------------------------------------
// The real-CLI subprocess proof.
// ---------------------------------------------------------------------------

/** Locate a command on the REAL PATH, resolving symlinks so the curated bin below points at the actual binary. */
function whichReal(cmd: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const p = join(dir, cmd)
    try {
      if (statSync(p).isFile()) {
        accessSync(p, constants.X_OK)
        return realpathSync(p)
      }
    } catch {
      // not here — keep looking
    }
  }
  return null
}

/**
 * A temp folder holding symlinks to just the tools the CLI subprocess needs
 * (`bun` to run it, `git` for repo detection, plus a few plumbing binaries) —
 * and deliberately NOT `gh`. Set as the child's entire PATH, this is a "trimmed
 * PATH that lacks gh" that still runs the CLI, without depending on the host's
 * `gh` living in a folder of its own (here it shares `/usr/bin` with `git`).
 */
function curatedBinWithoutGh(): string {
  const dir = tmp('gh-path-curated-')
  for (const cmd of [
    'bun',
    'git',
    'node',
    'sh',
    'bash',
    'env',
    'uname',
    'dirname',
    'basename',
    'cat',
    'mkdir',
    'rm',
    'ln',
    'cp',
    'mv',
    'ls',
    'grep',
    'sed'
  ]) {
    const real = whichReal(cmd)
    if (real) symlinkSync(real, join(dir, cmd))
  }
  return dir
}

/** A bare git repo directory, enough for `detectGitRepo`'s `git rev-parse` to succeed. */
function gitRepoDir(): string {
  const dir = tmp('gh-path-repo-')
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: dir, stdio: 'ignore' })
  return dir
}

type GhFinding = { check: string; severity: string; message: string }

function ghFindingFromDoctor(env: NodeJS.ProcessEnv, cwd: string): GhFinding {
  const result = spawnSyncBudgeted('bun', [CLI_ENTRY, 'doctor', '--json'], { cwd, encoding: 'utf8', env })
  let parsed: { data?: { findings?: GhFinding[] } }
  try {
    parsed = JSON.parse(result.stdout)
  } catch (err) {
    throw new Error(
      `doctor --json did not print parseable JSON (status ${result.status}): ${(err as Error).message}\n` +
        `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`
    )
  }
  const gh = (parsed.data?.findings ?? []).find((f) => f.check === 'gh')
  if (!gh) throw new Error(`doctor produced no [gh] finding.\n--- stdout ---\n${result.stdout}`)
  return gh
}

describe('vinaya doctor [gh] finding, real CLI with a trimmed PATH (issue #836)', () => {
  function baseEnv(pathValue: string, standardDirs: string): NodeJS.ProcessEnv {
    const home = tmp('gh-path-home-')
    return { ...stripVinayaEnv(), HOME: home, PATH: pathValue, [GH_STANDARD_DIRS_ENV]: standardDirs }
  }

  it('finds gh at a standard install location and reports it reachable (O1)', () => {
    const standard = ghDir()
    const env = baseEnv(curatedBinWithoutGh(), standard)
    const gh = ghFindingFromDoctor(env, gitRepoDir())
    expect(gh.severity).toBe('info')
    expect(gh.message).toContain(standard)
  })

  it('reports gh missing and where it looked when it is nowhere (O2)', () => {
    const standard = emptyDir()
    const env = baseEnv(curatedBinWithoutGh(), standard)
    const gh = ghFindingFromDoctor(env, gitRepoDir())
    expect(gh.severity).toBe('warn')
    expect(gh.message).toContain('not on PATH')
    expect(gh.message).toContain(standard)
  })

  it('uses a gh already on PATH and does not reach for a standard folder (O3)', () => {
    const onPath = ghDir()
    const standard = ghDir()
    const env = baseEnv(`${curatedBinWithoutGh()}${delimiter}${onPath}`, standard)
    const gh = ghFindingFromDoctor(env, gitRepoDir())
    expect(gh.severity).toBe('info')
    expect(gh.message).toContain(onPath)
    expect(gh.message).not.toContain(standard)
  })
})
