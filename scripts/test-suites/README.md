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
including `--isolate` where their package declares it. The scheduler's watchdog in
`schedule.ts` remains an infrastructure backstop, not a substitute for this fix.

Every test file the CI schedule, a local push and a review round run starts in a
runner process of its own (`FILES_PER_RUNNER` in `schedule.ts`, which
`LOCAL_GROUP_FILE_CAP` in `local-run.ts` names), with its suite's runner, folder,
configuration, environment and preload. The watchdog is therefore a per-file
limit: `GROUP_TIME_LIMIT_MS`, fifteen minutes, applies to each runner start in
CI, on a push and in a review round alike. A runner still running at the limit
is stopped with `SIGKILL`, its file is run once more alone, and a second stop
fails that file alone as interrupted; no other file's result is discarded. The
kill reaches only the runner itself, so a stopped file's own children may
outlive it. A push still stops after its first failing runner, which is now one
file. The failed-tests record is rewritten as each file's runner ends, so a file
that crashes, exits early or is killed leaves every file that finished before it
confirmed.

How many of those one-file runners run at once is one setting,
`VINAYA_TEST_CONCURRENCY`, a positive integer that `testConcurrency` in
`schedule.ts` reads and validates for the CI schedule, a push, a review round
and the exact receipt command alike; any other value is refused with a message
naming the setting, before any runner starts. Unset, the default is one: each
file's runner starts only when the one before it ended, and its output streams
as it comes. Above one, runners start in plan order, never more than the
setting at once, each with its own report, its own per-file limit and its own
single retry, and each runner's output is captured and written as one block
when it ends, between its own group start and end lines, so concurrent runners
never interleave their lines. Every file's report is still judged on its own,
the result lists the files in plan order whatever order they ended in, and the
failed-tests record is rewritten after each file ends. A push that stops after
a failing file starts no further file, while files already running finish and
are judged. The CI build job's literal repository-suite command in
`.github/workflows/ci.yml` is not scheduled and still runs its files in one
`bun test`.

Sandbox controller probes write their verdict directly to the inherited stdout
file descriptor before exiting. On Linux, newer Bun's `process.stdout.write`
loses output inside Codex's no-network reviewer sandbox, while `writeSync(1, …)`
works under the same policy. This opens no file and grants no network access.
The live suite checks an immediate refusal inside each generated role, and the
parent still requires a structured verdict as well as the refusal exit status;
missing output never counts as proof that a boundary held.
