/**
 * Isolation from an ambient `GIT_*` environment, for the test files that
 * create and operate on their OWN throwaway git fixture.
 *
 * `GIT_DIR` overrides git's directory discovery for every child process that
 * inherits it, whatever that child's own working directory is — so a fixture
 * test running under an inherited `GIT_DIR` performs its `git init`, `git
 * add`, `git commit` and `git checkout` calls against whatever repository
 * that variable names instead of its own temporary one. The concrete damage
 * is not hypothetical: a run of this repository's own `demo.test.ts` under a
 * leaked `GIT_DIR` set `core.bare=true` on the real checkout and committed
 * its fixture brief onto two of its branches.
 *
 * The generated `pre-push` hook clears these variables before the test run it
 * starts, which is where git itself sets them (`githooks(5)`); this helper is
 * the same guarantee owned by the tests that actually depend on it, so the
 * fixture stays the fixture under any runner, under any hook, and under a
 * runner a caller started with `GIT_DIR` already exported.
 *
 * Every `GIT_*` name is dropped, not a named subset: `GIT_DIR`,
 * `GIT_WORK_TREE`, `GIT_INDEX_FILE` and `GIT_PREFIX` redirect the fixture,
 * `GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>` inject configuration into it,
 * and `GIT_TRACE2*` interleaves trace output into the git output these tests
 * parse. One rule needs no upkeep as git grows more of them.
 *
 * Restore is unconditional and total — the returned callback puts back
 * exactly what was there, so a later test file in the same runner process
 * never inherits this file's own stripping.
 */
export function stripAmbientGitEnv(): () => void {
  const saved: Record<string, string | undefined> = {}
  for (const key of Object.keys(process.env)) {
    if (!key.startsWith('GIT_')) continue
    saved[key] = process.env[key]
    delete process.env[key]
  }
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}
