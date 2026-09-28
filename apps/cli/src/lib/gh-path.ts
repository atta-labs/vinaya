// Making `gh` reachable at process start — issue #836.
//
// Twenty-three source files invoke `gh` by name (`execFile('gh', …)`), and
// every one relies on the shell's own PATH lookup to find it. That lookup
// fails when the CLI is started with a PATH that does not contain gh's install
// folder — which is exactly how the Claude desktop app starts an Operator's
// task tools on macOS: `task-tools serve`'s PATH lacks `/opt/homebrew/bin`,
// where Homebrew keeps `gh`, so `loadTrustAnchorConfig`'s `gh api` cannot start
// and an unattended log sink with no anchor falls back to the local folder
// instead of the configured server. The same PATH breaks every other forge
// read.
//
// The fix is ONE place, at process start, in the CLI's entry path
// (`apps/cli/src/index.ts`): when `gh` is not already reachable, append a
// standard install folder that holds an executable `gh` to this process's own
// PATH. Every child process the CLI spawns inherits the amended PATH, so the
// twenty-three call sites keep invoking `gh` by name unchanged — the resolution
// is fixed once, never per call site. A PATH that already finds `gh` is left
// exactly as it was.

import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/**
 * `gh`'s standard install folders on macOS/Linux, in the order the fix appends
 * them. Homebrew on Apple Silicon installs to `/opt/homebrew/bin`; Intel
 * Homebrew and most manual installs use `/usr/local/bin`. The Claude desktop
 * app on macOS starts an Operator's task tools with a PATH that contains
 * neither, which is the incident this list exists for (#836).
 */
export const STANDARD_GH_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'] as const

/**
 * Test seam: a colon/`;`-delimited override for `STANDARD_GH_DIRS`, so a test
 * can stand a fake `gh` in a temporary folder in place of a real Homebrew
 * location it cannot write to (the same folders "standing in for a standard
 * location" the brief names). It grants no capability PATH itself does not
 * already grant — the caller composing the process environment could set PATH
 * directly — so it is not a new trust surface, only a stand-in for the
 * hardcoded folders during a test.
 */
export const GH_STANDARD_DIRS_ENV = 'VINAYA_GH_STANDARD_DIRS'

/** The executable names `gh` can carry, by platform — mirrors doctor.ts's own `diagnoseVinayaOnPath` list. */
export function ghExecutableNames(): string[] {
  return process.platform === 'win32' ? ['gh.exe', 'gh.cmd', 'gh.bat'] : ['gh']
}

function standardDirs(env: NodeJS.ProcessEnv): string[] {
  const override = env[GH_STANDARD_DIRS_ENV]
  if (override && override.trim().length > 0) return override.split(delimiter).filter(Boolean)
  return [...STANDARD_GH_DIRS]
}

/** A regular, executable file — a bare `existsSync` would count a directory named `gh` or a non-executable file. */
function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function dirHoldsGh(dir: string, names: string[]): boolean {
  return names.some((name) => isExecutableFile(join(dir, name)))
}

export type GhPathPlan =
  /** `gh` already resolves on the current PATH, at `dir` — PATH is left unchanged (O3). */
  | { kind: 'already-on-path'; dir: string }
  /** `gh` was not on PATH but a standard folder `dir` holds it; `newPath` appends that folder (O1). */
  | { kind: 'added'; dir: string; newPath: string }
  /** `gh` is neither on PATH nor at any standard folder; `searched` is where the standard lookup looked (O2). */
  | { kind: 'not-found'; searched: string[] }

/**
 * Decides, without mutating anything, what should happen to `env.PATH` so `gh`
 * resolves. Read-only, so `vinaya doctor` (which never mutates) can call it to
 * report the same fact the entry-path fix acts on.
 *
 * A standard folder is only ever APPENDED, never prepended, and existing PATH
 * entries are never reordered or removed — a `gh` the caller already put on
 * PATH keeps winning, and nothing else the caller relies on PATH order for
 * changes.
 */
export function planGhPathFix(env: NodeJS.ProcessEnv = process.env): GhPathPlan {
  const names = ghExecutableNames()
  const currentPath = env.PATH ?? ''
  const onPath = currentPath
    .split(delimiter)
    .filter(Boolean)
    .find((dir) => dirHoldsGh(dir, names))
  if (onPath !== undefined) return { kind: 'already-on-path', dir: onPath }

  const searched = standardDirs(env)
  for (const dir of searched) {
    if (dirHoldsGh(dir, names)) {
      const newPath = currentPath.length > 0 ? `${currentPath}${delimiter}${dir}` : dir
      return { kind: 'added', dir, newPath }
    }
  }
  return { kind: 'not-found', searched }
}

/**
 * Applies `planGhPathFix` to `env` (default `process.env`): when `gh` is not
 * reachable but a standard folder holds it, appends that folder to `env.PATH`.
 * Returns the plan so a caller can report what happened. The only mutation is
 * the `added` case; `already-on-path` and `not-found` leave `env` untouched.
 */
export function ensureGhOnPath(env: NodeJS.ProcessEnv = process.env): GhPathPlan {
  const plan = planGhPathFix(env)
  if (plan.kind === 'added') env.PATH = plan.newPath
  return plan
}
