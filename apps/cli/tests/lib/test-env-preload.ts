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
for (const key of ['GITHUB_ACTIONS', 'VINAYA_HOST', 'VINAYA_ROLE', 'VINAYA_ATTEMPT', 'VINAYA_PARENT_EVENT']) {
  delete process.env[key]
}
