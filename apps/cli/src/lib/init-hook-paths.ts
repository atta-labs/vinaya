/**
 * The git-hook paths `vinaya init` emits, kept apart from `artifacts.ts` so a
 * check bin can list them without bundling the whole init surface: that
 * module's import graph reaches other checks' entrypoints, which run their
 * `main()` at import time. `artifacts.ts`'s `buildInitOps` emits one managed
 * block per name in `INIT_HOOK_NAMES` under the chosen `HookDir`; a parity test
 * (`tests/checks/registry-gates.test.ts`) fails when the two drift.
 */

/**
 * The tracked hook directory — the default install target since
 * a real migration. Unlike `.git/hooks` (which git never versions, so a
 * fresh clone silently has NO ring-0 enforcement), files here are committed
 * and travel with the repo; `core.hooksPath` (relative, shared config) routes
 * git at them in the primary checkout and every linked worktree alike. The
 * irreducible per-clone residue is one `git config core.hooksPath
 * .vinaya/hooks` — `doctor` reports it whenever it is missing.
 */
export const TRACKED_HOOK_DIR = '.vinaya/hooks'

export type HookDir = '.husky' | '.git/hooks' | typeof TRACKED_HOOK_DIR

export const HOOK_DIRS: readonly HookDir[] = ['.husky', '.git/hooks', TRACKED_HOOK_DIR]

/** The git hooks `buildInitOps` installs into whichever `HookDir` it is given. */
export const INIT_HOOK_NAMES = ['pre-commit', 'pre-push', 'commit-msg'] as const

/** Every hook path `vinaya init` can emit: one per hook name per install directory. */
export function initHookPaths(): string[] {
  return HOOK_DIRS.flatMap((dir) => INIT_HOOK_NAMES.map((name) => `${dir}/${name}`))
}
