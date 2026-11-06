# Repository test runners

The root `package.json` pins the Bun runtime used by CI through `oven-sh/setup-bun`.
Use that version locally when running the repository suite. Bun 1.4.2 can lose a
synchronous child's exit after GC finalizes streams from earlier tests: the
private spawn event loop's poll accounting is corrupted, leaving a zombie child
and a busy loop. The runtime pin is 1.4.4, containing the upstream fix:
[oven-sh/bun#44581](https://github.com/oven-sh/bun/pull/44581).

`bun-runtime.test.ts` runs the upstream GC/piped-stream reproduction in an
asynchronously supervised child. It asserts that finalizers ran, the next child
was reaped without its timeout firing, and its output and exit status survived.
The child has both a synchronous-spawn timeout and an outer kill budget, so a
broken runtime cannot freeze the parent test runner. The fixture intentionally
uses synchronous spawns to exercise the runtime defect; do not convert those
calls to async spawns, which would stop testing it.

Run the regression with `bun test scripts/test-suites/bun-runtime.test.ts`.
The test is explicitly registered in `inventory.json` and the CI build job's
repository-suite command. The remaining tests keep their native suite commands,
including `--isolate` where their package declares it. The CI group watchdog in
`schedule.ts` remains an infrastructure backstop, not a substitute for this fix.

Sandbox controller probes must flush their piped verdict before exiting, including
an immediate socket refusal. `controller-probe.ts` guards against duplicate error
and close callbacks and exits only from the stdout write callback. The parent
requires the structured verdict as well as a refusal exit status; it never treats
missing output as proof that a boundary held.
