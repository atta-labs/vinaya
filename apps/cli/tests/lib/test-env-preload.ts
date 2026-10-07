/**
 * `[test] preload` (see `apps/cli/bunfig.toml`) — runs once, before any test
 * file in this package, in every `bun test` invocation that has `apps/cli`
 * as its working directory: a local `bun test`, the pre-push hook's
 * selected-file run, and CI's own sharded `bun test ... $(tr '\n' ' ' <
 * tests/ci-shards/shard-N.txt)` (`.github/workflows/ci.yml`).
 *
 * Two classes of ambient env this test PROCESS's own env must never carry
 * into a test, at the root, once, rather than at every individual fixture
 * that happens to spawn a real subprocess or call something in-process:
 *
 *  - `GITHUB_ACTIONS` — the CI runner sets this for the whole job. Left in
 *    place, any test's own log() call (in-process, or in a real subprocess
 *    that inherits `process.env`) resolves its destination through
 *    `log-sink.ts`'s CI branch to `{kind:'none'}` (no `logs.url` is
 *    configured for any fixture here) or prints a one-per-process "not
 *    recording" line to stderr — breaking a fixture that polls its own
 *    outbox for a landed event, or one that parses a spawned child's stderr
 *    as pure JSON. #721 fixed the same leak for the in-process loop
 *    harness's own `withWorldEnv`; per-fixture patches then chased it
 *    across every individual real-subprocess helper (`stripVinayaEnv` and
 *    its several local duplicates, `dev-review-loop.test.ts`'s own
 *    `fixtureChildEnv`) — but `checks/prose-gates-doctrine-root.test.ts`
 *    spawns check binaries with a raw, un-stripped `process.env` and was
 *    missed by that per-helper sweep, the exact gap this preload closes at
 *    the root instead: nothing downstream — in-process or a spawned child
 *    that inherits `process.env` verbatim — can see a `GITHUB_ACTIONS` this
 *    process's own env never carries once this runs.
 *  - `VINAYA_HOST`/`VINAYA_ROLE`/`VINAYA_ATTEMPT`/`VINAYA_PARENT_EVENT` —
 *    the dispatch-identity keys a REAL dispatched Developer/Reviewer
 *    session (this one included) sets on itself; #721's own
 *    `OWNED_ENV_KEYS` clears the same four for the in-process harness for
 *    the identical reason. Every existing fixture that strips `VINAYA_*` by
 *    prefix already covers these; cleared here too so a fixture that does
 *    NOT (the same `prose-gates-doctrine-root.test.ts` class of gap) never
 *    depends on running from a non-dispatched shell to pass.
 *
 * A test that deliberately EXERCISES the CI/dispatch-identity behavior
 * (`checks/runner/correlation.test.ts`'s "a CI-invoked run (GITHUB_ACTIONS
 * set) reads meta.host: 'ci'", `log-destination.test.ts`'s `CI_ENV`,
 * `dev-review-loop/inproc-1.test.ts`'s save/set/restore of
 * `process.env.GITHUB_ACTIONS`/`VINAYA_ROLE`) always sets the value it
 * needs itself — as an explicit `LogSinkDeps.env`/subprocess `env`
 * override, or by mutating and restoring `process.env` inside its own
 * `it(...)`, both of which run AFTER this preload and are untouched by it.
 */
import { afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exemptPrefixes, PROCESS_START_MS, realRuntimeDir, touchedSince } from './real-runtime-guard-core'

for (const key of ['GITHUB_ACTIONS', 'VINAYA_HOST', 'VINAYA_ROLE', 'VINAYA_ATTEMPT', 'VINAYA_PARENT_EVENT']) {
  delete process.env[key]
}

/**
 * `VINAYA_RUNTIME_DIR` — a dispatched session carries it (the driver hands its
 * runtime directory down), a CI runner or an operator's shell does not. Left
 * unset, anything a test reaches through `runtimeDirForThisRepo()` — the
 * test-run cache `pr report` writes, a driver log — resolves to the real
 * `~/.vinaya/runtime/<owner>-<repo>`, so the same suite wrote into the real
 * directory on CI and an operator's machine while staying clean in a
 * dispatched run. Pointing it at a private temporary directory makes every
 * environment behave like the dispatched one. A test that needs the default
 * resolution (or a different directory) sets or deletes the key itself, as
 * the ones that already run with it set do. `real-runtime-guard.test.ts`
 * still fails a test that reaches the real directory some other way, such as
 * a spawned child with `VINAYA_*` stripped.
 */
let privateRuntimeDir: string | null = null
if (!process.env.VINAYA_RUNTIME_DIR) {
  privateRuntimeDir = mkdtempSync(join(tmpdir(), 'vinaya-test-runtime-'))
  process.env.VINAYA_RUNTIME_DIR = privateRuntimeDir
}

/**
 * Once, after every test file this process ran: remove the private runtime
 * directory above, and fail the run if any test wrote into the REAL runtime
 * directory (`real-runtime-guard-core.ts`). A preload `afterAll` is the one
 * hook every test process loads, so each CI shard and each local run is
 * covered, whichever files it was given.
 */
afterAll(() => {
  if (privateRuntimeDir) rmSync(privateRuntimeDir, { recursive: true, force: true })
  const leaked = touchedSince(realRuntimeDir(), PROCESS_START_MS, exemptPrefixes(process.env))
  if (leaked.length > 0) {
    throw new Error(`tests wrote into the real runtime directory: ${leaked.join(' ')}`)
  }
})
