---
"@attalabs/aeg-core": minor
"@attalabs/vinaya": minor
"@attalabs/vinaya-sources": patch
---

`vinaya task dispatch <tranche> <n> [--agent claude | codex | gemini]` renders a task's brief from its Issue and the tree, pins the premises, and posts it once as a frozen `aeg:brief:v1` Issue comment — refusing outright, naming the existing comment's URL, if the Issue already carries one. With `--agent`, it starts the Developer through `dispatchRole` when that function is available, else prints the rendered brief and the manual dispatch instruction.

`vinaya pr create` no longer splits a brief section out of the PR body or posts it as a second comment — the brief now lives exclusively on the task Issue, posted by `task dispatch` before the Developer ever starts. A body still carrying either legacy `aeg:brief:start`/`aeg:brief:end` marker is refused outright. The PR body template's `## Summary` section is renamed `## Decisions` — one line per choice the brief left open, never a restatement of what the diff does — and its `## Reference — the dispatched brief` section is removed entirely.

Every reader that previously read the brief out of the PR body now reads the Issue's `aeg:brief:v1` comment instead on a task branch: `verify-dispatch --premise` (with no file argument), `check-brief-shape`, and the post-merge Archivist's provenance assembly (whose `- Brief:` line now names the comment's URL). A standalone `fix/*` branch's brief is unaffected — it still lives directly in its own PR body.
