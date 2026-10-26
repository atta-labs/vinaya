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
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureDir, releaseFixtureRun, sweepAbandonedFixtureRuns } from './test-temp-fixture'
import { exemptPrefixes, PROCESS_START_MS, realRuntimeDir, touchedSince } from './real-runtime-guard-core'

/**
 * `VINAYA_LOG_TOKEN`/`VINAYA_LOG_READ_TOKEN` — the log server's write and read
 * credentials. The repository config points `logs` at the real server with
 * these as its `${VAR}` headers, and dozens of tests spawn children with the
 * parent's environment, so a token left here lets a test send an event to, or
 * read from, the real server. Removed so no process the suite starts carries
 * either one; a test that exercises the credential passes its own fake as an
 * explicit `env` override.
 */
for (const key of [
  'GITHUB_ACTIONS',
  'VINAYA_HOST',
  'VINAYA_ROLE',
  'VINAYA_ATTEMPT',
  'VINAYA_PARENT_EVENT',
  'VINAYA_LOG_TOKEN',
  'VINAYA_LOG_READ_TOKEN'
]) {
  delete process.env[key]
}

/**
 * `VINAYA_RUNTIME_DIR` — always a private temporary directory for the tests.
 * Left as it was, anything a test reaches through `runtimeDirForThisRepo()` —
 * the test-run cache `pr report` writes, a driver log — resolves to a real
 * runtime directory: `~/.vinaya/runtime/<owner>-<repo>` when unset, and in a
 * dispatched session the very directory the driver handed down, so a
 * Developer's own test run wrote its fixtures' narration into the live task's
 * driver log. A test that needs the default resolution (or a different
 * directory) sets or deletes the key itself. `real-runtime-guard.test.ts`
 * still fails a test that reaches the real directory some other way, such as
 * a spawned child with `VINAYA_*` stripped.
 */
// A sandboxed run names a temporary directory it has not created yet (Claude's sandbox: `/tmp/claude`). Where none
// can be made at all, the run keeps the directory it was handed rather than failing before any test starts.
function makePrivateRuntimeDir(): string | null {
  try {
    mkdirSync(tmpdir(), { recursive: true })
    return mkdtempSync(join(tmpdir(), 'vinaya-test-runtime-'))
  } catch {
    return null
  }
}
const privateRuntimeDir = makePrivateRuntimeDir()
if (privateRuntimeDir !== null) process.env.VINAYA_RUNTIME_DIR = privateRuntimeDir

/**
 * `Bun.spawn`/`Bun.spawnSync` called without an `env` give the child the
 * environment this process STARTED with, not `process.env` as this file just
 * set it: a CLI a test spawns that way still saw the inherited runtime
 * directory and wrote its Log there. Defaulting them to the current
 * `process.env` makes every child see what the test process sees.
 */
const spawnWithCurrentEnv = <F extends (...args: never[]) => unknown>(original: F): F =>
  ((first: unknown, second?: unknown) => {
    if (Array.isArray(first)) {
      const options = (second ?? {}) as { env?: unknown }
      return (original as unknown as (...a: unknown[]) => unknown)(
        first,
        options.env === undefined ? { ...options, env: process.env } : options
      )
    }
    const options = first as { env?: unknown }
    return (original as unknown as (...a: unknown[]) => unknown)(
      options.env === undefined ? { ...options, env: process.env } : options
    )
  }) as unknown as F
Bun.spawn = spawnWithCurrentEnv(Bun.spawn)
Bun.spawnSync = spawnWithCurrentEnv(Bun.spawnSync)

/**
 * Heavy-fixture storage (`test-temp-fixture.ts`): before any test, sweep the run directories earlier test
 * processes abandoned (killed, or interrupted mid-cleanup). A failure is printed, never hidden; it does not stop
 * this run, which uses its own fresh run directory.
 */
const sweep = await sweepAbandonedFixtureRuns()
for (const { dir, error } of sweep.failed) console.error(`test temp: could not sweep ${dir}: ${error}`)

// Step one's trial and grading folders (`dev-review-eval/step-one.ts`) go to this run's owned fixture storage too.
process.env.VINAYA_STEP_ONE_TMP ??= fixtureDir('step-one-')

/**
 * Once, after every test file this process ran: remove the private runtime
 * directory above, and fail the run if any test wrote into the REAL runtime
 * directory (`real-runtime-guard-core.ts`). A preload `afterAll` is the one
 * hook every test process loads, so each CI shard and each local run is
 * covered, whichever files it was given.
 */
afterAll(async () => {
  const fixtures = await releaseFixtureRun()
  if (privateRuntimeDir !== null) rmSync(privateRuntimeDir, { recursive: true, force: true })
  const leaked = touchedSince(realRuntimeDir(), PROCESS_START_MS, exemptPrefixes(process.env))
  if (leaked.length > 0) {
    throw new Error(`tests wrote into the real runtime directory: ${leaked.join(' ')}`)
  }
  if (fixtures !== null) throw new Error(`test temp: could not release the run directory ${fixtures}`)
})
