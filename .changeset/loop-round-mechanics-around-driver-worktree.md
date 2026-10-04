---
'@attalabs/vinaya': patch
'@attalabs/aeg-core': patch
---

The review loop's own round mechanics now work around the worktree the driver creates before round 1, closing four breakages the recent confinement work left and a turbo-telemetry failure.

Both reviewers now receive the task's frozen brief as a fourth staged input file (`brief.md`) beside the PR body, diff and prior findings, and each reviewer's prompt names that file first and explicitly as the standard to judge the PR against — a credential-free reviewer can now read the brief its doctrine tells it to judge against, never through `gh`.

The rendered brief's Step 0 no longer starts with `cd .worktrees/<branch>`: the Developer already starts inside the task worktree the driver created, so Step 0 is now just `bun install --frozen-lockfile --silent`.

Round 1's no-push detection now fires when the remote task branch still sits at the default branch's tip — the state the driver creates before round 1 — exactly as it already fired for a missing branch, so a round-1 turn that pushes nothing is caught rather than polled against a branch with no task commits.

The after-turn credential scan of a Developer turn now reads only what the turn itself wrote — the lines its diff ADDED and the Developer's own assistant messages — never the contents of files it read or command output, so this repository's own credential-shaped test fixtures no longer trip a false refusal when the Developer reads them.

The driver now sets `TURBO_TELEMETRY_DISABLED=1` in every confined Developer's environment, for both Claude and Codex, beside the turbo cache directory it already redirects — turbo's telemetry ping to `telemetry.vercel.com` was blocked by the sandbox egress allowlist and failed `bun run typecheck`.
