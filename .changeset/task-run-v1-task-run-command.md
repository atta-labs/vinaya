---
"@attalabs/vinaya": minor
"@attalabs/vinaya-sources": minor
---

Adds `vinaya task run <tranche> <n> --agent <claude|codex|gemini>` — one command from a planned Issue to a reviewed pull request, exactly one developer started. Composes `task brief`'s own preparation (starts no agent) with `dev-review-loop` (whose own round 1 reads the frozen brief and is the only place a developer is ever dispatched from a fresh task). A brief already frozen on the Issue is reused, not re-posted; a task whose Issue refuses preparation is refused before any agent starts; a frozen brief whose developer branch already has an open pull request refuses a second start. Exit `0` with the PR URL on publish, exit `1` with the exact `vinaya dev-review-loop --resume <pr>` command on pause, exit `2` on a usage/argv error, exit `3` on any other failure.
