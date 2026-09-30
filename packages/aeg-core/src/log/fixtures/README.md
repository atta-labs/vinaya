# Log fixture executions

Named, deterministic streams of typed log events, for the tests of whatever reads the Vinaya Log: the normaliser, the sync engine and the queries. Reach them through the package's `log` subpath (`buildExecution`, `buildExecutions`, `FACT_SHEETS`).

- **Generated, never committed.** `executions.ts` builds every valid line with the real header builder; `executions.test.ts` parses each one with the real event schema, so a schema change that would invalidate a fixture fails there first.
- **Deterministic.** Every time, event id, run id and commit derives from a seed (`FIXTURE_SEED` by default) and the execution's name. Nothing reads the clock, a random source or state that outlives the call, so one seed always yields the same lines byte for byte.
- **Lines are raw text.** Each line carries how a reader should classify it: `valid`, `unknown_version` (a schema version no build knows) or `invalid` (a known version that fails validation). A repeated delivery is an identical valid line.
- **One behaviour each.** Green in one round; three rounds with a recurring finding and stated confidence; pause and resume; escalation to a handoff; one check and fingerprint at two commits, with no commit, and twice at one commit; cumulative and delta usage across two models with a retried attempt of unknown usage; and the historical, unknown, invalid and duplicate lines of an old store.
- **Fact sheets are the answer key.** `fact-sheets.ts` states each execution's line count, schema versions, round count, events per kind, distinct finding identities and models, written by hand from the scenario. The test compares each sheet with the lines. Work out a later expected result from a sheet, never from the code under test.
