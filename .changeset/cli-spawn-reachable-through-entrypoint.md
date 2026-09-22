---
"@attalabs/vinaya": patch
---

A test that spawns the built CLI as a subprocess (`Bun.spawn`/`Bun.spawnSync`, `execFileSync`, or `spawnSync` invoking `bun apps/cli/src/index.ts`) is now reachable by the pre-push test selector through the entrypoint's own real import graph, the same way a file that imports the entrypoint directly already was. Previously such a test named no import of the code it exercised, so a change to anything the entrypoint transitively imports — for example `apps/cli/src/lib/log-sink.ts` — could pass pre-push and only fail in CI.

A spawn shape the detector cannot read precisely (a different binary, a computed argument list, an indirect wrapper) still earns a coarse edge over the entrypoint's own source directory rather than staying invisible.
