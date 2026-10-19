# Harbor feasibility-job fixtures

These files are a redacted copy of the Harbor `0.24.0` feasibility job. The
successful, failed, and errored trial results and verifier rewards retain the
real Harbor shapes. Stable descriptive identifiers replace job, trial, and
session UUIDs and local paths. The `vinaya` fixture rewrites the original
Claude Code agent block to the repository's `vinaya` agent, adds the synced
`agent/vinaya-usage.json` files, and points task paths at committed redacted
`tasks/` copies. `claude-code-job/config.json` keeps the original Claude
Code agent block for the agent-refusal test.

Agent session folders, trajectories, email addresses, tool-server names, and
user paths are intentionally omitted.
