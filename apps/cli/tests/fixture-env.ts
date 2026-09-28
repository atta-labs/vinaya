/**
 * Isolation from the caller's own ambient environment, for the test files that
 * create a throwaway repository and then run this CLI inside it — the ones
 * whose fixture is only a fixture for as long as nothing leaks in.
 *
 * Two classes of variable leak, both observed live:
 *
 * `GIT_*` — `GIT_DIR` overrides git's directory discovery for every child that
 * inherits it, whatever that child's own working directory is, so a fixture
 * test running under an inherited `GIT_DIR` performs its `git init`, `git
 * add`, `git commit` and `git checkout` calls against whatever repository the
 * variable names. The damage is not hypothetical: a run of `demo.test.ts`
 * under a leaked `GIT_DIR` set `core.bare=true` on the real checkout and
 * committed its fixture brief onto two of its branches. Git itself sets these
 * when it runs a hook (`githooks(5)`), which is where the leak came from. The
 * whole prefix is dropped rather than a named subset: `GIT_DIR`,
 * `GIT_WORK_TREE`, `GIT_INDEX_FILE` and `GIT_PREFIX` redirect the fixture,
 * `GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>` inject configuration into it,
 * and `GIT_TRACE2*` interleaves trace output into the git output these tests
 * parse — one rule needs no upkeep as git grows more of them.
 *
 * `PR_BODY`/`PR_NUMBER`/`BRANCH` — the pull-request grading context. The
 * fixture installs this repository's own generated hooks and then really
 * commits and pushes through them, so `vinaya check` runs inside it for real;
 * with a `PR_BODY` inherited from the caller, those body-scoped checks grade
 * the CALLER's pull-request body from inside the fixture and refuse the
 * fixture's own commit or push. A caller that exports one is ordinary, not
 * exotic — `vinaya pr report` runs every Test-plan command with `PR_BODY` set,
 * which is exactly how `quickstart.test.ts` came to fail three tests under it
 * while passing everywhere else.
 *
 * Restore is unconditional and total — the returned callback puts back exactly
 * what was there, so a later test file in the same runner process never
 * inherits this file's own stripping.
 */
const FIXTURE_HOSTILE_ENV_NAMES = ['PR_BODY', 'PR_NUMBER', 'BRANCH'] as const

export function stripAmbientFixtureEnv(): () => void {
  const saved: Record<string, string | undefined> = {}
  const drop = (key: string): void => {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GIT_')) drop(key)
  }
  for (const key of FIXTURE_HOSTILE_ENV_NAMES) {
    if (process.env[key] !== undefined) drop(key)
  }
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}
