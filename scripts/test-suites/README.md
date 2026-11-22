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
fails that file alone as interrupted; no other file's result is discarded. A
runner that exits non-zero with a readable report naming a failing file is also
started once more, alone, under the same environment, folder and limits; a signal,
a stop at the limit, an unreadable report, a report naming no failing file and a
call of the real GitHub CLI are not retried. The file passes only when the second
run exits zero and its report names exactly its file as executed with none
failing, and it is then listed as passed on retry, with its failed file, on
standard error, in the step summary and in the run's result; otherwise the second
run's report decides it. Progress, the failed-runner list and the failed-files
record count only the deciding run. The
kill reaches only the runner itself, so a stopped file's own children may
outlive it. A push still stops after its first failing runner, which is now one
file. The failed-tests record is rewritten as each file's runner ends, so a file
that crashes, exits early or is killed leaves every file that finished before it
confirmed.

How many of those one-file runners run at once is one setting,
`VINAYA_TEST_CONCURRENCY`, a positive integer that `testConcurrency` in
`schedule.ts` reads and validates for the CI schedule, a push, a review round
and the exact receipt command alike; any other value is refused with a message
naming the setting, before any runner starts. The pre-push hook and the CI
workflow reach it through the environment. Unset, the default is four
(`DEFAULT_TEST_CONCURRENCY`, which reads `ROUND_TEST_FILE_CONCURRENCY`, N, from
the round-test lock in
`harness/processes/vinaya-strict/loops/dev-review/v2/round-test-lock.ts`). To
change it, set `VINAYA_TEST_CONCURRENCY` to another positive integer for the
push or the CI job; set it to `1` to go back to one file at a time, where each
file's runner starts only when the one before it ended and its output streams
as it comes. A review round's test run gets a fixed environment that never
carries a caller's setting, so the round sets it itself: N, capped at the
host's logical processors, one on a host with less than 8 GiB, and never below
one. The host's round-test slot rule counts the same N in test processes and
budgets each round 8 GiB: rounds testing at once = max(1, min(floor(logical
processors / N), floor(total memory / 8 GiB))), so the test processes of every
round together stay within the host's logical processors (a 12-processor,
36 GB machine runs three rounds of four files; a host with fewer processors
than N runs one round, at as many files as it has processors). The 8 GiB per
round comes from one round at four files measured whole — the summed resident
memory of its process tree, test runners and the children they start — at
7378 MiB, since a few tests and their child processes use 2 to 5 GiB each. The
expected gain: a round testing alone
ran forty files in 69.5 s instead of 216.5 s, about 3.1 times faster; when
several rounds test at once each gets only its share of the cores (four of
twelve with three rounds), so each is faster than before but by less.
Above one, runners start in plan order, never more than the
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

`file-level-tests.json` is the one committed list of tests that selection must
keep at file level. It is a JSON object whose keys are list names; each list is
an object that maps a repository-relative path to the reason the file is on it.
It holds two lists. `outside-call` names the test files that still run with the
real GitHub CLI. Every other scheduled runner finds `gh-guard/gh` first on its
`PATH`: the scheduler copies it into a directory of its own per runner and
prepends that directory to the runner's starting `PATH`, never replacing it, so
a test's own fake `gh` put earlier on its own `PATH` still wins. The stand-in
records each call's arguments beside itself, prints that a test reached the real
GitHub CLI and exits non-zero. The scheduler fails any unlisted file whose
runner recorded a call, whatever the file's own outcome, so a test that
tolerates a failing `gh` still fails. A test that rebuilds `PATH` from scratch
drops the stand-in for its own children, a known gap. The list is measured, by
running every placement with the stand-in twice: once with a dummy `GH_TOKEN`
and once with no token variable at all, because a test that resolves its token
falls back to `gh auth token` only when no token variable is set. It may only
shrink: `scripts/test-suites/schedule.test.ts` fails when it names a file that
no longer exists or grows past its ceiling. A runner holds either only listed
files or only unlisted ones; the scheduler refuses a runner that mixes them.

The other list is `real-sandbox`: the files allowed to read the host
platform, because each one verifies or spawns the real confinement path of the
host it runs on. `apps/cli/tests/platform-independence.test.ts` reads that list
and checks every tracked test file in the repository against it. A file that
reads the host platform and is not on the list fails the check. A listed file
that no longer reads the platform also fails, until its entry is deleted. The
list may not grow past the ceiling the test keeps beside its walk, so the list
only shrinks, and every entry must give a non-empty reason. `inventory.json`
declares the file as a `semantic` input (`file-level-tests`) of every test that
reads it, so a change to it selects them. A test that reads it later must be
added to that input's readers.

Sandbox controller probes write their verdict directly to the inherited stdout
file descriptor before exiting. On Linux, newer Bun's `process.stdout.write`
loses output inside Codex's no-network reviewer sandbox, while `writeSync(1, …)`
works under the same policy. This opens no file and grants no network access.
The live suite checks an immediate refusal inside each generated role, and the
parent still requires a structured verdict as well as the refusal exit status;
missing output never counts as proof that a boundary held.
