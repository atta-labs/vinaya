# Harbor feasibility-job fixtures

These files are a redacted copy of the Harbor `0.24.0` feasibility job. The
successful, failed, and errored trial results and verifier rewards retain the
real Harbor shapes. Stable descriptive identifiers replace job, trial, and
session UUIDs and local paths. The `vinaya` fixture rewrites the original
Claude Code agent block to the repository's `vinaya` agent in the shape
Harbor writes it — `name: "vinaya_harbor_agent:VinayaAgent"` with no
`import_path` in the job config, the job lock and each trial's config and
lock, and `vinaya` only as the `agent_info` name of each trial result — adds the synced
`agent/vinaya-usage.json` files to trials that reached the Vinaya entry point,
and points task paths at committed redacted `tasks/` copies.
`claude-code-job/` keeps the original Claude Code agent block and its trial
output for the agent-refusal test. The success, failure, and early-error
outcomes are the feasibility output's native outcomes; no derived outcome
variant replaces a native trial.

Agent session folders, trajectories, email addresses, tool-server names, and
user paths are intentionally omitted. Trial and job identifiers are replaced
with descriptive redacted values, task digests with a fixed redacted digest,
and exception tracebacks with the word `redacted`.

`vinaya-trial-traces.json` holds the trace of three real `vinaya` agent
trials, one per case kind (`change`, `review`, `answer`), as the tool names
their trial records carried and nothing else: no transcript, path, user name,
session id or model output. `harbor-practice-fixes.test.ts` grades those
traces through step one's trace reader.

`vinaya-real-0.24/` is a redacted copy of one real Harbor `0.24.0` job of the
`vinaya` agent on two `code-reviewer-quality-neutral.l5@1` cases,
`code-clean` and `code-contract`, both rewarded `1`. It keeps the job's
`config.json`, `lock.json` and `result.json`; each trial's `config.json`,
`lock.json`, `result.json`, `agent/vinaya-usage.json` and
`verifier/reward.txt`; and each case's converted `tasks/<case>/task.toml`,
whose task folders hold nothing else. Its task digests and the results'
`task_checksum` values are the real ones. Job, trial and agent-run ids are
replaced with `redacted-id-<n>`, trial URIs with `redacted-trial-uri`, and
local paths, including the agent archive's, with `/redacted`. The job and
trial logs, transcripts, `artifacts/`, the trial records and trial text,
verifier stdout and grades are omitted. The tests read it with
`--suite code-reviewer-quality-neutral.l5@1` and `--task-root` set to the
fixture directory.
