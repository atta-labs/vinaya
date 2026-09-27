/**
 * `[test] preload` — declared by BOTH `apps/cli/bunfig.toml` and the
 * repository-root `bunfig.toml`, so it runs once before any test file in
 * every invocation of the runner, whichever directory that invocation
 * started from: a local run inside `apps/cli`, CI's own sharded run (working
 * directory `apps/cli`), and the pre-push hook's selected-file run, which
 * git starts from the working tree root. Bun resolves `bunfig.toml` from the
 * process's working directory alone and never descends into a
 * subdirectory's config, so one declaration would cover only one of those
 * shapes.
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
for (const key of ['GITHUB_ACTIONS', 'VINAYA_HOST', 'VINAYA_ROLE', 'VINAYA_ATTEMPT', 'VINAYA_PARENT_EVENT']) {
  delete process.env[key]
}

/**
 * Every event this test process produces — in-process, or in a real
 * subprocess that inherits `process.env` — is marked `meta.test: true`
 * (`packages/aeg-core/src/log/schema.ts`), so a reader of a real log server
 * can separate this repository's own fixture traffic from real traffic.
 * Fixtures deliver to the SAME configured destination a real run does, by
 * design: the marker labels those events, it never suppresses or redirects
 * them.
 *
 * This is the EXPLICIT signal, and the one every sanctioned run of this
 * repository's tests now rests on, because BOTH `bunfig.toml` files declare
 * this preload. The sink also reads `NODE_ENV=test` (`testMarkerFrom`,
 * `apps/cli/src/lib/log-sink.ts`), which the runner sets for itself — but
 * only when nothing already exported it, so a machine whose shell exports
 * `NODE_ENV=development` would leave that signal absent. The explicit one
 * does not depend on the ambient value at all.
 *
 * Set here rather than per fixture, and deliberately NOT under the
 * `VINAYA_` prefix: the many fixtures that spawn a real `vinaya` child
 * delete every `VINAYA_*` key from its environment first, and a marker
 * stripped there would leave exactly the subprocess traffic this exists to
 * mark unmarked. For the same reason it is named in
 * `WORKER_ENV_ALLOWLIST_KEYS` (`apps/cli/src/lib/worker-boundary.ts`), whose
 * closed allowlist is what a CONFINED child inherits — without it, a
 * sandboxed dispatch spawned from inside a test run would emit unmarked
 * events indistinguishable from real traffic.
 */
process.env.AEG_LOG_TEST = '1'
