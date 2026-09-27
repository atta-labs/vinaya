/**
 * Not a suite file — deliberately `*.probe.ts`, so the repository's own test
 * discovery and its shard lists never collect it. `log-sink.test.ts` runs it
 * as a child, from the REPOSITORY ROOT, with `NODE_ENV` already exported to a
 * non-test value: the one shape in which the marker cannot come from the
 * runner's own `NODE_ENV` default, so what it proves is that the root
 * `bunfig.toml`'s own `[test] preload` declaration carries it instead.
 *
 * Kept as a fixture rather than folded into an assertion in the parent test
 * because only a real child of the real runner can observe which
 * `bunfig.toml` that runner resolved.
 */
import { expect, test } from 'bun:test'

test('a run started at the repository root is marked, with NODE_ENV already taken', () => {
  // The ambient value the runner respects rather than overwriting — the hole
  // the explicit signal exists to cover.
  expect(process.env.NODE_ENV).toBe('development')
  expect(process.env.AEG_LOG_TEST).toBe('1')
})
