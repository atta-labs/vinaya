# Harbor feasibility-job fixtures

These files are a redacted copy of the Harbor `0.24.0` feasibility job. The
successful, failed, and errored trial results and verifier rewards retain the
real Harbor shapes. Stable descriptive identifiers replace job, trial, and
session UUIDs and local paths. The `vinaya` fixture rewrites the original
Claude Code agent block to the repository's `vinaya` agent, adds the synced
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
